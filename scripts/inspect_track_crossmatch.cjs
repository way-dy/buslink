// 일회성 진단 (읽기 전용) — "배차된 차량이 그 노선을 안 지난다" 교차 대조.
//  ① 지정 노선의 정류장을 가장 잘 지난 차량은 누구인가
//  ② 지정 차량의 궤적과 가장 잘 맞는 노선은 무엇인가
// 사용: node scripts/inspect_track_crossmatch.cjs 2026-09-21 <routeId> <plate검색어>
const fs = require("fs");
const path = require("path");
const admin = require(path.join(__dirname, "..", "functions", "node_modules", "firebase-admin"));
const kd = path.join(__dirname, "..", "key");
const key = require(path.join(kd, fs.readdirSync(kd).find((f) => f.endsWith(".json"))));
if (key.project_id !== "buslink-prod") process.exit(1);
admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();

const CID = "dy001";
const [DATE, ROUTE_ID, PLATE_Q] = process.argv.slice(2);
const kst = (ms) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(11, 16);
const toMs = (v) => (v && v.toMillis ? v.toMillis() : (typeof v === "number" ? v : null));
function hav(a, b, c, d) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (c - a) * rad, dLng = (d - b) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a * rad) * Math.cos(c * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const score = (stops, pts) => {
  const near = stops.map((s) => {
    let best = Infinity, bt = null;
    pts.forEach((p) => { const dm = hav(s.lat, s.lng, p.lat, p.lng); if (dm < best) { best = dm; bt = p.ms; } });
    return { name: s.name, m: Math.round(best), t: bt };
  });
  const sorted = near.map((n) => n.m).sort((a, b) => a - b);
  return { near, hit: near.filter((n) => n.m <= 300).length, med: sorted[Math.floor(sorted.length / 2)] };
};

(async () => {
  const vs = await db.collection("companies").doc(CID).collection("vehicles").get();
  const tracks = [];
  for (const vd of vs.docs) {
    const ps = await db.collection("gpsHistory").doc(CID).collection(vd.id).doc(DATE).collection("points").orderBy("ts", "asc").get();
    if (ps.empty) continue;
    const pts = ps.docs.map((p) => ({ lat: p.data().lat, lng: p.data().lng, ms: toMs(p.data().ts) })).filter((p) => p.ms && p.lat);
    if (pts.length) tracks.push({ id: vd.id, plate: vd.data().plateNo, carId: vd.data().carId, pts });
  }
  console.log(`궤적 있는 차량 ${tracks.length}대 (${DATE})`);

  const loadStops = async (rid) => {
    const ss = await db.collection("companies").doc(CID).collection("routes").doc(rid).collection("stops").orderBy("order").get();
    return ss.docs.map((s) => ({ id: s.id, ...s.data() })).filter((s) => typeof s.lat === "number");
  };

  if (ROUTE_ID) {
    const stops = await loadStops(ROUTE_ID);
    const r = await db.collection("companies").doc(CID).collection("routes").doc(ROUTE_ID).get();
    console.log(`\n■ ① 노선 "${(r.data() || {}).name}" (정류장 ${stops.length}개) 를 실제로 지난 차량 랭킹`);
    tracks.map((t) => ({ t, s: score(stops, t.pts) }))
      .sort((a, b) => b.s.hit - a.s.hit || a.s.med - b.s.med)
      .slice(0, 6)
      .forEach(({ t, s }) => console.log(`   ${String(s.hit).padStart(2)}/${stops.length} 통과 · 중앙 ${String(s.med).padStart(5)}m · ${t.plate}(carId=${t.carId}) ${kst(t.pts[0].ms)}~${kst(t.pts[t.pts.length - 1].ms)}`));
  }

  if (PLATE_Q) {
    const me = tracks.find((t) => (t.plate || "").includes(PLATE_Q));
    if (!me) { console.log("차량 궤적 없음"); process.exit(0); }
    const rs = await db.collection("companies").doc(CID).collection("routes").get();
    console.log(`\n■ ② ${me.plate} 궤적(${me.pts.length}점 ${kst(me.pts[0].ms)}~${kst(me.pts[me.pts.length - 1].ms)}) 과 가장 잘 맞는 노선 랭킹 (전 노선 ${rs.size}개)`);
    const out = [];
    for (const rd of rs.docs) {
      const stops = await loadStops(rd.id);
      if (stops.length < 3) continue;
      const s = score(stops, me.pts);
      out.push({ name: (rd.data() || {}).name, id: rd.id, n: stops.length, s });
    }
    out.sort((a, b) => (b.s.hit / b.n) - (a.s.hit / a.n) || a.s.med - b.s.med)
      .slice(0, 8)
      .forEach((o) => console.log(`   ${String(o.s.hit).padStart(2)}/${o.n} 통과 · 중앙 ${String(o.s.med).padStart(5)}m · ${o.name} (${o.id})`));
    const top = out[0];
    if (top) {
      console.log(`\n   ▸ 1위 "${top.name}" 정류장별 최근접`);
      score(await loadStops(top.id), me.pts).near.forEach((n) =>
        console.log(`     ${n.m <= 300 ? "✅" : "❌"} ${String(n.name).padEnd(28)} ${String(n.m).padStart(5)}m @${n.t ? kst(n.t) : "-"}`));
    }
  }
  process.exit(0);
})();
