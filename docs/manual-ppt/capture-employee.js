// 승객(직원)앱 화면 자동 캡처 (buslink EmployeeApp `/p`, 모바일 viewport)
// 사용자는 사번 + PIN 입력·노선 선택 1회 + Enter
// 실행: node capture-employee.js
const { chromium, devices } = require("playwright");
const readline = require("readline");
const fs = require("fs");
const path = require("path");

const BASE_URL = process.env.BASE_URL || "https://buslink-prod.web.app";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 카카오맵 로드 대기 (EmployeeApp 홈 탭에 지도)
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

// 탭 전환 — Playwright page.click() 사용 (real pointer events, React synthetic event 정확 발화)
// .evaluate(b.click()) 단독은 일부 button(공지 탭)에서 setTab 적용 안 되는 케이스 발견.
const TAB_LABELS = ["홈", "노선", "공지", "탑승", "설정"];
async function clickEmpTab(page, label) {
  if (!TAB_LABELS.includes(label)) { console.log(`  ⚠ 알 수 없는 탭 '${label}'`); return; }
  // 진단: 현재 페이지의 탭바 인벤토리 (라벨·y·disabled)
  const inv = await page.evaluate(() => {
    const labels = ["홈","노선","공지","탑승","설정"];
    return Array.from(document.querySelectorAll("button"))
      .filter(b => { const l = b.querySelector("span:last-child"); return l && labels.includes((l.textContent||"").trim()); })
      .map(b => ({ l: b.querySelector("span:last-child").textContent.trim(), y: Math.round(b.getBoundingClientRect().y), d: b.disabled }));
  });
  // Playwright getByRole — accessible name은 자식 span 텍스트 누적, hasText로 정확 매칭
  const locator = page.locator("button").filter({ hasText: new RegExp(`^[^A-Za-z]*${label}$`) });
  const count = await locator.count();
  if (count === 0) {
    console.log(`  ⚠ '${label}' 탭 못 찾음. 인벤토리: ${JSON.stringify(inv)}`);
    await sleep(500);
    return;
  }
  try {
    await locator.first().click({ timeout: 3000 });
    console.log(`  → '${label}' 클릭 (탭바 ${inv.length}개, locator 매치 ${count})`);
  } catch (e) {
    console.log(`  ⚠ '${label}' 클릭 실패: ${e.message.split("\n")[0]}`);
  }
  await sleep(1500);
}

(async () => {
  const outDir = path.join(__dirname, "assets", "employee");
  fs.mkdirSync(outDir, { recursive: true });

  console.log("\n=== Buslink 승객앱 화면 자동 캡처 (모바일 — iPhone 14) ===");
  console.log(`접속 URL: ${BASE_URL}/p`);
  console.log("브라우저가 모바일 크기로 뜨면 사번+PIN+노선 선택 후 로그인.");
  console.log("홈 화면(지도 + 정류장)이 보이면 콘솔로 돌아와 Enter — 나머지는 자동.\n");

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
    await page.goto(`${BASE_URL}/p`, { waitUntil: "domcontentloaded" });
    await sleep(2000);
    await page.screenshot({ path: path.join(outDir, "01-login.png"), fullPage: false });
    console.log("✅ 01-login.png (로그인)");

    console.log("\n📱 사번 + PIN + 노선 선택 후 로그인하세요.");
    console.log("   홈 화면(지도)이 보이면 콘솔에서 Enter.");
    await ask("   로그인 완료 후 Enter > ");

    await sleep(1500);
    await waitKakao(page);

    // PWA 설치 안내 영역 캡처 시도 — 보통 자동 배너 또는 설정 탭
    // 02-install-android.png / 03-install-ios.png는 placeholder가 자연스러움
    // (실제 배너가 떴을 때만 캡처 — Android Chrome BIP는 자동, iOS Safari는 수동)
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

    // 4. 홈 — 지도 + 내 정류장
    await clickEmpTab(page, "홈");
    await waitKakao(page);
    await page.screenshot({ path: path.join(outDir, "04-home.png"), fullPage: false });
    console.log("✅ 04-home.png (홈)");

    // 5. 내 정류장 카드 — 정류장 마커/리스트 클릭 시도
    // (단순화: 정류장 리스트 첫 번째 항목 클릭)
    try {
      const clicked = await page.evaluate(() => {
        // 정류장 리스트의 클릭 가능한 행 찾기
        const items = Array.from(document.querySelectorAll("[onclick], button, div"));
        const stopItem = items.find(el => {
          const t = (el.innerText || "").trim();
          return /\d{1,2}:\d{2}/.test(t) && t.length < 50; // HH:MM 시각 포함 + 짧은 텍스트
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

    // 6. 공지 탭
    await clickEmpTab(page, "공지");
    await sleep(800);
    await page.screenshot({ path: path.join(outDir, "06-notices.png"), fullPage: false });
    console.log("✅ 06-notices.png (공지함)");

    // 7. 탑승 탭 (카메라 권한 거부 — 메인 안내 화면만)
    await clickEmpTab(page, "탑승");
    await sleep(800);
    await page.screenshot({ path: path.join(outDir, "07-scan.png"), fullPage: false });
    console.log("✅ 07-scan.png (탑승 QR 스캔 안내)");

    // 8. 설정 탭
    await clickEmpTab(page, "설정");
    await sleep(800);
    await page.screenshot({ path: path.join(outDir, "08-settings.png"), fullPage: false });
    console.log("✅ 08-settings.png (설정)");

    console.log("\n=== 모든 캡처 완료 ===");
    console.log(`저장 위치: ${outDir}`);
    console.log("3초 후 브라우저 닫힘. 'node build-employee.js'로 PPT 재생성하세요.");
    await sleep(3000);
  } catch (err) {
    console.error("\n❌ 오류:", err.message);
  } finally {
    await browser.close();
    rl.close();
  }
})();
