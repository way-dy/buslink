// 운행 강제 종료 변경분 헤드리스 실로드 점검 (2026-07-28)
//   1) node docs/manual/_serve_build.mjs   (별도 터미널·3000 포트)
//   2) node scripts/headless_check_force_end.cjs
//
// 목적 = "빌드 통과 ≠ 런타임". 신규 모듈(lib/runSignals.js·lib/forceEndRun.js)은 AdminApp 이
// 모듈 최상단에서 import 하므로, import 순환·TDZ 같은 결함이 있으면 **로그인 화면부터** 깨진다.
// 관제 화면 안쪽(실시간 관제 좌측 레일 UI)은 관리자 로그인이 필요해 여기서 확인 불가 —
// 그 부분은 배포 후 실계정 육안 확인 대상.
const path = require("path");
const os = require("os");
const fs = require("fs");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = "http://localhost:3000";

(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "buslink-hl-"));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CHROME, headless: true, viewport: { width: 1280, height: 900 },
  });
  let fail = 0;
  const ok = (n, c, x) => { console.log(`  ${c ? "✓" : "✗"} ${n}${!c && x ? " → " + x : ""}`); if (!c) fail++; };
  const ignorable = t => /kakao|dapi|favicon|manifest|Failed to load resource|net::ERR/i.test(t);

  const visit = async (url) => {
    const page = await ctx.newPage();
    const errs = [];
    page.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
    page.on("pageerror", e => errs.push("pageerror: " + e.message));
    // ⚠ networkidle 금지 — 승객·직원앱은 GPS onSnapshot 스트림을 계속 열어두므로 영영 idle 이
    //   안 돼 타임아웃 난다(코드 결함 아님). domcontentloaded + 고정 대기로 첫 렌더를 본다.
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(4000);
    return { page, errs: errs.filter(e => !ignorable(e)) };
  };

  for (const [label, url] of [["관리자 로그인 /", `${BASE}/`], ["기사앱 /driver", `${BASE}/driver`], ["직원앱 /p", `${BASE}/p`], ["승객앱 /bus", `${BASE}/bus`]]) {
    console.log(`\n[${label}]`);
    const { page, errs } = await visit(url);
    const body = await page.evaluate(() => document.body.innerText.slice(0, 200));
    ok("콘솔 오류 0", errs.length === 0, errs.join(" | "));
    ok("화면이 비어 있지 않음", body.trim().length > 0, JSON.stringify(body));
    await page.close();
  }

  await ctx.close();
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  console.log(fail ? `\n❌ ${fail}건 실패` : "\n✅ 전부 통과");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
