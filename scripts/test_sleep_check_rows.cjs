// 빈 차 확인 현황 — 대상 노선 선택·행 산출·내역 표시 격리 테스트(2026-08-25 미팅).
//   node scripts/test_sleep_check_rows.cjs
// 🔴 판정식을 베끼지 않고 `src/lib/sleepingCheck.js` 소스를 그대로 vm 에 태운다(재구현 0).
// prod 접속 0 · 쓰기 0.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = path.join(__dirname, "..");

function load() {
  const src = fs.readFileSync(path.join(ROOT, "src/lib/sleepingCheck.js"), "utf8")
    .replace(/^export const /gm, "const ")
    .replace(/^export function /gm, "function ");
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(src + `\n;this.__m = { sleepCheckRoutes, sleepCheckRows, sleepCheckState,
    sleepCheckedAtLabel, sleepCheckPlaceLabel, sleepCheckViaLabel, isSleepCheckRoute, SLEEP_CHECK_GRACE_MS };`, ctx);
  return ctx.__m;
}

(async () => {
  let fail = 0, n = 0;
  const ok = (name, cond, got) => {
    n++; console.log(`  ${cond ? "✓" : "✗"} ${name}${!cond && got !== undefined ? " → " + JSON.stringify(got) : ""}`);
    if (!cond) fail++;
  };
  const M = load();
  const NOW = new Date("2026-08-25T16:00:00+09:00").getTime();
  const ago = (min) => NOW - min * 60000;

  const stops = [{ id: "s1", order: 0 }, { id: "s2", order: 1 }, { id: "s3", order: 2 }];
  const stopsBy = { r_home: stops, r_school: stops, r_late: stops };
  const arrived = (min) => ({ s3: { actualAt: ago(min) } });

  console.log("\n[1] 대상 노선 — 지정이 있으면 지정만");
  const routes = [
    { id: "r_school", name: "[A] 등교 / To School", type: "출근", shift: "등교" },
    { id: "r_home", name: "[A] 하교 / Back Home", type: "퇴근", shift: "하교", sleepCheckEnabled: true },
    { id: "r_late", name: "[P] 방과후하교 / Late Activity Bus", type: "퇴근", shift: "하교" },
  ];
  const pinnedSel = M.sleepCheckRoutes(routes);
  ok("지정된 1개만", pinnedSel.routes.length === 1 && pinnedSel.routes[0].id === "r_home", pinnedSel.routes.map(r => r.id));
  ok("pinned=true", pinnedSel.pinned === true);
  ok("등교는 지정해도 안 켰으면 제외", !pinnedSel.routes.some(r => r.id === "r_school"));

  console.log("\n[2] 🔴 하나도 안 정했으면 폴백 — 빈 화면 금지");
  const noPin = M.sleepCheckRoutes(routes.map(({ sleepCheckEnabled, ...r }) => r));
  ok("pinned=false", noPin.pinned === false);
  ok("하교·방과후만 추천(등교 제외)", noPin.routes.length === 2 && !noPin.routes.some(r => r.id === "r_school"),
    noPin.routes.map(r => r.id));
  ok("노선이 없으면 빈 배열(크래시 0)", M.sleepCheckRoutes([]).routes.length === 0);
  ok("null 도 안전", M.sleepCheckRoutes(null).routes.length === 0);

  console.log("\n[3] 행 산출 — 봐야 할 것이 위로");
  const dispatches = [
    { id: "d_checked", routeId: "r_home", routeName: "하교A", stopArrivals: arrived(40),
      sleepingCheck: { checkedAt: ago(35), via: "nfc", distanceM: 8, distanceRef: "vehicle", nearOk: true, afterTerminalSec: 300 } },
    { id: "d_late",    routeId: "r_home", routeName: "하교B", stopArrivals: arrived(30) },
    { id: "d_waiting", routeId: "r_home", routeName: "하교C", stopArrivals: arrived(3) },
    { id: "d_running", routeId: "r_home", routeName: "하교D", stopArrivals: {} },
  ];
  const rows = M.sleepCheckRows(dispatches, stopsBy, NOW);
  ok("4행 전부 나온다(운행 중도 보인다)", rows.length === 4, rows.length);
  ok("정렬 = 미확인 → 대기 → 확인 → 운행중",
    rows.map(r => r.state).join(",") === "late,waiting,checked,running", rows.map(r => r.state));
  ok("미확인은 경과시간이 있다", rows[0].waitedMs > 0, rows[0].waitedMs);
  ok("확인된 건은 경과시간 없음", rows[2].waitedMs === null);
  ok("확인 시각 ms 가 실린다", typeof rows[2].checkedAtMs === "number");

  console.log("\n[4] 내역 표시 — '언제 · 어디서 · 어떻게'");
  const dChecked = dispatches[0];
  ok("확인 시각이 HH:MM", /^\d{2}:\d{2}$/.test(M.sleepCheckedAtLabel(dChecked)), M.sleepCheckedAtLabel(dChecked));
  ok("확인 안 된 건은 null", M.sleepCheckedAtLabel(dispatches[1]) === null);
  ok("위치 = 기준점 + 거리", M.sleepCheckPlaceLabel(dChecked).text === "차량에서 8m", M.sleepCheckPlaceLabel(dChecked));
  ok("가까우면 tone ok", M.sleepCheckPlaceLabel(dChecked).tone === "ok");
  ok("NFC 방식 표시", M.sleepCheckViaLabel(dChecked) === "NFC");

  const far = { sleepingCheck: { checkedAt: ago(5), via: "qr", distanceM: 820, distanceRef: "terminal", nearOk: false } };
  ok("먼 곳은 tone warn", M.sleepCheckPlaceLabel(far).tone === "warn", M.sleepCheckPlaceLabel(far));
  ok("종점 기준도 문구가 맞다", M.sleepCheckPlaceLabel(far).text === "종점에서 820m", M.sleepCheckPlaceLabel(far));
  ok("QR 방식 표시", M.sleepCheckViaLabel(far) === "QR");
  const noPlace = { sleepingCheck: { checkedAt: ago(5), via: "qr", distanceM: null } };
  ok("위치 미제공은 '위치 미확인'", M.sleepCheckPlaceLabel(noPlace).text === "위치 미확인", M.sleepCheckPlaceLabel(noPlace));
  ok("확인 전에는 위치 문구 없음", M.sleepCheckPlaceLabel(dispatches[1]).text === "");

  console.log("\n[5] 🔴 회귀 가드 — 운행이 끝나야 '미확인'이다");
  ok("종점 도착 기록이 없으면 running", M.sleepCheckState({ stopArrivals: {} }, stops, NOW) === "running");
  ok("유예 안이면 waiting", M.sleepCheckState({ stopArrivals: arrived(3) }, stops, NOW) === "waiting");
  ok("유예 지나면 late", M.sleepCheckState({ stopArrivals: arrived(30) }, stops, NOW) === "late");
  ok("정류장 정보가 없으면 running(0건으로 조용히 세지 않는다)",
    M.sleepCheckState({ stopArrivals: arrived(30) }, [], NOW) === "running");

  console.log(`\n${fail === 0 ? "✅" : "❌"} ${n - fail}/${n} 통과`);
  process.exit(fail === 0 ? 0 : 1);
})();
