// 관리자 콘솔 사이드바 메뉴 스크롤 확인 (2026-08-11 way "메뉴 스크롤 안됨").
//   node scripts/test_sidebar_scroll.cjs
//
// 관리자 콘솔은 로그인이 필요해 화면 전체를 헤드리스로 못 띄운다(2026-08-05 기록과 동일).
// 그래서 **사이드바 구조만** 실제로 렌더해서 픽셀로 잰다.
//
// 🔴 스타일은 `pages/AdminApp.js` 의 S 객체에서 **그대로 뽑아** 쓴다(다시 쓰지 않는다).
//    다시 쓰면 소스가 바뀌어도 이 검사는 영원히 통과한다.
// 🔴 옛 동작(스크롤 영역 없음 + flex:1 스페이서)도 **같은 잣대로 재현**해 잘림을 검출하는지
//    확인한다(양성 대조) — 그게 없으면 "통과"가 무엇을 증명하는지 알 수 없다.
const fs = require("fs");
const path = require("path");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ROOT = path.join(__dirname, "..");
const SHOT_DIR = process.env.SHOT_DIR || require("os").tmpdir();   // `--shot` 일 때만 사용

const adminSrc = fs.readFileSync(path.join(ROOT, "src/pages/AdminApp.js"), "utf8");
const indexCss = fs.readFileSync(path.join(ROOT, "src/index.css"), "utf8");
const tokensCss = fs.readFileSync(path.join(ROOT, "src/styles/tokens.css"), "utf8");

let pass = 0, fail = 0;
const ok = (cond, label, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
};

// ── ① 소스에서 S 객체 스타일 추출 ────────────────────────────────────────────
// 🔴 반드시 **최상위 `const S`** 안에서만 찾는다 — 파일 안에 같은 이름의 지역 스타일 객체가
//    또 있다(예: 1357행의 `wrap:{height:"100%"}`). 파일 전체에서 첫 매치를 집으면 엉뚱한
//    스타일로 재고, 컨테이너 높이가 안 걸려 "안 넘친다"는 거짓 결론이 난다(실제로 한 번 속았다).
const S_START = adminSrc.indexOf("\nconst S = {");
if (S_START < 0) { console.error("🔴 최상위 const S 를 못 찾음"); process.exit(1); }
const S_SRC = adminSrc.slice(S_START, adminSrc.indexOf("\n};", S_START));

// 형식: `  key:{ ... },` 한 줄. 못 찾으면 소스 구조가 바뀐 것이므로 즉시 중단한다.
function pickStyle(key) {
  const re = new RegExp(`^\\s{2}${key}:(\\{.*\\}),\\s*$`, "m");
  const m = S_SRC.match(re);
  if (!m) { console.error(`🔴 S.${key} 를 소스에서 못 찾음 — 스타일 구조가 바뀌었다.`); process.exit(1); }
  // 값은 문자열/숫자 리터럴뿐이라 Function 평가가 안전하다.
  return Function(`"use strict"; return (${m[1]});`)();
}
const S = {};
for (const k of ["wrap", "sidebar", "logo", "sideSection", "nav", "navItem", "navActive", "navIcon", "sideFoot", "logoutBtn"]) S[k] = pickStyle(k);

const UNITLESS = new Set(["flex", "flexShrink", "flexGrow", "fontWeight", "opacity", "zIndex", "lineHeight", "order"]);
const toCss = (obj) => Object.entries(obj).map(([k, v]) => {
  const prop = k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
  const val = typeof v === "number" && !UNITLESS.has(k) ? `${v}px` : String(v);
  return `${prop}:${val}`;
}).join(";");

// TABS 도 소스에서(항목 수가 곧 이 결함의 원인이다 — 하드코딩하면 늘어나도 모른다)
const tabsM = adminSrc.match(/^const TABS = (\[[^\]]*\]);/m);
if (!tabsM) { console.error("🔴 TABS 를 못 찾음"); process.exit(1); }
const TABS = Function(`"use strict"; return (${tabsM[1]});`)();
const ITEMS = [...TABS, "회사 관리"];   // 슈퍼관리자 로그인 = 최대 항목 수(가장 불리한 조건)

// ── ② HTML 조립 ──────────────────────────────────────────────────────────────
const ICON = `<span style="${toCss(S.navIcon)}"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="3" width="18" height="18" rx="3"/></svg></span>`;

