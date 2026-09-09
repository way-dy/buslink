// src/lib/partnerLink.js — 관리자 → 협력사 포털 바로가기 링크 (순수 · Firebase import 0)
// ---------------------------------------------------------------------------
// 요청(2026-09-09 way): "관리자는 협력사 클릭하면 바로 협력사 페이지로 이동 가능하도록".
// 종전에는 관리자가 협력사 포털을 보려면 ① 포털 URL 을 복사해 새 탭에 붙이고 ② 20자짜리
// 업체코드를 다시 복사해 붙여야 했다 — 화면 두 개를 오가는 그 왕복이 이 모듈이 없애는 것.
//
// 🔴 새 권한을 여는 링크가 아니다. `?code=` 에 실리는 값은 협력사 담당자가 포털 첫 화면에
//    직접 치는 그 업체코드와 **같은 값**이고, `partnerCodes` read 규칙은 이미 공개다
//    (`accountCards.buildPassengerLoginUrl` 의 `pc` 파라미터와 같은 급). 게다가
//    `authRequired` 를 켠 거래처는 이 링크로 들어와도 **비밀번호 화면에서 멈춘다**
//    — 링크는 «타이핑»만 대신하지 인증을 대신하지 않는다.
// ⚠ 그래도 주소창에 자격증명급 문자열을 남기지 않는다 → 포털이 읽자마자
//    `stripPartnerCodeFromUrl` 로 지운다(아래 함수 주석).
//
// ⚠ `URLSearchParams`·`URL` 을 쓰지 않는다 — 이 파일은 순수 모듈이라 격리 테스트가 bare vm
//    에서 태우는데 거기엔 그 전역이 없다(accountCards.js 가 같은 이유로 손 파싱을 쓴다).
// ---------------------------------------------------------------------------

/** 링크가 싣는 파라미터 이름. 승객앱 안내문 QR 의 `pc` 도 같은 값이라 함께 받는다. */
export const PARTNER_LINK_PARAM = "code";
const ACCEPTED_PARAMS = [PARTNER_LINK_PARAM, "pc"];

/**
 * 관리자 화면에서 쓰는 «그 거래처 포털» 주소.
 * 🔴 호스트를 `partner.` 로 바꾸지 않는다 — 협력사 관리 탭의 '포털 URL 복사'(`origin + /partner`)와
 *    **같은 주소여야** 한다. 경로가 앱을 명시하면 호스트 매핑보다 경로가 이긴다(App.js).
 *    그리고 `/partner` 경로는 firebase.js 에서 inMemoryPersistence 라, 이 링크로 새 탭을 열어도
 *    관리자 로그인 세션을 덮지 않는다(2026-07-09 cross-tab clobber 와 같은 축).
 */
export function buildPartnerPortalUrl({ origin, code } = {}) {
  const base = String(origin || "").replace(/\/+$/, "");
  const trimmed = String(code == null ? "" : code).trim();
  if (!trimmed) return `${base}/partner`;
  return `${base}/partner?${PARTNER_LINK_PARAM}=${encodeURIComponent(trimmed)}`;
}

/** `?code=…`(또는 `?pc=…`)에서 업체코드를 꺼낸다. 없으면 null. */
export function readPartnerCodeFromUrl(search) {
  const q = String(search == null ? "" : search).replace(/^[?#]+/, "");
  if (!q) return null;
  for (const part of q.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const key = eq < 0 ? part : part.slice(0, eq);
    if (!ACCEPTED_PARAMS.includes(key)) continue;
    const raw = eq < 0 ? "" : part.slice(eq + 1);
    let value;
    try { value = decodeURIComponent(raw.replace(/\+/g, " ")); } catch { value = raw; }
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/**
 * 주소창에서 업체코드만 지운다(다른 파라미터는 남긴다).
 * 🔴 `history.state` 를 **그대로 되쓴다** — 이 라우트의 뒤로가기(backNav)가 현재 항목에
 *    찍어 둔 `__blNav` 번호를 읽는다. 빈 객체로 덮으면 새로고침 뒤 '나가기'가 안 먹는다.
 */
export function stripPartnerCodeFromUrl(win) {
  const w = win || (typeof window !== "undefined" ? window : null);
  if (!w || !w.history || typeof w.history.replaceState !== "function" || !w.location) return null;
  const search = String(w.location.search || "").replace(/^[?]+/, "");
  if (!search) return null;
  const kept = search.split("&").filter(p => {
    if (!p) return false;
    const eq = p.indexOf("=");
    return !ACCEPTED_PARAMS.includes(eq < 0 ? p : p.slice(0, eq));
  });
  const next = `${w.location.pathname || ""}${kept.length ? `?${kept.join("&")}` : ""}${w.location.hash || ""}`;
  try { w.history.replaceState(w.history.state, "", next); } catch { return null; }
  return next;
}
