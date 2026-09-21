// 격리 테스트 — 노선 준수 점검(src/lib/routeAdherence.js).
//   node scripts/test_route_adherence.cjs
//
// 2026-09-21 신촌세브란스 도봉 사고: 9/18~9/21 사흘간 배차 차량(6626)과 실 운행 차량(6623)이
// 달랐는데 어느 화면에도 안 드러났다. 이 판정이 그 사흘을 당일에 잡는다.
//
// 🔴 고정본은 **prod 실측**이다(scripts/fixtures/route_adherence.json).
//    합성 표본만 쓰면 "정상인데 걸리는" 노선(정류장 좌표가 도로에서 떨어진 파주,
//    단말 신호가 희박한 김포)을 못 만들어 내서 임계값이 공허해진다.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "routeAdherence.js"), "utf8")
  .replace(/^import\s+\{[^}]*\}\s+from\s+["'][^"']+["'];?$/gm, "")
  .replace(/^export\s+function\s+/gm, "function ")
  .replace(/^export\s+const\s+/gm, "var ");
const ctx = vm.createContext({ console });
vm.runInContext(src, ctx);
const {
  scoreAdherence, adherenceVerdict, adherenceRows, runWindow, adherenceLabel,
  distanceM, hhmmToMin, usableStops, NEAR_M, MIN_POINTS, RATIO_BAD, MEDIAN_BAD_M,
} = ctx;

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "route_adherence.json"), "utf8"));

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log(`  ✅ ${n}`); }
  else { fail++; console.log(`  ❌ ${n}${x !== undefined ? " — " + JSON.stringify(x) : ""}`); }
};
const caseOf = (label) => FIX.cases.find((c) => c.label === label);
const scoreOf = (c) => {
  const win = runWindow(c.dayStartMs, c.dispatch.departTime, c.stops);
  const pts = win ? c.points.filter((p) => p.ms >= win.startMs && p.ms <= win.endMs) : c.points;
  return scoreAdherence(pts, c.stops);
};

console.log("\n[0] 고정본이 실제로 신호를 담고 있나(공허한 통과 방지)");
{
  ok("고정본 4건", FIX.cases.length === 4, FIX.cases.map((c) => c.label));
  ok("이상 표본 1건 · 정상 표본 3건",
    FIX.cases.filter((c) => c.expect === "offroute").length === 1 &&
    FIX.cases.filter((c) => c.expect === "ok").length === 3);
  const bad = scoreOf(caseOf("도봉_사고일"));
  const good = scoreOf(caseOf("도봉_정상일"));
  ok(`사고일과 정상일이 같은 노선인데 점수가 갈린다 (${bad.hit}/${bad.total} vs ${good.hit}/${good.total})`,
    bad.hit < good.hit, { bad: bad.hit, good: good.hit });
}

console.log("\n[1] 🔴 prod 실측 판정 — 사고 배차만 걸린다");
{
  FIX.cases.forEach((c) => {
    const s = scoreOf(c);
    const v = adherenceVerdict(s);
    ok(`${c.label} → ${c.expect} (${adherenceLabel(s)})`, v === c.expect, { got: v, s: { hit: s.hit, total: s.total, med: s.medianM, n: s.n } });
  });
}

console.log("\n[2] 🔴 두 조건은 AND — 한쪽만으로 판정하면 정상 배차가 걸린다");
{
  const paju = scoreOf(caseOf("파주운정교하_정상"));
  const gimpo = scoreOf(caseOf("김포_신호희박"));
  ok(`파주는 통과율이 낮다(${Math.round(paju.ratio * 100)}% < 50%) — 통과율만 보면 걸린다`, paju.ratio < 0.5, paju.ratio);
  ok("그래도 최근접 중앙값이 작아 정상", paju.medianM <= MEDIAN_BAD_M && adherenceVerdict(paju) === "ok", paju.medianM);
  ok(`김포는 통과율이 낮다(${Math.round(gimpo.ratio * 100)}%)`, gimpo.ratio < 0.5, gimpo.ratio);
  ok("그래도 중앙값이 임계 아래라 정상", gimpo.medianM <= MEDIAN_BAD_M && adherenceVerdict(gimpo) === "ok", gimpo.medianM);
  // 대조군: 통과율 조건만으로 판정하면 파주·김포가 함께 걸린다
  const ratioOnly = (s) => (s.ratio < RATIO_BAD ? "offroute" : "ok");
  const medianOnly = (s) => (s.medianM > MEDIAN_BAD_M ? "offroute" : "ok");
  const bad = scoreOf(caseOf("도봉_사고일"));
  ok("대조군: 통과율만 보는 판정도 사고 배차는 잡는다", ratioOnly(bad) === "offroute");
  ok("대조군: 중앙값만 보는 판정도 사고 배차는 잡는다", medianOnly(bad) === "offroute");
  ok("🔴 AND 가 아니면 정상 배차가 걸릴 여지가 생긴다(경계 확인)",
    paju.ratio < RATIO_BAD || paju.medianM <= MEDIAN_BAD_M, { r: paju.ratio, m: paju.medianM });
}

