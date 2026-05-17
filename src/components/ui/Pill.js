// src/components/ui/Pill.js — 톤별 라벨 칩 (순수 프레젠테이션)
// 목업 design/src/common.jsx Pill 1:1 ESM 포트.
import React from 'react';
import { C } from './tokens';

export function Pill({ tone = 'neutral', children, dot, style }) {
  const palette = {
    neutral:  { bg: C.bgSoft,       fg: C.label,      dot: C.labelMute },
    primary:  { bg: C.primarySoft,  fg: C.primaryDeep, dot: C.primary },
    positive: { bg: '#E6F7EB',      fg: '#007A29',    dot: C.positive },
    warn:     { bg: '#FFF1E0',      fg: '#B95300',    dot: C.cautionary },
    danger:   { bg: '#FCE5E5',      fg: '#A81818',    dot: C.destructive },
    violet:   { bg: '#F0ECFE',      fg: '#4E22A8',    dot: C.violet },
    dark:     { bg: 'rgba(255,255,255,0.08)', fg: '#E8EBF2', dot: '#7C8597' },
  }[tone];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      background: palette.bg, color: palette.fg,
      fontSize: 12, fontWeight: 600, lineHeight: 1, letterSpacing: 0.02,
      padding: '5px 10px', borderRadius: 999, ...style,
    }}>
      {dot && <span style={{ width: 6, height: 6, borderRadius: '50%', background: palette.dot }} />}
      {children}
    </span>
  );
}

export default Pill;
