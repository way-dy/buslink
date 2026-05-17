// src/components/ui/index.js — 공통 UI 라이브러리 배럴
// ---------------------------------------------------------------------------
// 목업 design/src/common.jsx 프리미티브의 ESM 정본.
// window 전역 노출 없음, Firebase/로직 import 금지(순수 프레젠테이션).
// 0단계: 라이브러리 신설까지만 — 기존 src/pages/* 는 아직 미채택.
// 사용 예: import { Btn, Pill, Icon } from '../components/ui';
// ---------------------------------------------------------------------------

export { BusLinkLogo } from './BusLinkLogo';
export { Pill } from './Pill';
export { StatusDot } from './StatusDot';
export { Btn } from './Btn';
export { Avatar } from './Avatar';
export { Icon } from './Icon';
export { C } from './tokens';
