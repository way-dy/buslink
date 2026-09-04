// inAppBrowser 순수 함수 격리 테스트 (2026-09-04)
//   node scripts/test_in_app_browser.cjs
// ESM 모듈이라 소스를 읽어 CJS 로 얕게 변환해 로드한다(빌드 없이 검증) — test_account_cards 와 같은 틀.
//
// 이 테스트가 지키는 것: 거래처 «어르신들이 홈 화면 설치를 못 한다» 의 실제 원인은
// 설치 버튼이 아니라 **카카오톡 인앱 브라우저**였다(거기선 beforeinstallprompt 가 없다).
// 그래서 여기서 제일 중요한 단언은 두 갈래다 —
//   ① 카톡/인앱을 **놓치지 않는가**(놓치면 승객이 설치 화면을 영영 못 본다)
//   ② 일반 크롬을 **인앱으로 오인하지 않는가**(오인하면 멀쩡한 승객에게 «브라우저로 여세요»
//      배너가 뜨고 진짜 설치 팝업이 가려진다 = 더 큰 사고)
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// 뮤테이션 대조군용 경로 주입 — 정본을 일부러 망가뜨린 사본을 태워 «이 단언이 진짜로 잡는가» 를
// 재는 데만 쓴다. 게이트는 환경변수 없이 돌므로 항상 정본을 태운다.
const MODULE_PATH = process.env.BUSLINK_INAPP_MODULE
  || path.join(__dirname, "..", "src", "lib", "inAppBrowser.js");
const src = fs.readFileSync(MODULE_PATH, "utf8")
  .replace(/^export const /gm, "const ")
  .replace(/^export function /gm, "function ");
