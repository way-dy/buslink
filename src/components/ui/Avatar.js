// src/components/ui/Avatar.js — 이니셜 아바타 (순수 프레젠테이션)
// 목업 design/src/common.jsx Avatar 1:1 ESM 포트.
import React from 'react';
import { C } from './tokens';

export function Avatar({ name = '김', tone = 'primary', size = 32 }) {
  const palette = {
    primary: { bg: C.primarySoft, fg: C.primaryDeep },
    violet: { bg: '#F0ECFE', fg: '#4E22A8' },
    positive: { bg: '#E6F7EB', fg: '#007A29' },
    warn: { bg: '#FFF1E0', fg: '#B95300' },
    cyan: { bg: '#D8F2EF', fg: '#006E66' },
    pink: { bg: '#FCDDEA', fg: '#B41867' },
  }[tone];
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: palette.bg, color: palette.fg, fontWeight: 700, fontSize: size * 0.42,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    }}>{name.slice(0, 1)}</div>
  );
}

export default Avatar;