console.log("\n[3] 운행 창 — 다른 회차 궤적을 안 섞는다");
{
  const c = caseOf("도봉_사고일");
  const win = runWindow(c.dayStartMs, "06:58", c.stops);
  const inWin = c.points.filter((p) => p.ms >= win.startMs && p.ms <= win.endMs).length;
  ok("06:58 창에 그날 궤적이 들어온다", inWin > 0 && inWin <= c.points.length, { inWin, all: c.points.length });
  const eve = runWindow(c.dayStartMs, "18:00", c.stops);
  const inEve = c.points.filter((p) => p.ms >= eve.startMs && p.ms <= eve.endMs).length;
  ok("🔴 같은 차량의 18:00 회차 창에는 오전 궤적이 안 들어온다", inEve === 0, inEve);
  ok("departTime 없으면 창 없음(null)", runWindow(c.dayStartMs, "", c.stops) === null);
  ok("창 시작은 출발 30분 전", win.startMs === c.dayStartMs + (6 * 60 + 58 - 30) * 60000);
}

console.log("\n[4] 판정 불가 — 지어내지 않는다");
{
  const c = caseOf("도봉_사고일");
  const few = scoreAdherence(c.points.slice(0, MIN_POINTS - 1), c.stops);
  ok(`궤적 ${MIN_POINTS}점 미만이면 insufficient`, adherenceVerdict(few) === "insufficient", few.n);
  const twoStops = scoreAdherence(c.points, c.stops.slice(0, 2));
  ok("정류장 3개 미만이면 insufficient", adherenceVerdict(twoStops) === "insufficient");
  const noCoord = scoreAdherence(c.points, [{ id: "a" }, { id: "b" }, { id: "c" }]);
  ok("좌표 없는 정류장뿐이면 insufficient", adherenceVerdict(noCoord) === "insufficient", noCoord);
  ok("궤적 0점이면 insufficient", adherenceVerdict(scoreAdherence([], c.stops)) === "insufficient");
  ok("입력이 없어도 던지지 않는다", adherenceVerdict(scoreAdherence(null, null)) === "insufficient");
}

console.log("\n[5] 목록 — 이상 → 판정불가 → 정상 순");
{
  const stopsByRoute = {}, pointsByVehicle = {}, disp = [];
  FIX.cases.forEach((c, i) => {
    const rid = c.dispatch.routeId + "#" + i;
    const vid = c.dispatch.vehicleId + "#" + i;
    stopsByRoute[rid] = c.stops;
    pointsByVehicle[vid] = c.points.map((p) => ({ ...p, ms: p.ms - c.dayStartMs + FIX.cases[0].dayStartMs }));
    disp.push({ ...c.dispatch, id: "d" + i, routeId: rid, vehicleId: vid });
  });
  const rows = adherenceRows(disp, stopsByRoute, pointsByVehicle, FIX.cases[0].dayStartMs);
  ok("행 4건", rows.length === 4, rows.length);
  ok("첫 행이 이상 배차", rows[0].verdict === "offroute", rows.map((r) => `${r.routeName}:${r.verdict}`));
  const idx = { offroute: 0, insufficient: 1, ok: 2 };
  ok("등급 순으로 정렬", rows.every((r, i) => i === 0 || idx[rows[i - 1].verdict] <= idx[r.verdict]));
  ok("routeId·vehicleId 없는 배차는 건너뛴다",
    adherenceRows([{ id: "x" }, { id: "y", routeId: "r" }], {}, {}, 0).length === 0);
}

