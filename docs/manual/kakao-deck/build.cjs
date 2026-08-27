// 고객사 전달용 «통근셔틀 이용 안내서» 슬라이드 → PDF (16:9 · 1920×1080).
//
//   ① 화면 캡처(카카오 톤):
//      THEME=kakao node scripts/capture_passenger_screens.cjs docs/manual/kakao-deck/shots 채드윅
//      node scripts/capture_board_screen.cjs docs/manual/kakao-deck/shots/board.png kakao
//   ② PDF:
//      node docs/manual/kakao-deck/build.cjs
//
// 판형·색은 카카오모빌리티 통근셔틀 소개서를 따랐다(곤색 #1E233D · 옐로우 #FFCD00 ·
// CTA #4088FE — 그 PDF 를 렌더해 픽셀에서 읽은 값. 카카오 **공식** 옐로우 #FEE500 이 아니다).
// 🔴 카카오 로고·워드마크는 넣지 않는다 — 맞춘 것은 색과 형태지 상표가 아니다.
//    (2026-08-27 way 결정: "색만". 상표를 쓰려면 카카오 측 서면 승인이 선행되어야 한다.)
const path = require("path");
const fs = require("fs");
const http = require("http");
const { chromium } = require(path.join(__dirname, "..", "node_modules", "playwright-core"));

const DIR = __dirname;
const SHOTS = process.env.SHOTS || path.join(DIR, "shots");
const OUT = process.argv[2] || path.join(DIR, "..", "out", "버스링크_통근셔틀_이용안내서.pdf");

// 템플릿 자리 → 캡처 파일명.
const MAP = {
  login: "login.png", home: "home.png", routes: "routes.png",
  scan: "scan.png", board: "board.png", notices: "notices.png", settings: "settings.png",
  qrcard: "qrcard.png",
};

function dataUri(file) {
  if (!fs.existsSync(file)) throw new Error(`캡처 없음: ${file}\n→ 위 주석의 ① 을 먼저 돌릴 것`);
  return "data:image/png;base64," + fs.readFileSync(file).toString("base64");
}

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  let html = fs.readFileSync(path.join(DIR, "deck.tpl.html"), "utf8");
  const miss = [];
  html = html.replace(/\{\{([a-z_]+)\}\}/g, (m, k) => {
    if (!MAP[k]) { miss.push(k); return m; }
    return dataUri(path.join(SHOTS, MAP[k]));
  });
  if (miss.length) throw new Error("템플릿에 모르는 자리: " + miss.join(", "));

  const server = http.createServer((req, res) => {   // 구글 폰트 때문에 http 로 서빙(file:// 은 막힌다)
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(html);
  });
  await new Promise((r) => server.listen(0, r));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errs = []; page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  await page.goto(`http://localhost:${server.address().port}/`, { waitUntil: "networkidle", timeout: 60000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1500);

  // 신호 유무 — 슬라이드·이미지·폰트가 실제로 붙었는지 먼저 본다.
  const chk = await page.evaluate(() => ({
    slides: document.querySelectorAll(".slide").length,
    imgs: [...document.querySelectorAll("img")].filter((i) => i.naturalWidth > 0).length,
    imgsTotal: document.querySelectorAll("img").length,
    gothic: document.fonts.check("800 92px 'Gothic A1'"),
  }));
  console.log("점검:", JSON.stringify(chk));
  if (chk.imgs !== chk.imgsTotal) throw new Error(`이미지 로드 실패 ${chk.imgsTotal - chk.imgs}건`);
  if (!chk.gothic) console.warn("⚠ Gothic A1 미적용 — 기기 기본 고딕으로 떨어졌다(네트워크 확인)");

  // 🔴 넘침·겹침 검사 — `.slide` 가 `overflow:hidden` 이라 내용이 넘쳐도 **에러 없이 잘린 채**
  //    PDF 가 나온다(첫 빌드에서 팁 박스가 통째로 잘렸고, 두 번째엔 설명이 팁을 덮었다).
  //    아래끝만 재면 «덮는» 것은 안 잡히므로 cols↔tips 간격도 함께 본다.
  const bad = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll(".slide").forEach((s, i) => {
      const sr = s.getBoundingClientRect();
      const padB = parseFloat(getComputedStyle(s).paddingBottom);
      s.querySelectorAll("*").forEach((c) => {
        if (c.classList.contains("brand") || c.classList.contains("pageno")) return;
        const over = Math.round(c.getBoundingClientRect().bottom - (sr.bottom - padB));
        if (over > 1) out.push({ slide: i + 1, el: c.className || c.tagName, over });
      });
      const cols = s.querySelector(".cols"), tips = s.querySelector(".tips");
      if (cols && tips) {
        const gap = Math.round(tips.getBoundingClientRect().top - cols.getBoundingClientRect().bottom);
        if (gap < 0) out.push({ slide: i + 1, el: "cols↔tips 겹침", over: -gap });
      }
    });
    return out;
  });
  if (bad.length) { console.error("🔴 넘침/겹침:", JSON.stringify(bad)); throw new Error("내용이 잘린다 — 치수를 줄일 것"); }
  console.log("넘침·겹침 0");

  await page.pdf({ path: OUT, width: "1920px", height: "1080px", printBackground: true,
    margin: { top: "0", right: "0", bottom: "0", left: "0" } });
  console.log(`${OUT} · ${chk.slides}쪽 · 콘솔오류 ${errs.length}`);
  await browser.close(); server.close();
})().catch((e) => { console.error("실패:", e.message || e); process.exit(1); });
