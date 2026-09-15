// 삼성전자 샘플 거래처에 딸린 데이터 전수 조사 — 읽기 전용(쓰기 0).
//   node scripts/inspect_sample_partner_leftovers.cjs
// seed_sample_partner.cjs --remove 는 «시드가 만든 것»만 지운다. 그 뒤에 생긴 것
// (PIN 해시 분리 백필·로그인 승계표·푸시 토큰·배차·탑승)이 남는지 먼저 센다.
const path = require("path");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
const sa = require(path.join(ROOT, "key", kf));
if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치");
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const CID = "dy001";
const CODE = "DY001-삼성전자샘플-2026-SMPL";
const ROUTE_IDS = ["sample-sec-01", "sample-sec-02", "sample-sec-03"];

(async () => {
  const co = db.collection("companies").doc(CID);
  const line = (k, v) => console.log(`  ${k.padEnd(34)} ${v}`);

  const pc = await db.collection("partnerCodes").doc(CODE).get();
  line("partnerCodes 문서", pc.exists ? "있음" : "없음");

  const pass = await co.collection("passengers").where("partnerCode", "==", CODE).get();
  const emps = pass.docs.map((d) => d.id);
  line("이 거래처 승객", `${pass.size}명 ${emps.join(",")}`);

  for (const e of emps) {
    line(`  passengerSecrets/${e}`, (await co.collection("passengerSecrets").doc(e).get()).exists ? "있음" : "없음");
    line(`  fcmTokens/${e}`, (await co.collection("fcmTokens").doc(e).get()).exists ? "있음" : "없음");
  }
  const sess = await co.collection("passengerSessions").get();
  const mySess = sess.docs.filter((d) => emps.includes((d.data() || {}).empNo));
  line("passengerSessions(이 승객)", `${mySess.length}건`);

  line("partnerSecrets", (await co.collection("partnerSecrets").doc(CODE).get()).exists ? "있음" : "없음");
  const psess = await co.collection("partnerSessions").where("partnerCode", "==", CODE).get();
  line("partnerSessions", `${psess.size}건`);

  for (const r of ROUTE_IDS) {
    const doc = await co.collection("routes").doc(r).get();
    const stops = doc.exists ? (await doc.ref.collection("stops").get()).size : 0;
    line(`routes/${r}`, doc.exists ? `있음 · 정류장 ${stops}` : "없음");
  }
  const otherRoutes = await co.collection("routes").where("partnerCode", "==", CODE).get();
  line("partnerCode 로 걸린 노선(전체)", `${otherRoutes.size}개 ${otherRoutes.docs.map((d) => d.id).join(",")}`);

  const sched = await co.collection("dispatchSchedules").where("routeId", "in", ROUTE_IDS).get();
  line("배차 일정(샘플 노선)", `${sched.size}건`);

  const disp = await db.collectionGroup("list").where("routeId", "in", ROUTE_IDS).get().catch((e) => ({ size: "조회불가 " + e.code, docs: [] }));
  line("배차·탑승 list 문서(샘플 노선)", `${disp.size}건 ${[...new Set((disp.docs || []).map((d) => d.ref.parent.parent.parent.id))].join(",")}`);

  const notices = await co.collection("notices").where("partnerCode", "==", CODE).get();
  line("공지(partnerCode)", `${notices.size}건 ${notices.docs.map((d) => d.id).join(",")}`);

  const users = await db.collection("users").where("allowedPartnerCodes", "array-contains", CODE).get();
  line("관리자 권한에 이 코드", `${users.size}명`);

  process.exit(0);
})();