console.log("\n[5b] 🔴 아직 출발 전인 회차는 'pending' — 아침 목록을 퇴근 배차가 덮지 않게");
{
  const c = caseOf("도봉_사고일");
  const stopsByRoute = { r: c.stops };
  const pointsByVehicle = { v: c.points };
  const morning = { id: "m", routeId: "r", vehicleId: "v", routeName: "06:58 도봉", departTime: "06:58" };
  const evening = { id: "e", routeId: "r", vehicleId: "v", routeName: "18:00 도봉", departTime: "18:00" };
  const at09 = c.dayStartMs + 9 * 3600000;
  const rows = adherenceRows([morning, evening], stopsByRoute, pointsByVehicle, c.dayStartMs, { nowMs: at09 });
  const m = rows.find((r) => r.id === "m"), e = rows.find((r) => r.id === "e");
  ok("09시 점검: 오전 회차는 판정된다", m.verdict === "offroute", m.verdict);
  ok("🔴 09시 점검: 18:00 회차는 pending(판정 불가로 쌓이지 않는다)", e.verdict === "pending", e.verdict);
  ok("pending 이 맨 뒤로 정렬", rows[rows.length - 1].verdict === "pending");
  // 대조군 — nowMs 를 안 주면 옛 동작(퇴근 회차가 'insufficient' 로 쌓인다)
  const legacy = adherenceRows([morning, evening], stopsByRoute, pointsByVehicle, c.dayStartMs);
  ok("대조군: nowMs 없으면 퇴근 회차가 판정 불가로 쌓인다(= 고치기 전 상태)",
    legacy.find((r) => r.id === "e").verdict === "insufficient", legacy.find((r) => r.id === "e").verdict);
  const at19 = c.dayStartMs + 19 * 3600000;
  ok("19시 점검: 18:00 회차도 판정 대상이 된다",
    adherenceRows([evening], stopsByRoute, pointsByVehicle, c.dayStartMs, { nowMs: at19 }).find((r) => r.id === "e").verdict !== "pending");
  ok("departTime 없으면 pending 으로 미루지 않는다",
    adherenceRows([{ id: "z", routeId: "r", vehicleId: "v" }], stopsByRoute, pointsByVehicle, c.dayStartMs, { nowMs: 0 })[0].verdict !== "pending");
}

console.log("\n[6] 기하·파싱 기본");
{
  ok("같은 점 거리 0", Math.round(distanceM(37.5, 127, 37.5, 127)) === 0);
  ok("위도 0.001 ≈ 111m", Math.abs(distanceM(37.5, 127, 37.501, 127) - 111) < 3, distanceM(37.5, 127, 37.501, 127));
  ok("hhmmToMin", hhmmToMin("06:58") === 418 && hhmmToMin("24:00") === null && hhmmToMin("") === null);
  ok("usableStops 가 좌표 무효를 뺀다", usableStops([{ lat: 1, lng: 2, order: 2 }, { lat: NaN, lng: 1 }, { lng: 1 }]).length === 1);
  ok("usableStops 가 order 로 정렬", usableStops([{ lat: 1, lng: 1, order: 3 }, { lat: 1, lng: 1, order: 1 }])[0].order === 1);
}

console.log("\n[7] 소스 가드 — 복원 금지 항목");
{
  const raw = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "routeAdherence.js"), "utf8");
  ok("🔴 판정이 AND 로 남아 있다", /score\.ratio\s*<\s*ratioBad\s*&&\s*score\.medianM\s*>\s*medianBad/.test(raw));
  ok("임계 상수 4종이 이름으로 노출된다",
    /export const RATIO_BAD/.test(raw) && /export const MEDIAN_BAD_M/.test(raw) &&
    /export const MIN_POINTS/.test(raw) && /export const NEAR_M/.test(raw));
  ok("🔴 Firebase import 없음(순수 모듈)", !/from\s+["']firebase/.test(raw) && !/require\(/.test(raw));
  ok("🔴 실측 근거가 주석에 남아 있다(임계값을 추측으로 바꾸지 못하게)", /1,320m|1,568m/.test(raw));
  ok("기본 임계값이 실측 경계 안", RATIO_BAD === 0.25 && MEDIAN_BAD_M === 1000 && NEAR_M === 300 && MIN_POINTS === 10);
}

console.log(`\n${fail === 0 ? "✅ 전부 통과" : "❌ 실패 있음"} — ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
