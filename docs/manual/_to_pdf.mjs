// BusLink 사용 매뉴얼 MD → A4 PDF 변환 (모노디자인)
// - marked 로 MD→HTML, 모노 템플릿(무채색 + 단일 포인트색 #0066FF) 적용
// - 시스템 Chrome(playwright-core)으로 A4 세로 PDF 렌더 (브라우저 다운로드 회피)
// 실행: node _to_pdf.mjs   (먼저: npm install)
import { marked } from "marked";
import { chromium } from "playwright-core";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.resolve(__dirname, "..", "manual-ppt", "assets"); // 기존 캡처 재사용
const OUT_DIR = path.join(__dirname, "out");

// 시스템 Chrome 경로 (Windows 표준 설치 위치)
const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];
const CHROME = CHROME_CANDIDATES.find((p) => fs.existsSync(p));

const ACCENT = "#0066FF";

// 변환 대상: [MD 파일, 출력 PDF, 표지 제목, 부제]
const DOCS = [
  ["ADMIN_GUIDE.md", "BusLink_관리자매뉴얼.pdf", "BusLink 관리자 매뉴얼", "동영관광 통근버스 관제 시스템 · 관리자용"],
  ["DRIVER_GUIDE.md", "BusLink_기사매뉴얼.pdf", "BusLink 기사 매뉴얼", "동영관광 통근버스 관제 시스템 · 기사용"],
  ["EMPLOYEE_GUIDE.md", "BusLink_직원매뉴얼.pdf", "BusLink 직원(승객) 매뉴얼", "동영관광 통근버스 관제 시스템 · 직원용"],
  // 2026-07-16 회의 #6 — 협력사 포탈·승객앱 요약본(최소 분량, 반출 고려)
  ["PARTNER_GUIDE.md", "BusLink_협력사포탈가이드.pdf", "협력사 포탈 요약 가이드", "동영관광 통근버스 관제 시스템 · 협력사 담당자용"],
  ["PASSENGER_QUICK.md", "BusLink_승객앱가이드.pdf", "승객 앱 요약 가이드", "동영관광 통근버스 관제 시스템 · 승객용"],
];

// 이미지 src(assets/...) → base64 data URI 로 인라인 (이미지가 PDF 에 박히도록).
// ※ file:// URL 은 page.setContent() 컨텍스트(about:blank)에서 로드가 차단되므로 data URI 필수.
export function rewriteImgSrc(html) {
  return html.replace(/src="assets\/([^"]+)"/g, (_m, rel) => {
    const abs = path.join(ASSETS_DIR, rel.split("/").join(path.sep));
    if (!fs.existsSync(abs)) { console.log(`  ⚠ 이미지 없음: ${rel}`); return `src=""`; }
    const ext = path.extname(abs).slice(1).toLowerCase();
    const mime = ext === "jpg" ? "jpeg" : ext;
    const b64 = fs.readFileSync(abs).toString("base64");
    return `src="data:image/${mime};base64,${b64}"`;
  });
}

