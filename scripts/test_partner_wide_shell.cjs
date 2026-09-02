// 협력사 포털 PC 레이아웃 검증 (2026-09-02 way "PC에서는 화면이 가로로 채워져서 어드민처럼")
//   node scripts/test_partner_wide_shell.cjs [--shot]
//
// 포털은 업체코드 인증 뒤에야 이 화면이 나오므로 전체를 헤드리스로 못 띄운다
// (관리자 콘솔과 같은 처지 — `test_admin_mobile_shell.cjs` 선례). 그래서 **셸 구조만**
// 실제로 렌더해 픽셀로 잰다.
//
// 🔴 스타일은 `pages/PartnerApp.js` 의 S 객체에서 **그대로 뽑아** 쓴다(다시 쓰지 않는다).
//    다시 쓰면 소스가 바뀌어도 이 검사는 영원히 통과한다.
// 🔴 옛 레이아웃(가운데 카드)도 **같은 잣대로 재현**해 "가로가 빈다"가 실제로 검출되는지
//    확인한다 — 그게 없으면 "통과"가 무엇을 증명하는지 알 수 없다.
const fs = require("fs");
const path = require("path");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ROOT = path.join(__dirname, "..");
const SHOT_DIR = process.env.SHOT_DIR || require("os").tmpdir();

const src = fs.readFileSync(path.join(ROOT, "src/pages/PartnerApp.js"), "utf8");
const tokensCss = fs.readFileSync(path.join(ROOT, "src/styles/tokens.css"), "utf8");

let pass = 0, fail = 0;
const ok = (cond, label, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
};

// ── ① 소스에서 스타일 추출 ──────────────────────────────────────────────────
// 🔴 최상위 `const S = {` 안에서만 찾는다(파일에 같은 이름의 지역 객체가 또 생길 수 있다).
const S_START = src.indexOf("\nconst S = {");
if (S_START < 0) { console.error("🔴 최상위 const S 를 못 찾음"); process.exit(1); }
const S_SRC = src.slice(S_START, src.indexOf("\n};", S_START));

function pick(key) {
  const m = S_SRC.match(new RegExp(`^\\s{2}${key}: ?(\\{[\\s\\S]*?\\}),\\s*$`, "m"));
  if (!m) { console.error(`🔴 S.${key} 를 소스에서 못 찾음 — 스타일 구조가 바뀌었다.`); process.exit(1); }
  return Function(`"use strict"; return (${m[1]});`)();
}
const S = {};
for (const k of ["wrap", "card", "shell", "sideCol", "contentCol", "topbar", "main", "navItem", "tableWrap", "table", "th", "td"]) S[k] = pick(k);

const WIDE_MIN_W = Number((src.match(/const WIDE_MIN_W = (\d+);/) || [])[1]);
const TAB_MAX_W = Function(`"use strict"; return (${(src.match(/const TAB_MAX_W = (\{[^}]*\});/) || [])[1]});`)();

const UNITLESS = new Set(["flex", "flexShrink", "flexGrow", "fontWeight", "opacity", "zIndex", "lineHeight", "order"]);
const toCss = (obj) => Object.entries(obj)
  .filter(([, v]) => v !== undefined && v !== null)
  .map(([k, v]) => {
    const prop = k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
    const val = typeof v === "number" && !UNITLESS.has(k) ? `${v}px` : String(v);
    return `${prop}:${val}`;
  }).join(";");

// 실제로 그 화면에 서는 한글 라벨(소스 문구 그대로 — 짧은 것만 넣으면 잘림이 안 드러난다).
const NAV = ["승객 등록", "승객 관리", "탑승 통계", "운영 포털"];
const TH = ["이름", "사번", "부서", "노선", "상태", "NFC 카드", "작업"];
const ROW = ["김통근", "0012345", "경영지원팀", "[A] 등교(월~수,금)", "재직 · 미시작", "0453ce9a", "수정 비밀번호 재발급 삭제"];

