// 덤 우회 정리 실데이터 검증 (읽기 전용) — 2026-08-05.
//   node scripts/verify_navi_detour.cjs [노선명 일부] [--max N]
//
// 기사 지적("좌회전하면 되는데 우회전 후 유턴 시킴", 과천라인 2026-08-05)의 처방을 실노선으로 잰다.
// **CF(functions/index.js)의 판정 함수를 소스에서 그대로 뽑아** 같은 절차를 재현한다
// (테스트용 복제본을 쓰면 소스가 바뀌어도 통과해 버린다).
//   ① 정류장만 → ② 그린 이탈 보정 → ③ 덤 우회 경유지 제거 → ④ 유턴 회피
// 판정 기준 = **예전보다 나빠진 노선이 0**(개선이면 더 좋고, 최악이어도 동률).
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
const MAX = mi >= 0 ? Number(args[mi + 1]) || 99 : 99;
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
const C = ["DRAWN_MATCH_THRESHOLD_M", "DRAWN_MATCH_MAX_POINTS", "DRAWN_MATCH_MAX_LEN_RATIO",
  "DRAWN_MATCH_KM_PER_POINT", "DRAWN_MATCH_MAX_PER_RUN", "KAKAO_NAVI_MAX_WAYPOINTS",
  "DETOUR_THRESHOLD_M", "DETOUR_MIN_RUN_M", "STOP_COVER_M", "DETOUR_PRUNE_ROUNDS", "KAKAO_NAVI_MAX_CALLS"]
  .reduce((o, n) => { o[n] = constOf(n); return o; }, {});
const ctx = vm.createContext({ console, ...C });
["distMeters", "distToSegMeters", "distToPathMeters", "worstDeviationPoints", "progressAlongDrawn",
  "drawnMismatchRatio", "detourRuns", "detourMeters", "naviRouteScore", "allStopsCovered",
  "detourSuspects", "uturnCount"].forEach((n) => vm.runInContext(extractFn(n), ctx));
const { distMeters, worstDeviationPoints, progressAlongDrawn, detourRuns, detourMeters,
  naviRouteScore, allStopsCovered, detourSuspects, uturnCount } = ctx;
console.log(`CF 설정: 이탈 ${C.DRAWN_MATCH_THRESHOLD_M}m · 덤 ${C.DETOUR_THRESHOLD_M}m(최소 ${C.DETOUR_MIN_RUN_M}m) · 정류장 커버 ${C.STOP_COVER_M}m · 호출 상한 ${C.KAKAO_NAVI_MAX_CALLS}\n`);

function ll(v) {
  if (!v) return null;
  const la = Number(v.lat ?? v.latitude ?? v.location?.latitude);
  const lo = Number(v.lng ?? v.longitude ?? v.location?.longitude);
  return Number.isFinite(la) && Number.isFinite(lo) && la && lo ? { lat: la, lng: lo } : null;
}
const pathLen = (p) => { let t = 0; for (let i = 1; i < p.length; i++) t += distMeters(p[i - 1].lat, p[i - 1].lng, p[i].lat, p[i].lng); return t; };

