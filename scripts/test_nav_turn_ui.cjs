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
const { turnGlyph, rotateDragDelta } = M;

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
  eq("지하차도 옆길은 화살표 없음", turnGlyph("반포(우면산터널) 양재IC 방면으로 지하차도 옆길"), null);
  eq("고가도로 진입도 없음", turnGlyph("고가도로 진입"), null);
  eq("빈 문구", turnGlyph(""), null);
  eq("null 입력", turnGlyph(null), null);
}

console.log("\n[3] type 은 보조 신호 — 문구가 우선");
{
  eq("type 4(유턴)만 있어도 유턴", turnGlyph("", 4), "⤶");
  eq("문구가 좌회전이면 type 3 이어도 좌회전", turnGlyph("좌회전", 3), "↰");
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
  ok("모르는 안내는 null 반환 유지", /return null;\s*\/\/ 고가도로/.test(nav));
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
}

console.log(`\n${fail === 0 ? "✅" : "❌"} pass ${pass} / fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
