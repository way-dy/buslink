// 강제 공지 모달이 "확인했습니다" 로 닫히는지 재현 (읽기 전용·prod 쓰기 0)
//   node scripts/repro_force_notice.cjs [거래처이름일부]
//
// 2026-08-11 way 신고: 모달에서 화면이 멈춘다. 읽음 처리는 localStorage 라 prod 쓰기 없음.
// 🔴 콘솔·pageerror 를 **거르지 않고** 전부 찍는다 — 평소 헤드리스 점검은 kakao/firebase 를
//    무시 목록에 넣는데, 그러면 진짜 원인이 그 목록에 숨는다.
const path = require("path");
const os = require("os");
const fs = require("fs");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.BASE || "https://p.buslink.co.kr";
const COMPANY = "dy001";
const ROOT = path.join(__dirname, "..");
const QUERY = process.argv[2] || "신촌세브란스";

function loadDb() {
  const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
  const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
  const sa = require(path.join(ROOT, "key", kf));
  if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치");
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  return admin.firestore();
}

(async () => {
  const db = loadDb();
  const pc = await db.collection("partnerCodes").where("companyId", "==", COMPANY).get();
  const t = pc.docs.map((d) => ({ code: d.id, ...(d.data() || {}) }))
    .find((c) => String(c.partnerName || "").includes(QUERY));
  if (!t) { console.log(`⏭ '${QUERY}' 거래처 없음`); process.exit(0); }
  const ps = await db.collection("companies").doc(COMPANY).collection("passengers")
    .where("partnerCode", "==", t.code).limit(1).get();
  if (ps.empty) { console.log("⏭ 승객 없음"); process.exit(0); }
  const p = { empNo: ps.docs[0].id, ...ps.docs[0].data() };
  console.log(`대상: ${t.partnerName} · 승객 ${p.empNo} · ${BASE}`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repro-fn-"));
  const ctx = await chromium.launchPersistentContext(dir, {
    executablePath: CHROME, headless: true, viewport: { width: 1400, height: 900 },
  });
  const page = await ctx.newPage();
  const logs = [];
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 200)}`));
  page.on("pageerror", (e) => logs.push(`[PAGEERROR] ${e.message}`));

  await page.addInitScript((s) => window.localStorage.setItem("buslink_employee", JSON.stringify(s)),
    { empNo: p.empNo, name: p.name || "검토", dept: p.dept || "검토", routeId: p.routeId || null,
      partnerCode: t.code, partnerName: t.partnerName || null, companyId: COMPANY });

  await page.goto(`${BASE}/p?c=${COMPANY}`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(9000);

  const modalUp = async () => page.evaluate(() =>
    document.body.innerText.includes("확인했습니다"));
  console.log(`\n모달 표시: ${await modalUp()}`);
  await page.screenshot({ path: path.join(dir, "1_before.png") });

  const btn = page.locator('button:has-text("확인했습니다")').first();
  console.log(`버튼 보임: ${await btn.isVisible().catch(() => false)}`);
  await btn.click({ timeout: 8000 }).catch((e) => console.log("클릭 실패:", e.message));
  await page.waitForTimeout(2500);

  const still = await modalUp();
  console.log(`클릭 직후 모달 있음: ${still}  ${still ? "🔴 재현됨" : "닫힘"}`);
  await page.screenshot({ path: path.join(dir, "2_after.png") });

  // 🔴 "닫혔다"로 끝내지 않는다 — 공지 onSnapshot 이 다시 오면 모달이 되살아날 수 있고,
  //    사용자에겐 그게 "멈춰 있다"로 보인다. 20초를 지켜본다.
  let reappeared = false;
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(2000);
    if (await modalUp()) { reappeared = true; console.log(`  🔴 ${(i + 1) * 2}초 뒤 모달이 다시 떴다`); break; }
  }
  if (!reappeared) console.log("  ✅ 20초 동안 다시 뜨지 않음");
  await page.screenshot({ path: path.join(dir, "3_after20s.png") });

  // 다시 눌러 보기 — 재발화(닫혔다가 즉시 다시 뜸)인지 구분
  if (still) {
    await page.locator('button:has-text("확인했습니다")').first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(2000);
    console.log(`두 번째 클릭 후에도 모달 있음: ${await modalUp()}`);
  }

  console.log(`\n콘솔/오류 ${logs.length}건 (전량):`);
  logs.slice(0, 25).forEach((l) => console.log("  " + l));
  console.log(`\n스크린샷: ${dir}`);
  await ctx.close();
  process.exit(0);
})().catch((e) => { console.error("실패:", e); process.exit(1); });
