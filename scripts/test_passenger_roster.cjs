// 명부 반영 판정 격리 검증 — functions/passengerRoster.js (2026-08-28 P3-a)
//   node scripts/test_passenger_roster.cjs
// 🔴 Firebase 접속 0 · prod 읽기/쓰기 0. **정본 모듈을 그대로 require 해서** 태운다(규칙 복제 0).
//
// 이 판정이 틀리면 사람이 로그인을 못 한다:
//   ⓐ 기존 사람에게 PIN 을 새로 발급하면 그 순간 그 사람 비밀번호가 끊긴다
//   ⓑ 다른 협력사에 있던 사번(이관자)을 신규로 오판해도 같은 일이 벌어진다
//   ⓒ 해시가 명부(passengers)로 새어 나가면 P3-a 를 한 이유가 사라진다
const path = require("path");
const { planRosterWrites, planReissue, dedupeRows } = require(
  path.join(__dirname, "..", "functions", "passengerRoster")
);

let n = 0, fail = 0;
const ok = (name, cond, got) => {
  n++;
  console.log(`  ${cond ? "✓" : "✗"} ${name}${!cond && got !== undefined ? " → " + JSON.stringify(got) : ""}`);
  if (!cond) fail++;
};

const NOW = "__ts__";
const deps = {
  now: NOW,
  makePin: () => "654321",
  hashPin: (p) => "H(" + p + ")",
  validPin: (v) => /^\d{6}$/.test(String(v ?? "").trim()) && String(v).trim() !== "000000",
  normNfc: (u) => String(u).toUpperCase(),
};
const row = (empNo, over = {}) => ({ empNo, name: "이름" + empNo, dept: "부서", routeCode: "662", routeId: "r1", active: true, ...over });
const plan = (rows, existing = new Map(), extra = {}) => planRosterWrites({
  rows, existing, code: "PC1", companyId: "dy001", partnerName: "협력사", ...deps, ...extra,
});

console.log("\n[1] 신규 — 해시는 secrets 로만 간다");
{
  const { ops, results } = plan([row("E1")]);
  ok("신규 1명", results.added === 1 && results.updated === 0, results);
  const op = ops[0];
  ok("명부 문서에 pinHash 가 없다", op.data.pinHash === undefined, Object.keys(op.data));
  ok("secret 에 해시가 있다", op.secret && op.secret.pinHash === "H(654321)", op.secret);
  ok("pinInitial:true 로 첫 설정을 강제", op.data.pinInitial === true);
  ok("평문은 반환에만", results.credentials[0].pin === "654321" && op.data.pin === undefined);
  ok("소속은 서버가 준 코드로 고정", op.data.partnerCode === "PC1");
}

console.log("\n[2] 🔴 기존 사람에게는 PIN 을 절대 새로 발급하지 않는다");
{
  const ex = new Map([["E1", { partnerCode: "PC1", active: true, name: "옛이름" }]]);
  const { ops, results } = plan([row("E1", { name: "새이름" })], ex);
  ok("갱신으로 센다", results.updated === 1 && results.added === 0, results);
  ok("secret 을 만들지 않는다", ops[0].secret === undefined);
  ok("반환에도 PIN 이 없다", results.credentials.length === 0);
  ok("이름은 바뀐다", ops[0].data.name === "새이름");
  ok("update 패치에 pinHash·pinInitial 이 없다",
    ops[0].data.pinHash === undefined && ops[0].data.pinInitial === undefined, Object.keys(ops[0].data));
}

console.log("\n[3] 🔴 다른 협력사에 있던 사번(이관자)도 기존으로 본다");
{
  const ex = new Map([["E9", { partnerCode: "OTHER", active: true }]]);
  const { ops, results } = plan([row("E9")], ex);
  ok("신규가 아니다", results.added === 0 && results.updated === 1, results);
  ok("PIN 재발급 없음(로그인 유지)", ops[0].secret === undefined && results.credentials.length === 0);
  ok("소속만 새 거래처로", ops[0].data.partnerCode === "PC1");
}

console.log("\n[4] 값을 안 보낸 항목은 기존 값을 지키지 않는다 — 키를 아예 안 만든다");
{
  const { ops } = plan([row("E1")]);                       // pinLocked·nfcUid 미지정
  ok("pinLocked 키 없음", !("pinLocked" in ops[0].data));
  ok("nfcUid 키 없음", !("nfcUid" in ops[0].data));
  const { ops: o2 } = plan([row("E2", { nfcUid: "0453ce9a", pinLocked: true })]);
  ok("보내면 정규화해서 기록", o2[0].data.nfcUid === "0453CE9A" && o2[0].data.pinLocked === true);
  const { ops: o3 } = plan([row("E3", { nfcUid: "" })]);
  ok("빈 문자열은 해제(null)", o3[0].data.nfcUid === null);
}

