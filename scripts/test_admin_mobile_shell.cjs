// 관리자 콘솔 모바일 레이아웃 확인 (2026-08-26 way "왼쪽 메뉴가 가리지 않게 · 세로글씨 안 나오게").
//   node scripts/test_admin_mobile_shell.cjs [--shot]
//
// 관리자 콘솔은 로그인이 필요해 화면 전체를 헤드리스로 못 띄운다(2026-08-11 사이드바 건과 동일).
// 그래서 **셸 구조와 지도 탑바만** 실제로 렌더해서 픽셀로 잰다.
//
// 🔴 스타일은 `pages/AdminApp.js` 의 S·MS 객체에서 **그대로 뽑아** 쓴다(다시 쓰지 않는다).
//    다시 쓰면 소스가 바뀌어도 이 검사는 영원히 통과한다.
// 🔴 옛 동작도 **같은 잣대로 재현**해 결함이 검출되는지 확인한다(양성 대조) —
//    그게 없으면 "통과"가 무엇을 증명하는지 알 수 없다([[verification-harness-passes-on-no-signal]]).
const fs = require("fs");
const path = require("path");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ROOT = path.join(__dirname, "..");
const SHOT_DIR = process.env.SHOT_DIR || require("os").tmpdir();

const adminSrc = fs.readFileSync(path.join(ROOT, "src/pages/AdminApp.js"), "utf8");
const tokensCss = fs.readFileSync(path.join(ROOT, "src/styles/tokens.css"), "utf8");

let pass = 0, fail = 0;
const ok = (cond, label, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
};

// ── ① 소스에서 스타일 추출 ──────────────────────────────────────────────────
// 🔴 최상위 선언 안에서만 찾는다 — 파일에 같은 이름의 지역 스타일이 또 있다(`wrap` 이 그렇다).
function sliceObj(decl) {
  const start = adminSrc.indexOf(decl);
  if (start < 0) { console.error(`🔴 ${decl.trim()} 를 못 찾음`); process.exit(1); }
  return adminSrc.slice(start, adminSrc.indexOf("\n};", start));
}
const S_SRC = sliceObj("\nconst S = {");
const MS_SRC = sliceObj("\nconst MS = {");

function pickFrom(src, key, whose) {
  const re = new RegExp(`^\\s{2}${key}:(\\{.*\\}),\\s*$`, "m");
  const m = src.match(re);
  if (!m) { console.error(`🔴 ${whose}.${key} 를 소스에서 못 찾음 — 스타일 구조가 바뀌었다.`); process.exit(1); }
  return Function(`"use strict"; return (${m[1]});`)();
}
const S = {};
for (const k of ["wrap", "sidebar", "sidebarDrawer", "navBackdrop", "content", "nav", "navItem"]) S[k] = pickFrom(S_SRC, k, "S");
const MS = {};
for (const k of ["topbar", "topbarMobile", "leftRail", "railSheet"]) MS[k] = pickFrom(MS_SRC, k, "MS");

const UNITLESS = new Set(["flex", "flexShrink", "flexGrow", "fontWeight", "opacity", "zIndex", "lineHeight", "order"]);
const toCss = (obj) => Object.entries(obj).map(([k, v]) => {
  const prop = k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
  const val = typeof v === "number" && !UNITLESS.has(k) ? `${v}px` : String(v);
  return `${prop}:${val}`;
}).join(";");

const tabsM = adminSrc.match(/^const TABS = (\[[^\]]*\]);/m);
if (!tabsM) { console.error("🔴 TABS 를 못 찾음"); process.exit(1); }
const TABS = Function(`"use strict"; return (${tabsM[1]});`)();

// 지도 탑바에 실제로 들어가는 한글 라벨들(소스의 문구 그대로 — 짧은 것만 넣으면 안 눌린다).
const TOPBAR_LABELS = ["동영관광 · dy001", "실시간 관제", "🗺 지도", "📊 노선도", "2026-08-26", "거래처", "전체", "실시간 GPS 수신", "새로고침"];

const VW = 360, VH = 740;   // 흔한 안드로이드 세로 화면

