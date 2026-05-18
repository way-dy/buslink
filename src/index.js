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