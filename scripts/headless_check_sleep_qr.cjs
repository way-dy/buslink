// 빈 차 확인(슬리핑 차일드) 뒷좌석 QR — 실화면 E2E (2026-08-18 건의 `Eg8ZbQTMmPR6AAYo4fp0`).
//
//   node scripts/headless_check_sleep_qr.cjs            (기본 = prod)
//   BASE=http://localhost:3000 node scripts/headless_check_sleep_qr.cjs
//
// 🔴 이 검사는 **prod 배차 문서에 실제로 확인 기록을 남긴다**(읽기 전용이 아니다).
//    그래서 ① 오늘 운행 중인 실차량을 쓰지 않고 ② 검사 끝에 **남긴 기록을 지운다**.
//    지우지 않으면 기사가 뒤까지 안 갔는데 "확인됨"으로 남아 이 기능의 의미가 무너진다.
// 🔴 확인 대상 배차가 없으면 판정 자체가 무의미 → 신호 유무를 검사 0번으로 둔다.
const path = require("path");
const fs = require("fs");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.BASE || "https://p.buslink.co.kr";
const COMPANY = "dy001";
const ROOT = path.join(__dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadDb() {
  const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
  const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
  const sa = require(path.join(ROOT, "key", kf));
  if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치: " + sa.project_id);
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  return { db: admin.firestore(), admin };
}

(async () => {
  let fail = 0;
  const ok = (n, c, x) => { console.log(`  ${c ? "✓" : "✗"} ${n}${!c && x !== undefined ? " → " + x : ""}`); if (!c) fail++; };

  const { db, admin } = loadDb();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
  const listRef = db.collection("companies").doc(COMPANY).collection("dispatches").doc(today).collection("list");
  const snap = await listRef.get();
  // 아직 확인이 없는 배차 하나를 표본으로(있는 것 중 아무거나 — 확인 뒤 되돌린다).
  const target = snap.docs.find((d) => !(d.data() || {}).sleepingCheck);
  console.log(`\n${today} · 오늘 배차 ${snap.size}건 · BASE=${BASE}`);
  ok("[0] 신호 있음 — 확인 기록이 없는 배차가 있다", !!target, snap.size);
  if (!target) { console.log("  ↳ 판정 불가(SKIP)"); process.exit(0); }
  const t = target.data() || {};
  const vehicleId = t.vehicleId;
  console.log(`  표본: ${t.vehicleNo || vehicleId} · ${t.routeName || t.routeId}`);
  ok("[1] 표본 배차에 vehicleId 가 있다", !!vehicleId, vehicleId);
  if (!vehicleId) process.exit(1);

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 430, height: 900 }, locale: "ko-KR", timezoneId: "Asia/Seoul" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  try {
    // ── 잘못된 QR(파라미터 없음)은 안내로 끝나야 한다 ──
    await page.goto(`${BASE}/sleep`, { waitUntil: "domcontentloaded" });
    await sleep(4000);
    const bad = await page.evaluate(() => document.body.innerText || "");
    ok("[2] 파라미터 없는 접근은 안내 화면", /확인용 QR이 아닙니다/.test(bad), bad.slice(0, 60));

    // ── 정상 QR ──
    await page.goto(`${BASE}/sleep?c=${COMPANY}&v=${encodeURIComponent(vehicleId)}`, { waitUntil: "domcontentloaded" });
    await sleep(5000);
    const txt1 = await page.evaluate(() => document.body.innerText || "");
    ok("[3] 확인 화면이 뜬다(빈 차 확인)", /빈 차 확인/.test(txt1), txt1.slice(0, 60));
    ok("[4] 입력란 없이 버튼 하나", (await page.locator("input").count()) === 0);

    const btn = page.locator("button", { hasText: "확인 완료" }).first();
    ok("[5] 확인 버튼이 있다", (await btn.count()) > 0);
    await btn.click();
    await sleep(6000);
    const txt2 = await page.evaluate(() => document.body.innerText || "");
    ok("[6] 눌렀더니 확인되었습니다", /확인되었습니다/.test(txt2), txt2.slice(0, 80));

    // ── 서버 기록 실측 ──
    const after = await listRef.doc(target.id).get();
    const rec = (after.data() || {}).sleepingCheck;
    ok("[7] 배차 문서에 확인 기록이 남았다", !!(rec && rec.checkedAt), JSON.stringify(rec || null));
    ok("[8] 경로가 qr 로 기록", rec && rec.via === "qr", rec && rec.via);

    // ── 멱등: 다시 눌러도 기록 시각이 안 바뀐다 ──
    const firstMs = rec && rec.checkedAt && rec.checkedAt.toMillis ? rec.checkedAt.toMillis() : null;
    await page.reload({ waitUntil: "domcontentloaded" });
    await sleep(5000);
    const btn2 = page.locator("button", { hasText: "확인 완료" }).first();
    if (await btn2.count()) { await btn2.click(); await sleep(5000); }
    const txt3 = await page.evaluate(() => document.body.innerText || "");
    const again = await listRef.doc(target.id).get();
    const rec2 = (again.data() || {}).sleepingCheck;
    const secondMs = rec2 && rec2.checkedAt && rec2.checkedAt.toMillis ? rec2.checkedAt.toMillis() : null;
    ok("[9] 두 번째는 '이미 확인되었습니다'", /이미 확인되었습니다/.test(txt3), txt3.slice(0, 60));
    ok("[10] 첫 확인 시각이 덮이지 않는다(멱등)", firstMs && secondMs && firstMs === secondMs, `${firstMs} vs ${secondMs}`);

    ok("[11] 콘솔 오류 0", errors.length === 0, errors.slice(0, 3));
  } finally {
    // 🔴 검사가 남긴 기록 원복 — 안 지우면 그 운행이 "확인됨"으로 굳는다.
    await listRef.doc(target.id).update({ sleepingCheck: admin.firestore.FieldValue.delete() }).catch(() => {});
    const cleaned = await listRef.doc(target.id).get();
    ok("[12] 검사가 남긴 기록을 지웠다(원복)", !(cleaned.data() || {}).sleepingCheck);
    await browser.close();
  }

  console.log(`\n${fail === 0 ? "✅ 통과" : `❌ ${fail}건 실패`}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
