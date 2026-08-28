// 홈 화면 — QR 탑승 버튼이 스크롤 없이 보이는가 (2026-08-28 최우석 요청 #6StRo4Dy)
//   1) node docs/manual/_serve_build.mjs   (별도 터미널)
//   2) node scripts/headless_check_home_qr_fold.cjs
//      BASE=https://p.buslink.co.kr EMP=SAMPLE-SEC node scripts/headless_check_home_qr_fold.cjs
//
// 🔴 왜 필요한가: "스크롤 후에야 QR탑승이 보인다"는 신고를 문구로 고쳤다 말하지 않고
//    **첫 화면(scrollTop=0)에서 버튼 아래끝이 탭바 위인지**를 픽셀로 재서 잠근다.
//    화면이 작을수록 노선도가 밀어내므로 작은 폰까지 함께 잰다.
// 🔴 로그인: 2026-08-25 승객 인증 전환 이후 localStorage 세션만으로는 못 들어간다
//    (`resumeToken` → `passengerSessions/{sha256}` 필요). capture_passenger_screens.cjs 와 같은 방식.
//    기본 대상은 **샘플 거래처 승객 `SAMPLE-SEC`** — 실제 사람 계정을 건드리지 않는다.
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
const VIEWPORTS = [
  { name: "iPhone 12 390x844", width: 390, height: 844 },
  { name: "작은 폰 360x640", width: 360, height: 640 },
];

function loadAdmin() {
  const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
  const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
  const sa = require(path.join(ROOT, "key", kf));
  if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치");
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(sa) });
  return admin;
}

const MEASURE = () => {
  const btns = [...document.querySelectorAll("button")].filter((b) => (b.textContent || "").replace(/\s+/g, "").includes("QR탑승"));
  if (!btns.length) return { found: false };
  const btn = btns[0];
  const br = btn.getBoundingClientRect();
  let sc = btn.parentElement, scInfo = null;
  while (sc) {
    const st = getComputedStyle(sc);
    if (/(auto|scroll)/.test(st.overflowY) && sc.scrollHeight > sc.clientHeight + 1) {
      scInfo = { scrollTop: Math.round(sc.scrollTop), scrollHeight: Math.round(sc.scrollHeight), clientHeight: Math.round(sc.clientHeight) };
      break;
    }
    sc = sc.parentElement;
  }
  const LAB = ["홈", "노선", "공지", "탑승", "설정", "문의", "홈페이지"];
  const tabs = [...document.querySelectorAll("button")].filter((b) => LAB.includes((b.textContent || "").trim()));
  const tabTop = tabs.length ? Math.min(...tabs.map((t) => t.getBoundingClientRect().top)) : window.innerHeight;
  // 도움말 FAB(우하단 고정)과 패널 버튼이 겹치는가 — 패널이 화면 안으로 들어오면서 새로 보이는 문제
  const help = document.querySelector('button[aria-label="도움말"]');
  const hr = help ? help.getBoundingClientRect() : null;
  const hit = (el) => { if (!hr || !el) return false; const r = el.getBoundingClientRect();
    return r.left < hr.right && r.right > hr.left && r.top < hr.bottom && r.bottom > hr.top; };
  const chg = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "정류장 변경");
  const strip = document.querySelector("[data-route-strip]");
  const sr = strip ? strip.getBoundingClientRect() : null;
  return {
    found: true,
    btnTop: Math.round(br.top), btnBottom: Math.round(br.bottom),
    tabTop: Math.round(tabTop), innerH: window.innerHeight,
    scroll: scInfo, stripTop: sr ? Math.round(sr.top) : null, stripBottom: sr ? Math.round(sr.bottom) : null,
    myStopPanel: document.body.innerText.includes("정류장 변경"),
    helpOverQr: hit(btn), helpOverChange: hit(chg), hasHelp: !!help, hasChange: !!chg,
  };
};

