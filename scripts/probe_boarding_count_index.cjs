// 읽기 전용 — boardings 집계를 「차량+노선」 2중 동등 필터로 바꿔도 복합 인덱스 없이 도는지 잰다.
//   node scripts/probe_boarding_count_index.cjs
// 🔴 쓰기 0. count() 집계만 날린다. 실패하면 그 에러(FAILED_PRECONDITION=인덱스 필요)를 그대로 보여준다.
const path = require("path");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
const sa = require(path.join(ROOT, "key", kf));
if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치");
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const COMPANY = "dy001";
const DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
// 실측으로 고른 표본 — 임시2875053(오전 06:30 김포 22명 / 저녁 18:00 김포 1명)
const VEHICLE = "CBYpwLwCiTEIZrwyA0VC";
const ROUTE_AM = "iLC7WegARJTFlPSEgjgb";
const ROUTE_PM = "m5o0GurPoMX5hjgXIkeB";

(async () => {
  const col = db.collection("companies").doc(COMPANY).collection("boardings").doc(DAY).collection("list");
  const show = async (label, q) => {
    try {
      const agg = await q.count().get();
      console.log("  OK   " + label + " = " + agg.data().count + "명");
    } catch (e) {
      console.log("  FAIL " + label + " → " + (e.code || "") + " " + (e.message || "").split("\n")[0]);
    }
  };
  console.log("대상일 " + DAY + " · 차량 임시2875053");
  await show("차량만(현행)          ", col.where("vehicleId", "==", VEHICLE));
  await show("차량+노선 06:30 김포  ", col.where("vehicleId", "==", VEHICLE).where("routeId", "==", ROUTE_AM));
  await show("차량+노선 18:00 김포  ", col.where("vehicleId", "==", VEHICLE).where("routeId", "==", ROUTE_PM));
})().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
