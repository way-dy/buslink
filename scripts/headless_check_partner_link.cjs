// 관리자 협력사 관리 → **업체명 클릭 = 그 거래처 포털** 실화면 검증. **쓰기 0.**
// @requires-credentials  (서비스 계정 키 + 띄워 둔 서버가 있어야 돈다 — 게이트에서는 제외)
//
//   BASE=http://localhost:3010 node scripts/headless_check_partner_link.cjs
//   node scripts/headless_check_partner_link.cjs            (prod — 배포 후에만 의미 있다)
//
// 🔴 왜 필요한가: 이 저장소의 관리자 콘솔 변경은 늘 "눈으로 보세요"로 남겨져 왔고, 그 사이
//    미리보기가 2px 로 눌린 채 배포됐다(2026-08-27). 이번 변경은 «클릭하면 이동한다»가
//    전부라서 **소스 가드만으로는 아무것도 증명하지 못한다** — 실제로 눌러서 새 탭이
//    그 거래처 포털로 뜨는 것까지 본다. 로그인 통로는 headless_check_portal_theme.cjs 와 동일.
// ⚠ 읽기만 한다. 저장·발급·비활성화 버튼은 누르지 않는다.
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const ROOT = path.join(__dirname, "..");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.BASE || "https://admin.buslink.co.kr";
const COMPANY = "dy001";
const OUT = process.env.OUT || path.join(os.tmpdir(), "buslink-partner-link");

