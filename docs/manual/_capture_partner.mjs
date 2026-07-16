// 협력사 포탈(/partner) 매뉴얼 스크린샷 캡처 — 사용자 직접 실행용(prod 데이터 접근·업체코드 필요).
// 선행: ① node _serve_build.mjs (localhost:3000 — 카카오 키 등록 도메인이라 3000 고정)
//       ② 활성 업체코드 준비(관리자 콘솔 협력사 관리에서 복사)
// 실행: PARTNER_CODE=<업체코드> node _capture_partner.mjs   (PowerShell: $env:PARTNER_CODE="...")
// 캡처만 하고 어떤 발송/등록 버튼도 누르지 않음(write 0). 캡처 후 승객 실명 등 PII 마스킹 필수.
import { chromium } from "playwright-core";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "..", "manual-ppt", "assets", "partner");
const BASE = "http://localhost:3000";
const CODE = process.env.PARTNER_CODE;
const CHROME = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"].find(p => fs.existsSync(p));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

if (!CODE) { console.error("PARTNER_CODE env 필요 (활성 업체코드)"); process.exit(1); }

async function clickMainTab(page, label) {
  await page.locator("button", { hasText: label }).first().click({ timeout: 8000 });
  await sleep(2500);
}

(async () => {
  if (!CHROME) { console.error("시스템 Chrome 없음"); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, deviceScaleFactor: 2, locale: "ko-KR", timezoneId: "Asia/Seoul" });
  const page = await ctx.newPage();
  page.on("dialog", d => d.dismiss().catch(() => {}));

  await page.goto(`${BASE}/partner`, { waitUntil: "domcontentloaded" });
  await sleep(2500);
  await page.screenshot({ path: path.join(OUT, "code-login.png") }); // 업체코드 입력 화면(코드 미입력 상태)
  console.log("✓ code-login.png");

  // 업체코드 인증
  await page.locator("input").first().fill(CODE);
  await page.keyboard.press("Enter").catch(() => {});
  // 확인/인증 버튼 폴백
  const btn = page.locator('button:has-text("확인"), button:has-text("인증"), button:has-text("다음")');
  if (await btn.count()) await btn.first().click().catch(() => {});
  await sleep(3500);

  await page.screenshot({ path: path.join(OUT, "register.png") }); // 기본 탭 = 승객 등록
  console.log("✓ register.png");

  await clickMainTab(page, "승객 관리");
  await page.screenshot({ path: path.join(OUT, "manage.png") });
  console.log("✓ manage.png");

  await clickMainTab(page, "운영 포털");
  await sleep(4000); // 카카오맵 + onSnapshot 4종
  // 섹션별 element 캡처(긴 페이지 fullPage 금지)
  const secShot = async (headerText, file) => {
    try {
      // 섹션 헤더가 span(자사 노선 등) 또는 div(🚏 노선도) 둘 다 있음 — 직계 자식 매칭으로 카드 div 특정.
      const sec = page.locator(`div:has(> div:has-text("${headerText}")), div:has(> div > span:has-text("${headerText}"))`).last();
      await sec.scrollIntoViewIfNeeded();
      await sleep(1200);
      await sec.screenshot({ path: path.join(OUT, file) });
      console.log(`✓ ${file}`);
    } catch (e) { console.log(`⚠ ${file} 실패: ${e.message.split("\n")[0]}`); }
  };
  await secShot("🛣 자사 노선", "ops-routes.png");
  await secShot("📍 실시간 버스 위치", "ops-map.png");
  await secShot("🚏 차량 운행 현황", "ops-strip.png");
  await secShot("🎫 오늘 탑승 현황", "ops-boarding.png");
  await secShot("📢 공지 발송", "ops-notice-send.png");

  await clickMainTab(page, "탑승 통계");
  await page.screenshot({ path: path.join(OUT, "stats.png") });
  console.log("✓ stats.png");

  await browser.close();
  console.log("완료 →", OUT, "\n⚠ 캡처본에 승객 실명·사번·업체코드가 보이면 마스킹 후 매뉴얼 반영");
})().catch(e => { console.error("오류:", e.message); process.exit(1); });
