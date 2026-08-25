// 노선 탭 → 정류장 목록 — 계획/예상 줄이 살아 있고 '조기도착' 배지가 없는지 검사.
//   2026-08-24 배시현 "정류장탭 조기도착 표기 제거" 요청 회귀 가드.
//
//   1) node docs/manual/_serve_build.mjs   (별도 터미널)
//   2) node scripts/headless_check_stop_list_labels.cjs [거래처이름일부]
//      BASE=https://p.buslink.co.kr node scripts/headless_check_stop_list_labels.cjs   (대조군)
//
// 🔴 이 검사만으로는 부족하다 — 조기도착 배지는 **차가 계획보다 일찍 도착한 순간에만** 뜬다.
//    운행 시간이 아니면 대조군(옛 prod)에서도 안 보이므로 "사라졌다"를 증명하지 못한다.
//    계산 쪽 증명은 `scripts/test_early_arrival_delay.cjs`(화면 재현 격리 테스트)가 맡고,
//    여기서는 **모달이 안 깨지고 계획·예상 줄이 그대로 남아 있는지**를 잠근다.
// prod 쓰기 0.
const path = require("path");
const os = require("os");
const fs = require("fs");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.BASE || "http://localhost:3000";
const COMPANY = "dy001";
const ROOT = path.join(__dirname, "..");
const QUERY = process.argv[2] || "채드윅";

function loadDb() {
  const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
  const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
  const sa = require(path.join(ROOT, "key", kf));
  if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치");
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  return admin.firestore();
}

(async () => {
  let fail = 0;
  const ok = (n, c, x) => { console.log(`  ${c ? "✓" : "✗"} ${n}${!c && x !== undefined ? " → " + JSON.stringify(x) : ""}`); if (!c) fail++; };

  const db = loadDb();
  const pc = await db.collection("partnerCodes").where("companyId", "==", COMPANY).get();
  const codes = pc.docs.map((d) => ({ code: d.id, ...(d.data() || {}) }));
  const target = codes.find((c) => String(c.partnerName || "").includes(QUERY)) || codes[0];
  const ps = await db.collection("companies").doc(COMPANY).collection("passengers")
    .where("partnerCode", "==", target.code).limit(1).get();
  if (ps.empty) { console.log("⏭ SKIP — 승객 없음"); process.exit(0); }
  const p = { empNo: ps.docs[0].id, ...ps.docs[0].data() };
  console.log(`\n대상: ${target.partnerName} · 승객 ${p.empNo} · ${BASE}`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stoplist-"));
  const ctx = await chromium.launchPersistentContext(dir, {
    executablePath: CHROME, headless: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.addInitScript((s) => localStorage.setItem("buslink_employee", JSON.stringify(s)),
    { empNo: p.empNo, name: p.name || "검토", dept: p.dept || "검토", routeId: p.routeId || null,
      partnerCode: target.code, partnerName: target.partnerName || null, companyId: COMPANY });
  await page.goto(`${BASE}/p?c=${COMPANY}`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(9000);
  for (const label of ["확인했습니다", "나중에", "✕"]) {
    for (let i = 0; i < 3; i++) {
      const b = page.locator(`button:has-text("${label}")`).first();
      if (await b.count() && await b.isVisible().catch(() => false)) { await b.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(400); } else break;
    }
  }

  // ── 홈 노선도 스트립 시각 — 계획시각이어야 한다(2026-08-24 배시현 요청 1) ──
  const strip = await page.evaluate(() => {
    const el = document.querySelector("[data-route-strip]");
    if (!el) return { found: false };
    const cols = [...el.querySelectorAll(":scope > div > div > div")].filter((d) => d.style.width === "86px");
    return {
      found: true,
      times: cols.map((c) => {
        const t = [...c.children].map((k) => (k.textContent || "").trim()).find((x) => /^\d{2}:\d{2}$/.test(x));
        return t || null;
      }),
      names: cols.map((c) => {
        const k = [...c.children].find((x) => x.style.WebkitLineClamp === "2");
        return (k?.textContent || "").trim().slice(0, 12);
      }),
    };
  });
  console.log("\n[홈 노선도 스트립 시각]");
  if (strip.found) strip.names.forEach((n, i) => console.log(`     ${String(n).padEnd(14)} ${strip.times[i] || "-"}`));
  else console.log("     (스트립 없음)");
  // 🔴 첫 정류장 시각 = 노선 출발시각(departTime)이어야 한다. 차가 미리 와서 대기하면
  //    예전엔 그 도착시각(예: 06:44)이 떴다 — 이 요청의 본론이다.
  if (strip.found && strip.times[0] && p.routeId) {
    const rs = await db.collection("companies").doc(COMPANY).collection("routes").doc(p.routeId).get();
    const depart = rs.exists ? (rs.data() || {}).departTime : null;
    if (depart) ok(`첫 정류장 시각 = 노선 출발시각 ${depart}`, strip.times[0] === depart,
      { 화면: strip.times[0], 출발시각: depart });
  }

  // 하단 탭바의 '노선' — 🔴 `has-text("노선")` 로 잡으면 헤더의 **'노선 변경'** 버튼이 먼저
  //    걸려 다른 시트가 열린다(2026-08-25 실측). 글자가 정확히 '노선'이고 화면 맨 아래인 것만.
  await page.evaluate(() => {
    const tabs = [...document.querySelectorAll("button")].filter((b) => (b.textContent || "").trim() === "노선");
    if (!tabs.length) return;
    tabs.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    tabs[0].click();
  });
  await page.waitForTimeout(2500);
  // 노선 카드의 '정류장' 버튼 → 바텀시트(정류장 목록/실시간 지도/거리뷰).
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "정류장");
    if (b) b.click();
  });
  await page.waitForTimeout(4000);

  const r = await page.evaluate(() => {
    const body = document.body.innerText;
    const sheetOpen = body.includes("정류장 목록") && body.includes("실시간 지도");
    // 계획/예상 줄 = "계획 HH:MM" 또는 "도착 HH:MM" 또는 "예상 HH:MM"
    const planRows = (body.match(/계획 \d{2}:\d{2}/g) || []).length;
    const arrivedRows = (body.match(/도착 \d{2}:\d{2}/g) || []).length;
    const estRows = (body.match(/예상 \d{2}:\d{2}/g) || []).length;
    const early = (body.match(/조기도착 \d+분/g) || []);
    const late = (body.match(/지연 \d+분/g) || []);
    return { sheetOpen, planRows, arrivedRows, estRows, early, late };
  });

  console.log("\n[노선 탭 · 정류장 목록]");
  console.log(`  계획 ${r.planRows}줄 · 도착 ${r.arrivedRows}줄 · 예상 ${r.estRows}줄 · 조기도착 ${r.early.length}건 · 지연 ${r.late.length}건`);
  ok("바텀시트가 열렸다(검사 성립)", r.sheetOpen);
  ok("계획·도착·예상 줄이 남아 있다", r.planRows + r.arrivedRows + r.estRows > 0,
    { 계획: r.planRows, 도착: r.arrivedRows, 예상: r.estRows });
  ok("🔴 '조기도착' 배지 0건", r.early.length === 0, r.early);
  ok("콘솔 런타임 오류 0", errs.length === 0, errs.slice(0, 3));

  const shot = path.join(dir, "stoplist.png");
  await page.screenshot({ path: shot, fullPage: false });
  console.log(`\n스크린샷: ${shot}`);
  await ctx.close();
  console.log(fail === 0 ? "\n✅ 전부 통과" : `\n❌ ${fail}건 실패`);
  process.exit(fail === 0 ? 0 : 1);
})();