function sidebarHtml({ legacy }) {
  const navStyle = legacy
    // 옛 동작 재현: 스크롤 영역 없음(flex/minHeight/overflow 제거) + 뒤에 flex:1 스페이서
    ? toCss({ display: "flex", flexDirection: "column", gap: 2 })
    : toCss(S.nav);
  const itemStyle = legacy
    ? toCss(Object.fromEntries(Object.entries(S.navItem).filter(([k]) => k !== "flexShrink")))
    : toCss(S.navItem);
  const sideStyle = legacy
    ? toCss(Object.fromEntries(Object.entries(S.sidebar).filter(([k]) => k !== "minHeight" && k !== "flexShrink")))
    : toCss(S.sidebar);
  const footStyle = legacy
    ? toCss(Object.fromEntries(Object.entries(S.sideFoot).filter(([k]) => k !== "flexShrink" && k !== "marginTop" && k !== "borderTop")))
    : toCss(S.sideFoot);
  const btnStyle = legacy
    ? toCss(Object.fromEntries(Object.entries(S.logoutBtn).filter(([k]) => k !== "flexShrink")))
    : toCss(S.logoutBtn);

  const items = ITEMS.map((t, i) =>
    `<div data-nav-item data-idx="${i}" style="${itemStyle}${i === 0 ? ";" + toCss(S.navActive) : ""}">${ICON}${t}</div>`).join("");

  return `<div id="side" style="${sideStyle}">
    <div style="${toCss(S.logo)}"><b style="font-size:20px">BusLink</b><span style="font-size:12px">관리자</span></div>
    <div style="${toCss(S.sideSection)}">메뉴</div>
    <nav id="nav" ${legacy ? "" : "data-nav-scroll"} style="${navStyle}">${items}</nav>
    ${legacy ? '<div style="flex:1"></div>' : ""}
    <div id="foot" style="${footStyle}">dy001</div>
    <button id="logout" style="${btnStyle}">로그아웃</button>
  </div>`;
}

const page = (legacy) => `<!doctype html><html><head><meta charset="utf-8"><style>
${tokensCss}
${indexCss}
html,body{margin:0;padding:0}
</style></head><body>
<div style="${toCss(S.wrap)}">${sidebarHtml({ legacy })}<div style="flex:1"></div></div>
</body></html>`;

