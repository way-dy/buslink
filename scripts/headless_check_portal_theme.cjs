// 관리자 ⚙️ 포탈 설정 — 테마 프리셋 UI 실화면 검증. **쓰기 0(저장 버튼을 누르지 않는다).**
//
//   node scripts/headless_check_portal_theme.cjs            (prod)
//   BASE=http://localhost:3000 node scripts/headless_check_portal_theme.cjs
//
// 🔴 이 저장소에 **관리자 로그인 하네스가 없어서** 관리자 화면은 늘 "눈으로 보세요"로
//    남겨져 왔고, 그 사이 미리보기가 높이 2px 로 눌린 채 배포됐다(2026-08-27). 그래서
//    서비스 계정으로 **커스텀 토큰**을 발급해 들어가는 통로를 여기 고정한다.
// 🔴 앱 이름을 반드시 **기본값**으로 초기화할 것 — Firebase 는 세션을
//    `firebase:authUser:{apiKey}:{appName}` 키로 IndexedDB 에 저장한다. 이름을 붙이면
//    키가 갈려 앱이 그 세션을 못 보고 로그인 화면에 머문다(실측으로 한 번 헛돌았다).
// ⚠ 로그인 대상은 **읽기만** 한다. 이 스크립트가 저장을 누르면 실제 거래처 문서가 바뀐다.
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const ROOT = path.join(__dirname, "..");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.BASE || "https://admin.buslink.co.kr";
const COMPANY = "dy001";

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

  // 전체 권한 admin 을 고른다 — 제한 admin 으로 들어가면 거래처가 안 보여 판정이 무의미하다.
  const users = await admin.firestore().collection("users").where("companyId", "==", COMPANY).get();
  const target = users.docs.map((d) => ({ uid: d.id, ...(d.data() || {}) }))
    .find((u) => u.role === "admin" && Array.isArray(u.allowedPartnerCodes) && u.allowedPartnerCodes.includes("*"));
  if (!target) { console.log("⏭ 전체 권한 admin 이 없다 — 판정 불가"); process.exit(0); }
  const token = await admin.auth().createCustomToken(target.uid);
  console.log(`대상: ${target.name || target.uid} (전체 권한) · ${BASE}`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "buslink-portal-"));
  const ctx = await chromium.launchPersistentContext(dir, { executablePath: CHROME, headless: true,
    viewport: { width: 1440, height: 950 }, deviceScaleFactor: 1.5 });
  const page = await ctx.newPage();
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });

  try {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(3000);
    await page.evaluate(async ({ cfg, token }) => {
      const A = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js");
      const U = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js");
      const auth = U.getAuth(A.initializeApp(cfg));      // 🔴 기본 앱 이름
      await U.setPersistence(auth, U.indexedDBLocalPersistence);
      await U.signInWithCustomToken(auth, token);
    }, { cfg: firebaseConfig(), token });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(9000);
    for (const l of ["나중에", "✕"]) {   // PWA 설치 안내가 모달 하단을 덮는다
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
    const gears = await page.locator("button").filter({ hasText: "포탈 설정" }).count();
    ok("⚙️ 포탈 설정 버튼이 있다", gears > 0, gears);
    await page.locator("button").filter({ hasText: "포탈 설정" }).first().click({ timeout: 15000 });
    await page.waitForTimeout(1800);

    console.log("\n[1] 프리셋 선택 UI");
    const cards = await page.locator("button").filter({ hasText: /^(기본|카카오 톤)/ }).count();
    ok("프리셋 카드가 2장", cards === 2, cards);

    // 미리보기 상자 = "미리보기" 라벨의 다음 형제.
    const preview = () => page.evaluate(() => {
      const lab = [...document.querySelectorAll("label")].find((l) => /^미리보기/.test((l.textContent || "").trim()));
      const box = lab && lab.nextElementSibling;
      if (!box) return null;
      const r = box.getBoundingClientRect();
      const band = box.firstElementChild;
      return { h: Math.round(r.height), bandH: band ? Math.round(band.getBoundingClientRect().height) : 0,
               bandBg: band ? getComputedStyle(band).backgroundColor : null };
    });

    const base = await preview();
    console.log("\n[2] 미리보기 — 기본");
    ok("미리보기 상자가 있다", !!base);
    // 🔴 이 단언이 이번 결함을 잡는 지점이다. `overflow:hidden` 인 flex 항목은 자동
    //    최소높이가 0 이라, 모달이 넘치면 테두리(2px)만 남고 내용이 통째로 잘린다.
    ok("🔴 상자가 눌리지 않았다(높이 > 40px — 2px 면 flexShrink 회귀)", base.h > 40, base);
    ok("  밴드가 그려졌다", base.bandH > 30, base.bandH);
    ok("  기본 밴드는 기본 테마 색", base.bandBg === "rgb(0, 61, 204)", base.bandBg);

    console.log("\n[3] 미리보기 — 카카오 톤");
    await page.locator("button").filter({ hasText: "카카오 톤" }).first().click({ timeout: 10000 });
    await page.waitForTimeout(800);
    const kk = await preview();
    ok("🔴 밴드가 곤색(#1E233D)으로 바뀐다", kk.bandBg === "rgb(30, 35, 61)", kk.bandBg);
    ok("  상자 높이는 그대로 유지", kk.h > 40, kk.h);
    ok("  🔴 기본과 실제로 다른 색이다(양성 대조)", kk.bandBg !== base.bandBg);
    const warn = await page.locator("text=프리셋을 쓰는 동안").count();
    ok("메인 컬러 미적용 안내가 뜬다", warn > 0, warn);

    console.log("\n[4] 되돌리기");
    await page.locator("button").filter({ hasText: /^기본/ }).first().click({ timeout: 10000 });
    await page.waitForTimeout(800);
    const back = await preview();
    ok("기본으로 되돌리면 원래 색", back.bandBg === base.bandBg, back.bandBg);

    ok("콘솔 오류 0", errs.length === 0, errs.slice(0, 3));
    console.log("\n🔴 저장 버튼은 누르지 않았다 — prod 쓰기 0");
  } finally {
    await ctx.close();
  }
  console.log(`\n${fail ? "✗ 실패 " + fail : "✓ 전부 통과"} (${n}단언)\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("실패:", e.message || e); process.exit(1); });
