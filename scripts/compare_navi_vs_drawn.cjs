// 카카오 도로 경로 ↔ 관리자가 그린 노선(routePath) 이탈 실측 (읽기 전용) — 2026-07-31.
//   node scripts/compare_navi_vs_drawn.cjs [노선명 일부] [--max N]
//
// 기사 지적 "내가 그려놓은 노선대로 안내를 하는 것 같지 않다"의 근거를 재려는 도구.
// 길안내 탭은 ① 카카오 도로 경로 ② 그린 경로 순으로 채택하는데, ①은 정류장만 경유지로
// 주고 그 사이 도로는 카카오가 고른다 → 회사가 실제로 다니는 길과 다를 수 있다.
// 그린 경로의 각 점이 카카오 경로에서 얼마나 떨어졌는지(수직거리)로 그 차이를 잰다.
//
// **응답은 저장하지 않는다**(카카오 운영정책). 키는 file/20260729/restkey.txt(gitignore).
const fs = require("fs");
const path = require("path");
const https = require("https");
const admin = require(path.join(__dirname, "..", "functions", "node_modules", "firebase-admin"));

const keyFile = path.join(__dirname, "..", "file", "20260729", "restkey.txt");
if (!fs.existsSync(keyFile)) { console.error("❌ REST 키 파일 없음:", keyFile); process.exit(1); }
const REST = fs.readFileSync(keyFile, "utf8").trim();

const saDir = path.join(__dirname, "..", "key");
const k = require(path.join(saDir, fs.readdirSync(saDir).find((f) => f.endsWith(".json"))));
if (k.project_id !== "buslink-prod") { console.error("project_id 불일치"); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(k) });
const db = admin.firestore();

const CID = "dy001";
const args = process.argv.slice(2);
const maxIdx = args.indexOf("--max");
const MAX = maxIdx >= 0 ? Number(args[maxIdx + 1]) || 4 : 4;
const Q = args.filter((a, i) => !a.startsWith("--") && i !== maxIdx + 1).join(" ").trim();

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
/** 점 → 선분 최단거리(m). 로컬 평면 근사(수백 m 규모라 충분). */
function distToSeg(p, a, b) {
  const mLat = 111320, mLng = 111320 * Math.cos(p.lat * R);
  const px = (p.lng - a.lng) * mLng, py = (p.lat - a.lat) * mLat;
  const bx = (b.lng - a.lng) * mLng, by = (b.lat - a.lat) * mLat;
  const len2 = bx * bx + by * by;
  if (len2 === 0) return Math.hypot(px, py);
  let t = (px * bx + py * by) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - bx * t, py - by * t);
}
function distToPath(p, poly) {
  let best = Infinity;
  for (let i = 1; i < poly.length; i++) {
    const d = distToSeg(p, poly[i - 1], poly[i]);
    if (d < best) best = d;
  }
  return best;
}
const pct = (arr, q) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] : 0);