// ── ③ 측정 ───────────────────────────────────────────────────────────────────
async function measure(p) {
  return await p.evaluate(() => {
    const nav = document.getElementById("nav");
    const side = document.getElementById("side");
    const logout = document.getElementById("logout");
    const items = [...document.querySelectorAll("[data-nav-item]")];
    const last = items[items.length - 1];
    const r = (el) => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, height: b.height }; };
    // 끝까지 스크롤해 본다(스크롤이 안 되면 값이 그대로다)
    nav.scrollTop = nav.scrollHeight;
    const afterScroll = r(last);
    nav.scrollTop = 0;
    return {
      itemCount: items.length,
      navScrollable: nav.scrollHeight > nav.clientHeight + 1,
      navBox: r(nav),
      sideBox: r(side),
      sideOverflow: side.scrollHeight - side.clientHeight,
      logoutBox: r(logout),
      lastAtTop: r(last),
      lastAfterScroll: afterScroll,
      viewportH: window.innerHeight,
    };
  });
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });

  // 신고 화면과 같은 낮은 창(스크린샷 기준 콘텐츠 높이 ≈ 660) + 더 낮은 노트북 창
  for (const H of [660, 600]) {
    console.log(`\n── 창 높이 ${H}px (탭 ${ITEMS.length}개 = 슈퍼관리자 로그인) ──`);

    // 양성 대조: 옛 코드
    let p = await browser.newPage({ viewport: { width: 1333, height: H } });
    await p.setContent(page(true));
    const oldM = await measure(p);
    console.log(`  [옛 코드] 창=${oldM.viewportH} · 사이드바 높이=${oldM.sideBox.height.toFixed(0)} · 메뉴 스크롤 가능=${oldM.navScrollable} · 마지막 항목 아래끝=${oldM.lastAfterScroll.bottom.toFixed(0)} · 사이드바 아래끝=${oldM.sideBox.bottom.toFixed(0)}`);
    ok(!oldM.navScrollable, "① 양성 대조: 옛 코드는 메뉴에 스크롤 영역이 없다");
    ok(oldM.lastAfterScroll.bottom > oldM.sideBox.bottom + 1,
      "② 양성 대조: 옛 코드는 끝까지 스크롤해도 마지막 항목이 화면 밖",
      `${(oldM.lastAfterScroll.bottom - oldM.sideBox.bottom).toFixed(0)}px 잘림`);
    await p.close();

    // 현재 코드
    p = await browser.newPage({ viewport: { width: 1333, height: H } });
    await p.setContent(page(false));
    const m = await measure(p);
    console.log(`  [현재]   메뉴 스크롤 가능=${m.navScrollable} · 마지막 항목 아래끝=${m.lastAfterScroll.bottom.toFixed(0)} · 메뉴영역 아래끝=${m.navBox.bottom.toFixed(0)}`);

    // 🔴 신호 유무 검사 — 항목이 다 안 그려졌거나 애초에 안 넘치면 아래 판정이 무의미하다
    ok(m.itemCount === ITEMS.length, "③ 신호 유무: 메뉴 항목이 전부 렌더됐다", `${m.itemCount}개`);
    ok(m.navScrollable, "④ 신호 유무: 이 창 높이에서 메뉴가 실제로 넘친다(안 넘치면 검사 무의미)");

    ok(m.lastAfterScroll.bottom <= m.navBox.bottom + 1,
      "⑤ 끝까지 스크롤하면 마지막 항목이 보인다",
      `여유 ${(m.navBox.bottom - m.lastAfterScroll.bottom).toFixed(0)}px`);
    ok(m.logoutBox.bottom <= m.sideBox.bottom + 1 && m.logoutBox.top >= m.sideBox.top,
      "⑥ 로그아웃 버튼이 잘리지 않고 고정된다",
      `아래끝 ${m.logoutBox.bottom.toFixed(0)} ≤ 사이드바 ${m.sideBox.bottom.toFixed(0)}`);
    ok(m.sideOverflow <= 1, "⑦ 사이드바 자체는 넘치지 않는다(스크롤은 메뉴 안에서만)", `초과 ${m.sideOverflow}px`);
    ok(m.lastAtTop.bottom > m.navBox.bottom,
      "⑧ 스크롤 전에는 마지막 항목이 아직 아래에 있다(스크롤이 실제로 움직였다는 증거)");
    // 눈으로도 본다(픽셀 수치만으로는 구분선·여백이 어떻게 보이는지 모른다).
    // ⚠ 캡처에 스크롤바가 안 보이는 건 **헤드리스가 오버레이 스크롤바**를 쓰기 때문이다
    //   (같은 조건에서 아무 `overflow:auto` div 도 gutter 0 → 우리 CSS 탓이 아니다).
    //   실제 Windows Chrome 은 자리를 차지하는 스크롤바를 그린다 — 이걸로 "안 보인다"고 판단하지 말 것.
    if (process.argv.includes("--shot") && H === 660) {
      for (const [tag, pos] of [["top", 0], ["bottom", 99999]]) {
        await p.evaluate((v) => { document.getElementById("nav").scrollTop = v; }, pos);
        const out = path.join(SHOT_DIR, `sidebar_${tag}.png`);
        await p.screenshot({ path: out, clip: { x: 0, y: 0, width: 300, height: H } });
        console.log(`  📷 ${out}`);
      }
    }
    await p.close();
  }

  // 높은 창 = 회귀 검사: 예전과 똑같이 보여야 한다(스크롤 없음·로그아웃 맨 아래)
  console.log(`\n── 창 높이 1080px (회귀: 넉넉한 화면에서 전과 동일해야) ──`);
  const p2 = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  await p2.setContent(page(false));
  const tall = await measure(p2);
  ok(!tall.navScrollable, "⑨ 넉넉한 화면에선 스크롤이 생기지 않는다");
  ok(tall.lastAtTop.bottom <= tall.navBox.bottom + 1, "⑩ 모든 항목이 그냥 보인다");
  ok(Math.abs(tall.logoutBox.bottom - (tall.sideBox.bottom - 18)) <= 2,
    "⑪ 로그아웃 버튼이 여전히 사이드바 맨 아래(패딩 18px)에 붙는다",
    `${tall.logoutBox.bottom.toFixed(0)} vs ${(tall.sideBox.bottom - 18).toFixed(0)}`);
  await p2.close();
  await browser.close();

  // ── ④ 소스 회귀 가드 ───────────────────────────────────────────────────────
  console.log(`\n── 소스 가드(복원 금지) ──`);
  const navLine = S_SRC.match(/^\s{2}nav:\{.*\},\s*$/m)[0];
  ok(/overflowY:"auto"/.test(navLine), "⑫ nav 에 overflowY:auto 가 있다");
  ok(/minHeight:0/.test(navLine), "⑬ nav 에 minHeight:0 이 있다(빼면 flex 기본값 때문에 스크롤이 안 생긴다)");
  ok(/flex:1/.test(navLine), "⑭ nav 가 flex:1 로 남는 높이를 차지한다");
  ok(/<nav data-nav-scroll style=\{S\.nav\}>/.test(adminSrc), "⑮ nav 에 data-nav-scroll 이 붙어 있다");
  // 사이드바 블록에 한정 — 모달 버튼줄 등 다른 곳의 flex:1 스페이서는 무관하다.
  const sideBlock = adminSrc.slice(adminSrc.indexOf("<nav data-nav-scroll"), adminSrc.indexOf("style={S.sideFoot}"));
  ok(!/<div style=\{\{ flex: 1 \}\} \/>/.test(sideBlock), "⑯ 사이드바의 옛 flex:1 스페이서가 제거됐다(nav 가 그 역할을 한다)");
  ok(/\[data-nav-scroll\]\s*\{[^}]*scrollbar-width:\s*thin/.test(indexCss),
    "⑰ 스크롤바를 숨기지 않는다(‘더 있다’는 신호가 곧 이 수정의 목적)");
  ok(!/\[data-nav-scroll\][^{]*\{[^}]*display:\s*none/.test(indexCss), "⑱ data-nav-scroll 스크롤바 숨김 규칙이 없다");
  ok(/maxHeight:"calc\(100dvh - 50px\)"[\s\S]{0,40}overflowY:"auto"/.test(adminSrc),
    "⑲ 모바일 드롭다운에도 높이 상한+스크롤이 있다(부모가 overflow:hidden)");

  console.log(`\n${fail === 0 ? "✅" : "🔴"} 통과 ${pass} / 실패 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