const exportNames = ["IN_APP", "detectBrowserEnv", "withExternalBrowserParam", "buildEscapeUrl", "buildEscapeFallbackUrl", "buildEscapeGuide"];
const sandbox = { module: { exports: {} }, String, RegExp, Object, Array, JSON };
vm.createContext(sandbox);
vm.runInContext(src + "\nmodule.exports = {" + exportNames.join(",") + "};", sandbox);
const M = sandbox.module.exports;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? " → " + extra : ""}`); }
}

// ── 실제 UA 표본 ────────────────────────────────────────────────────────────
const UA = {
  kakaoAos: "Mozilla/5.0 (Linux; Android 13; SM-S908N Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.6045.163 Mobile Safari/537.36 KAKAOTALK 10.4.5",
  kakaoIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 10.4.0",
  kakaoT: "Mozilla/5.0 (Linux; Android 12; SM-A536N; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/114.0.0.0 Mobile Safari/537.36 kakaotaxi/6.5.0",
  naver: "Mozilla/5.0 (Linux; Android 13; SM-S908N; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.0.0 Mobile Safari/537.36 NAVER(inapp; search; 1200; 12.6.0)",
  instaAos: "Mozilla/5.0 (Linux; Android 13; SM-S908N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36 Instagram 302.0.0.23.113 Android",
  instaIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 302.0.0.23.113",
  lineAos: "Mozilla/5.0 (Linux; Android 13; SM-S908N; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.0.0 Mobile Safari/537.36 Line/13.5.0",
  fbAos: "Mozilla/5.0 (Linux; Android 13; SM-S908N; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/440.0.0.30.108;]",
  // ── 대조군: 인앱이 아니어야 하는 것들 ──
  chromeAos: "Mozilla/5.0 (Linux; Android 13; SM-S908N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36",
  samsung: "Mozilla/5.0 (Linux; Android 13; SM-S908N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36",
  safariIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1",
  chromeIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/119.0.6045.169 Mobile/15E148 Safari/604.1",
  desktop: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
};

const HREF = "https://p.buslink.co.kr/p?emp=10001&pc=C1";

console.log("\n[1] detectBrowserEnv — 인앱을 놓치지 않는가");
{
  ok("카카오톡(안드) → kakaotalk", M.detectBrowserEnv(UA.kakaoAos).inApp === M.IN_APP.KAKAOTALK, M.detectBrowserEnv(UA.kakaoAos).inApp);
  ok("카카오톡(iOS) → kakaotalk", M.detectBrowserEnv(UA.kakaoIos).inApp === M.IN_APP.KAKAOTALK);
  ok("카카오T → kakaot", M.detectBrowserEnv(UA.kakaoT).inApp === M.IN_APP.KAKAOT, M.detectBrowserEnv(UA.kakaoT).inApp);
  ok("네이버 → naver", M.detectBrowserEnv(UA.naver).inApp === M.IN_APP.NAVER, M.detectBrowserEnv(UA.naver).inApp);
  ok("인스타(안드) → instagram", M.detectBrowserEnv(UA.instaAos).inApp === M.IN_APP.INSTAGRAM);
  ok("인스타(iOS) → instagram", M.detectBrowserEnv(UA.instaIos).inApp === M.IN_APP.INSTAGRAM);
  ok("라인 → line", M.detectBrowserEnv(UA.lineAos).inApp === M.IN_APP.LINE, M.detectBrowserEnv(UA.lineAos).inApp);
  ok("페이스북 → facebook", M.detectBrowserEnv(UA.fbAos).inApp === M.IN_APP.FACEBOOK, M.detectBrowserEnv(UA.fbAos).inApp);
  // 🔴 카카오톡 안드 UA 에는 «; wv)» 도 들어 있다 — 판정 순서가 뒤집히면 OTHER 로 떨어져
  //    카카오 전용 탈출(openExternalBrowser)을 못 쓰고 intent 로 새 버린다.
  ok("🔴 카톡이 wv 폴백보다 먼저 잡힌다(순서 가드)", M.detectBrowserEnv(UA.kakaoAos).inApp === M.IN_APP.KAKAOTALK);
}

console.log("\n[2] detectBrowserEnv — 대조군: 일반 브라우저를 인앱으로 오인하지 않는가");
{
  // 이 5건이 무너지면 멀쩡한 승객에게 «브라우저로 여세요» 가 뜨고 **진짜 설치 팝업이 가려진다**.
  ok("🔴 안드 크롬은 인앱 아님", M.detectBrowserEnv(UA.chromeAos).inApp === null, M.detectBrowserEnv(UA.chromeAos).inApp);
  ok("🔴 삼성 인터넷은 인앱 아님", M.detectBrowserEnv(UA.samsung).inApp === null, M.detectBrowserEnv(UA.samsung).inApp);
  ok("🔴 iOS 사파리는 인앱 아님", M.detectBrowserEnv(UA.safariIos).inApp === null, M.detectBrowserEnv(UA.safariIos).inApp);
  ok("🔴 iOS 크롬은 인앱 아님", M.detectBrowserEnv(UA.chromeIos).inApp === null, M.detectBrowserEnv(UA.chromeIos).inApp);
  ok("🔴 데스크톱은 인앱 아님", M.detectBrowserEnv(UA.desktop).inApp === null, M.detectBrowserEnv(UA.desktop).inApp);
  ok("빈 UA 도 throw 없이 null", M.detectBrowserEnv("").inApp === null && M.detectBrowserEnv(null).inApp === null);
}

console.log("\n[3] detectBrowserEnv — 플랫폼·라벨");
{
  ok("안드 표식", M.detectBrowserEnv(UA.kakaoAos).isAndroid === true && M.detectBrowserEnv(UA.kakaoAos).isIOS === false);
  ok("iOS 표식", M.detectBrowserEnv(UA.kakaoIos).isIOS === true && M.detectBrowserEnv(UA.kakaoIos).isAndroid === false);
  ok("라벨은 승객이 알아보는 앱 이름", M.detectBrowserEnv(UA.kakaoAos).appLabel === "카카오톡", M.detectBrowserEnv(UA.kakaoAos).appLabel);
  ok("인앱이 아니면 라벨 없음", M.detectBrowserEnv(UA.chromeAos).appLabel === null);
}

console.log("\n[4] withExternalBrowserParam");
{
  ok("쿼리 없는 주소 → ? 로 붙는다",
    M.withExternalBrowserParam("https://p.buslink.co.kr/p") === "https://p.buslink.co.kr/p?openExternalBrowser=1");
  ok("쿼리 있는 주소 → & 로 붙는다",
    M.withExternalBrowserParam(HREF) === HREF + "&openExternalBrowser=1");
  ok("🔴 이미 있으면 중복해서 붙이지 않는다",
    M.withExternalBrowserParam(HREF + "&openExternalBrowser=1") === HREF + "&openExternalBrowser=1");
  ok("해시는 뒤에 그대로 남는다",
    M.withExternalBrowserParam("https://p.buslink.co.kr/p#x") === "https://p.buslink.co.kr/p?openExternalBrowser=1#x",
    M.withExternalBrowserParam("https://p.buslink.co.kr/p#x"));
  ok("해시 안의 같은 글자에 속지 않는다",
    M.withExternalBrowserParam("https://p.buslink.co.kr/p#openExternalBrowser=1") === "https://p.buslink.co.kr/p?openExternalBrowser=1#openExternalBrowser=1");
  ok("빈 값은 그대로", M.withExternalBrowserParam("") === "" && M.withExternalBrowserParam(null) === "");
}

console.log("\n[5] buildEscapeUrl — 어떤 탈출을 쓰는가");
{
  // 🔴 2026-09-04 계약 변경 — **실기기에서 고쳤다**. 처음엔 카카오 계열에 `openExternalBrowser=1`
  //    을 줬는데 way 의 안드로이드 카톡에서 **눌러도 카톡 안에 그대로 머물렀다**. 카카오톡은 이
  //    파라미터를 «링크를 처음 열 때» 만 가로채고, 이미 열린 웹뷰 안의 이동에는 적용하지 않는다.
  //    → 안드로이드는 카카오도 `intent://`(OS 로 넘어가 카톡이 못 붙잡는다). 파라미터는 2단으로.
  const kakaoAos = M.detectBrowserEnv(UA.kakaoAos);
  const kakaoIos = M.detectBrowserEnv(UA.kakaoIos);
  const instaAos = M.detectBrowserEnv(UA.instaAos);
  const instaIos = M.detectBrowserEnv(UA.instaIos);
  const chrome = M.detectBrowserEnv(UA.chromeAos);
  const isIntent = (u) => typeof u === "string" && u.indexOf("intent://") === 0
    && u.indexOf("package=com.android.chrome") !== -1;

  ok("🔴 카톡(안드)은 intent 방식이다(파라미터는 실기기에서 안 먹었다)",
    isIntent(M.buildEscapeUrl(HREF, kakaoAos)), M.buildEscapeUrl(HREF, kakaoAos));
  ok("🔴 카톡(안드) 첫 수단은 파라미터가 아니다",
    M.buildEscapeUrl(HREF, kakaoAos) !== HREF + "&openExternalBrowser=1");
  ok("카카오T(안드)도 intent", isIntent(M.buildEscapeUrl(HREF, M.detectBrowserEnv(UA.kakaoT))));
  ok("안드 기타 인앱도 intent", isIntent(M.buildEscapeUrl(HREF, instaAos)));
  // iOS 에는 intent 가 없다 — 카카오만 파라미터로 나갈 수 있다.
  ok("카톡(iOS)은 파라미터 방식(iOS 엔 intent 가 없다)",
    M.buildEscapeUrl(HREF, kakaoIos) === HREF + "&openExternalBrowser=1", M.buildEscapeUrl(HREF, kakaoIos));
  ok("🔴 iOS 기타 인앱은 탈출 URL 없음(먹통 버튼 금지)", M.buildEscapeUrl(HREF, instaIos) === null, M.buildEscapeUrl(HREF, instaIos));
  ok("🔴 일반 브라우저는 탈출 URL 없음", M.buildEscapeUrl(HREF, chrome) === null);

  // intent 가 크롬 없는 기기에서 죽지 않도록 폴백 주소를 싣는다.
  ok("intent 에 browser_fallback_url 이 실린다",
    (M.buildEscapeUrl(HREF, kakaoAos) || "").indexOf("S.browser_fallback_url=") !== -1);
  ok("폴백 주소는 URL 인코딩된다(intent 파서가 «;» 에서 잘라먹지 않게)",
    (M.buildEscapeUrl(HREF, kakaoAos) || "").indexOf("S.browser_fallback_url=https%3A%2F%2F") !== -1,
    M.buildEscapeUrl(HREF, kakaoAos));
  ok("intent 는 원래 해시를 버린다(#Intent 와 충돌)",
    (M.buildEscapeUrl("https://p.buslink.co.kr/p#zz", instaAos) || "").indexOf("intent://p.buslink.co.kr/p#Intent") === 0,
    M.buildEscapeUrl("https://p.buslink.co.kr/p#zz", instaAos));
  ok("https 가 아니면 intent 를 만들지 않는다", M.buildEscapeUrl("about:blank", instaAos) === null);
  ok("빈 주소·빈 env 도 throw 없이 null",
    M.buildEscapeUrl("", kakaoAos) === null && M.buildEscapeUrl(HREF, null) === null && M.buildEscapeUrl(HREF, {}) === null);
}

