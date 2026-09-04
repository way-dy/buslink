// src/lib/partnerAuth.js — 협력사 포털 인증 CF 호출부 (2026-09-04 P3-b 1단계)
// ---------------------------------------------------------------------------
// 🔴 왜 필요한가: 협력사 포털은 지금 **업체코드만 알면 들어간다**. 그런데 그 코드는
//    `partnerCodes` read 규칙이 `true`(공개)라 **익명으로 11개가 전부 읽힌다**(2026-08-28
//    실측). 즉 인증이 없는 것과 같고, 남의 거래처 명부(16,409건)를 보고 고칠 수 있다.
//
// 구조는 **승객 P1(`src/lib/passengerAuth.js`)을 그대로 복제**한다 — 새로 발명하지 않는다.
//   passengerLogin  → partnerLogin        (커스텀 토큰 + resumeToken)
//   passengerResume → partnerResume       (포털도 inMemoryPersistence 라 새로고침마다 필요)
//   passengerLogout → partnerLogout
//   passengerSetPin → partnerSetPassword  (첫 로그인 시 변경 강제)
//
// ⚠ 협력사 포털(`/partner`)은 `firebase.js` 에서 **inMemoryPersistence** 다(익명 앱 라우트).
//   커스텀 토큰은 새로고침하면 사라지므로 `resumeToken` 을 기기에 두고 부팅마다 되받는다.
//   🔴 resumeToken 은 비밀번호와 같은 값이다 — 화면에 찍거나 URL 에 싣지 말 것.
// ---------------------------------------------------------------------------
import { getFunctions, httpsCallable } from "firebase/functions";
import { signInWithCustomToken, signInAnonymously } from "firebase/auth";
import { auth } from "../firebase";

const functions = getFunctions(undefined, "us-central1");

// CF 가 돌려준 커스텀 토큰으로 실제 로그인까지 마치고, 앱이 쓸 값만 돌려준다.
async function enter(data) {
  await signInWithCustomToken(auth, data.token);
  return {
    resumeToken: data.resumeToken,
    partner: data.partner,               // { code, companyId, partnerName, allowedRouteIds, authRequired }
    passwordInitial: !!data.passwordInitial,
  };
}

/** 업체코드 + 비밀번호 → 포털 신원. 실패 메시지는 서버 문구를 그대로 쓴다. */
export async function partnerLogin({ companyId, code, password }) {
  const { data } = await httpsCallable(functions, "partnerLogin")({ companyId, code, password });
  return await enter(data);
}

/** 기기에 보관한 승계표로 세션 복원. 코드 문서를 다시 읽으므로 비활성·만료가 즉시 반영된다. */
export async function partnerResume({ companyId, resumeToken }) {
  const { data } = await httpsCallable(functions, "partnerResume")({ companyId, resumeToken });
  return await enter(data);
}

/** 첫 로그인 시 변경 강제 · 이후 자발적 변경. 신원은 토큰에서 읽으므로 코드를 보내지 않는다. */
export async function partnerSetPassword({ currentPassword, newPassword }) {
  await httpsCallable(functions, "partnerSetPassword")({
    currentPassword: currentPassword || null, newPassword,
  });
}

/** 로그아웃 — 서버 승계표까지 지우고 익명으로 되돌린다. 서버 실패는 무시한다. */
export async function partnerLogout({ companyId, resumeToken }) {
  if (resumeToken) {
    try { await httpsCallable(functions, "partnerLogout")({ companyId, resumeToken }); }
    catch (e) { console.warn("[포털인증] 서버 로그아웃 실패:", e?.message); }
  }
  try { await signInAnonymously(auth); } catch (e) { /* 인증 화면은 익명 없이도 뜬다 */ }
}

/**
 * 🔴 **관리자 전용** — 초기 비밀번호 발급·재발급. AdminApp 협력사 관리에서만 부른다.
 * 평문은 **응답에 1회만** 오고 어디에도 저장되지 않는다(승객 안내문과 같은 계약).
 */
export async function partnerIssuePassword({ companyId, partnerCode }) {
  const { data } = await httpsCallable(functions, "partnerIssuePassword")({ companyId, partnerCode });
  return data;   // { ok, partnerCode, partnerName, password, reissued }
}
