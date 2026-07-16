// 승객앱(/p) 매뉴얼 스크린샷 캡처 — 실앱(로컬 build 서빙, prod Firestore 읽기)·모바일 뷰포트.
// 로그인 우회 = localStorage 합성 세션 주입(자격증명 미사용). 노선 선택은 앱 자체 "노선 변경" 모달 UI 로
// (실사용자 흐름 그대로 — Admin SDK 조회 불필요). prod 쓰기 없음(정류장 선택·탑승·공지읽음 클릭 안 함).
// 선행: node _serve_build.mjs (localhost:3000).  실행: node _capture_passenger.mjs
import { chromium } from "playwright-core";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "..", "manual-ppt", "assets", "passenger");
const BASE = "http://localhost:3000";
const CHROME = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"].find(p => fs.existsSync(p));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const SESSION = { empNo: "0000", name: "홍길동", dept: "안내", companyId: "dy001", routeId: "" };

async function clickTab(page, label) {
  // playbook: employee 탭은 real pointer click 필수(evaluate click 은 setState 미적용 사례)
  const btn = page.locator("button").filter({ has: page.locator(`span:text-is("${label}")`) });
  await btn.first().click({ timeout: 5000 });
  await sleep(1800);
}

(async () => {
  if (!CHROME) { console.error("시스템 Chrome 없음"); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });

  // ── 0) 로그인 화면 (세션 없이) ──
  {
    const ctx = await browser.newContext({ viewport: { width: 414, height: 896 }, deviceScaleFactor: 2, locale: "ko-KR", timezoneId: "Asia/Seoul" });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/p`, { waitUntil: "domcontentloaded" });
    await sleep(3000);
    await page.screenshot({ path: path.join(OUT, "login.png") });
    console.log("✓ login.png");
    await ctx.close();
  }

  // ── 1) 세션 주입 → 노선 변경 모달로 노선 선택 → 홈/노선/공지 ──
  const ctx = await browser.newContext({ viewport: { width: 414, height: 896 }, deviceScaleFactor: 2, locale: "ko-KR", timezoneId: "Asia/Seoul" });
  await ctx.addInitScript((s) => {
    try {
      localStorage.setItem("buslink_employee", JSON.stringify(s));
      // 강제 공지 모달 억제 — 읽음 시각은 localStorage 전용(Firestore write 0)
      localStorage.setItem(`buslink_notice_read_${s.empNo}`, String(Date.now()));
    } catch (e) {}
  }, SESSION);
  const page = await ctx.newPage();
  page.on("dialog", d => d.dismiss().catch(() => {}));
  await page.goto(`${BASE}/p`, { waitUntil: "domcontentloaded" });
  await sleep(4000);

  // 강제 공지 모달 떠 있으면 닫기("확인했습니다") — 읽음 write 유발하므로 Escape 대신 렌더만 회피 불가 시 skip
  const force = await page.locator('button:has-text("확인했습니다")').count();
  if (force > 0) { console.log("⚠ 강제 공지 모달 감지 — 읽음처리(write) 회피 위해 미클릭·홈 캡처에 포함될 수 있음"); }

  // 노선 변경 모달 열기 → 정류장 있는 노선 탐색(최대 6개): 선택 후 홈에 '내 정류장' 안내가 뜨는 노선 채택
  let chosen = null;
  for (let i = 0; i < 6; i++) {
    await page.locator('button:has-text("노선 변경")').first().click({ timeout: 8000 });
    await sleep(1500);
    const cards = page.locator('div').filter({ has: page.locator('span:text-is("현재")') }); // 현재 배지 제외용 아님 — 아래 인덱스 접근
    const list = page.locator('div[style*="overflow-y: auto"], div[style*="overflowY"]');
    // 모달 목록의 i번째 노선 카드 클릭 (fixed 오버레이 안 카드 = cursor:pointer div)
    const routeCards = page.locator('div[style*="cursor: pointer"]').filter({ hasText: "🕒" });
    const n = await routeCards.count();
    const total = n > 0 ? routeCards : page.locator('div[style*="cursor: pointer"]');
    const cnt = await total.count();
    if (cnt === 0) { console.log("⚠ 노선 카드 0개 — 인벤토리:", await page.evaluate(() => document.body.innerText.slice(0, 400))); break; }
    const idx = Math.min(i, cnt - 1);
    const name = (await total.nth(idx).innerText()).split("\n").join(" / ").slice(0, 60);
    await total.nth(idx).click();
    await sleep(3500); // stops·GPS 구독 + 카카오 렌더
    const hasStops = await page.evaluate(() => (document.body.innerText || "").includes("내 정류장"));
    console.log(`  노선 시도 ${i}: ${name} → stops=${hasStops}`);
    if (hasStops) { chosen = name; break; }
    if (idx === cnt - 1) break;
  }
  if (!chosen) console.log("⚠ '내 정류장' 안내 미검출 — 현재 화면 그대로 캡처(운행 외 시간대 정상일 수 있음)");

  await sleep(2500);
  await page.screenshot({ path: path.join(OUT, "home.png") });
  console.log("✓ home.png", chosen ? `(노선: ${chosen})` : "");

  await clickTab(page, "노선");
  await page.screenshot({ path: path.join(OUT, "routes.png") });
  console.log("✓ routes.png");

  await clickTab(page, "공지");
  await page.screenshot({ path: path.join(OUT, "notices.png") });
  console.log("✓ notices.png");

  await browser.close();
  console.log("완료 →", OUT);
})().catch(e => { console.error("오류:", e.message); process.exit(1); });
