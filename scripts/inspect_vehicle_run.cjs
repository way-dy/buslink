// 차량 1대의 하루 운행 실측 덤프 (읽기 전용) — 배차·정류장 예정/실도착·gpsHistory·원천좌표 대조.
// gpsHistory 적재 · 배차 stopArrivals · 노선 stops(offsetMin/좌표) · 회사 설정을 덤프하고,
// busin 원천 좌표(엑셀)와 대조해 "어느 정류장이 왜 안 잡혔나" 를 계산한다.
// 사용: node scripts/inspect_vehicle_run.cjs 2026-09-21 6626 [원천좌표.json]
const fs = require("fs");
const path = require("path");
const admin = require(path.join(__dirname, "..", "functions", "node_modules", "firebase-admin"));

const kd = path.join(__dirname, "..", "key");
const kf = fs.readdirSync(kd).find((f) => f.endsWith(".json"));
const key = require(path.join(kd, kf));
if (key.project_id !== "buslink-prod") { console.error("project mismatch"); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();

const CID = "dy001";
const DATE = process.argv[2];
const PLATE = process.argv[3] || "6626";

const kst = (ms) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(11, 19);
const toMs = (v) => (v && v.toMillis ? v.toMillis() : (typeof v === "number" ? v : (v ? new Date(v).getTime() : null)));

function haversine(a, b, c, d) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (c - a) * rad, dLng = (d - b) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a * rad) * Math.cos(c * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

(async () => {
  const comp = await db.collection("companies").doc(CID).get();
  const cv = comp.data() || {};
  console.log("■ 회사 설정 stopArriveRadiusM=", cv.stopArriveRadiusM, "gpsWindowPreMin=", cv.gpsWindowPreMin, "gpsWindowPostMin=", cv.gpsWindowPostMin);

  const vs = await db.collection("companies").doc(CID).collection("vehicles").get();
  const veh = vs.docs.find((d) => (d.data().plateNo || "").includes(PLATE));
  console.log("\n■ 차량", veh.id, veh.data().plateNo, "gpsSource=", veh.data().gpsSource, "carId=", veh.data().carId);

  const dispSnap = await db.collection("companies").doc(CID).collection("dispatches").doc(DATE).collection("list").get();
  const mine = dispSnap.docs.filter((d) => d.data().vehicleId === veh.id);
  console.log(`\n■ ${DATE} 배차 전체 ${dispSnap.size}건 · 이 차량 ${mine.length}건`);

  const stopsCache = {};
  for (const d of mine) {
    const v = d.data();
    console.log(`\n - 배차 ${d.id}`);
    console.log(`   depart=${v.departTime} route=${v.routeName}(${v.routeId}) driver=${v.driverName}(${v.driverId}) status=${v.status || "-"}`);
    console.log(`   startedAt=${toMs(v.startedAt) ? kst(toMs(v.startedAt)) : "-"} endedAt=${toMs(v.endedAt) ? kst(toMs(v.endedAt)) : "-"} 기타키=${Object.keys(v).join(",")}`);
    const sa = v.stopArrivals || {};
    console.log(`   stopArrivals ${Object.keys(sa).length}건`);
    Object.keys(sa).forEach((k) => {
      const a = sa[k] || {};
      console.log(`     ${k} actualAt=${toMs(a.actualAt) ? kst(toMs(a.actualAt)) : "-"} delaySec=${a.delaySec} est=${!!a.estimated} src=${a.source || "-"}`);
    });

    const rid = v.routeId;
    if (rid && !stopsCache[rid]) {
      const r = await db.collection("companies").doc(CID).collection("routes").doc(rid).get();
      const rv = r.data() || {};
      console.log(`   ▸ 노선 name=${rv.name} departTime=${rv.departTime} displayStart=${rv.displayStart || "-"} displayEnd=${rv.displayEnd || "-"} routePath=${Array.isArray(rv.routePath) ? rv.routePath.length + "점" : "없음"} partnerCode=${rv.partnerCode}`);
      const ss = await db.collection("companies").doc(CID).collection("routes").doc(rid).collection("stops").orderBy("order").get();
      stopsCache[rid] = ss.docs.map((s) => ({ id: s.id, ...s.data() }));
      stopsCache[rid].forEach((s) => {
        const planned = rv.departTime && typeof s.offsetMin === "number"
          ? (() => { const [H, M] = rv.departTime.split(":").map(Number); const t = H * 60 + M + s.offsetMin; return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`; })()
          : "--:--";
        console.log(`     #${s.order} ${String(s.name).padEnd(24)} off=${String(s.offsetMin).padStart(3)} 예정=${planned} ${s.lat},${s.lng} ${sa[s.id] ? "✅잡힘" : "❌미통과"} id=${s.id}`);
      });
    }
  }

  const ps = await db.collection("gpsHistory").doc(CID).collection(veh.id).doc(DATE).collection("points").orderBy("ts", "asc").get();
  console.log(`\n■ gpsHistory 적재 ${ps.size}건`);
  const pts = ps.docs.map((p) => ({ ...p.data(), ms: toMs(p.data().ts) }));
  let prev = null;
  pts.forEach((v, i) => {
    const gap = prev == null ? 0 : Math.round((v.ms - prev) / 1000);
    prev = v.ms;
    if (gap > 240 || i === 0 || i === pts.length - 1) console.log(`  ${String(i + 1).padStart(3)} ${kst(v.ms)} gap=${String(gap).padStart(5)}s ${v.lat},${v.lng} src=${v.source || "-"} route=${v.routeId || "(없음)"}`);
  });
  if (pts.length) console.log(`  범위 ${kst(pts[0].ms)} ~ ${kst(pts[pts.length - 1].ms)} · routeId 있는 점 ${pts.filter((p) => p.routeId).length}개`);

  // ── busin 원천(엑셀) 과 대조: 각 정류장 최근접 거리/시각 ──
  const src = process.argv[4];
  if (src && fs.existsSync(src)) {
    const track = JSON.parse(fs.readFileSync(src, "utf8"));
    for (const rid of Object.keys(stopsCache)) {
      console.log(`\n■ 원천좌표 대조 (노선 ${rid}) — 반경 ${cv.stopArriveRadiusM || 100}m 기준`);
      for (const s of stopsCache[rid]) {
        if (typeof s.lat !== "number" || typeof s.lng !== "number") { console.log(`  #${s.order} ${s.name} 좌표없음`); continue; }
        let best = null;
        track.forEach((p) => {
          const dm = haversine(s.lat, s.lng, p.lat, p.lng);
          if (!best || dm < best.dm) best = { dm, t: p.t };
        });
        const R = cv.stopArriveRadiusM || 100;
        console.log(`  #${String(s.order).padStart(2)} ${String(s.name).padEnd(24)} 최근접 ${String(Math.round(best.dm)).padStart(5)}m @${best.t} ${best.dm <= R ? "→ 반경안" : "→ 반경밖"}`);
      }
    }
  }
  process.exit(0);
})();
