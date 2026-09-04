// 협력사 포털 인증 — **판정만** 하는 순수 모듈 (2026-09-04 P3-b 1단계)
//
// 🔴 왜 따로 뺐나: `index.js` 는 `defineSecret`·`initializeApp` 이 있어 격리 테스트로 통째
//    태울 수 없다(아키타입 C playbook · P3-a 의 `passengerRoster.js` 와 같은 이유).
//    그런데 여기서 틀리면 ⓐ 비밀번호 없이 남의 거래처 포털에 들어가거나 ⓑ 켜 둔 거래처가
//    통째로 못 들어온다 — 둘 다 즉시 사고다. 그래서 **Firestore 를 만지지 않는 결정 부분만**
//    여기 두고, 실행(문서 읽기·쓰기·커스텀 토큰)은 index.js 가 한다.
//    테스트는 이 파일을 그대로 require 한다 — 규칙을 복제하지 않는다.
//
// 계약: 입력·출력 모두 평범한 값. 여기서 시각·네트워크를 만들지 않는다(nowMs 는 주입).
//      난수는 예외 — 초기 비밀번호 생성이 이 모듈의 책임이고, 테스트는 rng 를 주입해 잰다.
const crypto = require("crypto");

// 🔴 승객 PIN salt(buslink_salt_2026)와 **일부러 다른 값**이다. 같으면 6자리 PIN 해시
//    사전이 그대로 포털 비밀번호에도 통한다(둘 다 sha256 이라 표를 공유하게 된다).
const PARTNER_PASSWORD_SALT = "buslink_partner_salt_2026";

// ── 초기 비밀번호 정책 (🔴 클라 src/lib/partnerAuthPolicy.js 와 **같은 값이어야 한다**) ──
// 🔴 2026-09-01 사고를 그대로 물려받지 않으려고 처음부터 양쪽을 잠근다: 그때는 승객 초기 PIN 을
//    클라만 000000 으로 바꾸고 서버를 랜덤으로 둬, 안내문대로 넣으면 로그인이 안 되고
//    본인은 회복할 방법이 없었다(prod 2명 갇힘). 원인은 «값을 만드는 곳»과 «안내하는 곳»이
//    서로 다른 상수를 봤다는 것 하나다. 그래서 여기 상수와 클라 상수를
//    scripts/test_partner_auth.cjs 가 대조한다 — 한쪽만 고치면 게이트가 빨개진다.
// 🔴 포털은 승객과 **정책이 다르다**(고정 000000 이 아니라 랜덤). 근거 = 대상이 담당자
//    11곳뿐이라 개별 전달이 실제로 가능하고, 업체코드가 공개(partnerCodes read: true)라
//    고정 비밀번호를 쓰면 «코드 목록 + 알려진 기본값» 으로 전 거래처가 한 번에 열린다.
//    승객(16,000명·안내문 일괄 인쇄)과는 배부 비용의 크기가 다르다.
const PARTNER_PASSWORD_LENGTH = 10;
// 사람이 화면에서 읽어 옮겨 적는 값이라 헷갈리는 글자(0 O o · 1 l I)를 뺀다.
const PARTNER_PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
// 담당자가 직접 정하는 새 비밀번호의 하한. 업체코드가 공개값이라 짧으면 의미가 없다.
const PARTNER_PASSWORD_MIN_LEN = 8;
const PARTNER_PASSWORD_MAX_LEN = 64;
// 🔴 발급 화면이 그대로 보여주는 문장. **평문을 저장하지 않는다는 계약과 한 몸**이라
//    문구와 동작이 갈리면 담당자가 «나중에 다시 볼 수 있겠지» 하고 창을 닫는다.
const PARTNER_PASSWORD_ISSUE_NOTICE =
  "이 비밀번호는 지금 한 번만 보입니다. 창을 닫으면 다시 볼 수 없고, 잃어버리면 새로 발급해야 합니다.";

const sha256Hex = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

/** 비밀번호 해시. 🔴 평문은 어디에도 저장하지 않는다 — 이 함수의 출력만 남는다. */
function hashPartnerPassword(password) {
  return sha256Hex(String(password) + PARTNER_PASSWORD_SALT);
}

/**
 * 초기 비밀번호 발급. 기본 rng 는 crypto.randomInt(모듈러 편향 없음).
 * 🔴 고정값으로 되돌리지 말 것 — 위 주석의 근거가 그대로 뒤집힌다.
 */
