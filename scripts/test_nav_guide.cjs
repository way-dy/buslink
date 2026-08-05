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
  kakaoMapDirectionsUrl, splitGuidePath, fitLevel, guideView, nextNaviGuide, OFF_ROUTE_M, travelHeading } = G;

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

  eq("경로 없음", splitGuidePath({ path: [], pos: me, targetLL: target }), { passed: [], ahead: [], later: [], onRoute: false });
  eq("인자 없음", splitGuidePath(), { passed: [], ahead: [], later: [], onRoute: false });
  eq("점 1개", splitGuidePath({ path: [{ lat: 37.4, lng: 127 }] }), { passed: [], ahead: [], later: [], onRoute: false });
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

console.log("\n[13] nextNaviGuide — 카카오 회전 안내 중 '앞에 있는' 것만");
{
  const path = [0, 1, 2, 3, 4].map((i) => ({ lat: 37.4, lng: 127.0 + i * 0.01 }));
  const guides = [
    { lat: 37.4, lng: 127.005, guidance: "우회전", type: 2 },   // 내 뒤(지나침)
    { lat: 37.4, lng: 127.025, guidance: "좌회전", type: 1 },   // 앞
    { lat: 37.4, lng: 127.035, guidance: "목적지", type: 101 }, // 더 앞
  ];
  const me = { lat: 37.4, lng: 127.015 };
  const r = nextNaviGuide({ guides, path, pos: me });
  eq("가장 가까운 앞쪽 안내 선택", r.guide.guidance, "좌회전");
  ok("거리는 양수", r.aheadMeters > 0, r.aheadMeters);
  ok("라벨은 '거리 앞 문구'", /^\d+m 앞 좌회전$|^[\d.]+km 앞 좌회전$/.test(r.label), r.label);

  // 모든 안내를 지나쳤으면 null
  eq("전부 지나침", nextNaviGuide({ guides: [guides[0]], path, pos: me }), null);
  eq("안내 없음", nextNaviGuide({ guides: [], path, pos: me }), null);
  eq("경로 없음", nextNaviGuide({ guides, path: [], pos: me }), null);
  eq("위치 없음", nextNaviGuide({ guides, path, pos: null }), null);
  eq("인자 없음", nextNaviGuide(), null);
  ok("좌표 깨진 안내는 건너뜀", nextNaviGuide({
    guides: [{ lat: NaN, lng: 1, guidance: "깨짐" }, guides[1]], path, pos: me,
  }).guide.guidance === "좌회전");
  ok("문구 없으면 거리만", /^\d+m$|^[\d.]+km$/.test(
    nextNaviGuide({ guides: [{ lat: 37.4, lng: 127.025 }], path, pos: me }).label));
}

console.log("\n[14] 🔴 경로에서 멀리 떨어져 있을 때 — 엉뚱한 지점에 투영되면 안 된다");
{
  // 2026-07-29 way 현장 확인: "완전히 멀리 떨어져 있을 때 경로가 안 맞게 나온다
  // (이전 정류장에서의 안내 같다)". projectToPolyline 은 거리 제한이 없어 아무리 멀어도
  // 경로상 최근접점으로 투영된다 → 노선 중간에 찍히고 거기부터 안내가 계산됐다.
  const path = [0, 1, 2, 3, 4].map((i) => ({ lat: 37.4, lng: 127.0 + i * 0.01 }));
  const target = { lat: 37.4, lng: 127.03 };          // 4번째 점
  const prev = { lat: 37.4, lng: 127.02 };            // 3번째 점(직전 정류장)
  const farAway = { lat: 37.55, lng: 127.02 };        // 경로에서 북쪽으로 ~16km

  const r = splitGuidePath({ path, pos: farAway, targetLL: target, prevLL: prev });
  ok("경로 밖으로 판정", r.onRoute === false, r.onRoute);
  ok("가야 할 구간이 있다", r.ahead.length >= 2, r.ahead);
  // 멀리 있을 땐 '직전 정류장 → 다음 정류장' 이 지금 가야 할 구간이어야 한다
  ok("ahead 시작 ≈ 직전 정류장", Math.abs(r.ahead[0].lng - prev.lng) < 0.0015, r.ahead[0]);
  ok("ahead 끝 ≈ 다음 정류장", Math.abs(r.ahead[r.ahead.length - 1].lng - target.lng) < 0.0015, r.ahead[r.ahead.length - 1]);

  // 가까이 있으면 종전대로 내 위치부터
  const near = { lat: 37.4001, lng: 127.025 };
  const rn = splitGuidePath({ path, pos: near, targetLL: target, prevLL: prev });
  ok("경로 위로 판정", rn.onRoute === true);
  ok("ahead 시작 ≈ 내 위치", Math.abs(rn.ahead[0].lng - near.lng) < 0.002, rn.ahead[0]);

  // 회전 안내는 경로 밖이면 아예 주지 않는다(엉뚱한 안내보다 없는 게 낫다)
  const guides = [{ lat: 37.4, lng: 127.035, guidance: "우회전" }];
  eq("경로 밖 → 회전 안내 없음", nextNaviGuide({ guides, path, pos: farAway }), null);
  ok("경로 위 → 회전 안내 있음", !!nextNaviGuide({ guides, path, pos: near }));
}

