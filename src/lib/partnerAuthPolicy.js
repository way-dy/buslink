// src/lib/partnerAuthPolicy.js — 협력사 포털 비밀번호 정책(순수 · Firebase import 금지)
// ---------------------------------------------------------------------------
// 🔴 이 파일은 서버 정본 `functions/partnerAuth.js` 의 **거울**이다. 값이 갈리면
//    «화면 안내»와 «실제로 발급되는 값»이 어긋난다 — 2026-09-01 승객 초기 PIN 사고가
//    정확히 그것이었다(클라 000000 / 서버 랜덤 → 안내대로 넣으면 로그인 불가, 본인은
//    회복 불가). 그래서 `scripts/test_partner_auth.cjs` 가 두 파일의 상수와 판정을
//    대조한다 — **한쪽만 고치면 배포 게이트가 빨개진다**.
//
// 🔴 여기에 해시 함수를 만들지 말 것. 비밀번호 대조는 전부 서버(CF)에서만 한다
//    (승객 `hashPin` 을 클라에서 걷어낸 2026-08-28 P3-a 와 같은 이유 — 두 벌이 되면
//    salt 가 갈리는 날 전원 로그인 불가다). 이 모듈이 아는 것은 «길이·글자·문구» 뿐이다.
// ---------------------------------------------------------------------------

export const PARTNER_PASSWORD_LENGTH = 10;
export const PARTNER_PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
export const PARTNER_PASSWORD_MIN_LEN = 8;
export const PARTNER_PASSWORD_MAX_LEN = 64;

// 🔴 발급 모달이 **이 상수를 그대로** 화면에 쓴다(문장을 따로 타이핑하지 말 것).
//    평문을 저장하지 않는다는 서버 계약과 한 몸이다.
export const PARTNER_PASSWORD_ISSUE_NOTICE =
  "이 비밀번호는 지금 한 번만 보입니다. 창을 닫으면 다시 볼 수 없고, 잃어버리면 새로 발급해야 합니다.";

/** 담당자가 정하는 새 비밀번호가 쓸 만한가. 서버 `checkNewPartnerPassword` 와 같은 판정. */
export function checkNewPartnerPassword(v, opts) {
  const currentCode = (opts || {}).currentCode;
  const t = String(v == null ? "" : v);
  if (t.length < PARTNER_PASSWORD_MIN_LEN) {
    return { ok: false, message: "비밀번호는 " + PARTNER_PASSWORD_MIN_LEN + "자 이상이어야 합니다" };
  }
  if (t.length > PARTNER_PASSWORD_MAX_LEN) {
    return { ok: false, message: "비밀번호는 " + PARTNER_PASSWORD_MAX_LEN + "자 이하여야 합니다" };
  }
  if (/[ \t\r\n]/.test(t)) return { ok: false, message: "비밀번호에 공백은 쓸 수 없습니다" };
  if (currentCode && t.trim().toLowerCase() === String(currentCode).trim().toLowerCase()) {
    return { ok: false, message: "업체코드는 비밀번호로 쓸 수 없습니다. 다른 값으로 정해주세요" };
  }
  return { ok: true, message: "" };
}

/**
 * 이 거래처가 비밀번호를 요구하는가. 서버 `isPartnerAuthRequired` 와 같은 판정.
 * 🔴 **부재·falsy = 꺼짐 = 현행 코드-only 진입**(로그인 화면에 비밀번호 칸이 아예 안 뜬다).
 */
export function isPartnerAuthRequired(codeData) {
  return !!(codeData && codeData.authRequired === true);
}