function generateInitialPartnerPassword(randomInt) {
  const rnd = typeof randomInt === "function" ? randomInt : ((n) => crypto.randomInt(0, n));
  const n = PARTNER_PASSWORD_ALPHABET.length;
  let out = "";
  for (let i = 0; i < PARTNER_PASSWORD_LENGTH; i++) {
    out += PARTNER_PASSWORD_ALPHABET[((rnd(n) % n) + n) % n];
  }
  return out;
}

/** 담당자가 정하는 새 비밀번호가 쓸 만한가. { ok, message }. */
function checkNewPartnerPassword(v, opts) {
  const currentCode = (opts || {}).currentCode;
  const t = String(v == null ? "" : v);
  if (t.length < PARTNER_PASSWORD_MIN_LEN) {
    return { ok: false, message: "비밀번호는 " + PARTNER_PASSWORD_MIN_LEN + "자 이상이어야 합니다" };
  }
  if (t.length > PARTNER_PASSWORD_MAX_LEN) {
    return { ok: false, message: "비밀번호는 " + PARTNER_PASSWORD_MAX_LEN + "자 이하여야 합니다" };
  }
  if (/[ \t\r\n]/.test(t)) return { ok: false, message: "비밀번호에 공백은 쓸 수 없습니다" };
  // 🔴 업체코드를 비밀번호로 쓰지 못하게 막는다 — partnerCodes 는 read 가 공개라
  //    그 값은 이미 누구나 알고 있다(2026-08-28 실측 11개 전부 익명으로 읽힘).
  if (currentCode && t.trim().toLowerCase() === String(currentCode).trim().toLowerCase()) {
    return { ok: false, message: "업체코드는 비밀번호로 쓸 수 없습니다. 다른 값으로 정해주세요" };
  }
  return { ok: true, message: "" };
}

/** 업체코드 정규화 — 문서 ID 이자 유일 키. */
function normalizePartnerCode(v) {
  return String(v == null ? "" : v).trim();
}

/**
 * 커스텀 토큰 uid. 🔴 승객(passenger_{cid}_{empNo})과 **겹치지 않는 접두**를 쓴다.
 * ⚠ Firebase Auth uid 는 128자 상한이다 — 업체코드에 한글 업체명이 들어가 길어질 수 있어
 *   넘치면 해시로 접는다(그래도 코드마다 유일하고, 재로그인해도 같은 uid 다).
 */
function partnerUidOf(companyId, code) {
  const raw = "partner_" + companyId + "_" + normalizePartnerCode(code);
  if (raw.length <= 128) return raw;
  return "partner_" + companyId + "_h" + sha256Hex(normalizePartnerCode(code)).slice(0, 40);
}

/** 승계표 문서 ID — resumeToken 의 해시만 남긴다(승객 resumeDocId 와 같은 식). */
function partnerSessionDocId(resumeToken) {
  return sha256Hex(resumeToken);
}

/**
 * 이 거래처가 «비밀번호를 요구하는가».
 * 🔴 **부재·falsy = 꺼짐 = 현행 코드-only 진입**. 이 폴백을 뒤집으면 비밀번호를 아직 못 받은
 *    11곳 담당자가 그날 업무를 못 한다. 켜는 것은 거래처 단위 수동 작업이다.
 */
function isPartnerAuthRequired(codeData) {
  return !!(codeData && codeData.authRequired === true);
}

/** 포털이 화면에 쓰는 값만. 🔴 해시·평문은 넣지 않는다. */
function partnerPortalProfile(code, codeData) {
  const d = codeData || {};
  return {
    code: normalizePartnerCode(code),
    companyId: d.companyId || null,
    partnerName: d.partnerName || "",
    allowedRouteIds: Array.isArray(d.allowedRouteIds) ? d.allowedRouteIds : [],
    authRequired: isPartnerAuthRequired(d),
  };
}

/**
 * 로그인 판정. Firestore 접근 0.
 * @returns {{ok:true, passwordInitial:boolean, authRequired:boolean}
 *          |{ok:false, status:string, message:string}}
 */