function post(body) {
  return new Promise((res, rej) => {
    const p = JSON.stringify(body);
    const req = https.request({
      hostname: "apis-navi.kakaomobility.com", path: "/v1/waypoints/directions", method: "POST",
      headers: { Authorization: `KakaoAK ${REST}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(p) },
      timeout: 25000,
    }, (r) => { let raw = ""; r.setEncoding("utf8"); r.on("data", (c) => { raw += c; }); r.on("end", () => res({ status: r.statusCode, body: raw })); });
    req.on("timeout", () => req.destroy(new Error("시간 초과")));
    req.on("error", rej); req.write(p); req.end();
  });
}
let calls = 0, ms = 0;
async function callKakao(O, D, waypoints, avoidUturn) {
  if (calls >= C.KAKAO_NAVI_MAX_CALLS) return null;
  calls++;
  const t0 = Date.now();
  const r = await post({ origin: O, destination: D, waypoints, priority: "RECOMMEND", car_fuel: "DIESEL", summary: false, ...(avoidUturn ? { avoid: ["uturn"] } : {}) });
  ms += Date.now() - t0;
  if (r.status !== 200) return null;
  const route = (JSON.parse(r.body).routes || [])[0];
  if (!route || route.result_code !== 0) return null;
  const p = [], sectionOf = [], guides = [];
  (route.sections || []).forEach((sec, si) => {
    (sec.roads || []).forEach((rd) => {
      const v = rd.vertexes || [];
      for (let i = 0; i + 1 < v.length; i += 2) { p.push({ lat: Number(v[i + 1]), lng: Number(v[i]) }); sectionOf.push(si); }
    });
    (sec.guides || []).forEach((g) => { if (g.type !== 100 && g.type !== 1000) guides.push({ lat: Number(g.y), lng: Number(g.x), name: g.name || "", guidance: g.guidance || "", type: g.type }); });
  });
  return { path: p, sectionOf, guides, waypoints, avoidUturn: !!avoidUturn };
}

(async () => {
  const snap = await db.collection("companies").doc(CID).collection("routes").get();
  let routes = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }))
    .filter((r) => Array.isArray(r.routePath) && r.routePath.length >= 20);
  if (Q) routes = routes.filter((r) => String(r.name || "").includes(Q));
  // 같은 노선의 요일 변형이 줄줄이 잡히지 않게 경로 길이로 중복 제거
  const seen = new Set();
  routes = routes.filter((r) => { if (seen.has(r.routePath.length)) return false; seen.add(r.routePath.length); return true; });
  routes.sort((a, b) => b.routePath.length - a.routePath.length);
  routes = routes.slice(0, MAX);
  if (!routes.length) { console.error("대상 노선 없음"); process.exit(1); }

  let worse = 0, improved = 0, maxCalls = 0, maxMs = 0;
  for (const r of routes) {
    const st = await db.collection("companies").doc(CID).collection("routes").doc(r.id).collection("stops").orderBy("order").get();
    const pts = [];
    st.docs.forEach((d) => { const p = ll(d.data() || {}); if (p) pts.push({ name: (d.data() || {}).name || "", x: p.lng, y: p.lat }); });
    const drawn = r.routePath.map(ll).filter(Boolean);
    if (pts.length < 2 || drawn.length < 10) continue;
    const drawnLen = pathLen(drawn);
    const O = pts[0], D = pts[pts.length - 1], mid = pts.slice(1, -1);
    calls = 0; ms = 0;

    let cand = await callKakao(O, D, mid, false);
    if (!cand) { console.log(`▶ ${r.name} 1차 실패`); continue; }
    const scoreOf = (c) => naviRouteScore(drawn, drawnLen, c.path, c.sectionOf);
    let bestScore = scoreOf(cand);
    const s0 = bestScore, u0 = uturnCount(cand.guides), l0 = pathLen(cand.path);
    const d0 = detourMeters(cand.path, cand.sectionOf, drawn, C.DETOUR_THRESHOLD_M);
    const notes = [];

    // ② 그린 이탈 보정
    const room = Math.max(0, C.KAKAO_NAVI_MAX_WAYPOINTS - mid.length);
    if (room >= 1) {
      const worst = worstDeviationPoints(drawn, cand.path, C.DRAWN_MATCH_THRESHOLD_M, Math.min(room, C.DRAWN_MATCH_MAX_POINTS));
      if (worst.length) {
        const cum = [0];
        for (let i = 1; i < drawn.length; i++) cum.push(cum[i - 1] + distMeters(drawn[i - 1].lat, drawn[i - 1].lng, drawn[i].lat, drawn[i].lng));
        const merged = [
          ...mid.map((w) => ({ w, prog: progressAlongDrawn({ lat: w.y, lng: w.x }, drawn, cum) })),
          ...worst.map((p) => ({ w: { name: "", x: p.lng, y: p.lat }, prog: progressAlongDrawn(p, drawn, cum) })),
        ].sort((a, b) => a.prog - b.prog).map((o) => o.w).slice(0, C.KAKAO_NAVI_MAX_WAYPOINTS);
        const better = await callKakao(O, D, merged, false);
        if (better) {
          const sc = scoreOf(better);
          if (sc < bestScore && pathLen(better.path) <= drawnLen * C.DRAWN_MATCH_MAX_LEN_RATIO && allStopsCovered(pts, better.path, C.STOP_COVER_M)) {
            cand = better; bestScore = sc; notes.push(`보정 ${worst.length}점`);
          }
        }
      }
    }
    // ③ 덤 우회 경유지 제거
    for (let round = 0; round < C.DETOUR_PRUNE_ROUNDS && calls < C.KAKAO_NAVI_MAX_CALLS; round++) {
      const runs = detourRuns(cand.path, cand.sectionOf, drawn, C.DETOUR_THRESHOLD_M).filter((x) => x.meters >= C.DETOUR_MIN_RUN_M);
      if (!runs.length) break;
      let improvedRound = false;
      for (const wi of detourSuspects(runs.slice(0, 3), cand.waypoints.length)) {
        if (calls >= C.KAKAO_NAVI_MAX_CALLS) break;
        const pruned = await callKakao(O, D, cand.waypoints.filter((_, i) => i !== wi), cand.avoidUturn);
        if (!pruned) continue;
        const sc = scoreOf(pruned);
        if (sc < bestScore && allStopsCovered(pts, pruned.path, C.STOP_COVER_M)) {
          notes.push(`제거(${cand.waypoints[wi].name || "?"})`);
          cand = pruned; bestScore = sc; improvedRound = true; break;
        }
      }
      if (!improvedRound) break;
    }
    // ④ 유턴 회피
    if (uturnCount(cand.guides) > 0 && calls < C.KAKAO_NAVI_MAX_CALLS) {
      const noU = await callKakao(O, D, cand.waypoints, true);
      if (noU) {
        const sc = scoreOf(noU);
        const fewer = uturnCount(noU.guides) < uturnCount(cand.guides);
        if (allStopsCovered(pts, noU.path, C.STOP_COVER_M) && (sc < bestScore || (sc <= bestScore + 0.01 && fewer))) {
          notes.push("유턴회피"); cand = noU; bestScore = sc;
        }
      }
    }

    maxCalls = Math.max(maxCalls, calls); maxMs = Math.max(maxMs, ms);
    const dN = detourMeters(cand.path, cand.sectionOf, drawn, C.DETOUR_THRESHOLD_M);
    // 🔴 판정: **예전보다 나빠지면 실패**. 유턴 회피는 점수 동률에서 채택될 수 있어 여유 0.01.
    const bad = bestScore > s0 + 0.011 || !allStopsCovered(pts, cand.path, C.STOP_COVER_M);
    if (bad) worse++; else if (bestScore < s0 - 1e-9) improved++;
    console.log(`▶ ${String(r.name).padEnd(22)} 그린 ${(drawnLen / 1000).toFixed(1).padStart(5)}km | 예전 ${(l0 / 1000).toFixed(1).padStart(5)}km 덤${(d0 / 1000).toFixed(2).padStart(5)} 유턴${u0} 점수${s0.toFixed(3)} → 지금 ${(pathLen(cand.path) / 1000).toFixed(1).padStart(5)}km 덤${(dN / 1000).toFixed(2).padStart(5)} 유턴${uturnCount(cand.guides)} 점수${bestScore.toFixed(3)} | 호출${calls} ${String(ms).padStart(4)}ms ${bad ? "❌나빠짐" : bestScore < s0 - 1e-9 ? "✅개선" : "= 동일"}${notes.length ? ` [${notes.join("+")}]` : ""}`);
  }
  console.log(`\n개선 ${improved} · 동일 ${routes.length - improved - worse} · ${worse ? `❌ 나빠짐 ${worse}` : "나빠짐 0 ✅"} · 최대 호출 ${maxCalls}회 · 최대 ${maxMs}ms`);
  console.log("※ 카카오 응답은 저장하지 않았다.");
  process.exit(worse ? 1 : 0);
})().catch((e) => { console.error("실패:", e); process.exit(1); });
