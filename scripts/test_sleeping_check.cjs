// 빈 차 확인(슬리핑 차일드) 판정 격리 테스트 — 2026-08-18 배시현 건의 `Eg8ZbQTMmPR6AAYo4fp0`.
//
//   node scripts/test_sleeping_check.cjs
//
// 🔴 판정식을 베끼지 않고 `src/lib/sleepingCheck.js` 를 그대로 vm 에 태운다(재구현 0).
// 🔴 이 기능의 핵심 불변식 두 개를 직접 단언한다:
//    ① **운행 전/중인 배차는 절대 "미확인"이 아니다**(아침마다 빨간 목록이 쌓이면 아무도 안 본다)
//    ② **종점 판정은 order 정렬 배열의 마지막**(raw order 산술 금지 — 결번 안전)
// prod 쓰기 0.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = path.join(__dirname, "..");

function load() {
  const src = fs.readFileSync(path.join(ROOT, "src/lib/sleepingCheck.js"), "utf8")
    .replace(/^export const /gm, "const ").replace(/^export function /gm, "function ");
  const ctx = { console }; vm.createContext(ctx);
  vm.runInContext(src + "\n;this.__m={SLEEP_CHECK_GRACE_MS,SLEEP_CHECK_FAST_SEC,toMs,sleepCheckedAt,terminalArrivalMs,sleepCheckState,pendingSleepChecks,sleepCheckSummary,formatWaited,sleepCheckAudit,sleepAuditLabel};", ctx);
  return ctx.__m;
}

let fail = 0, n = 0;
const ok = (name, cond, got) => { n++; console.log(`  ${cond ? "✓" : "✗"} ${name}${!cond && got !== undefined ? " → " + JSON.stringify(got) : ""}`); if (!cond) fail++; };

const M = load();
const NOW = 1755500000000;
const MIN = 60000;
const ts = (ms) => ({ toMillis: () => ms });
const stops = [{ id: "s1", order: 0 }, { id: "s2", order: 5 }, { id: "s3", order: 9 }]; // 결번 있는 order

console.log("\n[1] 상태 판정");
ok("종점 도착 없음 = running(목록에 안 올린다)",
  M.sleepCheckState({ stopArrivals: { s1: { actualAt: ts(NOW - 30 * MIN) } } }, stops, NOW) === "running");
ok("종점 도착 직후 = waiting(유예 안)",
  M.sleepCheckState({ stopArrivals: { s3: { actualAt: ts(NOW - 3 * MIN) } } }, stops, NOW) === "waiting");
ok("종점 도착 10분 경과 + 확인 없음 = late",
  M.sleepCheckState({ stopArrivals: { s3: { actualAt: ts(NOW - 11 * MIN) } } }, stops, NOW) === "late");
ok("확인했으면 시간과 무관하게 checked",
  M.sleepCheckState({ stopArrivals: { s3: { actualAt: ts(NOW - 90 * MIN) } }, sleepingCheck: { checkedAt: ts(NOW - 80 * MIN) } }, stops, NOW) === "checked");
ok("정류장 정보가 없으면 running(모르면 빨갛게 하지 않는다)",
  M.sleepCheckState({ stopArrivals: { s3: { actualAt: ts(NOW - 60 * MIN) } } }, [], NOW) === "running");
ok("배차가 비어도 안전", M.sleepCheckState(null, stops, NOW) === "running");
ok("경계 정확히 10분은 late", M.sleepCheckState({ stopArrivals: { s3: { actualAt: ts(NOW - 10 * MIN) } } }, stops, NOW) === "late");
ok("9분59초는 waiting", M.sleepCheckState({ stopArrivals: { s3: { actualAt: ts(NOW - (10 * MIN - 1000)) } } }, stops, NOW) === "waiting");

console.log("\n[2] 🔴 종점은 order 정렬의 마지막 (결번 안전)");
// 중간 정류장(order 5)만 도착 → 종점 아님. raw order 산술이면 오판할 수 있는 구성.
ok("중간 정류장 도착만으로는 종점 아님",
  M.terminalArrivalMs({ stopArrivals: { s2: { actualAt: ts(NOW) } } }, stops) === null);
