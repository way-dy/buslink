// 포털 명부 CF 실호출 검증 — partnerImportPassengers / partnerReissuePins (2026-08-28 P3-a)
//   node scripts/test_partner_roster_live.cjs
//
// 🔴 **익명 클라이언트로 부른다** — 서비스 계정으로 부르면 인증 게이트가 늘 통과해
//    "포털에서 실제로 되는지"를 증명하지 못한다(아키타입 C playbook).
// 🔴 대상은 **샘플 거래처**(삼성전자 샘플). 실제 사람 계정을 건드리지 않는다.
//    검사가 만든 시험용 승객은 성공·실패와 무관하게 **끝에 지운다** — 안 지우면
//    그 거래처 인원 집계에 남아 다음 사람이 실데이터로 착각한다.
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const COMPANY = "dy001";
const PROBE = "ZZ-P3A-PROBE";          // 시험용 사번(사람 아님)

let n = 0, fail = 0;
const ok = (name, cond, got) => {
  n++;
  console.log(`  ${cond ? "✓" : "✗"} ${name}${!cond && got !== undefined ? " → " + JSON.stringify(got) : ""}`);
  if (!cond) fail++;
};

function loadAdmin() {
  const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
  const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
  const sa = require(path.join(ROOT, "key", kf));
  if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치");
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(sa) });
  return admin;
}
function loadEnv() {
  const out = {};
  for (const line of fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

(async () => {
  const admin = loadAdmin();
  const db = admin.firestore();
  const col = db.collection("companies").doc(COMPANY).collection("passengers");
  const secCol = db.collection("companies").doc(COMPANY).collection("passengerSecrets");

  const pcSnap = await db.collection("partnerCodes").where("companyId", "==", COMPANY).get();
  const sample = pcSnap.docs.find((d) => String(d.data().partnerName || "").includes("샘플"));
  if (!sample) { console.log("⏭ SKIP — 샘플 거래처가 없다"); process.exit(0); }
  const CODE = sample.id;
  console.log(`\n대상 거래처: ${sample.data().partnerName} (${CODE.slice(0, 18)}…)`);

  const cleanup = async () => {
    await col.doc(PROBE).delete().catch(() => {});
    await secCol.doc(PROBE).delete().catch(() => {});
  };
  await cleanup();   // 앞선 실행이 남긴 것 정리

  const env = loadEnv();
  const { initializeApp } = require(path.join(ROOT, "node_modules/firebase/app"));
  const { getAuth, signInAnonymously } = require(path.join(ROOT, "node_modules/firebase/auth"));
  const { getFunctions, httpsCallable } = require(path.join(ROOT, "node_modules/firebase/functions"));
  const app = initializeApp({
    apiKey: env.REACT_APP_FIREBASE_API_KEY, authDomain: env.REACT_APP_FIREBASE_AUTH_DOMAIN,
    projectId: env.REACT_APP_FIREBASE_PROJECT_ID, storageBucket: env.REACT_APP_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID, appId: env.REACT_APP_FIREBASE_APP_ID,
  });
  await signInAnonymously(getAuth(app));
  const fns = getFunctions(app, "us-central1");
  const importFn = httpsCallable(fns, "partnerImportPassengers");
  const reissueFn = httpsCallable(fns, "partnerReissuePins");

  try {
    console.log("\n[1] 신규 등록 — 해시가 명부가 아니라 secrets 로 간다");
    const r1 = (await importFn({
      companyId: COMPANY, partnerCode: CODE, partnerName: sample.data().partnerName,
      employees: [{ empNo: PROBE, name: "검사용", dept: "검사", routeCode: "", active: true }],
    })).data;
    ok("신규 1명으로 집계", r1.added === 1 && r1.updated === 0, r1);
    ok("평문 PIN 을 돌려준다(안내문용)", /^\d{6}$/.test((r1.credentials[0] || {}).pin || ""), r1.credentials);
    const doc1 = (await col.doc(PROBE).get()).data() || {};
    ok("명부 문서가 생겼다", !!doc1.empNo, doc1);
    ok("🔴 명부에 pinHash 가 없다", doc1.pinHash === undefined, Object.keys(doc1));
    ok("pinInitial:true", doc1.pinInitial === true);
    const sec1 = (await secCol.doc(PROBE).get()).data() || {};
    ok("🔴 secrets 에 해시가 있다", typeof sec1.pinHash === "string" && sec1.pinHash.length === 64, sec1.pinHash ? "있음" : "없음");

    console.log("\n[2] 같은 사번 재등록 — 기존으로 보고 PIN 을 새로 주지 않는다");
    const r2 = (await importFn({
      companyId: COMPANY, partnerCode: CODE, partnerName: sample.data().partnerName,
      employees: [{ empNo: PROBE, name: "검사용2", dept: "검사", routeCode: "", active: true }],
    })).data;
    ok("갱신으로 집계", r2.updated === 1 && r2.added === 0, r2);
    ok("PIN 을 안 돌려준다", r2.credentials.length === 0);
    const sec2 = (await secCol.doc(PROBE).get()).data() || {};
    ok("🔴 해시가 그대로다(로그인 유지)", sec2.pinHash === sec1.pinHash);
    ok("이름은 바뀐다", ((await col.doc(PROBE).get()).data() || {}).name === "검사용2");

    console.log("\n[3] PIN 재발급");
    const r3 = (await reissueFn({ companyId: COMPANY, partnerCode: CODE, passengers: [{ empNo: PROBE }] })).data;
    ok("1명 재발급", r3.credentials.length === 1 && /^\d{6}$/.test(r3.credentials[0].pin), r3);
    const sec3 = (await secCol.doc(PROBE).get()).data() || {};
    ok("해시가 바뀐다", sec3.pinHash && sec3.pinHash !== sec1.pinHash);
    ok("명부에는 여전히 해시가 없다", ((await col.doc(PROBE).get()).data() || {}).pinHash === undefined);

    console.log("\n[4] 🔴 인증 — 남의 거래처·잘못된 코드는 막힌다");
    const other = pcSnap.docs.find((d) => d.id !== CODE && d.data().active !== false);
    const denied = async (label, args) => {
      try { await importFn(args); ok(label, false, "통과해 버렸다"); }
      catch (e) { ok(label, /permission-denied|invalid-argument/.test(e.code || ""), e.code); }
    };
    await denied("없는 업체코드는 거부", { companyId: COMPANY, partnerCode: "NO-SUCH-CODE", employees: [{ empNo: PROBE, name: "x" }] });
    await denied("업체코드 없이 호출하면 거부", { companyId: COMPANY, employees: [{ empNo: PROBE, name: "x" }] });
    if (other) {
      const r5 = (await reissueFn({ companyId: COMPANY, partnerCode: other.id, passengers: [{ empNo: PROBE }] })).data;
      ok("남의 거래처 코드로는 이 사람 PIN 을 못 바꾼다",
        r5.credentials.length === 0 && r5.errors.some((e) => e.includes("소속")), r5);
      const sec4 = (await secCol.doc(PROBE).get()).data() || {};
      ok("해시가 안 바뀌었다", sec4.pinHash === sec3.pinHash);
    }
  } finally {
    await cleanup();
    const gone = !(await col.doc(PROBE).get()).exists && !(await secCol.doc(PROBE).get()).exists;
    ok("[정리] 시험용 승객·해시를 지웠다", gone);
  }

  console.log(`\n결과: ${n - fail} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})();
