// ETA 엔진 재생 비교 — «빠른 방향 1 클램프» 현행 vs 개선안 (2026-10-01 채드윅 미팅 후속)
//   node scripts/replay_eta_fast_clamp.cjs [일수=10] [구분정규식=하교|방과후] [파트너정규식=채드윅]
//
// 🔴 엔진을 베끼지 않는다 — `src/lib/stopSchedule.js` 정본을 vm 으로 그대로 태우고, 개선안은
//    그 소스의 slowFactor 한 줄만 치환한 사본이다(치환이 실제로 일어났는지 단언).
// 재생: 실제 운행의 GPS fix 가 들어올 때마다 그 시각(now)·좌표·그때까지 **기록된** 도착만 넣어
//       computeStopEstimates 를 부르고, 아직 안 지난 정류장마다 «예상 − 실제 통과»를 잰다.
// 정답(실제 통과) = GPS 궤적 최근접 구간 보간 시각(출발지는 떠난 시각) — inspect_eta_deviation.cjs 와 같은 정의.
// 지표: ① 다음 정류장 |오차| ② 전체 미통과 정류장 |오차|(승객이 보는 «내 정류장» 일반)
//       ③ 점프 = 같은 정류장의 예상이 연속 fix 사이 3분 넘게 바뀐 횟수 ④ 너무 이른 «곧 도착»
//          (예상 ≤ now+60초 인데 실제 통과는 3분 넘게 뒤)
// prod 쓰기 0.
process.env.TZ = "Asia/Seoul";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = path.join(__dirname, "..");
const DAYS = Number(process.argv[2] || 10);
const KIND = new RegExp(process.argv[3] || "하교|방과후");
const PARTNER = new RegExp(process.argv[4] || "채드윅");
const PASS_M = 150;

// ── 엔진 로드(정본 + 개선안) ─────────────────────────────────────────────
// 정본의 slowFactor 식(2026-10-01 반영분). 비교안은 이 식 전체를 바꿔 끼운다.
const CLAMP_OLD = "(actualProgress >= SLOW_FACTOR_MIN_PROGRESS)\n              ? Math.min(SLOW_FACTOR_MAX, Math.max(1, expectedProgressByTime / actualProgress))\n              : 1";
const CLAMP_NEW = "(actualProgress >= 0.2 ? Math.max(0.5, expectedProgressByTime / actualProgress) : Math.max(1, expectedProgressByTime / actualProgress))";
function loadEngine(rep) {
  const rp = fs.readFileSync(path.join(ROOT, "src/lib/routeProgress.js"), "utf8").replace(/^export /gm, "");
  let ss = fs.readFileSync(path.join(ROOT, "src/lib/stopSchedule.js"), "utf8")
    .replace(/\r\n/g, "\n").replace(/^import .*$/gm, "").replace(/^export /gm, "");
  if (rep) {
    if (!ss.includes(CLAMP_OLD)) throw new Error("slowFactor 줄을 소스에서 못 찾음 — 엔진이 바뀌었다");
    ss = ss.replace(CLAMP_OLD, rep);
    if (!ss.includes(rep)) throw new Error("치환 실패");
  }
  const ctx = { console, Date, Math, Number, isFinite, Array, Object, String };
  vm.createContext(ctx);
  vm.runInContext(rp + "\n" + ss + "\n;this.C=computeStopEstimates;", ctx);
  return ctx.C;
}
// 비교안 — slowFactor 한 줄만 바꾼다. cur = 정본 그대로.
const VARIANTS = {
  cur: null, // 정본 = 진행 25% 전 1 · 상한 1.5 (2026-10-01 채택)
  legacy: "(actualProgress > 0) ? Math.max(1, expectedProgressByTime / actualProgress) : 1", // 2026-05-29~09-30
  fastOK: CLAMP_NEW, // 빠른 방향 허용(기각 — 점프만 는다)
};
const ENGINES = Object.fromEntries(Object.entries(VARIANTS).map(([k, rep]) => [k, loadEngine(rep)]));