function firebaseConfig() {
  const t = fs.readFileSync(path.join(ROOT, ".env.local"), "utf8");
  const g = (k) => (t.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
  const cfg = { apiKey: g("REACT_APP_FIREBASE_API_KEY"), authDomain: g("REACT_APP_FIREBASE_AUTH_DOMAIN"),
    projectId: g("REACT_APP_FIREBASE_PROJECT_ID"), storageBucket: g("REACT_APP_FIREBASE_STORAGE_BUCKET"),
    messagingSenderId: g("REACT_APP_FIREBASE_MESSAGING_SENDER_ID"), appId: g("REACT_APP_FIREBASE_APP_ID") };
  if (!cfg.apiKey) throw new Error(".env.local 에서 REACT_APP_FIREBASE_* 를 못 읽었다");
  return cfg;
}

(async () => {
  let fail = 0, n = 0;
  const ok = (name, cond, got) => {
    n++; console.log(`  ${cond ? "✓" : "✗"} ${name}${!cond && got !== undefined ? " → " + JSON.stringify(got) : ""}`);
    if (!cond) fail++;
  };

  const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
  const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
  const sa = require(path.join(ROOT, "key", kf));
  if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치: " + sa.project_id);
  admin.initializeApp({ credential: admin.credential.cert(sa) });

  // 전체 권한 admin 으로 들어간다 — 제한 admin 은 거래처가 안 보여 판정이 무의미하다.
  const users = await admin.firestore().collection("users").where("companyId", "==", COMPANY).get();
  const target = users.docs.map((d) => ({ uid: d.id, ...(d.data() || {}) }))
    .find((u) => u.role === "admin" && Array.isArray(u.allowedPartnerCodes) && u.allowedPartnerCodes.includes("*"));
  if (!target) { console.log("⏭ 전체 권한 admin 이 없다 — 판정 불가"); process.exit(0); }
  const token = await admin.auth().createCustomToken(target.uid);
  console.log(`대상: ${target.name || target.uid} (전체 권한) · ${BASE}`);

  fs.mkdirSync(OUT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "buslink-plink-"));
  const ctx = await chromium.launchPersistentContext(dir, { executablePath: CHROME, headless: true,
    viewport: { width: 1440, height: 950 }, deviceScaleFactor: 1.5 });
  const page = await ctx.newPage();
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });

  try {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(3000);
    await page.evaluate(async ({ cfg, tok }) => {
      const A = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js");
      const U = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js");
      const auth = U.getAuth(A.initializeApp(cfg));      // 🔴 기본 앱 이름(세션 키가 갈리면 못 본다)
      await U.setPersistence(auth, U.indexedDBLocalPersistence);
      await U.signInWithCustomToken(auth, tok);
    }, { cfg: firebaseConfig(), tok: token });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(9000);
    for (const l of ["나중에", "✕"]) {   // PWA 설치 안내가 화면 하단을 덮는다
      const b = page.locator(`button:has-text("${l}")`).first();
      if (await b.count() && await b.isVisible().catch(() => false)) {
        await b.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(400);
      }
    }

    console.log("\n[0] 신호 유무");
    const menus = await page.locator("div").filter({ hasText: /^협력사 관리$/ }).count();
    ok("관리자 콘솔이 실제로 떴다(로그인 실패면 이하 전부 무의미)", menus > 0, menus);
    if (!menus) throw new Error("콘솔 진입 실패");

    await page.locator("div").filter({ hasText: /^협력사 관리$/ }).last().click({ timeout: 15000 });
    await page.waitForTimeout(3500);

    console.log("\n[1] 업체명이 링크다");
    const links = page.locator('a[href*="/partner?code="]');
    const linkCount = await links.count();
    const rowCount = await page.locator("button", { hasText: "포탈 설정" }).count();
    ok("포털 링크가 있다", linkCount > 0, linkCount);
    ok("행마다 하나씩 있다(빠진 거래처 0)", linkCount === rowCount, { linkCount, rowCount });
    const first = links.first();
    const info = await first.evaluate((a) => ({
      href: a.getAttribute("href"), target: a.getAttribute("target"),
      rel: a.getAttribute("rel"), text: (a.textContent || "").trim(),
    }));
    ok("새 탭으로 연다", info.target === "_blank" && /noopener/.test(info.rel || ""), info);
    ok("주소가 그 거래처 코드를 싣는다", /\/partner\?code=.+/.test(info.href), info.href);
    // 🔴 호스트를 갈아 끼우지 않는다 — '포털 URL 복사' 와 같은 주소여야 한다.
    ok("포털 URL 복사와 같은 origin", info.href.startsWith(BASE.replace(/\/+$/, "") + "/partner?"), info.href);
    await page.screenshot({ path: path.join(OUT, "admin-partner-link.png") });

    console.log("\n[2] 링크 클릭이 행 클릭(승객 목록)을 켜지 않는다");
    const beforeRoster = await page.locator("text=승객 목록").count();
    ok("[대조] 클릭 전에는 승객 목록이 닫혀 있다", beforeRoster === 0, beforeRoster);
    const [popup] = await Promise.all([
      ctx.waitForEvent("page", { timeout: 30000 }),
      first.click({ timeout: 15000 }),
    ]);
    await page.waitForTimeout(1200);
    const afterRoster = await page.locator("text=승객 목록").count();
    ok("🔴 링크를 눌러도 승객 목록이 펼쳐지지 않는다(stopPropagation)", afterRoster === 0, afterRoster);

    console.log("\n[3] 새 탭이 그 거래처 포털로 뜬다");
    await popup.waitForLoadState("domcontentloaded", { timeout: 30000 });
    await popup.waitForTimeout(9000);
    const entered = await popup.locator("text=인증된 업체").count();
    ok("업체코드를 치지 않고 포털에 들어갔다", entered > 0, entered);
    const shown = (await popup.locator("text=인증된 업체").first()
      .evaluate((el) => (el.parentElement?.textContent || "").trim()).catch(() => "")) || "";
    ok("🔴 관리자가 누른 그 거래처다", shown.includes(info.text.replace(/↗$/, "").trim()), { shown, clicked: info.text });
    // 🔴 자격증명급 문자열을 주소창에 남기지 않는다.
    ok("주소창에서 업체코드가 지워졌다", !/code=/.test(popup.url()), popup.url());
    await popup.screenshot({ path: path.join(OUT, "portal-from-link.png") });

    console.log("\n[4] 기존 동작(행 클릭 = 승객 목록)은 그대로다");
    await page.locator('a[href*="/partner?code="]').first()
      .evaluate((a) => a.closest("tr").querySelector("td:nth-child(3)")?.click());
    await page.waitForTimeout(2500);
    ok("행을 누르면 승객 목록이 펼쳐진다", (await page.locator("text=승객 목록").count()) > 0);

    console.log("\n[5] 🔗 링크 복사 버튼 + 빈 업체코드 칸");
    const linkBtns = await page.locator("button", { hasText: "🔗 링크" }).count();
    ok("행마다 링크 복사 버튼이 있다", linkBtns === rowCount, { linkBtns, rowCount });
    // 🔴 `code` 필드가 빈 문서(시연용 샘플)에서 이 칸이 비어 보였다 — 폴백 후 전 행이 채워져야 한다.
    const emptyCodes = await page.evaluate(() =>
      [...document.querySelectorAll("code")].filter((el) => !(el.textContent || "").trim()).length);
    ok("업체코드 칸이 빈 줄이 없다", emptyCodes === 0, emptyCodes);

    ok("콘솔 오류 0", errs.length === 0, errs.slice(0, 3));
    console.log(`\n🔴 쓰기 0 — 저장·발급·비활성화 버튼은 누르지 않았다.\n스크린샷: ${OUT}`);
  } finally {
    await ctx.close();
  }
  console.log(`\n${fail ? "✗ 실패 " + fail : "✓ 전부 통과"} (${n}단언)\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("실패:", e.message || e); process.exit(1); });
