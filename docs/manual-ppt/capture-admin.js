// 관리자 화면 자동 캡처 (buslink AdminApp `/`)
// 사용자는 Firebase Email/Password 로그인 1회 + Enter
// 실행: node capture-admin.js
const { chromium } = require("playwright");
const readline = require("readline");
const fs = require("fs");
const path = require("path");

const BASE_URL = process.env.BASE_URL || "https://buslink-prod.web.app";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// buslink AdminApp의 사이드바 nav 셀렉터 — data-nav-item 속성 (이미 확인)
async function clickTab(page, tabIdx) {
  // 사이드바 nav 항목 중 i번째 클릭
  await page.evaluate((i) => {
    const items = document.querySelectorAll('[data-nav-item]');
    if (items[i]) items[i].click();
  }, tabIdx);
  await sleep(900);
}

// 카카오맵 로드 대기 — `window.kakao.maps.load(cb)` 콜백 only (issues.md 패턴)
async function waitKakao(page, timeoutMs = 8000) {
  try {
    await page.waitForFunction(
      () => window.kakao && window.kakao.maps && window.kakao.maps.LatLng,
      null,
      { timeout: timeoutMs }
    );
    await sleep(800); // 마커/오버레이 렌더 여유
  } catch (e) {
    console.log("⚠ Kakao Maps 로드 타임아웃 — 캡처 시 흰화면 가능");
  }
}

(async () => {
  const outDir = path.join(__dirname, "assets", "admin");
  fs.mkdirSync(outDir, { recursive: true });

  console.log("\n=== Buslink 관리자 화면 자동 캡처 ===");
  console.log(`접속 URL: ${BASE_URL}`);
  console.log("Chrome 창이 뜨면 회사 이메일 + 비밀번호로 로그인하세요.");
  console.log("대시보드(첫 화면)가 보이면 콘솔에서 Enter — 나머지는 자동.\n");

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

    console.log("\n🔐 회사 이메일 + 비밀번호로 로그인 후, 대시보드가 보이면 Enter.");
    await ask("   로그인 완료 후 Enter > ");
    await sleep(2000);

    // 2. 사이드바 단독 캡처 (대시보드 상태에서 전체 캡처)
    await page.screenshot({
      path: path.join(outDir, "02-sidebar.png"),
      fullPage: false,
    });
    console.log("✅ 02-sidebar.png");

    // 3. 실시간 관제 (탭 1)
    await clickTab(page, 1);
    await waitKakao(page);
    await page.screenshot({ path: path.join(outDir, "03-realtime.png"), fullPage: false });
    console.log("✅ 03-realtime.png");

    // 4. 배차 일정 (탭 3 — '배차 일정'이 더 풍부)
    await clickTab(page, 3);
    await page.screenshot({ path: path.join(outDir, "04-dispatch.png"), fullPage: false });
    console.log("✅ 04-dispatch.png");

    // 5. 노선 관리 (탭 4)
    await clickTab(page, 4);
    await waitKakao(page);
    await page.screenshot({ path: path.join(outDir, "05-routes.png"), fullPage: false });
    console.log("✅ 05-routes.png");

    // 6. 기사 관리 (탭 5) — 카드 위주 슬라이드라 캡처 영역 0이지만 보조
    await clickTab(page, 5);
    await page.screenshot({ path: path.join(outDir, "06-drivers.png"), fullPage: false });
    console.log("✅ 06-drivers.png");

    // 7. 공지 발송 (탭 11)
    await clickTab(page, 11);
    await page.screenshot({ path: path.join(outDir, "07-notice.png"), fullPage: false });
    console.log("✅ 07-notice.png");

    // 8. 탑승 통계 (탭 9)
    await clickTab(page, 9);
    await page.screenshot({ path: path.join(outDir, "08-stats.png"), fullPage: false });
    console.log("✅ 08-stats.png");

    // 9. 운행 이력 (탭 8)
    await clickTab(page, 8);
    await waitKakao(page);
    await page.screenshot({ path: path.join(outDir, "09-history.png"), fullPage: false });
    console.log("✅ 09-history.png");

    // 10. 협력사 관리 (탭 10)
    await clickTab(page, 10);
    await page.screenshot({ path: path.join(outDir, "10-partner.png"), fullPage: false });
    console.log("✅ 10-partner.png");

    // 대시보드로 복귀
    await clickTab(page, 0);

    console.log("\n=== 모든 캡처 완료 ===");
    console.log(`저장 위치: ${outDir}`);
    console.log("3초 후 브라우저 닫힘. 'node build-admin.js'로 PPT 재생성하세요.");
    await sleep(3000);
  } catch (err) {
    console.error("\n❌ 오류:", err.message);
  } finally {
    await browser.close();
    rl.close();
  }
})();