function page(mobile, legacy) {
  // legacy=true 면 이번 수정 **전** 구조를 같은 잣대로 재현한다(양성 대조).
  const contentStyle = legacy
    ? toCss({ ...S.content, minWidth: undefined })   // minWidth:0 이 없던 상태
    : toCss(S.content);
  const sideStyle = legacy
    ? toCss(S.sidebar)                                        // 모바일에서도 고정 열이던 상태
    : (mobile ? toCss({ ...S.sidebarDrawer, transform: "translateX(-100%)" }) : toCss(S.sidebar));
  const topbarStyle = legacy || !mobile
    ? toCss(MS.topbar)                                        // 고정 height:52 · 줄바꿈 없음
    : toCss({ ...MS.topbar, ...MS.topbarMobile });

  return `<!doctype html><html><head><meta charset="utf-8"><style>
${tokensCss}
*{box-sizing:border-box} html,body{margin:0;padding:0}
</style></head><body>
<div id="wrap" style="${toCss(S.wrap)}">
  <div id="side" style="${sideStyle}">
    <nav id="nav" style="${toCss(S.nav)}">
      ${TABS.map((t, i) => `<div class="navitem" data-i="${i}" style="${toCss(S.navItem)}"><span style="flex-shrink:0;width:17px;height:17px;display:inline-block"></span><span class="navlabel">${t}</span></div>`).join("")}
    </nav>
  </div>
  <div id="content" style="${contentStyle}">
    <div id="mapwrap" style="position:relative;flex:1;min-height:0">
      <div id="topbar" style="${topbarStyle}">
        ${TOPBAR_LABELS.map((s, i) => `<span class="toplabel" data-i="${i}" style="font-size:12px;font-weight:600">${s}</span>`).join("")}
      </div>
      <div id="rail" style="${mobile && !legacy ? toCss(MS.railSheet) : toCss(MS.leftRail)}"></div>
    </div>
  </div>
</div>
</body></html>`;
}

