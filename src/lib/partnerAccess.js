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

/**
 * 협력사 포털 **운영 포털**이 보여줄 노선 집합 (2026-08-11 배시현 개선요청 `DnPGSfHB…`).
 *
 * 🔴 기준축은 **거래처에 지정된 노선**(`routes.partnerCode === code`)이다.
 *   예전엔 "승객이 배정된 노선"만 모아 썼는데, 승객 문서는 `routeId` 를 **하나만** 갖는다.
 *   그래서 아무도 기준노선으로 잡지 않는 하교·요일별·방과후 노선이 통째로 빠졌다
 *   (prod 실측 2026-08-11: 채드윅 29개 중 **8개** · 다우디지털스퀘어 18개 중 **2개**만 표시).
 *
 * 🔴 승객 배정에서 나온 노선은 **합집합으로 남긴다** — 거래처가 지정 안 된 노선이나 과거에
 *   다른 거래처 노선으로 배정된 승객이 실재하므로(prod 실측), 빼면 지금 보이던 노선이 사라진다.
 *
 * @param {Array} routes     회사 전체 노선 [{id, partnerCode?}]
 * @param {string} code      이 포털의 업체코드
 * @param {Array|{byRouteCount:Object, unassignedCount:number}} passengers
 *   이 거래처 활성 승객 [{routeId?}].
 *   🔴 인원이 많은 거래처(2026-08-28 신촌세브란스 16,155명)에서는 승객 문서를 전부
 *   받아오는 것 자체가 운영 포털을 느리게 한다 → **{byRouteCount:{routeId:수}, unassignedCount}**
 *   집계를 대신 넘길 수 있다. 호출부는 Firestore 집계(count)로 그 값을 만든다(문서 0건 전송).
 * @returns {{ids:Set<string>, byRouteCount:Map<string,number>, unassignedCount:number}}
 */
export function partnerOpsRoutes(routes, code, passengers) {
  const byRouteCount = new Map();
  let unassignedCount = 0;
  if (passengers && !Array.isArray(passengers) && typeof passengers === "object") {
    // 집계 경로 — 값이 이미 '노선별 재직 인원'이라 다시 세지 않는다.
    const src = passengers.byRouteCount || {};
    for (const [rid, cnt] of Object.entries(src)) {
      if (rid && typeof cnt === "number" && cnt > 0) byRouteCount.set(rid, cnt);
    }
    const u = passengers.unassignedCount;
    unassignedCount = typeof u === "number" && u > 0 ? u : 0;
  } else {
    (Array.isArray(passengers) ? passengers : []).forEach((p) => {
      const rid = (p && p.routeId) || null;
      if (!rid) { unassignedCount++; return; }
      byRouteCount.set(rid, (byRouteCount.get(rid) || 0) + 1);
    });
  }
  const ids = new Set(byRouteCount.keys());
  (Array.isArray(routes) ? routes : []).forEach((r) => {
    if (r && r.id && code && r.partnerCode === code) ids.add(r.id);
  });
  return { ids, byRouteCount, unassignedCount };
}

/**
 * 좌석예약 모드 (2026-07-30 way 결정 — 고객사가 셋 중 고른다).
 *
 * boolean 이 아니라 **한 축의 3단계**다(탑승 모드 `boardingMode` 와 같은 방식):
 *   off      예약 화면 자체를 안 보여준다. **부재·알 수 없는 값은 off**(신규 기능이라 회귀 0)
 *   optional 좌석 확보형 — 예약자는 자리를 갖고, 미예약자도 정원 안이면 탑승
 *   required 예약 필수형 — 미예약자는 기사 화면에 빨갛게 뜨고, 기사가 "태우기"로 예외 승차
 *
 * ⚠ required 라도 **탑승을 막지 않는다**. 막으면 예약 못 한 사람이 출근을 못 하고 기사가
 *   사람을 막아야 한다 → 거부가 아니라 **기록 남는 예외 승차**로 정원 관리 목적만 달성한다.
 */
export const SEAT_MODES = { OFF: "off", OPTIONAL: "optional", REQUIRED: "required" };
export const SEAT_MODE_LABELS = {
  off: "사용 안 함",
  optional: "좌석 확보형 (예약 없이도 탑승 가능)",
  required: "예약 필수형 (미예약자는 기사 확인 후 탑승)",
};

/** 거래처 문서 → 정규화된 좌석예약 모드. 모르는 값·부재는 모두 off. */
export function seatReservationMode(codeData) {
  const v = codeData && codeData.seatReservation;
  return v === SEAT_MODES.OPTIONAL || v === SEAT_MODES.REQUIRED ? v : SEAT_MODES.OFF;
}

/**
 * 좌석예약을 켤 수 있는가 — **정원이 없으면 예약이 성립하지 않는다.**
 * 안 막으면 "몇 자리인지 모르는 노선"에 예약 무제한이 조용히 성립한다.
 *
 * @param {Array}  routes 회사 전체 노선
 * @param {string} code   이 거래처 업체코드
 * @returns {{ok:boolean, missing:string[], total:number}} missing = 정원 미설정 노선명
 */
export function canEnableSeatReservation(routes, code) {
  const mine = partnerRouteOptions(routes, code);
  const missing = mine
    .filter((r) => !(typeof r.seats === "number" && r.seats > 0))
    .map((r) => r.name || r.id);
  return { ok: mine.length > 0 && missing.length === 0, missing, total: mine.length };
}
