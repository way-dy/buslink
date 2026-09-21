// 일회성 진단 (읽기 전용) — busin 운행편성(CarAlloc) 에서 차량번호↔차량ID(carId) 매핑만 뽑아 대조.
// 사용: node scripts/inspect_busin_alloc.cjs --plate 6626
//       node scripts/inspect_busin_alloc.cjs --carid 5014
const https = require("https");
const URL_ALLOC = "https://dr.busin.co.kr:4431/api/CarAlloc.aspx?drv=1";

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false, timeout: 20000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    }).on("error", reject);
  });
}
const strip = (h) => h.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();

(async () => {
  const html = await get(URL_ALLOC);
  const trs = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  let headers = null;
  const rows = [];
  for (const tr of trs) {
    const th = (tr.match(/<th[\s\S]*?<\/th>/gi) || []).map(strip);
    const td = (tr.match(/<td[\s\S]*?<\/td>/gi) || []).map(strip);
    if (th.length && !headers) { headers = th; continue; }
    if (!headers && td.length) { headers = td; continue; }
    if (td.length && headers) {
      const o = {};
      headers.forEach((h, i) => { o[h] = td[i] || ""; });
      rows.push(o);
    }
  }
  const mode = process.argv[2];
  const q = process.argv[3] || "";
  const seen = new Set();
  rows.forEach((r) => {
    const plate = r["차량번호"] || "";
    const carId = r["차량ID"] || "";
    const owner = r["소속"] || "";
    const drv = r["기사명"] || "";
    const hit = mode === "--carid" ? String(carId) === q : plate.includes(q);
    if (!hit) return;
    const k = plate + "|" + carId + "|" + drv;
    if (seen.has(k)) return;
    seen.add(k);
    console.log(`  차량번호=${plate.padEnd(14)} 차량ID=${String(carId).padEnd(6)} 소속=${owner.padEnd(10)} 기사=${drv} 운행가능=${r["운행가능여부"]} 종료일=${r["운행종료일"] || "-"}`);
  });
  console.log(`(편성 ${rows.length}건 중 매칭 ${seen.size}건)`);
})();
