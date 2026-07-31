// 경유지 전략 실험 (읽기 전용) — 2026-07-31.
//   node scripts/tune_navi_waypoints.cjs [노선명 일부]
//
// compare_navi_vs_drawn 결과: 정류장만 경유지로 주면 그린 경로에서 21~25% 이탈(최대 4.9km),
// 그린 경로를 통째로 경유지로 넣으면 이탈은 0 이지만 총 거리가 2배로 부푼다(U턴).
// → **이탈이 큰 구간에만** 경유지를 꽂는 적응형이 맞는지 잰다.
//
// 판정 기준 2축(둘 다 봐야 한다):
//   ⓐ 이탈  = 그린 경로 점이 도로 경로에서 떨어진 거리(작아야 "그 길로 간다")
//   ⓑ 거리비 = 도로 경로 총 길이 / 그린 경로 총 길이(1.0 근처여야 U턴이 없다)
const fs = require("fs");
const path = require("path");
const https = require("https");
const admin = require(path.join(__dirname, "..", "functions", "node_modules", "firebase-admin"));

const REST = fs.readFileSync(path.join(__dirname, "..", "file", "20260729", "restkey.txt"), "utf8").trim();
const saDir = path.join(__dirname, "..", "key");
const k = require(path.join(saDir, fs.readdirSync(saDir).find((f) => f.endsWith(".json"))));
admin.initializeApp({ credential: admin.credential.cert(k) });
const db = admin.firestore();
const CID = "dy001";
const Q = process.argv.slice(2).join(" ").trim();

const R = Math.PI / 180;
const hav = (a, b) => {
  const dLat = (b.lat - a.lat) * R, dLng = (b.lng - a.lng) * R;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * R) * Math.cos(b.lat * R) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(s));
};
function ll(v) {
  if (!v) return null;
  const la = Number(v.lat ?? v.latitude ?? v.location?.latitude);
  const lo = Number(v.lng ?? v.longitude ?? v.location?.longitude);
  return Number.isFinite(la) && Number.isFinite(lo) && la && lo ? { lat: la, lng: lo } : null;
}
function distToSeg(p, a, b) {
  const mLat = 111320, mLng = 111320 * Math.cos(p.lat * R);
  const px = (p.lng - a.lng) * mLng, py = (p.lat - a.lat) * mLat;
  const bx = (b.lng - a.lng) * mLng, by = (b.lat - a.lat) * mLat;
  const len2 = bx * bx + by * by;
  if (len2 === 0) return Math.hypot(px, py);
  let t = Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  return Math.hypot(px - bx * t, py - by * t);
}
const distToPath = (p, poly) => {
  let best = Infinity;
  for (let i = 1; i < poly.length; i++) { const d = distToSeg(p, poly[i - 1], poly[i]); if (d < best) best = d; }
  return best;
};
const pct = (a, q) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * q))] : 0);
const pathLen = (p) => { let t = 0; for (let i = 1; i < p.length; i++) t += hav(p[i - 1], p[i]); return t; };

