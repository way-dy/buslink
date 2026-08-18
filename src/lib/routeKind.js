// 노선 구분(등교·하교·방과후 / 출근·퇴근) — 협력사 포털 필터 칩 정본 (2026-08-18 배시현 요청)
//
// 요청: "협력사 담당자가 쉽게 볼 수 있도록 등교/하교/방과후하교 필터 · 하교와 방과후하교가
//        겹치는 시간대가 있어 혼선을 준다".
//
// 🔴 **`shift` 만으로는 방과후를 못 가른다** — prod 실측(2026-08-18 채드윅 29개):
//    `[A] 하교 / Back Home`(15:50) 과 `[A] 방과후하교 / Late Activity Bus`(17:30) 가
//    **둘 다 `type=퇴근` · `shift=하교`** 다. 요청자가 말한 "겹쳐서 혼선"이 데이터에도
//    그대로 있다. 그래서 방과후는 **이름**으로만 가를 수 있다.
//
// 🔴 새 필드를 만들지 않았다 — 73개 노선에 값을 다시 넣어야 하고, 그 사이 빈 값이 생기면
//    필터가 노선을 통째로 숨긴다. 이미 있는 축(shift·type)에 이름 판정을 얹어 쓴다.
//    ⚠ 나중에 `routes.kind` 같은 필드를 도입하면 **여기서만** 우선순위를 바꿀 것.
//
// 판정 순서(먼저 맞는 것):
//   ① 이름에 방과후 / Late Activity  → "방과후"
//   ② shift 가 등교·하교            → 그 값
//   ③ type 이 출근·퇴근             → 그 값
//   ④ 그 외                        → null (구분 없음 — 칩을 만들지 않고 '전체'에만 든다)
//
// 순수 함수 — Firebase import 금지.

// 칩 표시 순서(있는 것만 그린다). 등교→하교→방과후 는 하루 흐름 순.
export const ROUTE_KIND_ORDER = ["등교", "하교", "방과후", "출근", "퇴근"];

const AFTER_SCHOOL = /방과\s*후|late\s*activity/i;
const SHIFT_KINDS = ["등교", "하교"];
const TYPE_KINDS = ["출근", "퇴근"];

/** 노선 하나의 구분. 못 정하면 null. */
export function routeKind(route) {
  if (!route) return null;
  if (AFTER_SCHOOL.test(String(route.name || ""))) return "방과후";
  const shift = String(route.shift || "").trim();
  if (SHIFT_KINDS.includes(shift)) return shift;
  const type = String(route.type || "").trim();
  if (TYPE_KINDS.includes(type)) return type;
  return null;
}

/**
 * 이 목록에 실제로 존재하는 구분만 표시 순서대로.
 * 🔴 존재하지 않는 칩은 만들지 않는다 — 거래처마다 어휘가 다르다(채드윅=등교/하교/방과후,
 *    판교역 셔틀 거래처=출근/퇴근). 빈 결과만 주는 칩은 "고장난 필터"로 읽힌다.
 * 🔴 구분이 하나뿐이면 빈 배열 — 칩 한 개짜리 필터는 아무것도 걸러 주지 못한다.
 */
export function availableRouteKinds(routes) {
  const found = new Set();
  (routes || []).forEach(r => { const k = routeKind(r); if (k) found.add(k); });
  const list = ROUTE_KIND_ORDER.filter(k => found.has(k));
  return list.length >= 2 ? list : [];
}

/** kind 가 null 이면 전체 반환(필터 해제). */
export function filterRoutesByKind(routes, kind) {
  if (!kind) return routes || [];
  return (routes || []).filter(r => routeKind(r) === kind);
}
