// 일회성 실측 (읽기 전용) — "배차 차량이 노선을 안 지남" 판정 임계값 근거 만들기.
// 각 배차의 오늘 궤적을 그 노선 경로(routePath, 없으면 정류장 폴리라인)에 투영해
// 수직 이탈거리 중앙값·상위값을 잰다. 정상 배차와 이상 배차가 실제로 갈리는지 확인용.
// 사용: node scripts/inspect_offroute_threshold.cjs 2026-09-21
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
const toMs = (v) => (v && v.toMillis ? v.toMillis() : (typeof v === "number" ? v : null));

// src/lib/routeProgress.js 미러 (순수 기하 — 스크립트라 ESM import 대신 복제)
function hav(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function perpDist(p, a, b) {
  const rad = Math.PI / 180, R = 6371000;
  const lat0 = (a.lat + b.lat) / 2 * rad;
  const X = (q) => R * (q.lng * rad) * Math.cos(lat0);
  const Y = (q) => R * (q.lat * rad);
  const ax = X(a), ay = Y(a), bx = X(b), by = Y(b), px = X(p), py = Y(p);
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
const offRoute = (p, poly) => {
  let best = Infinity;
  for (let i = 0; i < poly.length - 1; i++) {
    const d = perpDist(p, poly[i], poly[i + 1]);
    if (d < best) best = d;
  }
  return best;
};
const pct = (arr, q) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; };

(async () => {
  const vs = await db.collection("companies").doc(CID).collection("vehicles").get();
  const vmap = {};
  vs.docs.forEach((d) => { vmap[d.id] = d.data().plateNo; });
  const ds = await db.collection("companies").doc(CID).collection("dispatches").doc(DATE).collection("list").get();

  console.log(`■ ${DATE} · 오전 배차 궤적 ↔ 노선 경로 이탈거리 (수직 투영)`);
  console.log("차량           노선                  경로원본   점수  중앙    75%     최대");
  const rows = [];
  for (const d of ds.docs) {
    const v = d.data();
    if (!/^0[4-9]:/.test(v.departTime || "") || !v.routeId || !v.vehicleId) continue;
    const ps = await db.collection("gpsHistory").doc(CID).collection(v.vehicleId).doc(DATE).collection("points").orderBy("ts", "asc").get();
    if (ps.size < 5) continue;
    const pts = ps.docs.map((p) => ({ lat: p.data().lat, lng: p.data().lng, ms: toMs(p.data().ts) })).filter((p) => p.lat && p.lng);
    const r = await db.collection("companies").doc(CID).collection("routes").doc(v.routeId).get();
    const rv = r.data() || {};
    let poly = Array.isArray(rv.routePath) ? rv.routePath.map((x) => ({ lat: Number(x.lat), lng: Number(x.lng) })).filter((x) => isFinite(x.lat) && isFinite(x.lng)) : [];
    let src = "routePath";
    if (poly.length < 2) {
      const ss = await db.collection("companies").doc(CID).collection("routes").doc(v.routeId).collection("stops").orderBy("order").get();
      poly = ss.docs.map((s) => s.data()).filter((s) => typeof s.lat === "number").map((s) => ({ lat: s.lat, lng: s.lng }));
      src = "정류장선";
    }
    if (poly.length < 2) continue;
    const dist = pts.map((p) => offRoute(p, poly));
    rows.push({
      plate: vmap[v.vehicleId] || "?", route: v.routeName, src, n: pts.length,
      med: Math.round(pct(dist, 0.5)), p75: Math.round(pct(dist, 0.75)), max: Math.round(Math.max(...dist)),
    });
  }
  rows.sort((a, b) => a.med - b.med);
  rows.forEach((o) => console.log(
    `${o.plate.padEnd(14)} ${String(o.route).slice(0, 20).padEnd(21)} ${o.src.padEnd(10)} ${String(o.n).padStart(4)} ${String(o.med).padStart(6)}m ${String(o.p75).padStart(6)}m ${String(o.max).padStart(7)}m`
  ));
  const meds = rows.map((r) => r.med);
  console.log(`\n  정상 구간(중앙값 분포): 최소 ${Math.min(...meds)}m · 중위 ${pct(meds, 0.5)}m · 90% ${pct(meds, 0.9)}m · 최대 ${Math.max(...meds)}m`);
  process.exit(0);
})();