console.log("\n[15] travelHeading — 차량이 향한 방향(지도 회전을 못 하니 마커로 알린다)");
{
  const a = { lat: 37.40, lng: 127.00 };
  const east = { lat: 37.40, lng: 127.01 };
  const north = { lat: 37.41, lng: 127.00 };
  ok("동쪽 이동 ≈ 90", Math.abs(travelHeading({ prev: a, cur: east }) - 90) < 2, travelHeading({ prev: a, cur: east }));
  ok("북쪽 이동 ≈ 0", Math.abs(travelHeading({ prev: a, cur: north })) < 2, travelHeading({ prev: a, cur: north }));
  // 거의 안 움직였으면 이동 벡터를 믿지 않는다(정차 중 방향이 홱홱 돈다)
  const tiny = { lat: 37.400001, lng: 127.000001 };
  eq("미세 이동은 gpsHeading 사용", travelHeading({ prev: a, cur: tiny, gpsHeading: 270 }), 270);
  eq("미세 이동 + heading 없음 → 직전값 유지", travelHeading({ prev: a, cur: tiny, fallback: 123 }), 123);
  eq("아무것도 없으면 null", travelHeading({}), null);
  eq("인자 없음", travelHeading(), null);
  eq("heading 이 음수(무효)면 폴백", travelHeading({ gpsHeading: -1, fallback: 45 }), 45);
  ok("이동 벡터가 gpsHeading 보다 우선", Math.abs(travelHeading({ prev: a, cur: east, gpsHeading: 270 }) - 90) < 2);
}

// ── 지도 시점: 축척·전방 오프셋 (2026-07-31) ──────────────────────
{
  console.log("\n[navCenter · 진행 방향 앞쪽으로 시점 밀기]");
  const { metersPerPixel, offsetLatLng, navCenter } = G;
  eq("level 3 = 1m/px", metersPerPixel(3), 1);
  eq("level 4 = 2m/px", metersPerPixel(4), 2);
  eq("level 5 = 4m/px", metersPerPixel(5), 4);
  eq("level 미지정은 4 기준", metersPerPixel(), 2);

  const p = { lat: 37.4, lng: 127.0 };
  const north = offsetLatLng(p, 0, 1000);
  ok("북쪽 1km → 위도 증가", north.lat > p.lat && Math.abs(north.lng - p.lng) < 1e-9, north);
  ok("북쪽 1km ≈ 0.009도", Math.abs(north.lat - p.lat - 0.00898) < 0.0005, north.lat - p.lat);
  const east = offsetLatLng(p, 90, 1000);
  ok("동쪽 1km → 경도만 증가", east.lng > p.lng && Math.abs(east.lat - p.lat) < 1e-9, east);
  ok("동쪽 1km 실거리 ≈ 1000m", Math.abs(haversine(p, east) - 1000) < 5, haversine(p, east));
  eq("이동 0m 는 그대로", offsetLatLng(p, 45, 0), { lat: 37.4, lng: 127.0 });
  eq("좌표 없으면 null", offsetLatLng(null, 0, 100), null);

  // 진행 방향을 모르면 밀지 않는다 — 엉뚱한 쪽으로 밀면 내 차가 화면 밖으로 나간다.
  eq("heading 없으면 내 위치 그대로", navCenter({ pos: p, level: 3, heightPx: 400 }), { lat: 37.4, lng: 127.0 });
  eq("pos 없으면 null", navCenter({ heading: 0, level: 3 }), null);
  const c = navCenter({ pos: p, heading: 0, level: 3, heightPx: 400, aheadRatio: 0.25 });
  ok("북진 시 중심이 앞(북)으로", c.lat > p.lat, c);
  ok("민 거리 = 1m/px × 400px × 0.25 = 100m", Math.abs(haversine(p, c) - 100) < 3, haversine(p, c));
  const c2 = navCenter({ pos: p, heading: 0, level: 5, heightPx: 400, aheadRatio: 0.25 });
  ok("축척이 넓어지면 더 멀리 민다", haversine(p, c2) > haversine(p, c) * 3.5, [haversine(p, c), haversine(p, c2)]);
  const c3 = navCenter({ pos: p, heading: 180, level: 3, heightPx: 400 });
  ok("남진 시 중심이 남쪽으로", c3.lat < p.lat, c3);
  ok("aheadRatio 0 이면 정중앙", haversine(p, navCenter({ pos: p, heading: 0, level: 3, heightPx: 400, aheadRatio: 0 })) < 0.5);
}

