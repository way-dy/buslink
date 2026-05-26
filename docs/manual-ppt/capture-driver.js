// 기사앱 화면 자동 캡처 (buslink DriverApp `/driver`, 모바일 viewport)
// 사용자는 사번 + PIN 입력·로그인 1회 + Enter
// 실행: node capture-driver.js
const { chromium, devices } = require("playwright");
const readline = require("readline");
const fs = require("fs");
const path = require("path");

const BASE_URL = process.env.BASE_URL || "https://buslink-prod.web.app";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const outDir = path.join(__dirname, "assets", "driver");
  fs.mkdirSync(outDir, { recursive: true });

  console.log("\n=== Buslink 기사앱 화면 자동 캡처 (모바일 — iPhone 14) ===");
  console.log(`접속 URL: ${BASE_URL}/driver`);
  console.log("브라우저가 모바일 크기로 뜨면 사번+PIN 입력 후 로그인.");
  console.log("홈 화면이 보이면 콘솔로 돌아와 Enter — 나머지는 자동 캡처.\n");

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
    // 1. 로그인 화면
    await page.goto(`${BASE_URL}/driver`, { waitUntil: "domcontentloaded" });
    await sleep(2000);
    await page.screenshot({ path: path.join(outDir, "01-login.png"), fullPage: false });
    console.log("✅ 01-login.png (로그인 화면)");

    console.log("\n📱 사번 + PIN으로 로그인하세요.");
    console.log("   홈 화면(배차 선택 or 오늘 배차 카드)이 보이면 콘솔에서 Enter.");
    await ask("   로그인 완료 후 Enter > ");

    await sleep(1500);

    // 2. 홈 화면 (운행 시작 전)
    await page.screenshot({ path: path.join(outDir, "02-home.png"), fullPage: false });
    console.log("✅ 02-home.png (홈 화면)");

    // 3. 운행 중 — 조건부 (운행 시작 안 했으면 placeholder 유지)
    try {
      // 운행 시작 상태인지 확인 — '운행 종료' 버튼만 (정류장 리스트는 운행 전에도 표시됨)
      const driving = await page.evaluate(() => {
        const text = document.body.innerText || "";
        return text.includes("운행 종료");
      });
      if (driving) {
        await page.screenshot({ path: path.join(outDir, "03-driving.png"), fullPage: false });
        console.log("✅ 03-driving.png (운행 중)");
      } else {
        console.log("⚠ 운행 시작 안 됨 — 03-driving placeholder 유지");
      }
    } catch (e) {
      console.log("⚠ 03-driving skip:", e.message);
    }

    // 4. 탑승 QR 탭 — 운행 중일 때만
    try {
      const qrTabClicked = await page.evaluate(() => {
        // '탑승 QR' 텍스트 버튼 찾기
        const btns = Array.from(document.querySelectorAll("button"));
        const qrBtn = btns.find(b => (b.innerText || "").includes("탑승 QR"));
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
    } catch (e) {
      console.log("⚠ 04-qr skip:", e.message);
    }

    console.log("\n=== 모든 캡처 완료 ===");
    console.log(`저장 위치: ${outDir}`);
    console.log("운행 시간대 외라면 03·04는 placeholder. 운행 중 재실행 권장.");
    console.log("3초 후 브라우저 닫힘.");
    await sleep(3000);
  } catch (err) {
    console.error("\n❌ 오류:", err.message);
  } finally {
    await browser.close();
    rl.close();
  }
})();
