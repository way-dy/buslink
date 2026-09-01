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

/**
 * 승객앱 홈이 **보고 있을 노선**을 정한다 (2026-09-01, 조수빈 클레임).
 *
 * 반환 = 새로 묶어야 할 routeId, 또는 `null`(지금 값 유지).
 *
 * 🔴 이 값은 곧 **스캐너가 서버에 보내는 노선**이다(`session.routeId`). 화면이 보는 노선과
 *    갈라지면 그 노선의 버스를 타도 서버가 "선택한 노선의 차량이 아닙니다"로 막는다.
 *    예전엔 홈 컴포넌트가 화면 state 만 바꾸고 세션에는 안 써서, 탭을 옮겼다 돌아올 때마다
 *    (QR 탑승 버튼도 탭 전환이다) 첫 즐겨찾기로 튕기고 내 정류장이 풀렸다 — prod 390명.
 *
 * 규칙:
 *  - 지금 노선이 실재하고 ⓐ 사용자가 직접 골랐거나(`pinned`) ⓑ 홈 목록 안이거나
 *    ⓒ 홈 목록이 비었으면 → 유지(null).
 *  - 그 밖 = 아직 자리를 못 잡은 상태 → 홈 목록 첫 노선(없으면 폴백 첫 노선).
 * ⚠ 자동 선택은 `pinned` 를 찍지 않는다 — 나중에 즐겨찾기가 바뀌면 다시 따라간다.
 */
export function pickHomeRoute(opts) {
  const { all = [], shown = [], fallback = [], routeId = null, pinned = false } = opts || {};
  const idsOf = (a) => (Array.isArray(a) ? a : []).map(r => (typeof r === "string" ? r : (r && r.id))).filter(Boolean);
  const A = idsOf(all), S = idsOf(shown), F = idsOf(fallback);
  const exists = !!routeId && A.includes(routeId);
  if (exists && (!!pinned || S.includes(routeId) || S.length === 0)) return null;
  const pick = S[0] || F[0] || null;
  return (pick && pick !== routeId) ? pick : null;
}

/**
 * 앱 안 스캐너가 서버에 보낼 «승객이 선택한 노선» (2026-09-01).
 *
 * 반환 = 보낼 routeId, 또는 `null`(안 보냄 = 노선 검증 없이 탑승).
 *
 * 🔴 오탑승 방지 게이트(2026-07-16 회의 #1)는 «승객이 **앱에서 선택한** 노선» 을 전제로 한다.
 *    그런데 `session.routeId` 는 명부의 배정 노선으로도 채워지고, 그 값은 일괄 업로드의
 *    부산물일 수 있다 — prod 실측: 신촌세브란스 승객 16,155명 중 **16,149명이 같은 노선**.
 *    선택한 적 없는 사람에게 그 값으로 거는 건 보호가 아니라 **거짓 차단**이다.
 *    (게다가 차단된 시도는 어디에도 안 남아 몇 명이 못 탔는지 셀 수도 없다.)
 *
 * 「선택했다」로 인정하는 신호는 둘뿐 — 둘 다 사용자가 앱에서 한 **행동**이다:
 *  - `pinned`       : 노선 변경·노선 칩으로 직접 골랐다
 *  - `favorites` 안 : 별을 눌러 고른 노선 중 하나로 정착했다
 * 그 밖(명부 배정값 그대로)은 `null` — 폰 기본 카메라(`BoardingApp`)와 같은 동작이 된다.
 *
 * ⚠ 이 함수가 `null` 을 늘리면 오탑승 방지가 약해진다. 인정 신호를 넓힐 때는 그것이
 *   정말 **사용자의 행동**인지부터 물을 것(명부·기본값·파생값은 행동이 아니다).
 */
export function boardingRouteId(opts) {
  const { routeId = null, pinned = false, favorites = [] } = opts || {};
  if (!routeId) return null;
  if (pinned) return routeId;
  const favs = Array.isArray(favorites) ? favorites.filter(Boolean) : [];
  return favs.includes(routeId) ? routeId : null;
}
