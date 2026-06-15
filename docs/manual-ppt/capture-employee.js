// 승객(직원)앱 화면 자동 캡처 (buslink EmployeeApp `/p`, 모바일 viewport)
// 로그인은 사용자가 뜬 창에서 직접 — 로그인 완료를 DOM(탭바)으로 자동 감지(Enter 불필요).
// 실행: node capture-employee.js
const { chromium, devices } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE_URL = process.env.BASE_URL || "https://buslink-prod.web.app";
const LOGIN_TIMEOUT = Number(process.env.LOGIN_TIMEOUT || 360000); // 6분

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitKakao(page, timeoutMs = 8000) {
  try {
    await page.waitForFunction(
      () => window.kakao && window.kakao.maps && window.kakao.maps.LatLng,
      null,
      { timeout: timeoutMs }
    );
    await sleep(1200);
  } catch (e) {
    console.log("⚠ Kakao Maps 로드 타임아웃");
  }
}

// 로그인 완료 = 하단 탭바(홈/노선/공지/탑승/설정) 라벨 3개 이상 등장
async function waitForLogin(page) {
  console.log("\n⏳ 로그인 대기 중 — 뜬 창에서 사번+PIN+노선 선택 후 로그인하세요 (최대 6분).");
  await page.waitForFunction(
    () => {
      // 1순위: 로그인 시 저장되는 localStorage 세션 (DOM 구조 무관, 가장 확실)
      try {
        if (localStorage.getItem("buslink_employee")) return true;
      } catch (e) {}
      // 2순위: 하단 탭바 라벨 등장
      const labels = ["홈", "노선", "공지", "탑승", "설정"];
      const btns = Array.from(document.querySelectorAll("button"));
      const found = labels.filter((l) =>
        btns.some((b) => {
          const s = b.querySelector("span:last-child");
          return s && (s.textContent || "").trim() === l;
        })
      );
      return found.length >= 3;
    },
    null,
    { timeout: LOGIN_TIMEOUT, polling: 1000 }
  );
  console.log("✅ 로그인 감지 — 캡처 시작\n");
}

const TAB_LABELS = ["홈", "노선", "공지", "탑승", "설정"];
async function clickEmpTab(page, label) {
  if (!TAB_LABELS.includes(label)) return;
  const locator = page.locator("button").filter({ hasText: new RegExp(`^[^A-Za-z]*${label}$`) });
  const count = await locator.count();
  if (count === 0) { console.log(`  ⚠ '${label}' 탭 못 찾음`); return; }
  try {
    await locator.first().click({ timeout: 3000 });
    console.log(`  → '${label}' 클릭`);
  } catch (e) {
    console.log(`  ⚠ '${label}' 클릭 실패: ${e.message.split("\n")[0]}`);
  }
  await sleep(1500);
}

(async () => {
  const outDir = path.join(__dirname, "assets", "employee");
  fs.mkdirSync(outDir, { recursive: true });

  console.log("\n=== Buslink 승객(직원)앱 화면 자동 캡처 (모바일 — iPhone 14) ===");
  console.log(`접속 URL: ${BASE_URL}/p`);

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
    await page.goto(`${BASE_URL}/p`, { waitUntil: "domcontentloaded" });
    await sleep(2000);
    await page.screenshot({ path: path.join(outDir, "01-login.png"), fullPage: false });
    console.log("✅ 01-login.png (로그인)");

    await waitForLogin(page);
    await sleep(1500);
    await waitKakao(page);

    try {
      const bannerVisible = await page.evaluate(() => {
        const text = document.body.innerText || "";
        return text.includes("앱 설치") || text.includes("홈 화면에 추가");
      });
      if (bannerVisible) {
        await page.screenshot({ path: path.join(outDir, "02-install-android.png"), fullPage: false });
        console.log("✅ 02-install-android.png (설치 배너)");
      } else {
        console.log("⚠ 설치 배너 미노출 — 02 placeholder 유지");
      }
    } catch (e) {}

    await clickEmpTab(page, "홈");
    await waitKakao(page);
    await page.screenshot({ path: path.join(outDir, "04-home.png"), fullPage: false });
    console.log("✅ 04-home.png (홈)");

    try {
      const clicked = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll("[onclick], button, div"));
        const stopItem = items.find((el) => {
          const t = (el.innerText || "").trim();
          return /\d{1,2}:\d{2}/.test(t) && t.length < 50;
        });
        if (stopItem) { stopItem.click(); return true; }
        return false;
      });
      if (clicked) {
        await sleep(1200);
        await page.screenshot({ path: path.join(outDir, "05-mystop.png"), fullPage: false });
        console.log("✅ 05-mystop.png (정류장 정보 카드)");
      } else {
        console.log("⚠ 정류장 항목 못 찾음 — 05 placeholder");
      }
    } catch (e) {
      console.log("⚠ 05-mystop skip:", e.message);
    }

    await clickEmpTab(page, "공지");
    await sleep(800);
    await page.screenshot({ path: path.join(outDir, "06-notices.png"), fullPage: false });
    console.log("✅ 06-notices.png (공지함)");

    await clickEmpTab(page, "탑승");
    await sleep(800);
    await page.screenshot({ path: path.join(outDir, "07-scan.png"), fullPage: false });
    console.log("✅ 07-scan.png (탑승 QR 스캔 안내)");

    await clickEmpTab(page, "설정");
    await sleep(800);
    await page.screenshot({ path: path.join(outDir, "08-settings.png"), fullPage: false });
    console.log("✅ 08-settings.png (설정)");

    console.log("\n=== 모든 캡처 완료 ===");
    console.log(`저장 위치: ${outDir}`);
    await sleep(2000);
  } catch (err) {
    console.error("\n❌ 오류:", err.message);
  } finally {
    await browser.close();
  }
})();
