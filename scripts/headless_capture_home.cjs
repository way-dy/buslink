// 승객앱(/p) 홈 화면 캡처 — 2026-08-05 회의 #4(노선도 2단 → 1단 통합) 육안 검토용.
//   1) node docs/manual/_serve_build.mjs   (별도 터미널·3000 포트)
//   2) node scripts/headless_capture_home.cjs
//
// /p 는 로그인(localStorage 세션)이 필요하다. 로그인 폼을 태우면 prod passengers 에
// lastLoginAt 이 써지므로, **세션을 localStorage 에 직접 심어** 읽기만 하고 지나간다
// (saveSession 은 로컬 전용 — Firestore write 경로가 아니다).
// ⚠ 이 스크립트는 화면을 눌러 '내 정류장'을 지정하지 않는다(fcmTokens write 방지).
// ⚠ localhost 는 카카오 도메인 미등록이라 지도 타일은 안 뜬다 — 스트립 검토가 목적.
const path = require("path");
const os = require("os");
const fs = require("fs");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = "http://localhost:3000";
const OUT = process.argv[2] || path.join(os.tmpdir(), "buslink-home");

// 캡처 대상 = (정류장 많은 노선, 운행 중인 노선) 두 가지 모양
const CASES = [
  { label: "stops10", routeId: "6iyi4WsSh3EmywvHaMEi", note: "과천대로 · 정류장 10" },
  { label: "running", routeId: "wVJpSfHB5CX6jmv4Bub6", note: "08:40 판교역 · 운행 중" },
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "buslink-cap-"));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CHROME, headless: true, viewport: { width: 420, height: 900 },
    deviceScaleFactor: 2,
  });

  for (const c of CASES) {
    const page = await ctx.newPage();
    const errs = [];
    const ignorable = (t) => /kakao|dapi|favicon|manifest|Failed to load resource|net::ERR/i.test(t);
    page.on("console", (m) => { if (m.type() === "error" && !ignorable(m.text())) errs.push(m.text()); });
    page.on("pageerror", (e) => { if (!ignorable(e.message)) errs.push("pageerror: " + e.message); });

    await page.addInitScript((routeId) => {
      window.localStorage.setItem("buslink_employee", JSON.stringify({
        empNo: "CAPTURE", name: "화면검토", dept: "검토", routeId, companyId: "dy001",
      }));
    }, c.routeId);

    await page.goto(`${BASE}/p?c=dy001`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(9000); // kakao 5초 대기 + 구독 도달
    // 설치 유도 배너는 캡처 환경에서만 뜨는 방해물 — 닫고 화면 본체를 본다
    for (const label of ["나중에", "닫기"]) {
      const btn = page.getByText(label, { exact: true }).first();
      if (await btn.count().catch(() => 0)) { await btn.click().catch(() => {}); await page.waitForTimeout(500); }
    }
    const file = path.join(OUT, `home_${c.label}.png`);
    await page.screenshot({ path: file, fullPage: false });
    console.log(`  ${c.note} → ${file}${errs.length ? "  ⚠ 콘솔오류: " + errs.join(" | ") : "  (콘솔오류 0)"}`);
    await page.close();
  }

  await ctx.close();
})().catch((e) => { console.error("실행 오류:", e.message); process.exit(1); });
