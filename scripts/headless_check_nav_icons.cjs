// 길안내 회전 픽토그램 실렌더 확인 (2026-08-06 way "지도 위에 엄청 크게 · 애니메이션").
//   node scripts/headless_check_nav_icons.cjs
//
// 기사앱은 로그인이 필요해 화면 전체를 헤드리스로 못 띄운다(2026-08-05 기록).
// 그래서 **그림 자체**만이라도 실제로 그려서 본다 — 새로 넣은 SVG 가 눈에 읽히는지,
// 지하/고가의 진입↔옆길이 서로 다르게 보이는지, 지도 위에서 대비가 나오는지.
//
// 🔴 도형은 `components/NavTurnIcon.js` 원문에서 **그대로 뽑아** 쓴다(다시 그리지 않는다).
//    다시 그리면 소스가 바뀌어도 이 확인은 영원히 예쁜 그림만 보여준다.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ROOT = path.join(__dirname, "..");

const src = fs.readFileSync(path.join(ROOT, "src/components/NavTurnIcon.js"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "src/styles/tokens.css"), "utf8");

// JSX → HTML: 공용 부품 상수 치환 · 프래그먼트 제거 · camelCase 속성 변환.
// 🔴 부품이 **상수 JSX** 여야 여기서 풀 수 있다. 함수 호출(`{FN(1)}`)로 바꾸면 치환이 안 되고
//    그림이 텅 빈 채로 통과한다 — 2026-08-06 에 실제로 한 번 속았다. 아래 ⑤ 가드가 그걸 잡는다.
const PARTS = {};
for (const m2 of src.matchAll(/const ([A-Z][A-Z_]*) = \(?\s*(<(?:rect|path)[\s\S]*?\/>)\s*\)?;/g)) {
  PARTS[m2[1]] = m2[2];
}
if (!PARTS.DECK) { console.error("🔴 DECK 를 못 찾음"); process.exit(1); }
console.log(`공용 부품 ${Object.keys(PARTS).length}종: ${Object.keys(PARTS).join(", ")}`);
const jsxToHtml = (s) => {
  let out = s;
  for (const [name, jsx] of Object.entries(PARTS)) out = out.split(`{${name}}`).join(jsx);
  return out
    .replace(/<>|<\/>/g, "")
    .replace(/strokeWidth=/g, "stroke-width=")
    .replace(/strokeLinecap=/g, "stroke-linecap=")
    .replace(/strokeLinejoin=/g, "stroke-linejoin=");
};

const body = src.slice(src.indexOf("const SHAPES = {"), src.indexOf("\n};", src.indexOf("const SHAPES = {")));
const kinds = [];
const re = /\n {2}"?([a-z-]+)"?:\s*\(([\s\S]*?)\n {2}\),/g;
let m;
while ((m = re.exec(body + "\n  x: (\n  ),")) !== null) {
  if (m[1] === "x") break;
  kinds.push({ kind: m[1], svg: jsxToHtml(m[2]) });
}
// motion 매핑은 navGuide 의 판정 결과와 같아야 의미가 있다 — 거기서 뽑는다
const nav = fs.readFileSync(path.join(ROOT, "src/lib/navGuide.js"), "utf8");
const motionOf = (kind) => {
  const r = new RegExp(`kind: "${kind}", motion: "([a-z]+)"`).exec(nav);
  return r ? r[1] : "up";
};

if (kinds.length < 10) { console.error(`🔴 도형 추출 ${kinds.length}종 — 파서 확인 필요`); process.exit(1); }
console.log(`추출한 픽토그램 ${kinds.length}종: ${kinds.map((k) => k.kind).join(", ")}`);

// ── 그리기 전에 소스 수준 가드 ──────────────────────────────
let guardFail = 0;
const g = (n, c, x) => { console.log(`  ${c ? "✓" : "✗"} ${n}${!c && x ? " → " + x : ""}`); if (!c) guardFail++; };
// ⑤ 🔴 치환 못 한 JSX 표현식이 남아 있으면 그 부분은 **안 그려진다** — 빈 그림이 통과하는 길.
const unresolved = kinds.filter((k) => /\{[^}]+\}/.test(k.svg));
g("치환 안 된 JSX 표현식 없음", unresolved.length === 0,
  unresolved.map((k) => `${k.kind}: ${(k.svg.match(/\{[^}]+\}/) || [])[0]}`).join(", "));
