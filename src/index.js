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
import { resolveAppIcons } from './lib/appIcons';

// ── 앱별 아이콘·매니페스트 조기 확정 (favicon·apple-touch·manifest) ──────────
// 호스트명(서브도메인) 우선 + 경로 폴백으로 현재 앱을 판별해, React render·BIP(설치)
// 평가 전에 <head> 링크를 그 앱 전용으로 동기 교체. 서브도메인 분리(2026-06)로
// admin/d/p/partner 가 각각 자기 파비콘·애플터치·매니페스트를 받는다(index.html
// 기본값=admin). 마운트 useEffect 의 applyAppManifest 보다 먼저 확정해야 Chrome 이
// 옛 manifest 로 beforeinstallprompt 를 평가하는 교차-설치 결함을 막는다.
if (typeof document !== "undefined") {
  const ic = resolveAppIcons(window.location.hostname, window.location.pathname);
  const svgIcon = document.querySelector('link[rel="icon"][type="image/svg+xml"]');
  const manifest = document.querySelector('link[rel="manifest"]');
  const apple = document.querySelector('link[rel="apple-touch-icon"]');
  if (svgIcon) svgIcon.setAttribute("href", ic.favicon);
  if (manifest) manifest.setAttribute("href", ic.manifest);
  if (apple) apple.setAttribute("href", ic.apple);
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