// ── 데이터 ───────────────────────────────────────────────────────────
const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
const sa = require(path.join(ROOT, "key", kf));
if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치");
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const COMPANY = "dy001";
const toMs = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : typeof v === "number" ? v : null);
const kstDate = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
const R = 6371000;
const xy = (lat, lng, lat0) => ({ x: (lng * Math.PI / 180) * R * Math.cos(lat0 * Math.PI / 180), y: (lat * Math.PI / 180) * R });
const dist = (a, s) => { const A = xy(a.lat, a.lng, s.lat), P = xy(s.lat, s.lng, s.lat); return Math.hypot(A.x - P.x, A.y - P.y); };
function passTime(stop, pts) {
  let best = null;
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = pts[k], b = pts[k + 1];
    if (b.ms - a.ms > 10 * 60e3) continue;
    const P = xy(stop.lat, stop.lng, stop.lat), A = xy(a.lat, a.lng, stop.lat), B = xy(b.lat, b.lng, stop.lat);
    const dx = B.x - A.x, dy = B.y - A.y, L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((P.x - A.x) * dx + (P.y - A.y) * dy) / L2)) : 0;
    const d = Math.hypot(A.x + t * dx - P.x, A.y + t * dy - P.y);
    if (!best || d < best.d) best = { d, ms: a.ms + t * (b.ms - a.ms) };
  }
  return best;
}
const toLL = (p) => (p && typeof p === "object" ? { lat: Number(p.lat ?? p.latitude ?? p._latitude), lng: Number(p.lng ?? p.longitude ?? p._longitude) } : null);
const q = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; };
const m = (sec) => (sec == null ? "—" : `${(sec / 60).toFixed(1)}분`);

