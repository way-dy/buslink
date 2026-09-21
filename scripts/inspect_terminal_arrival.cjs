// 일회성 진단 (읽기 전용) — "종점 도착이 표시 창(displayEnd) 보다 늦어 영원히 안 잡히는" 노선 찾기.
// 노선별: displayStart/End · 마지막 정류장 예정시각 · 실제 궤적 마지막 시각 · 종점 최근접거리.
// 사용: node scripts/inspect_terminal_arrival.cjs 2026-09-21
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
const addMin = (hhmm, n) => { const [H, M] = hhmm.split(":").map(Number); const t = H * 60 + M + n; return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`; };

(async () => {
  const vs = await db.collection("companies").doc(CID).collection("vehicles").get();
  const vmap = {};
  vs.docs.forEach((d) => { vmap[d.id] = d.data().plateNo; });
  const dispSnap = await db.collection("companies").doc(CID).collection("dispatches").doc(DATE).collection("list").get();

  console.log(`■ ${DATE} · 오전 배차 종점 도착 점검 (창 밖이면 도착 영구 미기록)`);
  console.log("차량           배차     노선                  표시창        마지막정류장예정  궤적끝   종점최근접  도착기록");
  for (const d of dispSnap.docs) {
    const v = d.data();
    if (!v.vehicleId || !v.routeId) continue;
    if (!/^0[5-9]:/.test(v.departTime || "")) continue; // 오전 출근 회차만
    const ps = await db.collection("gpsHistory").doc(CID).collection(v.vehicleId).doc(DATE).collection("points").orderBy("ts", "asc").get();
    if (ps.empty) continue;
    const pts = ps.docs.map((p) => ({ lat: p.data().lat, lng: p.data().lng, ms: toMs(p.data().ts) })).filter((p) => p.ms && p.lat);
    const r = await db.collection("companies").doc(CID).collection("routes").doc(v.routeId).get();
    const rv = r.data() || {};
    const ss = await db.collection("companies").doc(CID).collection("routes").doc(v.routeId).collection("stops").orderBy("order").get();
    const stops = ss.docs.map((s) => ({ id: s.id, ...s.data() })).filter((s) => typeof s.lat === "number");
    if (!stops.length) continue;
    const last = stops[stops.length - 1];
    let best = Infinity;
    pts.forEach((p) => { const m = hav(last.lat, last.lng, p.lat, p.lng); if (m < best) best = m; });
    const planned = rv.departTime && typeof last.offsetMin === "number" ? addMin(rv.departTime, last.offsetMin) : "--:--";
    const win = `${rv.displayStart || "-"}~${rv.displayEnd || "-"}`;
    const arrived = (v.stopArrivals || {})[last.id];
    const flag = best > 300 ? "🔴" : "  ";
    console.log(`${flag}${String(vmap[v.vehicleId] || "?").padEnd(13)} ${String(v.departTime).padEnd(7)} ${String(v.routeName).slice(0, 20).padEnd(21)} ${win.padEnd(13)} ${String(last.name).slice(0, 8).padEnd(9)}${planned.padEnd(8)} ${kst(pts[pts.length - 1].ms).padEnd(7)} ${String(Math.round(best)).padStart(6)}m  ${arrived ? "✅" : "❌"}`);
  }
  process.exit(0);
})();
