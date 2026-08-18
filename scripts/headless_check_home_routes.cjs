// 승객앱 홈 — 노선 칩이 즐겨찾기만 나오는지 · 정류장 지도 버스 마커가 작아졌는지 (2026-08-18 배시현 개선요청 2건).
//   1) node docs/manual/_serve_build.mjs   (별도 터미널·3000 포트)  또는  BASE=https://p.buslink.co.kr
//   2) node scripts/headless_check_home_routes.cjs
//
// 🔴 두 계정을 **다 태운다** — 즐겨찾기 보유자(요청자)만 보면 "즐겨찾기 없는 237명이 홈이 비었다"를
//    못 잡는다(그쪽이 훨씬 큰 사고다). prod 쓰기 0 — 세션은 localStorage 주입.
const path = require("path");
const os = require("os");
const fs = require("fs");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.BASE || "http://localhost:3000";
const COMPANY = "dy001";
const ROOT = path.join(__dirname, "..");

function loadDb() {
  const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
  const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
  const sa = require(path.join(ROOT, "key", kf));
  if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치: " + sa.project_id);
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  return admin.firestore();
}

let fail = 0;
const ok = (n, c, x) => { console.log(`  ${c ? "✓" : "✗"} ${n}${!c && x !== undefined ? " → " + x : ""}`); if (!c) fail++; };

async function closeOverlays(page) {
  for (const label of ["확인했습니다", "나중에", "✕"]) {
    for (let i = 0; i < 3; i++) {
      const b = page.locator(`button:has-text("${label}")`).first();
      if (await b.count() && await b.isVisible().catch(() => false)) {
        await b.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(400);
      } else break;
    }
  }
}