console.log("\n[5b] buildEscapeFallbackUrl — 1단이 조용히 무시될 때의 2단");
{
  const kakaoAos = M.detectBrowserEnv(UA.kakaoAos);
  const kakaoIos = M.detectBrowserEnv(UA.kakaoIos);
  const instaIos = M.detectBrowserEnv(UA.instaIos);
  ok("안드는 파라미터 URL 이 2단으로 온다",
    M.buildEscapeFallbackUrl(HREF, kakaoAos) === HREF + "&openExternalBrowser=1",
    M.buildEscapeFallbackUrl(HREF, kakaoAos));
  ok("2단은 1단과 다른 주소다(같으면 같은 실패를 반복한다)",
    M.buildEscapeFallbackUrl(HREF, kakaoAos) !== M.buildEscapeUrl(HREF, kakaoAos));
  // 🔴 iOS 는 1단이 곧 마지막이다 — 여기서 같은 URL 을 또 주면 눌렀을 때 같은 이동을 두 번 한다.
  ok("🔴 iOS 카톡은 2단이 없다", M.buildEscapeFallbackUrl(HREF, kakaoIos) === null);
  ok("iOS 기타 인앱도 2단이 없다", M.buildEscapeFallbackUrl(HREF, instaIos) === null);
  ok("일반 브라우저는 2단이 없다", M.buildEscapeFallbackUrl(HREF, M.detectBrowserEnv(UA.chromeAos)) === null);
}

