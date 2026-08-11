// 승객앱 설정 탭 "배정 노선" — 문서 ID 가 아니라 노선 이름이 보이는지 (2026-08-11).
//   1) node docs/manual/_serve_build.mjs   (별도 터미널·3000 포트)
//   2) node scripts/headless_check_settings_route_name.cjs [거래처이름일부]
//   대조군(옛 번들) = BASE=https://p.buslink.co.kr node scripts/headless_check_settings_route_name.cjs
//
// 🔴 "이름을 넣었으니 되겠지"가 아니라 **화면 문자열을 Firestore 실값과 대조**한다.
//    값이 비어 있으면(로그인·탭 진입 실패) 판정이 무의미하므로 신호 유무를 검사 0번에 둔다.
// prod 쓰기 0 — 세션은 localStorage 주입.
const path = require("path");
const os = require("os");
const fs = require("fs");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.BASE || "http://localhost:3000";
const COMPANY = "dy001";
const ROOT = path.join(__dirname, "..");
const AUTO_ID = /^[A-Za-z0-9]{18,24}$/;   // Firestore 자동 ID 모양

function loadDb() {
  const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
  const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
  const sa = require(path.join(ROOT, "key", kf));
  if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치: " + sa.project_id);
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  return admin.firestore();
}

(async () => {
  let fail = 0;
  const ok = (n, c, x) => { console.log(`  ${c ? "✓" : "✗"} ${n}${!c && x !== undefined ? " → " + x : ""}`); if (!c) fail++; };

  const db = loadDb();
  const q = process.argv[2] || "채드윅";
  const pcSnap = await db.collection("partnerCodes").where("companyId", "==", COMPANY).get();
  const target = pcSnap.docs.map((d) => ({ code: d.id, ...(d.data() || {}) }))
    .find((c) => String(c.partnerName || "").includes(q));
  if (!target) { console.log("⏭ SKIP — 그 거래처가 없다"); process.exit(0); }

  // 노선이 배정된 승객으로 봐야 의미가 있다
  const psSnap = await db.collection("companies").doc(COMPANY).collection("passengers")
    .where("partnerCode", "==", target.code).limit(30).get();
  const p = psSnap.docs.map((d) => ({ empNo: d.id, ...(d.data() || {}) })).find((x) => x.routeId);
  if (!p) { console.log("⏭ SKIP — 노선 배정된 승객이 없다"); process.exit(0); }
  const rSnap = await db.collection("companies").doc(COMPANY).collection("routes").doc(p.routeId).get();
  const expected = (rSnap.exists ? (rSnap.data().name || "") : "").trim();
  console.log(`\n대상: ${target.partnerName} · 승객 ${p.empNo} · routeId ${p.routeId}`);
  console.log(`  기대 표시값: "${expected}"`);
  console.log(`  BASE=${BASE}`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "buslink-sroute-"));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CHROME, headless: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const errs = [];
  const ignorable = (t) => /kakao|dapi|favicon|manifest|Failed to load resource|net::ERR/i.test(t);
  page.on("console", (m) => { if (m.type() === "error" && !ignorable(m.text())) errs.push(m.text()); });
  page.on("pageerror", (e) => { if (!ignorable(e.message)) errs.push("pageerror: " + e.message); });

  await page.addInitScript((s) => window.localStorage.setItem("buslink_employee", JSON.stringify(s)),
    { empNo: p.empNo, name: p.name || "검토", dept: p.dept || "검토", routeId: p.routeId,
      partnerCode: target.code, partnerName: target.partnerName || null, companyId: COMPANY });

  await page.goto(`${BASE}/p?c=${COMPANY}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(6000);
  for (const label of ["확인했습니다", "나중에", "✕"]) {
    for (let i = 0; i < 3; i++) {
      const b = page.locator(`button:has-text("${label}")`).first();
      if (await b.count() && await b.isVisible().catch(() => false)) {
        await b.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(400);
      } else break;
    }
  }
  await page.locator('button:has-text("설정")').last().click({ timeout: 15000 });
  await page.waitForTimeout(3000);

  const shown = await page.evaluate(() => {
    const label = [...document.querySelectorAll("span")].find((s) => (s.textContent || "").trim() === "배정 노선");
    if (!label) return null;
    const row = label.parentElement;
    const spans = [...row.querySelectorAll("span")];
    return spans.length >= 2 ? (spans[1].textContent || "").trim() : null;
  });

  console.log(`\n화면 표시값: ${shown === null ? "(못 찾음)" : `"${shown}"`}`);
  ok("[0] 신호 있음 — '배정 노선' 줄을 찾았고 값이 비어 있지 않다", !!shown && shown !== "–", shown);
  if (!shown || shown === "–") { console.log("  ↳ 판정 불가"); await ctx.close(); process.exit(1); }

  ok("[1] 문서 ID 가 노출되지 않는다", !AUTO_ID.test(shown) && shown !== p.routeId, shown);
  ok("[2] 실제 노선 이름과 일치", expected ? shown === expected : true, `${shown} ≠ ${expected}`);
  const clip = await page.evaluate(() => {
    const label = [...document.querySelectorAll("span")].find((s) => (s.textContent || "").trim() === "배정 노선");
    const v = label && label.parentElement.querySelectorAll("span")[1];
    return v ? { over: v.scrollWidth > v.clientWidth + 1, right: v.getBoundingClientRect().right } : null;
  });
  ok("[3] 값이 가로로 넘치지 않는다(긴 노선명 줄바꿈)", clip && !clip.over && clip.right <= 390, clip);
  ok("[4] 콘솔 오류 0", errs.length === 0, errs.slice(0, 3));

  const shot = process.env.SHOT || path.join(os.tmpdir(), "settings_route_name.png");
  await page.screenshot({ path: shot }).catch(() => {});
  console.log(`  (캡처: ${shot})`);
  await ctx.close();
  console.log(`\n${fail === 0 ? "✅ 통과" : `❌ ${fail}건 실패`}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
