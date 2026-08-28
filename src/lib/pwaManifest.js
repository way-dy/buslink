// 앱별 PWA manifest / apple-touch-icon / 앱 제목 동적 교체 유틸 (순수 DOM, Firebase 무관).
//
// buslink 라우팅상 정적 path-scope 는 /p 만 가능하고, 기사앱(DriverApp)은
// /(루트)에서 Auth 역할 분기로 마운트되므로 단일 정적 manifest 로는 앱별 설치
// 아이콘을 줄 수 없다. 따라서 해당 앱 컴포넌트 마운트 시점에 <head> 의
// link[rel=manifest] / link[rel=apple-touch-icon] / meta[apple-mobile-web-app-title]
// 를 그 앱 전용 값으로 교체한다. beforeinstallprompt(안드)·iOS 홈 화면 추가는
// 모두 마운트 이후 시점이라 마운트 1회 교체로 충분. idempotent — 같은 값으로
// 여러 번 호출해도 안전(메타 태그 없으면 1회 생성).
export function applyAppManifest({ manifestHref, appleTouchHref, title, faviconHref }) {
  if (typeof document === "undefined") return;

  // 파비콘(2026-08-28) — 거래처 워드마크를 쓰는 화면은 브라우저 탭 아이콘까지 그 브랜드로.
  // 🔴 `index.js` 가 부팅 때 앱별 아이콘으로 이미 한 번 바꾼다. 여기서는 거래처가 정해진 뒤
  //    **덧칠**하는 것이고, 거래처가 없으면 호출부가 앱 기본값을 다시 넘겨 원복시킨다.
  if (faviconHref) {
    const icon = document.querySelector('link[rel="icon"]');
    if (icon && icon.getAttribute("href") !== faviconHref) icon.setAttribute("href", faviconHref);
  }

  if (manifestHref) {
    const link = document.querySelector('link[rel="manifest"]');
    if (link && link.getAttribute("href") !== manifestHref) {
      link.setAttribute("href", manifestHref);
    }
  }

  if (appleTouchHref) {
    const apple = document.querySelector('link[rel="apple-touch-icon"]');
    if (apple && apple.getAttribute("href") !== appleTouchHref) {
      apple.setAttribute("href", appleTouchHref);
    }
  }

  if (title) {
    let meta = document.querySelector('meta[name="apple-mobile-web-app-title"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "apple-mobile-web-app-title");
      document.head.appendChild(meta);
    }
    if (meta.getAttribute("content") !== title) {
      meta.setAttribute("content", title);
    }
  }
}
