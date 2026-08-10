// 승객앱 현재 화면 일괄 캡처 (읽기 전용·prod 쓰기 0) — 2026-08-10 디자인 검토용.
//   node scripts/capture_passenger_screens.cjs [출력폴더] [거래처이름일부]
//
// 🔴 **prod 도메인에서 찍는다** — localhost 는 카카오 콘솔 미등록이라 지도가 안 뜨고,
//    지도가 빠진 스크린샷으로 "디자인이 조잡한가"를 판단하면 엉뚱한 결론이 난다.
// ⚠ 세션은 localStorage 주입(로그인 폼을 태우면 passengers.lastLoginAt 이 써진다).
// ⚠ 화면을 눌러 '내 정류장'을 지정하지 않는다(fcmTokens write 방지).
const path = require("path");
const os = require("os");
const fs = require("fs");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.BASE || "https://p.buslink.co.kr";
const COMPANY = "dy001";
const ROOT = path.join(__dirname, "..");
const OUT = process.argv[2] || path.join(os.tmpdir(), "buslink-shots");
const QUERY = process.argv[3] || "채드윅";

function loadDb() {
  const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
  const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
  const sa = require(path.join(ROOT, "key", kf));
  if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치: " + sa.project_id);
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  return admin.firestore();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const db = loadDb();
  const pcSnap = await db.collection("partnerCodes").where("companyId", "==", COMPANY).get();
  const codes = pcSnap.docs.map((d) => ({ code: d.id, ...(d.data() || {}) }));
  const target = codes.find((c) => String(c.partnerName || "").includes(QUERY)) || codes[0];
  const psSnap = await db.collection("companies").doc(COMPANY).collection("passengers")
    .where("partnerCode", "==", target.code).limit(1).get();
  if (psSnap.empty) { console.log(`⏭ ${target.partnerName} 승객 없음`); process.exit(0); }
  const p = { empNo: psSnap.docs[0].id, ...psSnap.docs[0].data() };
  console.log(`대상: ${target.partnerName} · 승객 ${p.empNo} · ${BASE}`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "buslink-cap-"));
  const ctx = await chromium.launchPersistentContext(dir, {
    executablePath: CHROME, headless: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await page.addInitScript((s) => window.localStorage.setItem("buslink_employee", JSON.stringify(s)),
    { empNo: p.empNo, name: p.name || "검토", dept: p.dept || "검토", routeId: p.routeId || null,
      partnerCode: target.code, partnerName: target.partnerName || null, companyId: COMPANY });

  await page.goto(`${BASE}/p?c=${COMPANY}`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(9000);   // 지도 타일·GPS 구독이 붙을 시간
  for (const label of ["확인했습니다", "나중에", "✕"]) {
    for (let i = 0; i < 3; i++) {
      const b = page.locator(`button:has-text("${label}")`).first();
      if (await b.count() && await b.isVisible().catch(() => false)) {
        await b.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(400);
      } else break;
    }
  }
  await page.waitForTimeout(2500);

  const tabBtn = (l) => page.locator("button").filter({ hasText: new RegExp(`^${l}$`) }).last();
  const shots = [["home", "홈"], ["routes", "노선"], ["notices", "공지"], ["scan", "탑승"], ["settings", "설정"]];
  for (const [file, label] of shots) {
    if (file !== "home") {
      await tabBtn(label).click({ timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2600);
    }
    await page.screenshot({ path: path.join(OUT, `${file}.png`) });
    console.log(`  캡처 ${file}.png`);
  }
  console.log(`\n출력: ${OUT}`);
  await ctx.close();
  process.exit(0);
})().catch((e) => { console.error("실패:", e); process.exit(1); });
