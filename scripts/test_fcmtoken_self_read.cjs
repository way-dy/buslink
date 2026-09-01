// @requires-credentials
// 실토큰 프로브 — 승객이 **자기** fcmTokens 문서만 읽을 수 있는가 (2026-09-01).
//   node scripts/test_fcmtoken_self_read.cjs
//
// 왜 이 검사가 필요한가: `fcmTokens` read 가 `isAdmin` 전용이라 승객앱이 '내 정류장'을
// **쓰기만 하고 다시 읽지 못했다** → 앱을 새로 열 때마다 지정이 풀린 것처럼 보였다
// (2026-05-26 부터 «비치명적»으로 적혀 있었으나 2026-09-01 신고의 정체였다).
//
// 🔴 **서비스 계정으로 재면 늘 통과한다** — 반드시 클라이언트 SDK + 실제 승객 토큰으로.
// 🔴 대조군 2개가 이 검사의 절반이다:
//    ⓐ 승객 토큰으로 **남의 문서**를 읽으면 거부되는가(과하게 열었는지)
//    ⓑ **익명 세션**은 여전히 거부되는가(규칙을 넓히지 않았다는 증거)
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
const sa = require(path.join(ROOT, "key", kf));
if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치: " + sa.project_id);
admin.initializeApp({ credential: admin.credential.cert(sa) });
const adb = admin.firestore();

const COMPANY = "dy001";
const ME = "REVIEW";              // 검토용 계정(신촌세브란스) — 실제 사람 계정 아님
const OTHER = "0879824";          // 대조군: 남의 문서(신고자) — **읽히면 안 된다**

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${x !== undefined ? " — " + JSON.stringify(x) : ""}`); } };

(async () => {
  // 클라이언트 SDK — 앱과 같은 경로로 읽는다.
  const { initializeApp } = require(path.join(ROOT, "node_modules", "firebase", "app"));
  const { getAuth, signInWithCustomToken, signInAnonymously, signOut } =
    require(path.join(ROOT, "node_modules", "firebase", "auth"));
  const { getFirestore, doc, getDoc } = require(path.join(ROOT, "node_modules", "firebase", "firestore"));

  const cfg = {
    apiKey: process.env.REACT_APP_FIREBASE_API_KEY,
    authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
    projectId: "buslink-prod",
  };
  if (!cfg.apiKey) {
    // .env.local 에서 읽는다(빌드와 같은 값).
    const env = fs.readFileSync(path.join(ROOT, ".env.local"), "utf8");
    const g = (k) => (env.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1];
    cfg.apiKey = g("REACT_APP_FIREBASE_API_KEY");
    cfg.authDomain = g("REACT_APP_FIREBASE_AUTH_DOMAIN");
  }
  ok("Firebase 웹 설정을 읽었다(신호 유무)", !!cfg.apiKey);
  if (!cfg.apiKey) { console.log("⏭ 판정 불가"); process.exit(1); }

  const app = initializeApp(cfg, "probe-" + Date.now());
  const auth = getAuth(app);
  const cdb = getFirestore(app);

  // 준비 — 내 문서에 값을 심는다(Admin SDK). 끝나면 지운다.
  const meRef = adb.collection("companies").doc(COMPANY).collection("fcmTokens").doc(ME);
  await meRef.set({ empNo: ME, companyId: COMPANY, routeId: "PROBE_ROUTE", stopId: "PROBE_STOP" }, { merge: true });

  try {
    console.log("\n[1] 승객 본인 — 자기 문서를 읽을 수 있어야 한다");
    const tok = await admin.auth().createCustomToken(`passenger_${COMPANY}_${ME}`, {
      role: "passenger", companyId: COMPANY, empNo: ME, partnerCode: "",
    });
    await signInWithCustomToken(auth, tok);
    let mine = null, err = null;
    try { mine = await getDoc(doc(cdb, "companies", COMPANY, "fcmTokens", ME)); }
    catch (e) { err = e.code || e.message; }
    ok("자기 문서 읽기 성공", !!mine && mine.exists(), err);
    ok("내 정류장 값이 그대로 온다", mine && mine.data() && mine.data().stopId === "PROBE_STOP",
      mine && mine.data ? mine.data() : null);

    console.log("\n[2] 🔴 대조군 — 같은 승객 토큰으로 **남의 문서**는 거부되어야 한다");
    let other = null, oerr = null;
    try { other = await getDoc(doc(cdb, "companies", COMPANY, "fcmTokens", OTHER)); }
    catch (e) { oerr = e.code || e.message; }
    ok("남의 문서 읽기 거부됨(과하게 열지 않았다)", other === null && /permission-denied/.test(oerr || ""), { oerr, got: other && other.exists() });

    console.log("\n[3] 🔴 대조군 — 익명 세션은 여전히 거부되어야 한다(규칙을 안 넓혔다는 증거)");
    await signOut(auth);
    await signInAnonymously(auth);
    let anon = null, aerr = null;
    try { anon = await getDoc(doc(cdb, "companies", COMPANY, "fcmTokens", ME)); }
    catch (e) { aerr = e.code || e.message; }
    ok("익명 읽기 거부됨", anon === null && /permission-denied/.test(aerr || ""), { aerr, got: anon && anon.exists() });

    console.log("\n[4] 쓰기 계약은 그대로(직원앱 토큰 등록이 막히면 안 된다)");
    ok("익명도 쓰기는 여전히 가능(규칙 원문 유지)",
      /match \/fcmTokens\/\{empNo\}[\s\S]{0,200}?allow write: if isAuth\(\)/.test(
        fs.readFileSync(path.join(ROOT, "firestore.rules"), "utf8")));

    await signOut(auth).catch(() => {});
  } finally {
    await meRef.delete().catch(() => {});
    console.log("\n♻ 프로브 문서 삭제");
  }

  console.log(`\n${fail === 0 ? "✅ 전부 통과" : "❌ 실패 있음"} — ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})();
