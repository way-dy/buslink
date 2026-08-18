// 협력사 포털 운영 포털 — "실시간 관제가 안 된다"(2026-08-18 배시현 개선요청 GUkjQFbT…) 검증.
//
//   1) node docs/manual/_serve_build.mjs   (별도 터미널·3000 포트)
//   2) node scripts/headless_check_partner_ops_buses.cjs [거래처이름일부]
//   대조군(옛 번들 재현) = BASE=https://partner.buslink.co.kr node scripts/headless_check_partner_ops_buses.cjs
//
// 🔴 소스 단언이 아니라 **지도에 실제로 그려진 버스 마커**를 Firestore 실값(gps 문서)과 대조한다.
//    근인이 "배차 읽기 권한이 없어 todayDispatches 가 항상 빈 배열" 이었으므로, 소스만 보면
//    고쳤는지 알 수 없다 — 화면에 버스가 뜨는지가 유일한 판정이다.
// 🔴 지금 운행 중인 차량이 0대면 판정 자체가 무의미하다 → **신호 유무를 검사 0번**으로 둔다
//    (운행 시간대가 아니면 SKIP 으로 끝난다. 초록으로 통과시키지 않는다).
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

(async () => {
  let fail = 0;
  const ok = (n, c, x) => { console.log(`  ${c ? "✓" : "✗"} ${n}${!c && x !== undefined ? " → " + x : ""}`); if (!c) fail++; };

  const db = loadDb();
  const q = process.argv[2] || "채드윅";
  const pcSnap = await db.collection("partnerCodes").where("companyId", "==", COMPANY).get();
  const target = pcSnap.docs.map((d) => ({ code: d.id, ...(d.data() || {}) }))
    .find((c) => String(c.partnerName || "").includes(q));
  if (!target) { console.log("⏭ SKIP — 그 거래처가 없다"); process.exit(0); }
  if (target.opsControlEnabled === false) { console.log("⏭ SKIP — 이 거래처는 관제 노출이 꺼져 있다"); process.exit(0); }

  // 기대치 = 이 거래처 노선(routes.partnerCode) ∪ 승객 배정 노선 에 속한 gps 문서
  //          (PartnerApp partnerOpsRoutes 와 같은 축 — 화면이 쓰는 기준으로 센다)
  const rSnap = await db.collection("companies").doc(COMPANY).collection("routes")
    .where("partnerCode", "==", target.code).get();
  const myRouteIds = new Set(rSnap.docs.map((d) => d.id));
  const psSnap = await db.collection("companies").doc(COMPANY).collection("passengers")
    .where("partnerCode", "==", target.code).where("active", "==", true).get();
  psSnap.docs.forEach((d) => { const rid = d.data().routeId; if (rid) myRouteIds.add(rid); });

  const gpsSnap = await db.collection("gps").where("companyId", "==", COMPANY).get();
  const expected = gpsSnap.docs.map((d) => d.data())
    .filter((g) => g.routeId && myRouteIds.has(g.routeId) && g.lat && g.lng);
  const expectedNos = expected.map((g) => String(g.vehicleNo || "").trim()).filter(Boolean).sort();

  console.log(`\n대상: ${target.partnerName} · 노선 ${myRouteIds.size}개 · BASE=${BASE}`);
  console.log(`Firestore 실값: 이 거래처 노선의 실시간 위치 ${expected.length}대`);
  expected.forEach((g) => console.log(`   · ${g.vehicleNo} | ${g.routeName}`));

  ok("[0] 신호 있음 — 지금 이 거래처 노선에 위치가 잡히는 차량이 1대 이상", expected.length > 0, expected.length);
  if (expected.length === 0) {
    console.log("  ↳ 지금은 운행 시간대가 아니다. 판정 불가 — 운행 시간에 다시 돌릴 것(SKIP).");
    process.exit(0);
  }

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
  await sleep(7000); // 지도 타일 + gps 스냅샷

  // 화면 실측 — 배지 문구 / 버스 마커(차량번호·둘째 줄) / 지도 타일
  const seen = await page.evaluate(() => {
    const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
    // 섹션 헤더 "📍 실시간 버스 위치" 의 오른쪽 배지
    let badge = "";
    document.querySelectorAll("span").forEach((el) => {
      if (norm(el.textContent) !== "📍 실시간 버스 위치") return;
      const next = el.nextElementSibling;
      if (next) badge = norm(next.textContent);
    });
    // 버스 마커 = <span>🚌</span> + 형제 div(차량번호 / 속도·신호 지연)
    const markers = [];
    document.querySelectorAll("span").forEach((el) => {
      if (norm(el.textContent) !== "🚌") return;
      const info = el.nextElementSibling;
      if (!info) return;
      const lines = [...info.querySelectorAll("div")].map((d) => norm(d.textContent));
      const r = el.getBoundingClientRect();
      markers.push({ no: lines[0] || "", sub: lines[1] || "", visible: r.width > 0 && r.height > 0 });
    });
    // 노선도 스트립에서 "운행 중" 으로 표시된 노선 수
    let stripRunning = 0;
    document.querySelectorAll("span").forEach((el) => { if (norm(el.textContent) === "운행 중") stripRunning++; });
    return { badge, markers, stripRunning, tiles: document.querySelectorAll("img[src*='map']").length };
  });

  const shownNos = seen.markers.filter((m) => m.visible && m.no).map((m) => m.no).sort();
  console.log(`\n화면: 배지 "${seen.badge}" · 버스 마커 ${shownNos.length}개 · 노선도 "운행 중" ${seen.stripRunning}개`);
  shownNos.forEach((n) => console.log(`   · ${n}`));

  ok(`[1] 배지가 "N대 운행 중" 이다(옛 화면은 "오늘 배차 없음")`, /\d+대 운행 중/.test(seen.badge), seen.badge);
  ok(`[2] 배지 대수 = 실값 ${expected.length}대`, seen.badge.startsWith(`${expected.length}대`), seen.badge);
  // ⚠ 마커 수는 실값과 **꼭 같지 않을 수 있다** — '전체' 보기는 축척이 넓어 지도 화면 범위
  //    밖 차량을 카카오가 그리지 않는다(2026-08-18 실측: 8대 중 판교 1대가 화면 밖). 그래서
  //    대수 판정은 **배지**(검사 2번·앱이 세는 값)로 하고, 여기서는 마커가 실제로 그려졌는지와
  //    **엉뚱한 차량이 섞이지 않았는지**를 본다. 빠진 대수는 아래에 그대로 찍는다(숨기지 않음).
  const notShown = expectedNos.filter((n) => !shownNos.includes(n));
  if (notShown.length) console.log(`  (지도 화면 범위 밖 ${notShown.length}대: ${notShown.join(", ")})`);
  ok("[3] 지도에 버스 마커가 그려졌다", shownNos.length > 0, shownNos.length);
  ok("[4] 그려진 마커가 전부 실값에 있는 차량이다(유령 마커 0)",
    shownNos.every((n) => expectedNos.includes(n)),
    `화면 ${JSON.stringify(shownNos)} vs 실값 ${JSON.stringify(expectedNos)}`);
  ok("[5] 마커 둘째 줄에 속도(또는 신호 지연) + 노선명", seen.markers.every((m) => !m.visible || /km\/h|신호 지연/.test(m.sub)),
    seen.markers.map((m) => m.sub).slice(0, 3));
  ok("[6] 노선도에도 '운행 중' 노선이 있다", seen.stripRunning > 0, seen.stripRunning);
  ok("[7] 콘솔 오류 0", errors.length === 0, errors.slice(0, 3));

  const shot = process.env.SHOT || path.join(require("os").tmpdir(), "partner_ops_buses.png");
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
  console.log(`  (캡처: ${shot})`);
  await browser.close();
  console.log(`\n${fail === 0 ? "✅ 통과" : `❌ ${fail}건 실패`}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
