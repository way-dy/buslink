import React from 'react';
import ReactDOM from 'react-dom/client';
// Pretendard self-host (npm 패키지, CDN 미사용) — @font-face 먼저 등록
import 'pretendard/dist/web/variable/pretendardvariable.css';
import './index.css';
// 디자인 토큰 — index.css 의 시스템 폰트 body 규칙보다 뒤에 와야
// html,body{font-family:var(--font-base)} 가 우선 적용됨(전역 Pretendard 폴백).
import './styles/tokens.css';
import App from './App';
import reportWebVitals from './reportWebVitals';

// ── PWA manifest 조기 확정 (앱 설치 충돌 방지) ──────────────────────
// index.html 기본 manifest 는 manifest.json(관제, id/start_url '/?app=admin').
// EmployeeApp(/p)은 컴포넌트 마운트(익명로그인+데이터 로드 후)에 applyAppManifest 로
// manifest-employee.json 으로 교체하나, 그 사이 Chrome 이 beforeinstallprompt 를
// 옛 manifest 로 평가하면 직원앱이 '/'(기사/관제)로 잘못 설치된다(설치 충돌·교차 실행).
// pathname 으로 즉시 판별 가능한 /p 는 render·BIP 리스너 전에 동기 교체.
// '/' 의 admin/driver 는 Auth 역할 분기 후라 컴포넌트 마운트 시 applyAppManifest 가 처리.
// 3 manifest 는 각각 고유 id(/?app=admin · /?app=driver · /p)로 별개 PWA 보장.
if (typeof document !== "undefined") {
  const path = window.location.pathname;
  if (path.startsWith("/p") && !path.startsWith("/partner")) {
    const link = document.querySelector('link[rel="manifest"]');
    if (link) link.setAttribute("href", "/manifest-employee.json");
    const apple = document.querySelector('link[rel="apple-touch-icon"]');
    if (apple) apple.setAttribute("href", "/icons/passenger-1024.png");
  }
}

// PWA 설치 가이드 — beforeinstallprompt는 페이지 로드 직후 한 번 발생.
// 리스너가 늦게 붙는 라우트(기사앱 등 Firebase Auth+driver/dispatch 로드 대기)에서도
// 놓치지 않도록 글로벌 stash. InstallPrompt 마운트 시 이 값을 회수해 사용.
if (typeof window !== "undefined") {
  window.__buslinkDeferredBIP = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    window.__buslinkDeferredBIP = e;
  });
  window.addEventListener("appinstalled", () => { window.__buslinkDeferredBIP = null; });
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

reportWebVitals();

// ── Service Worker 등록 (PWA 설치 프롬프트 활성화) ──
// beforeinstallprompt는 등록된 SW가 있어야 발화. notifications.js는 알림 초기화 시에만
// 등록하므로(권한 거부 시 미등록), 앱 로드 시 1회 선등록.
// 동일 URL register는 idempotent — notifications.js 재등록과 충돌 없음.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/firebase-messaging-sw.js")
      .catch((e) => console.warn("[SW] 등록 실패:", e.message));
  });
}