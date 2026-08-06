// 옆길·진입 안내의 **좌우를 경로 기하로 구할 수 있는가** 실측 (2026-08-06 way
//   "옆길과 지하차도 진입은 매우 중요한 경로 안내라 앱에서 자체적으로 오른쪽/왼쪽을 보여주면 되지 않나").
//   node scripts/measure_side_road_bearing.cjs [--max N]
//
// 카카오는 옆길의 좌우를 **필드로 주지 않는다**(응답 전 키 확인·2026-08-06). 하지만 우리가 받은
// **도로 경로 자체는 이미 그 옆길로 굽어 있다** — 안내 지점 앞뒤 진행 방위각 차이의 부호가 곧 좌우다.
//
// 이 스크립트는 "그 각이 실제로 좌우를 가를 만큼 큰가"를 **prod 실노선 실호출**로 잰다.
// 🔴 답이 "작다/뒤섞인다" 로 나오면 좌우 아이콘을 만들면 안 된다 — 틀린 방향은 없는 것보다 나쁘다.
// 카카오 응답은 저장하지 않는다(운영정책). 키 = file/20260729/restkey.txt(gitignore).
const fs = require("fs");
const path = require("path");
const https = require("https");
const ROOT = path.join(__dirname, "..");
const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));

const REST = fs.readFileSync(path.join(ROOT, "file", "20260729", "restkey.txt"), "utf8").trim();
const saDir = path.join(ROOT, "key");
const k = require(path.join(saDir, fs.readdirSync(saDir).find((f) => f.endsWith(".json"))));
if (k.project_id !== "buslink-prod") { console.error("project_id 불일치"); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(k) });
const db = admin.firestore();
const CID = "dy001";
const mi = process.argv.indexOf("--max");
const MAX = mi >= 0 ? Number(process.argv[mi + 1]) || 99 : 99;

