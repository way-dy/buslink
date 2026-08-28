// 고정 QR 탑승 화면(`/board`) 캡처 — 세션 불필요·**쓰기 0**(버튼을 누르지 않는다).
//
//   node scripts/capture_board_screen.cjs <출력파일> [kakao]
//   BASE=http://localhost:3000 PC=<거래처코드> node scripts/capture_board_screen.cjs out.png
//
// 🔴 `PC` 를 주면 주입 대신 **실제 거래처 문서**로 테마가 걸린다(2026-08-28) — 색뿐 아니라
//    워드마크까지 진짜 값으로 찍히므로 안내서용은 이쪽을 쓸 것. 주입(`kakao`)은 색만 바꾼다.
//
// 이 화면은 로그인 없이 입력 단계까지 뜨므로 승객 세션이 필요 없다(그래서 회귀 검토가 싸다).
// `kakao` 를 주면 거래처 테마가 켜졌을 때와 **같은 CSS 변수**를 주입해 찍는다 — 실제 거래처
// 문서를 건드리지 않고 고객 문서용 시안을 만들기 위한 것이다(색은 THEME_PRESETS 와 같아야 한다).
const path = require("path");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const BASE = process.env.BASE || "https://p.buslink.co.kr";
const OUT = process.argv[2];
const KAKAO = process.argv[3] === "kakao";
const PC = process.env.PC || "";
const PRESET = { band: "#1E233D", accent: "#FFCD00", accentSoft: "#FFF3C4", primary: "#4088FE" };

if (!OUT) { console.error("사용법: node scripts/capture_board_screen.cjs <출력파일> [kakao]"); process.exit(1); }

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  // `v=__preview__` = 존재하지 않는 차량 — 입력 화면까지만 뜨고 탑승은 시도조차 안 한다.
  await page.goto(`${BASE}/board?c=dy001&v=__preview__` + (PC ? "&pc=" + encodeURIComponent(PC) : ""),
    { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(5000);

  // 신호 유무 — 입력 화면이 실제로 떴는지 확인(안 뜨면 빈 화면을 문서에 싣게 된다).
  const hasForm = await page.locator("text=탑승 확인").count();
  if (!hasForm) throw new Error("탑승 확인 화면이 안 떴다 — 캡처 중단");

  if (KAKAO && !PC) {
    await page.evaluate((t) => {
      const r = document.documentElement.style;
      r.setProperty("--color-primary", t.primary);
      r.setProperty("--color-primary-soft", "#EAF1FE");
      r.setProperty("--color-primary-deep", "#2A6BE0");
      r.setProperty("--color-band", t.band);
      r.setProperty("--color-accent", t.accent);
      r.setProperty("--color-accent-soft", t.accentSoft);
    }, PRESET);
    await page.waitForTimeout(500);
  }
  await page.screenshot({ path: OUT });
  console.log(`${OUT}${KAKAO ? " (테마 주입: kakao)" : ""} · 콘솔오류 ${errs.length}`);
  await browser.close();
})().catch((e) => { console.error("실패:", e.message || e); process.exit(1); });