function post(body) {
  return new Promise((res, rej) => {
    const p = JSON.stringify(body);
    const req = https.request({
      hostname: "apis-navi.kakaomobility.com", path: "/v1/waypoints/directions", method: "POST",
      headers: { Authorization: `KakaoAK ${REST}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(p) },
      timeout: 20000,
    }, (r) => {
      let raw = ""; r.setEncoding("utf8");
      r.on("data", (c) => { raw += c; });
      r.on("end", () => res({ status: r.statusCode, body: raw }));
    });
    req.on("timeout", () => req.destroy(new Error("시간 초과")));
    req.on("error", rej);
    req.write(p); req.end();
  });
}

/** 카카오 응답 → {path, guides} */
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
  return { path: pathPts, guides, summary: route.summary };
}

/** 경로 총 길이(m) */
function pathLen(p) {
  let t = 0;
  for (let i = 1; i < p.length; i++) t += hav(p[i - 1], p[i]);
  return t;
}

/** 그린 경로를 균등 간격으로 n 점 추출(경유지 상한 대응). 시작·끝 제외. */
function samplePath(poly, n) {
  if (poly.length <= 2 || n <= 0) return [];
  const cum = [0];
  for (let i = 1; i < poly.length; i++) cum.push(cum[i - 1] + hav(poly[i - 1], poly[i]));
  const total = cum[cum.length - 1];
  const out = [];
  for (let i = 1; i <= n; i++) {
    const targetD = (total * i) / (n + 1);
    let j = 1;
    while (j < cum.length - 1 && cum[j] < targetD) j++;
    out.push(poly[j]);
  }
  return out;
}

(async () => {
  const snap = await db.collection("companies").doc(CID).collection("routes").get();
  let routes = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }))
    .filter((r) => Array.isArray(r.routePath) && r.routePath.length >= 10);
  if (Q) routes = routes.filter((r) => String(r.name || "").includes(Q));
  routes.sort((a, b) => (b.routePath.length || 0) - (a.routePath.length || 0));
  routes = routes.slice(0, MAX);
  if (!routes.length) { console.error("경로가 그려진 노선을 못 찾음"); process.exit(1); }

  console.log(`대상 노선 ${routes.length}개 (그린 경로 10점 이상)\n`);

  for (const r of routes) {
    const st = await db.collection("companies").doc(CID).collection("routes").doc(r.id).collection("stops").orderBy("order").get();
    const stops = [];
    st.docs.forEach((d) => { const p = ll(d.data() || {}); if (p) stops.push({ name: (d.data() || {}).name || "", x: p.lng, y: p.lat }); });
    const drawn = r.routePath.map(ll).filter(Boolean);
    console.log("═".repeat(72));
    console.log(`▶ ${r.name}  (정류장 ${stops.length} · 그린 경로 ${drawn.length}점 · ${(pathLen(drawn) / 1000).toFixed(1)}km)`);
    if (stops.length < 2 || drawn.length < 2) { console.log("  건너뜀(데이터 부족)\n"); continue; }

    // ① 현행: 정류장만 경유지
    const rA = await post({
      origin: stops[0], destination: stops[stops.length - 1], waypoints: stops.slice(1, -1),
      priority: "RECOMMEND", car_fuel: "DIESEL", summary: false,
    });
    if (rA.status !== 200) { console.log(`  ① HTTP ${rA.status} ${rA.body.slice(0, 120)}\n`); continue; }
    const A = parseRoute(JSON.parse(rA.body));
    if (!A) { console.log("  ① 경로 탐색 실패\n"); continue; }

    const devA = drawn.map((p) => distToPath(p, A.path)).sort((a, b) => a - b);
    console.log(`  ① 정류장만 경유지(현행)  도로 ${A.path.length}점 · ${(pathLen(A.path) / 1000).toFixed(1)}km · 회전안내 ${A.guides.length}개`);
    console.log(`     그린 경로와의 이탈: 중앙 ${Math.round(pct(devA, 0.5))}m · 상위10% ${Math.round(pct(devA, 0.9))}m · 최대 ${Math.round(devA[devA.length - 1])}m`);
    const offA = devA.filter((d) => d > 300).length;
    console.log(`     300m 초과 이탈 점 ${offA}/${devA.length} (${Math.round((offA / devA.length) * 100)}%)`);

    // ② 대안: 그린 경로를 경유지로 넣어 도로에 붙이기(정류장 포함 상한 30)
    const room = Math.max(0, 30 - Math.max(0, stops.length - 2));
    const extra = samplePath(drawn, Math.min(room, 24));
    if (extra.length >= 3) {
      // 정류장 + 그린 경로 표본을 진행 순서대로 섞는다(그린 경로 진행 방향 기준).
      const cumD = [0];
      for (let i = 1; i < drawn.length; i++) cumD.push(cumD[i - 1] + hav(drawn[i - 1], drawn[i]));
      const progOf = (pt) => {
        let best = Infinity, bp = 0;
        for (let i = 1; i < drawn.length; i++) {
          const d = distToSeg(pt, drawn[i - 1], drawn[i]);
          if (d < best) { best = d; bp = cumD[i - 1]; }
        }
        return bp;
      };
      const mid = [...stops.slice(1, -1), ...extra.map((p) => ({ name: "", x: p.lng, y: p.lat }))]
        .map((p) => ({ p, prog: progOf({ lat: p.y, lng: p.x }) }))
        .sort((a, b) => a.prog - b.prog).map((o) => o.p).slice(0, 30);
      const rB = await post({
        origin: stops[0], destination: stops[stops.length - 1], waypoints: mid,
        priority: "RECOMMEND", car_fuel: "DIESEL", summary: false,
      });
      if (rB.status === 200) {
        const B = parseRoute(JSON.parse(rB.body));
        if (B) {
          const devB = drawn.map((p) => distToPath(p, B.path)).sort((a, b) => a - b);
          const offB = devB.filter((d) => d > 300).length;
          console.log(`  ② 그린 경로도 경유지(대안·경유 ${mid.length})  도로 ${B.path.length}점 · ${(pathLen(B.path) / 1000).toFixed(1)}km · 회전안내 ${B.guides.length}개`);
          console.log(`     그린 경로와의 이탈: 중앙 ${Math.round(pct(devB, 0.5))}m · 상위10% ${Math.round(pct(devB, 0.9))}m · 최대 ${Math.round(devB[devB.length - 1])}m`);
          console.log(`     300m 초과 이탈 점 ${offB}/${devB.length} (${Math.round((offB / devB.length) * 100)}%)`);
        } else console.log("  ② 경로 탐색 실패");
      } else console.log(`  ② HTTP ${rB.status} ${rB.body.slice(0, 120)}`);
    } else {
      console.log("  ② 건너뜀(경유지 여유 없음)");
    }
    console.log("");
  }
  console.log("※ 카카오 응답은 저장하지 않았다(운영정책상 DB 저장 금지).");
  process.exit(0);
})().catch((e) => { console.error("실패:", e); process.exit(1); });
