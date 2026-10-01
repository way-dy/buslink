// 승객 화면 오류 문구 정리 (2026-10-01 way «승객에게 개발 용어를 보이지 말 것»)
//
// 서버(onCall)가 돌려주는 **한국어 안내**(«등록되지 않은 사번입니다» 등)는 그대로 보여 준다 — 그게
// 사용자에게 가장 정확한 말이다. 반면 영문·내부 코드(`internal`, `Failed to fetch`,
// `functions/unavailable`, `permission-denied` …)는 승객에게 아무 뜻이 없으므로 쉬운 말로 바꾼다.
// 🔴 원문은 버리지 않는다 — 호출부가 console 로 남기고(운영자 진단용) 화면에만 이 함수의 결과를 쓴다.
//
// 이 모듈은 **순수**(Firebase·React import 0) — 격리 테스트가 그대로 태운다.

const NETWORK_RE = /network|fetch|offline|unavailable|deadline|timeout|timed out|load failed/i;

/**
 * @param {unknown} msg   Error 또는 문자열
 * @param {string} [fallback]
 * @returns {string}
 */
export function friendlyError(msg, fallback = "문제가 생겼어요. 잠시 후 다시 시도해 주세요") {
  const text = typeof msg === "string" ? msg : (msg && typeof msg.message === "string" ? msg.message : "");
  const t = text.trim();
  if (!t) return fallback;
  if (/[가-힣]/.test(t)) return t;             // 서버·앱이 준 한국어 안내는 그대로
  if (NETWORK_RE.test(t)) return "인터넷 연결이 불안정해요. 잠시 후 다시 시도해 주세요";
  return fallback;
}