export function htmlTemplate(title, subtitle, bodyHtml) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<style>
  @page { size: A4 portrait; margin: 18mm 16mm; }
  :root { --accent: ${ACCENT}; --ink: #1a1a1a; --mute: #666; --line: #d9d9d9; --soft: #f4f5f7; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Pretendard", "Pretendard Variable", "맑은 고딕", "Malgun Gothic", -apple-system, sans-serif;
    color: var(--ink); font-size: 11.5pt; line-height: 1.75; -webkit-font-smoothing: antialiased;
  }
  /* 표지 */
  .cover { height: 247mm; display: flex; flex-direction: column; justify-content: center;
    page-break-after: always; }
  .cover .brand { font-size: 15pt; font-weight: 800; letter-spacing: -0.5px; color: var(--accent); margin-bottom: 6mm; }
  .cover h1 { font-size: 30pt; font-weight: 800; letter-spacing: -1px; margin: 0 0 5mm; line-height: 1.25; }
  .cover .sub { font-size: 12.5pt; color: var(--mute); margin: 0; }
  .cover .rule { width: 40mm; height: 4px; background: var(--accent); margin: 9mm 0; border-radius: 2px; }
  .cover .foot { margin-top: auto; font-size: 9.5pt; color: var(--mute); }
  /* 본문 */
  h1 { font-size: 19pt; font-weight: 800; letter-spacing: -0.5px; margin: 0 0 5mm;
    padding-bottom: 3mm; border-bottom: 2.5px solid var(--accent); page-break-after: avoid; }
  h2 { font-size: 14.5pt; font-weight: 700; margin: 9mm 0 3mm; padding-left: 3mm;
    border-left: 4px solid var(--accent); page-break-after: avoid; }
  h3 { font-size: 12pt; font-weight: 700; margin: 6mm 0 2mm; color: #2a2a2a; page-break-after: avoid; }
  p { margin: 0 0 2.5mm; }
  ul, ol { margin: 0 0 3mm; padding-left: 6mm; }
  li { margin: 0 0 1.5mm; }
  strong { font-weight: 700; }
  a { color: var(--accent); text-decoration: none; }
  code { font-family: "Consolas", "맑은 고딕", monospace; background: var(--soft);
    padding: 0.5mm 1.5mm; border-radius: 3px; font-size: 10pt; color: #333; }
  /* 화면 라벨 강조 — 회색 칩 (다색 금지) */
  /* 이미지 (스크린샷) */
  img { max-width: 84%; display: block; margin: 4mm auto 5mm; border: 1px solid var(--line);
    border-radius: 6px; page-break-inside: avoid; }
  img.wide { max-width: 100%; }
  /* 인용 = 주의/팁 박스: 회색 + 좌측 굵은 테두리 (빨강/노랑 금지) */
  blockquote { margin: 4mm 0; padding: 3mm 4mm; background: var(--soft);
    border-left: 4px solid #888; border-radius: 0 6px 6px 0; color: #333; page-break-inside: avoid; }
  blockquote p { margin: 0; }
  blockquote strong { color: var(--ink); }
  /* placeholder 박스 (운영 중 캡처 필요) */
  .ph { border: 1.5px dashed var(--line); border-radius: 8px; padding: 10mm 6mm;
    text-align: center; color: var(--mute); margin: 4mm auto 5mm; max-width: 84%;
    background: repeating-linear-gradient(45deg, #fafafa, #fafafa 8px, #f2f2f2 8px, #f2f2f2 16px);
    page-break-inside: avoid; font-size: 10pt; }
  .ph b { color: #444; display: block; margin-bottom: 1.5mm; }
  hr { border: none; border-top: 1px solid var(--line); margin: 7mm 0; }
  table { border-collapse: collapse; width: 100%; margin: 3mm 0 5mm; font-size: 10.5pt; }
  th, td { border: 1px solid var(--line); padding: 2mm 3mm; text-align: left; vertical-align: top; }
  th { background: var(--soft); font-weight: 700; }
  /* 번호 단계 — ol 기본 + 강조 */
  .step-num { color: var(--accent); font-weight: 800; }
</style></head>
<body>
  <section class="cover">
    <div class="brand">BusLink</div>
    <h1>${title}</h1>
    <div class="rule"></div>
    <p class="sub">${subtitle}</p>
    <div class="foot">동영관광 · ${new Date().getFullYear()}년판 사용 안내서</div>
  </section>
  ${bodyHtml}
</body></html>`;
}

async function build() {
  if (!CHROME) {
    console.error("✗ 시스템 Chrome 을 찾지 못했습니다. 경로 확인 필요:", CHROME_CANDIDATES);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ deviceScaleFactor: 2, locale: "ko-KR" });

  for (const [mdFile, pdfName, title, subtitle] of DOCS) {
    const mdPath = path.join(__dirname, mdFile);
    if (!fs.existsSync(mdPath)) { console.log(`⚠ 건너뜀(없음): ${mdFile}`); continue; }
    const md = fs.readFileSync(mdPath, "utf8");
    let body = marked.parse(md);
    body = rewriteImgSrc(body);
    const html = htmlTemplate(title, subtitle, body);

    const page = await ctx.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    await page.waitForTimeout(400); // 폰트/이미지 안정화
    const outPath = path.join(OUT_DIR, pdfName);
    await page.pdf({ path: outPath, format: "A4", printBackground: true });
    await page.close();
    const kb = (fs.statSync(outPath).size / 1024).toFixed(0);
    console.log(`✓ ${pdfName}  (${kb} KB)`);
  }
  await browser.close();
  console.log("완료 →", OUT_DIR);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build().catch((e) => { console.error(e); process.exit(1); });
}