ok("정렬 순서가 뒤섞여 들어와도 마지막은 s3",
  M.terminalArrivalMs({ stopArrivals: { s3: { actualAt: ts(NOW - MIN) } } },
    [{ id: "s3", order: 9 }, { id: "s1", order: 0 }, { id: "s2", order: 5 }]) === NOW - MIN);

console.log("\n[3] 목록·요약");
const dispatches = [
  { id: "d1", routeId: "r1", vehicleNo: "1111", stopArrivals: { s3: { actualAt: ts(NOW - 40 * MIN) } } },                                  // late(40분)
  { id: "d2", routeId: "r1", vehicleNo: "2222", stopArrivals: { s3: { actualAt: ts(NOW - 15 * MIN) } } },                                  // late(15분)
  { id: "d3", routeId: "r1", vehicleNo: "3333", stopArrivals: { s3: { actualAt: ts(NOW - 2 * MIN) } } },                                   // waiting
  { id: "d4", routeId: "r1", vehicleNo: "4444", stopArrivals: { s3: { actualAt: ts(NOW - 60 * MIN) } }, sleepingCheck: { checkedAt: ts(NOW - 55 * MIN) } }, // checked
  { id: "d5", routeId: "r1", vehicleNo: "5555", stopArrivals: {} },                                                                         // running(운행 전)
];
const byRoute = { r1: stops };
const pend = M.pendingSleepChecks(dispatches, byRoute, NOW);
ok("미확인 2건", pend.length === 2, pend.map(d => d.id));
ok("오래 기다린 순", pend[0].id === "d1" && pend[1].id === "d2", pend.map(d => d.id));
ok("🔴 운행 전 배차는 목록에 없다", !pend.some(d => d.id === "d5"));
ok("🔴 확인 완료도 목록에 없다", !pend.some(d => d.id === "d4"));
const sum = M.sleepCheckSummary(dispatches, byRoute, NOW);
ok("요약 = 완료1·미확인2·대기1", sum.done === 1 && sum.late === 2 && sum.waiting === 1, sum);
ok("모수에 운행 전(d5)은 빠진다", sum.total === 4, sum.total);
ok("정류장 정보가 아직 없으면 전부 running → 목록 0",
  M.pendingSleepChecks(dispatches, {}, NOW).length === 0);

console.log("\n[4] 표기");
ok("40분", M.formatWaited(40 * MIN) === "40분째", M.formatWaited(40 * MIN));
ok("1시간 5분", M.formatWaited(65 * MIN) === "1시간 5분째", M.formatWaited(65 * MIN));
ok("음수·0 은 빈 문자열", M.formatWaited(0) === "" && M.formatWaited(-1) === "");

console.log("\n[4.5] 🔴 QR 도용 감사(2026-08-18 way 지적 — 사진으로 복제된다)");
const chk = (extra) => ({ sleepingCheck: { checkedAt: ts(NOW), via: "qr", ...extra } });
ok("종점에서 먼 곳에서 찍히면 의심", M.sleepCheckAudit(chk({ nearOk: false, distanceM: 4200 })).suspicious);
ok("가까우면 정상", M.sleepCheckAudit(chk({ nearOk: true, distanceM: 40 })).suspicious === false);
ok("종점 도착 5초 만에 찍히면 의심(걸어갈 시간이 없다)",
  M.sleepCheckAudit(chk({ nearOk: true, distanceM: 30, afterTerminalSec: 5 })).suspicious);
ok("40초 뒤는 정상", M.sleepCheckAudit(chk({ nearOk: true, distanceM: 30, afterTerminalSec: 40 })).suspicious === false);
ok("🔴 위치 없음만으로는 의심 아님(권한 거부·실내가 흔하다)",
  M.sleepCheckAudit(chk({ nearOk: null, distanceM: null })).suspicious === false,
  JSON.stringify(M.sleepCheckAudit(chk({ nearOk: null, distanceM: null }))));
