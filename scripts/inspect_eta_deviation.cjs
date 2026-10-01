// 하교·방과후 ETA 편차 실측 (2026-10-01 채드윅 시스템 관련 미팅 — «2분 후라더니 4분», 강남·한남·도곡)
//   node scripts/inspect_eta_deviation.cjs [일수=10] [노선정규식=.] [구분정규식=하교|방과후] [정류장정규식=도곡]
//   ⚠ 채드윅 노선명은 코드형([G1]·[H1]·[A]…)이라 «강남·한남» 으로는 안 걸린다 — 노선별로 다 보고 정류장으로 좁힌다.
//
// 🔴 기준은 «기록된 도착» 이 아니라 **GPS 궤적에서 구한 실제 통과 시각**이다.
//   device 차량의 서버 도착감지(`pollDeviceVehicleGps`)는 ⓐ 최신 좌표 1점만 반경과 비교하고
//   ⓑ `actualAt` 을 측정 시각이 아니라 **폴 시각(serverTimestamp)** 으로 쓴다. 보고 간격이 120초면
//   그 사이 버스는 ~1km 를 가므로, 기록된 도착 자체가 늦거나 빠졌을 수 있다 → 기록을 정답으로 쓰면
//   측정이 측정 대상을 닮는다.
// 통과 시각 = 정류장에 가장 가까이 간 **구간**(연속 두 fix)에 정류장을 투영해 시각을 보간.
//   최근접 거리가 PASS_M 를 넘으면 «통과 판정 불가»(경로 이탈·GPS 공백)로 센다.
//
// 재는 것(정류장 i ≥ 1):
//   계획오차  = 통과[i] − 계획[i]                    (출발 지연이 그대로 실린다 — 참고용)
//   체인오차  = 통과[i] − (통과[i-1] + 계획구간[i])     ← 현행 ETA 체인이 «직전 정류장을 정확히 알 때» 낼 오차
//   기록체인  = 통과[i] − (기록[j] + 계획[i]−계획[j])  ← 앱이 실제로 쓰는 앵커(직전 **기록된** 정류장 j)
//   기록지연  = 기록[i] − 통과[i]                    (폴 시각 기록·누락의 크기)
// prod 쓰기 0.
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const DAYS = Number(process.argv[2] || 10);
const AREA = new RegExp(process.argv[3] || ".");
const KIND = new RegExp(process.argv[4] || "하교|방과후");
const STOP = new RegExp(process.argv[5] || "도곡");
const PASS_M = 150;

const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
const sa = require(path.join(ROOT, "key", kf));
if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치");
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const COMPANY = "dy001";

const toMs = (v) => (v && typeof v.toMillis === "function" ? v.toMillis() : typeof v === "number" ? v : null);
const kstDate = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
const hhmm = (ms) => (ms == null ? "  —  " : new Date(ms).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour12: false }).slice(0, 5));
const R = 6371000;
function xy(lat, lng, lat0) { // 국소 평면(m)
  return { x: (lng * Math.PI / 180) * R * Math.cos(lat0 * Math.PI / 180), y: (lat * Math.PI / 180) * R };
}
// 정류장 → 궤적 최근접 구간에 투영한 통과 시각(보간)·거리
function passTime(stop, pts) {
  let best = null;
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = pts[k], b = pts[k + 1];
    if (b.ms - a.ms > 10 * 60e3) continue; // 10분 넘는 공백은 잇지 않는다
    const P = xy(stop.lat, stop.lng, stop.lat), A = xy(a.lat, a.lng, stop.lat), B = xy(b.lat, b.lng, stop.lat);
    const dx = B.x - A.x, dy = B.y - A.y, L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((P.x - A.x) * dx + (P.y - A.y) * dy) / L2)) : 0;
    const d = Math.hypot(A.x + t * dx - P.x, A.y + t * dy - P.y);
    if (!best || d < best.d) best = { d, ms: a.ms + t * (b.ms - a.ms) };
  }
  return best;
}
const q = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; };
const fmt = (sec) => (sec == null ? "—" : `${sec >= 0 ? "+" : ""}${(sec / 60).toFixed(1)}분`);
const absq = (arr, p) => q(arr.map(Math.abs), p);

