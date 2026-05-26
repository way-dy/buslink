// src/lib/stopMapping.js — 탑승 시점 차량 GPS 좌표를 노선 정류장으로 매핑
// ---------------------------------------------------------------------------
//   - nearestStop(lat, lng, stops, maxMeters): 좌표에서 가장 가까운 stops 항목 결정.
//     좌표가 maxMeters 초과면 null(미매핑) — 정밀성 보존.
//   - aggregateBoardingsByStop(boardings, stopsByRoute, maxMeters):
//     boardings 배열 → routeId별 stops에 매핑 → 정류장별 카운트 집계.
//     반환: { mapped: [{ routeId, routeName, stopId, stopName, count }], unmapped, noGps }
// 순수 함수, Firebase/외부 SDK import 없음. routeProgress.haversine 재사용.
// ---------------------------------------------------------------------------

import { haversine } from "./routeProgress";

const DEFAULT_MAX_METERS = 300; // 정류장 반경 300m 이내만 매핑(임계 거리)

export function nearestStop(lat, lng, stops, maxMeters = DEFAULT_MAX_METERS) {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Array.isArray(stops) || stops.length === 0) return null;
  let best = null, bestD = Infinity;
  for (const s of stops) {
    if (typeof s.lat !== "number" || typeof s.lng !== "number") continue;
    const d = haversine({ lat, lng }, { lat: s.lat, lng: s.lng });
    if (d < bestD) { bestD = d; best = s; }
  }
  if (best == null) return null;
  if (bestD > maxMeters) return null;
  return { stop: best, distance: bestD };
}

export function aggregateBoardingsByStop(boardings, stopsByRoute, maxMeters = DEFAULT_MAX_METERS) {
  // 매핑 결과 누적 — key = `${routeId}::${stopId}`
  const byKey = new window.Map();
  let unmapped = 0; // GPS 있으나 임계 초과(어느 정류장 반경에도 안 들어옴)
  let noGps = 0;   // GPS 좌표 자체가 boarding에 없음(legacy 또는 GPS 미수신)
  for (const b of boardings) {
    // boarding이 stopId 명시 보유 시 우선(기존 EmployeeApp 등이 채워준 경우 — 현재는 미사용 경로 보존).
    if (b.stopId && b.stopName) {
      const k = `${b.routeId || "_unknown"}::${b.stopId}`;
      const cur = byKey.get(k) || { routeId: b.routeId, routeName: b.routeName || "노선 미지정",
        stopId: b.stopId, stopName: b.stopName, count: 0, minDist: null };
      cur.count++;
      byKey.set(k, cur);
      continue;
    }
    // 차량 GPS 좌표 + 해당 routeId stops 로 매핑
    const stops = stopsByRoute[b.routeId];
    if (typeof b.vehicleLat !== "number" || typeof b.vehicleLng !== "number") {
      noGps++;
      continue;
    }
    const match = nearestStop(b.vehicleLat, b.vehicleLng, stops, maxMeters);
    if (!match) {
      unmapped++;
      continue;
    }
    const k = `${b.routeId || "_unknown"}::${match.stop.id}`;
    const cur = byKey.get(k) || {
      routeId: b.routeId, routeName: b.routeName || "노선 미지정",
      stopId: match.stop.id, stopName: match.stop.name,
      count: 0, minDist: match.distance,
    };
    cur.count++;
    if (cur.minDist == null || match.distance < cur.minDist) cur.minDist = match.distance;
    byKey.set(k, cur);
  }
  // 카운트 내림차순 정렬
  const mapped = [...byKey.values()].sort((a, b) => b.count - a.count);
  return { mapped, unmapped, noGps };
}