(async () => {
  let fail = 0;
  const ok = (n, c, x) => { console.log(`  ${c ? "✓" : "✗"} ${n}${!c && x !== undefined ? " → " + x : ""}`); if (!c) fail++; };

  const admin = loadAdmin();
  const db = admin.firestore();
  const pdoc = await db.collection("companies").doc(COMPANY).collection("passengers").doc(EMP).get();
  if (!pdoc.exists) { console.log(`⏭ SKIP — 승객 ${EMP} 없음`); process.exit(0); }
  const p = { empNo: pdoc.id, ...(pdoc.data() || {}) };
  console.log(`\n대상: ${p.partnerName || p.partnerCode} · 승객 ${p.empNo} · ${BASE}`);

  // 승계표 발급(문서 ID = sha256(resumeToken) — functions/index.js 와 같은 식). 끝나면 삭제.
  const resumeToken = crypto.randomBytes(32).toString("hex");
  const sessRef = db.collection("companies").doc(COMPANY).collection("passengerSessions")
    .doc(crypto.createHash("sha256").update(resumeToken).digest("hex"));
  await sessRef.set({
    companyId: COMPANY, empNo: p.empNo,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    lastUsedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qrfold-"));
  try {
    for (const vp of VIEWPORTS) {
      const ctx = await chromium.launchPersistentContext(path.join(dir, String(vp.width)), {
        executablePath: CHROME, headless: true,
        viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2,
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
      await page.waitForTimeout(1500);

      console.log(`\n[${vp.name}]`);
      // ① 정류장 미선택 상태
      let r = await page.evaluate(MEASURE);
      await page.screenshot({ path: path.join(dir, `home-${vp.width}-a.png`) });
      if (!r.found) {
        console.log("  ✗ QR 탑승 버튼을 못 찾음 · 화면: " + (await page.evaluate(() => document.body.innerText.slice(0, 200).replace(/\n/g, " / "))));
        fail++; await ctx.close(); continue;
      }
      const line = (t, x) => console.log(`  ${t}: QR ${x.btnTop}~${x.btnBottom}px · 탭바 ${x.tabTop}px · 뷰포트 ${x.innerH}px`
        + (x.scroll ? ` · 스크롤 ${x.scroll.scrollHeight}/${x.scroll.clientHeight}(top=${x.scroll.scrollTop})` : " · 스크롤 없음"));
      line("정류장 미선택", r);
      ok("정류장 미선택 — 스크롤 0에서 QR 탑승이 온전히 보인다",
        r.btnTop >= 0 && r.btnBottom <= r.tabTop, `${r.btnTop}~${r.btnBottom} vs 탭바 ${r.tabTop}`);

      // ② 내 정류장 선택 상태(패널이 커진다 — 실제 신고 상황)
      const col = page.locator("[data-route-strip] div[style*='width: 86px']").first();
      if (await col.count()) {
        await col.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(2000);
        // 선택 직후 스트립 자동 스크롤이 세로 스크롤을 건드렸을 수 있으니 되돌려 첫 화면 기준으로 잰다
        await page.evaluate(() => {
          document.querySelectorAll("div").forEach((d) => { const st = getComputedStyle(d); if (/(auto|scroll)/.test(st.overflowY)) d.scrollTop = 0; });
        });
        await page.waitForTimeout(500);
        r = await page.evaluate(MEASURE);
        await page.screenshot({ path: path.join(dir, `home-${vp.width}-b.png`) });
        line("정류장 선택", r);
        ok("정류장 선택 — 스크롤 0에서 QR 탑승이 온전히 보인다",
          r.found && r.btnTop >= 0 && r.btnBottom <= r.tabTop, `${r.btnTop}~${r.btnBottom} vs 탭바 ${r.tabTop}`);
        ok("내 정류장 카드(정류장 변경 버튼)가 떴다 — 검사 성립", r.myStopPanel === true);
        ok("도움말 버튼이 QR 탑승 버튼을 덮지 않는다", r.hasHelp && !r.helpOverQr, r.hasHelp ? "겹침" : "도움말 버튼 없음");
        ok("도움말 버튼이 정류장 변경 버튼을 덮지 않는다", r.hasChange && !r.helpOverChange, r.hasChange ? "겹침" : "버튼 없음");
      } else {
        console.log("  ⏭ 정류장 컬럼을 못 찾아 선택 상태는 건너뜀");
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
