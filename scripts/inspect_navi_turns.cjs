// 길안내 회전 안내 진단 (읽기 전용) — 2026-08-05.
//   node scripts/inspect_navi_turns.cjs [노선명 일부] [--near "선암사거리"]
//
// 기사 지적("좌회전하면 되는데 우회전 후 유턴 시킴")을 실데이터로 잰다.
// CF(functions/index.js)의 2단계 절차를 **소스에서 뽑은 판정 함수 그대로** 재현하고,
// 1차(정류장만) / 2차(보정) 각각의 **회전 안내 목록과 유턴 위치**를 나란히 찍는다.
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
const ni = args.indexOf("--near");
const NEAR = ni >= 0 ? String(args[ni + 1] || "") : "";
const Q = args.filter((a, i) => !a.startsWith("--") && i !== ni + 1).join(" ").trim() || "과천";

// ── CF 소스에서 판정 함수·상수를 그대로 가져온다(복제본 금지) ──────
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
const THRESHOLD = constOf("DRAWN_MATCH_THRESHOLD_M");
const MAXPTS = constOf("DRAWN_MATCH_MAX_POINTS");
const LENRATIO = constOf("DRAWN_MATCH_MAX_LEN_RATIO");
const WPMAX = constOf("KAKAO_NAVI_MAX_WAYPOINTS");

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
  if (r.status !== 200) { console.log(`  HTTP ${r.status}: ${r.body.slice(0, 200)}`); return null; }
  const route = (JSON.parse(r.body).routes || [])[0];
  if (!route || route.result_code !== 0) { console.log(`  result_code=${route && route.result_code}`); return null; }
  const pts = [], guides = [];
  (route.sections || []).forEach((s) => {
    (s.roads || []).forEach((rd) => {
      const v = rd.vertexes || [];
      for (let i = 0; i + 1 < v.length; i += 2) pts.push({ lat: Number(v[i + 1]), lng: Number(v[i]) });
    });
    (s.guides || []).forEach((g) => { if (g.type !== 100 && g.type !== 1000) guides.push(g); });
  });
  return { path: pts, guides, distance: route.summary ? route.summary.distance : null };
}

const isUturn = (g) => /유턴|U턴/.test(`${g.guidance || ""}`) || g.type === 4;
const isRight = (g) => /우회전/.test(`${g.guidance || ""}`);

function dumpGuides(label, res, drawn) {
  const u = res.guides.filter(isUturn);
  const rt = res.guides.filter(isRight);
  console.log(`\n  ── ${label} · 도로 ${(pathLen(res.path) / 1000).toFixed(1)}km · 안내 ${res.guides.length}개 (유턴 ${u.length} · 우회전 ${rt.length})`);
  res.guides.forEach((g, i) => {
    const p = { lat: Number(g.y), lng: Number(g.x) };
    const off = Math.round(distToPathMeters(p, drawn));   // 이 안내 지점이 그린 경로에서 얼마나 떨어졌나
    const flag = isUturn(g) ? "🔴유턴" : (off > THRESHOLD ? "⚠이탈" : "  ");
    const hit = NEAR && String(g.name || "").includes(NEAR) ? " ◀◀" : "";
    console.log(`    ${String(i).padStart(2)} ${flag} ${String(g.guidance || "").padEnd(14)} ${String(g.name || "").padEnd(20)} 그린이탈 ${String(off).padStart(5)}m${hit}`);
  });
  return { u: u.length, r: rt.length };
}

