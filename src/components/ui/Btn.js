// src/components/ui/Btn.js — 버튼 프리미티브 (순수 프레젠테이션)
// 목업 design/src/common.jsx Btn 1:1 ESM 포트.
// 핸들러 props (1단계 LoginApp 채택 시 확장, 2026-05-16):
//   - 원본 목업 Btn 은 onClick/type/disabled 미수신(전시용)이었음.
//   - 실제 폼에서 쓰려면 핸들러가 필요해 onClick/type/disabled/title 추가.
//   - 시각 동일성 보존: 기존 스타일 그대로, disabled 일 때만 opacity 0.6 +
//     cursor not-allowed 적용(추가 시각 토큰 신설 없음).
import React from 'react';
import { C } from './tokens';

export function Btn({
  variant = 'primary', size = 'md', children, icon, style, dark,
  onClick, type = 'button', disabled = false, title,
}) {
  const sizes = {
    sm: { padding: '6px 12px', font: 13, radius: 8, gap: 6 },
    md: { padding: '10px 16px', font: 14, radius: 10, gap: 8 },
    lg: { padding: '14px 22px', font: 16, radius: 12, gap: 10 },
  }[size];
  const variants = {
    primary: { bg: C.primary, fg: '#fff', border: 'transparent' },
    primaryDark: { bg: '#fff', fg: C.bgDark, border: 'transparent' },
    secondary: { bg: dark ? 'rgba(255,255,255,0.08)' : '#fff', fg: dark ? '#E8EBF2' : C.label, border: dark ? 'rgba(255,255,255,0.12)' : C.line },
    ghost: { bg: 'transparent', fg: dark ? '#E8EBF2' : C.label, border: 'transparent' },
    danger: { bg: '#fff', fg: C.destructive, border: '#F6C9C9' },
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: sizes.gap,
        padding: sizes.padding, fontSize: sizes.font, fontWeight: 600, letterSpacing: 0,
        borderRadius: sizes.radius, background: variants.bg, color: variants.fg,
        border: `1px solid ${variants.border}`,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        whiteSpace: 'nowrap', fontFamily: 'inherit', ...style,
      }}>
      {icon}{children}
    </button>
  );
}

export default Btn;
