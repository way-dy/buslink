// 문의 게시판 연동 (2026-08-06 오전 미팅) — 승객앱 하단 "문의" 탭이 여는 대상.
//
// 대상 = **dycs**(동영 통합 고객문의·분실물 CS 시스템, Firebase `dycschannel`)의 고객 위젯.
//   위젯 URL 계약 = `https://dycs-widget.web.app/?tenant=<tenantId>[&token=<embedToken>][&intake=1]`
//   (dycs `apps/widget/src/lib/firebase.ts readEmbedParams` 가 정본. 파라미터명 바꾸지 말 것.)
//
// 🔴 buslink 거래처(`partnerCodes/{code}`)와 dycs 거래처(`tenants/{tenantId}`)는 **별개 체계**다.
//   이름이 겹치는 곳도 있지만(신촌세브란스 등) 코드로 자동 매칭하면 남의 거래처로 문의가 간다
//   → 매핑은 관리자가 협력사 관리 ⚙️ 포탈 설정에서 tenantId 를 **직접 입력**한다.
//
// 이 모듈은 **순수**(Firebase import 0) — 격리 테스트 `scripts/test_inquiry_link.cjs` 가 그대로 태운다.

/** dycs 고객 위젯 오리진. 변경 시 이 상수만. */
export const INQUIRY_WIDGET_ORIGIN = "https://dycs-widget.web.app";

/**
 * dycs tenantId 형식 — 영문 소문자 약칭 컨벤션(`snu`·`kolon`·`hanwha`…).
 * 공백·한글·경로문자가 섞이면 위젯이 "거래처 없음"만 띄우므로 입력 단계에서 막는다.
 */
export function isValidTenantId(v) {
  return typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v.trim());
}

/**
 * `partnerCodes/{code}` 문서 → 문의 설정.
 * 🔴 **부재·모르는 값 = 꺼짐**(신규 기능이라 기존 거래처 회귀 0).
 *   `enabled` 는 스위치 AND 유효한 tenantId — 스위치만 켜고 거래처 ID 가 없으면
 *   승객에게 빈 위젯을 보여주는 꼴이라 탭 자체를 띄우지 않는다.
 * @returns {{enabled:boolean, tenantId:string|null, token:string|null}}
 */
export function resolveInquiryConfig(codeData) {
  const raw = codeData && typeof codeData === "object" ? codeData.inquiry : null;
  if (!raw || typeof raw !== "object") return { enabled: false, tenantId: null, token: null };
  const tenantId = isValidTenantId(raw.tenantId) ? raw.tenantId.trim() : null;
  const token = typeof raw.token === "string" && raw.token.trim() ? raw.token.trim() : null;
  return { enabled: raw.enabled === true && !!tenantId, tenantId, token };
}

/**
 * 위젯 URL 조립. 꺼져 있거나 거래처 ID 가 없으면 **null**(호출부가 화면을 안 그린다).
 * @param {{enabled:boolean, tenantId:string|null, token:string|null}} config
 * @param {{directIntake?:boolean}} [opts] directIntake=true 면 챗봇을 건너뛰고 접수 폼으로.
 */
export function buildInquiryUrl(config, opts) {
  if (!config || config.enabled !== true || !isValidTenantId(config.tenantId)) return null;
  const p = new URLSearchParams();
  p.set("tenant", config.tenantId.trim());
  if (config.token) p.set("token", config.token);
  if (opts && opts.directIntake) p.set("intake", "1");
  return `${INQUIRY_WIDGET_ORIGIN}/?${p.toString()}`;
}

/**
 * 관리자 미리보기용 — 저장 전 입력값 그대로 열어 tenantId 가 맞는지 확인하는 통로.
 * (`enabled` 스위치와 무관하게 tenantId 만 유효하면 URL 을 만든다.)
 */
export function buildInquiryPreviewUrl(tenantId, token) {
  return buildInquiryUrl({ enabled: true, tenantId, token: token || null });
}
