// src/lib/useWakeTick.js — 탭 가시성 wake 감지 훅
// ---------------------------------------------------------------------------
// 모바일/PWA에서 장시간 백그라운드(전날부터 등) → 브라우저가 탭 frozen.
// Firestore `onSnapshot` 리스너가 살아있는 듯하나 새 doc 변경을 못 받는 stale.
// 사용자가 탭으로 돌아왔을 때 GPS·dispatch effect를 강제 재구독해야 신선화됨.
//
// 사용: const wakeTick = useWakeTick(); useEffect(()=>{...}, [..., wakeTick])
// 동작:
//   - `document.visibilitychange`: hidden→visible 전이 시에만 tick(+1).
//   - `window.pageshow` event.persisted=true(bfcache 복귀) 시 tick.
//   - 첫 마운트(visible 상태) 시점은 tick 안 함 — useEffect 본체가 1회 구독 후
//     wakeTick 변경 시 unsub→재구독. 0→1 전이 = 첫 wake.
// 순수 React 훅, Firebase/카카오 import 없음.
// ---------------------------------------------------------------------------

import { useEffect, useState, useRef } from "react";

export function useWakeTick() {
  const [tick, setTick] = useState(0);
  // 직전 visibility 상태 추적 — 마운트 시 'visible'을 기억해 즉시 tick 방지.
  const lastVisibleRef = useRef(
    typeof document !== "undefined" ? !document.hidden : true
  );

  useEffect(() => {
    if (typeof document === "undefined") return;

    const onVisChange = () => {
      const nowVisible = !document.hidden;
      // hidden → visible 전이만 wake로 간주
      if (nowVisible && !lastVisibleRef.current) {
        setTick(t => t + 1);
      }
      lastVisibleRef.current = nowVisible;
    };

    const onPageShow = (e) => {
      // bfcache 복귀(persisted=true) 또는 일반 표시 시 tick — 보수적
      if (e && e.persisted) setTick(t => t + 1);
    };

    document.addEventListener("visibilitychange", onVisChange);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVisChange);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);

  return tick;
}
