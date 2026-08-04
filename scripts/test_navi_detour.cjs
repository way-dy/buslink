// 격리 테스트 — 덤 우회 감지·원인 귀속·점수 (2026-08-05).
//   node scripts/test_navi_detour.cjs
//
// 판정 함수를 **CF 소스(functions/index.js)에서 그대로 뽑아** 평가한다(복제본을 쓰면
// 소스가 바뀌어도 통과해 버린다). 네트워크·Firebase 접근 0.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "functions", "index.js"), "utf8");

function extractFn(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`소스에서 ${name} 없음`);
  let i = SRC.indexOf("{", start), depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error(`${name} 끝 없음`);
}
const constOf = (n) => Number((SRC.match(new RegExp(`const ${n}\\s*=\\s*([\\d.]+)`)) || [])[1]);
const CONSTS = {
  DRAWN_MATCH_THRESHOLD_M: constOf("DRAWN_MATCH_THRESHOLD_M"),
  DRAWN_MATCH_KM_PER_POINT: constOf("DRAWN_MATCH_KM_PER_POINT"),
  DRAWN_MATCH_MAX_PER_RUN: constOf("DRAWN_MATCH_MAX_PER_RUN"),
  DETOUR_THRESHOLD_M: constOf("DETOUR_THRESHOLD_M"),
  DETOUR_MIN_RUN_M: constOf("DETOUR_MIN_RUN_M"),
  STOP_COVER_M: constOf("STOP_COVER_M"),
  DETOUR_PRUNE_ROUNDS: constOf("DETOUR_PRUNE_ROUNDS"),
  KAKAO_NAVI_MAX_CALLS: constOf("KAKAO_NAVI_MAX_CALLS"),
};
const ctx = vm.createContext({ console, ...CONSTS });
["distMeters", "distToSegMeters", "distToPathMeters", "worstDeviationPoints", "drawnMismatchRatio",
  "detourRuns", "detourMeters", "naviRouteScore", "allStopsCovered", "detourSuspects", "uturnCount"]
  .forEach((n) => vm.runInContext(extractFn(n), ctx));
