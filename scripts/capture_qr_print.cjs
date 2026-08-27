// 차량 QR 인쇄물 카드 캡처 — 고객 안내서용. **네트워크·prod 접근 0 · 쓰기 0.**
//
//   node scripts/capture_qr_print.cjs <출력.png> [tone] [차량번호]
//   node scripts/capture_qr_print.cjs docs/manual/kakao-deck/shots/qrcard.png kakao "경기78바2032"
//
// 🔴 카드 마크업을 여기서 다시 그리지 않는다 — `src/lib/qrPrint.js` 를 **소스 그대로**
//    태운다. 안내서에만 예쁘게 그리면 고객이 받는 실물과 달라진다(그게 이 파일의 존재 이유).
// QR 은 실제 고정 QR 주소로 만든다(`/board?c=&v=`) — 그림용 가짜 코드가 아니다.
const path = require("path");
const fs = require("fs");
const vm = require("vm");
const ROOT = path.join(__dirname, "..");
const { chromium } = require(path.join(ROOT, "docs", "manual", "node_modules", "playwright-core"));
const QRCode = require(path.join(ROOT, "node_modules", "qrcode"));

const OUT = process.argv[2];
const TONE = process.argv[3] || "kakao";
const PLATE = process.argv[4] || "경기78바2032";
const COMPANY = "dy001";
const VEHICLE = "sample-vehicle";

if (!OUT) { console.error("사용법: node scripts/capture_qr_print.cjs <출력.png> [tone] [차량번호]"); process.exit(1); }

function loadQrPrint() {
  const src = fs.readFileSync(path.join(ROOT, "src/lib/qrPrint.js"), "utf8")
    .split("\n").filter((l) => !/^import\s/.test(l)).join("\n")
    .replace(/^export const /gm, "const ").replace(/^export function /gm, "function ");
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(src + "\n;this.__m = { buildQrPrintHtml, QR_TONES };", ctx);
  return ctx.__m;
}

(async () => {
  const { buildQrPrintHtml, QR_TONES } = loadQrPrint();
  if (!QR_TONES[TONE]) { console.error(`모르는 톤: ${TONE} — ${Object.keys(QR_TONES).join(", ")}`); process.exit(1); }

  const url = `https://p.buslink.co.kr/board?c=${COMPANY}&v=${VEHICLE}`;
  const img = await QRCode.toDataURL(url, { width: 320, margin: 1 });
  const html = buildQrPrintHtml({
    plate: PLATE, tone: TONE, img, url,
    title: "탑승 QR", sub: "차량에 부착 · 탑승 시 스캔",
    bandText: "통근 셔틀 · QR을 스캔해 탑승해주세요",
    autoPrint: false,          // 캡처라 인쇄 대화상자를 띄우지 않는다
  });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 600, height: 900 }, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: "networkidle" });
  const card = await page.$(".card");
  if (!card) throw new Error(".card 를 못 찾았다 — qrPrint.js 구조가 바뀌었는지 확인");

  // 신호 유무 — 카드가 실제로 칠해졌는지(투명·0크기면 캡처가 무의미).
  const chk = await page.evaluate(() => {
    const c = document.querySelector(".card"), t = document.querySelector(".tile img");
    const r = c.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height),
             bg: getComputedStyle(c).backgroundColor, qr: t ? t.naturalWidth : 0 };
  });
  if (chk.w < 100 || chk.h < 100 || !chk.qr) throw new Error("카드/QR 렌더 실패: " + JSON.stringify(chk));
  console.log(`카드 ${chk.w}×${chk.h} · 배경 ${chk.bg} · QR ${chk.qr}px`);

  await card.screenshot({ path: OUT });
  console.log(`${OUT} (tone=${TONE})`);
  await browser.close();
})().catch((e) => { console.error("실패:", e.message || e); process.exit(1); });
