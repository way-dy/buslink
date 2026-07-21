// src/lib/useExitConfirm.js — 뒤로가기 종료 확인 훅(순수 React, Firebase import 금지)
// ---------------------------------------------------------------------------
// 고객 호소: 뒤로가기 누르면 확인 없이 바로 종료. "정말 종료하시겠습니까?" 1회 확인 추가.
//
// 동작:
//   - **첫 사용자 제스처(탭/키 입력) 시** history 에 더미 항목 1회 push(현재 URL)
//     → 첫 뒤로가기가 그 더미를 소비하며 popstate 발화(실제 종료/이탈 전에 가로채기).
//   - popstate 발화 시 window.confirm("정말 종료하시겠습니까?"):
//       * true  → 추가 동작 없이 통과(브라우저가 한 칸 더 뒤로 가서 실제 이탈).
//       * false → 다시 더미를 push 해 현재 위치 고정(이탈 취소).
//   - 발판은 항상 1개만 유지(armed 플래그) — 여러 개면 "확인"을 눌러도 안 나가진다.
//   - 언마운트 시 리스너 정리(cleanup). idempotent.
//
// ⚠ 왜 마운트 즉시가 아니라 "제스처 후"인가 (2026-07-21 배시현 재신고):
//   안드로이드 크롬은 **사용자 제스처 없이 push 된 history 항목을 뒤로가기 때 건너뛴다**
//   (history manipulation intervention). 마운트 시점 push 는 제스처가 없어 이 대상이 되어
//   팝업이 아예 안 뜬다(데스크톱 크롬에서는 정상 동작 → "됐다가 안 되는" 증상의 정체).
//   제스처 직후 push 한 항목은 건너뛰지 않으므로 발판이 유효해진다.
//   대신 앱을 열자마자 아무것도 안 만지고 뒤로가면 팝업 없이 나간다(잃을 입력이 없는 상태).
//
// 한계: 설치형 PWA standalone 의 OS back 은 100% 강제 불가(브라우저 한계).
//       앱 내 탭 전환은 state 기반이라 popstate 와 무관(영향 없음).
//       로그인 리다이렉트(window.location.replace)와 충돌 없도록 앱 마운트 후에만 동작.
// ---------------------------------------------------------------------------

import { useEffect } from "react";

const GESTURE_EVENTS = ["pointerdown", "touchstart", "keydown"];

export function useExitConfirm(message = "정말 종료하시겠습니까?") {
  useEffect(() => {
    if (typeof window === "undefined") return;

    let armed = false;    // 발판(더미 history 항목) 설치 여부 — 항상 최대 1개
    let leaving = false;  // "확인" 눌러 실제 이탈 중 — 재확인 루프 차단

    const arm = () => {
      if (armed) return;
      armed = true;
      window.history.pushState({ __exitGuard: true }, "", window.location.href);
    };

    const onPopState = () => {
      if (leaving) return;   // 이탈 진행 중 발화 — 다시 묻지 않는다
      armed = false;         // 발판이 소비됨
      // eslint-disable-next-line no-alert
      const leave = window.confirm(message);
      if (!leave) { arm(); return; }   // 이탈 취소 — 발판 재설치(현재 위치 고정)
      // 확인 — 발판만 소비된 상태(현재 위치 그대로)라 한 칸 더 뒤로 보내야 실제로 나간다.
      // (안 그러면 "확인"을 눌러도 앱에 그대로 남아 한 번 더 눌러야 하는 결함.)
      leaving = true;
      window.history.back();
      // 이전 항목이 없어 back 이 무효인 경우(새 탭 첫 진입) 재무장 가능하도록 해제.
      window.setTimeout(() => { leaving = false; }, 1000);
    };

    GESTURE_EVENTS.forEach(t => window.addEventListener(t, arm, { passive: true }));
    window.addEventListener("popstate", onPopState);
    return () => {
      GESTURE_EVENTS.forEach(t => window.removeEventListener(t, arm));
      window.removeEventListener("popstate", onPopState);
    };
  }, [message]);
}
