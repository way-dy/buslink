// 익명 화면의 '실제 도착시각' 표시 — 승객앱(/bus) + 협력사 포털 노선도 통과(✓) 실화면 검증.
//
//   1) node docs/manual/_serve_build.mjs   (별도 터미널·3000 포트)
//   2) node scripts/headless_check_stop_arrivals.cjs
//   대조군(옛 번들 재현) = BASE=https://p.buslink.co.kr node scripts/headless_check_stop_arrivals.cjs
//     ⚠ 대조군은 승객앱만 본다(협력사 포털은 partner.buslink.co.kr 이라 도메인이 다르다).
//
// 🔴 소스 단언이 아니라 **화면에 찍힌 "도착 HH:MM"** 을 센다. 근인이 "권한 거부를 빈 값으로
//    흡수" 였기 때문에 코드만 봐서는 살아났는지 알 수 없다.
// 🔴 오늘 도착 기록이 없으면 판정이 공허하다 → 신호 유무를 검사 0번으로 두고 SKIP.
// prod 쓰기 0.
const path = require("path");
const fs = require("fs");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.BASE || "http://localhost:3000";
const PARTNER_BASE = process.env.PARTNER_BASE || BASE;
const COMPANY = "dy001";
const ROOT = path.join(__dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());

  // 도착 기록이 가장 많은 노선을 고른다(신호가 가장 센 표본).
  const dispSnap = await db.collection("companies").doc(COMPANY)
    .collection("dispatches").doc(today).collection("list").get();
  const byRoute = {};
  dispSnap.docs.forEach((d) => {
    const v = d.data() || {};
    if (!v.routeId) return;
    const b = (byRoute[v.routeId] = byRoute[v.routeId] || { name: v.routeName || "", stops: new Set() });
    Object.entries(v.stopArrivals || {}).forEach(([sid, rec]) => { if (rec && rec.actualAt) b.stops.add(sid); });
  });
  const best = Object.entries(byRoute).sort((a, b) => b[1].stops.size - a[1].stops.size)[0];
  const routeId = best && best[0];
  const expectedArrivals = best ? best[1].stops.size : 0;

  console.log(`\n${today} · 표본 노선 "${best ? best[1].name : "-"}"(${routeId}) · 도착 기록 ${expectedArrivals}개 · BASE=${BASE}`);
  ok("[0] 신호 있음 — 오늘 도착 기록이 있는 노선이 있다", expectedArrivals > 0, expectedArrivals);
  if (expectedArrivals === 0) { console.log("  ↳ 판정 불가 — 운행 뒤에 다시 돌릴 것(SKIP)."); process.exit(0); }

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 430, height: 1000 }, locale: "ko-KR", timezoneId: "Asia/Seoul" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("dialog", (d) => d.dismiss().catch(() => {}));

  // ── 승객앱 /bus — 정류장 목록의 "도착 HH:MM" ──
  await page.goto(`${BASE}/bus?c=${COMPANY}&route=${routeId}`, { waitUntil: "domcontentloaded" });
  await sleep(9000); // 익명 로그인 + 정류장 로드 + CF 응답
  const bus = await page.evaluate(() => {
    const txt = document.body.innerText || "";
    return {
      arrived: (txt.match(/도착\s+\d{2}:\d{2}/g) || []).length,
      planned: (txt.match(/계획\s+\d{2}:\d{2}/g) || []).length,
      bodyLen: txt.length,
    };
  });
  console.log(`  승객앱: "도착 HH:MM" ${bus.arrived}개 · "계획 HH:MM" ${bus.planned}개`);
  ok("[1] 승객앱이 살아 있다(빈 화면 아님)", bus.bodyLen > 200, bus.bodyLen);
  ok("[2] 정류장 목록에 실제 도착시각이 표시된다(옛 화면은 0개)", bus.arrived > 0, bus.arrived);
  ok(`[3] 표시 수가 실측 도착 기록(${expectedArrivals})을 넘지 않는다`, bus.arrived <= expectedArrivals, bus.arrived);
  ok("[4] 콘솔 오류 0", errors.length === 0, errors.slice(0, 3));

  const shot1 = process.env.SHOT || path.join(require("os").tmpdir(), "stop_arrivals_bus.png");
  await page.screenshot({ path: shot1, fullPage: true }).catch(() => {});
  console.log(`  (캡처: ${shot1})`);

  // ── 협력사 포털 노선도 통과(✓) ──
  if (process.env.SKIP_PARTNER) { await browser.close(); console.log(`\n${fail === 0 ? "✅ 통과" : `❌ ${fail}건 실패`}`); process.exit(fail === 0 ? 0 : 1); }
  const pcSnap = await db.collection("partnerCodes").where("companyId", "==", COMPANY).get();
  const rSnap = await db.collection("companies").doc(COMPANY).collection("routes").doc(routeId).get();
  const owner = rSnap.exists ? (rSnap.data() || {}).partnerCode : null;
  const target = pcSnap.docs.map((d) => ({ code: d.id, ...(d.data() || {}) })).find((c) => c.code === owner);
  if (!target) { console.log("  ⏭ 그 노선의 거래처가 없어 포털 검사는 건너뛴다"); }
  else {
    const p2 = await ctx.newPage();
    p2.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await p2.setViewportSize({ width: 1280, height: 1400 });
    await p2.goto(`${PARTNER_BASE}/partner`, { waitUntil: "domcontentloaded" });
    await sleep(2500);
    await p2.locator("input").first().fill(target.code);
    const btn = p2.locator('button:has-text("확인"), button:has-text("인증"), button:has-text("다음")');
    if (await btn.count()) await btn.first().click().catch(() => {});
    await sleep(3500);
    await p2.locator("button", { hasText: "운영 포털" }).first().click({ timeout: 10000 });
    await sleep(9000);
    // ✓ 는 노선도 스트립의 **정류장 노드**(14px 원)만 센다 — 화면 다른 곳의 체크 글리프가
    // 섞이면 대조군(옛 번들)이 1개로 통과해 버린다(2026-08-18 실측으로 걸렀다).
    const checks = await p2.evaluate(() => {
      let n = 0;
      document.querySelectorAll("div").forEach((el) => {
        if ((el.textContent || "").trim() !== "✓" || el.children.length !== 0) return;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (r.width > 0 && r.width <= 18 && r.height <= 18 && parseFloat(cs.borderRadius) >= 50) n++;
      });
      return n;
    });
    console.log(`  협력사 포털(${target.partnerName}): 노선도 통과 ✓ ${checks}개`);
    ok("[5] 노선도에 통과(✓) 표시가 찍힌다(옛 화면은 0개)", checks > 0, checks);
    const shot2 = path.join(require("os").tmpdir(), "stop_arrivals_partner.png");
    await p2.screenshot({ path: shot2, fullPage: true }).catch(() => {});
    console.log(`  (캡처: ${shot2})`);
  }
  ok("[6] 콘솔 오류 0(두 화면 합산)", errors.length === 0, errors.slice(0, 3));

  await browser.close();
  console.log(`\n${fail === 0 ? "✅ 통과" : `❌ ${fail}건 실패`}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
