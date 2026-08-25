// 조기 도착(정시 전 미리 와서 대기) 표시 격리 테스트 — 2026-08-24 배시현 게시판 2건.
//
//   node scripts/test_early_arrival_delay.cjs
//
// 재현 대상 = 첨부 스크린샷 [H1] 등교 / 출발 06:25 / 06:38 시점 화면 그대로.
//   출 공덕역      도착 05:55 · 조기도착 30분      ← 출발지에 30분 미리 도착해 대기
//   2 이촌 자이    계획 06:40 · 예상 06:38 · 조기도착 30분   ← 🔴 예상은 2분 빠른데 배지는 30분
//   3 이촌 강촌    계획 06:45 · 예상 06:43 · 조기도착 2분
//   4 신동아       계획 06:50 · 예상 06:48 · 조기도착 2분
//   5 한남오거리   계획 07:00 · 예상 06:58 · 조기도착 2분
//   도 채드윅      계획 08:15 · 예상 08:13 · 조기도착 2분
//
// 🔴 판정식을 베끼지 않고 `src/lib/stopSchedule.js` 소스를 그대로 vm 에 태운다(재구현 0).
// prod 쓰기 0 · 네트워크 0.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = path.join(__dirname, "..");

function strip(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/^import[\s\S]*?from\s+".*?";\s*$/gm, "")   // 모듈 import 제거(같은 컨텍스트에 합침)
    .replace(/^export const /gm, "const ")
    .replace(/^export function /gm, "function ");
}

function loadSchedule() {
  const src = strip("src/lib/routeProgress.js") + "\n" + strip("src/lib/stopSchedule.js");
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(src + "\n;this.__m = { computeStopEstimates, formatDelayLabel, planTimeForStop };", ctx);
  return ctx.__m;
}

// "HH:MM" → 오늘 millis
const AT = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime();
};

