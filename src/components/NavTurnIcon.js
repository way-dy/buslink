// 길안내 회전 픽토그램 (2026-08-06 way "지도 위에 엄청 크게 잘 보이게 · 애니메이션으로",
// "지하차도 옆길/진입은 아이콘 모양과 화살표 조합으로 가능?").
//
// 순수 프레젠테이션 — Firebase·상태 import 0. 종류 판정은 `lib/navGuide.turnIconKind` 가 하고
// 여기서는 그리기만 한다(판정과 그리기를 섞으면 문구↔그림 어긋남이 다시 생긴다).
//
// 🔴 **문자 글리프를 크게 키우지 않는다** — `⤓`·`⌸` 류는 Pretendard 에 없으면 두부(□)가 되고,
//    26px 에선 안 보이던 게 150px 에선 화면을 통째로 망친다. 그래서 직접 그린 SVG 를 쓰고,
//    모르는 종류일 때만 넘겨받은 글리프 문자로 폴백한다.
// 🔴 **지하차도/고가도로 "옆길"은 좌우를 그리지 않는다** — 카카오가 좌우를 안 준다(실측).
//    본선(상판/지하)을 비껴 빠진다는 것까지만 그리고 방향을 지어내지 않는다.
import React from "react";

// ── 지하차도·고가도로 공통 부품 ────────────────────────────────
// 상판(고가) · 천장(지하) 을 나타내는 가로 막대.
const DECK = <rect x="4" y="25" width="56" height="7" rx="2.5" fill="currentColor" opacity="0.55" />;
// 🔴 지하 vs 고가는 **본선이 막대를 어떻게 지나는가**로만 갈린다 —
//    아래로 지나면 막대가 선을 끊고(가려서 안 보인다), 위로 지나면 선이 이어진다.
//    색·투명도로 구분하려 하면 지도 배경 위에서 둘 다 흐릿해져 구분이 사라진다(실측).
// 🔴 아래 부품은 **함수가 아니라 상수 JSX** 로 둔다 — 검증 하네스가 소스에서 도형을 그대로
//    뽑아 렌더하는데, `{FN(1)}` 같은 호출은 못 풀어서 **그림이 텅 빈 채로 통과**한다
//    (2026-08-06 실제로 그렇게 한 번 속았다).
// 본선이 막대 아래로 — 막대 구간에서 끊긴다
// ⚠ `= (` 뒤에 주석을 달지 말 것: 하네스의 부품 추출 정규식이 못 읽어 그림이 빈 채로 나간다.
const UNDER_MAIN = (
  <path d="M32 60V38M32 19V9" fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round" />
);
const UNDER_MAIN_MUTED = (
  <path d="M32 60V38M32 19V9" fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round" opacity="0.5" />
);
// 본선이 막대 위로 — 끊김 없이 이어진다
const OVER_MAIN = (
  <path d="M32 60V9" fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round" />
);
const OVER_MAIN_MUTED = (
  <path d="M32 60V9" fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round" opacity="0.5" />
);
// 위쪽 화살촉(전진)
const HEAD_UP = (
  <path d="M32 9l-9 9m9-9 9 9" fill="none" stroke="currentColor" strokeWidth="7"
    strokeLinecap="round" strokeLinejoin="round" />
);
// 본선에서 갈라져 나가는 "옆길" 화살표.
// 🔴 카카오는 옆길의 **좌우를 주지 않는다**(2026-08-06 응답 전 키 확인). 그래서 이 그림은
//    "본선을 안 타고 옆으로 빠진다"까지만 말하고 방향을 주장하지 않는다 — 좌우는 배너 문구가
//    가진 만큼만 알려준다. 회전(↱)처럼 보이지 않게 **꺾지 않고 나란히** 올라가게 그린다.
const SIDE_BRANCH = (
  <path d="M32 58v-8c0-9 7-13 16-13V12m0 0-7 7m7-7 7 7"
    fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
);

const SHAPES = {
  // ── 회전 ──────────────────────────────────────────────
  left: (
    <path d="M40 56V32a10 10 0 0 0-10-10h-8m0 0 9-9m-9 9 9 9"
      fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
  ),
  right: (
    <path d="M24 56V32a10 10 0 0 1 10-10h8m0 0-9-9m9 9-9 9"
      fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
  ),
  "slight-left": (
    <path d="M38 56V38a12 12 0 0 1 3.5-8.5L50 21m0 0H37m13 0v13"
      fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round"
      transform="scale(-1,1) translate(-64,0)" />
  ),
  "slight-right": (
    <path d="M38 56V38a12 12 0 0 1 3.5-8.5L50 21m0 0H37m13 0v13"
      fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
  ),
  straight: (
    <path d="M32 57V12m0 0-11 11m11-11 11 11"
      fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
  ),
  uturn: (
    <path d="M22 57V26a10 10 0 0 1 20 0v14m0 0-8-8m8 8 8-8"
      fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
  ),
  goal: (
    <>
      <path d="M18 58V8" fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round" />
      <path d="M22 11h26l-6 9 6 9H22z" fill="currentColor" />
    </>
  ),

  // ── 지하차도 — 본선이 막대 **아래로**(선이 끊긴다) ──
  //    진입 = 내가 그 본선을 탄다(진하게) / 옆길 = 본선은 흐리게 두고 옆으로 빠진다
  "underpass-enter": (
    <>
      {DECK}
      {UNDER_MAIN}
      {HEAD_UP}
    </>
  ),
  "underpass-side": (
    <>
      {DECK}
      {UNDER_MAIN_MUTED}
      {SIDE_BRANCH}
    </>
  ),

  // ── 고가도로 — 본선이 막대 **위로**(선이 이어진다) ──
  "overpass-enter": (
    <>
      {DECK}
      {OVER_MAIN}
      {HEAD_UP}
    </>
  ),
  "overpass-side": (
    <>
      {DECK}
      {OVER_MAIN_MUTED}
      {SIDE_BRANCH}
    </>
  ),

  // ── 톨게이트 — 지붕 아래 차로를 통과 ──
  toll: (
    <>
      <path d="M8 22 32 10l24 12" fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="12" y="26" width="8" height="26" rx="2" fill="currentColor" opacity="0.45" />
      <rect x="44" y="26" width="8" height="26" rx="2" fill="currentColor" opacity="0.45" />
      <path d="M32 56V28m0 0-7 7m7-7 7 7"
        fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
};

/**
 * @param kind   `turnIconKind().kind` — 없으면 glyph 폴백
 * @param glyph  `turnGlyph()` 결과(폴백 문자). 둘 다 없으면 아무것도 안 그린다.
 * @param size   px
 */
export function NavTurnIcon({ kind, glyph, size = 28, title }) {
  const shape = kind ? SHAPES[kind] : null;
  if (!shape) {
    if (!glyph) return null;
    return <span aria-label={title} style={{ fontSize: size, lineHeight: 1 }}>{glyph}</span>;
  }
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={title || kind}
      style={{ display: "block", flexShrink: 0 }}>
      {shape}
    </svg>
  );
}

export default NavTurnIcon;
