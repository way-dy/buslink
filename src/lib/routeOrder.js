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
 * @param {Array|Object} passengers  [{routeId, active}] — active===false 는 제외(퇴사).
 *   🔴 인원이 많은 회사(2026-08-28 신촌세브란스 16,155명)에서는 승객 문서를 전부 받아오는
 *   것 자체가 화면을 느리게 한다 → **{routeId: 재직인원수} 맵**을 대신 넘길 수 있다.
 *   호출부는 Firestore 집계(count) 로 그 맵을 만든다(문서 0건 전송).
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
  } else if (passengers && typeof passengers === "object") {
    // 집계 맵 경로 — 값이 이미 '재직 인원'이라 active 필터를 다시 걸지 않는다.
    for (const [routeId, n] of Object.entries(passengers)) {
      const e = out[routeId];
      if (e && typeof n === "number" && n > 0) e.registered = n;
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

/**
 * 승객앱 홈 탭에 보여줄 노선 목록 (2026-08-18 배시현 개선요청).
 *
 * 규칙 = **즐겨찾기한 노선만**. 하나도 없으면 배정 노선 하나.
 * 예전 규칙(`배정 ∪ 즐겨찾기`)은 가입 때 자동으로 잡힌 노선을 뺄 방법이 없어
 * "즐겨찾기도 아닌데 홈에서 안 없어진다"는 신고가 됐다. 별을 눌러 고른 것만 홈에 둔다.
 *
 * 🔴 즐겨찾기가 비면 배정 노선으로 폴백 — 빼면 홈이 통째로 빈다(prod 251명 중 237명이 이 경우).
 * ⚠ 반환 순서는 입력 `all` 순서를 그대로 따른다(호출부가 이미 정렬해 넘긴다).
 */
export function homeRouteList(all, opts) {
  // 🔴 `= {}` 기본값은 undefined 에만 걸린다 — null 을 넘기면 구조분해가 던진다(격리 테스트가 잡았다).
  const { assignedRouteId = null, favorites = [] } = opts || {};
  const list = Array.isArray(all) ? all.filter(Boolean) : [];
  const favs = Array.isArray(favorites) ? favorites.filter(Boolean) : [];
  const favShown = list.filter(r => favs.includes(r.id));
  if (favShown.length > 0) return favShown;
  return assignedRouteId ? list.filter(r => r.id === assignedRouteId) : [];
}
