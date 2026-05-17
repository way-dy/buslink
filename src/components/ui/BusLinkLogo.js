// src/components/ui/BusLinkLogo.js — 워드마크 (순수 프레젠테이션)
// 목업 design/src/common.jsx BusLinkLogo 1:1 ESM 포트.
import React from 'react';
import { C } from './tokens';

export function BusLinkLogo({ size = 22, color, sub }) {
  const c = color || C.primary;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <rect x="2" y="4" width="20" height="14" rx="4" fill={c} />
        <rect x="5" y="7" width="6" height="5" rx="1.5" fill="#fff" opacity=".95" />
        <rect x="13" y="7" width="6" height="5" rx="1.5" fill="#fff" opacity=".95" />
        <circle cx="7" cy="20" r="2.2" fill={c} stroke="#fff" strokeWidth="1.2" />
        <circle cx="17" cy="20" r="2.2" fill={c} stroke="#fff" strokeWidth="1.2" />
        <rect x="9" y="14.5" width="6" height="1.5" rx=".7" fill="#fff" opacity=".7" />
      </svg>
      <span style={{ fontFamily: 'var(--font-brand)', fontWeight: 800, fontSize: size * 0.86, letterSpacing: '-0.03em', color: color === '#fff' ? '#fff' : '#0B1020' }}>
        Bus<span style={{ color: c }}>Link</span>
      </span>
      {sub && <span style={{ fontSize: 11, color: C.labelMute, fontWeight: 600, marginLeft: 4, letterSpacing: 0 }}>{sub}</span>}
    </div>
  );
}

export default BusLinkLogo;