ok("위치 없음도 사유로는 남는다(관제에서 보이게)",
  M.sleepCheckAudit(chk({ nearOk: null, distanceM: null })).reasons.includes("noPlace"));
ok("🔴 NFC 는 위치로 의심하지 않는다(물리적 접촉이 강제된다)",
  M.sleepCheckAudit({ sleepingCheck: { checkedAt: ts(NOW), via: "nfc", nearOk: false, distanceM: 9000 } }).suspicious === false);
ok("NFC 라도 도착 직후 즉시는 의심",
  M.sleepCheckAudit({ sleepingCheck: { checkedAt: ts(NOW), via: "nfc", afterTerminalSec: 3 } }).suspicious);
ok("확인 기록이 없으면 의심 아님", M.sleepCheckAudit({}).suspicious === false);
ok("사유 라벨", M.sleepAuditLabel(["far", "tooFast"]) === "종점에서 먼 곳 · 도착 직후 즉시",
  M.sleepAuditLabel(["far", "tooFast"]));
console.log("\n[5] 소스 가드");
const cf = fs.readFileSync(path.join(ROOT, "functions/index.js"), "utf8");
ok("서버가 첫 확인만 남긴다(멱등)", /alreadyChecked: true/.test(cf));
ok("NFC 는 그 차량 등록 태그와 일치해야 한다", /이 차량의 확인 태그가 아닙니다/.test(cf));
ok("태그 중복 등록 거부", /이미 \$\{n\} 차량에 등록된 태그입니다/.test(cf));
ok("🔴 운행 시간창 밖 확인은 거부(차고지·전날 미리 찍기 차단)", /지금은 이 노선의 운행 시간이 아닙니다/.test(cf));
ok("🔴 위치는 기록만 — 거부 사유로 쓰지 않는다", /nearOk: distanceM == null \? null :/.test(cf) && !/nearOk === false\) throw/.test(cf));
ok("🔴 종점 도착을 필수 조건으로 걸지 않았다(실측 71%)", !/종점 도착 기록이 없습니다/.test(cf));
ok("확인 위치 기준은 차량 GPS → 없으면 종점 정류장", /refKind = \"terminal\"/.test(cf));
const sc = fs.readFileSync(path.join(ROOT, "src/pages/SleepCheckApp.js"), "utf8");
ok("🔴 위치를 못 얻어도 확인은 진행된다", /getCurrentPosition/.test(sc) && /\.\.\.\(pos \|\| \{\}\)/.test(sc));
const app = fs.readFileSync(path.join(ROOT, "src/App.js"), "utf8");
ok("🔴 /sleep 은 /board 와 다른 경로다(승객이 찍어도 탑승이 안 생긴다)", /pSleep\s*=\s*path\.startsWith\("\/sleep"\)/.test(app));
const fb = fs.readFileSync(path.join(ROOT, "src/firebase.js"), "utf8");
ok("🔴 /sleep 은 익명 지속성(기사 세션을 덮지 않는다)", /_pSleep/.test(fb) && /_pSleep \|\|/.test(fb));
const drv = fs.readFileSync(path.join(ROOT, "src/pages/DriverApp.js"), "utf8");
ok("기사앱에 '확인했음' 버튼이 없다(태그로만 찍힌다)", !/확인 완료<\/button>/.test(drv));
const adm = fs.readFileSync(path.join(ROOT, "src/pages/AdminApp.js"), "utf8");
ok("관제가 정본 판정 모듈을 쓴다", /from "\.\.\/lib\/sleepingCheck"/.test(adm));
ok("판정 stops 를 뷰와 무관하게 로드한다", /stopsForSleep/.test(adm));

console.log(`\n${fail === 0 ? `✅ ${n}단언 전부 통과` : `❌ ${fail}/${n} 실패`}`);
process.exit(fail === 0 ? 0 : 1);
