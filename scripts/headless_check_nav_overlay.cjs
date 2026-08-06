// 대형 회전 픽토그램이 **실제 지도 위에서** 크게·잘 보이는지 (2026-08-06 way "화살표 자체는 크게 잘 보이는건가?")
//   node scripts/headless_check_nav_overlay.cjs
//
// 기사앱은 로그인이 필요해 그 화면을 통째로 헤드리스로 못 띄운다. 그래서
//   ① 진짜 카카오 지도를 **승객앱(prod)에서 실제로 렌더**해 배경으로 쓰고
//   ② 그 위에 픽토그램을 **DriverApp 소스에서 뽑은 값 그대로**(크기·위치·투명도·그림자·색) 얹는다.
// 🔴 손으로 옮겨 적은 숫자로 그리면 "예쁜 그림"만 보고 통과한다 — 값은 전부 소스에서 파싱한다.
// ⚠ 배너·정류장 칩 등 나머지 오버레이는 재현하지 않는다(그건 이 확인의 대상이 아니다).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ROOT = path.join(__dirname, "..");
const W = 390, H = 844;

const drv = fs.readFileSync(path.join(ROOT, "src/pages/DriverApp.js"), "utf8");
const ico = fs.readFileSync(path.join(ROOT, "src/components/NavTurnIcon.js"), "utf8");

// ── DriverApp 에서 대형 픽토그램 값 파싱 ──────────────────────
const block = (drv.match(/\{turnIcon && \([\s\S]*?\n {8}\)\}/) || [])[0];
if (!block) { console.error("🔴 대형 픽토그램 블록을 못 찾음"); process.exit(1); }
const pick = (re, label) => {
  const m = block.match(re);
  if (!m) { console.error(`🔴 ${label} 파싱 실패`); process.exit(1); }
  return m;
};
const topPct = pick(/top: "(\d+)%"/, "top")[1];
const sizes = pick(/size=\{turnNear \? (\d+) : (\d+)\}/, "size");
const ops = pick(/opacity: turnNear \? ([\d.]+) : ([\d.]+)/, "opacity");
const colors = pick(/color: turnNear \? "([^"]+)" : "([^"]+)"/, "color");
const filter = pick(/filter: "([^"]+)"/, "filter")[1];
console.log(`\n소스에서 읽은 값 — top ${topPct}% · 크기 ${sizes[1]}/${sizes[2]}px · 투명도 ${ops[1]}/${ops[2]} · 색 ${colors[1]}/${colors[2]}`);