(async () => {
  const rsnap = await db.collection("companies").doc(COMPANY).collection("routes").get();
  const routes = rsnap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((r) => /채드윅|chadwick/i.test(String(r.partnerCode || "") + String(r.partnerName || ""))
      && AREA.test(r.name || r.routeName || "") && KIND.test(r.name || r.routeName || ""));
  if (!routes.length) { console.log("대상 노선 없음"); process.exit(0); }
  const byId = Object.fromEntries(routes.map((r) => [r.id, r]));
  console.log(`대상 노선 ${routes.length}개: ${routes.map((r) => r.name || r.routeName).join(" · ")}`);

  const stopsCache = {};
  const getStops = async (rid) => stopsCache[rid] || (stopsCache[rid] = (await db.collection("companies").doc(COMPANY)
    .collection("routes").doc(rid).collection("stops").orderBy("order", "asc").get())
    .docs.map((d) => ({ id: d.id, ...d.data() }))
    .map((s) => ({ ...s, lat: Number(s.lat ?? s.latitude ?? s.location?.latitude), lng: Number(s.lng ?? s.longitude ?? s.location?.longitude) }))
    .filter((s) => isFinite(s.lat) && isFinite(s.lng)));

  const perRoute = {};
  const stopFocus = {};
  const all = { chainFirst: [], chainRest: [], firstByRoute: {}, chain: [], recChain: [], plan: [], lag: [], miss: 0, rec: 0, passN: 0, noPass: 0, gaps: [] };
  const now = Date.now();
  for (let k = 1; k <= DAYS; k++) {
    const date = kstDate(now - k * 86400e3);
    const ds = await db.collection("companies").doc(COMPANY).collection("dispatches").doc(date).collection("list").get();
    for (const doc of ds.docs) {
      const disp = doc.data();
      const route = byId[disp.routeId];
      if (!route || !disp.vehicleId) continue;
      const stops = await getStops(disp.routeId);
      if (stops.length < 2) continue;
      const depart = disp.departTime || route.departTime;
      if (!/^\d{1,2}:\d{2}$/.test(depart || "")) continue;
      const depMs = Date.parse(`${date}T${depart.padStart(5, "0")}:00+09:00`);
      const lastOff = Math.max(...stops.map((s) => Number(s.offsetMin) || 0));
      const ps = await db.collection("gpsHistory").doc(COMPANY).collection(disp.vehicleId).doc(date).collection("points")
        .where("ts", ">=", admin.firestore.Timestamp.fromMillis(depMs - 20 * 60e3))
        .where("ts", "<=", admin.firestore.Timestamp.fromMillis(depMs + (lastOff + 60) * 60e3)).orderBy("ts").get();
      const pts = ps.docs.map((d) => d.data()).map((p) => ({ lat: Number(p.lat), lng: Number(p.lng), ms: toMs(p.ts) }))
        .filter((p) => isFinite(p.lat) && isFinite(p.lng) && p.ms && !(p.lat === 0 && p.lng === 0));
      if (pts.length < 5) continue;
      for (let i = 1; i < pts.length; i++) all.gaps.push((pts[i].ms - pts[i - 1].ms) / 1000);

      const name = route.name || route.routeName;
      const pr = perRoute[name] || (perRoute[name] = { runs: 0, chain: [], recChain: [], plan: [], lag: [], miss: 0, rec: 0, noPass: 0, worst: [] });
      pr.runs++;
      const arr = disp.stopArrivals || {};
      const row = stops.map((s, si) => {
        const p = passTime(s, pts);
        let pass = p && p.d <= PASS_M ? p.ms : null;
        // 🔴 출발지는 «최근접» 이 아니라 **떠난 시각**(반경 안 마지막 fix) — 하교는 학교에서 대기하므로
        //    최근접점이 대기 중 아무 순간이나 잡혀 첫 구간 오차가 출렁인다.
        if (si === 0 && pass != null) {
          const near = pts.filter((pt) => Math.hypot(...Object.values((() => { const A = xy(pt.lat, pt.lng, s.lat), P = xy(s.lat, s.lng, s.lat); return { a: A.x - P.x, b: A.y - P.y }; })())) <= PASS_M);
          if (near.length) pass = near[near.length - 1].ms;
        }
        const recMs = toMs(arr[s.id]?.actualAt);
        const planMs = s.offsetMin != null && s.offsetMin !== "" ? depMs + Number(s.offsetMin) * 60e3 : null;
        return { s, pass, d: p ? Math.round(p.d) : null, recMs, planMs };
      });
      row.forEach((r, i) => {
        if (r.pass == null) { pr.noPass++; all.noPass++; return; }
        all.passN++;
        if (r.recMs != null) { pr.rec++; all.rec++; const lag = (r.recMs - r.pass) / 1000; pr.lag.push(lag); all.lag.push(lag); }
        else { pr.miss++; all.miss++; }
        if (r.planMs != null) { const e = (r.pass - r.planMs) / 1000; pr.plan.push(e); all.plan.push(e); }
        if (i === 0) return;
        const prev = row[i - 1];
        if (prev.pass != null && prev.planMs != null && r.planMs != null) {
          const e = (r.pass - (prev.pass + (r.planMs - prev.planMs))) / 1000;
          pr.chain.push(e); all.chain.push(e);
          (i === 1 ? all.chainFirst : all.chainRest).push(e);
          if (i === 1) (all.firstByRoute[name] ||= []).push(e);
          pr.worst.push({ e, at: `${date} ${prev.s.name}→${r.s.name}` });
          if (STOP.test(r.s.name || "")) (stopFocus[`${r.s.name} (${name})`] ||= []).push(e);
        }
        // 앱이 실제로 쓰는 앵커: i 보다 앞에서 가장 최근에 «기록된» 정류장
        for (let j = i - 1; j >= 0; j--) {
          const a = row[j];
          if (a.recMs != null && a.planMs != null && r.planMs != null) {
            const e = (r.pass - (a.recMs + (r.planMs - a.planMs))) / 1000;
            pr.recChain.push(e); all.recChain.push(e); break;
          }
        }
      });
    }
  }

  const line = (lab, a) => `${lab} n=${a.length} 중앙 ${fmt(q(a, 0.5))} · |오차| 중앙 ${fmt(absq(a, 0.5))} · |오차| p90 ${fmt(absq(a, 0.9))}`;
  for (const [name, pr] of Object.entries(perRoute)) {
    console.log(`\n■ ${name} — 운행 ${pr.runs}회`);
    console.log("  " + line("체인오차(직전 통과 정확)", pr.chain));
    console.log("  " + line("기록체인(앱 실제 앵커)  ", pr.recChain));
    console.log("  " + line("계획대비(출발지연 포함) ", pr.plan));
    console.log(`  기록지연 중앙 ${fmt(q(pr.lag, 0.5))} · p90 ${fmt(q(pr.lag, 0.9))} · 통과했는데 기록 없음 ${pr.miss}/${pr.miss + pr.rec} · 통과 판정 불가 ${pr.noPass}`);
    const w = pr.worst.sort((a, b) => Math.abs(b.e) - Math.abs(a.e)).slice(0, 3);
    if (w.length) console.log("  가장 큰 구간: " + w.map((x) => `${x.at} ${fmt(x.e)}`).join(" / "));
  }
  for (const [k, a] of Object.entries(stopFocus)) console.log(`\n◆ 정류장 ${k}\n  ` + line("체인오차", a));
  console.log(`\n■ 전체`);
  console.log("  " + line("체인오차", all.chain));
  console.log("  " + line(" └ 첫 구간(출발지→첫 정류장)", all.chainFirst));
  console.log("  " + line(" └ 그 뒤 구간            ", all.chainRest));
  console.log("\n■ 첫 구간 계획 보정 후보(중앙 오차 = 계획보다 실제가 빠르면 음수 · 3회 이상만)");
  for (const [n, a] of Object.entries(all.firstByRoute).filter(([, a]) => a.length >= 3).sort((x, y) => Math.abs(q(y[1], 0.5)) - Math.abs(q(x[1], 0.5))))
    console.log(`  ${fmt(q(a, 0.5)).padStart(7)}  (${a.map((x) => fmt(x)).join(", ")})  ${n}`);
  console.log("  " + line("기록체인", all.recChain));
  console.log(`  기록지연 중앙 ${fmt(q(all.lag, 0.5))} · p90 ${fmt(q(all.lag, 0.9))} · 기록 누락 ${all.miss}/${all.miss + all.rec} (${all.miss + all.rec ? Math.round(100 * all.miss / (all.miss + all.rec)) : 0}%) · 통과 판정 불가 ${all.noPass}`);
  console.log(`  GPS 보고 간격 중앙 ${q(all.gaps, 0.5)}초 · p90 ${q(all.gaps, 0.9)}초`);
  process.exit(0);
})();