function post(body) {
  return new Promise((res, rej) => {
    const p = JSON.stringify(body);
    const req = https.request({
      hostname: "apis-navi.kakaomobility.com", path: "/v1/waypoints/directions", method: "POST",
      headers: { Authorization: `KakaoAK ${REST}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(p) },
      timeout: 20000,
    }, (r) => { let raw = ""; r.setEncoding("utf8"); r.on("data", (c) => { raw += c; }); r.on("end", () => res({ status: r.statusCode, body: raw })); });
    req.on("timeout", () => req.destroy(new Error("시간 초과")));
    req.on("error", rej); req.write(p); req.end();
  });
}
function parseRoute(json) {
  const route = (json.routes || [])[0];
  if (!route || route.result_code !== 0) return null;
  const pathPts = [], guides = [];
  (route.sections || []).forEach((s) => {
    (s.roads || []).forEach((rd) => {
      const v = rd.vertexes || [];
      for (let i = 0; i + 1 < v.length; i += 2) pathPts.push({ lat: Number(v[i + 1]), lng: Number(v[i]) });
    });
    (s.guides || []).forEach((g) => { if (g.type !== 100 && g.type !== 1000) guides.push(g); });
  });
  return { path: pathPts, guides };
}

/** 그린 경로 누적거리 */
function cumOf(poly) {
  const c = [0];
  for (let i = 1; i < poly.length; i++) c.push(c[i - 1] + hav(poly[i - 1], poly[i]));
  return c;
}

/**
 * 적응형 경유지: 그린 경로 점 중 현재 도로 경로에서 threshold 이상 벗어난 구간을 찾아
 * 각 구간의 **가장 많이 벗어난 점 1개**만 경유지로 추가한다.
 * (구간마다 여러 점을 넣으면 도로 스냅 U턴이 생겨 거리가 부푼다 — 실측)
 */
function adaptiveWaypoints(drawn, roadPath, threshold, limit) {
  const dev = drawn.map((p) => distToPath(p, roadPath));
  const runs = [];
  let cur = null;
  for (let i = 0; i < dev.length; i++) {
    if (dev[i] > threshold) {
      if (!cur) cur = { s: i, e: i, bi: i, bd: dev[i] };
      else { cur.e = i; if (dev[i] > cur.bd) { cur.bd = dev[i]; cur.bi = i; } }
    } else if (cur) { runs.push(cur); cur = null; }
  }
  if (cur) runs.push(cur);
  runs.sort((a, b) => b.bd - a.bd);
  return runs.slice(0, limit).map((r) => ({ idx: r.bi, pt: drawn[r.bi], dev: r.bd, span: r.e - r.s + 1 }));
}

async function evalPlan(label, stops, mid, drawn, drawnLen) {
  const r = await post({
    origin: stops[0], destination: stops[stops.length - 1], waypoints: mid,
    priority: "RECOMMEND", car_fuel: "DIESEL", summary: false,
  });
  if (r.status !== 200) { console.log(`  ${label}: HTTP ${r.status}`); return null; }
  const P = parseRoute(JSON.parse(r.body));
  if (!P) { console.log(`  ${label}: 탐색 실패`); return null; }
  const dev = drawn.map((p) => distToPath(p, P.path)).sort((a, b) => a - b);
  const off = dev.filter((d) => d > 300).length;
  const len = pathLen(P.path);
  console.log(`  ${label.padEnd(26)} 이탈 중앙 ${String(Math.round(pct(dev, 0.5))).padStart(4)}m · p90 ${String(Math.round(pct(dev, 0.9))).padStart(5)}m · 최대 ${String(Math.round(dev[dev.length - 1])).padStart(5)}m · 300m초과 ${String(Math.round((off / dev.length) * 100)).padStart(3)}% · 거리비 ${(len / drawnLen).toFixed(2)} · 안내 ${P.guides.length}`);
  return P;
}

(async () => {
  const snap = await db.collection("companies").doc(CID).collection("routes").get();
  let routes = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }))
    .filter((r) => Array.isArray(r.routePath) && r.routePath.length >= 10);
  if (Q) routes = routes.filter((r) => String(r.name || "").includes(Q));
  // 서로 다른 노선 형태를 보려고 길이 상·중·하에서 하나씩.
  routes.sort((a, b) => b.routePath.length - a.routePath.length);
  const uniq = [];
  const seen = new Set();
  for (const r of routes) {
    const key = r.routePath.length;
    if (seen.has(key)) continue;
    seen.add(key); uniq.push(r);
  }
  const pick = Q ? uniq.slice(0, 3) : [uniq[0], uniq[Math.floor(uniq.length / 2)], uniq[uniq.length - 1]].filter(Boolean);

  for (const r of pick) {
    const st = await db.collection("companies").doc(CID).collection("routes").doc(r.id).collection("stops").orderBy("order").get();
    const stops = [];
    st.docs.forEach((d) => { const p = ll(d.data() || {}); if (p) stops.push({ name: (d.data() || {}).name || "", x: p.lng, y: p.lat }); });
    const drawn = r.routePath.map(ll).filter(Boolean);
    if (stops.length < 2 || drawn.length < 2) continue;
    const drawnLen = pathLen(drawn);
    console.log("═".repeat(100));
    console.log(`▶ ${r.name} · 정류장 ${stops.length} · 그린 ${drawn.length}점 ${(drawnLen / 1000).toFixed(1)}km`);

    const base = await evalPlan("① 정류장만(현행)", stops, stops.slice(1, -1), drawn, drawnLen);
    if (!base) { console.log(""); continue; }

    const room = Math.max(0, 30 - Math.max(0, stops.length - 2));
    const cumD = cumOf(drawn);
    const progOf = (pt) => {
      let best = Infinity, bp = 0;
      for (let i = 1; i < drawn.length; i++) {
        const d = distToSeg(pt, drawn[i - 1], drawn[i]);
        if (d < best) { best = d; bp = cumD[i - 1]; }
      }
      return bp;
    };
    const order = (arr) => arr.map((p) => ({ p, g: progOf({ lat: p.y, lng: p.x }) })).sort((a, b) => a.g - b.g).map((o) => o.p);

    for (const [thr, lim] of [[300, 6], [300, 12], [150, 12], [500, 6]]) {
      const add = adaptiveWaypoints(drawn, base.path, thr, Math.min(lim, room));
      if (!add.length) { console.log(`  ② 적응형 ${thr}m/최대${lim}: 추가 경유지 없음(이미 일치)`); continue; }
      const mid = order([...stops.slice(1, -1), ...add.map((a) => ({ name: "", x: a.pt.lng, y: a.pt.lat }))]).slice(0, 30);
      await evalPlan(`② 적응형 ${thr}m/${add.length}개`, stops, mid, drawn, drawnLen);
    }
    console.log("");
  }
  console.log("※ 카카오 응답은 저장하지 않았다.");
  process.exit(0);
})().catch((e) => { console.error("실패:", e); process.exit(1); });
