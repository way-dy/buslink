// 승객 명부 노출 실측 — 익명 사용자가 무엇을 읽을 수 있나 (2026-08-28 · P4 판단 자료)
//   node scripts/inspect_passenger_exposure.cjs
// 🔴 읽기 전용 · prod 쓰기 0. **개인정보를 화면에 찍지 않는다** — 건수와 필드 '이름'만 센다.
//    (노출을 증명하는 데 값이 필요하지 않고, 증명하려다 로그에 명부를 남기면 본말전도다.)
//
// 배경: 2026-08-25 P1·P2(커스텀 토큰) 로 신원은 생겼지만 P3(포털 CRUD 서버 이관)·P4(명부 닫기)
// 전까지 `passengers` read 는 `isAuth()` 라 **익명 로그인만 하면 누구나 전건**을 읽는다.
// 그 위험을 적어 둘 당시 명부는 258건이었는데, 2026-08-27 업로드로 자릿수가 바뀌었다.
const path = require("path");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const COMPANY = process.env.COMPANY || "dy001";

function loadEnv() {
  const p = path.join(ROOT, ".env.local");
  const out = {};
  if (!fs.existsSync(p)) throw new Error(".env.local 없음 — 익명 클라이언트를 만들 수 없다");
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

(async () => {
  const env = loadEnv();
  const { initializeApp } = require(path.join(ROOT, "node_modules/firebase/app"));
  const { getAuth, signInAnonymously } = require(path.join(ROOT, "node_modules/firebase/auth"));
  const {
    getFirestore, collection, getDocs, query, limit, getCountFromServer,
  } = require(path.join(ROOT, "node_modules/firebase/firestore"));

  const app = initializeApp({
    apiKey: env.REACT_APP_FIREBASE_API_KEY,
    authDomain: env.REACT_APP_FIREBASE_AUTH_DOMAIN,
    projectId: env.REACT_APP_FIREBASE_PROJECT_ID,
    storageBucket: env.REACT_APP_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
    appId: env.REACT_APP_FIREBASE_APP_ID,
  });
  const cred = await signInAnonymously(getAuth(app));
  const db = getFirestore(app);
  console.log(`\n익명 로그인 성공 — uid ${cred.user.uid.slice(0, 8)}… (앱을 여는 누구나 여기까지 온다)`);

  const col = collection(db, "companies", COMPANY, "passengers");

  // ① 전건 셀 수 있나
  let total = null, countErr = null;
  try { total = (await getCountFromServer(col)).data().count; }
  catch (e) { countErr = e.code || e.message; }
  console.log(`\n[1] 명부 전건 집계   : ${total !== null ? `읽힘 — ${total.toLocaleString()}건` : `거부(${countErr})`}`);

  // ② 문서 내용을 읽을 수 있나 — **필드 이름만** 본다
  let fields = null, readErr = null;
  try {
    const snap = await getDocs(query(col, limit(1)));
    if (!snap.empty) fields = Object.keys(snap.docs[0].data()).sort();
  } catch (e) { readErr = e.code || e.message; }
  console.log(`[2] 문서 내용        : ${fields ? "읽힘" : `거부(${readErr})`}`);
  if (fields) {
    console.log(`    필드 ${fields.length}개: ${fields.join(", ")}`);
    const sensitive = fields.filter((f) => /pinHash|nfcUid|name|dept|empNo|partnerName/i.test(f));
    console.log(`    이 중 개인 식별·자격 관련: ${sensitive.join(", ") || "없음"}`);
  }

  // ③ 대조군 — 이미 닫아 둔 컬렉션은 여전히 닫혀 있나(규칙이 통째로 열린 게 아님을 확인)
  let sessionsDenied = false, sessErr = null;
  try { await getDocs(query(collection(db, "companies", COMPANY, "passengerSessions"), limit(1))); }
  catch (e) { sessionsDenied = e.code === "permission-denied"; sessErr = e.code; }
  console.log(`[3] 대조군 승계표    : ${sessionsDenied ? "거부(정상 — 닫혀 있다)" : `읽힘 🔴 (${sessErr || "허용"})`}`);

  console.log(`\n판정: ${fields && total ? `🔴 익명 사용자가 명부 ${total.toLocaleString()}건을 전부 읽을 수 있다` : "명부 읽기가 막혀 있다"}`);
  console.log("   (P3 포털 CRUD 서버 이관 → P4 명부 닫기 전까지 남는 위험. 닫을 때 로그인 시도 제한도 함께.)");
  process.exit(0);
})();
