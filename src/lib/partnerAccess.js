// admin별 협력사 권한 게이팅 헬퍼 (Phase B, 2026-06-08)
// 순수 함수 모듈 — Firebase import 금지. App.js·AdminApp 양쪽에서 사용.
//
// 데이터 모델: users/{uid}.allowedPartnerCodes:string[]
//   ["*"]            = 회사 전체(팀장/본부) — 무제한
//   ["code1","code2"]= 특정 협력사만
//   []               = 아무 협력사도 못 봄(유효 케이스)
//   부재/null/비배열  = 기존 admin 호환 → ["*"] 폴백(회귀 0 — 핵심)
//
// Phase A(CF 인프라)·SuperCompanyTab 관리 UI 는 이미 이 필드를 write/read.
// Phase B = AdminApp 8지점 필터가 로그인 admin 의 이 값을 자동 강제.

/**
 * 로그인 admin 의 협력사 접근 범위를 정규화한다.
 * @param {string}   role  users/{uid}.role
 * @param {any}      allowedPartnerCodes  users/{uid}.allowedPartnerCodes (옵셔널)
 * @returns {string[]}  ["*"] | ["code", ...] | []
 */
export function resolveAllowed(role, allowedPartnerCodes) {
  // 슈퍼관리자는 협력사 제한 위 — 항상 무제한.
  if (role === "superadmin") return ["*"];
  const v = allowedPartnerCodes;
  if (!Array.isArray(v)) return ["*"];     // 부재/null/비배열 = 기존 admin 호환 폴백
  if (v.includes("*")) return ["*"];        // 와일드카드 포함 = 무제한
  // 빈 배열은 그대로([] = 아무 협력사도 못 봄). 그 외는 정규화(빈 문자열·중복 제거).
  const cleaned = Array.from(new Set(v.filter(c => typeof c === "string" && c)));
  return cleaned;
}

/**
 * 무제한 접근 여부. true 면 모든 신규 필터가 비활성(현재 동작과 100% 동일 = 회귀 0).
 * @param {string[]} allowed  resolveAllowed 결과
 */
export function isAllAccess(allowed) {
  return Array.isArray(allowed) && allowed.includes("*");
}

/**
 * 특정 협력사 코드가 허용 범위에 드는지.
 * isAllAccess 면 항상 true. code 가 null/빈값(협력사 미지정 데이터)이면
 * 무제한일 때만 노출(제한 admin 은 미지정 데이터 안 봄).
 * @param {string[]} allowed
 * @param {string|null|undefined} code
 */
export function partnerCodeAllowed(allowed, code) {
  if (isAllAccess(allowed)) return true;
  if (!code) return false;             // 협력사 미지정 = 제한 admin 비노출
  return allowed.includes(code);
}

/**
 * 협력사 포털 노선 드롭다운 옵션 — **그 거래처 노선만** (2026-07-30 배시현 개선요청).
 *
 * 배경: PartnerApp 은 회사 **전 노선**을 불러 등록·수정 폼에 그대로 넘겼다. 그래서 담당자가
 * 남의 거래처 노선을 골라 승객을 배정할 수 있었고, 실제로 prod 승객 13명 중 1명이 다른
 * 거래처 노선에 배정된 상태로 발견됐다(표시만의 문제가 아니라 데이터가 틀어진다).
 *
 * 🔴 **현재 배정된 노선은 목록에 남긴다.** 수정 화면에서 select 의 현재 값이 옵션에 없으면
 *   빈 선택으로 표시되고, 그대로 저장하면 **배정된 노선이 지워진다**. 거래처 미지정 노선이나
 *   과거에 잘못 배정된 노선에 걸려 있는 승객이 실재하므로(prod 실측) 이 예외가 필수다.
 *
 * @param {Array}  routes   회사 전체 노선 [{id, code?, partnerCode?, name}]
 * @param {string} code     이 포털의 업체코드
 * @param {string} [current] 지금 폼에 들어 있는 값(routeCode 또는 routeId)
 * @returns {Array} 드롭다운에 보일 노선
 */
export function partnerRouteOptions(routes, code, current) {
  if (!Array.isArray(routes)) return [];
  const cur = current === undefined || current === null || current === "" ? null : String(current);
  return routes.filter((r) => {
    if (!r) return false;
    if (code && r.partnerCode === code) return true;
    if (!cur) return false;
    // 현재 값은 routeCode 로도 routeId 로도 들어올 수 있다(폼 계약이 둘을 섞어 쓴다).
    return String(r.code || "") === cur || String(r.id || "") === cur;
  });
}
