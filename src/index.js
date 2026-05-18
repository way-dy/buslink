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