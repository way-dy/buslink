// 협력사 포털 구분 필터(등교/하교/방과후) + 마커 축소 — 실화면 검증(2026-08-18 배시현 후속 요청).
//
//   1) node docs/manual/_serve_build.mjs   (별도 터미널·3000 포트)
//   2) node scripts/headless_check_partner_kind_filter.cjs [거래처이름일부]
//   대조군(옛 번들) = BASE=https://partner.buslink.co.kr node scripts/headless_check_partner_kind_filter.cjs
//
// 🔴 칩을 눌러 **실제로 카드 수가 줄어드는지**를 Firestore 실값과 대조한다(칩 렌더만 보면
//    "필터가 안 걸리는 필터"도 통과한다). 마커 크기는 **픽셀로** 잰다(축소 요청이라 눈대중 금지).
// prod 쓰기 0 — 업체코드로 로그인만 한다.
const path = require("path");
const fs = require("fs");
const vm = require("vm");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.BASE || "http://localhost:3000";
const COMPANY = "dy001";
const ROOT = path.join(__dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 승객앱 노선 지도 마커와 같은 치수(2026-08-18) — 이 값을 넘으면 "축소" 가 아니다.
const MAX_MARKER_W = 132, MAX_MARKER_H = 34;

function loadKind() {
  const src = fs.readFileSync(path.join(ROOT, "src/lib/routeKind.js"), "utf8")
    .replace(/^export const /gm, "const ").replace(/^export function /gm, "function ");
  const ctx = { console }; vm.createContext(ctx);
  vm.runInContext(src + "\n;this.__m={routeKind,availableRouteKinds,filterRoutesByKind};", ctx);
  return ctx.__m;
}
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

  const { routeKind, availableRouteKinds } = loadKind();
  const db = loadDb();
  const q = process.argv[2] || "채드윅";
  const pcSnap = await db.collection("partnerCodes").where("companyId", "==", COMPANY).get();
  const target = pcSnap.docs.map((d) => ({ code: d.id, ...(d.data() || {}) }))
    .find((c) => String(c.partnerName || "").includes(q));
  if (!target) { console.log("⏭ SKIP — 그 거래처가 없다"); process.exit(0); }

  const rSnap = await db.collection("companies").doc(COMPANY).collection("routes")
    .where("partnerCode", "==", target.code).get();
  const routes = rSnap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
  const kinds = availableRouteKinds(routes);
  const expect = {};
  kinds.forEach((k) => { expect[k] = routes.filter((r) => routeKind(r) === k).length; });

  console.log(`\n대상: ${target.partnerName} · 노선 ${routes.length}개 · BASE=${BASE}`);
  console.log(`Firestore 실값 구분: ${kinds.map((k) => `${k} ${expect[k]}`).join(" · ")}`);
  ok("[0] 신호 있음 — 구분이 2개 이상이라 필터가 의미 있다", kinds.length >= 2, kinds.length);
  if (kinds.length < 2) { console.log("  ↳ 판정 불가(SKIP)"); process.exit(0); }

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 }, locale: "ko-KR", timezoneId: "Asia/Seoul" });
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
  await page.locator("button", { hasText: "운영 포털" }).first().click({ timeout: 10000 });
  await sleep(7000);

  const countCards = () => page.evaluate(() => {
    let n = 0;
    document.querySelectorAll("div").forEach((el) => {
      const t = el.textContent || "";
      if (!/👤\s*\d+명/.test(t)) return;
      if (el.querySelector("div") && [...el.querySelectorAll("div")].some((c) => /👤\s*\d+명/.test(c.textContent || ""))) return;
      n++;
    });
    return n;
  });

  const all = await countCards();
  ok(`[1] '전체'에서 카드 ${routes.length}개`, all === routes.length, all);

  for (const k of kinds) {
    const chip = page.locator("button", { hasText: new RegExp(`^${k}$`) }).first();
    const has = await chip.count();
    ok(`[2:${k}] 칩이 있다`, has > 0);
    if (!has) continue;
    await chip.click();
    await sleep(1200);
    const n = await countCards();
    ok(`[3:${k}] 카드 ${expect[k]}개로 줄어든다`, n === expect[k], n);
    await chip.click(); // 해제
    await sleep(800);
  }

  // 🔴 '하교' 를 골랐을 때 방과후가 안 섞이는지 — 요청의 핵심
  const hagyo = page.locator("button", { hasText: /^하교$/ }).first();
  if (await hagyo.count()) {
    await hagyo.click(); await sleep(1200);
    const names = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll("div").forEach((el) => {
        const t = el.textContent || "";
        if (!/👤\s*\d+명/.test(t)) return;
        if (el.querySelector("div") && [...el.querySelectorAll("div")].some((c) => /👤\s*\d+명/.test(c.textContent || ""))) return;
        const card = el.parentElement || el; const s = card.querySelector("span");
        if (s) out.push((s.textContent || "").trim());
      });
      return out;
    });
    ok("[4] '하교'에 방과후가 섞이지 않는다", names.every((n) => !/방과\s*후|Late Activity/i.test(n)),
      names.filter((n) => /방과/.test(n)).slice(0, 3));
    await hagyo.click(); await sleep(800);
  }

  // 마커 크기 — 픽셀 실측
  const marker = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll("svg").forEach((svg) => {
      const pill = svg.closest("div");
      if (!pill) return;
      const t = (pill.textContent || "");
      if (!/km\/h|신호 지연/.test(t)) return;
      const r = pill.getBoundingClientRect();
      if (r.width > 0) out.push({ w: Math.round(r.width), h: Math.round(r.height), t: t.trim().slice(0, 30) });
    });
    return out;
  });
  console.log(`  버스 마커 ${marker.length}개 ${marker.slice(0, 3).map((m) => `${m.w}×${m.h}`).join(", ")}`);
  if (marker.length === 0) {
    console.log("  ⏭ 지금 운행 중인 버스가 없어 마커 크기 검사는 건너뛴다(운행 시간에 재실행)");
  } else {
    ok(`[5] 마커가 ${MAX_MARKER_W}×${MAX_MARKER_H}px 이내(축소 확인)`,
      marker.every((m) => m.w <= MAX_MARKER_W && m.h <= MAX_MARKER_H),
      marker.map((m) => `${m.w}×${m.h}`).join(","));
    ok("[6] 축소해도 차량번호는 남아 있다", marker.every((m) => /[가-힣0-9]{2,}/.test(m.t)), marker[0].t);
  }
  ok("[7] 콘솔 오류 0", errors.length === 0, errors.slice(0, 3));

  const shot = process.env.SHOT || path.join(require("os").tmpdir(), "partner_kind_filter.png");
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
  console.log(`  (캡처: ${shot})`);
  await browser.close();
  console.log(`\n${fail === 0 ? "✅ 통과" : `❌ ${fail}건 실패`}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
