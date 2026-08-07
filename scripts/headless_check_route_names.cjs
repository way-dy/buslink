// 승객앱 노선 탭 — 노선명이 잘리지 않는지 · 협력사 표기 (2026-08-07 배시현 개선요청).
//   1) node docs/manual/_serve_build.mjs   (별도 터미널·3000 포트)
//   2) node scripts/headless_check_route_names.cjs [거래처이름일부]
//
// 🔴 "줄바꿈 넣었으니 다 보이겠지" 로 넘기지 않는다 — **잘렸는지를 픽셀로** 잰다
//    (`scrollWidth > clientWidth` 또는 `scrollHeight > clientHeight` 면 아직 잘린 것).
// prod 쓰기 0 — 세션은 localStorage 주입.
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

(async () => {
  let fail = 0;
  const ok = (n, c, x) => { console.log(`  ${c ? "✓" : "✗"} ${n}${!c && x !== undefined ? " → " + x : ""}`); if (!c) fail++; };

  const db = loadDb();
  const q = process.argv[2] || "채드윅";
  const pcSnap = await db.collection("partnerCodes").where("companyId", "==", COMPANY).get();
  const codes = pcSnap.docs.map((d) => ({ code: d.id, ...(d.data() || {}) }));
  const target = codes.find((c) => String(c.partnerName || "").includes(q)) || codes[0];
  if (!target) { console.log("⏭ SKIP — 거래처가 없다"); process.exit(0); }

  // 가장 긴 노선명을 가진 거래처로 봐야 의미가 있다
  const rSnap = await db.collection("companies").doc(COMPANY).collection("routes")
    .where("partnerCode", "==", target.code).get();
  const names = rSnap.docs.map((d) => d.data().name || "").sort((a, b) => b.length - a.length);
  console.log(`\n대상: ${target.partnerName} · 노선 ${names.length}개 · 가장 긴 이름 ${names[0] ? names[0].length : 0}자`);
  if (names[0]) console.log(`  "${names[0]}"`);

  const psSnap = await db.collection("companies").doc(COMPANY).collection("passengers")
    .where("partnerCode", "==", target.code).limit(3).get();
  const p = psSnap.docs.map((d) => ({ empNo: d.id, ...(d.data() || {}) }))[0];
  if (!p) { console.log("⏭ SKIP — 그 거래처 승객이 없다"); process.exit(0); }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "buslink-rname-"));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CHROME, headless: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const errs = [];
  const ignorable = (t) => /kakao|dapi|favicon|manifest|Failed to load resource|net::ERR/i.test(t);
  page.on("console", (m) => { if (m.type() === "error" && !ignorable(m.text())) errs.push(m.text()); });
  page.on("pageerror", (e) => { if (!ignorable(e.message)) errs.push("pageerror: " + e.message); });

  await page.addInitScript((s) => window.localStorage.setItem("buslink_employee", JSON.stringify(s)),
    { empNo: p.empNo, name: p.name || "검토", dept: "검토", routeId: p.routeId || null,
      partnerCode: target.code, partnerName: target.partnerName || null, companyId: COMPANY });

  await page.goto(`${BASE}/p?c=${COMPANY}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(6000);
  // 🔴 강제 공지 모달·설치 안내가 탭 클릭을 가로챈다(실제로 막혔다) — 전부 닫고 시작한다.
  for (const label of ["확인했습니다", "나중에", "✕"]) {
    for (let i = 0; i < 3; i++) {
      const b = page.locator(`button:has-text("${label}")`).first();
      if (await b.count() && await b.isVisible().catch(() => false)) {
        await b.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(400);
      } else break;
    }
  }
  await page.waitForTimeout(500);
  // 노선 탭으로 — 하단 탭바 버튼
  await page.locator('button:has-text("노선")').last().click({ timeout: 15000 });
  await page.waitForTimeout(3000);

  // ① 표기명
  const banner = await page.evaluate(() => {
    const el = [...document.querySelectorAll("div")].find((d) => /^선택된 /.test(d.textContent || "") && d.children.length === 0);
    return el ? el.textContent.trim() : null;
  });
  console.log(`\n안내 배너: ${banner}`);
  ok("'선택된 협력사' 로 표기", !!banner && banner.startsWith("선택된 협력사"), banner);
  ok("'거래처' 문구가 화면에 없다", !(await page.evaluate(() => document.body.innerText.includes("거래처"))));

  // ② 노선명 잘림 — 픽셀로 잰다
  const cut = await page.evaluate(() => {
    const out = [];
    for (const d of document.querySelectorAll("div")) {
      const t = (d.textContent || "").trim();
      if (!/등교|하교|출근|퇴근/.test(t) || d.children.length > 0) continue;
      const cs = getComputedStyle(d);
      if (Number(cs.fontSize.replace("px", "")) < 13) continue;   // 카드 제목만
      out.push({ text: t.slice(0, 44), w: Math.round(d.getBoundingClientRect().width),
        h: Math.round(d.getBoundingClientRect().height),
        clippedX: d.scrollWidth > d.clientWidth + 1, clippedY: d.scrollHeight > d.clientHeight + 1,
        size: cs.fontSize });
    }
    return out;
  });
  console.log(`\n노선 카드 제목 ${cut.length}개 (글자 ${cut[0] ? cut[0].size : "?"})`);
  cut.slice(0, 5).forEach((c) => console.log(`   ${c.w}×${c.h}px ${c.clippedX || c.clippedY ? "🔴잘림" : "온전"}  ${c.text}`));
  ok("노선명이 하나도 잘리지 않는다", cut.length > 0 && cut.every((c) => !c.clippedX && !c.clippedY),
    cut.filter((c) => c.clippedX || c.clippedY).map((c) => c.text).join(" | "));
  ok("글자 크기를 줄이지 않았다(14px 유지)", cut.every((c) => parseFloat(c.size) >= 14), cut[0] && cut[0].size);
  ok("두 줄 이상 쓰는 이름이 실제로 있다(줄바꿈이 동작한다)", cut.some((c) => c.h > 24), String(Math.max(...cut.map((c) => c.h))));

  await page.screenshot({ path: path.join(userDataDir, "routes.png") });
  ok("콘솔 오류 0건", errs.length === 0, errs.slice(0, 2).join(" | "));
  console.log(`\n캡처: ${userDataDir}`);
  await ctx.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("🔴", e.message); process.exit(1); });