const { distMeters, distToPathMeters, drawnMismatchRatio, detourRuns, detourMeters,
  naviRouteScore, allStopsCovered, detourSuspects, uturnCount } = ctx;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; } else { fail++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ""}`); } };

// ── 합성 지형 ────────────────────────────────────────────────
// 그린 경로 = 위도 37.5 를 따라 동쪽으로 곧게 2km(경도 127.000 → 127.0227).
const LAT = 37.5, LNG0 = 127.0;
const mPerLng = 111320 * Math.cos(LAT * Math.PI / 180);
const east = (m) => LNG0 + m / mPerLng;
const north = (m) => LAT + m / 111320;
const drawn = [];
for (let m = 0; m <= 2000; m += 50) drawn.push({ lat: LAT, lng: east(m) });
const drawnLen = 2000;

// 도로A = 그린과 같은 길(덤 없음)
const roadClean = [], secClean = [];
for (let m = 0; m <= 2000; m += 25) { roadClean.push({ lat: LAT, lng: east(m) }); secClean.push(m < 1000 ? 0 : 1); }

// 도로B = 같은 길인데 1,000m 지점에서 북쪽으로 400m 나갔다 되돌아온다(= 유턴 우회).
//   그린 점은 전부 도로에 덮이므로 **기존 한 방향 잣대에는 안 잡힌다** — 이번 결함의 핵심.
const roadDetour = [], secDetour = [];
for (let m = 0; m <= 1000; m += 25) { roadDetour.push({ lat: LAT, lng: east(m) }); secDetour.push(0); }
for (let n = 25; n <= 400; n += 25) { roadDetour.push({ lat: north(n), lng: east(1000) }); secDetour.push(1); }
for (let n = 400 - 25; n >= 0; n -= 25) { roadDetour.push({ lat: north(n), lng: east(1000) }); secDetour.push(1); }
for (let m = 1025; m <= 2000; m += 25) { roadDetour.push({ lat: LAT, lng: east(m) }); secDetour.push(2); }

console.log("① 덤 우회 감지 — 기존 한 방향 잣대가 못 보던 것");
ok("깨끗한 도로는 덤 0", detourRuns(roadClean, secClean, drawn, CONSTS.DETOUR_THRESHOLD_M).length === 0);
const runs = detourRuns(roadDetour, secDetour, drawn, CONSTS.DETOUR_THRESHOLD_M);
ok("우회 도로에서 덤 구간 1개 검출", runs.length === 1, `${runs.length}개`);
ok("덤 길이 ≈ 왕복 500m 이상", runs[0] && runs[0].meters > 450, runs[0] && `${Math.round(runs[0].meters)}m`);
ok("최대 이탈 ≈ 400m", runs[0] && Math.abs(runs[0].maxDev - 400) < 20, runs[0] && `${Math.round(runs[0].maxDev)}m`);
// 🔴 회귀의 정체: 그린→도로(기존 잣대)로는 0 — 그래서 "이미 일치"로 보정을 건너뛰었다.
ok("기존 잣대(그린→도로)는 우회를 0% 로 본다",
  drawnMismatchRatio(drawn, roadDetour, CONSTS.DRAWN_MATCH_THRESHOLD_M) === 0);
ok("깨끗/우회의 기존 잣대가 동일(=구분 불가)",
  drawnMismatchRatio(drawn, roadClean, CONSTS.DRAWN_MATCH_THRESHOLD_M) === drawnMismatchRatio(drawn, roadDetour, CONSTS.DRAWN_MATCH_THRESHOLD_M));
ok("새 점수는 우회를 더 나쁘게 본다",
  naviRouteScore(drawn, drawnLen, roadDetour, secDetour) > naviRouteScore(drawn, drawnLen, roadClean, secClean));
ok("깨끗한 도로 점수 0", naviRouteScore(drawn, drawnLen, roadClean, secClean) === 0);
ok("덤 총합 = 구간 합", Math.abs(detourMeters(roadDetour, secDetour, drawn, CONSTS.DETOUR_THRESHOLD_M) - runs[0].meters) < 1e-6);
ok("임계보다 작은 이탈은 덤이 아니다", detourRuns(
  [{ lat: LAT, lng: east(0) }, { lat: north(50), lng: east(500) }, { lat: LAT, lng: east(1000) }],
  [0, 0, 0], drawn, CONSTS.DETOUR_THRESHOLD_M).length === 0);
ok("빈 입력 방어", detourRuns([], [], drawn, 150).length === 0 && detourRuns(roadClean, secClean, [], 150).length === 0);

console.log("② 원인 경유지 귀속 — 거리가 아니라 leg 경계로");
// 덤이 leg 1 에서 났다 → 범인 후보는 waypoint 0(leg1 진입)·waypoint 1(leg1 도착).
ok("leg1 우회 → 후보 [0,1]", JSON.stringify(detourSuspects(runs, 3)) === JSON.stringify([0, 1]),
  JSON.stringify(detourSuspects(runs, 3)));
ok("leg0 우회는 waypoint 0 만(출발지는 못 뺀다)",
  JSON.stringify(detourSuspects([{ sections: [0] }], 3)) === JSON.stringify([0]));
ok("마지막 leg 은 목적지를 후보에서 제외",
  JSON.stringify(detourSuspects([{ sections: [3] }], 3)) === JSON.stringify([2]));
ok("경유지 없는 노선은 후보 0", detourSuspects(runs, 0).length === 0);
ok("여러 구간의 후보를 중복 없이 합친다",
  JSON.stringify(detourSuspects([{ sections: [1] }, { sections: [1, 2] }], 4)) === JSON.stringify([0, 1, 2]));

console.log("③ 정류장 누락 방지 가드");
const stopsOnPath = [{ x: east(0), y: LAT }, { x: east(1000), y: LAT }, { x: east(2000), y: LAT }];
ok("그린 위 정류장은 우회를 빼도 덮인다", allStopsCovered(stopsOnPath, roadClean, CONSTS.STOP_COVER_M));
const stopFarAway = [{ x: east(1000), y: north(900) }];
ok("도로에서 먼 정류장은 기각 신호", !allStopsCovered(stopFarAway, roadClean, CONSTS.STOP_COVER_M));
ok("경계값(임계 이내)은 통과",
  allStopsCovered([{ x: east(500), y: north(CONSTS.STOP_COVER_M - 10) }], roadClean, CONSTS.STOP_COVER_M));
ok("경계값(임계 초과)은 기각",
  !allStopsCovered([{ x: east(500), y: north(CONSTS.STOP_COVER_M + 10) }], roadClean, CONSTS.STOP_COVER_M));

console.log("④ 유턴 세기");
ok("유턴 안내를 센다", uturnCount([{ guidance: "선바위역 서울 방면으로 유턴" }, { guidance: "우회전" }]) === 1);
ok("U턴 표기도 센다", uturnCount([{ guidance: "U턴" }]) === 1);
ok("유턴 없으면 0", uturnCount([{ guidance: "좌회전" }, { guidance: "직진" }]) === 0);
ok("빈 입력 0", uturnCount(null) === 0 && uturnCount([]) === 0);
ok("guidance 부재 방어", uturnCount([{}, { guidance: null }]) === 0);

console.log("⑤ 과천라인 실측 형태 재현 — 옛 판정이 통과시키던 경로");
// 실측: 그린 14.1km · 도로 16.0km · 덤 750m · 유턴 2 인데 그린→도로 이탈 0% 였다.
{
  const oldVerdict = drawnMismatchRatio(drawn, roadDetour, CONSTS.DRAWN_MATCH_THRESHOLD_M) === 0;
  const newVerdict = naviRouteScore(drawn, drawnLen, roadDetour, secDetour) > 0;
  ok("옛 판정 = 문제없음 · 새 판정 = 문제있음", oldVerdict && newVerdict);
  // 우회를 뺀 경로가 실제로 더 좋은 점수여야 제거가 채택된다.
  ok("우회 제거본이 더 낮은 점수",
    naviRouteScore(drawn, drawnLen, roadClean, secClean) < naviRouteScore(drawn, drawnLen, roadDetour, secDetour));
}

console.log("⑥ 회귀 가드가 소스에 실제로 있는지");
const guards = [
  ["보정 무조건 채택 금지(점수 비교)", /sc < bestScore && newLen <= drawnLen \* DRAWN_MATCH_MAX_LEN_RATIO/],
  ["구간당 점 수는 길이 비례 유지", /DRAWN_MATCH_MAX_PER_RUN/],
  ["덤 우회 양방향 점수", /function naviRouteScore\([\s\S]*?drawnMismatchRatio[\s\S]*?detourMeters/],
  ["경유지 제거 시 정류장 커버 검사", /allStopsCovered\(pts, pruned\.path, STOP_COVER_M\)/],
  ["유턴 회피도 점수 나빠지면 기각", /sc < bestScore \|\| \(sc <= bestScore \+ 0\.01 && fewer\)/],
  ["원인 귀속은 leg 경계(detourSuspects)", /detourSuspects\(runs\.slice\(0, 3\), cand\.waypoints\.length\)/],
  ["카카오 호출 상한", /if \(kakaoCalls >= KAKAO_NAVI_MAX_CALLS\) return null;/],
  ["응답 저장 금지 주석 유지", /저장하지 않고 그대로 돌려|저장하지 않고 그대로 반환/],
  ["vertexes x=경도·y=위도 주의 유지", /x=경도.{0,4}y=위도/],
  ["유턴 회피는 요청할 때만 붙인다", /\.\.\.\(avoidUturn \? \{ avoid: \["uturn"\] \} : \{\}\)/],
];
guards.forEach(([name, re]) => ok(`가드: ${name}`, re.test(SRC)));

console.log("⑦ 상수 sanity");
ok("덤 임계 < 그린 이탈 임계", CONSTS.DETOUR_THRESHOLD_M < CONSTS.DRAWN_MATCH_THRESHOLD_M);
ok("최소 덤 길이 > 0", CONSTS.DETOUR_MIN_RUN_M > 0);
ok("정류장 커버 임계 > 0", CONSTS.STOP_COVER_M > 0);
ok("호출 상한 ≥ 라운드 수 + 3", CONSTS.KAKAO_NAVI_MAX_CALLS >= CONSTS.DETOUR_PRUNE_ROUNDS + 3);

console.log(`\n${fail ? "❌" : "✅"} ${pass}/${pass + fail} 통과`);
process.exit(fail ? 1 : 0);
