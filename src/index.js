import React from 'react';
import ReactDOM from 'react-dom/client';
// Pretendard self-host (npm 패키지, CDN 미사용) — @font-face 먼저 등록.
// dynamic-subset: 글리프 unicode-range 별 ~30KB woff2 분할(91개) → 화면에
// 실제 그려진 글자가 속한 subset 만 온디맨드 로드(전체 2MB 단일 폰트 대신
// 통상 ~150–450KB). font-display:swap 동일·동일 'Pretendard Variable'
// 패밀리·동일 weight(45 920) → 리디자인 라이트 룩 변화 0, 첫 로드만 가벼워짐.
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
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