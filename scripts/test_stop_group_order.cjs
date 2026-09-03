// 격리 테스트 — 정류장별 탑승을 «노선 그룹 + 운행 순서»로 묶는다(src/lib/stopMapping.js).
//   node scripts/test_stop_group_order.cjs
//
// 2026-09-03 요청: 탑승수 내림차순 한 줄 나열은 노선이 뒤섞여 «어느 구간에서 사람이 타는가»를
// 못 읽는다. 노선으로 묶고 그 안은 버스가 지나는 순서여야 통계로 쓸 수 있다.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "stopMapping.js"), "utf8")
  .replace(/^import\s+\{[^}]*\}\s+from\s+["'][^"']+["'];?$/gm, "")
  .replace(/^export\s+function\s+/gm, "function ")
  .replace(/^export\s+const\s+/gm, "var ");
// haversine 스텁 — 평면 근사(1도 ≈ 111km). 순번/그룹 규칙만 검사하므로 정밀도 무관.
const haversine = (a, b) => Math.hypot(a.lat - b.lat, a.lng - b.lng) * 111000;
const ctx = vm.createContext({ console, haversine, window: { Map, Set } });
vm.runInContext(src, ctx);
const { aggregateBoardingsByStop, groupMappedByRoute } = ctx;

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${x !== undefined ? " — " + JSON.stringify(x) : ""}`); } };

// 노선 A: 정류장 3곳(운행 순서 s1→s2→s3), 노선 B: 2곳.
const STOPS = {
  rA: [
    { id: "s1", name: "첫 정류장", order: 0, lat: 37.500, lng: 127.000 },
    { id: "s2", name: "둘째 정류장", order: 1, lat: 37.510, lng: 127.000 },
    { id: "s3", name: "셋째 정류장", order: 2, lat: 37.520, lng: 127.000 },
  ],
  rB: [
    { id: "t1", name: "B첫째", order: 0, lat: 37.600, lng: 127.000 },
    { id: "t2", name: "B둘째", order: 1, lat: 37.610, lng: 127.000 },
  ],
};
const at = (s, n) => Array.from({ length: n }, () => ({
  routeId: s.routeId, routeName: s.routeName, vehicleLat: s.lat, vehicleLng: s.lng,
}));
const A = (stop, n) => at({ routeId: "rA", routeName: "06:48 광명", lat: stop.lat, lng: stop.lng }, n);
const B = (stop, n) => at({ routeId: "rB", routeName: "06:55 행신", lat: stop.lat, lng: stop.lng }, n);

console.log("\n[1] 🔴 노선 안에서는 탑승수가 아니라 «운행 순서»로 늘어선다");
{
  // 일부러 뒤 정류장에 탑승을 몰아준다 — 카운트 정렬이면 순서가 뒤집힌다.
  const boardings = [...A(STOPS.rA[0], 1), ...A(STOPS.rA[1], 9), ...A(STOPS.rA[2], 5)];
  const { mapped } = aggregateBoardingsByStop(boardings, STOPS, 300);
  const g = groupMappedByRoute(mapped, STOPS);
  ok("노선 1개 그룹", g.length === 1, g.map(x => x.routeName));
  ok("정류장이 s1→s2→s3 순서", g[0].stops.map(s => s.stopId).join(",") === "s1,s2,s3", g[0].stops.map(s => s.stopId));
  ok("순번 1,2,3 부여", g[0].stops.map(s => s.seq).join(",") === "1,2,3", g[0].stops.map(s => s.seq));
  ok("그룹 합계 = 15건", g[0].total === 15, g[0].total);
  ok("건수는 그대로", g[0].stops.map(s => s.count).join(",") === "1,9,5");
}

console.log("\n[2] 노선끼리는 섞이지 않는다 · 그룹은 합계 내림차순");
{
  const boardings = [...A(STOPS.rA[2], 2), ...B(STOPS.rB[0], 7), ...A(STOPS.rA[0], 3), ...B(STOPS.rB[1], 1)];
  const { mapped } = aggregateBoardingsByStop(boardings, STOPS, 300);
  const g = groupMappedByRoute(mapped, STOPS);
  ok("그룹 2개", g.length === 2);
  ok("합계 많은 노선(rB 8건)이 먼저", g[0].routeId === "rB", g.map(x => [x.routeId, x.total]));
  ok("rB 안은 t1→t2", g[0].stops.map(s => s.stopId).join(",") === "t1,t2");
  ok("rA 안은 s1→s3(운행 순서 유지)", g[1].stops.map(s => s.stopId).join(",") === "s1,s3", g[1].stops.map(s => s.stopId));
  ok("rA 순번은 1,3 — 건너뛴 s2 가 보인다", g[1].stops.map(s => s.seq).join(",") === "1,3", g[1].stops.map(s => s.seq));
  ok("노선 전체 정류장 수 노출", g[1].routeStopCount === 3 && g[0].routeStopCount === 2);
  ok("🔴 노선 소계 = 그 노선 정류장 합", g[0].total === g[0].stops.reduce((a, s) => a + s.count, 0), g[0].total);
  ok("🔴 소계 총합 = 전체 매핑 건수", g.reduce((a, x) => a + x.total, 0) === 13, g.map(x => x.total));
}

console.log("\n[3] 🔴 순번을 모르는 정류장도 버리지 않는다 — 그룹 맨 뒤로만 간다");
{
  // stopId 를 명시 보유하지만 노선 stops 에 없는(삭제된) 정류장 — legacy 경로.
  const boardings = [
    { routeId: "rA", routeName: "06:48 광명", stopId: "지워진정류장", stopName: "옛 정류장" },
    ...A(STOPS.rA[1], 2),
  ];
  const { mapped } = aggregateBoardingsByStop(boardings, STOPS, 300);
  const g = groupMappedByRoute(mapped, STOPS);
  ok("두 정류장 모두 남는다", g[0].stops.length === 2, g[0].stops.map(s => s.stopName));
  ok("순번 있는 쪽이 앞", g[0].stops[0].stopId === "s2");
  ok("순번 없는 쪽 seq=null", g[0].stops[1].seq === null, g[0].stops[1]);
  ok("합계에는 포함", g[0].total === 3, g[0].total);
}

console.log("\n[4] stops 미로드(노선 정류장 못 읽음)여도 그룹은 만들어진다");
{
  const boardings = [
    { routeId: "rZ", routeName: "미로드 노선", stopId: "x1", stopName: "정류장X" },
    { routeId: "rZ", routeName: "미로드 노선", stopId: "x1", stopName: "정류장X" },
  ];
  const { mapped } = aggregateBoardingsByStop(boardings, {}, 300);
  const g = groupMappedByRoute(mapped, {});
  ok("그룹 1개·2건", g.length === 1 && g[0].total === 2, g);
  ok("routeStopCount=0(모름)", g[0].routeStopCount === 0);
  ok("seq=null 이어도 표시 가능", g[0].stops[0].seq === null);
}

console.log("\n[5] 🔴 소스 가드 — 노선 머리줄을 한 칸에 몰지 않는다");
{
  // 2026-09-03 실측 회귀: 머리줄을 `<td colSpan={4} style={{ ..., display:"flex" }}>` 로 만들었더니
  // td 가 table-cell 을 벗어나 colSpan 이 무효화되고, 머리줄이 첫 열(52px) 안으로 접혔다.
  // 노선명이 세로로 쌓이고 소계가 «탑승» 열에서 벗어난다 — 눈으로만 잡히는 종류라 소스로 잠근다.
  const HEAD_RE = /^const (stopGroupHead|pStopGroupHead) = /;
  for (const f of ["src/pages/AdminApp.js", "src/pages/PartnerApp.js"]) {
    const t = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    const head = t.split(/\r?\n/).filter(l => HEAD_RE.test(l));
    ok(f + " — 머리줄 스타일 상수 1개", head.length === 1, head);
    ok(f + " — 머리줄에 display:flex 없음", !/display:\s*"flex"/.test(head[0] || ""), head[0]);
    ok(f + " — 노선 소계(g.total)를 «탑승» 열에 표시", t.includes("{g.total}"), null);
    ok(f + " — 머리줄을 colSpan 한 칸에 몰지 않음", !/colSpan=\{4\}/.test(t), null);
  }
}

console.log(`\n결과: ✅ ${pass} / ❌ ${fail}`);
process.exit(fail === 0 ? 0 : 1);
