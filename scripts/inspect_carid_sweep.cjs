// 일회성 진단 (읽기 전용) — "이 노선을 실제로 지난 단말(carId)은 누구인가" 를 busin 원천에서 직접 찾는다.
// BusLink 등록 여부와 무관하게 carId 범위를 훑어 노선 정류장 통과를 채점한다.
// 사용: node scripts/inspect_carid_sweep.cjs 2026-09-21 <routeId> 5005 5030
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
const [DATE, ROUTE_ID, FROM, TO] = process.argv.slice(2);

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false, timeout: 25000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    }).on("error", reject).on("timeout", function () { this.destroy(); reject(new Error("timeout")); });
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
function hav(a, b, c, d) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (c - a) * rad, dLng = (d - b) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a * rad) * Math.cos(c * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const hhmm = (s) => {
  const k = String(s).match(/(오전|오후)\s*(\d{1,2}):(\d{2})/);
  if (!k) { const m = String(s).match(/(\d{1,2}):(\d{2})/); return m ? `${m[1].padStart(2, "0")}:${m[2]}` : "--:--"; }
  let h = parseInt(k[2], 10);
  if (k[1] === "오전") { if (h === 12) h = 0; } else if (h !== 12) h += 12;
  return `${String(h).padStart(2, "0")}:${k[3]}`;
};

(async () => {
  const ss = await db.collection("companies").doc(CID).collection("routes").doc(ROUTE_ID).collection("stops").orderBy("order").get();
  const stops = ss.docs.map((s) => s.data()).filter((s) => typeof s.lat === "number");
  const r = await db.collection("companies").doc(CID).collection("routes").doc(ROUTE_ID).get();
  console.log(`■ 노선 "${(r.data() || {}).name}" 정류장 ${stops.length}개 · ${DATE} · carId ${FROM}~${TO} 훑기`);

  // busin 편성표로 carId → 차량번호
  const alloc = {};
  try {
    parseRows(await get("https://dr.busin.co.kr:4431/api/CarAlloc.aspx?drv=1")).forEach((a) => {
      const id = String(a["차량ID"] || "").trim();
      if (id && !alloc[id]) alloc[id] = { plate: (a["차량번호"] || "").trim(), owner: (a["소속"] || "").trim() };
    });
  } catch (e) { console.log("편성표 조회 실패:", e.message); }

  const out = [];
  for (let id = Number(FROM); id <= Number(TO); id++) {
    let rows;
    try {
      rows = parseRows(await get(`https://dr.busin.co.kr/api/CarLocationAll.aspx?carid=${id}&date=${DATE}`));
    } catch (e) { continue; }
    const pts = rows.map((v) => ({
      lat: parseFloat(v["위도"] || "0"), lng: parseFloat(v["경도"] || "0"), t: hhmm(v["일시"] || ""),
    })).filter((p) => p.lat && p.lng);
    if (pts.length < 5) continue;
    const near = stops.map((s) => {
      let best = Infinity, bt = null;
      pts.forEach((p) => { const dm = hav(s.lat, s.lng, p.lat, p.lng); if (dm < best) { best = dm; bt = p.t; } });
      return { name: s.name, m: Math.round(best), t: bt };
    });
    const sorted = near.map((n) => n.m).sort((a, b) => a - b);
    const hit = near.filter((n) => n.m <= 300).length;
    out.push({ id, plate: (alloc[id] || {}).plate || "?", owner: (alloc[id] || {}).owner || "", n: pts.length, first: pts[0].t, last: pts[pts.length - 1].t, hit, med: sorted[Math.floor(sorted.length / 2)], near });
  }
  out.sort((a, b) => b.hit - a.hit || a.med - b.med);
  out.forEach((o) => console.log(`  ${String(o.hit).padStart(2)}/${stops.length} · 중앙 ${String(o.med).padStart(5)}m · carId ${String(o.id).padEnd(5)} ${String(o.plate).padEnd(14)} ${o.owner.padEnd(10)} ${o.n}점 ${o.first}~${o.last}`));
  const top = out[0];
  if (top && top.hit > 1) {
    console.log(`\n  ▸ 1위 carId ${top.id} (${top.plate}) 정류장별 최근접`);
    top.near.forEach((n) => console.log(`    ${n.m <= 300 ? "✅" : "❌"} ${String(n.name).padEnd(26)} ${String(n.m).padStart(5)}m @${n.t}`));
  }
  process.exit(0);
})();