console.log("\n[6] buildEscapeGuide — 화면에 그대로 나가는 문구");
{
  const g1 = M.buildEscapeGuide(HREF, M.detectBrowserEnv(UA.kakaoAos));
  ok("🔴 일반 브라우저면 안내 자체가 없다(설치 팝업을 가리지 않는다)",
    M.buildEscapeGuide(HREF, M.detectBrowserEnv(UA.chromeAos)) === null);
  ok("카톡이면 안내가 있다", !!g1);
  // 🔴 아래 단언들은 전부 «값이 없으면 크래시» 가 아니라 «빨간불» 로 떨어져야 한다 —
  //    게이트에서 테스트가 throw 로 죽으면 뒤따르는 단언이 통째로 안 돌아 실패를 가린다
  //    (2026-09-04 뮤테이션 대조군이 실제로 이걸 잡았다).
  ok("승객이 알아보는 앱 이름이 본문에 있다", !!(g1 && g1.body) && g1.body.indexOf("카카오톡") !== -1, g1 && g1.body);
  ok("버튼 라벨이 있다", !!g1 && typeof g1.buttonLabel === "string" && g1.buttonLabel.length > 0, g1 && g1.buttonLabel);
  // 🔴 2026-09-04 실기기 실패로 뒤집힌 계약 — 예전엔 «버튼이 있으면 손안내는 없다» 였다.
  //    자동 탈출이 조용히 안 먹는 기기가 실재하므로(way 폰이 그랬다), 버튼과 손안내를 함께 준다.
  //    이게 없으면 승객은 «눌렀는데 아무 일도 안 일어난다» 에서 멈춘다.
  ok("🔴 버튼이 있어도 손안내를 함께 띄운다(자동 탈출이 실패할 수 있다)",
    !!g1 && typeof g1.manualHint === "string" && g1.manualHint.length > 0, g1 && g1.manualHint);
  // 🔴 카톡 안드 메뉴는 **하단바 오른쪽 ⋮** 다(way 실기기 스크린샷 실측). «위» 라고 적으면 못 찾는다.
  ok("🔴 안드 손안내가 «오른쪽 아래» 를 가리킨다(카톡 메뉴는 하단바에 있다)",
    !!(g1 && g1.manualHint) && g1.manualHint.indexOf("오른쪽 아래") !== -1, g1 && g1.manualHint);
  ok("안드 손안내가 «위» 라고 말하지 않는다",
    !!(g1 && g1.manualHint) && g1.manualHint.indexOf("오른쪽 위") === -1, g1 && g1.manualHint);
  ok("탈출 URL 은 intent 다", !!g1 && typeof g1.escapeUrl === "string" && g1.escapeUrl.indexOf("intent://") === 0);
  ok("2단 폴백도 함께 실린다", !!g1 && g1.escapeFallbackUrl === HREF + "&openExternalBrowser=1");

  const g2 = M.buildEscapeGuide(HREF, M.detectBrowserEnv(UA.instaIos));
  ok("iOS 기타 인앱은 버튼 없이 손안내", !!g2 && g2.buttonLabel === null && typeof g2.manualHint === "string");
  ok("iOS 손안내는 Safari 를 가리킨다", !!(g2 && g2.manualHint) && g2.manualHint.indexOf("Safari") !== -1, g2 && g2.manualHint);
  ok("iOS 기타 인앱은 탈출 URL 이 null", !!g2 && g2.escapeUrl === null);
  ok("iOS 는 2단 폴백도 null", !!g2 && g2.escapeFallbackUrl === null);

  const g3 = M.buildEscapeGuide(HREF, M.detectBrowserEnv(UA.naver));
  ok("네이버(안드)는 버튼이 나온다",
    !!g3 && typeof g3.buttonLabel === "string" && typeof g3.escapeUrl === "string" && g3.escapeUrl.indexOf("intent://") === 0);
  ok("네이버 본문에 네이버가 적힌다", !!(g3 && g3.body) && g3.body.indexOf("네이버") !== -1);

  ok("env 가 없으면 안내 없음", M.buildEscapeGuide(HREF, null) === null && M.buildEscapeGuide(HREF, {}) === null);
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail === 0 ? 0 : 1);
