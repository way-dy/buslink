// src/lib/useOnlineRecover.js — 네트워크 복구 감지 + Firestore 재연결 강제 훅
// ---------------------------------------------------------------------------
// 모바일/PWA에서 장시간 오프라인 후 복구 시 Firestore 클라이언트가 reconnect 지연되거나
// onSnapshot 리스너가 stale 상태로 살아있는 듯하나 새 doc 변경 못 받는 결함이 있음
// (기사앱 노선 변경/재시작 호소의 근인). `useWakeTick`(visibilitychange)이 백그라운드
// 복귀는 잡지만 "온라인 전이"는 별도 신호.
//
// 사용: const tick = useOnlineRecover({ forceFirestoreReconnect: true });
//       useEffect(()=>{...}, [..., tick])
//
// 동작:
//   - `window.online` 이벤트 + `navigator.onLine` 전이(false→true)에서 tick(+1).
//   - 첫 마운트(이미 online) 시점은 tick 안 함 — useEffect 본체가 1회 구독 후 tick
//     증가 시 unsub→재구독 → Firestore가 현재 docs 즉시 fire.
//   - options.forceFirestoreReconnect 가 true면 online 전이 시 `disableNetwork(db)`
//     → `enableNetwork(db)` 1회 강제(reconnect 지연 우회). 옵셔널.
// 순수 React 훅, 카카오 SDK import 없음.
// ---------------------------------------------------------------------------

import { useEffect, useState, useRef } from "react";
import { disableNetwork, enableNetwork } from "firebase/firestore";
import { db } from "../firebase";

export function useOnlineRecover(options) {
  const { forceFirestoreReconnect = false } = options || {};
  const [tick, setTick] = useState(0);
  const lastOnlineRef = useRef(
    typeof navigator !== "undefined" ? navigator.onLine !== false : true
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onOnline = async () => {
      // 첫 마운트 시 이미 online이었다면 lastOnlineRef=true → 이 콜백은 발화 안 함.
      if (lastOnlineRef.current) return;
      lastOnlineRef.current = true;
      if (forceFirestoreReconnect) {
        try {
          await disableNetwork(db);
          await enableNetwork(db);
        } catch (e) {
          console.warn("[BusLink] Firestore reconnect 실패:", e.message);
        }
      }
      setTick(t => t + 1);
    };
    const onOffline = () => { lastOnlineRef.current = false; };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [forceFirestoreReconnect]);

  return tick;
}