// 픽토그램 도형(부품 치환은 아이콘 하네스와 동일 규칙)
const PARTS = {};
for (const m of ico.matchAll(/const ([A-Z][A-Z_]*) = \(?\s*(<(?:rect|path)[\s\S]*?\/>)\s*\)?;/g)) PARTS[m[1]] = m[2];
const body = ico.slice(ico.indexOf("const SHAPES = {"), ico.indexOf("\n};", ico.indexOf("const SHAPES = {")));
const shapeOf = (kind) => {
  const m = new RegExp(`\\n {2}"?${kind}"?:\\s*\\(([\\s\\S]*?)\\n {2}\\),`).exec(body + "\n  x: (\n  ),");
  if (!m) { console.error(`🔴 ${kind} 도형 없음`); process.exit(1); }
  let s = m[1];
  for (const [n, j] of Object.entries(PARTS)) s = s.split(`{${n}}`).join(j);
  if (/\{[^}]+\}/.test(s)) { console.error(`🔴 ${kind} 치환 안 된 참조`); process.exit(1); }
  return s.replace(/<>|<\/>/g, "").replace(/strokeWidth=/g, "stroke-width=")
    .replace(/strokeLinecap=/g, "stroke-linecap=").replace(/strokeLinejoin=/g, "stroke-linejoin=");
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "buslink-navovl-"));
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });

  // ① 진짜 지도 — 승객앱(prod)에서 카카오 타일을 실제로 렌더해 배경으로 쓴다.
  //    🔴 `/bus` 는 **노선 선택 화면**으로 먼저 뜬다 — 그대로 찍으면 배경이 목록이라
  //       "지도 위에서 잘 보이나"를 하나도 검증하지 못한다(2026-08-06 실제로 한 번 그렇게 찍혔다).
  const mp = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
  await mp.goto("https://p.buslink.co.kr/bus?c=dy001", { waitUntil: "domcontentloaded", timeout: 60000 });
  await mp.waitForTimeout(6000);
  const card = mp.locator("text=과천라인").first();
  if (await card.count()) { await card.click().catch(() => {}); }
  else { const any = mp.locator("text=출근").first(); if (await any.count()) await any.click().catch(() => {}); }
  await mp.waitForTimeout(9000);
  // 🔴 카카오 타일이 실제로 깔렸는지 확인 — 안 깔렸으면 이 확인은 의미가 없으므로 **실패**시킨다
  const tiles = await mp.evaluate(() =>
    document.querySelectorAll("img[src*='daumcdn'], img[src*='kakaocdn']").length);
  const mapShot = path.join(dir, "map.png");
  await mp.screenshot({ path: mapShot });
  await mp.close();
  if (tiles < 3) {
    console.error(`🔴 지도 타일 ${tiles}개 — 배경이 지도가 아니다(노선 선택 화면일 가능성). 캡처: ${mapShot}`);
    await browser.close(); process.exit(1);
  }
  console.log(`지도 배경 캡처 완료 — 카카오 타일 ${tiles}개`);
  const bg = "data:image/png;base64," + fs.readFileSync(mapShot).toString("base64");

  // ② 그 위에 픽토그램만 소스 값 그대로
  const cell = (kind, near) => `
  <div class="ph">
    <img class="bg" src="${bg}">
    <div class="wrap" style="top:${topPct}%">
      <div class="ic" style="color:${near ? colors[1] : colors[2]};opacity:${near ? ops[1] : ops[2]};filter:${filter}">
        <svg width="${near ? sizes[1] : sizes[2]}" height="${near ? sizes[1] : sizes[2]}" viewBox="0 0 64 64">${shapeOf(kind)}</svg>
      </div>
    </div>
    <div class="cap">${kind} · ${near ? `가까울 때 ${sizes[1]}px` : `멀 때 ${sizes[2]}px`}</div>
  </div>`;

  // 🔴 색이 `var(--color-primary)` 라 tokens.css 를 안 넣으면 브랜드색이 안 풀려 회색으로 그려진다
  //    (앱에서는 파란색인데 확인 화면만 회색 → "잘 안 보인다"는 엉뚱한 결론이 난다).
  const tokens = fs.readFileSync(path.join(ROOT, "src/styles/tokens.css"), "utf8");
  const html = `<!doctype html><meta charset="utf-8"><style>
  ${tokens}
  body{margin:0;background:#20242c;padding:14px;display:flex;gap:14px;font:700 12px sans-serif;color:#dfe4ee}
  .ph{width:${W}px}
  .ph>.bg{width:${W}px;height:${H}px;display:block;border-radius:12px}
  .ph{position:relative}
  .wrap{position:absolute;left:0;right:0;display:flex;justify-content:center;pointer-events:none}
  .cap{margin-top:6px;text-align:center}
  </style>
  ${cell("left", true)}${cell("left", false)}${cell("underpass-side", true)}`;

  const file = path.join(dir, "overlay.html");
  fs.writeFileSync(file, html);
  const p2 = await browser.newPage({ viewport: { width: W * 3 + 80, height: H + 70 }, deviceScaleFactor: 2 });
  await p2.goto("file:///" + file.replace(/\\/g, "/"), { waitUntil: "load" });
  await p2.waitForTimeout(500);

  // ③ 숫자로도 재 둔다 — "크다"는 느낌이 아니라 화면 대비 비율
  const near = Number(sizes[1]), far = Number(sizes[2]);
  console.log(`\n화면 390px 기준`);
  console.log(`  가까울 때 ${near}px = 화면 폭의 ${Math.round((near / W) * 100)}%  (배너 글자 21px 의 ${(near / 21).toFixed(1)}배)`);
  console.log(`  멀 때     ${far}px = 화면 폭의 ${Math.round((far / W) * 100)}%`);
  console.log(`  세로 위치 top ${topPct}% — 위쪽 배너/칩(상단 스택)과 아래 버튼줄 사이`);

  // 🔴 색이 실제로 풀렸는지 픽셀 계산값으로 확인 — 안 풀리면 검정으로 그려져
  //    "앱에선 파란데 확인 화면만 회색" 이라는 거짓 결론이 난다.
  const resolved = await p2.evaluate(() => getComputedStyle(document.querySelector(".ic")).color);
  console.log(`아이콘 색 계산값: ${resolved}`);
  if (/rgb\(0,\s*0,\s*0\)/.test(resolved)) {
    console.error("🔴 색이 안 풀렸다(tokens.css 미적용)");
    await browser.close(); process.exit(1);
  }

  const shot = path.join(dir, "nav-overlay.png");
  await p2.screenshot({ path: shot });
  console.log(`\n캡처: ${shot}`);
  await browser.close();
})().catch((e) => { console.error("🔴", e.message); process.exit(1); });
