// 협력사 포털 운영 포털 — "자사 노선" 카드가 그 거래처 노선을 **전부** 보여주는지 (2026-08-11 배시현 개선요청).
//   1) node docs/manual/_serve_build.mjs   (별도 터미널·3000 포트)
//   2) node scripts/headless_check_partner_ops_routes.cjs [거래처이름일부]
//   대조군(옛 번들 재현) = BASE=https://partner.buslink.co.kr node scripts/headless_check_partner_ops_routes.cjs
//
// 🔴 소스 단언이 아니라 **실제로 그려진 카드 수**를 Firestore 실값과 대조한다.
//    카드 수가 0 이면(로그인 실패·섹션 미렌더) 판정 자체가 무의미하므로 신호 유무를 0번으로 검사한다.
// prod 쓰기 0 — 업체코드로 로그인만 한다.
const path = require("path");
const fs = require("fs");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.BASE || "http://localhost:3000";
const COMPANY = "dy001";
const ROOT = path.join(__dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 🔴 탭은 셸에 따라 태그가 다르다 — PC(2026-09-02 어드민형 셸)는 <nav><div onClick>, 모바일은 <button>.
//    `locator("button",{hasText})` 로 잡으면 1280px 에서 0개가 되어 하네스가 통째로 죽는다
//    (2026-09-04 실측: 포털 하네스 5개가 09-02 이래 전부 죽어 있었다). 태그가 아니라 **라벨**로 잡는다.
const tabByLabel = (page, label) => page.locator("nav div, button").filter({ hasText: label }).first();


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

  const rSnap = await db.collection("companies").doc(COMPANY).collection("routes")
    .where("partnerCode", "==", target.code).get();
  const routeNames = rSnap.docs.map((d) => (d.data().name || "").trim()).filter(Boolean);
  const psSnap = await db.collection("companies").doc(COMPANY).collection("passengers")
    .where("partnerCode", "==", target.code).where("active", "==", true).get();
  const assigned = new Set(psSnap.docs.map((d) => d.data().routeId).filter(Boolean));
  const zeroPassengerNames = rSnap.docs.filter((d) => !assigned.has(d.id)).map((d) => (d.data().name || "").trim());

  console.log(`\n대상: ${target.partnerName} · 노선 ${routeNames.length}개 · 승객 배정 노선 ${assigned.size}개`);
  console.log(`  (승객 0명이라 예전엔 숨겨지던 노선 ${zeroPassengerNames.length}개)`);
  console.log(`  BASE=${BASE}`);

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: "ko-KR", timezoneId: "Asia/Seoul" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("dialog", (d) => d.dismiss().catch(() => {}));

  await page.goto(`${BASE}/partner`, { waitUntil: "domcontentloaded" });
  await sleep(2500);
  await page.locator("input").first().fill(target.code);
  const btn = page.locator('button:has-text("확인"), button:has-text("인증"), button:has-text("다음")');
  if (await btn.count()) await btn.first().click().catch(() => {});
  await sleep(3500);
  await tabByLabel(page, "운영 포털").click({ timeout: 10000 });
  await sleep(5000);

  // "🛣 자사 노선" 섹션의 카드 = 노선명 + '👤 N명' 을 함께 가진 요소
  const cards = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll("div").forEach((el) => {
      const t = el.textContent || "";
      if (!/👤\s*\d+명/.test(t)) return;
      if (el.querySelector("div") && [...el.querySelectorAll("div")].some((c) => /👤\s*\d+명/.test(c.textContent || ""))) return;
      // el = 카드 안쪽 '🕒 시각 👤 N명' 줄 → 카드 본체는 그 부모, 노선명은 부모의 첫 span
      const card = el.parentElement || el;
      const nameEl = card.querySelector("span");
      const r = card.getBoundingClientRect();
      // 잘림은 "줄바꿈 넣었으니 되겠지"가 아니라 픽셀로 잰다(2026-08-07 노선명 건과 같은 잣대).
      const clipped = nameEl
        ? (nameEl.scrollWidth > nameEl.clientWidth + 1 || nameEl.scrollHeight > nameEl.clientHeight + 1)
        : false;
      const fontPx = nameEl ? parseFloat(getComputedStyle(nameEl).fontSize) : 0;
      out.push({
        name: (nameEl ? nameEl.textContent : "").trim(),
        visible: r.width > 0 && r.height > 0,
        clipped, fontPx,
        overflowsCard: nameEl ? nameEl.getBoundingClientRect().right > r.right + 1 : false,
      });
    });
    return out;
  });
  const norm = (s) => String(s).replace(/\s+/g, " ").trim();
  const shown = cards.filter((c) => c.visible && c.name).map((c) => norm(c.name));

  console.log(`\n화면에 그려진 노선 카드 ${shown.length}개`);
  if (process.env.DEBUG) shown.forEach((s) => console.log(`    · ${s}`));
  ok("[0] 신호 있음 — 카드가 1개 이상 그려졌다(로그인·섹션 렌더 확인)", shown.length > 0, shown.length);
  if (shown.length === 0) { console.log("  ↳ 판정 불가 — 아래 검사는 건너뛴다"); await browser.close(); process.exit(1); }

  ok(`[1] 카드 수 ≥ 거래처 노선 수(${routeNames.length})`, shown.length >= routeNames.length, shown.length);
  const missing = routeNames.filter((n) => !shown.some((s) => s === n || n.startsWith(s.replace(/…$/, ""))));
  ok("[2] 빠진 노선 0개", missing.length === 0, missing.slice(0, 8));
  const zeroShown = zeroPassengerNames.filter((n) => shown.some((s) => s === n || n.startsWith(s.replace(/…$/, ""))));
  ok(`[3] 승객 0명 노선도 나온다(${zeroPassengerNames.length}개 중 ${zeroShown.length})`,
    zeroPassengerNames.length === 0 || zeroShown.length === zeroPassengerNames.length, zeroPassengerNames.length - zeroShown.length);
  // [4] 노선명 잘림 — 이름이 다 보이지 않으면 29개가 나와도 구분이 안 된다(2026-08-11 후속)
  const vis = cards.filter((c) => c.visible && c.name);
  const clipped = vis.filter((c) => c.clipped).map((c) => norm(c.name));
  const overflow = vis.filter((c) => c.overflowsCard).map((c) => norm(c.name));
  const longest = routeNames.reduce((a, b) => (b.length > a.length ? b : a), "");
  ok(`[4] 노선명 잘린 카드 0개(가장 긴 이름 ${longest.length}자)`, clipped.length === 0, clipped.slice(0, 5));
  ok("[5] 카드 밖으로 넘친 이름 0개", overflow.length === 0, overflow.slice(0, 5));
  ok("[6] 글자 크기 13px 유지(축소로 때우지 않았다)", vis.every((c) => c.fontPx >= 13), vis.map((c) => c.fontPx)[0]);
  ok("[7] 콘솔 오류 0", errors.length === 0, errors.slice(0, 3));

  const shot = process.env.SHOT || path.join(require("os").tmpdir(), "partner_ops_routes.png");
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
  console.log(`  (캡처: ${shot})`);
  await browser.close();
  console.log(`\n${fail === 0 ? "✅ 통과" : `❌ ${fail}건 실패`}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
