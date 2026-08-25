// 노선 탭 카드 — 특이사항 꼬리표(`… - 조기출근`)가 실제로 진하게 그려지는지 검사.
//   2026-08-25 최우석 캡처 요청 회귀 가드.
//
//   node scripts/headless_check_route_note_bold.cjs              (기본 = prod)
//   BASE=http://localhost:3000 node scripts/headless_check_route_note_bold.cjs
//
// 🔴 "굵어 보인다"를 눈으로 판정하지 말고 **계산된 fontWeight 를 픽셀 쪽에서 읽어** 잠근다.
//    꼬리표가 있는 노선이 신촌세브란스에 딱 1개라(prod 실측 112개 중 2개) 대상 노선이
//    목록에 없으면 검사가 공허 통과한다 → "대상을 찾았나" 단언을 먼저 둔다.
// prod 쓰기 0.
const path = require("path");
const os = require("os");
const fs = require("fs");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.BASE || "https://p.buslink.co.kr";
const COMPANY = "dy001";
const ROOT = path.join(__dirname, "..");
const QUERY = process.argv[2] || "신촌";

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

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notebold-"));
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
  // 하단 탭바 '노선'(완전일치 + 화면 최하단 — 헤더의 '노선 변경'과 구분)
  await page.evaluate(() => {
    const tabs = [...document.querySelectorAll("button")].filter((b) => (b.textContent || "").trim() === "노선");
    tabs.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    if (tabs[0]) tabs[0].click();
  });
  await page.waitForTimeout(3000);

  const r = await page.evaluate(() => {
    // 카드 제목 = fontSize 14 + fontWeight 700 인 div 중 노선명이 든 것
    const titles = [...document.querySelectorAll("div")].filter((d) => {
      const s = getComputedStyle(d);
      return s.fontSize === "14px" && s.fontWeight === "700" && (d.textContent || "").trim().length > 3;
    });
    const withNote = titles.filter((d) => / - /.test((d.textContent || "").trim()));
    const out = withNote.map((d) => {
      const spans = [...d.querySelectorAll("span")];
      const bold = spans.filter((s) => Number(getComputedStyle(s).fontWeight) >= 800);
      return {
        text: (d.textContent || "").trim(),
        boldParts: bold.map((s) => ({ t: (s.textContent || "").trim(), w: getComputedStyle(s).fontWeight, c: getComputedStyle(s).color })),
      };
    });
    return { titleCount: titles.length, noteRows: out };
  });

  console.log(`\n[노선 탭 카드]`);
  console.log(`  제목 ${r.titleCount}개 · 꼬리표 있는 노선 ${r.noteRows.length}개`);
  r.noteRows.forEach((x) => console.log(`    "${x.text}" → 진한 부분 ${JSON.stringify(x.boldParts)}`));

  ok("카드가 실제로 그려졌다(검사 성립)", r.titleCount > 0, r.titleCount);
  ok("꼬리표 있는 노선을 찾았다(검사 성립)", r.noteRows.length > 0, r.noteRows.length);
  ok("🔴 꼬리표가 본문보다 진하다(weight ≥ 800)",
    r.noteRows.length > 0 && r.noteRows.every((x) => x.boldParts.length === 1), r.noteRows);
  ok("진한 부분이 꼬리표 그 자체다(앞부분이 섞이지 않았다)",
    r.noteRows.every((x) => x.boldParts.every((b) => x.text.endsWith(b.t))), r.noteRows);
  ok("콘솔 런타임 오류 0", errs.length === 0, errs.slice(0, 3));

  const shot = path.join(dir, "routes.png");
  await page.screenshot({ path: shot });
  console.log(`\n스크린샷: ${shot}`);
  await ctx.close();
  console.log(fail === 0 ? "\n✅ 전부 통과" : `\n❌ ${fail}건 실패`);
  process.exit(fail === 0 ? 0 : 1);
})();
