// QR 탑승 3단계 — 진입 즉시 카메라 · 확인 터치 없음 (2026-09-02 세브란스병원 총무팀 요청)
//   1) node docs/manual/_serve_build.mjs   (별도 터미널)
//   2) node scripts/headless_check_quick_boarding.cjs
//      BASE=https://p.buslink.co.kr EMP=SAMPLE-SEC node scripts/headless_check_quick_boarding.cjs
//
// 🔴 두 갈래를 **둘 다** 태운다 — 한쪽만 보면 반쪽이다.
//   [A] 카메라 있음(가짜 장치) → 탭을 누르는 것만으로 스캔 화면까지 간다("카메라 열기"를 안 누른다)
//   [B] 카메라 없음           → 자동 시작이 실패해도 앱이 죽지 않고 오류 화면 + "다시 시도" 가 남는다
//   실제 태깅(QR 인식 → 탑승 적재)은 여기서 하지 않는다 — prod 에 가짜 탑승이 쌓인다
//   (2026-08-25 실제로 밟은 사고). 태깅 이후 로직은 격리 테스트가 잠근다.
const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.BASE || "http://localhost:3000";
const COMPANY = "dy001";
const EMP = process.env.EMP || "SAMPLE-SEC";
const ROOT = path.join(__dirname, "..");

function loadAdmin() {
  const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
  const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
  const sa = require(path.join(ROOT, "key", kf));
  if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치");
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(sa) });
  return admin;
}

// 화면이 어느 단계인지 문구로 읽는다(내부 state 가 아니라 사용자가 보는 것).
const READ = () => {
  const txt = document.body.innerText || "";
  const btn = (t) => [...document.querySelectorAll("button")].some((b) => (b.textContent || "").trim() === t);
  return {
    hasVideo: !!document.querySelector("video"),
    scanHint: txt.includes("QR코드를 사각형 안에 맞춰주세요"),
    openCamBtn: btn("카메라 열기") || txt.includes("카메라 열기"),
    confirmBtn: btn("탑승 확인") || txt.includes("탑승 확인"),
    errorScreen: txt.includes("오류") && (txt.includes("카메라") || txt.includes("QR")),
    retryBtn: btn("다시 시도"),
    head: txt.slice(0, 160).replace(/\n/g, " / "),
  };
};

(async () => {
  let fail = 0;
  const ok = (n, c, x) => { console.log(`  ${c ? "✓" : "✗"} ${n}${!c && x !== undefined ? " → " + JSON.stringify(x) : ""}`); if (!c) fail++; };

  const admin = loadAdmin();
  const db = admin.firestore();
  const pdoc = await db.collection("companies").doc(COMPANY).collection("passengers").doc(EMP).get();
  if (!pdoc.exists) { console.log(`⏭ SKIP — 승객 ${EMP} 없음`); process.exit(0); }
  const p = { empNo: pdoc.id, ...(pdoc.data() || {}) };
  console.log(`\n대상: ${p.partnerName || p.partnerCode} · 승객 ${p.empNo} · ${BASE}`);

  const resumeToken = crypto.randomBytes(32).toString("hex");
  const sessRef = db.collection("companies").doc(COMPANY).collection("passengerSessions")
    .doc(crypto.createHash("sha256").update(resumeToken).digest("hex"));
  await sessRef.set({
    companyId: COMPANY, empNo: p.empNo,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    lastUsedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qrquick-"));
  const CASES = [
    { key: "A", name: "카메라 있음(가짜 장치)", args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
    { key: "B", name: "카메라 없음", args: [] },
  ];

  try {
    for (const cs of CASES) {
      const ctx = await chromium.launchPersistentContext(path.join(dir, cs.key), {
        executablePath: CHROME, headless: true, args: cs.args,
        viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
      });
      const page = await ctx.newPage();
      const errs = [];
      page.on("pageerror", (e) => errs.push(e.message));
      await page.addInitScript((s) => window.localStorage.setItem("buslink_employee", JSON.stringify(s)),
        { empNo: p.empNo, name: p.name || "검토", dept: p.dept || "검토", routeId: p.routeId || null,
          partnerCode: p.partnerCode || null, partnerName: p.partnerName || null, companyId: COMPANY, resumeToken });
      await page.goto(`${BASE}/p?c=${COMPANY}`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(9000);
      for (const label of ["확인했습니다", "나중에", "✕"]) {
        for (let i = 0; i < 3; i++) {
          const b = page.locator(`button:has-text("${label}")`).first();
          if (await b.count() && await b.isVisible().catch(() => false)) { await b.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(400); } else break;
        }
      }

      console.log(`\n[${cs.key}] ${cs.name}`);
      // 하단 탭바의 "탑승" — 🔴 부분일치로 고르면 다른 라벨에 먼저 걸린다(2026-08-25 교훈).
      //    완전일치 + 화면 맨 아래로 고른다.
      const clicked = await page.evaluate(() => {
        const c = [...document.querySelectorAll("button")].filter((b) => (b.textContent || "").trim() === "탑승");
        if (!c.length) return false;
        c.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
        c[0].click(); return true;
      });
      ok("탑승 탭을 눌렀다(검사 성립)", clicked);
      if (!clicked) { await ctx.close(); continue; }
      await page.waitForTimeout(3500);

      const r = await page.evaluate(READ);
      console.log(`    화면: ${r.head}`);
      await page.screenshot({ path: path.join(dir, `scan-${cs.key}.png`) });

      // 🔴 두 경우 모두 — 확인 터치는 사라졌고, ready(카메라 열기)에 머물지 않는다.
      ok('"탑승 확인" 버튼이 없다', !r.confirmBtn, r);
      ok('"카메라 열기"(ready) 에 머물지 않는다 — 자동으로 시작했다', !r.openCamBtn, r);

      if (cs.key === "A") {
        ok("진입만으로 스캔 화면이다(video + 안내 문구)", r.hasVideo && r.scanHint, r);
      } else {
        // 자동 시작 실패 → 오류 화면이 폴백. 여기서 앱이 죽으면 사용자는 탈 방법이 없다.
        ok("자동 시작이 실패하면 오류 화면 + 다시 시도가 남는다", r.errorScreen && r.retryBtn, r);
        const btn = page.locator('button:has-text("다시 시도")').first();
        if (await btn.count()) {
          await btn.click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(2500);
          const r2 = await page.evaluate(READ);
          ok("다시 시도해도 앱이 살아 있다", (r2.errorScreen && r2.retryBtn) || r2.hasVideo, r2);
        }
      }
      ok("콘솔 런타임 오류 0", errs.length === 0, errs[0]);
      await ctx.close();
    }
  } finally {
    await sessRef.delete().catch(() => {});
  }

  console.log(`\n스크린샷: ${dir}`);
  console.log(fail === 0 ? "\n✅ 통과" : `\n❌ 실패 ${fail}건`);
  process.exit(fail === 0 ? 0 : 1);
})();
