// src/components/ui/BusLinkLogo.js — 워드마크 (순수 프레젠테이션)
// 목업 design/src/common.jsx BusLinkLogo 1:1 ESM 포트.
import React from 'react';
import { C } from './tokens';

// 🔴 기본색을 **CSS 변수**로 둔다(2026-08-27). 예전 기본값은 `tokens.js` 의 정적 상수
//    `C.primary` 라, 거래처 브랜딩·테마를 켜도 **로고만 늘 기본 파랑**으로 남았다
//    (카카오 톤 안내서를 만들다 픽셀에서 잡혔다 — 버튼은 #4088FE 인데 로고는 #0066FF).
//    `color` 를 명시로 넘기면 그 값이 이긴다(어두운 배경 위 흰 로고 등).
// 🔴 `name` 을 주면 워드마크 글자를 그 값으로 바꾼다(2026-08-28, 거래처 워드마크).
//    안 주면 예전과 **글자 그대로** 같다 — "Bus" 는 먹색, "Link" 만 브랜드색.
//    거래처 이름은 색을 쪼개지 않고 한 색(먹색)으로 쓴다: 어디를 강조할지는 그 회사의
//    아이덴티티라 우리가 정할 일이 아니고, 두 토막 중 하나만 파랗게 칠하면 대개 어색해진다.
export function BusLinkLogo({ size = 22, color, sub, name }) {
  const c = color || "var(--color-primary)";
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
        {name ? name : <>Bus<span style={{ color: c }}>Link</span></>}
      </span>
      {sub && <span style={{ fontSize: 11, color: C.labelMute, fontWeight: 600, marginLeft: 4, letterSpacing: 0 }}>{sub}</span>}
    </div>
  );
}

export default BusLinkLogo;
