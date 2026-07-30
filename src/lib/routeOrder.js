// 노선 표시 순서 (2026-07-10)
// 관리자가 노선 관리에서 정한 `routes.order`(number) 를 모든 화면이 같은 규칙으로 따른다.
// 이전엔 정렬이 아예 없어 Firestore 문서 ID 순(사실상 무작위)으로 보였다.
//
// 규칙: order 오름차순 → 출발시각 → 노선명. order 미설정(레거시)은 항상 뒤로.
// 순수 함수 — Firebase import 금지.

const NO_ORDER = Number.MAX_SAFE_INTEGER;

function orderOf(r) {
  const v = r?.order;
  return typeof v === "number" && isFinite(v) ? v : NO_ORDER;
}

export function compareRoutes(a, b) {
  const oa = orderOf(a), ob = orderOf(b);
  if (oa !== ob) return oa - ob;
  const ta = a?.departTime || "99:99", tb = b?.departTime || "99:99";
  if (ta !== tb) return ta < tb ? -1 : 1;
  return (a?.name || "").localeCompare(b?.name || "", "ko");
}

export function sortRoutes(routes) {
  return [...(routes || [])].sort(compareRoutes);
}

/**
 * 노선별 정원 대비 인원 (2026-07-30 — 경쟁사 대조에서 드러난 갭).
 *
 * 노선에 `seats`(좌석수, 기본 45)는 원래 있었는데 **정원 대비 몇 명인지 볼 화면이 없었다**.
 * 승객 245명이 등록된 뒤에도 노선별 정원 초과를 사전에 알 방법이 없었다.
 *
 * 순수 함수 — 집계만 한다(표시·경고 문구는 호출부).
 *
 * @param {Array} routes      [{id, seats}]
 * @param {Array} passengers  [{routeId, active}] — active===false 는 제외(퇴사)
 * @param {Array} [boardings] [{routeId}] — 오늘 탑승 기록(있으면 탑승 수도 집계)
 * @returns {Object} { [routeId]: {seats, registered, boarded, over, ratio} }
 *   seats null = 정원 미설정(over 는 항상 false — 없는 기준으로 초과 판정하지 않는다)
 */
export function seatUsage(routes, passengers, boardings) {
  const out = {};
  if (!Array.isArray(routes)) return out;
  for (const r of routes) {
    if (!r || !r.id) continue;
    const seats = typeof r.seats === "number" && r.seats > 0 ? r.seats : null;
    out[r.id] = { seats, registered: 0, boarded: 0, over: false, ratio: null };
  }
  if (Array.isArray(passengers)) {
    for (const p of passengers) {
      if (!p || p.active === false) continue;
      const e = out[p.routeId];
      if (e) e.registered++;
    }
  }
  if (Array.isArray(boardings)) {
    for (const b of boardings) {
      if (!b) continue;
      const e = out[b.routeId];
      if (e) e.boarded++;
    }
  }
  for (const k of Object.keys(out)) {
    const e = out[k];
    if (e.seats) {
      e.over = e.registered > e.seats;
      e.ratio = e.registered / e.seats;
    }
  }
  return out;
}
