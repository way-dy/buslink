// 승객 로그인 라이브 검증 — **배포 후에만** 돌린다 (2026-08-25 P1·P2)
//   node scripts/test_passenger_login_live.cjs
//
// 이 검사가 재는 것 = "258명이 내일 아침 로그인할 수 있는가". 배포 로그·함수 목록으로는
// 절대 알 수 없다(함수는 떠 있는데 해시가 안 맞거나 IAM 이 막으면 전원 로그인 불가).
//
// 🔴 **prod 에 남는 것**: 검토용 계정 `REVIEW` 의 `lastLoginAt` 갱신 + `passengerSessions`
//    문서 1건(끝에 passengerLogout 으로 지운다). 실승객 계정은 건드리지 않는다.
// 🔴 **거부 케이스는 아무것도 안 쓴다**(로그인 실패는 write 가 없다).
// ⚠ 2026-08-25 사고 교훈: "거부를 재는 호출이니 안전하다"는 넘겨짚음이 가짜 탑승을 적재했다.
//    그래서 여기서도 **탑승(boardStatic) 성공 경로는 부르지 않는다** — 그건
//    `test_board_static_auth.cjs`(거부만) 담당이다.
const path = require("path");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const COMPANY = "dy001";
const REGION = "us-central1";
// 평문을 아는 유일한 계정. 없으면 이 검사는 성립하지 않는다(실승객 PIN 은 평문이 없다).
const REVIEW = { empNo: "REVIEW", pin: "112233" };

function loadEnv() {
  const out = {};
  fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/).forEach((l) => {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m) out[m[1]] = m[2];
  });
  return out;
}

(async () => {
  const env = loadEnv();
  const { initializeApp } = require(path.join(ROOT, "node_modules/firebase/app"));
  const { getAuth, signInWithCustomToken, signOut } = require(path.join(ROOT, "node_modules/firebase/auth"));
  const { getFunctions, httpsCallable } = require(path.join(ROOT, "node_modules/firebase/functions"));
  const app = initializeApp({
    apiKey: env.REACT_APP_FIREBASE_API_KEY,
    authDomain: env.REACT_APP_FIREBASE_AUTH_DOMAIN,
    projectId: env.REACT_APP_FIREBASE_PROJECT_ID,
    storageBucket: env.REACT_APP_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
    appId: env.REACT_APP_FIREBASE_APP_ID,
  });
  const auth = getAuth(app);
  const fns = getFunctions(app, REGION);
  const call = (name) => async (data) => {
    try { const r = await httpsCallable(fns, name)(data); return { ok: true, data: r.data }; }
    catch (e) { return { ok: false, code: e.code || "", message: e.message || "" }; }
  };

  let n = 0, fail = 0;
  const ok = (label, cond, got) => {
    n++;
    console.log(`  ${cond ? "✓" : "✗"} ${label}${!cond && got !== undefined ? " → " + JSON.stringify(got).slice(0, 200) : ""}`);
    if (!cond) fail++;
  };

  console.log("\n[A] 거부 — 쓰기 0");
  const bad1 = await call("passengerLogin")({ companyId: COMPANY, empNo: "9999zz-not-real", pin: "1234" });
  ok("없는 사번은 거부", !bad1.ok && /등록되지 않은 사번/.test(bad1.message), bad1);
  const bad2 = await call("passengerLogin")({ companyId: COMPANY, empNo: REVIEW.empNo, pin: "000111" });
  ok("틀린 PIN 은 거부", !bad2.ok && /PIN이 올바르지 않습니다/.test(bad2.message), bad2);
  const bad3 = await call("passengerResume")({ companyId: COMPANY, resumeToken: "f".repeat(64) });
  ok("모르는 승계표는 거부", !bad3.ok && /다시 로그인/.test(bad3.message), bad3);
  // 🔴 이게 403 Forbidden 이면 invoker(allUsers) 가 안 걸린 것 — 우리 코드의 거부와 구별해야 한다.
  ok("계측 성립 — CF 에 실제로 닿았다(invoker 정상)",
    !/internal|not-found|unauthenticated/.test(bad1.code || ""), bad1.code);

  console.log("\n[B] 로그인 — 검토용 계정(REVIEW) 1건");
  const login = await call("passengerLogin")({ companyId: COMPANY, empNo: REVIEW.empNo, pin: REVIEW.pin });
  ok("🔴 실제 로그인이 된다", login.ok, login);
  if (!login.ok) {
    console.log("\n❌ 여기서 실패하면 **전 승객이 로그인 못 한다** — 즉시 롤백 판단.");
    console.log(`   ${n - fail}/${n} 통과`);
    process.exit(1);
  }
  const d = login.data || {};
  ok("커스텀 토큰이 왔다", typeof d.token === "string" && d.token.length > 100);
  ok("승계표가 왔다", typeof d.resumeToken === "string" && d.resumeToken.length === 64);
  ok("프로필에 사번이 있다", d.passenger && d.passenger.empNo === REVIEW.empNo, d.passenger);
  // 🔴 세션에서 pinHash 를 뺀 것이 P2 의 목표 — 다시 들어오면 회귀다.
  ok("🔴 프로필에 pinHash 가 없다(P2)", d.passenger && d.passenger.pinHash === undefined, Object.keys(d.passenger || {}));

  console.log("\n[C] 커스텀 토큰으로 실제 인증");
  let signedIn = false, claims = null;
  try {
    const cred = await signInWithCustomToken(auth, d.token);
    signedIn = true;
    const t = await cred.user.getIdTokenResult();
    claims = { role: t.claims.role, companyId: t.claims.companyId, empNo: t.claims.empNo };
  } catch (e) {
    console.log("    로그인 실패:", e.message);
  }
  ok("🔴 signInWithCustomToken 성공(= 승객 신원 생성)", signedIn);
  ok("클레임이 실려 있다", claims && claims.role === "passenger" && claims.empNo === REVIEW.empNo, claims);
  ok("uid 가 규칙대로다", signedIn && auth.currentUser.uid === `passenger_${COMPANY}_${REVIEW.empNo}`,
    signedIn ? auth.currentUser.uid : null);

  console.log("\n[D] 새로고침 복원(passengerResume) — 이게 깨지면 '탈 때마다 로그인'이 된다");
  const res = await call("passengerResume")({ companyId: COMPANY, resumeToken: d.resumeToken });
  ok("🔴 승계표로 세션이 복원된다", res.ok, res);
  ok("복원 때 승계표는 그대로다(탭 여러 개 대비)",
    res.ok && res.data.resumeToken === d.resumeToken, res.ok ? res.data.resumeToken : null);

  console.log("\n[E] 로그아웃 — 서버 승계표 제거");
  const out = await call("passengerLogout")({ companyId: COMPANY, resumeToken: d.resumeToken });
  ok("로그아웃 호출 성공", out.ok, out);
  const after = await call("passengerResume")({ companyId: COMPANY, resumeToken: d.resumeToken });
  ok("지운 승계표로는 복원되지 않는다", !after.ok, after);

  try { await signOut(auth); } catch { /* 무해 */ }
  console.log(`\n${fail === 0 ? "✅" : "❌"} ${n - fail}/${n} 통과`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
