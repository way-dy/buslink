// 읽기 전용 — "같은 차량 출·퇴근 2번째 태깅이 «이미 탑승» 으로 막힌다" 의 폭발 반경을 잰다.
//   node scripts/inspect_boarding_dupe_key.cjs [YYYY-MM-DD]
// 🔴 쓰기 0. boardings/dispatches 를 읽기만 한다.
// 재는 것: ① 오늘 배차가 2건 이상인 차량 ② 그 배차들의 routeId 가 갈라지는지(=routeId 키로 충분한가)
//          ③ 그 차량에 이미 탑승 기록이 있는 사람 수(= 두 번째 태깅에서 막힐 사람 수)
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
const DAY = process.argv[2] || new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());

(async () => {
  console.log("대상일 " + DAY + " · 회사 " + COMPANY);
  console.log("");
  const [ds, bs] = await Promise.all([
    db.collection("companies").doc(COMPANY).collection("dispatches").doc(DAY).collection("list").get(),
    db.collection("companies").doc(COMPANY).collection("boardings").doc(DAY).collection("list").get(),
  ]);
  const disp = ds.docs.map((d) => Object.assign({ id: d.id }, d.data()));
  const board = bs.docs.map((d) => Object.assign({ id: d.id }, d.data()));
  console.log("배차 " + disp.length + "건 · 탑승 " + board.length + "건");

  // ① 차량별 배차
  const byVeh = new Map();
  disp.forEach((d) => {
    const k = d.vehicleId || "(무)";
    if (!byVeh.has(k)) byVeh.set(k, []);
    byVeh.get(k).push(d);
  });
  const multi = [...byVeh.entries()].filter(([, v]) => v.length > 1);
  console.log("차량 " + byVeh.size + "대 중 배차 2건 이상 = " + multi.length + "대");
  console.log("");

  const boardedByVeh = new Map();
  board.forEach((b) => {
    const k = b.vehicleId || "(무)";
    if (!boardedByVeh.has(k)) boardedByVeh.set(k, []);
    boardedByVeh.get(k).push(b);
  });

  // ② routeId 가 갈라지는가
  let sameRoute = 0;
  let diffRoute = 0;
  console.log("── 배차 2건 이상 차량 (차량 / 배차 목록 / 오늘 탑승기록) ──");
  multi.sort((a, b) => b[1].length - a[1].length).forEach(([vid, list]) => {
    const routeIds = new Set(list.map((d) => d.routeId || ""));
    if (routeIds.size === 1) sameRoute++; else diffRoute++;
    const veh = list[0].vehicleNo || vid;
    const b = boardedByVeh.get(vid) || [];
    const mark = routeIds.size === 1 ? "⚠같은노선" : "노선갈림";
    console.log("  " + veh + " [" + vid + "] 배차" + list.length + " " + mark + "(routeId " + routeIds.size + "종) · 탑승 " + b.length + "명");
    list.slice().sort((x, y) => String(x.departTime || "").localeCompare(String(y.departTime || "")))
      .forEach((d) => console.log("      " + String(d.departTime || "--:--") + " " + (d.routeName || "(무명)") + "  route=" + (d.routeId || "(무)") + " disp=" + d.id));
    if (b.length) {
      const byRoute = new Map();
      b.forEach((x) => {
        const n = x.routeName || x.routeId || "(무)";
        byRoute.set(n, (byRoute.get(n) || 0) + 1);
      });
      console.log("      → 적재된 노선: " + [...byRoute.entries()].map(([n, c]) => n + " " + c + "명").join(" · "));
    }
  });
  console.log("");
  console.log("  routeId 가 갈리는 차량 " + diffRoute + "대 · 같은 routeId 로 2회차 이상인 차량 " + sameRoute + "대");

  // ③ 막힐 사람 수
  const blocked = multi.reduce((n, [vid]) => n + (boardedByVeh.get(vid) || []).length, 0);
  console.log("");
  console.log("③ 오늘 «두 번째 태깅이 막히는» 사람 = " + blocked + "명 (배차 2건 이상 차량에 이미 기록된 인원)");

  // 참고: 50001 흔적
  const mine = board.filter((b) => String(b.empNo) === "50001");
  if (mine.length) {
    console.log("");
    console.log("참고 — 50001 기록:");
    mine.forEach((b) => console.log("  docId=" + b.id + " route=" + b.routeName + " veh=" + b.vehicleNo + " via=" + b.via + " at=" + (b.boardedAt && b.boardedAt.toDate ? b.boardedAt.toDate().toISOString() : "?")));
  }
})().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
