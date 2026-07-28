// 격리 테스트 — src/lib/navGuide.js (기사 길안내 계산).
//   node scripts/test_nav_guide.cjs
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadModule(relPath, deps = {}) {
  let src = fs.readFileSync(path.join(__dirname, "..", relPath), "utf8");
  src = src
    .replace(/^import\s+\{[^}]*\}\s+from\s+["'][^"']+["'];?$/gm, "")
    .replace(/^export\s+function\s+/gm, "function ")
    // vm 컨텍스트에서 top-level const 는 global 에 안 붙는다 → var
    .replace(/^export\s+const\s+/gm, "var ");
  const ctx = vm.createContext({ ...deps, console });
  vm.runInContext(src, ctx);
  return ctx;
}

const rp = loadModule("src/lib/routeProgress.js");
const { haversine, buildCumulativeLengths, projectToPolyline, pathUpTo, pathFrom } = rp;
const G = loadModule("src/lib/navGuide.js", { haversine, buildCumulativeLengths, projectToPolyline, pathUpTo, pathFrom });
const { stopLatLng, formatDistance, bearing, compassLabel, guideTargetIndex, computeGuide,
  kakaoMapDirectionsUrl, splitGuidePath, fitLevel, guideView } = G;

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${x !== undefined ? " — " + JSON.stringify(x) : ""}`); } };
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b), { actual: a, expected: b });

// 실제 노선 좌표대(판교~강남)
const PANGYO = { lat: 37.3948, lng: 127.1112 };
const GANGNAM = { lat: 37.4979, lng: 127.0276 };

console.log("\n[1] stopLatLng — 좌표 4형식 흡수 + 빈값 함정");
eq("number", stopLatLng({ lat: 37.5, lng: 127.0 }), { lat: 37.5, lng: 127.0 });
eq("문자열", stopLatLng({ lat: "37.5", lng: "127.0" }), { lat: 37.5, lng: 127.0 });
eq("GeoPoint", stopLatLng({ latitude: 37.5, longitude: 127.0 }), { lat: 37.5, lng: 127.0 });
eq("중첩 location", stopLatLng({ location: { latitude: 37.5, longitude: 127.0 } }), { lat: 37.5, lng: 127.0 });
eq("빈 문자열은 0 이 아니라 없음", stopLatLng({ lat: "", lng: "" }), null);
eq("null 은 0 이 아니라 없음", stopLatLng({ lat: null, lng: null }), null);
eq("(0,0) 대서양 점 배제", stopLatLng({ lat: 0, lng: 0 }), null);
eq("undefined stop", stopLatLng(undefined), null);
eq("좌표 없음", stopLatLng({ name: "정류장" }), null);

console.log("\n[2] formatDistance");
eq("120m", formatDistance(123), "120m");
eq("10m 미만도 최소 10m", formatDistance(3), "10m");
eq("1.2km", formatDistance(1234), "1.2km");
eq("12km(1만 이상은 정수)", formatDistance(12345), "12km");
eq("음수·NaN", formatDistance(-5), "–");
eq("NaN", formatDistance(NaN), "–");

console.log("\n[3] bearing / compassLabel");
{
  const north = bearing({ lat: 37.0, lng: 127.0 }, { lat: 38.0, lng: 127.0 });
  ok("정북 ≈ 0", Math.abs(north) < 1 || Math.abs(north - 360) < 1, north);
  const east = bearing({ lat: 37.0, lng: 127.0 }, { lat: 37.0, lng: 128.0 });
  ok("정동 ≈ 90", Math.abs(east - 90) < 1, east);
  eq("0 → 북", compassLabel(0), "북");
  eq("90 → 동", compassLabel(90), "동");
  eq("225 → 남서", compassLabel(225), "남서");
  eq("359 → 북(감싸기)", compassLabel(359), "북");
  eq("null 은 빈 문자열", compassLabel(null), "");
  // 판교 → 강남은 북서 방향
  eq("판교→강남 = 북서", compassLabel(bearing(PANGYO, GANGNAM)), "북서");
}

console.log("\n[4] guideTargetIndex — 안내 대상은 '아직 안 지난 첫 정류장'");
{
  const s = [{ id: "a" }, { id: "b" }, { id: "c" }];
  eq("출발 전(-1) → 0번", guideTargetIndex(s, -1), 0);
  eq("0번 도착 → 1번", guideTargetIndex(s, 0), 1);
  eq("종점 도착 → 없음", guideTargetIndex(s, 2), -1);
  eq("정류장 없음", guideTargetIndex([], -1), -1);
  eq("인덱스 결측도 출발 전 취급", guideTargetIndex(s, undefined), 0);
}

console.log("\n[5] computeGuide — 남은 거리·방향");
{
  const stops = [
    { id: "s1", name: "판교역", lat: PANGYO.lat, lng: PANGYO.lng },
    { id: "s2", name: "강남역", lat: GANGNAM.lat, lng: GANGNAM.lng },
  ];
  const g = computeGuide({ stops, currentStopIdx: 0, pos: PANGYO });
  eq("대상 = 두 번째", g.targetIdx, 1);
  eq("이름", g.stop.name, "강남역");
  // 판교역↔강남역 직선거리 ≈ 13.6km(실측). 도로 거리가 아니라 직선이라는 점이 계약.
  ok("남은 거리 ≈ 13.6km(직선)", g.remainMeters > 13000 && g.remainMeters < 14500, g.remainMeters);
  eq("방향 라벨", g.headingLabel, "북서");
  ok("종점 표시", g.isLast === true);
  ok("위치 있음", g.hasPos === true);
}

console.log("\n[6] 위치를 아직 못 잡았을 때도 안내는 나온다(거리만 미정)");
{
  const stops = [{ id: "s1", name: "판교역", lat: PANGYO.lat, lng: PANGYO.lng }];
  const g = computeGuide({ stops, currentStopIdx: -1, pos: null });
  eq("대상 있음", g.stop.name, "판교역");
  eq("거리 미정", g.remainLabel, "–");
  eq("방향 없음", g.headingLabel, "");
  ok("hasPos=false", g.hasPos === false);
}

console.log("\n[7] 좌표 없는 정류장이 안내 대상이어도 throw 하지 않는다");
{
  const stops = [{ id: "s1", name: "좌표없음" }, { id: "s2", name: "다음", lat: 37.5, lng: 127.0 }];
  const g = computeGuide({ stops, currentStopIdx: -1, pos: PANGYO });
  eq("대상은 그대로", g.stop.name, "좌표없음");
  eq("거리 미정", g.remainMeters, null);
  eq("링크 없음(엉뚱한 곳 열림 방지)", kakaoMapDirectionsUrl(stops[0]), null);
}

console.log("\n[8] 운행 종료(종점까지 지남)");
{
  const stops = [{ id: "s1", lat: 37.5, lng: 127.0 }];
  const g = computeGuide({ stops, currentStopIdx: 0, pos: PANGYO });
  eq("대상 없음", g.targetIdx, -1);
  ok("finished", g.finished === true);
  eq("빈 정류장은 finished 아님", computeGuide({ stops: [], currentStopIdx: -1 }).finished, false);
}

console.log("\n[9] 카카오맵 길찾기 링크");
{
  const url = kakaoMapDirectionsUrl({ name: "판교역", lat: PANGYO.lat, lng: PANGYO.lng });
  ok("카카오맵 to 링크", url.startsWith("https://map.kakao.com/link/to/"), url);
  ok("이름 URL 인코딩", url.includes(encodeURIComponent("판교역")), url);
  ok("좌표 포함", url.endsWith(`,${PANGYO.lat},${PANGYO.lng}`), url);
  const comma = kakaoMapDirectionsUrl({ name: "가, 나\n다", lat: 37.5, lng: 127.0 });
  ok("이름 속 쉼표·개행 제거(링크 형식 파손 방지)", !decodeURIComponent(comma.split("/to/")[1]).split(",")[0].includes(","), comma);
  eq("이름 없으면 기본값", kakaoMapDirectionsUrl({ lat: 37.5, lng: 127.0 }).includes(encodeURIComponent("정류장")), true);
}

console.log("\n[10] 결측 입력에 throw 하지 않는다");
{
  ok("인자 없음", !!computeGuide());
  ok("stops null", !!computeGuide({ stops: null, currentStopIdx: 0 }));
  ok("pos 형식 이상", computeGuide({ stops: [{ id: "a", lat: 37.5, lng: 127 }], currentStopIdx: -1, pos: { lat: "x" } }).remainMeters === null);
}

console.log("\n[11] splitGuidePath — 길안내의 핵심: '지금 가야 할 구간'만 분리");
{
  // 서→동 일직선 경로(위도 고정) 5점. 대략 각 구간 ~880m.
  const path = [0, 1, 2, 3, 4].map((i) => ({ lat: 37.4, lng: 127.0 + i * 0.01 }));
  const me = { lat: 37.4, lng: 127.005 };          // 1번째 구간 중간
  const target = { lat: 37.4, lng: 127.02 };       // 3번째 점
  const r = splitGuidePath({ path, pos: me, targetLL: target });
  ok("지나온 구간 있음", r.passed.length >= 2, r.passed);
  ok("가야 할 구간 있음", r.ahead.length >= 2, r.ahead);
  ok("그 이후 구간 있음", r.later.length >= 2, r.later);
  // ahead 는 내 위치에서 시작해 목표에서 끝난다
  ok("ahead 시작 ≈ 내 위치", Math.abs(r.ahead[0].lng - me.lng) < 0.0005, r.ahead[0]);
  ok("ahead 끝 ≈ 목표", Math.abs(r.ahead[r.ahead.length - 1].lng - target.lng) < 0.0005, r.ahead[r.ahead.length - 1]);
  ok("passed 는 목표를 넘지 않음", r.passed[r.passed.length - 1].lng <= me.lng + 0.0005);

  // 위치 없음 → 지나온 구간 없이 처음부터 목표까지가 '가야 할 길'
  const noPos = splitGuidePath({ path, pos: null, targetLL: target });
  eq("위치 없으면 지나온 구간 없음", noPos.passed.length, 0);
  ok("가야 할 구간은 여전히 있음", noPos.ahead.length >= 2);

  // 이미 지나침(도착 감지 실패) → 직선으로라도 방향 제시
  const passedTarget = splitGuidePath({ path, pos: { lat: 37.4, lng: 127.03 }, targetLL: target });
  eq("지나쳤어도 안내선 2점", passedTarget.ahead.length, 2);

  eq("경로 없음", splitGuidePath({ path: [], pos: me, targetLL: target }), { passed: [], ahead: [], later: [] });
  eq("인자 없음", splitGuidePath(), { passed: [], ahead: [], later: [] });
  eq("점 1개", splitGuidePath({ path: [{ lat: 37.4, lng: 127 }] }), { passed: [], ahead: [], later: [] });
}

console.log("\n[12] fitLevel / guideView — 내 위치와 다음 정류장이 한 화면에");
{
  ok("가까울수록 확대(작은 값)", fitLevel(200) < fitLevel(5000), [fitLevel(200), fitLevel(5000)]);
  eq("200m", fitLevel(200), 3);
  eq("1km", fitLevel(1000), 5);
  eq("아주 멀면 최대", fitLevel(999999), 9);
  eq("결측은 기본값", fitLevel(NaN), 4);
  const v = guideView({ pos: PANGYO, targetLL: GANGNAM });
  ok("중심은 두 점 사이", v.center.lat > Math.min(PANGYO.lat, GANGNAM.lat) && v.center.lat < Math.max(PANGYO.lat, GANGNAM.lat), v.center);
  eq("13.6km → level 8", v.level, 8);
  eq("목표만 있으면 목표 중심", guideView({ targetLL: GANGNAM }).center, GANGNAM);
  eq("둘 다 없으면 null", guideView({}), null);
  eq("인자 없음", guideView(), null);

  // 운행 시작 전: 다음 정류장이 코앞(450m)이어도 노선 전체가 화면에 들어와야 한다.
  // (2026-07-28 실화면 — 450m 기준으로 확대돼 나머지 노선이 화면 밖으로 나갔다)
  const nearTarget = { lat: 37.3905, lng: 126.9948 };          // 덕장로 사거리 근처
  const me = { lat: 37.3880, lng: 126.9990 };                   // 450m 쯤 떨어진 곳
  const wholeRoute = [nearTarget, { lat: 37.44, lng: 127.02 }, { lat: 37.4841, lng: 127.0427 }];
  const near = guideView({ pos: me, targetLL: nearTarget });
  const whole = guideView({ pos: me, targetLL: nearTarget, path: wholeRoute });
  ok("경로를 주면 더 넓게 잡힌다", whole.level > near.level, { near: near.level, whole: whole.level });
  ok("중심이 노선 쪽으로 이동", whole.center.lat > near.center.lat, { near: near.center, whole: whole.center });
  eq("경로가 빈 배열이면 기존과 동일", guideView({ pos: me, targetLL: nearTarget, path: [] }).level, near.level);
  ok("경로에 잘못된 점이 섞여도 throw 없음",
    !!guideView({ pos: me, targetLL: nearTarget, path: [null, { lat: "x", lng: 1 }, wholeRoute[2]] }));
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
