// 오늘 노선 도착 기록(stopArrivals) 조회 훅 — 익명 화면 3곳 공용(2026-08-18).
//
// 🔴 왜 훅 하나인가: 같은 데이터를 승객앱(`/bus`)·직원앱(`/p`)·협력사 포털이 각자 구독하고
//    있었고, 셋 다 `dispatches` 를 직접 읽다가 **권한 거부를 빈 결과로 흡수**해 조용히
//    죽어 있었다. 세 벌로 고치면 다음 변경에서 또 갈린다 → 조회·병합·폴링을 여기 한 곳에.
//    서버 정본 = CF `getRouteStopArrivals`(functions/index.js).
//
// 🔴 폴링은 "버스가 실제로 달릴 때만" 돈다(`active`). 도착 기록은 버스가 움직일 때만
//    늘어나므로, 운행이 없으면 몇 번을 물어도 같은 답이다. 상시 폴링으로 바꾸면
//    승객 수 × 분 만큼 호출·읽기가 늘어난다(250명이면 하루 수십만 건).
//
// 실패는 조용히 빈 값 — 도착 기록이 없으면 화면은 계획 시각으로 폴백한다(기존 동작).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getFunctions, httpsCallable } from "firebase/functions";

const functions = getFunctions(undefined, "us-central1");

// 운행 중 갱신 주기. 정류장 도착은 몇 분에 한 번이라 60초면 충분하다.
export const STOP_ARRIVALS_POLL_MS = 60000;

/**
 * @param {Object}   p
 * @param {string}   p.companyId
 * @param {string[]} p.routeIds  조회할 노선(빈 배열이면 호출 안 함)
 * @param {boolean}  p.active    지금 이 노선에 버스가 달리는가(=폴링 여부)
 * @param {number}   [p.tick]    외부 재조회 신호(wake/online 복귀·수동 새로고침)
 * @returns {{ byRoute: Object, loaded: boolean, refresh: Function }}
 *   byRoute = { [routeId]: { count, arrivals: { [stopId]: ms } } }
 */
export function useRouteStopArrivals({ companyId, routeIds, active = false, tick = 0 }) {
  const [byRoute, setByRoute] = useState({});
  const [loaded, setLoaded] = useState(false);
  // 배열은 매 렌더 새 참조라 그대로 deps 에 넣으면 무한 재조회가 된다 → 정렬된 키로 고정.
  const key = useMemo(
    () => (Array.isArray(routeIds) ? routeIds.filter(Boolean).slice().sort().join("|") : ""),
    [routeIds]
  );
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  const refresh = useCallback(async () => {
    if (!companyId || !key) { setByRoute({}); setLoaded(true); return; }
    try {
      const call = httpsCallable(functions, "getRouteStopArrivals");
      const res = await call({ companyId, routeIds: key.split("|") });
      if (!aliveRef.current) return;
      setByRoute((res.data && res.data.routes) || {});
    } catch (e) {
      // 권한·네트워크 오류 → 도착 기록 없음으로 폴백(계획 시각 표시). 화면은 안 깨진다.
      console.warn("[stopArrivals] 조회 실패:", e?.message);
      if (aliveRef.current) setByRoute({});
    } finally {
      if (aliveRef.current) setLoaded(true);
    }
  }, [companyId, key]);

  useEffect(() => { setLoaded(false); refresh(); }, [refresh, tick]);

  useEffect(() => {
    if (!active || !companyId || !key) return;
    const t = setInterval(refresh, STOP_ARRIVALS_POLL_MS);
    return () => clearInterval(t);
  }, [active, companyId, key, refresh]);

  return { byRoute, loaded, refresh };
}

// 한 노선용 얕은 래퍼 — 승객앱·직원앱처럼 노선 하나만 보는 화면에서 쓴다.
// 반환 계약을 기존 `todayDispatch` 와 같은 모양으로 맞춘다(호출부 변경 최소화).
export function useOneRouteStopArrivals({ companyId, routeId, active = false, tick = 0 }) {
  const routeIds = useMemo(() => (routeId ? [routeId] : []), [routeId]);
  const { byRoute, loaded, refresh } = useRouteStopArrivals({ companyId, routeIds, active, tick });
  const entry = routeId ? byRoute[routeId] : null;
  // count 0(오늘 배차 없음)이면 null — 기존 `snap.empty → setTodayDispatch(null)` 과 같은 의미.
  const todayDispatch = useMemo(
    () => (entry && entry.count > 0 ? { stopArrivals: entry.arrivals || {} } : null),
    [entry]
  );
  return { todayDispatch, loaded, refresh };
}
