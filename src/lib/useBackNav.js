// src/lib/useBackNav.js — createBackNav 의 React 껍데기(로직 0 · 배선만)
// 로직은 전부 `lib/backNav.js` 에 있다(브라우저 없이 검증 가능해야 해서 분리 — scripts/test_partner_back_nav.cjs).
import { useEffect, useMemo, useRef } from "react";
import { createBackNav } from "./backNav";

/**
 * @param {object}   o
 * @param {Function} o.onPop      () => boolean. 앱 안에서 한 화면 되돌렸으면 true.
 * @param {Function} o.onExitAsk  () => void. 나가기 확인 모달을 연다.
 */
export function useBackNav({ onPop, onExitAsk }) {
  // 콜백은 매 렌더 바뀌지만 리스너는 한 번만 단다 — ref 로 최신 것을 본다.
  const cbs = useRef({ onPop, onExitAsk });
  cbs.current = { onPop, onExitAsk };
  const navRef = useRef(null);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const nav = createBackNav({
      win: window,
      onPop: () => cbs.current.onPop?.() === true,
      onExitAsk: () => cbs.current.onExitAsk?.(),
    });
    navRef.current = nav;
    nav.start();
    return () => { nav.stop(); navRef.current = null; };
  }, []);

  // 신원이 고정된 조작 핸들(핸들러 deps 에 넣어도 안전).
  return useMemo(() => ({
    pushView: () => navRef.current?.pushView(),
    back: () => navRef.current?.back(),
    cancelExit: () => navRef.current?.cancelExit(),
    confirmExit: () => navRef.current?.confirmExit(),
  }), []);
}
