// 고정 QR 탑승 본인 확인 — 2026-08-25 미팅(외부 카메라로 열면 아무거나 넣어도 탑승) 가드.
//
//   node scripts/test_board_static_auth.cjs            (거부 3종만 — prod 쓰기 0)
//
// 🔴 **일부러 성공 경로를 호출하지 않는다.** boardStatic 성공은 prod 에 탑승 기록을 만들고
//    그날 탑승률·정원 통계를 오염시킨다. 그래서 이 하네스는 두 가지를 나눠서 잰다:
//      [A] 서버 거부 — 익명 클라로 실제 호출. 거부는 아무것도 안 쓴다.
//      [B] 통과 근거 — 명부의 pinHash 가 `hashPin(PIN)` 과 실제로 맞는지 Admin SDK 로 **읽어서만** 대조.
//          (성공 경로가 쓰는 값이 바로 이 해시다 — 여기가 맞으면 진짜 승객은 안 막힌다.)
// 🔴 해시식은 베끼지 않고 `src/lib/partner.js` 의 hashPin 소스를 그대로 vm 에 태운다(재구현 0).
const path = require("path");
const fs = require("fs");
const vm = require("vm");
const crypto = require("crypto");
const ROOT = path.join(__dirname, "..");

// ── src/lib/partner.js 의 hashPin 만 격리 실행(파이어베이스 import 는 잘라낸다) ──
function loadHashPin() {
  const src = fs.readFileSync(path.join(ROOT, "src/lib/partner.js"), "utf8");
  const m = /export async function hashPin\(pin\) \{[\s\S]*?\n\}/.exec(src);
  if (!m) throw new Error("hashPin 소스를 못 찾았다 — 함수명이 바뀌었는지 확인");
  const ctx = { crypto: crypto.webcrypto, TextEncoder, console };
  vm.createContext(ctx);
  vm.runInContext(m[0].replace(/^export /, "") + "\n;this.__h = hashPin;", ctx);
  return ctx.__h;
}

function loadAdmin() {
  const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
  const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
  const sa = require(path.join(ROOT, "key", kf));
  if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치");
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  return admin;
}

const COMPANY = "dy001";
// 🔴 리전은 `us-central1` — 손으로 URL 을 짜지 말고 SDK 를 쓴다. 처음에 asia-northeast3 로
//    URL 을 만들었더니 전 케이스가 404 로 떨어져 **아무것도 못 재면서 빨갛게** 나왔다.
const REGION = "us-central1";

function loadEnv() {
  const out = {};
  fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/).forEach((l) => {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m) out[m[1]] = m[2];
  });
  return out;
}

// 익명 클라이언트(= 승객앱 밖 고정 QR 진입점과 같은 신원)로 boardStatic 호출.
async function makeCaller() {
  const env = loadEnv();
  const { initializeApp } = require(path.join(ROOT, "node_modules/firebase/app"));
  const { getAuth, signInAnonymously } = require(path.join(ROOT, "node_modules/firebase/auth"));
  const { getFunctions, httpsCallable } = require(path.join(ROOT, "node_modules/firebase/functions"));
  const app = initializeApp({
    apiKey: env.REACT_APP_FIREBASE_API_KEY,
    authDomain: env.REACT_APP_FIREBASE_AUTH_DOMAIN,
    projectId: env.REACT_APP_FIREBASE_PROJECT_ID,
    storageBucket: env.REACT_APP_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
    appId: env.REACT_APP_FIREBASE_APP_ID,
  });
  await signInAnonymously(getAuth(app));
  const call = httpsCallable(getFunctions(app, REGION), "boardStatic");
  return async (data) => {
    try { const r = await call(data); return { ok: true, code: null, message: JSON.stringify(r.data) }; }
    catch (e) { return { ok: false, code: e.code || "", message: e.message || "" }; }
  };
}

