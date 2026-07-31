// 격리 테스트 — functions/index.js 의 "그린 경로 정합" 기하 (2026-07-31).
//   node scripts/test_navi_drawn_match.cjs
//
// 기사 지적("내가 그려놓은 노선대로 안내를 하는 것 같지 않다")의 처방을 검증한다.
// 판정식을 **실제 소스에서 뽑아** 평가한다(테스트용 복제본을 만들면 소스가 바뀌어도 통과한다).
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "functions", "index.js"), "utf8");

/** 소스에서 함수 선언 하나를 중괄호 짝을 세어 통째로 떼어낸다. */
function extractFn(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`소스에서 ${name} 를 찾지 못했다`);
  let i = SRC.indexOf("{", start), depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error(`${name} 의 끝을 못 찾았다`);
}

/** 소스의 상수도 그대로 가져온다(테스트가 값을 따로 들고 있으면 소스와 어긋난다). */
function constOf(name) {
  const m = SRC.match(new RegExp(`const ${name}\\s*=\\s*([\\d.]+)`));
  if (!m) throw new Error(`소스에서 ${name} 를 찾지 못했다`);
  return Number(m[1]);
}
const ctx = vm.createContext({
  console,
  DRAWN_MATCH_KM_PER_POINT: constOf("DRAWN_MATCH_KM_PER_POINT"),
  DRAWN_MATCH_MAX_PER_RUN: constOf("DRAWN_MATCH_MAX_PER_RUN"),
});
["distMeters", "distToSegMeters", "distToPathMeters", "worstDeviationPoints", "progressAlongDrawn", "drawnMismatchRatio"]
  .forEach((n) => vm.runInContext(extractFn(n), ctx));
