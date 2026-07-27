// 계정 발급·배부 흐름 헤드리스 실로드 점검 (2026-07-27)
//   1) node docs/manual/_serve_build.mjs   (별도 터미널·3000 포트)
//   2) node scripts/headless_check_account_flow.cjs
//
// 검사: 승객앱/협력사 포털이 콘솔 오류 없이 뜨는지 + 안내문 QR 링크(`?emp=`)가
//       사번 입력칸에 실제로 채워지는지(빌드된 번들 기준 = 배포될 코드 그대로).
// ⚠ 사용자 Chrome 프로필을 건드리지 않도록 전용 임시 프로필로 띄운다.
const path = require("path");
const os = require("os");
const fs = require("fs");
// playwright-core 는 매뉴얼 캡처 도구 쪽에 설치돼 있다(루트 앱 의존성 아님).
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = "http://localhost:3000";

(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "buslink-hl-"));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CHROME, headless: true, viewport: { width: 420, height: 860 },
  });
  let fail = 0;
  const ok = (n, c, x) => { console.log(`  ${c ? "✓" : "✗"} ${n}${!c && x ? " → " + x : ""}`); if (!c) fail++; };

  const visit = async (url, waitFor) => {
    const page = await ctx.newPage();
    const errs = [];
    page.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
    page.on("pageerror", e => errs.push("pageerror: " + e.message));
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    if (waitFor) await page.waitForSelector(waitFor, { timeout: 15000 }).catch(() => {});
    return { page, errs };
  };

  // 카카오 지도 키는 localhost 등록돼 있지만 네트워크 사정으로 실패할 수 있어 무시 목록에 둔다.
  const ignorable = t => /kakao|dapi|favicon|manifest|Failed to load resource/i.test(t);

  console.log("\n[1] 승객앱 /p — 안내문 QR 진입(사번 프리필)");
  {
    const { page, errs } = await visit(`${BASE}/p?emp=10001`, 'input[placeholder="사번"]');
    const val = await page.inputValue('input[placeholder="사번"]').catch(() => null);
    ok("사번 입력칸이 QR 파라미터로 채워짐", val === "10001", `실제="${val}"`);
    const hint = await page.textContent("body");
    ok("초기 PIN 000000 안내 문구 제거됨", !/초기 PIN: 000000/.test(hint));
    ok("안내문 기준 문구 노출", /안내문의 아이디와 비밀번호/.test(hint));
    ok("콘솔 오류 0", errs.filter(e => !ignorable(e)).length === 0, errs.join(" | "));
    await page.close();
  }

  console.log("\n[2] 승객앱 /p — 파라미터 없는 기존 진입(회귀 확인)");
  {
    const { page, errs } = await visit(`${BASE}/p`, 'input[placeholder="사번"]');
    const val = await page.inputValue('input[placeholder="사번"]').catch(() => null);
    ok("사번 입력칸 비어 있음", val === "", `실제="${val}"`);
    ok("콘솔 오류 0", errs.filter(e => !ignorable(e)).length === 0, errs.join(" | "));
    await page.close();
  }

  console.log("\n[3] 협력사 포털 /partner — 업체코드 화면");
  {
    const { page, errs } = await visit(`${BASE}/partner`, "input");
    const body = await page.textContent("body");
    ok("업체코드 인증 화면 렌더", /업체코드/.test(body));
    ok("콘솔 오류 0", errs.filter(e => !ignorable(e)).length === 0, errs.join(" | "));
    await page.close();
  }

  console.log("\n[4] 관리자 / · 기사 /driver — 무영향 확인");
  for (const [label, url] of [["관리자", `${BASE}/`], ["기사", `${BASE}/driver`]]) {
    const { page, errs } = await visit(url, "input");
    ok(`${label} 화면 콘솔 오류 0`, errs.filter(e => !ignorable(e)).length === 0, errs.join(" | "));
    await page.close();
  }

  await ctx.close();
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) { /* 잔여 프로필은 무해 */ }
  console.log(`\n결과: ${fail ? fail + "건 실패" : "전부 통과"}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
