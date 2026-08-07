// 승객앱 공지 배너 — 본문 2줄 미리보기 · **아래 화면을 안 가리는지** (2026-08-07 배시현 개선요청).
//   1) node docs/manual/_serve_build.mjs   (별도 터미널·3000 포트)
//   2) node scripts/headless_check_notice_banner.cjs
//
// 🔴 "줄 수를 묶었으니 안 가리겠지"로 넘기지 않는다 — 배너는 `position:fixed` 라
//    **배너 아래끝과 본문 시작점을 픽셀로 비교**해야 가림이 잡힌다.
//    실제로 신고 원인은 줄 수가 아니라 **본문 여백이 60px 고정**이었던 것이다.
// prod 쓰기 0 — 세션은 localStorage 주입, 공지는 prod 실데이터를 그대로 쓴다.
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
  // 가장 본문이 긴 활성 공지를 가진 거래처로 봐야 의미가 있다
  const nSnap = await db.collection("companies").doc(COMPANY).collection("notices")
    .where("active", "==", true).get();
  const notices = nSnap.docs.map((d) => d.data())
    .sort((a, b) => String(b.body || "").length - String(a.body || "").length);
  const top = notices[0];
  console.log(`\n활성 공지 ${notices.length}건 · 가장 긴 본문 ${top ? String(top.body || "").length : 0}자` +
    (top && top.partnerCode ? ` (협력사 ${top.partnerCode})` : " (전체 발송)"));
  if (top) console.log(`  제목: ${String(top.title || "").slice(0, 60)}`);
  if (!top) { console.log("⏭ SKIP — 활성 공지가 없다"); process.exit(0); }

  // 그 공지를 받는 승객으로 로그인(협력사 지정 공지면 그 협력사 승객)
  let q = db.collection("companies").doc(COMPANY).collection("passengers").limit(3);
  if (top.partnerCode) q = db.collection("companies").doc(COMPANY).collection("passengers")
    .where("partnerCode", "==", top.partnerCode).limit(3);
  const pSnap = await q.get();
  const p = pSnap.docs.map((d) => ({ empNo: d.id, ...(d.data() || {}) }))[0];
  if (!p) { console.log("⏭ SKIP — 대상 승객이 없다"); process.exit(0); }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "buslink-notice-"));
  const ctx = await chromium.launchPersistentContext(dir, {
    executablePath: CHROME, headless: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const errs = [];
  const ignorable = (t) => /kakao|dapi|favicon|manifest|Failed to load resource|net::ERR/i.test(t);
  page.on("console", (m) => { if (m.type() === "error" && !ignorable(m.text())) errs.push(m.text()); });
  page.on("pageerror", (e) => { if (!ignorable(e.message)) errs.push("pageerror: " + e.message); });

  await page.addInitScript((s) => window.localStorage.setItem("buslink_employee", JSON.stringify(s)),
    { empNo: p.empNo, name: p.name || "검토", dept: "검토", routeId: p.routeId || null,
      partnerCode: p.partnerCode || null, partnerName: p.partnerName || null, companyId: COMPANY });

  await page.goto(`${BASE}/p?c=${COMPANY}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(6000);
  // 강제 공지 모달·설치 안내를 닫아야 배너가 보인다(모달이 위를 덮는다)
  for (const label of ["확인했습니다", "나중에"]) {
    for (let i = 0; i < 3; i++) {
      const b = page.locator(`button:has-text("${label}")`).first();
      if (await b.count() && await b.isVisible().catch(() => false)) {
        await b.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(400);
      } else break;
    }
  }
  await page.waitForTimeout(1500);

  const m = await page.evaluate(() => {
    const bar = [...document.querySelectorAll("div")].find((d) => {
      const cs = getComputedStyle(d);
      return cs.position === "fixed" && cs.top === "0px" && /공지/.test(d.textContent || "");
    });
    if (!bar) return null;
    const br = bar.getBoundingClientRect();
    const body = [...bar.querySelectorAll("div")].find((d) =>
      d.children.length === 0 && !/^(🚨|📢)/.test((d.textContent || "").trim()) && !/탭하면/.test(d.textContent || ""));
    // 배너 바로 아래에 와야 하는 본문 컨테이너
    const content = [...document.querySelectorAll("div")].find((d) => {
      const cs = getComputedStyle(d);
      return cs.marginTop !== "0px" && parseFloat(cs.marginTop) > 20 && d.getBoundingClientRect().width > 300;
    });
    return {
      barH: Math.round(br.height),
      bodyLines: body ? Math.round(body.getBoundingClientRect().height / (parseFloat(getComputedStyle(body).lineHeight) || 16)) : null,
      bodyClipped: body ? body.scrollHeight > body.clientHeight + 1 : null,
      marginTop: content ? Math.round(parseFloat(getComputedStyle(content).marginTop)) : null,
      contentTop: content ? Math.round(content.getBoundingClientRect().top) : null,
    };
  });

  if (!m) { console.log("⏭ SKIP — 배너가 화면에 없다(그 승객에게 안 읽은 공지가 없음)"); await ctx.close(); process.exit(0); }
  console.log(`\n배너 높이 ${m.barH}px · 본문 ${m.bodyLines}줄(말줄임 ${m.bodyClipped ? "적용" : "없음"}) · 본문 여백 ${m.marginTop}px · 본문 시작 y=${m.contentTop}`);
  ok("본문 미리보기가 2줄 이하", m.bodyLines !== null && m.bodyLines <= 2, String(m.bodyLines));
  ok("긴 공지는 실제로 잘려 있다(2줄 미리보기가 동작)", m.bodyClipped === true);
  // 🔴 핵심 — 배너 아래끝보다 본문이 아래에서 시작해야 안 가려진다
  ok("🔴 배너가 아래 화면을 가리지 않는다", m.contentTop !== null && m.contentTop >= m.barH,
    `배너 ${m.barH}px vs 본문 시작 ${m.contentTop}`);
  ok("여백이 60px 고정이 아니라 배너 높이를 따라간다", m.marginTop === m.barH, `${m.marginTop} vs ${m.barH}`);
  ok("콘솔 오류 0건", errs.length === 0, errs.slice(0, 2).join(" | "));

  await page.screenshot({ path: path.join(dir, "notice.png") });
  console.log(`\n캡처: ${dir}`);
  await ctx.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("🔴", e.message); process.exit(1); });
