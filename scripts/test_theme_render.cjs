// 거래처 테마 실렌더 검증 — 2026-08-27. **prod 접근 0 · 네트워크 0 · 쓰기 0.**
//
//   node scripts/test_theme_render.cjs
//
// 왜 격리 렌더인가 = 승객앱 전체를 띄우려면 실제 승객 세션이 필요하고(그 하네스는 별건),
// 여기서 재야 할 것은 **"CSS 변수가 실제로 그 색으로 칠해지는가"** 하나다. tokens.css 와
// `partnerBranding.js` 를 **소스 그대로** 브라우저에 태우고 getComputedStyle 로 픽셀 값을 읽는다.
//
// 🔴 색 표현식은 손으로 옮겨 적지 않고 `EmployeeApp.js` 에서 **추출**한다 — 베껴 적으면
//    나중에 소스가 바뀌어도 이 검사는 계속 초록이다(예쁜 그림만 보고 통과하는 하네스).
// 🔴 이 검사의 핵심은 [1] — **테마를 안 쓰는 거래처가 예전과 같은 색인가**. 그게 이 변경의
//    유일한 회귀 위험이고, 41단언짜리 단위 테스트는 "무슨 변수를 썼나"까지만 알지
//    "그래서 무슨 색이 칠해지나"는 모른다(var 폴백 체인은 브라우저만 안다).
const fs = require("fs");
const path = require("path");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));
const ROOT = path.join(__dirname, "..");

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// EmployeeApp 소스에서 색 표현식을 뽑는다(재구현 0). 못 찾으면 던진다 —
// 조용히 기본값으로 넘어가면 "검사는 도는데 아무것도 안 재는" 상태가 된다.
function extractVar(src, anchor, label) {
  const line = src.split("\n").find((l) => l.includes(anchor));
  if (!line) throw new Error(`앵커 실종(${label}): ${anchor}\n→ EmployeeApp 이 바뀌었다면 이 검사를 먼저 고칠 것`);
  const m = /var\(--color-[a-z-]+\)/.exec(line.slice(line.indexOf(anchor)));
  if (!m) throw new Error(`색 표현식을 못 찾음(${label}): ${line.trim().slice(0, 120)}`);
  return m[0];
}