(async () => {
  console.log(`CF 설정: 임계 ${THRESHOLD}m · 보정점 최대 ${MAXPTS} · 거리비 상한 ${LENRATIO} · 경유지 상한 ${WPMAX}`);
  const snap = await db.collection("companies").doc(CID).collection("routes").get();
  const routes = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }))
    .filter((r) => String(r.name || "").includes(Q));
  if (!routes.length) { console.error(`"${Q}" 노선 없음`); process.exit(1); }

  for (const r of routes) {
    const st = await db.collection("companies").doc(CID).collection("routes").doc(r.id).collection("stops").orderBy("order").get();
    const stops = [];
    st.docs.forEach((d) => { const p = ll(d.data() || {}); if (p) stops.push({ name: (d.data() || {}).name || "", x: p.lng, y: p.lat }); });
    const drawn = (Array.isArray(r.routePath) ? r.routePath : []).map(ll).filter(Boolean);
    console.log("\n" + "═".repeat(100));
    console.log(`▶ ${r.name} (${r.id}) · 정류장 ${stops.length} · 그린 ${drawn.length}점 ${drawn.length ? (pathLen(drawn) / 1000).toFixed(1) : 0}km · departTime ${r.departTime || "-"}`);
    if (stops.length < 2) { console.log("  좌표 정류장 2곳 미만 — skip"); continue; }

    // 정류장이 그린 경로/도로에서 얼마나 떨어져 있는지 — 경유지 스냅이 유턴을 만드는 주범
    if (drawn.length >= 2) {
      console.log("  정류장 ↔ 그린 경로 거리:");
      stops.forEach((s, i) => {
        const off = Math.round(distToPathMeters({ lat: s.y, lng: s.x }, drawn));
        console.log(`    ${String(i).padStart(2)} ${String(s.name).padEnd(24)} ${String(off).padStart(5)}m ${off > 60 ? "⚠" : ""}`);
      });
    }

    const mid = stops.slice(1, -1);
    const first = await callKakao(stops[0], stops[stops.length - 1], mid);
    if (!first) { console.log("  1차 실패"); continue; }
    const a = dumpGuides("① 정류장만(1차)", first, drawn);

    if (drawn.length < 10) { console.log("\n  그린 경로 10점 미만 — 보정 안 함(1차가 최종)"); continue; }
    const room = Math.max(0, WPMAX - mid.length);
    const worst = worstDeviationPoints(drawn, first.path, THRESHOLD, Math.min(room, MAXPTS));
    if (!worst.length) { console.log("\n  ② 보정 불필요(이미 그린 경로와 일치) — 1차가 최종"); continue; }
    const cum = [0];
    for (let i = 1; i < drawn.length; i++) cum.push(cum[i - 1] + hav(drawn[i - 1], drawn[i]));
    const merged = [
      ...mid.map((w) => ({ w, prog: progressAlongDrawn({ lat: w.y, lng: w.x }, drawn, cum) })),
      ...worst.map((p) => ({ w: { name: "", x: p.lng, y: p.lat }, prog: progressAlongDrawn(p, drawn, cum) })),
    ].sort((x, y) => x.prog - y.prog).map((o) => o.w).slice(0, WPMAX);
    console.log(`\n  보정점 ${worst.length}개 삽입 → 경유지 ${merged.length}개`);
    const second = await callKakao(stops[0], stops[stops.length - 1], merged);
    if (!second) { console.log("  2차 실패(1차 결과 사용)"); continue; }
    const b = dumpGuides(`② 보정 ${worst.length}점(2차)`, second, drawn);

    const baseScore = drawnMismatchRatio(drawn, first.path, THRESHOLD);
    const newScore = drawnMismatchRatio(drawn, second.path, THRESHOLD);
    const noDetour = pathLen(second.path) <= pathLen(drawn) * LENRATIO;
    const adopt = newScore < baseScore && noDetour;
    console.log(`\n  → CF 판정: ${adopt ? "★ 2차 채택(기사가 보는 안내)" : "1차 유지"} · 이탈 ${Math.round(baseScore * 100)}%→${Math.round(newScore * 100)}%${noDetour ? "" : " · 거리 부풀림"}`);
    console.log(`     유턴 ${a.u}→${b.u} · 우회전 ${a.r}→${b.r}`);
  }
  console.log("\n※ 카카오 응답은 저장하지 않았다.");
  process.exit(0);
})().catch((e) => { console.error("실패:", e); process.exit(1); });
