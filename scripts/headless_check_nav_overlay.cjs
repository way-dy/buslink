// 회전 지점 패널이 **실제 지도 위에서** 어떻게 보이는지 (2026-08-07 way 실주행 지적 반영판).
//   node scripts/headless_check_nav_overlay.cjs
//
// 기사앱은 로그인이 필요해 그 화면을 통째로 헤드리스로 못 띄운다. 그래서
//   ① 진짜 카카오 지도를 **승객앱(prod)에서 실제로 렌더**해 배경으로 쓰고
//   ② 그 위에 패널을 **DriverApp 소스에서 뽑은 값 그대로**(크기·색·고리) 얹는다.
// 🔴 손으로 옮겨 적은 숫자로 그리면 "예쁜 그림"만 보고 통과한다 — 값은 전부 소스에서 파싱한다.
// ⚠ 실제 위치는 **회전 지점 좌표**다(CustomOverlayMap). 여기서는 **패널 디자인**만 본다.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ROOT = path.join(__dirname, "..");
const W = 390, H = 844;

const drv = fs.readFileSync(path.join(ROOT, "src/pages/DriverApp.js"), "utf8");
const ico = fs.readFileSync(path.join(ROOT, "src/components/NavTurnIcon.js"), "utf8");

// ── DriverApp 에서 회전 지점 패널 값 파싱 ──────────────────
const bStart = drv.indexOf("{turn && turnIcon && Number.isFinite");
const bEnd = drv.indexOf("</CustomOverlayMap>", bStart);
if (bStart < 0 || bEnd < 0) { console.error("🔴 회전 지점 패널 블록을 못 찾음(설계가 바뀌었나?)"); process.exit(1); }
const block = drv.slice(bStart, bEnd);
const pick = (re, label) => {
  const m = block.match(re);
  if (!m) { console.error("🔴 " + label + " 파싱 실패"); process.exit(1); }
  return m;
};
const iconSize = pick(/size=\{(\d+)\} title=\{turn\.label\}/, "아이콘 크기")[1];
const bgs = pick(/background: turnNear \? "([^"]+)" : "([^"]+)"/, "배경색");
const distSize = pick(/fontSize: (\d+), fontWeight: 900, letterSpacing/, "거리 글자")[1];
const hasRing = /animation: "navturnring/.test(block);
const ringSize = (block.match(/width: (\d+), height: \d+,\s*\n\s*marginLeft/) || [])[1] || "92";
console.log("\n소스에서 읽은 값 — 아이콘 " + iconSize + "px · 거리 글자 " + distSize +
  "px · 배경 " + bgs[1] + " / " + bgs[2] + " · 펄스 고리 " + (hasRing ? ringSize + "px" : "없음"));
if (!hasRing) { console.error("🔴 펄스 고리가 사라졌다"); process.exit(1); }

// ── 픽토그램 도형(부품 치환은 아이콘 하네스와 동일 규칙) ──
const PARTS = {};
for (const m of ico.matchAll(/const ([A-Z][A-Z_]*) = \(?\s*(<(?:rect|path)[\s\S]*?\/>)\s*\)?;/g)) PARTS[m[1]] = m[2];
const body = ico.slice(ico.indexOf("const SHAPES = {"), ico.indexOf("\n};", ico.indexOf("const SHAPES = {")));
const shapeOf = (kind) => {
  const m = new RegExp("\\n {2}\"?" + kind + "\"?:\\s*\\(([\\s\\S]*?)\\n {2}\\),").exec(body + "\n  x: (\n  ),");
  if (!m) { console.error("🔴 " + kind + " 도형 없음"); process.exit(1); }
  let s = m[1];
  for (const [n, j] of Object.entries(PARTS)) s = s.split("{" + n + "}").join(j);
  if (/\{[^}]+\}/.test(s)) { console.error("🔴 " + kind + " 치환 안 된 참조"); process.exit(1); }
  return s.replace(/<>|<\/>/g, "").replace(/strokeWidth=/g, "stroke-width=")
    .replace(/strokeLinecap=/g, "stroke-linecap=").replace(/strokeLinejoin=/g, "stroke-linejoin=");
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "buslink-navovl-"));
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });

  // ① 진짜 지도 — 🔴 `/bus` 는 노선 선택 화면으로 먼저 뜬다. 그대로 찍으면 배경이 목록이라
  //    "지도 위에서 어떻게 보이나"를 하나도 검증하지 못한다(2026-08-06 실제로 그렇게 찍혔다).
  const mp = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
  await mp.goto("https://p.buslink.co.kr/bus?c=dy001", { waitUntil: "domcontentloaded", timeout: 60000 });
  await mp.waitForTimeout(6000);
  const card = mp.locator("text=과천라인").first();
  if (await card.count()) await card.click().catch(() => {});
  await mp.waitForTimeout(9000);
  const tiles = await mp.evaluate(() =>
    document.querySelectorAll("img[src*='daumcdn'], img[src*='kakaocdn']").length);
  const mapShot = path.join(dir, "map.png");
  await mp.screenshot({ path: mapShot });
  await mp.close();
  if (tiles < 3) {
    console.error("🔴 지도 타일 " + tiles + "개 — 배경이 지도가 아니다. 캡처: " + mapShot);
    await browser.close(); process.exit(1);
  }
  console.log("지도 배경 캡처 완료 — 카카오 타일 " + tiles + "개");
  const bg = "data:image/png;base64," + fs.readFileSync(mapShot).toString("base64");

  const panel = (kind, near, dist, roadName) => `
    <div class="marker ${near ? "near" : "far"}">
      ${near && hasRing ? '<span class="ring"></span>' : ""}
      <div class="panel">
        <svg width="${iconSize}" height="${iconSize}" viewBox="0 0 64 64">${shapeOf(kind)}</svg>
        <div class="txt"><span class="dist">${dist}</span><span class="road">${roadName}</span></div>
      </div>
      <span class="tail"></span>
    </div>`;

  const cell = (kind, near, dist, roadName, cap) => `
  <div class="ph">
    <img class="bg" src="${bg}">
    <div class="spot">${panel(kind, near, dist, roadName)}</div>
    <div class="cap">${cap}</div>
  </div>`;

  const tokens = fs.readFileSync(path.join(ROOT, "src/styles/tokens.css"), "utf8");
  const html = `<!doctype html><meta charset="utf-8"><style>
  ${tokens}
  body{margin:0;background:#20242c;padding:14px;display:flex;gap:14px;font:700 12px sans-serif;color:#dfe4ee}
  .ph{width:${W}px;position:relative}
  .ph>.bg{width:${W}px;height:${H}px;display:block;border-radius:12px}
  .spot{position:absolute;left:50%;top:46%;transform:translateX(-50%)}
  .marker{position:relative}
  .ring{position:absolute;left:50%;top:50%;width:${ringSize}px;height:${ringSize}px;
    margin-left:-${ringSize / 2}px;margin-top:-${ringSize / 2}px;border-radius:50%;
    border:2px solid var(--color-primary);animation:navturnring 2s ease-out infinite}
  .panel{position:relative;display:flex;align-items:center;gap:8px;padding:7px 11px 7px 8px;
    border-radius:13px;color:#fff;white-space:nowrap;
    box-shadow:0 3px 12px rgba(0,0,0,.32),0 0 0 2px rgba(255,255,255,.9)}
  .near .panel{background:${bgs[1]}}
  .far .panel{background:${bgs[2]}}
  .txt{display:flex;flex-direction:column;line-height:1.1}
  .dist{font-size:${distSize}px;font-weight:900;letter-spacing:-0.02em}
  .road{font-size:10px;font-weight:700;opacity:.8}
  .tail{position:absolute;left:50%;bottom:-6px;margin-left:-6px;width:0;height:0;
    border-left:6px solid transparent;border-right:6px solid transparent}
  .near .tail{border-top:7px solid ${bgs[1]}}
  .far .tail{border-top:7px solid ${bgs[2]}}
  .cap{position:absolute;left:0;right:0;bottom:-24px;text-align:center}
  </style>
  ${cell("underpass-side", true, "364m", "선암지하차도", "지하차도 옆길 · 접근(200m 이내)")}
  ${cell("left", false, "1.8km", "양재대로", "좌회전 · 아직 멂")}
  ${cell("overpass-enter", true, "210m", "사당IC", "고가도로 진입 · 접근")}`;

  const file = path.join(dir, "overlay.html");
  fs.writeFileSync(file, html);
  const p2 = await browser.newPage({ viewport: { width: W * 3 + 80, height: H + 90 }, deviceScaleFactor: 2 });
  await p2.goto("file:///" + file.replace(/\\/g, "/"), { waitUntil: "load" });
  await p2.waitForTimeout(600);

  // 🔴 색이 실제로 풀렸는지 · 패널이 실제로 그려졌는지 픽셀로 확인
  const info = await p2.evaluate(() => {
    const p = document.querySelector(".near .panel");
    const r = p.getBoundingClientRect();
    return { bg: getComputedStyle(p).backgroundColor, w: Math.round(r.width), h: Math.round(r.height),
      paths: document.querySelectorAll(".panel svg path, .panel svg rect").length };
  });
  console.log("패널 실측 — " + info.w + "×" + info.h + "px · 배경 " + info.bg + " · 도형 요소 " + info.paths + "개");
  if (/rgb\(0,\s*0,\s*0\)/.test(info.bg)) { console.error("🔴 색이 안 풀렸다(tokens.css 미적용)"); await browser.close(); process.exit(1); }
  if (info.paths < 6) { console.error("🔴 픽토그램이 안 그려졌다"); await browser.close(); process.exit(1); }
  console.log("화면 폭 " + W + "px 대비 패널 폭 " + Math.round((info.w / W) * 100) + "%");

  const shot = path.join(dir, "nav-overlay.png");
  await p2.screenshot({ path: shot });
  console.log("\n캡처: " + shot);
  await browser.close();
})().catch((e) => { console.error("🔴", e.message); process.exit(1); });
