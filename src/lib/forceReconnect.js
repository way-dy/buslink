// src/lib/forceReconnect.js — 수동 "새로고침" 시 Firestore 강제 재연결
// ---------------------------------------------------------------------------
// 운행 중 기사 폰 GPS가 껐다 켜지면 gps/{cid}_{vehicleId} 문서는 갱신되는데
// 관제/사용자 화면의 onSnapshot 리스너가 stale 상태(살아있는 듯 새 doc 못 받음)일 수
// 있음(useOnlineRecover 는 online 전이만 잡음 — 데이터망이 안 끊겼으면 미발화).
// 사용자/관리자가 직접 누르는 "노선 새로고침" 버튼이 호출 → disableNetwork→enableNetwork
// 로 클라이언트 reconnect 를 강제(모든 활성 리스너가 서버 현재 docs 로 즉시 재발화).
//
// 사용:
//   await forceReconnect();
//   setManualTick(t => t + 1);  // + 특정 onSnapshot useEffect deps 재구독
//
// 순수 함수(React 훅 아님). 카카오 SDK import 없음.
// ---------------------------------------------------------------------------

import { disableNetwork, enableNetwork } from "firebase/firestore";
import { db } from "../firebase";

export async function forceReconnect() {
  try {
    await disableNetwork(db);
    await enableNetwork(db);
    return true;
  } catch (e) {
    console.warn("[BusLink] 수동 재연결 실패:", e.message);
    return false;
  }
}
