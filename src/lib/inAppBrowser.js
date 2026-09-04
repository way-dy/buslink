// ════════════════════════════════════════════════════════════
// inAppBrowser — 인앱 브라우저 감지·탈출(2026-09-04)
//
// 배경: 거래처가 «어르신들이 홈 화면 설치를 못 한다» 고 알려 왔다. 코드를 실측해 보니
//   막힌 곳이 설치 버튼이 아니었다 — 승객은 안내 링크를 **카카오톡으로 받아 카톡 인앱
//   브라우저에서 연다**. 거기서는
//     ① `beforeinstallprompt` 가 아예 발생하지 않고
//     ② `InstallPrompt.isAndroidPwaCapable()` 이 카톡을 UA 로 제외하므로 수동 안내도 안 뜬다
//   = 설치 안내를 **본 적조차 없는** 승객이 대다수다. "설치가 어렵다" 가 아니라
//   "설치 화면이 안 나온다" 였다.
//
// 해결: 인앱 브라우저면 «설치하세요» 대신 «인터넷 브라우저로 열기» 를 먼저 보여준다.
//   - 카카오(톡·T): 주소에 openExternalBrowser=1 → 카카오가 기본 브라우저로 넘긴다.
//   - 그 외 안드로이드 인앱: intent://…;package=com.android.chrome 로 크롬 직행.
//   - iOS: 표준 탈출 수단이 없다 → 버튼을 만들지 않고 «⋯ → Safari로 열기» 안내만 한다.
//     🔴 여기서 버튼을 억지로 만들면 «눌러도 아무 일도 안 일어나는» 먹통 버튼이 된다.
//
// 🔴 **설치가 불가능한 곳에서 설치를 조르지 않는다** — 인앱 브라우저에 설치 팝업을 반복
//    노출하면 「닫아도 계속 뜨는데 눌러도 설치가 안 되는」 광고가 된다. 그래서 «설치할
//    때까지 팝업»(2026-09-04 way)과 이 모듈은 한 벌이다. 한쪽만 넣지 말 것.
//
// 순수 모듈: window·navigator·URL·URLSearchParams 접근 0(전부 인자로 받는다).
//   격리 테스트가 bare vm 에서 태우므로 그 전역들이 없다(accountCards.js 와 같은 제약).
// ════════════════════════════════════════════════════════════

/** 인앱 브라우저 종류. null = 인앱이 아님(일반 브라우저 또는 판별 불가). */
export const IN_APP = {
  KAKAOTALK: "kakaotalk",
  KAKAOT: "kakaot",
  NAVER: "naver",
  LINE: "line",
  FACEBOOK: "facebook",
  INSTAGRAM: "instagram",
  OTHER: "other",
};

// 화면에 그대로 쓰는 이름. 「인앱 브라우저」 같은 말은 어르신에게 통하지 않는다 —
// 승객이 **자기가 지금 무슨 앱 안에 있는지** 알아볼 수 있는 이름으로 적는다.
const IN_APP_LABEL = {
  [IN_APP.KAKAOTALK]: "카카오톡",
  [IN_APP.KAKAOT]: "카카오T",
  [IN_APP.NAVER]: "네이버",
  [IN_APP.LINE]: "라인",
  [IN_APP.FACEBOOK]: "페이스북",
  [IN_APP.INSTAGRAM]: "인스타그램",
  [IN_APP.OTHER]: "다른 앱",
};

/**
 * UA 문자열 → 실행 환경.
 * public/webview-check.html 의 판별식과 같은 계열이다(그쪽은 진단 페이지라 인라인 유지).
 * ⚠ 인앱 브라우저 UA 는 앱마다 제각각이라 **미검출이어도 일반 브라우저라고 단정하지 않는다** —
 *   호출부는 inApp === null 을 "인앱이 아니다" 가 아니라 "모른다" 로 다뤄야 안전하다.
 * @param {string} ua navigator.userAgent
 */
