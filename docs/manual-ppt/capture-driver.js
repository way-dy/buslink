// 기사앱 화면 자동 캡처 (buslink DriverApp `/driver`, 모바일 viewport)
// 로그인은 사용자가 뜬 창에서 직접 — 로그인 완료를 DOM으로 자동 감지(Enter 불필요).
// 실행: node capture-driver.js
const { chromium, devices } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE_URL = process.env.BASE_URL || "https://buslink-prod.web.app";
const LOGIN_TIMEOUT = Number(process.env.LOGIN_TIMEOUT || 360000); // 6분

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 로그인 완료 = 로그인 입력(input) 사라지고 기사 홈 UI(운행/배차) 등장
async function waitForLogin(page) {
  console.log("\n⏳ 로그인 대기 중 — 뜬 창에서 사번+PIN으로 로그인하세요 (최대 6분).");
  await page.waitForFunction(
    () => {
      const t = document.body.innerText || "";
      const noInputs = document.querySelectorAll("input").length === 0;
      const driverHome = t.includes("운행 시작") || t.includes("운행 종료") || t.includes("오늘 배차") || t.includes("배차가 없");
      return driverHome || (noInputs && t.includes("운행"));
    },
    null,
    { timeout: LOGIN_TIMEOUT, polling: 1000 }
  );
  console.log("✅ 로그인 감지 — 캡처 시작\n");
}

(async () => {
  const outDir = path.join(__dirname, "assets", "driver");
  fs.mkdirSync(outDir, { recursive: true });

  console.log("\n=== Buslink 기사앱 화면 자동 캡처 (모바일 — iPhone 14) ===");
  console.log(`접속 URL: ${BASE_URL}/driver`);

  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({
    ...devices["iPhone 14"],
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    geolocation: { latitude: 37.5665, longitude: 126.9780 },
    permissions: ["geolocation"],
  });
  const page = await ctx.newPage();

  try {
    await page.goto(`${BASE_URL}/driver`, { waitUntil: "domcontentloaded" });
    await sleep(2000);
    await page.screenshot({ path: path.join(outDir, "01-login.png"), fullPage: false });
    console.log("✅ 01-login.png (로그인 화면)");

    await waitForLogin(page);
    await sleep(1500);

    await page.screenshot({ path: path.join(outDir, "02-home.png"), fullPage: false });
    console.log("✅ 02-home.png (홈 화면)");

    // 운행 중일 때만 — placeholder 유지 가능
    try {
      const driving = await page.evaluate(() => (document.body.innerText || "").includes("운행 종료"));
      if (driving) {
        await page.screenshot({ path: path.join(outDir, "03-driving.png"), fullPage: false });
        console.log("✅ 03-driving.png (운행 중)");
      } else {
        console.log("⚠ 운행 시작 안 됨 — 03-driving placeholder 유지");
      }
    } catch (e) { console.log("⚠ 03-driving skip:", e.message); }

    try {
      const qrTabClicked = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const qrBtn = btns.find((b) => (b.innerText || "").includes("탑승 QR"));
        if (qrBtn) { qrBtn.click(); return true; }
        return false;
      });
      if (qrTabClicked) {
        await sleep(1200);
        await page.screenshot({ path: path.join(outDir, "04-qr.png"), fullPage: false });
        console.log("✅ 04-qr.png (탑승 QR)");
      } else {
        console.log("⚠ 탑승 QR 탭 못 찾음 (운행 미시작) — 04-qr placeholder 유지");
      }
    } catch (e) { console.log("⚠ 04-qr skip:", e.message); }

    console.log("\n=== 모든 캡처 완료 ===");
    console.log(`저장 위치: ${outDir}`);
    console.log("운행 시간대 외라면 03·04는 placeholder. 운행 중 재실행 권장.");
    await sleep(2000);
  } catch (err) {
    console.error("\n❌ 오류:", err.message);
  } finally {
    await browser.close();
  }
})();
