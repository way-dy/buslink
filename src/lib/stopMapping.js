// src/lib/stopMapping.js — 탑승 시점 차량 GPS 좌표를 노선 정류장으로 매핑
// ---------------------------------------------------------------------------
//   - nearestStop(lat, lng, stops, maxMeters): 좌표에서 가장 가까운 stops 항목 결정.
//     좌표가 maxMeters 초과면 null(미매핑) — 정밀성 보존.
//   - aggregateBoardingsByStop(boardings, stopsByRoute, maxMeters):
//     boardings 배열 → routeId별 stops에 매핑 → 정류장별 카운트 집계.
//     반환: { mapped: [{ routeId, routeName, stopId, stopName, stopOrder, count, minDist, items }], unmapped, noGps }
//     items = 그 정류장으로 판정된 boarding 원본들(화면에서 «누가 탔나»를 펼쳐 보여주는 근거).
//   - groupMappedByRoute(mapped, stopsByRoute): mapped 를 노선 그룹으로 묶고
//     **정류장을 버스가 지나는 순서대로** 정렬 + 노선 내 몇 번째 정류장인지(seq/routeStopCount) 부여.
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
    // 노선 정류장 목록(order asc 로 로드됨) — 순번 부여·GPS 매핑 양쪽이 쓴다.
    const stops = stopsByRoute[b.routeId];
    // boarding이 stopId 명시 보유 시 우선(기존 EmployeeApp 등이 채워준 경우 — 현재는 미사용 경로 보존).
    if (b.stopId && b.stopName) {
      const k = `${b.routeId || "_unknown"}::${b.stopId}`;
      // 순번은 노선 stops 에서 되찾는다. 정류장 문서가 지워졌으면 null → 그룹 맨 뒤로.
      const cur = byKey.get(k) || { routeId: b.routeId, routeName: b.routeName || "노선 미지정",
        stopId: b.stopId, stopName: b.stopName, stopOrder: stopOrderOf(stops, b.stopId),
        count: 0, minDist: null, items: [] };
      cur.count++;
      cur.items.push(b);
      byKey.set(k, cur);
      continue;
    }
    // 차량 GPS 좌표 + 해당 routeId stops 로 매핑
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
      stopOrder: typeof match.stop.order === "number" ? match.stop.order : null,
      count: 0, minDist: match.distance, items: [],
    };
    cur.count++;
    cur.items.push(b);
    if (cur.minDist == null || match.distance < cur.minDist) cur.minDist = match.distance;
    byKey.set(k, cur);
  }
  // 카운트 내림차순 정렬
  const mapped = [...byKey.values()].sort((a, b) => b.count - a.count);
  return { mapped, unmapped, noGps };
}

// 노선 stops 에서 stopId 의 순번(order)을 되찾는다. 없으면 null.
function stopOrderOf(stops, stopId) {
  if (!Array.isArray(stops)) return null;
  const hit = stops.find(s => s.id === stopId);
  return hit && typeof hit.order === "number" ? hit.order : null;
}

// ─── 노선 그룹 + 정류장 순번 정렬 (2026-09-03) ──────────────
// 🔴 정류장을 탑승수 내림차순으로만 늘어놓으면 노선이 뒤섞여 «어느 구간에서 사람이 타는가»를
//    읽을 수 없다. 노선으로 묶고 그 안은 **버스가 지나는 순서(order)** 여야 통계가 된다.
//    순번을 모르는 정류장(정류장 문서 삭제·legacy stopId)은 그룹 맨 뒤로 보내되 버리지 않는다.
// 노선 그룹 자체는 탑승 합계 내림차순 — 같은 화면 «노선별 탑승» 패널과 같은 기준.
export function groupMappedByRoute(mapped, stopsByRoute = {}) {
  const byRoute = new window.Map();
  for (const m of mapped || []) {
    const k = m.routeId || "_unknown";
    const cur = byRoute.get(k) || {
      routeId: m.routeId || null,
      routeName: m.routeName || "노선 미지정",
      total: 0, routeStopCount: 0, stops: [],
    };
    cur.total += m.count;
    cur.stops.push(m);
    byRoute.set(k, cur);
  }
  const groups = [...byRoute.values()];
  for (const g of groups) {
    // 노선 전체 정류장 목록(order asc 로 로드)에서 «몇 번째 정류장인가»를 뽑는다.
    // 탑승이 있는 정류장만 세면 «3번 정류장이 통째로 비었다»를 못 읽는다 — 그래서 전체 기준.
    const all = Array.isArray(stopsByRoute[g.routeId]) ? stopsByRoute[g.routeId] : [];
    g.routeStopCount = all.length;
    const seqById = new window.Map();
    all.forEach((s, i) => seqById.set(s.id, i + 1));
    g.stops.forEach(m => { m.seq = seqById.has(m.stopId) ? seqById.get(m.stopId) : null; });
    g.stops.sort((a, b) => {
      const ak = a.seq != null ? a.seq : (typeof a.stopOrder === "number" ? a.stopOrder : Infinity);
      const bk = b.seq != null ? b.seq : (typeof b.stopOrder === "number" ? b.stopOrder : Infinity);
      if (ak !== bk) return ak - bk;
      if (b.count !== a.count) return b.count - a.count;
      return String(a.stopName || "").localeCompare(String(b.stopName || ""), "ko");
    });
  }
  groups.sort((a, b) =>
    b.total - a.total || String(a.routeName).localeCompare(String(b.routeName), "ko"));
  return groups;
}