function planPartnerLogin({ codeData, companyId, password, secret, nowMs, expiresAtMs }) {
  const d = codeData || null;
  // 🔴 «없는 코드 / 비활성 / 다른 회사» 는 **한 문구**로 답한다 — 갈라 말하면 공개된 코드
  //    목록으로 어느 회사 소속인지까지 훑을 수 있다.
  if (!d || d.active === false || (companyId && d.companyId !== companyId)) {
    return { ok: false, status: "permission-denied", message: "유효하지 않은 업체코드입니다" };
  }
  if (expiresAtMs && nowMs > expiresAtMs) {
    return { ok: false, status: "permission-denied", message: "만료된 업체코드입니다" };
  }
  if (!isPartnerAuthRequired(d)) {
    // 아직 안 켠 거래처 — 지금과 똑같이 코드만으로 통과한다(비밀번호를 받았든 아니든).
    return { ok: true, passwordInitial: false, authRequired: false };
  }
  const stored = secret && secret.passwordHash ? String(secret.passwordHash) : "";
  if (!stored) {
    // 켜 두고 발급을 안 한 상태 — 담당자가 무엇을 해야 하는지 화면에서 알 수 있어야 한다.
    return { ok: false, status: "failed-precondition",
      message: "이 거래처는 아직 비밀번호가 발급되지 않았습니다. 운영사 담당자에게 요청하세요" };
  }
  if (!password) {
    return { ok: false, status: "permission-denied", message: "비밀번호를 입력해주세요" };
  }
  if (hashPartnerPassword(password) !== stored) {
    return { ok: false, status: "permission-denied", message: "비밀번호가 올바르지 않습니다" };
  }
  return { ok: true, passwordInitial: secret.passwordInitial === true, authRequired: true };
}

/**
 * 승계(resume) 판정 — 비밀번호는 다시 묻지 않지만 **코드 상태는 다시 본다**.
 * 🔴 관리자가 코드를 비활성·만료시키면 다음 부팅에서 바로 막혀야 한다(승객 `passengerResume`
 *    이 명부를 다시 읽는 것과 같은 이유). 켜 둔 거래처인데 비밀번호가 사라졌으면(발급 취소)
 *    승계도 끊는다.
 */
function planPartnerResume({ codeData, companyId, secret, nowMs, expiresAtMs }) {
  const d = codeData || null;
  if (!d || d.active === false || (companyId && d.companyId !== companyId)) {
    return { ok: false, status: "unauthenticated", message: "다시 로그인해주세요" };
  }
  if (expiresAtMs && nowMs > expiresAtMs) {
    return { ok: false, status: "unauthenticated", message: "만료된 업체코드입니다" };
  }
  if (!isPartnerAuthRequired(d)) {
    return { ok: true, passwordInitial: false, authRequired: false };
  }
  if (!secret || !secret.passwordHash) {
    return { ok: false, status: "unauthenticated", message: "다시 로그인해주세요" };
  }
  return { ok: true, passwordInitial: secret.passwordInitial === true, authRequired: true };
}

/**
 * 포털 CF 호출자 판정(partnerImportPassengers·partnerReissuePins 등이 쓴다).
 *
 * 🔴 지금까지 이 검사는 «코드가 실재하는 활성 코드인가» 뿐이었고, 그 코드는 공개값이라
 *    사실상 아무나 통과했다(설계 문서의 «인증이 아니라 소속 강제와 감사 로그»). 켠 거래처는
 *    **토큰을 요구**하고, 토큰이 있으면 **토큰이 정본**이다 — 클라가 보낸 코드는 토큰과
 *    같아야 한다(안 그러면 남의 거래처 명부를 자기 토큰으로 고칠 수 있다).
 *
 * @returns {{ok:true}|{ok:false,status:string,message:string}}
 */
function planPartnerCallerCheck({ codeData, companyId, requestedCode, claims }) {
  const d = codeData || null;
  const code = normalizePartnerCode(requestedCode);
  if (!code) return { ok: false, status: "permission-denied", message: "업체코드가 필요합니다" };
  if (!d || d.active === false || d.companyId !== companyId) {
    return { ok: false, status: "permission-denied", message: "유효하지 않은 업체코드입니다" };
  }
  const c = claims || {};
  if (c.role === "partner") {
    if (c.companyId !== companyId || normalizePartnerCode(c.partnerCode) !== code) {
      return { ok: false, status: "permission-denied", message: "다른 거래처의 자료에는 접근할 수 없습니다" };
    }
    return { ok: true };
  }
  if (isPartnerAuthRequired(d)) {
    return { ok: false, status: "unauthenticated",
      message: "포털 로그인이 필요합니다. 비밀번호로 다시 로그인해주세요" };
  }
  return { ok: true };   // 아직 안 켠 거래처 — 현행 그대로
}

module.exports = {
  PARTNER_PASSWORD_SALT, PARTNER_PASSWORD_LENGTH, PARTNER_PASSWORD_ALPHABET,
  PARTNER_PASSWORD_MIN_LEN, PARTNER_PASSWORD_MAX_LEN, PARTNER_PASSWORD_ISSUE_NOTICE,
  hashPartnerPassword, generateInitialPartnerPassword, checkNewPartnerPassword,
  normalizePartnerCode, partnerUidOf, partnerSessionDocId,
  isPartnerAuthRequired, partnerPortalProfile,
  planPartnerLogin, planPartnerResume, planPartnerCallerCheck,
};
