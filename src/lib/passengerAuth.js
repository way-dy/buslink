// ─── 승객 인증 (2026-08-25 설계 P1) ─────────────────────────────────────────
// 예전에는 로그인이 **클라에서** `passengers/{empNo}` 를 읽어 `pinHash` 를 비교하는 것이
// 전부였다. 그래서 승객에게는 서버가 알아볼 신원이 없었고, 규칙에 "본인만"을 쓸 수도,
// 탑승 CF 가 "누가 찍었나"를 확인할 수도 없었다.
// 이제 PIN 대조는 서버(CF `passengerLogin`)가 하고, 통과하면 **커스텀 토큰**을 받아
// `signInWithCustomToken` 으로 들어간다 — 승객마다 uid 와 클레임이 생긴다.
//
// ⚠ 승객앱은 `inMemoryPersistence` 다(firebase.js) — **새로고침하면 로그인 상태가 사라진다**.
//   그래서 로그인 때 받은 `resumeToken` 을 기기에 보관했다가 부팅 시 `resume()` 으로
//   새 토큰을 받는다. 🔴 `resumeToken` 은 비밀번호와 같은 값이다 — 화면에 찍거나 URL 에
//   싣지 말 것.
import { getFunctions, httpsCallable } from "firebase/functions";
import { signInWithCustomToken, signInAnonymously } from "firebase/auth";
import { auth } from "../firebase";

const functions = getFunctions(undefined, "us-central1");

// CF 가 돌려준 커스텀 토큰으로 실제 로그인까지 마치고, 앱이 쓸 값만 돌려준다.
async function enter(data) {
  await signInWithCustomToken(auth, data.token);
  return { resumeToken: data.resumeToken, passenger: data.passenger };
}

// 사번 + PIN → 승객 신원. 실패 메시지는 서버 문구를 그대로 쓴다(화면에 그대로 나간다).
export async function passengerLogin({ companyId, empNo, pin }) {
  const { data } = await httpsCallable(functions, "passengerLogin")({ companyId, empNo, pin });
  return await enter(data);
}

// 기기에 보관한 승계표로 세션 복원. 명부를 다시 읽으므로 퇴사·비활성은 즉시 반영된다.
export async function passengerResume({ companyId, resumeToken }) {
  const { data } = await httpsCallable(functions, "passengerResume")({ companyId, resumeToken });
  return await enter(data);
}

// 🔴 한시적 — 이 배포 이전에 로그인해 둔 기기(localStorage 에 `pinHash` 만 있음)를 튕기지
//    않고 승계시킨다. 서버에 하드 만료일이 박혀 있어 그 뒤로는 거부된다(그때는 PIN 재입력).
export async function passengerMigrate({ companyId, empNo, pinHash }) {
  const { data } = await httpsCallable(functions, "passengerMigrate")({ companyId, empNo, pinHash });
  return await enter(data);
}

// PIN 첫 설정·변경. 신원은 토큰에서 읽으므로 사번을 보내지 않는다.
// 첫 설정(pinInitial)일 때는 currentPin 이 없어도 된다.
export async function passengerSetPin({ currentPin, newPin }) {
  await httpsCallable(functions, "passengerSetPin")({ currentPin: currentPin || null, newPin });
}

// 로그아웃 — 서버 승계표까지 지우고 익명으로 되돌린다. 서버 실패는 무시한다
// (기기에서 지우는 것이 우선이고, 여기서 막히면 로그아웃 자체가 안 된다).
export async function passengerLogout({ companyId, resumeToken }) {
  if (resumeToken) {
    try { await httpsCallable(functions, "passengerLogout")({ companyId, resumeToken }); }
    catch (e) { console.warn("[승객인증] 서버 로그아웃 실패:", e?.message); }
  }
  try { await signInAnonymously(auth); } catch (e) { /* 로그인 화면은 익명 없이도 뜬다 */ }
}
