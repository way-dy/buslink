// 그린 경로(routePath)로 '회전 지점'을 뽑아낼 수 있는지 검증 (읽기 전용) — 2026-07-29.
//   node scripts/inspect_route_turns.cjs [노선명 일부]
//
// 목적: 턴바이턴 안내는 도로 데이터가 있어야 하지만, 관리자가 도로를 따라 찍은 점들의
// **방위 변화**로 "여기서 꺾는다"를 근사할 수 있는지 실측한다. 판단 기준 2가지:
//   ① 점 간격이 충분히 촘촘한가(간격이 크면 회전이 뭉개진다)
//   ② 큰 각도 변화가 실제 교차로 수준으로 떨어지는가(너무 많으면 노이즈)
const fs = require("fs");
const path = require("path");
const admin = require(path.join(__dirname, "..", "functions", "node_modules", "firebase-admin"));

const kd = path.join(__dirname, "..", "key");
const key = require(path.join(kd, fs.readdirSync(kd).find((f) => f.endsWith(".json"))));
if (key.project_id !== "buslink-prod") { console.error("project_id 불일치"); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();

const Q = (process.argv[2] || "").trim();
const R = Math.PI / 180;
const hav = (a, b) => {
  const dLat = (b.lat - a.lat) * R, dLng = (b.lng - a.lng) * R;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * R) * Math.cos(b.lat * R) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(s));
};
const brg = (a, b) => {
  const y = Math.sin((b.lng - a.lng) * R) * Math.cos(b.lat * R);
  const x = Math.cos(a.lat * R) * Math.sin(b.lat * R) - Math.sin(a.lat * R) * Math.cos(b.lat * R) * Math.cos((b.lng - a.lng) * R);
  return (Math.atan2(y, x) / R + 360) % 360;
};
const diff = (a, b) => { let d = ((b - a + 540) % 360) - 180; return d; }; // -180~180, +우회전

// 점 노이즈를 줄이려고 앞뒤 WINDOW 미터 구간의 방위를 비교한다(인접 2점은 흔들린다).
const WINDOW = 60;
function turnsOf(pts) {
  const out = [];
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + hav(pts[i - 1], pts[i]));
  const at = (m) => {
    for (let i = 1; i < cum.length; i++) if (cum[i] >= m) return pts[i];
    return pts[pts.length - 1];
  };
  for (let i = 1; i < pts.length - 1; i++) {
    const d = cum[i];
    if (d - WINDOW < 0 || d + WINDOW > cum[cum.length - 1]) continue;
    const before = brg(at(d - WINDOW), pts[i]);
    const after = brg(pts[i], at(d + WINDOW));
    const t = diff(before, after);
    if (Math.abs(t) >= 45) out.push({ idx: i, at: Math.round(d), deg: Math.round(t) });
  }
  // 연속 검출 병합(같은 회전이 여러 점에 걸쳐 잡힌다)
  const merged = [];
  for (const t of out) {
    const last = merged[merged.length - 1];
    if (last && t.at - last.at < 80 && Math.sign(t.deg) === Math.sign(last.deg)) {
      if (Math.abs(t.deg) > Math.abs(last.deg)) merged[merged.length - 1] = t;
    } else merged.push(t);
  }
  return merged;
}

(async () => {
  const routes = await db.collection("companies").doc("dy001").collection("routes").get();
  const target = routes.docs.filter((r) => {
    const d = r.data();
    return Array.isArray(d.routePath) && d.routePath.length >= 2 && (!Q || (d.name || "").includes(Q));
  });
  if (!target.length) { console.log("대상 노선 없음"); process.exit(0); }

  let totalGapMed = [];
  for (const r of target.slice(0, Q ? 5 : 6)) {
    const d = r.data();
    const pts = d.routePath.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    if (pts.length < 3) continue;
    const gaps = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) { const g = hav(pts[i - 1], pts[i]); gaps.push(g); total += g; }
    gaps.sort((a, b) => a - b);
    const med = gaps[Math.floor(gaps.length / 2)];
    totalGapMed.push(med);
    const t = turnsOf(pts);
    console.log(`\n=== ${d.name} ===`);
    console.log(`  점 ${pts.length}개 · 총 ${(total / 1000).toFixed(1)}km · 점 간격 중앙 ${Math.round(med)}m (최대 ${Math.round(gaps[gaps.length - 1])}m)`);
    console.log(`  45° 이상 꺾임 ${t.length}곳 → 1km 당 ${(t.length / (total / 1000)).toFixed(1)}곳`);
    if (t.length) {
      console.log("  " + t.slice(0, 10).map((x) => `${(x.at / 1000).toFixed(1)}km ${x.deg > 0 ? "우" : "좌"}${Math.abs(x.deg)}°`).join(" · "));
    }
  }
  if (totalGapMed.length) {
    totalGapMed.sort((a, b) => a - b);
    console.log(`\n전체 점 간격 중앙값: ${Math.round(totalGapMed[Math.floor(totalGapMed.length / 2)])}m`);
    console.log("판단: 간격이 30m 이하면 회전 근사 신뢰도 높음 · 100m 이상이면 뭉개짐");
  }
  process.exit(0);
})().catch((e) => { console.error("실패:", e); process.exit(1); });