// 한 요소가 "세로글씨"인지 = 글자가 글자당 한 줄로 쌓였는지.
// 판정 = 실제 높이가 한 줄 높이의 2.5배를 넘는가(폭이 min-content 까지 눌린 결과).
const MEASURE = `(() => {
  const out = [];
  document.querySelectorAll(".toplabel").forEach((el) => {
    const r = el.getBoundingClientRect();
    const fs = parseFloat(getComputedStyle(el).fontSize);
    out.push({ text: el.textContent, w: Math.round(r.width), h: Math.round(r.height), fs, stacked: r.height > fs * 2.5 });
  });
  const side = document.getElementById("side").getBoundingClientRect();
  const content = document.getElementById("content").getBoundingClientRect();
  const rail = document.getElementById("rail").getBoundingClientRect();
  const labels = [];
  document.querySelectorAll(".navlabel").forEach((el) => {
    const r = el.getBoundingClientRect();
    const fs = parseFloat(getComputedStyle(el).fontSize);
    labels.push({ text: el.textContent, h: Math.round(r.height), stacked: r.height > fs * 2.5 });
  });
  return { top: out, side: { x: Math.round(side.x), w: Math.round(side.width), right: Math.round(side.right) },
           content: { x: Math.round(content.x), w: Math.round(content.width) },
           rail: { x: Math.round(rail.x), w: Math.round(rail.width), y: Math.round(rail.y), h: Math.round(rail.height) },
           navLabels: labels };
})()`;

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();

  const run = async (mobile, legacy) => {
    await p.setContent(page(mobile, legacy), { waitUntil: "load" });
    return await p.evaluate(MEASURE);
  };

  console.log(`\n── 대조군: 이번 수정 **전** 구조를 같은 잣대로 (${VW}×${VH}) ──`);
  const before = await run(true, true);
  const beforeStacked = before.top.filter((t) => t.stacked);
  // 🔴 신호 유무 — 옛 구조에서 실제로 세로글씨가 나야 이 검사가 의미를 갖는다.
  ok(beforeStacked.length > 0, "[대조0] 옛 구조에서 세로글씨가 실제로 발생한다(신호 유무)",
    `${beforeStacked.length}개: ${beforeStacked.slice(0, 3).map((t) => `${t.text}(${t.w}×${t.h})`).join(", ")}`);
  ok(before.side.w >= 200, "[대조1] 옛 구조는 사이드바가 가로 폭을 차지한다", `${before.side.w}px`);
  ok(before.content.w < VW, "[대조2] 옛 구조는 본문이 그만큼 좁아진다", `${before.content.w}px`);
  ok(before.rail.w >= VW * 0.5, "[대조3] 옛 구조는 좌측 레일이 화면 절반 이상을 덮는다",
    `${before.rail.w}px = ${Math.round(before.rail.w / VW * 100)}%`);

  console.log("\n── 현재 구조: 모바일(360px) ──");
  const now = await run(true, false);
  ok(now.side.right <= 0, "[1] 드로어는 닫혀 있을 때 화면 밖에 있다", `right=${now.side.right}px`);
  ok(now.content.x === 0 && now.content.w === VW, "[2] 본문이 화면 전체를 쓴다(드로어가 자리를 안 먹는다)",
    `x=${now.content.x} w=${now.content.w}`);
  const nowStacked = now.top.filter((t) => t.stacked);
  ok(nowStacked.length === 0, "[3] 지도 탑바에 세로글씨가 없다",
    nowStacked.length ? nowStacked.map((t) => `${t.text}(${t.w}×${t.h})`).join(", ") : `라벨 ${now.top.length}개 전부 정상`);
  const navStacked = now.navLabels.filter((l) => l.stacked);
  ok(navStacked.length === 0, "[4] 메뉴 이름에 세로글씨가 없다",
    navStacked.length ? navStacked.map((l) => l.text).join(", ") : `항목 ${now.navLabels.length}개 정상`);
  ok(now.rail.w <= VW && now.rail.x >= 0 && now.rail.h <= VH * 0.45,
    "[5] 차량 목록이 하단 시트다(지도를 가로로 안 가린다)",
    `x=${now.rail.x} w=${now.rail.w} h=${now.rail.h}(≤${Math.round(VH * 0.45)})`);
  ok(now.rail.y > VH * 0.5, "[6] 하단 시트가 화면 아래쪽에 있다", `y=${now.rail.y}`);

  console.log("\n── 현재 구조: 드로어 열림 ──");
  await p.setContent(page(true, false), { waitUntil: "load" });
  await p.evaluate(() => {
    const s = document.getElementById("side");
    // 🔴 transition 을 끄고 옮긴다 — 안 끄면 애니메이션 도중 값을 재서 닫힌 위치가 잡힌다
    //    (처음 이 하네스가 x=-264 로 실패한 이유. 재는 시점이 아니라 재는 상태를 고정할 것).
    s.style.transition = "none";
    s.style.transform = "translateX(0)";
    const b = document.createElement("div");
    b.id = "backdrop";
    document.getElementById("wrap").prepend(b);
    return b;
  });
  await p.evaluate((css) => { document.getElementById("backdrop").style.cssText = css; }, toCss(S.navBackdrop));
  const open = await p.evaluate(`(() => {
    const s = document.getElementById("side").getBoundingClientRect();
    const b = document.getElementById("backdrop").getBoundingClientRect();
    const c = document.getElementById("content").getBoundingClientRect();
    const sz = getComputedStyle(document.getElementById("side")).zIndex;
    const bz = getComputedStyle(document.getElementById("backdrop")).zIndex;
    return { side:{x:Math.round(s.x),w:Math.round(s.width)}, back:{w:Math.round(b.width),h:Math.round(b.height)},
             content:{x:Math.round(c.x),w:Math.round(c.width)}, sz:+sz, bz:+bz };
  })()`);
  ok(open.side.x === 0 && open.side.w > 0, "[7] 열면 드로어가 왼쪽에 붙어 나타난다", `x=${open.side.x} w=${open.side.w}`);
  ok(open.side.w <= VW * 0.8 + 1, "[8] 드로어가 화면을 다 덮지 않는다(뒤를 탭할 여지)", `${open.side.w}px ≤ ${Math.round(VW * 0.8)}px`);
  ok(open.back.w >= VW && open.back.h >= VH, "[9] 딤이 화면을 덮는다(탭하면 닫히는 표적)", `${open.back.w}×${open.back.h}`);
  ok(open.sz > open.bz, "[10] 드로어가 딤보다 위다", `drawer z=${open.sz} > backdrop z=${open.bz}`);
  ok(open.content.x === 0 && open.content.w === VW, "[11] 열려 있어도 본문 레이아웃은 그대로", `x=${open.content.x} w=${open.content.w}`);

  console.log("\n── 회귀: PC(1280px) 는 그대로인가 ──");
  await ctx.close();
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p2 = await ctx2.newPage();
  await p2.setContent(page(false, false), { waitUntil: "load" });
  const pc = await p2.evaluate(MEASURE);
  ok(pc.side.x === 0 && pc.side.w === S.sidebar.width, "[12] PC 사이드바는 고정 열 그대로", `${pc.side.w}px`);
  ok(pc.content.x === S.sidebar.width, "[13] PC 본문은 사이드바 옆에서 시작", `x=${pc.content.x}`);
  ok(pc.top.filter((t) => t.stacked).length === 0, "[14] PC 탑바 세로글씨 0");

  if (process.argv.includes("--shot")) {
    const f = path.join(SHOT_DIR, "admin_mobile_shell.png");
    await p2.screenshot({ path: f });
    console.log(`  · 스크린샷 ${f}`);
  }
  await browser.close();

  console.log("\n── 소스 회귀 가드 ──");
  ok(/content:\{flex:1,minWidth:0,/.test(adminSrc), "[15] S.content 에 minWidth:0 이 있다");
  ok(S.navItem.whiteSpace === "nowrap", "[16] S.navItem 에 whiteSpace:nowrap 이 있다", `실제값 ${JSON.stringify(S.navItem.whiteSpace)}`);
  ok(adminSrc.includes("sidebarDrawer:") && adminSrc.includes("navBackdrop:"), "[17] 드로어·딤 스타일이 남아 있다");
  ok(!/gridTemplateColumns:"1fr 1fr"[\s\S]{0,400}setMenuOpen\(false\)/.test(adminSrc), "[18] 옛 2열 드롭다운 메뉴가 되살아나지 않았다");
  ok(/const isMobile = useIsMobile\(\)/.test(adminSrc), "[19] 모바일 판정이 공용 훅 한 곳이다");

  console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass}/${pass + fail} 통과`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("ERR", e && e.stack ? e.stack : e); process.exit(1); });