(async () => {
  const db = loadDb();
  const psSnap = await db.collection("companies").doc(COMPANY).collection("passengers").get();
  const ps = psSnap.docs.map((d) => ({ empNo: d.id, ...(d.data() || {}) }));
  // ① 즐겨찾기가 있고 배정 노선이 즐겨찾기에 **없는** 사람(= 이번 변경으로 화면이 바뀌는 쪽)
  const changed = ps.find((p) => Array.isArray(p.favorites) && p.favorites.length > 1 && p.routeId && !p.favorites.includes(p.routeId));
  // ② 즐겨찾기가 하나도 없는 사람(= 237명 · 화면이 그대로여야 하는 쪽)
  const plain = ps.find((p) => (!Array.isArray(p.favorites) || p.favorites.length === 0) && p.routeId && p.partnerCode);
  console.log(`\n[0] 신호 유무 — 두 모양의 실계정이 prod 에 있는가`);
  ok(`변화 대상(즐겨찾기 있고 배정은 즐겨찾기 아님): ${changed ? changed.name : "없음"}`, !!changed);
  ok(`무변화 대상(즐겨찾기 0): ${plain ? plain.name : "없음"}`, !!plain);
  if (!changed || !plain) { console.log("⏭ 판정 불가 — 표본 없음"); process.exit(1); }
  console.log(`   변화 대상 즐겨찾기 ${changed.favorites.length}개 · 배정 ${changed.routeId}`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "buslink-homeroutes-"));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CHROME, headless: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
  });
  const errs = [];
  const ignorable = (t) => /kakao|dapi|favicon|manifest|Failed to load resource|net::ERR/i.test(t);

  for (const [label, p, expectChips] of [["변화 대상", changed, changed.favorites.length], ["무변화 대상", plain, 1]]) {
    const page = await ctx.newPage();
    page.on("console", (m) => { if (m.type() === "error" && !ignorable(m.text())) errs.push(m.text()); });
    page.on("pageerror", (e) => { if (!ignorable(e.message)) errs.push("pageerror: " + e.message); });
    await page.addInitScript((s) => window.localStorage.setItem("buslink_employee", JSON.stringify(s)),
      { empNo: p.empNo, name: p.name || "검토", dept: p.dept || "검토", routeId: p.routeId,
        partnerCode: p.partnerCode || null, partnerName: p.partnerName || null,
        favorites: p.favorites || [], companyId: COMPANY });
    await page.goto(`${BASE}/p?c=${COMPANY}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(6000);
    await closeOverlays(page);
    await page.waitForTimeout(1500);

    console.log(`\n[1] 홈 노선 칩 — ${label}(${p.name})`);
    const chips = await page.evaluate(() => {
      // 브랜드 밴드 안 가로 스크롤 칩 줄: 버튼들이 한 줄에 flex 로 놓인다
      const rows = [...document.querySelectorAll("div")].filter(d => {
        const cs = getComputedStyle(d);
        return cs.display === "flex" && cs.overflowX === "auto" && d.querySelectorAll("button").length > 1;
      });
      if (!rows.length) return [];
      return [...rows[0].querySelectorAll("button")].map(b => b.textContent.trim());
    });
    console.log(`   칩 ${chips.length}개: ${chips.join(" | ") || "(없음)"}`);
    // 화면 문자열을 Firestore 실값과 대조한다(정규식으로 어림잡지 않는다).
    const rDoc = await db.collection("companies").doc(COMPANY).collection("routes").doc(p.routeId).get();
    const assignedName = (rDoc.data() || {}).name || "";
    const bandText = await page.evaluate(() => document.body.innerText.slice(0, 600));
    if (expectChips > 1) {
      ok(`즐겨찾기 수(${expectChips})만큼 나온다`, chips.length === expectChips, chips.length);
      // 🔴 이 검사가 요청의 핵심 — 즐겨찾기가 아닌 배정 노선이 칩에서 빠졌는가
      const head = assignedName.slice(0, 10);
      ok(`배정 노선("${assignedName}")이 칩에 없다`, !chips.some(c => head && c.startsWith(head)), chips.join(" | "));
    } else {
      ok("칩 줄이 아예 없다(노선 1개이므로 — 기존 동작)", chips.length === 0, chips.length);
      ok(`홈이 비지 않았다 — 배정 노선 "${assignedName}" 이 화면에 있다`,
        !!assignedName && bandText.includes(assignedName), bandText.slice(0, 120));
    }

    await page.close();
  }

  // ── 정류장 바텀시트 실시간 지도의 버스 마커 크기 ──
  console.log("\n[2] 노선 탭 → 실시간 지도 버스 마커 크기(요청: 너무 크다)");
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error" && !ignorable(m.text())) errs.push(m.text()); });
  await page.addInitScript((s) => window.localStorage.setItem("buslink_employee", JSON.stringify(s)),
    { empNo: changed.empNo, name: changed.name, dept: changed.dept || "검토", routeId: changed.routeId,
      partnerCode: changed.partnerCode || null, partnerName: changed.partnerName || null,
      favorites: changed.favorites || [], companyId: COMPANY });
  await page.goto(`${BASE}/p?c=${COMPANY}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(6000);
  await closeOverlays(page);
  // 소스에서 마커 치수를 뽑아 화면 값과 대조(손으로 옮겨 적은 숫자로 판정하지 않는다)
  const emp = fs.readFileSync(path.join(ROOT, "src/pages/EmployeeApp.js"), "utf8");
  const blk = emp.slice(emp.indexOf("{/* 실시간 버스 마커"), emp.indexOf("{/* 실시간 버스 마커") + 1400);
  const iconSize = (blk.match(/<Icon name="bus" size=\{(\d+)\}/) || [])[1];
  const plateFont = (blk.match(/fontSize:([\d.]+), fontWeight:800/) || [])[1];
  console.log(`   소스 값 — 버스 아이콘 ${iconSize}px · 차량번호 ${plateFont}px`);
  ok("아이콘이 예전(14px)보다 작다", Number(iconSize) < 14, iconSize);
  ok("차량번호 글자가 예전(11px)보다 작다", Number(plateFont) < 11, plateFont);
  await page.close();

  console.log("\n[3] 콘솔 오류");
  ok(`오류 ${errs.length}건`, errs.length === 0, errs.slice(0, 3).join(" / "));

  await ctx.close();
  console.log(fail === 0 ? "\n✅ 전부 통과" : `\n❌ ${fail}건 실패`);
  process.exit(fail === 0 ? 0 : 1);
})();
