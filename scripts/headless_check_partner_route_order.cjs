// 협력사 포털 운영 포털 — 노선 카드가 **관리자 노선 관리 순서(routes.order)** 로 보이는지
// (2026-08-26 배상준 개선요청 `DqF7nony`).
//
//   1) node docs/manual/_serve_build.mjs   (별도 터미널·3000 포트)
//   2) node scripts/headless_check_partner_route_order.cjs [거래처이름일부]
//   대조군(옛 번들 재현) = BASE=https://partner.buslink.co.kr node scripts/headless_check_partner_route_order.cjs [...]
//
// 🔴 소스 단언이 아니라 **실제로 그려진 카드의 나열 순서**를 Firestore 의 `routes.order` 와
//    대조한다. 격리 테스트(`test_partner_route_order.cjs`)는 규칙이 맞는지만 보고,
//    그 규칙이 화면까지 닿았는지는 이 하네스가 본다.
//    카드가 0개면(로그인 실패·섹션 미렌더) 판정이 무의미하므로 신호 유무를 0번으로 검사한다.
// prod 쓰기 0 — 업체코드로 로그인만 한다.
const path = require("path");
const fs = require("fs");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.BASE || "http://localhost:3000";
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

// 화면이 따라야 할 정본 규칙 — `src/lib/routeOrder.js` 와 같은 식(order → 출발 → 이름).
const NO_ORDER = Number.MAX_SAFE_INTEGER;
function orderOf(r) {
  const v = r && r.order;
  return typeof v === "number" && isFinite(v) ? v : NO_ORDER;
}
function compare(a, b) {
  const oa = orderOf(a), ob = orderOf(b);
  if (oa !== ob) return oa - ob;
  const ta = (a && a.departTime) || "99:99", tb = (b && b.departTime) || "99:99";
  if (ta !== tb) return ta < tb ? -1 : 1;
  return String((a && a.name) || "").localeCompare(String((b && b.name) || ""), "ko");
}

(async () => {
  let fail = 0;
  const ok = (n, c, x) => { console.log(`  ${c ? "✓" : "✗"} ${n}${!c && x !== undefined ? " → " + JSON.stringify(x) : ""}`); if (!c) fail++; };

  const db = loadDb();
  const q = process.argv[2] || "채드윅";
  const pcSnap = await db.collection("partnerCodes").where("companyId", "==", COMPANY).get();
  const target = pcSnap.docs.map((d) => ({ code: d.id, ...(d.data() || {}) }))
    .find((c) => String(c.partnerName || "").includes(q));
  if (!target) { console.log("⏭ SKIP — 그 거래처가 없다"); process.exit(0); }

  const rSnap = await db.collection("companies").doc(COMPANY).collection("routes")
    .where("partnerCode", "==", target.code).get();
  const routes = rSnap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
  const expected = routes.slice().sort(compare).map((r) => String(r.name || "").trim()).filter(Boolean);
  const withOrder = routes.filter((r) => typeof r.order === "number").length;

  console.log(`\n대상: ${target.partnerName} · 노선 ${routes.length}개(order 지정 ${withOrder}개)`);
  console.log(`  BASE=${BASE}`);
  if (withOrder < 2) {
    console.log("⏭ SKIP — order 가 2개 미만이라 순서를 판정할 수 없다(관리자에서 ▲▼ 한 번도 안 쓴 거래처)");
    process.exit(0);
  }

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 }, locale: "ko-KR", timezoneId: "Asia/Seoul" });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.dismiss().catch(() => {}));

  await page.goto(`${BASE}/partner`, { waitUntil: "domcontentloaded" });
  await sleep(2500);
  await page.locator("input").first().fill(target.code);
  const btn = page.locator('button:has-text("확인"), button:has-text("인증"), button:has-text("다음")');
  if (await btn.count()) await btn.first().click().catch(() => {});
  await sleep(3500);
  await page.locator("button", { hasText: "운영 포털" }).first().click({ timeout: 10000 });
  await sleep(5000);

  // 카드 = '👤 N명' 을 가진 잎 요소 → 부모가 카드 본체, 첫 span 이 노선명.
  // 🔴 DOM 순서가 아니라 **화면 좌표(top, left)** 로 줄을 세운다 — 사람이 읽는 순서가 그것이다.
  const cards = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll("div").forEach((el) => {
      const t = el.textContent || "";
      if (!/👤\s*\d+명/.test(t)) return;
      if (el.querySelector("div") && [...el.querySelectorAll("div")].some((c) => /👤\s*\d+명/.test(c.textContent || ""))) return;
      const card = el.parentElement || el;
      const nameEl = card.querySelector("span");
      const r = card.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return;
      out.push({ name: (nameEl ? nameEl.textContent : "").trim(), top: Math.round(r.top), left: Math.round(r.left) });
    });
    return out;
  });
  await browser.close();

  const norm = (s) => String(s).replace(/\s+/g, " ").trim();
  const shown = cards
    .slice()
    .sort((a, b) => (a.top - b.top) || (a.left - b.left))
    .map((c) => norm(c.name))
    .filter(Boolean);

  console.log(`\n화면에 그려진 노선 카드 ${shown.length}개`);
  if (process.env.DEBUG) shown.forEach((s, i) => console.log(`    ${String(i + 1).padStart(2)}. ${s}`));

  ok("[0] 신호 있음 — 카드가 1개 이상 그려졌다(로그인·섹션 렌더 확인)", shown.length > 0, shown.length);
  if (shown.length === 0) { console.log("  ↳ 판정 불가"); process.exit(1); }

  // 화면엔 승객 배정으로 딸려온 다른 노선이 섞일 수 있다(합집합 규칙) →
  // **거래처 지정 노선만 뽑아** 그 상대 순서가 관리자 순서와 같은지 본다.
  const expSet = new Set(expected);
  const shownMine = shown.filter((s) => expSet.has(s));
  const expectedShown = expected.filter((n) => shownMine.includes(n));

  ok(`[1] 거래처 지정 노선이 화면에 다 있다(${expectedShown.length}/${expected.length})`,
    expectedShown.length === expected.length,
    expected.filter((n) => !shownMine.includes(n)).slice(0, 8));
  ok("[2] 화면 순서 = 관리자 노선 관리 순서", JSON.stringify(shownMine) === JSON.stringify(expectedShown),
    { 화면: shownMine.slice(0, 10), 관리자: expectedShown.slice(0, 10) });

  // 첫 어긋남 지점을 짚어 준다 — 대조군(옛 번들)에서 신고 화면을 재현할 때 쓴다.
  if (JSON.stringify(shownMine) !== JSON.stringify(expectedShown)) {
    const i = shownMine.findIndex((n, k) => n !== expectedShown[k]);
    console.log(`  ↳ ${i + 1}번째부터 갈린다: 화면 "${shownMine[i]}" · 관리자 "${expectedShown[i]}"`);
  }

  console.log(`\n${fail === 0 ? "✅ 통과" : `❌ ${fail}건 실패`}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("ERR", e && e.stack ? e.stack : e); process.exit(1); });
