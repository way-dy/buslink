// src/components/ui/StatusDot.js — 상태 점(펄스 옵션) (순수 프레젠테이션)
// 목업 design/src/common.jsx StatusDot 1:1 ESM 포트.
// pulse 사용 시 keyframes 'blpulse' 가 전역에 정의돼 있어야 함(원본 목업도 동일 전제).
import React from 'react';
import { C } from './tokens';

export function StatusDot({ tone = 'positive', size = 8, pulse }) {
  const color = { positive: C.positive, warn: C.cautionary, danger: C.destructive, neutral: C.labelMute, primary: C.primary }[tone];
  return (
    <span style={{ position: 'relative', display: 'inline-block', width: size, height: size }}>
      {pulse && <span style={{ position: 'absolute', inset: -3, borderRadius: '50%', background: color, opacity: 0.25, animation: 'blpulse 1.6s ease-out infinite' }} />}
      <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: color }} />
    </span>
  );
}

export default StatusDot;
