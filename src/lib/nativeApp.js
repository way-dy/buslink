// ─── 네이티브 앱(Capacitor 래퍼) 안에서 열렸는가 (2026-10-06) ─────────────────
// 승객앱 iOS 스토어 출시 트랙 — `~/buslink-passenger`(Mac) 래퍼가 원격 모드
// (`server.url`=p.buslink.co.kr/p)로 이 웹을 그대로 띄운다. Capacitor 는 문서 시작 시점에
// `window.Capacitor` 를 주입하므로 React 렌더 전에도 판별된다.
// 🔴 브라우저·PWA 에서는 항상 false — 이 파일의 분기는 웹 사용자에게 아무것도 바꾸지 않는다.
export function isNativeApp() {
  try {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  } catch {
    return false;
  }
}

// 앱 안에서는 WKWebView 가 화면 전체(상태바·홈 막대 아래까지)를 차지한다.
// `viewport-fit=cover` 가 없으면 iOS 가 안전 영역만큼 스크롤 여유를 만들어
// 화면 전체가 위아래로 밀리고(탭바가 화면 밖으로 사라짐) 상단이 시계와 겹친다(실기기 실측).
// cover 로 바꾸면 `env(safe-area-inset-*)` 가 실제 값을 갖고, 각 화면이 그만큼 비켜 그린다.
// 웹에서는 cover 를 켜지 않는다 → env() 는 0 → 기존 화면 그대로.
export function applyNativeViewport() {
  if (!isNativeApp()) return;
  const meta = document.querySelector('meta[name="viewport"]');
  if (meta && !/viewport-fit/.test(meta.content)) {
    meta.setAttribute("content", meta.content + ", viewport-fit=cover");
  }
  document.documentElement.classList.add("native-app");
}
