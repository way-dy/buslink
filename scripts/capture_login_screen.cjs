// 승객앱 로그인 화면(`/p`) 캡처 — 세션 불필요·쓰기 0.
//
//   BASE=http://localhost:3000 PC=<거래처코드> node scripts/capture_login_screen.cjs <출력파일>
//
// 🔴 `PC` 없이 찍으면 워드마크가 `BusLink` 로 나온다 — 로그인 «전»에는 앱이 거래처를 모르기
//    때문이다(2026-08-27 `pc` 파라미터 도입 이유). 고객사 안내서용은 반드시 그 거래처 코드로.
//    이건 캡처 편의가 아니라 실제 동작이다: 고객에게 보내는 링크에도 같은 `?pc=` 가 있어야
//    첫 화면이 그 거래처 톤·이름으로 열린다.
const path = require("path");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const BASE = process.env.BASE || "https://p.buslink.co.kr";
const PC = process.env.PC || "";
const OUT = process.argv[2];
if (!OUT) { console.error("사용법: PC=<거래처코드> node scripts/capture_login_screen.cjs <출력파일>"); process.exit(1); }

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  await page.goto(BASE + "/p" + (PC ? "?pc=" + encodeURIComponent(PC) : ""),
    { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(5000);

  // 신호 유무 — 로그인 폼이 실제로 떴는지. 세션이 남아 있거나 로딩이 안 끝나면 엉뚱한 화면을 싣는다.
  if (!(await page.locator("text=로그인").count())) throw new Error("로그인 화면이 안 떴다 — 캡처 중단");
  // 🔴 거래처를 줬는데 테마가 안 걸렸으면 멈춘다(색만 기본인 채로 «적용했다»는 그림이 나가는 것 차단).
  if (PC) {
    const primary = await page.evaluate(() => document.documentElement.style.getPropertyValue("--color-primary"));
    if (!primary) throw new Error("거래처 테마가 안 걸렸다 — 코드가 맞는지 확인(" + PC + ")");
  }
  await page.screenshot({ path: OUT });
  console.log(OUT + (PC ? " (거래처 " + PC + ")" : "") + " · 콘솔오류 " + errs.length);
  await browser.close();
})().catch((e) => { console.error("실패:", e.message || e); process.exit(1); });
