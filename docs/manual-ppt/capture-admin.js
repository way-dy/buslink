// 관리자 화면 자동 캡처 (buslink AdminApp `/`)
// 로그인은 사용자가 뜬 창에서 직접 — 로그인 완료를 DOM(사이드바 nav)으로 자동 감지(Enter 불필요).
// 실행: node capture-admin.js
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE_URL = process.env.BASE_URL || "https://buslink-prod.web.app";
const LOGIN_TIMEOUT = Number(process.env.LOGIN_TIMEOUT || 360000); // 6분

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function clickTab(page, tabIdx) {
  await page.evaluate((i) => {
    const items = document.querySelectorAll("[data-nav-item]");
    if (items[i]) items[i].click();
  }, tabIdx);
  await sleep(900);
}

// 라벨 텍스트로 사이드바 탭 클릭 (인덱스 변동에 강건)
async function clickTabByText(page, text) {
  const ok = await page.evaluate((t) => {
    const items = Array.from(document.querySelectorAll("[data-nav-item]"));
    const el = items.find((i) => (i.innerText || "").includes(t));
    if (el) { el.click(); return true; }
    return false;
  }, text);
  await sleep(900);
  return ok;
}

async function waitKakao(page, timeoutMs = 8000) {
  try {
    await page.waitForFunction(
      () => window.kakao && window.kakao.maps && window.kakao.maps.LatLng,
      null,
      { timeout: timeoutMs }
    );
    await sleep(800);
  } catch (e) {
    console.log("⚠ Kakao Maps 로드 타임아웃 — 캡처 시 흰화면 가능");
  }
}

// 로그인 완료 = 사이드바 nav 항목(data-nav-item) 등장
async function waitForLogin(page) {
  console.log("\n⏳ 로그인 대기 중 — 뜬 창에서 회사 이메일+비밀번호로 로그인하세요 (최대 6분).");
  await page.waitForFunction(
    () => document.querySelectorAll("[data-nav-item]").length > 0,
    null,
    { timeout: LOGIN_TIMEOUT, polling: 1000 }
  );
  console.log("✅ 로그인 감지 — 캡처 시작\n");
}

(async () => {
  const outDir = path.join(__dirname, "assets", "admin");
  fs.mkdirSync(outDir, { recursive: true });

  console.log("\n=== Buslink 관리자 화면 자동 캡처 ===");
  console.log(`접속 URL: ${BASE_URL}`);

  const browser = await chromium.launch({ headless: false, args: ["--start-maximized"] });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
  });
  const page = await ctx.newPage();

  try {
    await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
    await sleep(1500);
    await page.screenshot({ path: path.join(outDir, "01-login.png"), fullPage: false });
    console.log("✅ 01-login.png");

    await waitForLogin(page);
    await sleep(2000);

    // 02. 대시보드(첫 화면, 사이드바 포함)
    await clickTab(page, 0);
    await page.screenshot({ path: path.join(outDir, "02-sidebar.png"), fullPage: false });
    console.log("✅ 02-sidebar.png (대시보드+사이드바)");

    // 03. 실시간 관제
    await clickTabByText(page, "실시간");
    await waitKakao(page);
    await page.screenshot({ path: path.join(outDir, "03-realtime.png"), fullPage: false });
    console.log("✅ 03-realtime.png");

    // 04. 배차 일정
    await clickTabByText(page, "배차 일정");
    await page.screenshot({ path: path.join(outDir, "04-dispatch.png"), fullPage: false });
    console.log("✅ 04-dispatch.png (배차 일정)");

    // 11. 배차 관리 (기존 placeholder 보강)
    if (await clickTabByText(page, "배차 관리")) {
      await page.screenshot({ path: path.join(outDir, "11-dispatch-manage.png"), fullPage: false });
      console.log("✅ 11-dispatch-manage.png (배차 관리)");
    } else { console.log("⚠ 배차 관리 탭 못 찾음"); }

    // 05. 노선 관리
    await clickTabByText(page, "노선");
    await waitKakao(page);
    await page.screenshot({ path: path.join(outDir, "05-routes.png"), fullPage: false });
    console.log("✅ 05-routes.png");

    // 06. 기사 관리
    await clickTabByText(page, "기사");
    await page.screenshot({ path: path.join(outDir, "06-drivers.png"), fullPage: false });
    console.log("✅ 06-drivers.png");

    // 12. 차량 관리 (기존 placeholder 보강)
    if (await clickTabByText(page, "차량")) {
      await page.screenshot({ path: path.join(outDir, "12-vehicles.png"), fullPage: false });
      console.log("✅ 12-vehicles.png (차량 관리)");
    } else { console.log("⚠ 차량 관리 탭 못 찾음"); }

    // 09. 운행 이력
    await clickTabByText(page, "운행 이력");
    await waitKakao(page);
    await page.screenshot({ path: path.join(outDir, "09-history.png"), fullPage: false });
    console.log("✅ 09-history.png");

    // 08. 탑승 통계
    await clickTabByText(page, "탑승");
    await page.screenshot({ path: path.join(outDir, "08-stats.png"), fullPage: false });
    console.log("✅ 08-stats.png");

    // 10. 협력사 관리
    await clickTabByText(page, "협력사");
    await page.screenshot({ path: path.join(outDir, "10-partner.png"), fullPage: false });
    console.log("✅ 10-partner.png");

    // 07. 공지 발송
    await clickTabByText(page, "공지");
    await page.screenshot({ path: path.join(outDir, "07-notice.png"), fullPage: false });
    console.log("✅ 07-notice.png");

    await clickTab(page, 0);

    console.log("\n=== 모든 캡처 완료 ===");
    console.log(`저장 위치: ${outDir}`);
    await sleep(2000);
  } catch (err) {
    console.error("\n❌ 오류:", err.message);
  } finally {
    await browser.close();
  }
})();
