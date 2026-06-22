// src/lib/useExitConfirm.js — 뒤로가기 종료 확인 훅(순수 React, Firebase import 금지)
// ---------------------------------------------------------------------------
// 고객 호소: 뒤로가기 누르면 확인 없이 바로 종료. "정말 종료하시겠습니까?" 1회 확인 추가.
//
// 동작:
//   - 마운트 시 history 에 더미 항목 1회 push(현재 URL) → 첫 뒤로가기가 그 더미를
//     소비하며 popstate 발화(실제 종료/이탈 전에 가로채기).
//   - popstate 발화 시 window.confirm("정말 종료하시겠습니까?"):
//       * true  → 추가 동작 없이 통과(브라우저가 한 칸 더 뒤로 가서 실제 이탈).
//       * false → 다시 더미를 push 해 현재 위치 고정(이탈 취소).
//   - 언마운트 시 popstate 리스너 정리(cleanup). idempotent.
//
// 한계: 설치형 PWA standalone 의 OS back 은 100% 강제 불가(브라우저 한계).
//       대부분 케이스는 잡힘. 앱 내 탭 전환은 state 기반이라 popstate 와 무관(영향 없음).
//       로그인 리다이렉트(window.location.replace)와 충돌 없도록 앱 마운트 후에만 동작.
// ---------------------------------------------------------------------------

import { useEffect } from "react";

export function useExitConfirm(message = "정말 종료하시겠습니까?") {
  useEffect(() => {
    if (typeof window === "undefined") return;

    // 마운트 시 더미 항목 1회 push — 첫 뒤로가기를 가로챌 발판.
    window.history.pushState(null, "", window.location.href);

    const onPopState = () => {
      // eslint-disable-next-line no-alert
      const leave = window.confirm(message);
      if (!leave) {
        // 이탈 취소 — 더미를 다시 push 해 현재 위치 고정.
        window.history.pushState(null, "", window.location.href);
      }
      // leave === true 면 추가 동작 없이 통과(브라우저가 이전 항목으로 이동).
    };

    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
    };
  }, [message]);
}