// legacy=true 면 이번 수정 **전** 구조(가운데 카드)를 같은 잣대로 재현한다.
function page(legacy) {
  const inner = `
    <div id="topbar" style="${toCss(S.topbar)}">
      <span class="lbl">승객 관리</span><span class="lbl">등록된 승객을 찾아 수정·재발급합니다</span>
    </div>
    <div id="main" style="${toCss(S.main)}">
      <div id="inner" style="width:100%;max-width:${TAB_MAX_W.manage}px;margin:0 auto">
        <div id="tablewrap" style="${toCss(S.tableWrap)}">
          <table style="${toCss(S.table)}">
            <thead><tr>${TH.map((h) => `<th style="${toCss(S.th)}"><span class="cell">${h}</span></th>`).join("")}</tr></thead>
            <tbody>${[0, 1, 2].map(() => `<tr>${ROW.map((c) => `<td style="${toCss(S.td)}"><span class="cell">${c}</span></td>`).join("")}</tr>`).join("")}</tbody>
          </table>
        </div>
      </div>
    </div>`;

  if (legacy) {
    // 옛 구조: 화면이 아무리 넓어도 480~760px 카드 하나가 가운데 선다.
    return `<!doctype html><html><head><meta charset="utf-8"><style>
${tokensCss}
*{box-sizing:border-box} html,body{margin:0;padding:0}
</style></head><body>
<div id="shell" style="${toCss(S.wrap)}">
  <div id="content" style="${toCss({ ...S.card, maxWidth: 760 })}">
    <div id="side" style="width:0;height:0"></div>
    ${inner}
  </div>
</div></body></html>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${tokensCss}
*{box-sizing:border-box} html,body{margin:0;padding:0}
</style></head><body>
<div id="shell" style="${toCss(S.shell)}">
  <div id="side" style="${toCss(S.sideCol)}">
    <nav id="nav" style="display:flex;flex-direction:column;gap:2px;flex:1;min-height:0;overflow-y:auto">
      ${NAV.map((t) => `<div class="navitem" style="${toCss(S.navItem)}"><span style="flex-shrink:0;width:17px;height:17px;display:inline-block"></span><span class="navlabel">${t}</span></div>`).join("")}
    </nav>
  </div>
  <div id="content" style="${toCss(S.contentCol)}">${inner}</div>
</div></body></html>`;
}

// "세로글씨"(글자당 한 줄로 쌓임) = 실제 높이가 한 줄 높이의 2.5배를 넘는가.
const MEASURE = `(() => {
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) }; };
  const stacked = (sel) => {
    const out = [];
    document.querySelectorAll(sel).forEach((el) => {
      const r = el.getBoundingClientRect();
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (r.height > fs * 2.5) out.push({ text: el.textContent.trim().slice(0, 14), w: Math.round(r.width), h: Math.round(r.height) });
    });
    return out;
  };
  return {
    side: box(document.getElementById("side")),
    content: box(document.getElementById("content")),
    inner: box(document.getElementById("inner")),
    tablewrap: box(document.getElementById("tablewrap")),
    stackedCells: stacked(".cell"),
    stackedNav: stacked(".navlabel"),
    pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
})()`;

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const VW = 1440, VH = 900;
  const ctx = await browser.newContext({ viewport: { width: VW, height: VH } });
  const p = await ctx.newPage();

  console.log(`\n── 대조군: 이번 수정 **전** 구조(가운데 카드)를 같은 잣대로 (${VW}×${VH}) ──`);
  await p.setContent(page(true), { waitUntil: "load" });
  const before = await p.evaluate(MEASURE);
  // 🔴 신호 유무 — 옛 구조에서 실제로 "가로가 빈다"가 나야 이 검사가 의미를 갖는다.
  ok(before.content.w <= 800, "[대조0] 옛 구조는 본문이 카드 폭에 갇힌다", `${before.content.w}px = 화면의 ${Math.round(before.content.w / VW * 100)}%`);
  ok(before.content.w / VW < 0.6, "[대조1] 화면의 40% 이상이 빈다", `${Math.round((1 - before.content.w / VW) * 100)}% 여백`);
  const beforeStacked = before.stackedCells.length;
  ok(beforeStacked > 0 || before.tablewrap.w <= 800, "[대조2] 옛 폭에서는 표가 카드 안에 눌린다",
    `표 폭 ${before.tablewrap.w}px · 세로글씨 ${beforeStacked}개`);

  console.log(`\n── 현재 구조: PC(${VW}×${VH}) ──`);
  await p.setContent(page(false), { waitUntil: "load" });
  const now = await p.evaluate(MEASURE);
  ok(now.side.x === 0 && now.side.w === S.sideCol.width, "[1] 사이드바가 왼쪽 고정 열이다", `${now.side.w}px`);
  ok(now.content.x === S.sideCol.width && now.content.w === VW - S.sideCol.width,
    "[2] 본문이 사이드바 옆에서 시작해 남은 가로를 전부 쓴다", `x=${now.content.x} w=${now.content.w}`);
  ok(now.inner.w >= 1000, "[3] 승객 관리 본문이 실제로 넓게 채워진다", `${now.inner.w}px (옛 구조 ${before.content.w}px)`);
  ok(now.inner.w > before.content.w * 1.5, "[4] 옛 구조보다 최소 1.5배 넓다",
    `${now.inner.w} vs ${before.content.w}`);
  ok(now.stackedCells.length === 0, "[5] 표 칸에 세로글씨가 없다",
    now.stackedCells.length ? JSON.stringify(now.stackedCells.slice(0, 3)) : `칸 ${TH.length * 4}개 정상`);
  ok(now.stackedNav.length === 0, "[6] 메뉴 이름에 세로글씨가 없다");
  ok(now.pageOverflow <= 0, "[7] 페이지가 가로로 넘치지 않는다", `overflow=${now.pageOverflow}px`);
  ok(now.tablewrap.right <= now.content.right, "[8] 표가 본문 밖으로 삐져나가지 않는다",
    `표 right=${now.tablewrap.right} ≤ 본문 right=${now.content.right}`);

  console.log("\n── 회귀: 좁은 화면은 예전 그대로여야 한다 ──");
  await ctx.close();
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p2 = await ctx2.newPage();
  await p2.setContent(page(true), { waitUntil: "load" });
  const m = await p2.evaluate(MEASURE);
  ok(m.pageOverflow <= 0, "[9] 모바일 카드 레이아웃이 가로로 안 넘친다", `overflow=${m.pageOverflow}px`);
  ok(m.content.w <= 390, "[10] 카드가 화면 폭 안에 들어온다", `${m.content.w}px`);

  if (process.argv.includes("--shot")) {
    const ctx3 = await browser.newContext({ viewport: { width: VW, height: VH } });
    const p3 = await ctx3.newPage();
    await p3.setContent(page(false), { waitUntil: "load" });
    const f = path.join(SHOT_DIR, "partner_wide_shell.png");
    await p3.screenshot({ path: f });
    console.log(`  · 스크린샷 ${f}`);
  }
  await browser.close();

  console.log("\n── 소스 회귀 가드 ──");
  ok(WIDE_MIN_W === 1024, "[11] PC 판정 기준이 1024px 이다", `WIDE_MIN_W=${WIDE_MIN_W}`);
  // 🔴 minWidth:0 이 세로글씨의 예방책이다(AdminApp 2026-08-26 과 같은 함정).
  ok(S.contentCol.minWidth === 0, "[12] S.contentCol 에 minWidth:0 이 있다", JSON.stringify(S.contentCol.minWidth));
  ok(S.contentCol.minHeight === 0 && S.main.minHeight === 0, "[13] 세로 스크롤용 minHeight:0 이 있다");
  ok(S.navItem.whiteSpace === "nowrap", "[14] 메뉴 이름은 줄바꿈하지 않는다");
  // 🔴 인증 화면까지 셸로 감싸지 말 것 — 로그인은 가운데 카드가 맞다(관리자 콘솔과 같다).
  ok(/if \(wide && step !== STEPS\.CODE && codeData\)/.test(src), "[15] 인증 화면은 PC 에서도 가운데 카드다");
  // 🔴 모바일 반응형은 손대지 않는다(way "현재 버전은 모바일 반응형으로 잘 두고").
  ok(/모바일·태블릿\(<1024px\) — 기존 카드 레이아웃 그대로/.test(src), "[16] 좁은 화면 경로가 그대로 남아 있다");
  // 🔴 탭 목록이 한 벌이어야 모바일 탭바와 PC 사이드바가 같이 는다.
  ok((src.match(/const MAIN_TABS = \[/g) || []).length === 1 && /MAIN_TABS\.map/.test(src),
    "[17] 탭 목록 정본이 한 곳(MAIN_TABS)이다");
  ok(/EmployeeManageMode codeData=\{codeData\} code=\{code\} routes=\{routes\} wide=\{wide\}/.test(src),
    "[18] 승객 관리에 wide 가 전달된다");
  // 🔴 «어떻게 생긴 JSX 인가» 가 아니라 «표로 그리는가» 를 잰다 — 주석 한 줄에 빨개지면 안 된다.
  ok(/wide \? \([\s\S]{0,400}S\.tableWrap[\s\S]{0,200}<table style=\{S\.table\}>/.test(src),
    "[19] PC 는 표(S.table)로 그린다");
  ok(/visible\.map/.test(src) && (src.match(/visible\.map/g) || []).length === 2,
    "[20] 표와 카드가 같은 `visible` 배열을 그린다(표시 상한이 한 곳)");

  console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass}/${pass + fail} 통과`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("ERR", e && e.stack ? e.stack : e); process.exit(1); });
