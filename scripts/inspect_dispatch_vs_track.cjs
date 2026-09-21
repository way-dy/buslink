// 일회성 진단 (읽기 전용) — 오늘 배차 ↔ 실제 궤적 정합 요약(동영 dy001).
//  · 배차는 있는데 궤적이 없는 차량 / 궤적은 있는데 배차가 없는 차량
//  · 특정 정류장 주변을 지난 차량 찾기(--near lat,lng[,반경m][,HH:mm-HH:mm])
// 사용: node scripts/inspect_dispatch_vs_track.cjs 2026-09-21
//       node scripts/inspect_dispatch_vs_track.cjs 2026-09-21 --near 37.638565,127.026028,600,06:40-07:40
const fs = require("fs");
const path = require("path");
const admin = require(path.join(__dirname, "..", "functions", "node_modules", "firebase-admin"));
const kd = path.join(__dirname, "..", "key");
const key = require(path.join(kd, fs.readdirSync(kd).find((f) => f.endsWith(".json"))));
if (key.project_id !== "buslink-prod") process.exit(1);
admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();

const CID = "dy001";
const DATE = process.argv[2];
const kst = (ms) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(11, 16);
const toMs = (v) => (v && v.toMillis ? v.toMillis() : (typeof v === "number" ? v : null));
function hav(a, b, c, d) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (c - a) * rad, dLng = (d - b) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a * rad) * Math.cos(c * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

(async () => {
  const vs = await db.collection("companies").doc(CID).collection("vehicles").get();
  const vmap = {};
  vs.docs.forEach((d) => { vmap[d.id] = { plate: d.data().plateNo, src: d.data().gpsSource, carId: d.data().carId }; });

  const dispSnap = await db.collection("companies").doc(CID).collection("dispatches").doc(DATE).collection("list").get();
  const dispByVeh = {};
  dispSnap.docs.forEach((d) => { const v = d.data(); if (v.vehicleId) (dispByVeh[v.vehicleId] = dispByVeh[v.vehicleId] || []).push(v); });

  const tracks = {};
  for (const id of Object.keys(vmap)) {
    const ps = await db.collection("gpsHistory").doc(CID).collection(id).doc(DATE).collection("points").orderBy("ts", "asc").get();
    if (!ps.empty) tracks[id] = ps.docs.map((p) => ({ lat: p.data().lat, lng: p.data().lng, ms: toMs(p.data().ts) })).filter((p) => p.ms && p.lat);
  }

  const nearArg = process.argv.indexOf("--near");
  if (nearArg > -1) {
    const [lat, lng, rad, win] = process.argv[nearArg + 1].split(",");
    const R = Number(rad || 500);
    let t0 = 0, t1 = 24 * 60;
    if (win) { const [a, b] = win.split("-"); const m = (s) => +s.split(":")[0] * 60 + +s.split(":")[1]; t0 = m(a); t1 = m(b); }
    console.log(`■ ${DATE} · (${lat},${lng}) 반경 ${R}m · ${win || "종일"} 통과 차량`);
    Object.entries(tracks).forEach(([id, pts]) => {
      const hits = pts.filter((p) => {
        const mn = Math.floor(((p.ms + 9 * 3600000) % 86400000) / 60000);
        return mn >= t0 && mn <= t1 && hav(+lat, +lng, p.lat, p.lng) <= R;
      });
      if (hits.length) {
        const d = Math.round(Math.min(...hits.map((h) => hav(+lat, +lng, h.lat, h.lng))));
        console.log(`   ${vmap[id].plate.padEnd(14)} carId=${String(vmap[id].carId).padEnd(5)} ${hits.length}점 최근접 ${d}m @${kst(hits[0].ms)} · 배차=${(dispByVeh[id] || []).map((x) => x.departTime + " " + x.routeName).join(" / ") || "없음"}`);
      }
    });
    process.exit(0);
  }

  console.log(`■ ${DATE} 배차 ${dispSnap.size}건 · 궤적 있는 차량 ${Object.keys(tracks).length}대`);
  console.log("\n▸ 배차 있는데 궤적 없음(단말 미장착·미운행·창 밖)");
  Object.keys(dispByVeh).forEach((id) => {
    if (!tracks[id]) console.log(`   ${(vmap[id] ? vmap[id].plate : id).padEnd(14)} src=${vmap[id] ? vmap[id].src : "?"} · ${dispByVeh[id].map((x) => x.departTime + " " + x.routeName).join(" / ")}`);
  });
  console.log("\n▸ 궤적 있는데 오늘 배차 없음");
  Object.keys(tracks).forEach((id) => {
    if (!dispByVeh[id]) console.log(`   ${vmap[id].plate.padEnd(14)} carId=${vmap[id].carId} ${tracks[id].length}점 ${kst(tracks[id][0].ms)}~${kst(tracks[id][tracks[id].length - 1].ms)}`);
  });
  process.exit(0);
})();
