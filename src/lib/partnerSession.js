// src/lib/partnerSession.js — 협력사 포털 인증 세션(순수 · Firebase import 금지)
// ---------------------------------------------------------------------------
// 고객 호소(2026-09-02 way): "뒤로가기를 누르면 무조건 페이지를 빠져나온다. 로그인은 계속
// 유지되게 해달라." 종전 포털은 업체코드 인증 결과를 **React state 로만** 들고 있어서
// 새로고침·뒤로가기·앱 전환 한 번이면 담당자가 20자짜리 업체코드를 다시 타이핑해야 했다.
//
// 저장하는 것: **업체코드와 마지막 인증 시각뿐**.
//   🔴 partnerName·companyId·allowedRouteIds 같은 **권한 정보는 저장하지 않는다**.
//      복원할 때 `partner.validatePartnerCode` 로 서버에 다시 물으므로, 관리자가 코드를
//      비활성화하거나 만료시키면 다음 진입에서 바로 막힌다. 권한을 캐시해 두면 그 차단이
//      영영 도달하지 않는 브라우저가 생긴다([[external-approval-state-is-knowable-only-if-failure-blocks-the-record]]).
//   ⚠ 업체코드 자체는 EmployeeApp 의 `buslink_employee` 세션과 같은 급의 값이다(공용 PC
//     에서는 '인증 해제'로 지운다 — 포털 사이드바/헤더에 상시 노출된 버튼).
// ---------------------------------------------------------------------------

export const PARTNER_SESSION_KEY = "buslink_partner";
// 30일 — 통근버스 담당자는 명부 갱신 주기가 길다(월 단위). 그 안에서는 다시 안 묻는다.
export const PARTNER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Safari 프라이빗 모드·정책 차단 환경에서 localStorage 접근 자체가 throw 한다 → 전 함수 무해 처리.
function pick(storage) {
  if (storage) return storage;
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch { return null; }
}

/** 인증 성공 직후 호출. 코드 문자열 하나만 남긴다. */
export function savePartnerSession(code, { now = Date.now(), storage } = {}) {
  const s = pick(storage);
  if (!s || !code) return false;
  try {
    s.setItem(PARTNER_SESSION_KEY, JSON.stringify({ code: String(code).trim(), savedAt: now }));
    return true;
  } catch { return false; }
}

/**
 * 저장된 업체코드를 돌려준다. 없거나·형식이 깨졌거나·TTL 을 넘겼으면 null.
 * 🔴 여기서 "유효한 코드"라고 말하지 않는다 — 유효성은 서버(validatePartnerCode)만 안다.
 */
export function loadPartnerSession({ now = Date.now(), storage } = {}) {
  const s = pick(storage);
  if (!s) return null;
  let raw;
  try { raw = s.getItem(PARTNER_SESSION_KEY); } catch { return null; }
  if (!raw) return null;
  let data;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!data || typeof data.code !== "string" || !data.code.trim()) return null;
  const savedAt = typeof data.savedAt === "number" ? data.savedAt : 0;
  if (!savedAt || now - savedAt > PARTNER_SESSION_TTL_MS) return null;
  return { code: data.code.trim(), savedAt };
}

/** '인증 해제' · 복원 실패(비활성·만료) 시 호출. */
export function clearPartnerSession({ storage } = {}) {
  const s = pick(storage);
  if (!s) return false;
  try { s.removeItem(PARTNER_SESSION_KEY); return true; } catch { return false; }
}
