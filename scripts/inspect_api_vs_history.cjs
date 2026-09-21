// 일회성 진단 (읽기 전용) — busin 원천 API 와 BusLink gpsHistory 를 **점 단위로** 대조.
// "API 데이터와 운행이력이 안 맞는다" 를 범위가 아니라 행마다 확인한다.
// 사용: node scripts/inspect_api_vs_history.cjs 2026-09-21 5014
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
const [DATE, CARID] = process.argv.slice(2);

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
// functions/index.js parseBusinFixMs 미러 (오전 12시 = 자정 · 초까지 · KST)
function fixMs(timeStr, dateStr) {
  const s = String(timeStr || "");
  const dm = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  const d = dm ? [dm[1], dm[2], dm[3]] : String(dateStr).split("-");
  let h = null, mi = null, sec = 0;
  const k = s.match(/(오전|오후)\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (k) {
    h = parseInt(k[2], 10);
    if (k[1] === "오전") { if (h === 12) h = 0; } else if (h !== 12) h += 12;
    mi = parseInt(k[3], 10); sec = k[4] ? parseInt(k[4], 10) : 0;
  } else {
    const rest = dm ? s.slice(s.indexOf(dm[0]) + dm[0].length) : s;
    const t = rest.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!t) return null;
    h = parseInt(t[1], 10); mi = parseInt(t[2], 10); sec = t[3] ? parseInt(t[3], 10) : 0;
  }
  return Date.UTC(+d[0], +d[1] - 1, +d[2], h, mi, sec) - 9 * 3600 * 1000;
}
const kst = (ms) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(11, 19);
const toMs = (v) => (v && v.toMillis ? v.toMillis() : (typeof v === "number" ? v : null));
function hav(a, b, c, d) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (c - a) * rad, dLng = (d - b) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a * rad) * Math.cos(c * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

(async () => {
  // ① API
  const rows = parseRows(await get(`https://dr.busin.co.kr/api/CarLocationAll.aspx?carid=${CARID}&date=${DATE}`));
  const api = rows.map((v) => ({
    raw: v["일시"] || "", lat: parseFloat(v["위도"] || "0"), lng: parseFloat(v["경도"] || "0"),
  })).filter((p) => p.lat && p.lng).map((p) => ({ ...p, ms: fixMs(p.raw, DATE) })).filter((p) => p.ms !== null)
    .sort((a, b) => a.ms - b.ms);

  // ② 차량 찾기 + gpsHistory
  const vs = await db.collection("companies").doc(CID).collection("vehicles").get();
  const veh = vs.docs.find((d) => String(d.data().carId) === String(CARID));
  const ps = await db.collection("gpsHistory").doc(CID).collection(veh.id).doc(DATE).collection("points").orderBy("ts", "asc").get();
  const his = ps.docs.map((d) => ({ id: d.id, lat: d.data().lat, lng: d.data().lng, ms: toMs(d.data().ts) })).filter((p) => p.ms);

  console.log(`■ ${DATE} · carId=${CARID} (${veh.data().plateNo})`);
  console.log(`  API 원천      ${String(api.length).padStart(3)}행  ${kst(api[0].ms)} ~ ${kst(api[api.length - 1].ms)}`);
  console.log(`  gpsHistory    ${String(his.length).padStart(3)}건  ${his.length ? kst(his[0].ms) + " ~ " + kst(his[his.length - 1].ms) : "-"}`);

  // ③ 측정 시각(초)으로 맞춘다
  const hByMs = new Map(his.map((p) => [p.ms, p]));
  let matched = 0, moved = 0, maxGapM = 0;
  const missing = [];
  for (const a of api) {
    const h = hByMs.get(a.ms);
    if (!h) { missing.push(a); continue; }
    matched++;
    const d = hav(a.lat, a.lng, h.lat, h.lng);
    if (d > 1) { moved++; if (d > maxGapM) maxGapM = d; }
  }
  const extra = his.filter((p) => !api.some((a) => a.ms === p.ms));

  console.log(`\n■ 점 단위 대조 (측정 시각 초 단위로 매칭)`);
  console.log(`  일치(시각+좌표)  ${matched}건  · 좌표 1m 초과 어긋남 ${moved}건 (최대 ${Math.round(maxGapM)}m)`);
  console.log(`  API 에만 있음    ${missing.length}건  ← 운행이력에서 빠진 것`);
  console.log(`  이력에만 있음    ${extra.length}건  ← 원천에 없는 것`);
  if (extra.length) extra.slice(0, 10).forEach((p) => console.log(`     ${kst(p.ms)} ${p.lat},${p.lng} id=${p.id}`));

  // ④ 빠진 행이 어느 구간인지
  if (missing.length) {
    const before = missing.filter((p) => his.length && p.ms < his[0].ms);
    const after = missing.filter((p) => his.length && p.ms > his[his.length - 1].ms);
    const middle = missing.filter((p) => his.length && p.ms >= his[0].ms && p.ms <= his[his.length - 1].ms);
    console.log(`\n  빠진 위치: 이력 시작 전 ${before.length}건 · 중간 ${middle.length}건 · 이력 끝 뒤 ${after.length}건`);
    if (before.length) console.log(`    시작 전  ${kst(before[0].ms)} ~ ${kst(before[before.length - 1].ms)}`);
    if (middle.length) middle.forEach((p) => console.log(`    🔴 중간  ${kst(p.ms)} ${p.lat},${p.lng}`));
    if (after.length) console.log(`    끝 뒤    ${kst(after[0].ms)} ~ ${kst(after[after.length - 1].ms)}`);
  }

  // ⑤ 운행이력 화면이 실제로 그리는 구간(배차 필터 적용 후)
  const ds = await db.collection("companies").doc(CID).collection("dispatches").doc(DATE).collection("list").get();
  const disp = ds.docs.map((d) => d.data()).filter((v) => v.vehicleId === veh.id);
  for (const v of disp) {
    const [H, M] = String(v.departTime).split(":").map(Number);
    const base = Date.UTC(...DATE.split("-").map((x, i) => (i === 1 ? +x - 1 : +x))) - 9 * 3600 * 1000;
    const start = base + (H * 60 + M - 5) * 60000;
    let lastActual = null;
    Object.values(v.stopArrivals || {}).forEach((a) => { const m = toMs(a && a.actualAt); if (m && (!lastActual || m > lastActual)) lastActual = m; });
    const end = lastActual ? lastActual + 10 * 60000 : start + 3 * 3600 * 1000;
    const shown = his.filter((p) => p.ms >= start && p.ms <= end);
    console.log(`\n■ 운행이력 화면 (배차 ${v.departTime} ${v.routeName})`);
    console.log(`  필터 ${kst(start)} ~ ${kst(end)}  → 화면에 ${shown.length}점  (적재 ${his.length} · 원천 ${api.length})`);
    console.log(`  끝 시각 근거: ${lastActual ? "마지막 도착기록 " + kst(lastActual) + " + 10분" : "도착기록 없음 → 출발+3시간"}`);
  }
  process.exit(0);
})();
