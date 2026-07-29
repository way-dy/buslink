// 카카오모빌리티 길찾기 실호출 검증 (읽기 전용) — 2026-07-29.
//   node scripts/verify_kakao_navi.cjs [노선명 일부]
//
// 키가 실제로 통하는지 · 응답에 도로 좌표와 회전 안내가 오는지 · 손으로 그린 경로보다
// 얼마나 촘촘한지를 실노선 정류장으로 확인한다. **결과는 저장하지 않는다**(카카오 정책).
//
// 키는 file/20260729/restkey.txt(=Functions 시크릿과 같은 값). file/ 은 gitignore 됨.
const fs = require("fs");
const path = require("path");
const https = require("https");
const admin = require(path.join(__dirname, "..", "functions", "node_modules", "firebase-admin"));

const keyFile = path.join(__dirname, "..", "file", "20260729", "restkey.txt");
if (!fs.existsSync(keyFile)) { console.error("❌ REST 키 파일 없음:", keyFile); process.exit(1); }
const REST = fs.readFileSync(keyFile, "utf8").trim();

const sa = path.join(__dirname, "..", "key");
const k = require(path.join(sa, fs.readdirSync(sa).find((f) => f.endsWith(".json"))));
if (k.project_id !== "buslink-prod") { console.error("project_id 불일치"); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(k) });
const db = admin.firestore();

const R = Math.PI / 180;
const hav = (a, b) => {
  const dLat = (b.lat - a.lat) * R, dLng = (b.lng - a.lng) * R;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * R) * Math.cos(b.lat * R) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(s));
};
function ll(v) {
  const la = Number(v.lat ?? v.latitude ?? v.location?.latitude);
  const lo = Number(v.lng ?? v.longitude ?? v.location?.longitude);
  return Number.isFinite(la) && Number.isFinite(lo) && la && lo ? { lat: la, lng: lo } : null;
}
function post(body) {
  return new Promise((res, rej) => {
    const p = JSON.stringify(body);
    const req = https.request({
      hostname: "apis-navi.kakaomobility.com", path: "/v1/waypoints/directions", method: "POST",
      headers: { Authorization: `KakaoAK ${REST}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(p) },
      timeout: 15000,
    }, (r) => {
      let raw = ""; r.setEncoding("utf8");
      r.on("data", (c) => { raw += c; });
      r.on("end", () => res({ status: r.statusCode, body: raw }));
    });
    req.on("error", rej); req.write(p); req.end();
  });
}

(async () => {
  const Q = (process.argv[2] || "과천라인").trim();
  const routes = await db.collection("companies").doc("dy001").collection("routes").get();
  const hit = routes.docs.find((r) => ((r.data().name || "").includes(Q)));
  if (!hit) { console.error(`노선 '${Q}' 없음`); process.exit(1); }
  const rd = hit.data();
  const st = await hit.ref.collection("stops").orderBy("order").get();
  const pts = [];
  st.docs.forEach((d) => { const p = ll(d.data() || {}); if (p) pts.push({ name: (d.data() || {}).name || "", x: p.lng, y: p.lat }); });
  console.log(`\n노선 "${rd.name}" · 정류장 ${pts.length}곳`);
  if (pts.length < 2) { console.error("정류장 부족"); process.exit(1); }

  const t0 = Date.now();
  const r = await post({
    origin: pts[0], destination: pts[pts.length - 1], waypoints: pts.slice(1, -1),
    priority: "RECOMMEND", car_fuel: "DIESEL", summary: false,
  });
  console.log(`HTTP ${r.status} · ${Date.now() - t0}ms`);
  if (r.status !== 200) { console.error("응답 본문:", r.body.slice(0, 400)); process.exit(1); }

  const j = JSON.parse(r.body);
  const route = (j.routes || [])[0];
  console.log(`result_code=${route.result_code} ${route.result_msg || ""}`);
  if (route.result_code !== 0) { console.error("경로 탐색 실패"); process.exit(1); }

  const pathPts = []; const guides = [];
  (route.sections || []).forEach((s) => {
    (s.roads || []).forEach((rd2) => {
      const v = rd2.vertexes || [];
      for (let i = 0; i + 1 < v.length; i += 2) pathPts.push({ lat: Number(v[i + 1]), lng: Number(v[i]) });
    });
    (s.guides || []).forEach((g) => { if (g.type !== 100) guides.push(g); });
  });

  let total = 0; const gaps = [];
  for (let i = 1; i < pathPts.length; i++) { const d = hav(pathPts[i - 1], pathPts[i]); gaps.push(d); total += d; }
  gaps.sort((a, b) => a - b);
  const drawn = Array.isArray(rd.routePath) ? rd.routePath.length : 0;

  console.log(`\n받은 도로 경로  ${pathPts.length}점 · 총 ${(total / 1000).toFixed(1)}km · 점 간격 중앙 ${Math.round(gaps[Math.floor(gaps.length / 2)])}m`);
  console.log(`손으로 그린 경로 ${drawn}점  → ${drawn ? (pathPts.length / drawn).toFixed(1) : "-"}배 촘촘`);
  console.log(`요약: ${(route.summary.distance / 1000).toFixed(1)}km · ${Math.round(route.summary.duration / 60)}분`);
  console.log(`\n회전 안내 ${guides.length}개 — 앞 12개:`);
  guides.slice(0, 12).forEach((g) => {
    console.log(`  ${String(Math.round(g.distance)).padStart(6)}m  ${(g.guidance || "").padEnd(12)} ${g.name || ""}`);
  });
  console.log("\n※ 이 응답은 저장하지 않았다(카카오 운영정책상 DB 저장 금지).");
  process.exit(0);
})().catch((e) => { console.error("실패:", e); process.exit(1); });
