// 일회성 진단 (읽기 전용) — 노선 표시창 종료시각(displayEnd) 권장값 산출.
// busin 원천에서 "종점 300m 안에 처음 들어온 시각"을 찾아 현재 displayEnd 와 비교한다.
// 창이 종점 도착보다 이르면 그 노선은 종점 도착이 영영 기록되지 않는다.
// 사용: node scripts/inspect_display_end_recommend.cjs 2026-09-21
const fs = require("fs");
const path = require("path");
const https = require("https");
const admin = require(path.join(__dirname, "..", "functions", "node_modules", "firebase-admin"));
const kd = path.join(__dirname, "..", "key");
const key = require(path.join(kd, fs.readdirSync(kd).find((f) => f.endsWith(".json"))));
if (key.project_id !== "buslink-prod") process.exit(1);
admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();

const CID = "dy001";
const DATE = process.argv[2];
const MARGIN_MIN = 15; // 종점 도착 뒤 여유

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false, timeout: 25000 }, (res) => {
      const c = [];
      res.on("data", (x) => c.push(x));
      res.on("end", () => resolve(Buffer.concat(c).toString("utf8")));
    }).on("error", reject);
  });
}
const strip = (h) => h.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
function parseRows(html) {
  const trs = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  let headers = null;
  const rows = [];
  for (const tr of trs) {
    const th = (tr.match(/<th[\s\S]*?<\/th>/gi) || []).map(strip);
    const td = (tr.match(/<td[\s\S]*?<\/td>/gi) || []).map(strip);
    if (th.length && !headers) { headers = th; continue; }
    if (!headers && td.length) { headers = td; continue; }
    if (td.length && headers) { const o = {}; headers.forEach((h, i) => { o[h] = td[i] || ""; }); rows.push(o); }
  }
  return rows;
}
const toMin = (s) => {
  const k = String(s).match(/(오전|오후)\s*(\d{1,2}):(\d{2})/);
  if (k) { let h = parseInt(k[2], 10); if (k[1] === "오전") { if (h === 12) h = 0; } else if (h !== 12) h += 12; return h * 60 + parseInt(k[3], 10); }
  const m = String(s).match(/(\d{1,2}):(\d{2})/);
  return m ? +m[1] * 60 + +m[2] : null;
};
const hhmm = (n) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
function hav(a, b, c, d) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (c - a) * rad, dLng = (d - b) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a * rad) * Math.cos(c * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

(async () => {
  const comp = await db.collection("companies").doc(CID).get();
  const R = (comp.data() || {}).stopArriveRadiusM || 100;
  const vs = await db.collection("companies").doc(CID).collection("vehicles").get();
  const vmap = {};
  vs.docs.forEach((d) => { vmap[d.id] = d.data(); });
  const ds = await db.collection("companies").doc(CID).collection("dispatches").doc(DATE).collection("list").get();

  console.log(`■ ${DATE} · 오전 배차 종점 도착 실측 → displayEnd 권장 (반경 ${R}m · 여유 ${MARGIN_MIN}분)`);
  console.log("노선                      현재창        종점예정  종점실도착  판정   권장 displayEnd");
  const seen = new Set();
  for (const d of ds.docs) {
    const v = d.data();
    if (!/^0[4-9]:/.test(v.departTime || "") || !v.routeId || !v.vehicleId) continue;
    if (seen.has(v.routeId)) continue;
    seen.add(v.routeId);
    const veh = vmap[v.vehicleId];
    if (!veh || !veh.carId) continue;
    const r = await db.collection("companies").doc(CID).collection("routes").doc(v.routeId).get();
    const rv = r.data() || {};
    const ss = await db.collection("companies").doc(CID).collection("routes").doc(v.routeId).collection("stops").orderBy("order").get();
    const stops = ss.docs.map((s) => s.data()).filter((s) => typeof s.lat === "number");
    if (!stops.length) continue;
    const last = stops[stops.length - 1];
    let rows;
    try { rows = parseRows(await get(`https://dr.busin.co.kr/api/CarLocationAll.aspx?carid=${veh.carId}&date=${DATE}`)); } catch (e) { continue; }
    const dep = toMin(rv.departTime);
    const pts = rows.map((x) => ({ lat: parseFloat(x["위도"] || "0"), lng: parseFloat(x["경도"] || "0"), m: toMin(x["일시"] || "") }))
      .filter((p) => p.lat && p.lng && p.m !== null && (dep === null || p.m >= dep - 10))
      .sort((a, b) => a.m - b.m);
    let arriveMin = null, best = Infinity;
    for (const p of pts) {
      const dm = hav(last.lat, last.lng, p.lat, p.lng);
      if (dm < best) best = dm;
      if (dm <= R) { arriveMin = p.m; break; }
    }
    const planned = dep !== null && typeof last.offsetMin === "number" ? dep + last.offsetMin : null;
    const endMin = toMin(rv.displayEnd);
    const ok = arriveMin !== null && endMin !== null && arriveMin <= endMin;
    const rec = arriveMin !== null ? hhmm(Math.min(1439, arriveMin + MARGIN_MIN)) : "—";
    const flag = arriveMin === null ? "⚠도착못찾음" : (ok ? "  정상  " : "🔴 창밖 ");
    console.log(
      `${String(rv.name).slice(0, 24).padEnd(25)} ${((rv.displayStart || "-") + "~" + (rv.displayEnd || "-")).padEnd(13)} ` +
      `${(planned !== null ? hhmm(planned) : "--:--").padEnd(9)} ${(arriveMin !== null ? hhmm(arriveMin) : "(최근접 " + Math.round(best) + "m)").padEnd(11)} ${flag} ${ok ? "" : rec}`
    );
  }
  process.exit(0);
})();