const { distToSegMeters, distToPathMeters, worstDeviationPoints, progressAlongDrawn, drawnMismatchRatio } = ctx;

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${x !== undefined ? " — " + JSON.stringify(x) : ""}`); } };
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b), { actual: a, expected: b });

// 위도 37.4 근처에서 경도 0.001도 ≈ 88m, 위도 0.001도 ≈ 111m
const B = { lat: 37.4, lng: 127.0 };
const at = (dLatM, dLngM) => ({ lat: B.lat + dLatM / 111320, lng: B.lng + dLngM / (111320 * Math.cos(B.lat * Math.PI / 180)) });

console.log("[거리 기하]");
{
  const a = at(0, 0), b = at(0, 1000);
  ok("선분 위의 점 = 0m", distToSegMeters(at(0, 500), a, b) < 1);
  ok("선분에서 100m 옆", Math.abs(distToSegMeters(at(100, 500), a, b) - 100) < 2, distToSegMeters(at(100, 500), a, b));
  ok("선분 끝 너머는 끝점까지 거리", Math.abs(distToSegMeters(at(0, 1500), a, b) - 500) < 3, distToSegMeters(at(0, 1500), a, b));
  eq("길이 0 선분", Math.round(distToSegMeters(at(0, 100), a, a)), 100);

  const poly = [at(0, 0), at(0, 1000), at(1000, 1000)];
  ok("폴리라인 최단거리는 가장 가까운 선분", distToPathMeters(at(50, 500), poly) < 55, distToPathMeters(at(50, 500), poly));
}

console.log("\n[이탈 구간 추출 — 벗어난 구간마다 최악점 1개]");
{
  // 그린 경로: 동쪽으로 곧게 2km. 도로 경로: 같은 직선.
  const drawn = Array.from({ length: 21 }, (_, i) => at(0, i * 100));
  const road = [at(0, 0), at(0, 2000)];
  eq("완전 일치면 보정점 없음", worstDeviationPoints(drawn, road, 300, 6), []);

  // 그린 경로 가운데가 북쪽으로 크게 우회(= 회사가 다니는 다른 길)
  const detour = drawn.map((p, i) => (i >= 8 && i <= 12 ? at(400 + (i === 10 ? 300 : 0), i * 100) : p));
  const w1 = worstDeviationPoints(detour, road, 300, 6);
  eq("우회 구간 1곳 → 보정점 1개", w1.length, 1);
  eq("그 구간에서 가장 많이 벗어난 점을 고른다", w1[0].idx, 10);
  ok("이탈 거리도 같이 준다(≈700m)", Math.abs(w1[0].dev - 700) < 20, w1[0].dev);

  // 떨어진 두 구간
  const two = drawn.map((p, i) => {
    if (i >= 3 && i <= 5) return at(500, i * 100);
    if (i >= 14 && i <= 16) return at(900, i * 100);
    return p;
  });
  const w2 = worstDeviationPoints(two, road, 300, 6);
  eq("떨어진 두 구간 → 2개", w2.length, 2);
  ok("이탈이 큰 구간이 먼저", w2[0].dev > w2[1].dev, w2.map((x) => Math.round(x.dev)));
  ok("두 구간에서 각각 하나씩", w2[0].idx >= 14 && w2[1].idx >= 3 && w2[1].idx <= 5, w2.map((x) => x.idx));

  eq("상한을 넘겨 뽑지 않는다", worstDeviationPoints(two, road, 300, 1).length, 1);
  eq("임계가 높으면 아무것도 안 뽑는다", worstDeviationPoints(two, road, 2000, 6), []);
  eq("그린 경로가 없으면 빈 배열", worstDeviationPoints([], road, 300, 6), []);
  eq("도로 경로가 없으면 빈 배열", worstDeviationPoints(drawn, [], 300, 6), []);
  eq("배열이 아니면 빈 배열", worstDeviationPoints(null, road, 300, 6), []);

  // 🔴 경계: 마지막 점까지 벗어난 채로 끝나도 그 구간을 놓치지 않아야 한다
  const tailOff = drawn.map((p, i) => (i >= 18 ? at(800, i * 100) : p));
  eq("끝까지 벗어난 구간도 잡는다", worstDeviationPoints(tailOff, road, 300, 6).length, 1);
}

console.log("\n[긴 우회 구간은 점을 더 꽂는다 — 점 1개로는 못 끌어온다(압구정 하교 사례)]");
{
  // 동쪽으로 20km 직선 그린 경로. 가운데 8km 가 통째로 북쪽 2km 로 우회.
  const drawn = Array.from({ length: 101 }, (_, i) => at(0, i * 200));
  const road = [at(0, 0), at(0, 20000)];
  const long = drawn.map((p, i) => (i >= 30 && i <= 70 ? at(2000, i * 200) : p));
  const w = worstDeviationPoints(long, road, 300, 6);
  ok("8km 우회 구간엔 여러 점(구간당 상한 3)", w.length === 3, w.map((x) => x.idx));
  ok("구간 안에 고르게 배치", w.every((x) => x.idx >= 30 && x.idx <= 70), w.map((x) => x.idx));
  ok("서로 다른 위치", new Set(w.map((x) => x.idx)).size === w.length, w.map((x) => x.idx));
  ok("순서대로", w[0].idx < w[1].idx && w[1].idx < w[2].idx, w.map((x) => x.idx));

  // 짧은 우회(500m)는 여전히 1점 — 아껴 넣어야 U턴이 안 생긴다
  const shortDetour = drawn.map((p, i) => (i >= 40 && i <= 42 ? at(500, i * 200) : p));
  eq("짧은 우회는 1점", worstDeviationPoints(shortDetour, road, 300, 6).length, 1);

  // 전체 상한을 넘지 않는다
  ok("전체 상한 준수", worstDeviationPoints(long, road, 300, 2).length === 2);
}

console.log("\n[채택 판정 — 나빠지면 기각한다]");
{
  const drawn = Array.from({ length: 21 }, (_, i) => at(0, i * 100));
  const good = [at(0, 0), at(0, 2000)];
  const bad = [at(5000, 0), at(5000, 2000)];
  eq("완전 일치 = 0", drawnMismatchRatio(drawn, good, 300), 0);
  eq("완전 이탈 = 1", drawnMismatchRatio(drawn, bad, 300), 1);
  ok("도로 경로가 없으면 최악(1)로 본다", drawnMismatchRatio(drawn, [], 300) === 1);
  ok("그린 경로가 없으면 최악(1)로 본다", drawnMismatchRatio([], good, 300) === 1);
  const half = drawn.map((p, i) => (i > 10 ? at(4000, i * 100) : p));
  const r = drawnMismatchRatio(half, good, 300);
  ok("절반 이탈 ≈ 0.5", Math.abs(r - 10 / 21) < 0.01, r);
}

console.log("\n[진행 순서 정렬 — 경유지가 뒤섞이면 되돌아가는 경로가 나온다]");
{
  const drawn = Array.from({ length: 11 }, (_, i) => at(0, i * 100));
  const cum = [0];
  for (let i = 1; i < drawn.length; i++) {
    const dy = (drawn[i].lat - drawn[i - 1].lat) * 111320;
    const dx = (drawn[i].lng - drawn[i - 1].lng) * 111320 * Math.cos(B.lat * Math.PI / 180);
    cum.push(cum[i - 1] + Math.hypot(dx, dy));
  }
  const p3 = progressAlongDrawn(at(0, 300), drawn, cum);
  const p7 = progressAlongDrawn(at(0, 700), drawn, cum);
  ok("뒤쪽 점의 진행거리가 더 크다", p7 > p3, { p3, p7 });
  ok("진행거리가 실제 거리와 비슷", Math.abs(p3 - 300) < 120, p3);
  ok("경로에서 옆으로 벗어난 점도 가장 가까운 구간으로 매핑", Math.abs(progressAlongDrawn(at(400, 500), drawn, cum) - 500) < 120);
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
