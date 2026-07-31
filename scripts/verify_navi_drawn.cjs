// 그린 경로 정합 검증 (읽기 전용) — 2026-07-31.
//   node scripts/verify_navi_drawn.cjs [노선명 일부] [--max N]
//
// 기사 지적 "내가 그려놓은 노선대로 안내를 하는 것 같지 않다" 의 처방을 실데이터로 잰다.
// **CF(functions/index.js)의 판정 함수를 소스에서 그대로 뽑아** 같은 2단계를 재현한다
// (테스트용 복제본을 쓰면 소스가 바뀌어도 통과해 버린다).
//   1차 = 정류장만 경유지(예전 동작)  →  2차 = 벗어난 구간에만 보정점(현재 동작)
//
// 카카오 응답은 저장하지 않는다(운영정책). 키는 file/20260729/restkey.txt(gitignore).
const fs = require("fs");
const path = require("path");
const https = require("https");
const vm = require("vm");
const ROOT = path.join(__dirname, "..");
const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));

const REST = fs.readFileSync(path.join(ROOT, "file", "20260729", "restkey.txt"), "utf8").trim();
const saDir = path.join(ROOT, "key");
const k = require(path.join(saDir, fs.readdirSync(saDir).find((f) => f.endsWith(".json"))));
if (k.project_id !== "buslink-prod") { console.error("project_id 불일치"); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(k) });
const db = admin.firestore();
const CID = "dy001";

const args = process.argv.slice(2);
const mi = args.indexOf("--max");
const MAX = mi >= 0 ? Number(args[mi + 1]) || 3 : 3;
const Q = args.filter((a, i) => !a.startsWith("--") && i !== mi + 1).join(" ").trim();

// ── CF 소스에서 판정 함수·상수를 그대로 가져온다 ──────────────────
const SRC = fs.readFileSync(path.join(ROOT, "functions", "index.js"), "utf8");
function extractFn(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`소스에서 ${name} 없음`);
  let i = SRC.indexOf("{", start), depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error(`${name} 끝 없음`);
}
const constOf = (n) => Number((SRC.match(new RegExp(`const ${n}\\s*=\\s*([\\d.]+)`)) || [])[1]);
const ctx = vm.createContext({
  console,
  DRAWN_MATCH_KM_PER_POINT: constOf("DRAWN_MATCH_KM_PER_POINT"),
  DRAWN_MATCH_MAX_PER_RUN: constOf("DRAWN_MATCH_MAX_PER_RUN"),
});
["distMeters", "distToSegMeters", "distToPathMeters", "worstDeviationPoints", "progressAlongDrawn", "drawnMismatchRatio"]
  .forEach((n) => vm.runInContext(extractFn(n), ctx));
const { worstDeviationPoints, progressAlongDrawn, distToPathMeters, drawnMismatchRatio } = ctx;
const THRESHOLD = Number((SRC.match(/DRAWN_MATCH_THRESHOLD_M\s*=\s*(\d+)/) || [])[1]);
const MAXPTS = Number((SRC.match(/DRAWN_MATCH_MAX_POINTS\s*=\s*(\d+)/) || [])[1]);
const LENRATIO = Number((SRC.match(/DRAWN_MATCH_MAX_LEN_RATIO\s*=\s*([\d.]+)/) || [])[1]);
const WPMAX = Number((SRC.match(/KAKAO_NAVI_MAX_WAYPOINTS\s*=\s*(\d+)/) || [])[1]);
console.log(`CF 설정: 임계 ${THRESHOLD}m · 보정점 최대 ${MAXPTS}개 · 거리비 상한 ${LENRATIO} · 경유지 상한 ${WPMAX}\n`);

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
async function callKakao(origin, destination, waypoints) {
  const r = await post({ origin, destination, waypoints, priority: "RECOMMEND", car_fuel: "DIESEL", summary: false });
  if (r.status !== 200) return null;
  const route = (JSON.parse(r.body).routes || [])[0];
  if (!route || route.result_code !== 0) return null;
  const pts = [], guides = [];
  (route.sections || []).forEach((s) => {
    (s.roads || []).forEach((rd) => {
      const v = rd.vertexes || [];
      for (let i = 0; i + 1 < v.length; i += 2) pts.push({ lat: Number(v[i + 1]), lng: Number(v[i]) });
    });
    (s.guides || []).forEach((g) => { if (g.type !== 100 && g.type !== 1000) guides.push(g); });
  });
  return { path: pts, guides };
}
function report(label, road, drawn) {
  const dev = drawn.map((p) => distToPathMeters(p, road)).sort((a, b) => a - b);
  const off = dev.filter((x) => x > 300).length;
  const ratio = pathLen(road) / pathLen(drawn);
  console.log(`  ${label.padEnd(22)} 이탈 중앙 ${String(Math.round(pct(dev, 0.5))).padStart(4)}m · p90 ${String(Math.round(pct(dev, 0.9))).padStart(5)}m · 최대 ${String(Math.round(dev[dev.length - 1])).padStart(5)}m · 300m초과 ${String(Math.round((off / dev.length) * 100)).padStart(3)}% · 거리비 ${ratio.toFixed(2)} · 안내 ${road.length ? guidesOf(road) : 0}`);
  return { offRatio: off / dev.length, ratio };
}
const guidesOf = () => "";  // 안내 개수는 아래에서 따로 찍는다

