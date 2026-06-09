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
