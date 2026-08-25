// 거래처 홈페이지 연결 (2026-08-25 신규거래처 도입 미팅) — 승객앱 하단 `홈페이지` 탭이 여는 대상.
//
// 미팅 결정: "문의를 홈페이지로 한 다음에 전화를 하더라도 그냥 거기서 해라"(별도 전화 버튼 없음),
//   버튼명은 `홈페이지`. 그래서 홈페이지가 설정된 거래처는 **문의 탭을 홈페이지 탭이 대체**한다.
//   ⚠ 그 거래처의 dycs 문의 위젯 유입은 그 시점부터 끊긴다 — 켜기 전에 확인받을 것.
//
// 🔴 **iframe 임베드는 불가하다**(실측 2026-08-25). 신촌세브란스 사이트(Google Sites)는
//    `X-Frame-Options: DENY` + `frame-ancestors https://google-admin.corp.google.com/` 을 준다.
//    문의 위젯처럼 iframe 으로 감싸면 **빈 화면**이 된다. 반드시 새 창(`target="_blank"`)으로 연다.
//    다른 거래처 주소를 넣을 때도 같은 전제로 다뤄야 한다(임베드 되는지 하나씩 재는 건 함정).
//
// 이 모듈은 **순수**(Firebase import 0) — 격리 테스트가 그대로 태운다.

/**
 * 홈페이지 주소로 쓸 수 있는 값인가.
 * 🔴 http/https 만 통과시킨다 — `javascript:` 같은 스킴을 그대로 링크에 꽂으면
 *   승객앱 탭이 스크립트 실행 통로가 된다(관리자 입력값이라도 믿지 않는다).
 */
export function isValidHomepageUrl(v) {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (!s) return false;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * `partnerCodes/{code}` 문서 → 홈페이지 설정.
 * 🔴 **부재·모르는 값 = 꺼짐**(신규 기능이라 기존 거래처 회귀 0).
 *   스위치만 켜고 주소가 없으면 승객에게 죽은 버튼을 보여주는 꼴이라 탭 자체를 안 띄운다.
 * @returns {{enabled:boolean, url:string|null}}
 */
export function resolveHomepageConfig(codeData) {
  const raw = codeData && typeof codeData === "object" ? codeData.homepage : null;
  if (!raw || typeof raw !== "object") return { enabled: false, url: null };
  const url = isValidHomepageUrl(raw.url) ? raw.url.trim() : null;
  return { enabled: raw.enabled === true && !!url, url };
}

/**
 * 화면에 보여줄 짧은 주소(호스트만). 긴 구글사이트 주소를 그대로 두면 탭이 지저분해진다.
 * 파싱 실패 시 원문을 그대로 돌려준다(보여주기용이라 실패해도 무해).
 */
export function homepageDisplayHost(url) {
  try { return new URL(url).host; } catch { return url || ""; }
}
