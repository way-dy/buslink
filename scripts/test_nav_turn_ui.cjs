// 격리 테스트 — 길안내 배너 화살표(turnGlyph) · 회전 판 드래그 보정(rotateDragDelta).
//   node scripts/test_nav_turn_ui.cjs
//
// 2026-08-05 way 현장 지적 2건:
//   ① "지시하고 방향하고 안맞음" — 배너 화살표가 `↱` 하드코딩이라 좌회전에도 우회전 표시
//   ② "지도 움직일 때 손가락 방향대로 안 움직임" — 판이 회전해 있으면 드래그가 어긋난다
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadModule(relPath) {
  let src = fs.readFileSync(path.join(__dirname, "..", relPath), "utf8");
  src = src
    .replace(/^import\s+\{[^}]*\}\s+from\s+["'][^"']+["'];?$/gm, "")
    .replace(/^export\s+function\s+/gm, "function ")
    .replace(/^export\s+const\s+/gm, "var ");
  const ctx = vm.createContext({ console, Math, Number, String, isFinite, JSON });
  vm.runInContext(src, ctx);
  return ctx;
}
const M = loadModule("src/lib/navGuide.js");
const { turnGlyph, turnIconKind, rotateDragDelta, trafficLabel, speedKmh } = M;

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${x !== undefined ? ` — ${JSON.stringify(x)}` : ""}`); } };
const eq = (n, a, b) => ok(n, a === b, { actual: a, expected: b });

console.log("\n[1] 🔴 신고 재현 — 좌회전에 우회전 화살표가 뜨면 안 된다");
{
  // prod 실데이터에서 그대로 가져온 문구들(과천대로·과천라인)
  eq("백운호수 성남 서판교 방면으로 좌회전", turnGlyph("백운호수 성남 서판교 방면으로 좌회전"), "↰");
  eq("북의왕IC 방면으로 우회전", turnGlyph("북의왕IC 방면으로 우회전"), "↱");
  ok("좌회전과 우회전 글리프가 다르다", turnGlyph("좌회전") !== turnGlyph("우회전"));
  ok("옛 동작(항상 ↱)이 아니다", turnGlyph("좌회전") !== "↱");
}

console.log("\n[2] prod 에서 실제로 관측된 안내 문구 전수");
{
  const cases = [
    ["선바위역 서울 방면으로 유턴", "⤶"],
    ["남부순환로 방면으로 유턴", "⤶"],
    ["양재역 방면으로 좌회전", "↰"],
    ["양재대로 방면으로 우회전", "↱"],
    ["국립과천과학관 서울 방면으로 오른쪽 방향", "↗"],
    ["12시 방향", "↑"],
    ["목적지", "⚑"],
  ];
  cases.forEach(([t, e]) => eq(t, turnGlyph(t), e));
  // 방향이 안 정해지는 안내 = 화살표 없음(틀린 방향보다 없는 게 낫다)
  eq("지하차도 옆길은 전용 픽토그램", turnGlyph("반포(우면산터널) 양재IC 방면으로 지하차도 옆길"), "⤓");
  eq("고가도로 진입도 전용 픽토그램", turnGlyph("고가도로 진입"), "⤒");
  eq("빈 문구", turnGlyph(""), null);
  eq("null 입력", turnGlyph(null), null);
}

console.log("\n[3] 숫자 type 은 아예 안 쓴다 — 문구만 본다");
{
  // 🔴 2026-08-06 실측: 카카오 유턴은 type **3** 이다. 예전 코드엔 type===4 가 유턴으로
  //    박혀 있었다(문구가 항상 "유턴"이라 화면에는 안 드러났을 뿐 틀린 값). 짐작한 코드표는
  //    이렇게 조용히 틀리므로 판정에서 숫자를 뺐다.
  eq("type 을 넘겨도 무시하고 문구로 판정", turnGlyph("좌회전", 3), "↰");
  eq("문구가 없으면 화살표 없음(숫자로 지어내지 않는다)", turnGlyph("", 4), null);
}

console.log("\n[3-b] 실측 type 표에서 나온 안내 문구들(2026-08-06)");
{
  eq("지하차도 진입", turnGlyph("북수원IC 수원 방면으로 지하차도 진입"), "⤓");
  eq("지하차도 옆길", turnGlyph("지하차도 옆길"), "⤓");
  eq("고가도로 진입", turnGlyph("신갈동 시청 방면으로 고가도로 진입"), "⤒");
  eq("고가도로 옆길", turnGlyph("과천 안양 방면으로 고가도로 옆길"), "⤒");
  eq("톨게이트 진입", turnGlyph("톨게이트 진입"), "⌸");
  eq("왼쪽 직진(type 82)", turnGlyph("의왕 방면으로 왼쪽 직진"), "↖");
  eq("오른쪽 직진(type 83)", turnGlyph("과천 안양 방면으로 오른쪽 직진"), "↗");
  eq("고속도로 출구는 좌우 문구를 따른다", turnGlyph("오창 방면으로 오른쪽에 고속도로 출구"), "↗");
}

console.log("\n[3-e] 🔴 지명에 도로 이름이 섞인 문구 — 동작 부분만 본다(2026-08-06 prod 실측 결함)");
{
  const { guidanceAction } = M;
  // prod 실호출에서 실제로 나온 문구. 동작은 '왼쪽 출구'인데 지명이 '매헌지하차도' 다.
  const g = "매헌지하차도 수서IC 방면으로 왼쪽에 도시고속도로 출구";
  eq("동작만 떼어낸다", guidanceAction(g), "왼쪽에 도시고속도로 출구");
  eq("🔴 지하차도로 오판하지 않는다(글리프)", turnGlyph(g), "↖");
  eq("🔴 지하차도로 오판하지 않는다(픽토그램)", turnIconKind(g).kind, "slight-left");
  // 정상 케이스는 그대로여야 한다
  eq("방면으로 뒤가 진짜 지하차도면 그대로", turnIconKind("북수원IC 수원 방면으로 지하차도 진입").kind, "underpass-enter");
  eq("방면으로 가 없는 짧은 문구", guidanceAction("지하차도 진입"), "지하차도 진입");
  eq("빈 문구", guidanceAction(""), "");
  eq("여러 번 나오면 마지막 기준", guidanceAction("가 방면으로 나 방면으로 우회전"), "우회전");
  // 🔴 배너 글리프와 큰 그림이 **같은 전처리**를 타야 한다
  ["매헌지하차도 수서IC 방면으로 왼쪽에 도시고속도로 출구", "판교고가도로 방면으로 우회전"]
    .forEach((s) => ok(`글리프↔픽토그램 일치: ${s.slice(0, 18)}…`,
      (turnGlyph(s) === "↖" && turnIconKind(s).kind === "slight-left") ||
      (turnGlyph(s) === "↱" && turnIconKind(s).kind === "right")));
}

console.log("\n[3-d] 픽토그램 종류 — 진입/옆길 구분(2026-08-06 way \"아이콘 모양과 화살표 조합\")");
{
  const k = (g) => { const r = turnIconKind(g); return r ? r.kind : null; };
  const m = (g) => { const r = turnIconKind(g); return r ? r.motion : null; };
  // 🔴 이 둘은 운전자가 할 행동이 정반대다 — 같은 그림으로 뭉뚱그리면 안 된다
  eq("지하차도 진입", k("북수원IC 수원 방면으로 지하차도 진입"), "underpass-enter");
  eq("지하차도 옆길", k("반포(우면산터널) 양재IC 방면으로 지하차도 옆길"), "underpass-side");
  ok("지하차도 진입과 옆길이 다른 그림", k("지하차도 진입") !== k("지하차도 옆길"));
  eq("고가도로 진입", k("신갈동 시청 방면으로 고가도로 진입"), "overpass-enter");
  eq("고가도로 옆길", k("과천 안양 방면으로 고가도로 옆길"), "overpass-side");
  ok("고가도로 진입과 옆길이 다른 그림", k("고가도로 진입") !== k("고가도로 옆길"));
  // 🔴 지하/고가는 전부 전진(up) — 좌우로 흔들면 옆길이 우회전으로 읽힌다.
  //    (카카오가 옆길 좌우를 안 주므로 애니메이션으로 방향을 지어내면 안 된다)
  ["지하차도 진입", "지하차도 옆길", "고가도로 진입", "고가도로 옆길"].forEach((g) =>
    eq(`${g} 은 좌우를 주장하지 않는다`, m(g), "up"));
  // 회전
  eq("좌회전", k("백운호수 성남 서판교 방면으로 좌회전"), "left");
  eq("우회전", k("북의왕IC 방면으로 우회전"), "right");
  eq("좌회전은 왼쪽으로 움직인다", m("좌회전"), "left");
  eq("우회전은 오른쪽으로 움직인다", m("우회전"), "right");
  eq("유턴", k("선바위역 서울 방면으로 유턴"), "uturn");
  eq("왼쪽 직진", k("의왕 방면으로 왼쪽 직진"), "slight-left");
  eq("오른쪽 직진", k("과천 안양 방면으로 오른쪽 직진"), "slight-right");
  eq("톨게이트", k("톨게이트 진입"), "toll");
  eq("목적지", k("목적지"), "goal");
  // 🔴 turnGlyph 와 같은 원칙 — 모르면 안 그린다
  eq("빈 문구", turnIconKind(""), null);
  eq("null 입력", turnIconKind(null), null);
  eq("방향을 못 정하는 안내", turnIconKind("정보 없음"), null);
  // 🔴 지하/고가 판정이 "방면" 같은 회전 단어보다 앞서야 한다(문구에 둘 다 섞여 있다)
  eq("'방면으로 지하차도 진입' 이 좌우 회전으로 새지 않는다",
    k("서울 오른쪽 방면으로 지하차도 진입"), "underpass-enter");
  // 배너 글리프와 종류가 같은 문구에서 나온다 = 둘이 어긋날 수 없다
  ok("글리프가 있는 안내는 종류도 있다",
    ["좌회전", "우회전", "유턴", "지하차도 진입", "고가도로 옆길", "톨게이트 진입", "목적지"]
      .every((g) => !!turnGlyph(g) === !!turnIconKind(g)));
}

console.log("\n[3-c] 속도·교통 표시");
{
  eq("m/s → km/h", speedKmh(16.6667), 60);
  eq("0 은 0", speedKmh(0), 0);
  eq("null 은 null(정차·미지원)", speedKmh(null), null);
  eq("음수는 null", speedKmh(-1), null);
  eq("문자열 숫자 허용", speedKmh("10"), 36);
  eq("원활", trafficLabel(1).text, "원활");
  eq("서행", trafficLabel(2).text, "서행");
  eq("지체", trafficLabel(3).text, "지체");
  eq("정체", trafficLabel(4).text, "정체");
  eq("0(정보없음)은 표시 안 함", trafficLabel(0), null);
  eq("모르는 값도 표시 안 함", trafficLabel(99), null);
  eq("undefined 도 null", trafficLabel(undefined), null);
}

console.log("\n[4] 드래그 보정 — 회전 0도면 그대로");
{
  const r = rotateDragDelta({ dx: 10, dy: -4, rotDeg: 0 });
  eq("dx 보존", Math.round(r.dx), 10);
  eq("dy 보존", Math.round(r.dy), -4);
  const r360 = rotateDragDelta({ dx: 7, dy: 3, rotDeg: 360 });
  ok("360도도 그대로", Math.round(r360.dx) === 7 && Math.round(r360.dy) === 3, r360);
}

console.log("\n[5] 드래그 보정 — 회전 시 판 좌표계로 되돌린다");
{
  // CSS rotate 는 화면 좌표(x 오른쪽·y 아래)에서 시계방향이 +.
  // 판 좌표 p 는 화면에서 s = R(rot)·p 로 보이므로, 화면 델타를 판으로 되돌리려면 R(-rot).
  //   rot=-90 → 판의 +y 축이 화면 오른쪽으로 눕는다 ⇒ 손가락 화면 +x = 판 +y
  const r = rotateDragDelta({ dx: 10, dy: 0, rotDeg: -90 });
  ok("-90도: 화면 +x → 판 +y", Math.round(r.dx) === 0 && Math.round(r.dy) === 10, r);
  //   rot=+90 → 판의 +y 축이 화면 왼쪽을 향한다 ⇒ 손가락 화면 +x = 판 -y
  const r2 = rotateDragDelta({ dx: 10, dy: 0, rotDeg: 90 });
  ok("+90도: 화면 +x → 판 -y", Math.round(r2.dx) === 0 && Math.round(r2.dy) === -10, r2);
  const r3 = rotateDragDelta({ dx: 0, dy: 10, rotDeg: 180 });
  ok("180도: 화면 +y → 판 -y", Math.round(r3.dx) === 0 && Math.round(r3.dy) === -10, r3);
}

console.log("\n[6] 드래그 보정 — 길이 보존·역변환");
{
  for (const deg of [0, 17, 45, -33, 90, 180, -170, 359]) {
    const v = { dx: 12, dy: -5 };
    const r = rotateDragDelta({ ...v, rotDeg: deg });
    const len0 = Math.hypot(v.dx, v.dy), len1 = Math.hypot(r.dx, r.dy);
    ok(`${deg}도 길이 보존`, Math.abs(len0 - len1) < 1e-9, { len0, len1 });
    // 반대 각으로 되돌리면 원래 벡터
    const back = rotateDragDelta({ dx: r.dx, dy: r.dy, rotDeg: -deg });
    ok(`${deg}도 역변환 복원`, Math.abs(back.dx - v.dx) < 1e-9 && Math.abs(back.dy - v.dy) < 1e-9, back);
  }
}

console.log("\n[7] 나쁜 입력");
{
  const r = rotateDragDelta({ dx: NaN, dy: 3, rotDeg: 30 });
  ok("NaN 은 0 으로", r.dx === 0 && r.dy === 0, r);
  const r2 = rotateDragDelta({});
  ok("빈 인자도 throw 없음", r2.dx === 0 && r2.dy === 0, r2);
}

console.log("\n[8] 회귀 가드 — 소스 단언");
{
  const nav = fs.readFileSync(path.join(__dirname, "..", "src/lib/navGuide.js"), "utf8");
  ok("방향을 못 정하는 안내는 null 반환 유지", /return null;\s*\/\/ 방향이 안 정해지는/.test(nav));
  // 🔴 Number(null)===0 함정 — 측정 안 된 속도를 "0 km/h" 로 지어내면 정차와 구분이 안 된다
  ok("속도 변환이 null·빈문자열을 먼저 걸러낸다",
    /metersPerSec === null \|\| metersPerSec === undefined \|\| metersPerSec === ""/.test(nav));
  const drv = fs.readFileSync(path.join(__dirname, "..", "src/pages/DriverApp.js"), "utf8");
  ok("배너가 ↱ 하드코딩으로 되돌아가지 않았다", !/fontSize: 26, lineHeight: 1 \}\}>↱</.test(drv));
  ok("배너가 turnGlyph 를 쓴다", /turnGlyph\(/.test(drv));
  ok("회전 중 드래그 보정이 배선돼 있다", /rotateDragDelta\(/.test(drv));

  // 2026-08-06 way "차량 위치가 뚝뚝 끊어져서 이동" — 두 가지가 같이 필요하다.
  ok("내 폰 위치를 1순위로 쓴다(서버 왕복 5초 스로틀 회피)", /const rawPos = myPos \|\| livePos;/.test(drv)
    && !/const pos = livePos \|\| myPos;/.test(drv));
  ok("기사 화면에도 rAF 보간을 적용한다", /useAnimatedPositions\(posList\)/.test(drv));
  ok("마커는 보간값으로 그린다", /position=\{drawPos\}/.test(drv));
  // 🔴 지도 재센터 deps 가 원본이면 지도만 5초마다 튄다(마커는 부드러운데 화면이 끊긴다)
  ok("지도 재센터도 보간값을 따라간다", /\[follow, drawPos && drawPos\.lat, drawPos && drawPos\.lng/.test(drv));
  // 판정은 원본이어야 "몇 m 앞 회전"이 늦지 않는다
  ok("회전 안내 판정은 원본 좌표로", /nextNaviGuide\(\{ guides: navi\.guides, path, pos \}\)/.test(drv));

  // 2026-08-06 속도 표시 — 처음엔 지도 위 왼쪽 아래 칩이었으나 시점 버튼줄·카카오 로고·
  // 아래 운행/종료 메뉴와 한 띠에서 겹쳤다(way "잘 보이도록 하되 어떤 메뉴도 가리지 않도록").
  // 🔴 새 불변식 = 속도는 **지도 오버레이가 아니라 지도 밖 고정 줄**에 있다.
  ok("속도 칩이 배선돼 있다", /const myKmh = speedKmh\(mySpeed\)/.test(drv) && /roadTraffic/.test(drv));
  ok("속도가 지도 아래 고정 줄에 있다", /지도 아래 한 줄 — 속도[\s\S]{0,900}\{myKmh !== null && \(/.test(drv));
  ok("속도를 지도 위 떠 있는 칩으로 되돌리지 않았다", !/position: "absolute"[^}]*bottom: 40/.test(drv));
  ok("모르는 속도를 0 으로 지어내지 않는다", /myKmh !== null/.test(drv));

  // 2026-08-06 대형 회전 픽토그램 — way "지도 위에 엄청 크게 잘 보이게 · 애니메이션으로"
  ok("대형 픽토그램이 배선돼 있다", /turnIconKind\(turn\.guide\.guidance\)/.test(drv) && /<NavTurnIcon/.test(drv));
  // 🔴 배너와 같은 문구에서 종류를 뽑아야 그림과 글자가 어긋나지 않는다(2026-08-05 가드의 확장)
  ok("픽토그램 종류를 문구에서 뽑는다(리터럴 하드코딩 아님)",
    /const turnIcon = turn \? turnIconKind\(turn\.guide\.guidance\) : null/.test(drv));
  ok("가까워지면 진하게 — 거리 필드는 aheadMeters", /turn\.aheadMeters <= NAV_TURN_NEAR_M/.test(drv));
  // 🔴 키프레임이 transform 을 애니메이션하므로 그 요소에 인라인 transform 을 쓰면 조용히 사라진다
  ok("대형 픽토그램 래퍼에 인라인 transform 없음",
    !/animation: `navturn-[\s\S]{0,200}transform:/.test(drv));
  ok("애니메이션 키프레임 5종이 tokens.css 에 있다", (() => {
    const css = fs.readFileSync(path.join(__dirname, "..", "src", "styles", "tokens.css"), "utf8");
    return ["left", "right", "up", "down", "spin"].every((m) => css.includes(`@keyframes navturn-${m}`));
  })());
  ok("픽토그램은 SVG 로 그린다(큰 글리프는 폰트에 없으면 두부)", (() => {
    const ico = fs.readFileSync(path.join(__dirname, "..", "src", "components", "NavTurnIcon.js"), "utf8");
    return /<svg/.test(ico) && /glyph/.test(ico); // 모르는 종류는 글리프 폴백
  })());
  const fn = fs.readFileSync(path.join(__dirname, "..", "functions", "index.js"), "utf8");
  ok("CF 가 path 와 같은 길이로 speeds/states 를 채운다", /speeds\.push\(/.test(fn) && /states\.push\(/.test(fn));
  ok("CF 응답에 speeds/states 가 실려 나간다", /speeds: cand\.speeds \|\| \[\]/.test(fn));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} pass ${pass} / fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
