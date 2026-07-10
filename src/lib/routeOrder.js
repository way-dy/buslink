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
