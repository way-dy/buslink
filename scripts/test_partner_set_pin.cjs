// 비밀번호 «직접 지정» 판정 격리 검증 — functions/passengerRoster.js planDirectPin (2026-09-10)
//   node scripts/test_partner_set_pin.cjs
// 🔴 Firebase 접속 0 · prod 읽기/쓰기 0. **정본 모듈을 그대로 require 해서** 태운다(규칙 복제 0).
//
// 이 판정이 틀리면:
//   ⓐ 소속 확인이 빠지면 업체코드 하나로 **남의 거래처 사람 비밀번호를 갈아치운다**
//      (그 사람은 그 순간 로그인 불가가 된다) — 이 가드가 planDirectPin 의 존재 이유다
//   ⓑ `pinInitial` 이 true 로 돌아가면 관리자가 정해 준 번호가 첫 로그인에서 곧바로 버려진다
//      (강제 PIN 설정 화면이 뜬다) = 요청이 성립하지 않는다
//   ⓒ 평문이 op 에 실려 나가면 Firestore·로그에 남는다
const path = require("path");
const crypto = require("crypto");
const { planDirectPin } = require(path.join(__dirname, "..", "functions", "passengerRoster"));

let n = 0, fail = 0;
const ok = (name, cond, got) => {
  n++;
  console.log(`  ${cond ? "✓" : "✗"} ${name}${!cond && got !== undefined ? " → " + JSON.stringify(got) : ""}`);
  if (!cond) fail++;
};

const NOW = "__ts__";
const CODE = "PC1";
// 🔴 해시 스텁은 평문을 되비추면 안 된다 — `"H("+p+")"` 같은 스텁을 쓰면 [6] 의
//    «평문이 op 에 없다» 가 스텁 탓에 늘 빨간불이라 판정이 무의미해진다(실제로 밟았다).
const hashPin = (p) => crypto.createHash("sha256").update(String(p) + "__salt__").digest("hex");
// 서버 실물과 같은 판정을 주입한다(index.js `isValidDirectPinAdmin` = 4~6자리 숫자).
const deps = {
  code: CODE,
  companyId: "dy001",
  now: NOW,
  hashPin,
  validPin: (v) => /^\d{4,6}$/.test(String(v == null ? "" : v).trim()),
};
const OWNED = new Map([
  ["E1", { partnerCode: CODE, active: true, name: "우리사람" }],
  ["E9", { partnerCode: "OTHER", active: true, name: "남의사람" }],
  ["E0", { active: true, name: "소속없음" }],   // partnerCode 부재 = 어느 거래처도 아님
]);
const run = (empNo, pin, over = {}) => planDirectPin({ empNo, pin, owned: OWNED, ...deps, ...over });

console.log("\n[1] 🔴 소속 가드 — 이 함수의 존재 이유");
{
  const r = run("E9", "1234");
  ok("남의 거래처 사람은 op 가 없다", r.op === null, r);
  ok("이유를 말한다", /이 거래처 소속이 아닙니다/.test(r.errors[0] || ""), r.errors);
  const r2 = run("E0", "1234");
  ok("partnerCode 부재 문서도 거부", r2.op === null && /소속/.test(r2.errors[0] || ""), r2.errors);
  // 같은 사람이라도 코드가 맞으면 통과 — 가드가 «전부 거부» 로 굳어 있지 않은지(신호 유무)
  const r3 = run("E9", "1234", { code: "OTHER" });
  ok("코드가 맞으면 통과한다(가드가 무조건 거부가 아니다)", !!r3.op, r3.errors);
}

console.log("\n[2] 명부에 없는 사번");
{
  const r = run("NOPE", "1234");
  ok("op 가 없다", r.op === null, r);
  ok("이유를 말한다", /명부에 없습니다/.test(r.errors[0] || ""), r.errors);
}

console.log("\n[3] 빈 사번");
{
  for (const v of ["", "   ", null, undefined]) {
    const r = run(v, "1234");
    ok(`빈 사번 거부 (${JSON.stringify(v)})`, r.op === null && r.errors.length === 1, r);
  }
}

console.log("\n[4] 형식 — 숫자 4~6자리만");
{
  for (const bad of ["123", "1234567", "12a4", "12 34", "", "  ", null, undefined]) {
    const r = run("E1", bad);
    ok(`거부: ${JSON.stringify(bad)}`, r.op === null && /4~6자리/.test(r.errors[0] || ""), r);
  }
  for (const good of ["1234", "12345", "123456", "000000", " 4321 "]) {
    const r = run("E1", good);
    ok(`허용: ${JSON.stringify(good)}`, !!r.op, r.errors);
  }
}

console.log("\n[5] 🔴 성공 — 재발급과의 차이(pinInitial:false)");
{
  const r = run("E1", "4321");
  ok("op 가 있고 오류가 없다", !!r.op && r.errors.length === 0, r.errors);
  const op = r.op;
  ok("대상 사번이 정규화돼 실린다", op.empNo === "E1", op.empNo);
  ok("🔴 pinInitial === false (강제 변경 화면을 띄우지 않는다)", op.patch.pinInitial === false, op.patch);
  ok("🔴 deletePinHash === true (명부의 옛 해시를 걷는다)", op.patch.deletePinHash === true, op.patch);
  ok("해시는 hashPin(pin) 결과다", op.secret.pinHash === hashPin("4321"), op.secret);
  ok("다른 PIN 이면 다른 해시(스텁이 상수가 아니다 — 신호 유무)", hashPin("4321") !== hashPin("1234"));
  ok("secret 에 회사·사번이 실린다", op.secret.companyId === "dy001" && op.secret.empNo === "E1", op.secret);
  ok("시각은 주입한 센티널", op.secret.updatedAt === NOW && op.patch.updatedAt === NOW, op);
}

console.log("\n[6] 🔴 평문이 op 어디에도 없다");
{
  const PIN = "975310";
  const r = run("E1", PIN);
  const dump = JSON.stringify(r.op);
  ok("직렬화한 op 에 평문이 없다", dump.indexOf(PIN) === -1, dump);
  ok("patch 에도 pinHash 를 직접 넣지 않는다", r.op.patch.pinHash === undefined, r.op.patch);
  ok("명부 patch 는 상태 필드만", Object.keys(r.op.patch).sort().join(",") === "deletePinHash,pinInitial,updatedAt", Object.keys(r.op.patch));
}

console.log("\n[7] 사번 앞뒤 공백은 정규화(문서 ID 는 trim 한 값)");
{
  const r = run("  E1  ", "1234");
  ok("공백을 걷어 찾는다", !!r.op && r.op.empNo === "E1", r);
}

console.log(`\n${fail === 0 ? "✅ 전부 통과" : "❌ 실패 있음"} — ${n - fail} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
