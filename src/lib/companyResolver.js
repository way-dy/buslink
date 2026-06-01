// ════════════════════════════════════════════════════════════
// companyResolver — SaaS Phase 1.1 (2026-05-28)
//
// 신규 회사 온보딩 시 ① 아래 HOSTNAME_TO_COMPANY 맵에 도메인 추가
// (예: "swstour.buslink.kr": "sws001") ② companies/{newCid} 도큐먼트 생성
// (Phase 1.2 슈퍼관리자 콘솔의 `createCompany` CF가 담당) — 이 두 가지만으로
// 클라이언트 코드 변경 0. 신규 회사 직원/기사/승객 모두 자기 도메인 진입 시
// 자동으로 자기 companyId 분기.
//
// dy001 폴백은 동영관광 운영 기간 호환성 보장(원래 단일테넌트 폴백). Phase 1.2
// 완료 후에도 유지(prod 데이터 보호 — hostname 매핑·users 문서 둘 다 누락된 비정상
// 케이스의 안전망). hostname 매핑 도입은 dy001 폴백을 *대체* 안 함, *추가* 만.
//
// 순수 함수(Firebase import 0) — App.js / DriverApp / EmployeeApp / PassengerApp
// 어디서든 호출 가능. SW 도 hostname 매핑이 필요하지만 SW context 는 build-time
// js import 불가 → firebase-messaging-sw.js 가 동일 맵을 인라인 복제(동기화 필요
// 주석 동반).
// ════════════════════════════════════════════════════════════

const DEFAULT_FALLBACK = "dy001";

// 신규 회사 추가 시 이 맵만 갱신. key=hostname(소문자, 포트 제외) · value=companyId.
// localhost 는 개발 편의상 dy001(동영관광 실데이터로 손 빠르게 확인).
export const HOSTNAME_TO_COMPANY = {
  "buslink-prod.web.app": "dy001",
  "buslink-prod.firebaseapp.com": "dy001",
  "localhost": "dy001",
  "127.0.0.1": "dy001",
};

/** hostname → companyId. 매핑 없으면 null. */
export function resolveByHostname(hostname) {
  if (!hostname || typeof hostname !== "string") return null;
  const key = hostname.toLowerCase();
  return HOSTNAME_TO_COMPANY[key] || null;
}

/**
 * 로그인 사용자(users 문서) 기반 companyId 결정.
 * 우선순위: users.companyId > hostname 매핑 > fallback.
 * @param {object|null|undefined} userDoc - users/{uid} doc data
 * @param {string} [fallback="dy001"]
 */
export function resolveCompanyIdForAuth(userDoc, fallback = DEFAULT_FALLBACK) {
  if (userDoc && typeof userDoc.companyId === "string" && userDoc.companyId) {
    return userDoc.companyId;
  }
  const host = (typeof window !== "undefined" && window.location)
    ? window.location.hostname : "";
  return resolveByHostname(host) || fallback;
}

/**
 * 익명 흐름(승객/직원/협력사) companyId 결정.
 * 우선순위: URL param > localStorage > hostname 매핑 > fallback.
 * @param {{urlParam?:string|null, localStorageVal?:string|null, fallback?:string}} opts
 */
export function resolveCompanyIdForAnon({ urlParam, localStorageVal, fallback = DEFAULT_FALLBACK } = {}) {
  if (urlParam && typeof urlParam === "string") return urlParam;
  if (localStorageVal && typeof localStorageVal === "string") return localStorageVal;
  const host = (typeof window !== "undefined" && window.location)
    ? window.location.hostname : "";
  return resolveByHostname(host) || fallback;
}
