// src/components/ui/Icon.js — 스트로크 아이콘 세트 (순수 프레젠테이션)
// 목업 design/src/common.jsx Icon 1:1 ESM 포트. 아이콘 세트 전부 보존.
// currentColor 기반 — 부모 color 상속.
import React from 'react';

// 채움(solid) 변형 — 2026-08-05 way "아이콘도 색을 넣을 수 있는 감각적인 것으로".
// 선이 얇으면 거래처 브랜드색이 거의 안 읽힌다. **선택된 항목만** 면으로 채워
// 색이 또렷하게 들어오게 한다(비선택은 라인 유지 — 전부 채우면 뭐가 선택인지 모른다).
// 🔴 이 맵은 **추가분**이다. 없는 이름은 기존 라인 아이콘으로 자동 폴백하므로
//    다른 화면(AdminApp 등)의 기존 사용처는 아무 영향이 없다.
const SOLID_PATHS = {
  home: <path d="M11.02 3.3a1.6 1.6 0 0 1 1.96 0l7.4 5.76c.39.3.62.77.62 1.26V19a2.4 2.4 0 0 1-2.4 2.4h-3.4v-5.2a1.4 1.4 0 0 0-1.4-1.4h-3.6a1.4 1.4 0 0 0-1.4 1.4v5.2H5.4A2.4 2.4 0 0 1 3 19v-8.68c0-.49.23-.96.62-1.26z"/>,
  route: <><path d="M8.2 5.6a2.9 2.9 0 1 1-5.8 0 2.9 2.9 0 0 1 5.8 0zm13.4 12.8a2.9 2.9 0 1 1-5.8 0 2.9 2.9 0 0 1 5.8 0z"/><path d="M8.6 4.4h5.9a5.1 5.1 0 0 1 0 10.2h-4.6a2.7 2.7 0 0 0 0 5.4h5.2v2.4H9.9a5.1 5.1 0 0 1 0-10.2h4.6a2.7 2.7 0 0 0 0-5.4H8.6z"/></>,
  bell: <><path d="M12 2.4a6.6 6.6 0 0 0-6.6 6.6c0 3.5-1.1 4.7-1.7 5.4-.5.6-.1 1.5.7 1.5h15.2c.8 0 1.2-.9.7-1.5-.6-.7-1.7-1.9-1.7-5.4A6.6 6.6 0 0 0 12 2.4z"/><path d="M9.5 18.6a2.6 2.6 0 0 0 5 0z"/></>,
  qr: <><path d="M4.6 3h4.2A1.6 1.6 0 0 1 10.4 4.6v4.2a1.6 1.6 0 0 1-1.6 1.6H4.6A1.6 1.6 0 0 1 3 8.8V4.6A1.6 1.6 0 0 1 4.6 3zm10.6 0h4.2A1.6 1.6 0 0 1 21 4.6v4.2a1.6 1.6 0 0 1-1.6 1.6h-4.2a1.6 1.6 0 0 1-1.6-1.6V4.6A1.6 1.6 0 0 1 15.2 3zM4.6 13.6h4.2a1.6 1.6 0 0 1 1.6 1.6v4.2A1.6 1.6 0 0 1 8.8 21H4.6A1.6 1.6 0 0 1 3 19.4v-4.2a1.6 1.6 0 0 1 1.6-1.6z"/><path d="M13.6 13.6h3.1v3.1h-3.1zm4.3 0H21v3.1h-3.1zM13.6 17.9h3.1V21h-3.1zm4.3 0H21V21h-3.1z"/></>,
  settings: <path d="M13.87 3h-3.74l-.71 2.32c-.84.3-1.62.76-2.32 1.34l-2.33-.92-1.98 3.42 2.03 1.5a7.4 7.4 0 0 0 0 2.68l-2.03 1.5 1.98 3.42 2.33-.92c.7.58 1.48 1.04 2.32 1.34L10.13 21h3.74l.71-2.32c.84-.3 1.62-.76 2.32-1.34l2.33.92 1.98-3.42-2.03-1.5a7.4 7.4 0 0 0 0-2.68l2.03-1.5-1.98-3.42-2.33.92a7.3 7.3 0 0 0-2.32-1.34zM12 15.4a3.4 3.4 0 1 1 0-6.8 3.4 3.4 0 0 1 0 6.8z"/>,
  chat: <path d="M12.5 3.5A8.5 8.5 0 0 0 4.9 15.8L3 21.5l5.7-1.9a8.5 8.5 0 1 0 3.8-16.1z"/>,
  // 2026-08-10 승객앱 이모지 제거용 — 채움형이 필요한 것들(즐겨찾기·운행중 점 등)
  star: <path d="M12 3.2l2.6 5.3 5.8.85-4.2 4.1 1 5.8-5.2-2.73-5.2 2.73 1-5.8-4.2-4.1 5.8-.85z"/>,
  dot: <circle cx="12" cy="12" r="5"/>,
};

export function Icon({ name, size = 18, stroke = 1.7, solid = false }) {
  if (solid && SOLID_PATHS[name]) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="none">
        {SOLID_PATHS[name]}
      </svg>
    );
  }
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
    chat: <><path d="M12.5 3.5A8.5 8.5 0 0 0 4.9 15.8L3 21.5l5.7-1.9a8.5 8.5 0 1 0 3.8-16.1z"/><path d="M8.8 10.5h7M8.8 14h4.5"/></>,
    // 2026-08-10 승객앱 이모지 제거용 신규 — 이모지는 OS 마다 모양·색이 달라
    // 아무리 배치를 다듬어도 화면이 싸구려로 보인다(way 고객 피드백 "조잡").
    star: <><path d="M12 3.6l2.5 5.1 5.6.8-4 3.95.95 5.6L12 16.4l-5 2.65.95-5.6-4-3.95 5.6-.8z"/></>,
    building: <><rect x="4" y="3" width="16" height="18" rx="1.8"/><path d="M8 7h2M14 7h2M8 11h2M14 11h2M8 15h2M14 15h2"/><path d="M10 21v-3h4v3"/></>,
    camera: <><path d="M3 8.5A2 2 0 0 1 5 6.5h2.2l1.2-2h7.2l1.2 2H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.6"/></>,
    dot: <circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none"/>,
    // 🔴 `repeat`(양방향 화살표=교체)와 구분되는 **원형 화살표**. 둘을 같은 아이콘으로 쓰면
    //    "노선 변경"과 "새로고침"이 한 줄에 나란히 있을 때 서로 구별이 안 된다(2026-08-10 실측).
    refresh: <><path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 4.2V10h-5.8"/></>,
  }[name];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
      {paths}
    </svg>
  );
}

export default Icon;