// ── 회귀 가드: 소스에 실제로 남아 있는지 코드로 단언 ──────────────
{
  console.log("\n[회귀 가드 — 소스 검사]");
  const drv = fs.readFileSync(path.join(__dirname, "..", "src", "pages", "DriverApp.js"), "utf8");
  ok("회전 판이 대각선 크기로 커진다(모서리 빔 방지)", /Math\.hypot\(clipBox\.w,\s*clipBox\.h\)/.test(drv));
  ok("카카오 로고·축척을 회전 밖으로 옮긴다(약관 표시 유지)", /liftCredits/.test(drv) && /map\.kakao\.com/.test(drv));
  ok("정류장 번호는 반대로 돌려 세운다", /counterRot/.test(drv));
  // dragstart 는 touchedMap() 을 부르고 그 안에서 setFollow(false) 한다(2026-08-05 자동 복귀 추가).
  // 🔴 리터럴이 아니라 **관계**를 검사한다 — "끌면 추적이 풀리고, 잠시 뒤 스스로 돌아온다".
  ok("기사가 지도를 끌면 자동 추적 해제", /"dragstart"[\s\S]{0,80}touchedMap\(\)/.test(drv)
    && /const touchedMap[\s\S]{0,200}setFollow\(false\)/.test(drv));
  ok("손 뗀 뒤 자동으로 추적 복귀", /FOLLOW_RESUME_MS/.test(drv) && /setTimeout\([\s\S]{0,60}setFollow\(true\)/.test(drv));
  ok("정류장 사진은 길안내에서 제거됨", !/target\.photo/.test(drv));
  ok("기본 확대는 크게(level 3)", /NAV_ZOOM_DEFAULT\s*=\s*3/.test(drv));

  const fn = fs.readFileSync(path.join(__dirname, "..", "functions", "index.js"), "utf8");
  ok("그린 경로 보정 임계 300m", /DRAWN_MATCH_THRESHOLD_M\s*=\s*300/.test(fn));
  ok("보정점 상한이 정해져 있다(경유지 상한 방어)", /DRAWN_MATCH_MAX_POINTS\s*=\s*\d+/.test(fn));
  ok("2차 호출로 그린 경로에 맞춘다", /worstDeviationPoints\(/.test(fn) && /matchedToDrawn/.test(fn));
  // ⚠ 2026-08-05 우회·유턴 근절로 채택 판정이 바뀌었다(`drawnMismatchRatio` 단방향 비교
  //   → `naviRouteScore` 양방향 점수 + 단계별 후보 비교). 아래 3개는 그때 갱신되지 않아
  //   **stale 상태로 빨간불이던 가드**다(2026-08-05 재점검에서 발견) — 리터럴이 아니라
  //   지금의 **관계**를 검사하도록 고쳤다. [[guard-must-check-the-relation-not-the-literal-value]]
  ok("보정 실패해도 직전 후보 유지(안내가 사라지지 않는다)",
    /let bestScore/.test(fn) && /cand = /.test(fn));
  // 🔴 실측에서 보정이 오히려 이탈을 키운 노선이 있었다([압구정] 하교 42%→52%) →
  //    무조건 채택 금지. 이 게이트를 빼면 그 회귀가 그대로 돌아온다.
  ok("나빠지면 보정을 기각한다(점수가 나아질 때만 채택)",
    /naviRouteScore\(/.test(fn) && /sc < bestScore/.test(fn));
  ok("거리 부풀림(U턴)도 기각 조건", /newLen <= drawnLen \* DRAWN_MATCH_MAX_LEN_RATIO/.test(fn));
  // 🔴 경유지를 뺄 때 정류장을 통째로 지나치는 경로가 채택되면 안 된다(2026-08-05 가드).
  ok("경유지 제거·유턴 회피는 정류장 커버 검사를 통과해야 채택", /allStopsCovered\(pts,/.test(fn));
  ok("긴 우회 구간엔 점을 여러 개", /DRAWN_MATCH_KM_PER_POINT/.test(fn) && /DRAWN_MATCH_MAX_PER_RUN/.test(fn));
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
