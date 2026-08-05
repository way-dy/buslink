// src/components/ui/Icon.js — 스트로크 아이콘 세트 (순수 프레젠테이션)
// 목업 design/src/common.jsx Icon 1:1 ESM 포트. 아이콘 세트 전부 보존.
// currentColor 기반 — 부모 color 상속.
import React from 'react';

export function Icon({ name, size = 18, stroke = 1.7 }) {
  const paths = {
    bus: <><rect x="3" y="5" width="18" height="12" rx="2.5"/><path d="M3 12h18"/><circle cx="8" cy="19" r="1.6"/><circle cx="16" cy="19" r="1.6"/></>,
    pin: <><path d="M12 22s7-7.3 7-13a7 7 0 1 0-14 0c0 5.7 7 13 7 13z"/><circle cx="12" cy="9" r="2.5"/></>,
    route: <><circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="18" r="2.2"/><path d="M8 6h6a4 4 0 0 1 4 4v2a4 4 0 0 1-4 4H10a4 4 0 0 0-4 4v-2"/></>,
    user: <><circle cx="12" cy="8" r="3.5"/><path d="M4 21c1-4 4.5-6 8-6s7 2 8 6"/></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.4"/><rect x="14" y="3" width="7" height="7" rx="1.4"/><rect x="3" y="14" width="7" height="7" rx="1.4"/><rect x="14" y="14" width="7" height="7" rx="1.4"/></>,
    bell: <><path d="M6 9a6 6 0 1 1 12 0c0 4 1.5 5.5 2 6H4c.5-.5 2-2 2-6z"/><path d="M10 19a2 2 0 0 0 4 0"/></>,
    qr: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3M21 14v7M17 17v4M14 21h3"/></>,
    chart: <><path d="M4 19V5M4 19h16"/><path d="M8 15v-3M12 15V8M16 15v-6"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
    search: <><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></>,
    arrow: <><path d="M5 12h14M13 5l7 7-7 7"/></>,
    chev: <><path d="M9 6l6 6-6 6"/></>,
    check: <><path d="M5 12.5l4.5 4.5L19 7"/></>,
    play: <path d="M7 5l12 7-12 7z" fill="currentColor" stroke="none"/>,
    pause: <><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.3l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2.3-1.3L13.5 3h-3l-.7 2.4a7 7 0 0 0-2.3 1.3L5.1 5.8 3.1 9.2l2 1.5A7 7 0 0 0 5 12a7 7 0 0 0 .1 1.3l-2 1.5 2 3.4 2.3-.9c.7.6 1.5 1 2.3 1.3L10.5 21h3l.7-2.4a7 7 0 0 0 2.3-1.3l2.3.9 2-3.4-2-1.5c.1-.4.2-.9.2-1.3z"/></>,
    download: <><path d="M12 4v12M7 11l5 5 5-5M5 20h14"/></>,
    filter: <><path d="M4 5h16l-6 8v6l-4-2v-4z"/></>,
    speed: <><path d="M5 18a8 8 0 1 1 14 0"/><path d="M12 18l4-6"/></>,
    clock: <><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/></>,
    eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></>,
    phone: <><path d="M5 4h3l2 5-2.5 1.5a11 11 0 0 0 6 6L15 14l5 2v3a2 2 0 0 1-2 2A15 15 0 0 1 3 6a2 2 0 0 1 2-2z"/></>,
    menu: <><path d="M4 7h16M4 12h16M4 17h16"/></>,
    close: <><path d="M6 6l12 12M18 6l-6 6-6 6"/></>,
    sparkle: <><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/><path d="M19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/></>,
    flag: <><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></>,
    globe: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></>,
    repeat: <><path d="M17 2l4 4-4 4"/><path d="M3 12V8a2 2 0 0 1 2-2h16"/><path d="M7 22l-4-4 4-4"/><path d="M21 12v4a2 2 0 0 1-2 2H3"/></>,
    home: <><path d="M4 10.5L12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z"/><path d="M9.5 20.5v-6h5v6"/></>,
  }[name];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
      {paths}
    </svg>
  );
}

export default Icon;