(async () => {
  let fail = 0, n = 0;
  const ok = (name, cond, got) => {
    n++; console.log(`  ${cond ? "✓" : "✗"} ${name}${!cond && got !== undefined ? " → " + JSON.stringify(got) : ""}`);
    if (!cond) fail++;
  };

  const emp = read("src/pages/EmployeeApp.js");
  const PILL = extractVar(emp, 'background: tab === t.id ?', "탭바 선택 알약");
  const BADGE = extractVar(emp, 'background: r.type === "출근" ?', "운행 구분 배지");
  console.log(`\n소스에서 추출: 탭바 알약=${PILL} · 출근 배지=${BADGE}`);

  const lib = read("src/lib/partnerBranding.js")
    .split("\n").filter((l) => !/^import\s/.test(l)).join("\n")
    .replace(/^export /gm, "");

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><head><style>${read("src/styles/tokens.css")}</style></head>
    <body>
      <div id="pill" style="background:${PILL}"></div>
      <div id="badge" style="background:${BADGE}"></div>
    </body></html>`);
  await page.addScriptTag({ content: lib + "\n;window.__lib={applyPartnerTheme,clearPartnerBranding,resolveTheme,brandBand};" });

  const paint = () => page.evaluate(() => ({
    pill: getComputedStyle(document.getElementById("pill")).backgroundColor,
    badge: getComputedStyle(document.getElementById("badge")).backgroundColor,
  }));
  const apply = (data) => page.evaluate((d) => {
    window.__lib.clearPartnerBranding();
    return window.__lib.applyPartnerTheme(d);
  }, data);

  // ── [0] 신호 유무 ────────────────────────────────────────────
  console.log("\n[0] 신호 유무");
  const base = await paint();
  ok("tokens.css 가 실제로 로드돼 색이 칠해진다(투명이면 검사가 무의미)",
    base.pill !== "rgba(0, 0, 0, 0)" && base.badge !== "rgba(0, 0, 0, 0)", base);

  // ── [1] 테마 없음 = 지금과 같은 색 (회귀 가드) ────────────────
  console.log("\n[1] 테마 없음 = 현행");
  ok("기본값이 primary-soft(#EAF2FE)", base.pill === "rgb(234, 242, 254)", base.pill);
  ok("  배지도 같은 색", base.badge === "rgb(234, 242, 254)", base.badge);

  await apply({ branding: { primaryColor: "#142c52" } });   // 채드윅 실설정값
  const chadwick = await paint();
  ok("🔴 브랜딩만 쓰는 거래처(채드윅 #142c52)는 예전 파생값 그대로",
    chadwick.pill === "rgb(232, 234, 238)" && chadwick.badge === chadwick.pill, chadwick);

  await apply({});
  ok("거래처 설정이 아예 없으면 다시 기본값", (await paint()).pill === "rgb(234, 242, 254)");

  // ── [2] 카카오 프리셋 ────────────────────────────────────────
  console.log("\n[2] 카카오 프리셋");
  const th = await apply({ theme: { preset: "kakao" } });
  const kakao = await paint();
  ok("탭바 알약이 옅은 노랑(#FFF3C4)으로 칠해진다", kakao.pill === "rgb(255, 243, 196)", kakao.pill);
  ok("출근 배지도 같은 노랑", kakao.badge === "rgb(255, 243, 196)", kakao.badge);
  ok("🔴 기본값과 실제로 다른 색이다(양성 대조)", kakao.pill !== base.pill);
  ok("밴드는 곤색 그대로(파생 아님)", th.band === "#1E233D", th);

  const bandColor = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--color-band").trim());
  ok("--color-band 가 :root 에 실제로 실린다", bandColor === "#1E233D", bandColor);

  // ── [3] 거래처를 옮기면 색이 안 남는다 ────────────────────────
  console.log("\n[3] 잔존 없음");
  await page.evaluate(() => window.__lib.clearPartnerBranding());
  const cleared = await paint();
  ok("🔴 clear 후 기본값으로 완전히 돌아온다(남으면 로그아웃 뒤 남의 색이 보인다)",
    cleared.pill === base.pill && cleared.badge === base.badge, cleared);
  const bandAfter = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--color-band").trim());
  ok("  --color-band 도 tokens.css 기본값으로", bandAfter === "#003DCC", bandAfter);

  // ── [4] 탑승·QR 화면(BoardingApp) — 2026-08-27 라이트 리스킨 + 토큰화 ──────
  // 이 화면은 2026-05 리디자인에서 통째로 빠져 남색 + 다른 글꼴이었다. 소스의 `S` 객체를
  // 통째로 꺼내 실제로 렌더해 본다(값만 훑으면 var 폴백이 뭘로 풀리는지 모른다).
  console.log("\n[4] 탑승·QR 화면");
  const bSrc = read("src/pages/BoardingApp.js");
  const from = bSrc.indexOf("const S = {");
  const to = bSrc.indexOf("\n};", from);
  if (from < 0 || to < 0) throw new Error("BoardingApp 의 S 객체를 못 찾음 — 이 검사를 먼저 고칠 것");
  const sObj = bSrc.slice(from + "const S = ".length, to + 2);

  ok("🔴 남색 하드코딩이 남아 있지 않다(#0B1A2E·#112240·#1E3A5F·#8896AA)",
    !/#0B1A2E|#112240|#1E3A5F|#8896AA|#F0F4FF|#4A6FA5/i.test(bSrc));
  // ⚠ 문자열이 아니라 **선언**을 본다 — 주석에 "예전엔 Noto Sans KR 이었다"고 적어 두면
  //    단순 포함 검사는 그 설명에 걸려 빨간불이 된다(실제로 그랬다).
  ok("🔴 fontFamily 에 Noto 를 다시 쓰지 않는다(이 저장소는 Pretendard 만 self-host 한다)",
    !/fontFamily:\s*["'][^"']*Noto/.test(bSrc));
  ok("거래처 테마를 적용한다(applyPartnerTheme 배선)", /applyPartnerTheme/.test(bSrc));

  await page.evaluate((src) => {
    const S = eval("(" + src + ")");                        // eslint-disable-line no-eval
    const mk = (id, st) => {
      const el = document.createElement("div");
      el.id = id; Object.assign(el.style, st); document.body.appendChild(el);
    };
    mk("bWrap", S.wrap); mk("bCard", S.card); mk("bBtn", S.btn); mk("bInput", S.input);
  }, sObj);
  const boarding = () => page.evaluate(() => {
    const g = (id) => getComputedStyle(document.getElementById(id));
    return {
      wrap: g("bWrap").backgroundColor, card: g("bCard").backgroundColor,
      btn: g("bBtn").backgroundColor, input: g("bInput").backgroundColor,
      font: g("bWrap").fontFamily,
    };
  });
  await page.evaluate(() => window.__lib.clearPartnerBranding());
  const bBase = await boarding();
  ok("카드가 흰색이다(예전엔 #112240 남색)", bBase.card === "rgb(255, 255, 255)", bBase.card);
  ok("바탕이 밝은 회색이다(예전엔 #0B1A2E)", bBase.wrap === "rgb(247, 247, 248)", bBase.wrap);
  ok("입력칸도 흰색", bBase.input === "rgb(255, 255, 255)", bBase.input);
  ok("버튼이 기본 파랑(#0066FF)", bBase.btn === "rgb(0, 102, 255)", bBase.btn);
  ok("글꼴이 Pretendard 계열로 해석된다", /Pretendard/.test(bBase.font), bBase.font);

  await apply({ theme: { preset: "kakao" } });
  const bKakao = await boarding();
  ok("🔴 테마를 켜면 버튼이 카카오 파랑(#4088FE)으로 따라온다 — 이게 토큰화의 목적",
    bKakao.btn === "rgb(64, 136, 254)", bKakao.btn);
  ok("  바탕·카드는 그대로(밝은 면 유지)", bKakao.card === bBase.card && bKakao.wrap === bBase.wrap);
  await page.evaluate(() => window.__lib.clearPartnerBranding());

  // ── [5] 관리자 프리셋 선택 UI — 소스 가드 ────────────────────────────────
  // 🔴 관리자 콘솔은 Firebase Auth 로그인이 필요해 헤드리스로 못 띄운다(이 저장소에 admin
  //    로그인 하네스가 없다 — `test_sidebar_scroll.cjs` 와 같은 처지). 그래서 **화면이 아니라
  //    계약**을 잠근다. 여기서 막지 않으면 조용히 어긋나는 것들이다.
  console.log("\n[5] 관리자 프리셋 선택 UI");
  const aSrc = read("src/pages/AdminApp.js");
  ok("프리셋 목록을 THEME_PRESETS 에서 만든다(하드코딩 목록이 아니다 — 프리셋을 늘리면 UI 도 따라온다)",
    /Object\.keys\(THEME_PRESETS\)/.test(aSrc));
  ok("🔴 저장이 필드 삭제가 아니라 빈 객체다(끄면 예전 색으로 정확히 돌아가야 한다)",
    /theme:\s*pTheme\s*\?\s*\{\s*preset:\s*pTheme\s*\}\s*:\s*\{\}/.test(aSrc));
  ok("🔴 프리셋을 써도 branding 을 지우지 않는다(되돌릴 값·로고가 사라진다)",
    /branding:\s*\{\s*\n\s*primaryColor:/.test(aSrc));
  ok("🔴 미리보기 밴드 글자색을 하드코딩하지 않고 readableOn 으로 정한다",
    /readableOn\(bandBg\)/.test(aSrc));
  ok("모르는 preset 이름은 폼에 싣지 않는다(화면과 실제 동작이 어긋나면 '켜져 있다'고 오해한다)",
    /THEME_PRESETS\[th\.preset\]\s*\?\s*th\.preset\s*:\s*""/.test(aSrc));

  await browser.close();
  console.log(`\n${fail ? "✗ 실패 " + fail : "✓ 전부 통과"} (${n}단언)\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("실패:", e.message || e); process.exit(1); });