export function detectBrowserEnv(ua) {
  const s = String(ua == null ? "" : ua);
  const isIOS = /iPhone|iPad|iPod/i.test(s);
  const isAndroid = /Android/i.test(s);

  // 🔴 순서가 중요하다 — 카카오톡 UA 에도 daumkakao 가 섞여 들어오므로 카카오톡을 먼저 가른다.
  let inApp = null;
  if (/KAKAOTALK/i.test(s)) inApp = IN_APP.KAKAOTALK;
  else if (/kakaot|daumkakao|TIARA/i.test(s)) inApp = IN_APP.KAKAOT;
  else if (/NAVER\(inapp|NAVER\//i.test(s)) inApp = IN_APP.NAVER;
  else if (/\bLine\//i.test(s)) inApp = IN_APP.LINE;
  else if (/Instagram/i.test(s)) inApp = IN_APP.INSTAGRAM;
  else if (/FBAN|FBAV|FB_IAB/i.test(s)) inApp = IN_APP.FACEBOOK;
  // 안드로이드 WebView 표식(«; wv»)은 «앱 안에 박힌 브라우저» 의 일반 신호다.
  // Chrome 자체는 이 표식을 달지 않는다.
  else if (/;\s*wv\)/i.test(s)) inApp = IN_APP.OTHER;
  else if (/everytimeapp/i.test(s)) inApp = IN_APP.OTHER;

  return { isIOS, isAndroid, inApp, appLabel: inApp ? IN_APP_LABEL[inApp] : null };
}

/**
 * 링크에 카카오 탈출 파라미터를 붙인다.
 * 카카오톡·카카오T 는 주소에 openExternalBrowser=1 이 있으면 인앱 브라우저 대신
 * **기기 기본 브라우저**로 연다. 다른 앱은 이 값을 그냥 무시하므로 항상 붙여도 무해하다.
 * 🔴 이미 붙어 있으면 다시 붙이지 않는다 — 중복되면 카카오가 인식하지 못하는 사례가 있다.
 */
export function withExternalBrowserParam(url) {
  const s = String(url == null ? "" : url);
  if (!s) return s;
  const hashAt = s.indexOf("#");
  const head = hashAt === -1 ? s : s.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : s.slice(hashAt);
  if (/[?&]openExternalBrowser=/.test(head)) return s;
  return head + (head.indexOf("?") === -1 ? "?" : "&") + "openExternalBrowser=1" + hash;
}

/**
 * 지금 주소를 일반 브라우저에서 다시 열 URL. 탈출 수단이 없으면 null.
 * @param {string} href 현재 전체 주소(window.location.href)
 * @param {{isIOS:boolean,isAndroid:boolean,inApp:string|null}} env detectBrowserEnv 결과
 */
export function buildEscapeUrl(href, env) {
  const s = String(href == null ? "" : href);
  const e = env || {};
  if (!e.inApp || !s) return null;

  // 카카오 계열은 파라미터 한 개면 끝난다(안드로이드·iOS 공통으로 동작).
  if (e.inApp === IN_APP.KAKAOTALK || e.inApp === IN_APP.KAKAOT) {
    return withExternalBrowserParam(s);
  }

  // 🔴 iOS 는 카카오 말고는 표준 탈출 수단이 없다. intent: 는 안드로이드 전용이라
  //    사파리에서 누르면 아무 일도 안 일어난다 → 버튼을 만들지 않고 안내만 한다.
  if (!e.isAndroid) return null;

  // 안드로이드 기타 인앱: 크롬 직행. «#Intent» 가 프래그먼트 자리를 쓰므로 원래 해시는 버린다
  // (이 앱은 해시 라우팅을 쓰지 않는다 — react-router 없이 경로 기반 분기).
  const m = /^https?:\/\/(.+)$/i.exec(s);
  if (!m) return null;
  const noHash = m[1].split("#")[0];
  return "intent://" + noHash + "#Intent;scheme=https;package=com.android.chrome;end";
}

/**
 * 화면에 그대로 쓸 안내 문구 묶음. 컴포넌트가 분기문을 갖지 않게 여기서 다 만든다.
 * 인앱이 아니면 null(= 이 안내를 띄울 이유가 없다).
 */
export function buildEscapeGuide(href, env) {
  const e = env || {};
  if (!e.inApp) return null;
  const where = e.appLabel || "다른 앱";
  const escapeUrl = buildEscapeUrl(href, e);

  if (escapeUrl) {
    return {
      inApp: e.inApp,
      appLabel: where,
      escapeUrl,
      title: "앱으로 설치하려면 한 번만 더",
      body: "지금은 " + where + " 안에서 열려 있어 설치 버튼이 나오지 않습니다. "
        + "아래 버튼을 누르면 인터넷 브라우저로 옮겨지고, 거기서 설치할 수 있어요.",
      buttonLabel: "인터넷 브라우저로 열기",
      manualHint: null,
    };
  }

  // 탈출 버튼을 만들 수 없는 환경(주로 iOS 의 카카오 외 인앱) — 손으로 하는 법만 알려 준다.
  return {
    inApp: e.inApp,
    appLabel: where,
    escapeUrl: null,
    title: "앱으로 설치하려면 한 번만 더",
    body: "지금은 " + where + " 안에서 열려 있어 설치 버튼이 나오지 않습니다.",
    buttonLabel: null,
    manualHint: e.isIOS
      ? "화면 오른쪽 아래 «⋯» 를 누르고 «Safari로 열기» 를 선택해 주세요."
      : "화면 오른쪽 위 «⋮» 를 누르고 «다른 브라우저로 열기» 를 선택해 주세요.",
  };
}