const R = 6371000, rad = (d) => (d * Math.PI) / 180;
function distM(a, b) {
  const dLa = rad(b.lat - a.lat), dLo = rad(b.lng - a.lng);
  const s = Math.sin(dLa / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
/** 방위각(도, 북=0, 시계방향). */
function bearing(a, b) {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
            Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (Math.atan2(y, x) * 180) / Math.PI;
}
/** 부호 있는 회전각(−180..180). 양수=우회전(시계), 음수=좌회전. */
function signedTurn(inB, outB) {
  let d = outB - inB;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}
function ll(v) {
  const la = Number(v?.lat ?? v?.latitude ?? v?.location?.latitude);
  const lo = Number(v?.lng ?? v?.longitude ?? v?.location?.longitude);
  return Number.isFinite(la) && Number.isFinite(lo) && la && lo ? { lat: la, lng: lo } : null;
}

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

/** 안내 지점 앞뒤 `span` m 구간의 방위각으로 부호 있는 회전각을 낸다. */
function turnAtPoint(pathArr, cum, pt, span) {
  // 가장 가까운 경로 점
  let bi = -1, bd = Infinity;
  for (let i = 0; i < pathArr.length; i++) {
    const d = distM(pathArr[i], pt);
    if (d < bd) { bd = d; bi = i; }
  }
  if (bi < 0 || bd > 60) return null;              // 경로에서 60m 넘게 떨어지면 판정 불가
  const s = cum[bi];
  const at = (target) => {                          // 누적거리 target 지점의 좌표(근사=최근접 점)
    let j = bi, best = Infinity, out = null;
    for (let i = 0; i < pathArr.length; i++) {
      const d = Math.abs(cum[i] - target);
      if (d < best) { best = d; out = pathArr[i]; j = i; }
    }
    return { pt: out, idx: j };
  };
  const back = at(s - span), fwd = at(s + span);
  if (!back.pt || !fwd.pt) return null;
  if (back.idx === bi || fwd.idx === bi) return null;               // 앞뒤로 충분한 구간이 없다
  if (distM(back.pt, pathArr[bi]) < span * 0.4) return null;
  if (distM(fwd.pt, pathArr[bi]) < span * 0.4) return null;
  const inB = bearing(back.pt, pathArr[bi]);
  const outB = bearing(pathArr[bi], fwd.pt);
  return { deg: signedTurn(inB, outB), offRoute: bd };
}

(async () => {
  const snap = await db.collection("companies").doc(CID).collection("routes").get();
  const routes = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) })).slice(0, MAX);
  console.log(`\n노선 ${routes.length}개 대상 — 카카오 실호출로 안내를 받아 앞뒤 방위각 차이를 잰다\n`);

  const rows = [];
  const allGuidances = [];
  let called = 0;
  for (const r of routes) {
    const st = await db.collection("companies").doc(CID).collection("routes").doc(r.id).collection("stops").orderBy("order").get();
    const pts = st.docs.map((d) => ll(d.data())).filter(Boolean);
    if (pts.length < 2) continue;
    const O = pts[0], D = pts[pts.length - 1], mid = pts.slice(1, -1).slice(0, 30);
    const res = await post({
      origin: { x: O.lng, y: O.lat }, destination: { x: D.lng, y: D.lat },
      waypoints: mid.map((p) => ({ x: p.lng, y: p.lat })),
      priority: "RECOMMEND", car_fuel: "DIESEL", summary: false,
    });
    called++;
    if (res.status !== 200) { console.log(`  ⏭ ${r.name} — HTTP ${res.status}`); continue; }
    const route = (JSON.parse(res.body).routes || [])[0];
    if (!route || route.result_code !== 0) { console.log(`  ⏭ ${r.name} — result_code ${route?.result_code}`); continue; }

    const P = [], guides = [];
    (route.sections || []).forEach((sec) => {
      (sec.roads || []).forEach((rd) => {
        const v = rd.vertexes || [];
        for (let i = 0; i + 1 < v.length; i += 2) P.push({ lat: Number(v[i + 1]), lng: Number(v[i]) });
      });
      (sec.guides || []).forEach((g) => {
        if (g.type === 100 || g.type === 1000) return;
        guides.push({ lat: Number(g.y), lng: Number(g.x), guidance: g.guidance || "", type: g.type });
      });
    });
    if (P.length < 10) continue;
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum[i] = cum[i - 1] + distM(P[i - 1], P[i]);

    guides.forEach((g) => allGuidances.push(g.guidance));
    for (const g of guides) {
      const cls = /지하차도/.test(g.guidance) ? (/옆길/.test(g.guidance) ? "지하-옆길" : "지하-진입")
        : /고가도로/.test(g.guidance) ? (/옆길/.test(g.guidance) ? "고가-옆길" : "고가-진입")
        : /좌회전/.test(g.guidance) ? "좌회전(대조군)"
        : /우회전/.test(g.guidance) ? "우회전(대조군)" : null;
      if (!cls) continue;
      const t30 = turnAtPoint(P, cum, g, 30);
      const t60 = turnAtPoint(P, cum, g, 60);
      rows.push({ route: r.name, cls, guidance: g.guidance, type: g.type,
        d30: t30 ? t30.deg : null, d60: t60 ? t60.deg : null });
    }
  }

  console.log(`카카오 호출 ${called}회 · 수집한 안내 ${rows.length}건\n`);

  // 🔴 지명에 도로 이름이 섞여 오판되던 문구가 prod 에 얼마나 있나(2026-08-06 발견 결함)
  const act = (s) => { const i = s.lastIndexOf("방면으로"); return i >= 0 ? s.slice(i + 4).trim() : s; };
  const bad = allGuidances.filter((s) => /지하차도|고가도로|톨게이트/.test(s) && !/지하차도|고가도로|톨게이트/.test(act(s)));
  console.log(`■ 지명 오탐(문구 전체엔 도로 이름이 있으나 실제 동작은 다름) — ${bad.length}/${allGuidances.length}건`);
  [...new Set(bad)].slice(0, 8).forEach((s) => console.log(`   · ${s}  →  실제 동작: ${act(s)}`));
  console.log();

  const byCls = {};
  rows.forEach((x) => { (byCls[x.cls] = byCls[x.cls] || []).push(x); });
  const fmt = (n) => (n === null ? "  –  " : `${n >= 0 ? "+" : ""}${n.toFixed(0)}°`);
  for (const [cls, list] of Object.entries(byCls)) {
    const with30 = list.filter((x) => x.d30 !== null);
    const decisive = with30.filter((x) => Math.abs(x.d30) >= 20);
    const agree = with30.filter((x) => x.d60 !== null && Math.sign(x.d30) === Math.sign(x.d60));
    console.log(`■ ${cls} — ${list.length}건 (각 측정 ${with30.length}건)`);
    console.log(`   |각| ≥ 20°: ${decisive.length}/${with30.length}` +
      `   30m·60m 부호 일치: ${agree.length}/${with30.filter((x) => x.d60 !== null).length}`);
    list.slice(0, 6).forEach((x) =>
      console.log(`   30m ${fmt(x.d30)} · 60m ${fmt(x.d60)}  [${x.type}] ${x.guidance.slice(0, 42)}`));
    if (list.length > 6) console.log(`   … 외 ${list.length - 6}건`);
    console.log();
  }
  process.exit(0);
})().catch((e) => { console.error("🔴", e.message); process.exit(1); });