// way 가 요구한 핵심 — 진입과 옆길이 **다르게 보여야** 한다
const byKind = Object.fromEntries(kinds.map((k) => [k.kind, k.svg.replace(/\s+/g, " ").trim()]));
g("지하차도 진입 ≠ 옆길", byKind["underpass-enter"] !== byKind["underpass-side"]);
g("고가도로 진입 ≠ 옆길", byKind["overpass-enter"] !== byKind["overpass-side"]);
g("지하차도 ≠ 고가도로(진입)", byKind["underpass-enter"] !== byKind["overpass-enter"]);
g("지하차도 ≠ 고가도로(옆길)", byKind["underpass-side"] !== byKind["overpass-side"]);
// 도로 아이콘은 막대 + 본선 + (화살촉|갈래) = 최소 3개 요소여야 형태가 성립한다
["underpass-enter", "underpass-side", "overpass-enter", "overpass-side"].forEach((k) =>
  g(`${k} 요소 3개 이상`, (byKind[k].match(/<(rect|path)/g) || []).length >= 3,
    String((byKind[k].match(/<(rect|path)/g) || []).length)));
if (guardFail) { console.error("\n🔴 소스 가드 실패 — 렌더 안 함"); process.exit(1); }

// 2026-08-07 — 방향별로 아이콘을 흔들던 키프레임은 way 지적("장난감스럽다")으로 폐기됐다.
// 이 화면은 **도형 자체**를 보는 자리라 애니메이션 없이 정지 상태로 렌더한다.
const keyframes = (css.match(/@keyframes navturnring[\s\S]*?\n\}/g) || []).join("\n");
if (!keyframes) { console.error("🔴 navturnring 키프레임 없음"); process.exit(1); }

const cell = (k, near) => `
<div class="cell">
  <div class="map">
    <div class="ico ${near ? "near" : "far"}">
      <svg width="${near ? 168 : 124}" height="${near ? 168 : 124}" viewBox="0 0 64 64">${k.svg}</svg>
    </div>
  </div>
  <div class="cap">${k.kind}${near ? " · 접근" : ""}</div>
</div>`;

const html = `<!doctype html><meta charset="utf-8"><style>
${keyframes}
body{margin:0;background:#eef1f5;font:600 12px/1.4 sans-serif;padding:16px}
.grid{display:flex;flex-wrap:wrap;gap:12px}
.cell{width:190px}
/* 지도 비슷한 바탕 — 흰 길·회색 블록 위에서 대비가 나오는지 본다 */
.map{position:relative;height:190px;border-radius:10px;overflow:hidden;
  background:repeating-linear-gradient(45deg,#f6f7f9 0 18px,#e9edf2 18px 36px);
  display:flex;align-items:center;justify-content:center}
.map:before{content:"";position:absolute;left:0;right:0;top:46%;height:16px;background:#fff}
.ico{animation-duration:1.2s;animation-timing-function:ease-in-out;animation-iteration-count:infinite;
  filter:drop-shadow(0 2px 6px rgba(255,255,255,.95)) drop-shadow(0 0 2px rgba(255,255,255,.9))}
.ico.near{color:#0066FF;opacity:.92}
.ico.far{color:#20304a;opacity:.34}
.cap{margin-top:5px;color:#44506a;text-align:center}
h2{font-size:13px;color:#22304a;margin:18px 0 8px}
</style>
<h2>가까울 때(진하게 · 168px)</h2>
<div class="grid">${kinds.map((k) => cell(k, true)).join("")}</div>
<h2>멀 때(옅게 · 124px)</h2>
<div class="grid">${kinds.map((k) => cell(k, false)).join("")}</div>`;

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "buslink-navicon-"));
  const file = path.join(dir, "icons.html");
  fs.writeFileSync(file, html);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1240, height: 900 }, deviceScaleFactor: 2 });
  const errs = [];
  page.on("console", (msg) => { if (msg.type() === "error") errs.push(msg.text()); });
  await page.goto("file:///" + file.replace(/\\/g, "/"), { waitUntil: "load" });
  await page.waitForTimeout(400);

  // 실제로 그려졌나 — 빈 svg(경로 0개)면 화면엔 아무것도 없는데 통과할 수 있다
  const drawn = await page.evaluate(() =>
    [...document.querySelectorAll(".cell svg")].map((s) => ({
      paths: s.querySelectorAll("path,rect").length,
      w: Math.round(s.getBoundingClientRect().width),
    })));
  const empty = drawn.filter((d) => d.paths === 0).length;
  console.log(`도형 요소: 셀 ${drawn.length}개 · 빈 svg ${empty}개 · 렌더 폭 ${drawn[0] && drawn[0].w}px`);
  console.log(`콘솔 오류: ${errs.length}건`);

  const shot = path.join(dir, "nav-icons.png");
  await page.screenshot({ path: shot, fullPage: true });
  console.log(`캡처: ${shot}`);
  await browser.close();
  process.exit(empty === 0 && errs.length === 0 ? 0 : 1);
})().catch((e) => { console.error("🔴", e.message); process.exit(1); });