(async () => {
  let fail = 0, n = 0;
  const ok = (name, cond, got) => {
    n++; console.log(`  ${cond ? "✓" : "✗"} ${name}${!cond && got !== undefined ? " → " + JSON.stringify(got).slice(0, 220) : ""}`);
    if (!cond) fail++;
  };

  const hashPin = loadHashPin();
  const admin = loadAdmin();
  const db = admin.firestore();

  // 대상 차량 = 오늘 배차가 있는 아무 차량(배차가 없으면 배차 단계에서 먼저 막혀 본인확인을 못 잰다).
  const today = new Date();
  const ds = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  // 🔴 본인 확인은 **배차 해석보다 먼저** 돌므로 배차가 없어도 잴 수 있다(그래서 낮에도 검사 성립).
  //    실제 차량이 있으면 그걸 쓰고, 없으면 더미를 넣는다 — 거부 문구로 어느 단계에서 막혔는지 가른다.
  const disp = await db.collection("companies").doc(COMPANY)
    .collection("dispatches").doc(ds).collection("list").limit(1).get();
  const vehicleId = (disp.empty ? null : (disp.docs[0].data() || {}).vehicleId) || "__no_such_vehicle__";
  console.log(`\n오늘(${ds}) 배차 ${disp.size ? "있음" : "없음"} · 차량 ${vehicleId}`);

  // 실재 승객 1명(해시 대조용) — 읽기만.
  const ps = await db.collection("companies").doc(COMPANY).collection("passengers").limit(1).get();
  const realEmpNo = ps.empty ? null : ps.docs[0].id;
  const realHash = ps.empty ? null : (ps.docs[0].data() || {}).pinHash;

  const callBoardStatic = await makeCaller();

  // ── 안전 프로브 — 🔴 이 검사를 돌려도 되는 서버인지 먼저 묻는다 ────────────────
  // 2026-08-25 실측 사고: "거부를 재는 호출이니 아무것도 안 쓴다"고 넘겨짚고 **배포 전**
  //   prod 에 돌렸다가, 본인 확인이 없던 그 서버가 세 호출을 전부 **성공**시켜 가짜 탑승
  //   2건(그중 하나는 실재 승객 이름으로)을 적재했다. 지우는 스크립트를 따로 만들어야 했다.
  // 프로브는 **없는 차량**으로 부른다 — 가드가 있으면 사번 단계에서 먼저 막히고(쓰기 0),
  //   가드가 없으면 배차 해석에서 막힌다(그것도 쓰기 0). 두 경우의 **문구가 다르다**는 게
  //   판별자다. 가드가 없다고 나오면 아래 케이스는 **돌리지 않는다**.
  const probe = await callBoardStatic({
    companyId: COMPANY, vehicleId: "__no_such_vehicle__", empNo: "9999zz-not-a-real-emp", pinHash: "deadbeef",
  });
  const guarded = !probe.ok && /등록되지 않은 사번/.test(probe.message);
  console.log(`\n[프로브] 서버 본인확인 가드 ${guarded ? "있음" : "없음"} — ${probe.message.slice(0, 80)}`);
  if (!guarded) {
    console.log("\n⛔ 이 서버에는 본인 확인 가드가 없다. 거부 케이스를 돌리면 **가짜 탑승이 적재된다**.");
    console.log("   `firebase deploy --only functions:boardStatic` 후 다시 실행할 것.");
    process.exit(1);
  }

  console.log("\n[A] 서버 거부 — 익명 클라 실호출(가드 확인 후이므로 쓰기 0)");
  const cases = [
    ["무작위 사번은 거부된다(신고된 공격)", { companyId: COMPANY, vehicleId, empNo: "9999zz-not-a-real-emp", pinHash: "deadbeef" }],
    ["실재 사번 + 틀린 비밀번호는 거부된다", { companyId: COMPANY, vehicleId, empNo: realEmpNo, pinHash: "0".repeat(64) }],
    ["실재 사번 + 본인확인 없음은 거부된다", { companyId: COMPANY, vehicleId, empNo: realEmpNo }],
  ];
  let instrumentAlive = false;
  for (const [label, data] of cases) {
    if (!data.empNo) { console.log(`  ⏭ SKIP ${label} (승객 없음)`); continue; }
    const res = await callBoardStatic(data);
    if (res.code !== "functions/internal" && res.code !== "functions/not-found") instrumentAlive = true;
    // 🔴 "거부됐다"만 보면 안 된다 — 배차 없음(failed-precondition)으로 막혀도 거부는 거부다.
    //    본인 확인 단계에서 막혔는지 **문구**로 확정한다(그게 이 검사의 대상이다).
    // "앱을 새로 고친 뒤" = 레거시 pinHash 경로가 기한 만료로 닫힌 뒤의 거부 문구(2026-08-25 P2).
    //   이 하네스는 **익명**으로 부르므로 신원 토큰이 없다 = 언제나 레거시 경로를 잰다.
    const denied = !res.ok && /등록되지 않은 사번|본인 확인이 필요|비활성화된 계정|새로 고친 뒤/.test(res.message);
    ok(label, denied, res);
  }
  // 🔴 계측기가 살아 있었나 — 전 케이스가 not-found/internal 이면 아무것도 못 잰 것이지
  //    "안전하다"가 아니다(2026-08-25 실측: 리전을 잘못 짚어 404 로 전부 빨갛게 나왔다).
  ok("계측 성립 — CF 에 실제로 닿았다", instrumentAlive);

  console.log("\n[B] 통과 근거 — 명부 해시가 hashPin(PIN) 과 맞물리는지(읽기만)");
  ok("승객 문서에 pinHash 가 있다", !!realHash, realEmpNo);
  const sample = await hashPin("112233");
  ok("hashPin 이 64자리 SHA-256 hex 를 만든다", /^[0-9a-f]{64}$/.test(sample), sample);
  ok("같은 PIN 은 항상 같은 해시(서버 대조가 성립)", sample === await hashPin("112233"));
  ok("다른 PIN 은 다른 해시", sample !== await hashPin("112234"));
  // 검토용 계정(PIN 112233)이 살아 있으면 저장 해시와 실제로 맞는지까지 대조.
  const rev = await db.collection("companies").doc(COMPANY).collection("passengers").doc("REVIEW").get();
  if (rev.exists) {
    ok("검토용 계정 저장 해시 = hashPin('112233')", (rev.data() || {}).pinHash === sample, "불일치");
  } else {
    console.log("  ⏭ SKIP 검토용 계정(REVIEW) 없음 — 저장 해시 실대조는 건너뜀");
  }

  console.log(`\n${fail === 0 ? "✅" : "❌"} ${n - fail}/${n} 통과`);
  process.exit(fail === 0 ? 0 : 1);
})();