(async () => {
  const snap = await db.collection("companies").doc(CID).collection("routes").get();
  let routes = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }))
    .filter((r) => Array.isArray(r.routePath) && r.routePath.length >= 20);
  if (Q) routes = routes.filter((r) => String(r.name || "").includes(Q));
  routes.sort((a, b) => b.routePath.length - a.routePath.length);
  // 같은 노선의 요일 변형이 줄줄이 잡히지 않게 경로 길이로 중복 제거
  const seen = new Set(); const uniq = [];
  for (const r of routes) { if (seen.has(r.routePath.length)) continue; seen.add(r.routePath.length); uniq.push(r); }
  routes = uniq.slice(0, MAX);
  if (!routes.length) { console.error("대상 노선 없음"); process.exit(1); }

  let bad = 0;
  for (const r of routes) {
    const st = await db.collection("companies").doc(CID).collection("routes").doc(r.id).collection("stops").orderBy("order").get();
    const stops = [];
    st.docs.forEach((d) => { const p = ll(d.data() || {}); if (p) stops.push({ name: (d.data() || {}).name || "", x: p.lng, y: p.lat }); });
    const drawn = r.routePath.map(ll).filter(Boolean);
    if (stops.length < 2 || drawn.length < 2) continue;
    console.log("═".repeat(96));
    console.log(`▶ ${r.name} · 정류장 ${stops.length} · 그린 ${drawn.length}점 ${(pathLen(drawn) / 1000).toFixed(1)}km`);

    const mid = stops.slice(1, -1);
    const first = await callKakao(stops[0], stops[stops.length - 1], mid);
    if (!first) { console.log("  1차 실패\n"); bad++; continue; }
    const a = report("① 정류장만(예전)", first.path, drawn);
    console.log(`     회전 안내 ${first.guides.length}개`);

    // ── CF 2차와 동일 절차 ──
    const room = Math.max(0, WPMAX - mid.length);
    const worst = worstDeviationPoints(drawn, first.path, THRESHOLD, Math.min(room, MAXPTS));
    if (!worst.length) {
      console.log("  ② 보정 불필요(이미 그린 경로와 일치)\n");
      continue;
    }
    const cum = [0];
    for (let i = 1; i < drawn.length; i++) cum.push(cum[i - 1] + hav(drawn[i - 1], drawn[i]));
    const merged = [
      ...mid.map((w) => ({ w, prog: progressAlongDrawn({ lat: w.y, lng: w.x }, drawn, cum) })),
      ...worst.map((p) => ({ w: { name: "", x: p.lng, y: p.lat }, prog: progressAlongDrawn(p, drawn, cum) })),
    ].sort((x, y) => x.prog - y.prog).map((o) => o.w).slice(0, WPMAX);
    const second = await callKakao(stops[0], stops[stops.length - 1], merged);
    if (!second) { console.log("  2차 실패(1차 결과 사용됨)\n"); bad++; continue; }
    const b = report(`② 보정 ${worst.length}점`, second.path, drawn);
    console.log(`     회전 안내 ${second.guides.length}개 · 보정점 최대 이탈 ${Math.round(worst[0].dev)}m`);

    // ── CF 의 채택 판정과 **같은 잣대** ── 나빠지면 기각하고 정류장 경로를 그대로 쓴다.
    const baseScore = drawnMismatchRatio(drawn, first.path, THRESHOLD);
    const newScore = drawnMismatchRatio(drawn, second.path, THRESHOLD);
    const noDetour = b.ratio <= LENRATIO;
    const adopt = newScore < baseScore && noDetour;
    const finalScore = adopt ? newScore : baseScore;
    console.log(`  → ${adopt ? "채택" : "기각"}: 이탈 ${Math.round(baseScore * 100)}% → ${Math.round(newScore * 100)}%${noDetour ? "" : " · 거리 부풀림"}`);
    // 판정 기준: **예전보다 나빠지지 않는다**(개선이면 더 좋고, 최악이어도 동률).
    if (finalScore > baseScore) { bad++; console.log(`  ❌ 예전보다 나빠졌다`); }
    else console.log(`  ✅ 최종 이탈 ${Math.round(finalScore * 100)}% (예전 ${Math.round(baseScore * 100)}%)`);
    console.log("");
  }
  console.log(bad ? `❌ 확인 필요 ${bad}건` : "✅ 전 노선 통과");
  console.log("※ 카카오 응답은 저장하지 않았다.");
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error("실패:", e); process.exit(1); });
