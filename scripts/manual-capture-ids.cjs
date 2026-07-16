// 매뉴얼 스크린샷 캡처용 ID 조회 (읽기 전용) — 사용자 직접 실행용.
// 출력: ① 활성 업체코드 1개(승객 있는 것 우선) ② 정류장 있는 노선 ID 1개.
// 사용: cd app/buslink && node scripts/manual-capture-ids.cjs
const fs = require("fs");
const path = require("path");

const keyDir = path.join(__dirname, "..", "key");
const keyFile = fs.readdirSync(keyDir).find(f => f.endsWith(".json"));
if (!keyFile) { console.error("key/*.json 서비스 계정 키가 없습니다"); process.exit(1); }
const sa = require(path.join(keyDir, keyFile));
if (sa.project_id !== "buslink-prod") { console.error(`project_id 불일치: ${sa.project_id}`); process.exit(1); }

const admin = require(path.join(__dirname, "..", "functions", "node_modules", "firebase-admin"));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

(async () => {
  const codes = await db.collection("partnerCodes")
    .where("companyId", "==", "dy001").where("active", "==", true).get();
  let picked = null;
  for (const d of codes.docs) {
    const code = d.data().code || d.id;
    const pass = await db.collection("companies").doc("dy001").collection("passengers")
      .where("partnerCode", "==", code).where("active", "==", true).limit(1).get();
    if (!pass.empty) { picked = { code, name: d.data().partnerName }; break; }
    if (!picked) picked = { code, name: d.data().partnerName };
  }
  console.log("업체코드:", picked ? `${picked.code} (${picked.name})` : "없음");

  const routes = await db.collection("companies").doc("dy001").collection("routes").limit(20).get();
  for (const r of routes.docs) {
    const stops = await r.ref.collection("stops").limit(1).get();
    if (!stops.empty) { console.log("노선ID:", r.id, `(${r.data().name || ""})`); break; }
  }
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
