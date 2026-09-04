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

/**
 * 인증 성공 직후 호출. 코드 문자열(+ 켠 거래처면 승계표)만 남긴다.
 *
 * 🔴 `resumeToken` 은 2026-09-04(P3-b)에 추가됐다 — 포털에 진짜 인증이 생겼고, 이 라우트는
 *    `inMemoryPersistence` 라(firebase.js 익명 앱) **새로고침하면 커스텀 토큰이 사라지기**
 *    때문이다. 승객앱이 `resumeToken` 을 기기에 두는 것과 **같은 구조**다.
 *    ⚠ 이건 «권한 정보»가 아니라 **자격증명**이다 — 서버엔 해시만 남고, 이 값이 있어도
 *      코드가 비활성·만료면 `partnerResume` 이 거부하고 승계표를 지운다.
 *    ⚠ `authRequired` 를 안 켠 거래처는 이 값이 **없다**(현행 코드-only 경로 그대로).
 */
export function savePartnerSession(code, { now = Date.now(), storage, resumeToken } = {}) {
  const s = pick(storage);
  if (!s || !code) return false;
  try {
    const rec = { code: String(code).trim(), savedAt: now };
    if (resumeToken) rec.resumeToken = String(resumeToken);
    s.setItem(PARTNER_SESSION_KEY, JSON.stringify(rec));
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
  // 🔴 `resumeToken` 부재 = 예전에 저장된 기기(또는 안 켠 거래처). 그 경우에도 `code` 는
  //    그대로 살아 있어야 한다 — 없다고 지우면 2026-09-02 에 없앤 «코드 재타이핑» 이 돌아온다.
  return {
    code: data.code.trim(),
    savedAt,
    resumeToken: typeof data.resumeToken === "string" && data.resumeToken ? data.resumeToken : null,
  };
}

/** '인증 해제' · 복원 실패(비활성·만료) 시 호출. */
export function clearPartnerSession({ storage } = {}) {
  const s = pick(storage);
  if (!s) return false;
  try { s.removeItem(PARTNER_SESSION_KEY); return true; } catch { return false; }
}
