// src/components/ui/tokens.js
// ---------------------------------------------------------------------------
// 디자인 토큰의 JS 미러. 정본은 src/styles/tokens.css 의 CSS 변수.
// JS 로직(SVG fill, 팔레트 분기 등 CSS var 로 표현하기 곤란한 곳)에서만 사용.
// 값은 목업 design/src/common.jsx 의 C 객체와 1:1 (변경 금지 — 시각 동일성).
// 가능하면 컴포넌트는 var(--color-*) 를 직접 쓰고, 이 상수는 보조로만.
// ---------------------------------------------------------------------------

export const C = {
  primary: '#0066FF',
  primaryStrong: '#005EEB',
  primaryDeep: '#003DCC',
  primarySoft: '#EAF2FE',
  bg: '#FFFFFF',
  bgAlt: '#F7F7F8',
  bgSoft: '#F2F2F3',
  bgDark: '#0B1020',
  bgDarker: '#070A15',
  label: '#171719',
  labelStrong: '#000',
  labelMute: 'rgba(46,47,51,0.62)',
  labelAlt: 'rgba(46,47,51,0.40)',
  line: 'rgba(112,115,124,0.18)',
  lineSoft: 'rgba(112,115,124,0.10)',
  positive: '#00BF40',
  cautionary: '#FF7A00',
  destructive: '#E52222',
  violet: '#7B3FE4',
};

export default C;