(async () => {
  const rsnap = await db.collection("companies").doc(COMPANY).collection("routes").get();
  const routes = Object.fromEntries(rsnap.docs.map((d) => [d.id, { id: d.id, ...d.data() }])
    .filter(([, r]) => PARTNER.test(String(r.partnerCode || "")) && KIND.test(r.name || "")));
  const stopsCache = {};
  const getStops = async (rid) => stopsCache[rid] || (stopsCache[rid] = (await db.collection("companies").doc(COMPANY)
    .collection("routes").doc(rid).collection("stops").orderBy("order", "asc").get()).docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .map((s) => ({ ...s, lat: Number(s.lat ?? s.latitude), lng: Number(s.lng ?? s.longitude), offsetMin: s.offsetMin === "" || s.offsetMin == null ? undefined : Number(s.offsetMin) }))
    .filter((s) => isFinite(s.lat) && isFinite(s.lng)));

  const S = {};
  for (const k of Object.keys(ENGINES)) S[k] = { next: [], all: [], jumps: 0, early: 0, nextFirst: [], nextRest: [] };
  let runs = 0, calls = 0, routesWithPath = 0;
  const now0 = Date.now();
  for (let day = 1; day <= DAYS; day++) {
    const date = kstDate(now0 - day * 86400e3);
    const ds = await db.collection("companies").doc(COMPANY).collection("dispatches").doc(date).collection("list").get();
    for (const doc of ds.docs) {
      const disp = doc.data();
      const route = routes[disp.routeId];
      if (!route || !disp.vehicleId) continue;
      const stops = await getStops(disp.routeId);
      if (stops.length < 2) continue;
      const depart = disp.departTime || route.departTime;
      if (!/^\d{1,2}:\d{2}$/.test(depart || "")) continue;
      const depMs = Date.parse(`${date}T${depart.padStart(5, "0")}:00+09:00`);
      const lastOff = Math.max(...stops.map((s) => s.offsetMin || 0));
      const ps = await db.collection("gpsHistory").doc(COMPANY).collection(disp.vehicleId).doc(date).collection("points")
        .where("ts", ">=", admin.firestore.Timestamp.fromMillis(depMs - 20 * 60e3))
        .where("ts", "<=", admin.firestore.Timestamp.fromMillis(depMs + (lastOff + 60) * 60e3)).orderBy("ts").get();
      const pts = ps.docs.map((d) => d.data()).map((p) => ({ lat: Number(p.lat), lng: Number(p.lng), ms: toMs(p.ts) }))
        .filter((p) => isFinite(p.lat) && isFinite(p.lng) && p.ms && !(p.lat === 0 && p.lng === 0));
      if (pts.length < 5) continue;
      const truth = stops.map((s, si) => {
        const p = passTime(s, pts);
        if (!p || p.d > PASS_M) return null;
        if (si === 0) { const near = pts.filter((pt) => dist(pt, s) <= PASS_M); return near.length ? near[near.length - 1].ms : p.ms; }
        return p.ms;
      });
      if (truth[0] == null) continue;
      const lastTruth = Math.max(...truth.filter((x) => x != null));
      const rec = {};
      for (const [sid, v] of Object.entries(disp.stopArrivals || {})) { const ms = toMs(v && v.actualAt); if (ms) rec[sid] = ms; }
      const routePath = (Array.isArray(route.routePath) ? route.routePath.map(toLL) : []).filter((p) => p && isFinite(p.lat) && isFinite(p.lng));
      if (routePath.length >= 2) routesWithPath++;
      runs++;
      const prevPred = Object.fromEntries(Object.keys(ENGINES).map((k) => [k, {}]));
      for (const fx of pts) {
        if (fx.ms < truth[0] - 60e3 || fx.ms > lastTruth) continue; // 출발 직전 ~ 마지막 통과
        const arrivals = Object.fromEntries(Object.entries(rec).filter(([, ms]) => ms <= fx.ms));
        for (const [k, C] of Object.entries(ENGINES)) {
          const out = C({ stops, departTime: depart, actualArrivals: arrivals, vehiclePos: { lat: fx.lat, lng: fx.lng }, speed: null, routePath: routePath.length >= 2 ? routePath : null, now: fx.ms });
          calls++;
          out.forEach((e, i) => {
            if (e.status !== "next" && e.status !== "upcoming") return;
            const t = truth[i];
            if (t == null || t <= fx.ms || !e.estimatedAt) return;
            const [hh, mm] = e.estimatedAt.split(":").map(Number);
            let est = Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:30+09:00`);
            const err = (est - t) / 1000;
            S[k].all.push(Math.abs(err));
            if (k === "cur" && Math.abs(err) > 600) (S.cur.bad ||= []).push({
              err, at: new Date(fx.ms).toTimeString().slice(0, 5), date, route: route.name.slice(0, 16), stop: (stops[i].name || "").slice(0, 14), i,
              status: e.status, source: e.source, est: e.estimatedAt, truth: new Date(t).toTimeString().slice(0, 5),
              known: Object.keys(arrivals).length, lastTruthPassed: truth.filter((x) => x != null && x <= fx.ms).length,
            });
            if (e.status === "next") { S[k].next.push(Math.abs(err)); (i === 1 ? S[k].nextFirst : S[k].nextRest).push(Math.abs(err)); }
            if (est <= fx.ms + 90e3 && t - fx.ms > 180e3) S[k].early++;
            const pp = prevPred[k][e.stopId];
            if (pp != null && Math.abs(est - pp) > 180e3) S[k].jumps++;
            prevPred[k][e.stopId] = est;
          });
        }
      }
    }
  }
  console.log(`재생: 운행 ${runs}회 · 엔진 호출 ${calls}회 · routePath 보유 운행 ${routesWithPath}회`);
  const row = (k) => {
    const s = S[k];
    return `${k.padEnd(11)} | 다음정류장 |오차| 중앙 ${m(q(s.next, .5))} p90 ${m(q(s.next, .9))} (첫구간 중앙 ${m(q(s.nextFirst, .5))} · 그뒤 ${m(q(s.nextRest, .5))})`
      + ` | 전체 미통과 중앙 ${m(q(s.all, .5))} p90 ${m(q(s.all, .9))} | 3분+ 점프 ${s.jumps} | 이른 곧도착 ${s.early} | 표본 ${s.all.length}`;
  };
  for (const k of Object.keys(ENGINES)) console.log(row(k));
  const bad = S.cur.bad || [];
  if (bad.length) {
    console.log(`\n[현행] 10분 넘게 틀린 순간 ${bad.length}건 — 유형별`);
    const by = {};
    for (const b of bad) { const key = `${b.err > 0 ? "늦게" : "이르게"} · ${b.status} · source=${b.source} · 기록${b.known < b.lastTruthPassed ? "<" : ">="}실통과`; (by[key] ||= []).push(b); }
    for (const [k, a] of Object.entries(by).sort((x, y) => y[1].length - x[1].length))
      console.log(`  ${String(a.length).padStart(4)}  ${k}  예: ${a[0].date} ${a[0].at} ${a[0].route} #${a[0].i} ${a[0].stop} 예상 ${a[0].est} 실제 ${a[0].truth} (기록 ${a[0].known}/실통과 ${a[0].lastTruthPassed})`);
  }
  process.exit(0);
})();