console.log("\n[5] 관리자 지정 초기 PIN");
{
  const { ops, results } = plan([row("E1", { initialPin: "112233" })]);
  ok("지정값을 쓴다", results.credentials[0].pin === "112233" && ops[0].secret.pinHash === "H(112233)");
  const { results: r2 } = plan([row("E2", { initialPin: "000000" })]);
  ok("000000 은 거부하고 임의 발급", r2.credentials[0].pin === "654321");
  const { results: r3 } = plan([row("E3", { initialPin: "12" })]);
  ok("형식이 틀리면 임의 발급", r3.credentials[0].pin === "654321");
}

console.log("\n[6] 중복 사번·빈 사번");
{
  const { ops, results } = plan([row("E1", { name: "앞" }), row("E1", { name: "뒤" })]);
  ok("한 번만 쓴다", ops.length === 1 && results.added === 1);
  ok("뒤엣것이 남는다", ops[0].data.name === "뒤");
  const errs = [];
  ok("빈 사번은 버리고 알린다", dedupeRows([{ name: "사번없음" }], errs).length === 0 && errs.length === 1, errs);
}

console.log("\n[7] 퇴사 전이");
{
  const ex = new Map([["E1", { partnerCode: "PC1", active: true }]]);
  const { results } = plan([row("E1", { active: false })], ex);
  ok("deactivated 로 센다", results.deactivated === 1 && results.updated === 0, results);
  const ex2 = new Map([["E1", { partnerCode: "PC1", active: false }]]);
  ok("이미 퇴사였으면 갱신", plan([row("E1", { active: false })], ex2).results.updated === 1);
}

console.log("\n[8] PIN 재발급 — 🔴 소속 확인이 이 함수의 존재 이유");
{
  const owned = new Map([
    ["E1", { partnerCode: "PC1", name: "우리" }],
    ["E9", { partnerCode: "OTHER", name: "남" }],
  ]);
  const r = planReissue({
    rows: [{ empNo: "E1" }, { empNo: "E9" }, { empNo: "E404" }, { empNo: "  " }],
    owned, code: "PC1", companyId: "dy001", now: NOW, makePin: deps.makePin, hashPin: deps.hashPin,
  });
  ok("우리 거래처 사람만 재발급", r.credentials.length === 1 && r.credentials[0].empNo === "E1", r.credentials);
  ok("남의 거래처는 거부하고 알린다", r.errors.some((e) => e.includes("E9") && e.includes("소속")), r.errors);
  ok("명부에 없으면 거부", r.errors.some((e) => e.includes("E404")));
  ok("빈 사번도 알린다", r.errors.some((e) => e.includes("사번 없는")));
  ok("해시는 secret 으로", r.ops[0].secret.pinHash === "H(654321)");
  ok("명부의 옛 해시는 지우게 표시", r.ops[0].patch.deletePinHash === true);
  ok("pinInitial 을 되돌린다(첫 설정 화면을 다시 만난다)", r.ops[0].patch.pinInitial === true);
}

console.log("\n[9] 회귀 가드 — 소스에 실제로 남아 있는지");
{
  const fs = require("fs");
  const src = fs.readFileSync(path.join(__dirname, "..", "functions", "passengerRoster.js"), "utf8");
  ok("신규에만 secret 을 만든다(기존 분기엔 secret 없음)",
    /if \(!prev\)[\s\S]*?secret:/.test(src) && !/kind: "update"[\s\S]{0,200}secret:/.test(src));
  ok("명부 data 에 pinHash 를 쓰지 않는다", !/\bpinHash\s*:/.test(src.split("planReissue")[0].replace(/secret: \{[^}]*\}/g, "")));
  const idx = fs.readFileSync(path.join(__dirname, "..", "functions", "index.js"), "utf8");
  ok("index.js 가 판정을 이 모듈에 위임한다", /require\("\.\/passengerRoster"\)/.test(idx));
  ok("index.js 가 secret 을 passengerSecrets 로 쓴다", /passengerSecretRef\(db, companyId, op\.empNo\), op\.secret/.test(idx));
  ok("로그인은 secrets 우선·명부 폴백", /readPinHash\(db, companyId, snap\.id, snap\)/.test(idx));

  // 🔴 클라가 다시 명부를 직접 쓰지 않는지 — 되돌아가면 해시를 못 써서 신규 등록이 통째로 실패한다.
  //    (2026-08-28 오전의 클라측 배치 구현과 그 테스트 test_import_employees.cjs 는
  //     이 이관으로 대상을 잃어 폐기했다. 지키려던 것[왕복하지 않는다]은 여기서 잇는다.)
  const cliRaw = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "partner.js"), "utf8");
  // 🔴 주석을 걷고 본다 — 안 그러면 "배치를 걷어냈다"고 적은 **설명글 자체가** 걸려
  //    가드가 빨간불이 된다(실제로 그랬다). 가드는 코드를 봐야 한다.
  const cli = cliRaw.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  ok("클라는 CF 로 위임한다", /httpsCallable\(functions, "partnerImportPassengers"\)/.test(cli));
  ok("클라에 명부 배치 쓰기가 없다", !/writeBatch\(|documentId\(\)/.test(cli));
  ok("클라에 PIN 해시 함수가 없다", !/crypto\.subtle|function hashPin\b/.test(cli));
}

console.log(`\n결과: ${n - fail} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