(async () => {
  let fail = 0, n = 0;
  const ok = (name, cond, got) => {
    n++; console.log(`  ${cond ? "✓" : "✗"} ${name}${!cond && got !== undefined ? " → " + JSON.stringify(got) : ""}`);
    if (!cond) fail++;
  };
  const { computeStopEstimates, formatDelayLabel } = loadSchedule();

  // ── 스크린샷 [H1] 등교 노선 픽스처 ──────────────────────────────────────────
  // 좌표는 계산에 안 쓰이게 routePath 미설정(직선 폴백도 offsetMin 이 다 있어 미사용).
  const stops = [
    { id: "s1", name: "공덕역",       order: 0, offsetMin: 0,   lat: 37.54, lng: 126.95 },
    { id: "s2", name: "이촌 자이",     order: 1, offsetMin: 15,  lat: 37.52, lng: 126.97 },
    { id: "s3", name: "이촌 강촌",     order: 2, offsetMin: 20,  lat: 37.52, lng: 126.98 },
    { id: "s4", name: "신동아",       order: 3, offsetMin: 25,  lat: 37.52, lng: 126.99 },
    { id: "s5", name: "한남오거리",    order: 4, offsetMin: 35,  lat: 37.53, lng: 127.00 },
    { id: "s6", name: "채드윅",       order: 5, offsetMin: 110, lat: 37.38, lng: 126.65 },
  ];
  const DEPART = "06:25";
  const NOW = AT("06:38");
  // 출발지에만 실측 도착 — 05:55(계획 06:25 보다 30분 이르다)
  const arrivals = { s1: AT("05:55") };

  const run = () => computeStopEstimates({
    stops, departTime: DEPART, actualArrivals: arrivals,
    vehiclePos: null, speed: null, routePath: null, now: NOW,
  });

  const est = run();
  const by = {}; est.forEach(e => { by[e.stopId] = e; });
  const mins = (e) => (e.delaySec == null ? null : Math.round(e.delaySec / 60));

  console.log("\n[1] 현재 동작 — 화면 재현");
  est.forEach((e, i) => {
    console.log(`     ${stops[i].name.padEnd(7)} 계획 ${e.plannedAt} · 예상 ${e.estimatedAt} · ${formatDelayLabel(e.delaySec).label} (${e.status}/${e.source})`);
  });

  console.log("\n[2] 결함 재발 방지 — 수정 전에는 s2 가 `예상 06:38 · 조기도착 30분` 이었다");
  ok("출발지 도착 기록은 05:55 사실 그대로", by.s1.estimatedAt === "05:55", by.s1.estimatedAt);
  ok("출발지 자체 배지는 조기도착 30분 유지(기사·관리자용 사실)",
    formatDelayLabel(by.s1.delaySec).label === "조기도착 30분", formatDelayLabel(by.s1.delaySec).label);
  ok("다음 정류장에 출발지 조기값이 전파되지 않는다", mins(by.s2) !== -30, mins(by.s2));
  ok("배지와 같은 줄 예상시각이 어긋나지 않는다", (() => {
    const [ph, pm] = by.s2.plannedAt.split(":").map(Number);
    const [eh, em] = by.s2.estimatedAt.split(":").map(Number);
    const diffMin = (eh * 60 + em) - (ph * 60 + pm);
    return Math.abs(diffMin - mins(by.s2)) <= 1;
  })(), { 계획: by.s2.plannedAt, 예상: by.s2.estimatedAt, 배지: mins(by.s2) });
  ok("이후 전 정류장이 '지금+30초'로 눌리지 않는다(40분 내내 곧 도착 차단)",
    est.slice(1).every(e => e.estimatedAt !== "06:38"), est.slice(1).map(e => e.estimatedAt));

  console.log("\n[3] 기대 동작 — 계획시각 전에는 출발하지 않는다");
  ok("2번 정류장 예상 = 계획 06:40(06:25 출발 + 15분)", by.s2.estimatedAt === "06:40", by.s2.estimatedAt);
  ok("2번 정류장 배지 = 정시(0분)", mins(by.s2) === 0, mins(by.s2));
  ok("3번 정류장 예상 = 계획 06:45", by.s3.estimatedAt === "06:45", by.s3.estimatedAt);
  ok("도착지 예상 = 계획 08:15", by.s6.estimatedAt === "08:15", by.s6.estimatedAt);

  console.log("\n[4] 회귀 가드 — 늦게 도착한 경우는 그대로 지연 전파");
  const late = computeStopEstimates({
    stops, departTime: DEPART, actualArrivals: { s1: AT("06:35") },
    vehiclePos: null, speed: null, routePath: null, now: AT("06:40"),
  });
  const lateBy = {}; late.forEach(e => { lateBy[e.stopId] = e; });
  ok("출발지 10분 지연", Math.round(lateBy.s1.delaySec / 60) === 10, Math.round(lateBy.s1.delaySec / 60));
  ok("다음 정류장도 10분 지연 유지(06:50)", lateBy.s2.estimatedAt === "06:50", lateBy.s2.estimatedAt);
  ok("지연 배지 유지", formatDelayLabel(lateBy.s2.delaySec).label === "지연 10분", formatDelayLabel(lateBy.s2.delaySec).label);

  console.log("\n[5] 회귀 가드 — 중간 정류장 조기 통과는 클램프하지 않는다(일찍 떠날 수 있다)");
  const midEarly = computeStopEstimates({
    stops, departTime: DEPART, actualArrivals: { s1: AT("06:25"), s2: AT("06:36") },
    vehiclePos: null, speed: null, routePath: null, now: AT("06:37"),
  });
  const midBy = {}; midEarly.forEach(e => { midBy[e.stopId] = e; });
  ok("s2 를 4분 일찍 통과", Math.round(midBy.s2.delaySec / 60) === -4, Math.round(midBy.s2.delaySec / 60));
  ok("s3 예상도 앞당겨진다(06:41)", midBy.s3.estimatedAt === "06:41", midBy.s3.estimatedAt);

  console.log("\n[6] 회귀 가드 — 운행 전(실측·GPS 0)은 계획 그대로");
  const idle = computeStopEstimates({
    stops, departTime: DEPART, actualArrivals: {},
    vehiclePos: null, speed: null, routePath: null, now: AT("05:00"),
  });
  ok("전부 계획시각", idle.every((e, i) => e.estimatedAt === e.plannedAt), idle.map(e => e.estimatedAt));
  ok("지연 라벨 없음", idle.every(e => formatDelayLabel(e.delaySec).label === ""), idle.map(e => e.delaySec));

  console.log(`\n${fail === 0 ? "✅" : "❌"} ${n - fail}/${n} 통과`);
  process.exit(fail === 0 ? 0 : 1);
})();
