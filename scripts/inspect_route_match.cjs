// 일회성 진단 (읽기 전용) — 차량 실 궤적이 배차된 노선 정류장을 얼마나 지나는지 채점.
// 사용: node scripts/inspect_route_match.cjs 2026-09-21 [2026-09-18 ...]
const fs = require("fs");
const path = require("path");
const admin = require(path.join(__dirname, "..", "functions", "node_modules", "firebase-admin"));
const kd = path.join(__dirname, "..", "key");
const key = require(path.join(kd, fs.readdirSync(kd).find((f) => f.endsWith(".json"))));
if (key.project_id !== "buslink-prod") process.exit(1);
admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();

const CID = "dy001";
const kst = (ms) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(11, 16);
const toMs = (v) => (v && v.toMillis ? v.toMillis() : (typeof v === "number" ? v : null));
function hav(a, b, c, d) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (c - a) * rad, dLng = (d - b) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a * rad) * Math.cos(c * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

(async () => {
  const dates = process.argv.slice(2);
  const vs = await db.collection("companies").doc(CID).collection("vehicles").where("gpsSource", "==", "device").get();
  const stopsCache = {};
  const getStops = async (rid) => {
    if (!stopsCache[rid]) {
      const ss = await db.collection("companies").doc(CID).collection("routes").doc(rid).collection("stops").orderBy("order").get();
      stopsCache[rid] = ss.docs.map((s) => ({ id: s.id, ...s.data() })).filter((s) => typeof s.lat === "number");
    }
    return stopsCache[rid];
  };

  for (const DATE of dates) {
    console.log(`\n══════ ${DATE} ══════`);
    const dispSnap = await db.collection("companies").doc(CID).collection("dispatches").doc(DATE).collection("list").get();
    const byVeh = {};
    dispSnap.docs.forEach((d) => { const v = d.data(); if (v.vehicleId) (byVeh[v.vehicleId] = byVeh[v.vehicleId] || []).push(v); });

    for (const vd of vs.docs) {
      const veh = vd.data();
      const ps = await db.collection("gpsHistory").doc(CID).collection(vd.id).doc(DATE).collection("points").orderBy("ts", "asc").get();
      if (ps.empty) continue;
      const pts = ps.docs.map((p) => ({ lat: p.data().lat, lng: p.data().lng, ms: toMs(p.data().ts) })).filter((p) => p.ms);
      const disps = byVeh[vd.id] || [];
      if (!disps.length) { console.log(`\n■ ${veh.plateNo} (carId=${veh.carId}) 궤적 ${pts.length}점 ${kst(pts[0].ms)}~${kst(pts[pts.length - 1].ms)} · 배차 없음`); continue; }
      for (const dv of disps) {
        const stops = await getStops(dv.routeId);
        const near = stops.map((s) => {
          let best = Infinity, bt = null;
          pts.forEach((p) => { const dm = hav(s.lat, s.lng, p.lat, p.lng); if (dm < best) { best = dm; bt = p.ms; } });
          return { name: s.name, m: Math.round(best), t: bt };
        });
        const hit300 = near.filter((n) => n.m <= 300).length;
        const med = near.map((n) => n.m).sort((a, b) => a - b)[Math.floor(near.length / 2)];
        console.log(`\n■ ${veh.plateNo} (carId=${veh.carId}) ${dv.departTime} ${dv.routeName} · 궤적 ${pts.length}점 ${kst(pts[0].ms)}~${kst(pts[pts.length - 1].ms)}`);
        console.log(`   정류장 ${stops.length}개 중 300m 안 통과 ${hit300}개 · 최근접거리 중앙 ${med}m · 기록된 stopArrivals ${Object.keys(dv.stopArrivals || {}).length}건`);
        if (hit300 < stops.length) {
          near.forEach((n) => console.log(`     ${n.m <= 300 ? "✅" : "❌"} ${String(n.name).padEnd(24)} ${String(n.m).padStart(5)}m @${n.t ? kst(n.t) : "-"}`));
        }
      }
    }
  }
  process.exit(0);
})();
