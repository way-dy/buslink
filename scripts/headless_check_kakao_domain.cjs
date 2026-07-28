// 카카오 지도가 이 도메인에서 뜨는지 판별 (읽기 전용) — 2026-07-28.
//   node scripts/headless_check_kakao_domain.cjs <origin>
//   예: node scripts/headless_check_kakao_domain.cjs https://buslink-prod--navguide-xxxx.web.app
//
// 왜: 카카오 지도는 **개발자 콘솔에 등록된 도메인에서만** 동작한다(2026-06-15 실측 — 신규
// 서브도메인에서 지도·주소검색이 동시에 죽었고 코드는 무죄였다). 프리뷰 채널은 매번 새
// 호스트명을 받으므로 등록돼 있지 않다.
//
// 판별: 이미 지도가 있는 화면(`/p` 직원앱)이 같은 도메인에서 뜨는지 본다.
//   거기도 안 뜨면 → 도메인 미등록(코드 무죄)
//   거기는 뜨는데 새 화면만 안 뜨면 → 새 화면 코드 문제
// ⚠ 다른 헤드리스 점검과 달리 kakao/dapi 오류를 **걸러내지 않고 그대로 출력**한다.
const path = require("path");
const os = require("os");
const fs = require("fs");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ORIGIN = (process.argv[2] || "").replace(/\/$/, "");
if (!ORIGIN) { console.error("사용: node scripts/headless_check_kakao_domain.cjs <origin>"); process.exit(1); }

(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "buslink-kk-"));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CHROME, headless: true, viewport: { width: 420, height: 900 },
  });
  const page = await ctx.newPage();
  const msgs = [];
  page.on("console", (m) => msgs.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => msgs.push(`[pageerror] ${e.message}`));
  const failed = [];
  page.on("requestfailed", (r) => { if (/kakao|dapi/i.test(r.url())) failed.push(`${r.url()} — ${r.failure()?.errorText}`); });
  const responses = [];
  page.on("response", (r) => { if (/dapi\.kakao|map\.kakao|kakaocdn/i.test(r.url())) responses.push(`${r.status()} ${r.url().slice(0, 110)}`); });

  console.log(`\n대상: ${ORIGIN}/p  (직원앱 — 이미 지도가 있는 화면)\n`);
  await page.goto(`${ORIGIN}/p`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(6000);

  const state = await page.evaluate(() => ({
    hasKakao: typeof window.kakao !== "undefined",
    hasMaps: !!(window.kakao && window.kakao.maps),
    hasMapCtor: !!(window.kakao && window.kakao.maps && window.kakao.maps.Map),
    // 카카오 지도가 실제로 그려지면 타일 이미지가 붙는다
    tiles: document.querySelectorAll('img[src*="map"], .map_tile, [class*="mapTile"]').length,
    bodyText: document.body.innerText.slice(0, 120),
  }));

  console.log("SDK 상태:");
  console.log(`  window.kakao            ${state.hasKakao ? "✓" : "✗"}`);
  console.log(`  kakao.maps              ${state.hasMaps ? "✓" : "✗"}`);
  console.log(`  kakao.maps.Map 생성자   ${state.hasMapCtor ? "✓" : "✗"}`);
  console.log(`  지도 타일 요소          ${state.tiles}개`);

  console.log("\n카카오 관련 네트워크 응답:");
  (responses.length ? responses.slice(0, 12) : ["(없음)"]).forEach((r) => console.log("  " + r));
  if (failed.length) { console.log("\n실패한 요청:"); failed.forEach((f) => console.log("  " + f)); }

  const kk = msgs.filter((m) => /kakao|dapi|도메인|domain|appkey|인증/i.test(m));
  console.log("\n카카오 관련 콘솔 메시지:");
  (kk.length ? kk : ["(없음)"]).forEach((m) => console.log("  " + m));

  console.log("\n판정:");
  if (!state.hasMapCtor) console.log("  🔴 SDK 자체가 안 올라옴 — 도메인 미등록 또는 키 문제(코드 무죄)");
  else if (state.tiles === 0) console.log("  🔴 SDK 는 올라왔는데 타일이 0 — 도메인 미등록이 유력(코드 무죄)");
  else console.log("  🟢 이 도메인에서 지도 정상 — 새 화면 코드 쪽을 봐야 함");

  await ctx.close();
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
