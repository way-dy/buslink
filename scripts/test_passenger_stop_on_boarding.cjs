// 탑승 기록에 승객 지정 정류장 싣기 격리 검증 (2026-09-18 최우석 개선요청 `43HgiApQ…`)
//   node scripts/test_passenger_stop_on_boarding.cjs
// 🔴 Firebase 접속 0 · prod 읽기/쓰기 0.
// 🔴 `functions/index.js` 는 defineSecret 때문에 통째로 require 못 한다 → 함수 본문만 뽑아 평가한다(재구현 금지).
//
// 잠그는 것:
//   ① 승객이 고른 정류장은 **이번 탑승 노선과 같을 때만** 실린다(출근 정류장이 퇴근 탑승에 붙으면 오집계)
//   ② 미지정·삭제된 정류장·조회 실패 = 빈 값(= 기존처럼 GPS 매핑) — 탑승은 절대 막지 않는다
//   ③ boardStatic·boardNfc 둘 다 실제로 이 헬퍼를 쓰고, 빈 stopId 리터럴이 남지 않았다

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
};

const src = fs.readFileSync(path.join(ROOT, "functions/index.js"), "utf8");
const start = src.indexOf("async function resolvePassengerStopAdmin(");
const end = src.indexOf("\n}\n", start);
if (start < 0 || end < 0) {
  console.error("🔴 functions/index.js 에서 resolvePassengerStopAdmin 을 못 찾았습니다 (이름이 바뀌었나요?)");
  process.exit(1);
}
const ctx = {};
vm.createContext(ctx);
vm.runInContext(src.slice(start, end + 2) + "\nthis.fn = resolvePassengerStopAdmin;", ctx);
const resolve = ctx.fn;

// ── 가짜 Firestore: 경로 문자열 → 문서 데이터 ─────────────────
function fakeDb(docs, { throwOn } = {}) {
  const ref = (p) => ({
    collection: (c) => ({ doc: (d) => ref(`${p}/${c}/${d}`) }),
    get: async () => {
      if (throwOn && p.includes(throwOn)) throw new Error("boom");
      return { exists: p in docs, data: () => docs[p] };
    },
  });
  return { collection: (c) => ({ doc: (d) => ref(`${c}/${d}`) }) };
}
const CID = "dy001";
const TOK = (emp) => `companies/${CID}/fcmTokens/${emp}`;
const STOP = (rid, sid) => `companies/${CID}/routes/${rid}/stops/${sid}`;

(async () => {
  console.log("\n[1] 노선 일치 — 정류장이 실린다");
  const db = fakeDb({
    [TOK("0879824")]: { routeId: "R_AM", stopId: "S1" },
    [STOP("R_AM", "S1")]: { name: "광명역 3번출구" },
  });
  const r1 = await resolve(db, CID, "0879824", "R_AM");
  ok("stopId 실림", r1.stopId === "S1", JSON.stringify(r1));
  ok("stopName 은 정류장 문서의 이름", r1.stopName === "광명역 3번출구", JSON.stringify(r1));

  console.log("\n[2] 🔴 노선 불일치 — 출근 정류장을 퇴근 탑승에 붙이지 않는다");
  const r2 = await resolve(db, CID, "0879824", "R_PM");
  ok("빈 값", r2.stopId === "" && r2.stopName === "", JSON.stringify(r2));

  console.log("\n[3] 미지정·결손 — 빈 값(= 기존 GPS 매핑)");
  ok("fcmTokens 문서 없음", (await resolve(fakeDb({}), CID, "X", "R_AM")).stopId === "");
  ok("stopId 가 null(정류장 해제)",
    (await resolve(fakeDb({ [TOK("E")]: { routeId: "R_AM", stopId: null } }), CID, "E", "R_AM")).stopId === "");
  ok("정류장 문서가 지워짐",
    (await resolve(fakeDb({ [TOK("E")]: { routeId: "R_AM", stopId: "GONE" } }), CID, "E", "R_AM")).stopId === "");
  ok("routeId 없음(옛 배차)", (await resolve(db, CID, "0879824", "")).stopId === "");
  ok("empNo 없음", (await resolve(db, CID, "", "R_AM")).stopId === "");

  console.log("\n[4] 🔴 조회 실패는 탑승을 막지 않는다(throw 금지)");
  let threw = false, r4;
  try { r4 = await resolve(fakeDb({}, { throwOn: "fcmTokens" }), CID, "E", "R_AM"); } catch { threw = true; }
  ok("throw 하지 않는다", !threw);
  ok("빈 값", r4 && r4.stopId === "" && r4.stopName === "");

  console.log("\n[5] 배선 — 두 CF 가 실제로 이 헬퍼를 쓴다");
  const calls = src.match(/\.\.\.\(await resolvePassengerStopAdmin\(/g) || [];
  ok("boardStatic·boardNfc 2곳에서 호출", calls.length === 2, `실제 ${calls.length}곳`);
  ok("boardStatic 은 토큰 사번(trimmedEmpNo)으로 조회",
    /resolvePassengerStopAdmin\(db, companyId, trimmedEmpNo, routeId\)/.test(src));
  ok("🔴 빈 stopId 리터럴이 탑승 기록에 남지 않았다", !/^\s+stopId: "",\s*$/m.test(src));

  console.log(`\n${fail === 0 ? "✅" : "🔴"} ${pass}/${pass + fail} 통과`);
  process.exit(fail === 0 ? 0 : 1);
})();
