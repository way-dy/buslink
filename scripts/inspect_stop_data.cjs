// 정류장 데이터 충실도 점검 (읽기 전용) — 길안내·초보 기사 지원 기능 설계 근거용.
//   node scripts/inspect_stop_data.cjs
//
// 길안내는 좌표가 있어야 하고, "여기서 세우세요" 사진 안내는 photo 가 있어야 한다.
// 기능을 만들기 전에 **데이터가 실제로 채워져 있는지** 먼저 본다.
const fs = require("fs");
const path = require("path");
const admin = require(path.join(__dirname, "..", "functions", "node_modules", "firebase-admin"));

const kd = path.join(__dirname, "..", "key");
const kf = fs.existsSync(kd) && fs.readdirSync(kd).find((f) => f.endsWith(".json"));
if (!kf) { console.error("❌ key/*.json 없음"); process.exit(1); }
const key = require(path.join(kd, kf));
if (key.project_id !== "buslink-prod") { console.error(`❌ project_id 불일치: ${key.project_id}`); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();

// 좌표 4형식 흡수(issues.md toLatLng 계약과 동일 의미)
function ll(v) {
  const la = Number(v.lat ?? v.latitude ?? v.location?.latitude);
  const lo = Number(v.lng ?? v.longitude ?? v.location?.longitude);
  return Number.isFinite(la) && Number.isFinite(lo) && la !== 0 && lo !== 0;
}

// 노선명(일부)을 주면 그 노선만 상세 — 경로 점 분포·정류장과의 관계를 본다.
const QUERY = (process.argv[2] || "").trim();

async function detail(cid, q) {
  const routes = await db.collection("companies").doc(cid).collection("routes").get();
  const hit = routes.docs.filter((r) => (r.data().name || "").includes(q));
  if (!hit.length) { console.log(`'${q}' 노선 없음`); return; }
  for (const r of hit) {
    const d = r.data();
    const rp = Array.isArray(d.routePath) ? d.routePath : [];
    console.log(`\n=== ${d.name} (${r.id}) ===`);
    console.log(`  출발시각 ${d.departTime || "-"} · 경로 점 ${rp.length}개`);
    if (rp.length >= 2) {
      console.log(`  경로 시작 (${rp[0].lat}, ${rp[0].lng})`);
      console.log(`  경로 끝   (${rp[rp.length - 1].lat}, ${rp[rp.length - 1].lng})`);
    }
    const st = await r.ref.collection("stops").orderBy("order", "asc").get();
    console.log(`  정류장 ${st.size}개:`);
    st.docs.forEach((s, i) => {
      const v = s.data();
      const p = ll(v);
      // 각 정류장이 경로에서 얼마나 떨어져 있나 = 경로가 정류장을 실제로 지나는가
      let near = "-";
      if (p && rp.length) {
        let best = Infinity;
        for (const q2 of rp) {
          const dx = (Number(q2.lat) - Number(v.lat ?? v.latitude ?? v.location?.latitude)) * 111000;
          const dy = (Number(q2.lng) - Number(v.lng ?? v.longitude ?? v.location?.longitude)) * 88000;
          const dd = Math.hypot(dx, dy);
          if (dd < best) best = dd;
        }
        near = `${Math.round(best)}m`;
      }
      console.log(`    ${String(i + 1).padStart(2)}. ${v.name || s.id}  좌표 ${p ? "O" : "X"} · 경로와의 최단거리 ${near}`);
    });
  }
}

(async () => {
  if (QUERY) { await detail("dy001", QUERY); process.exit(0); }
  const companies = await db.collection("companies").get();
  for (const c of companies.docs) {
    const routes = await c.ref.collection("routes").get();
    if (routes.empty) continue;
    let tot = 0, ok = 0, ph = 0, de = 0, off = 0, rp = 0;
    const thin = [];
    for (const r of routes.docs) {
      const rd = r.data();
      if (Array.isArray(rd.routePath) && rd.routePath.length > 1) rp++;
      const st = await r.ref.collection("stops").get();
      let rOk = 0;
      for (const s of st.docs) {
        const v = s.data();
        tot++;
        if (ll(v)) { ok++; rOk++; }
        if (v.photo) ph++;
        if (v.description) de++;
        if (typeof v.offsetMin === "number") off++;
      }
      if (st.size && rOk < st.size) thin.push(`${rd.name || r.id}: 좌표 ${rOk}/${st.size}`);
    }
    if (!tot) continue;
    const pc = (n) => `${n} (${Math.round((n / tot) * 100)}%)`;
    console.log(`\n=== ${c.id} (${c.data().name || "-"}) ===`);
    console.log(`노선 ${routes.size}개 · 경로 그려진 노선 ${rp}개 · 정류장 ${tot}개`);
    console.log(`  좌표          ${pc(ok)}   ← 길안내 가능 조건`);
    console.log(`  사진          ${pc(ph)}   ← "여기서 세우세요" 안내 조건`);
    console.log(`  설명          ${pc(de)}`);
    console.log(`  진입시각      ${pc(off)}`);
    if (thin.length) {
      console.log(`  ⚠ 좌표 빠진 노선 ${thin.length}개:`);
      thin.slice(0, 8).forEach((t) => console.log(`      ${t}`));
    }
    // 경로(routePath) 미설정 노선 — 길안내·승객앱 지도에서 정류장 직선으로 폴백된다.
    const noPath = routes.docs.filter((r) => {
      const p = r.data().routePath;
      return !Array.isArray(p) || p.length < 2;
    });
    console.log(`\n  ⚠ 경로 미설정 노선 ${noPath.length}개 (길안내가 직선으로 표시됨):`);
    noPath.forEach((r) => {
      const d = r.data();
      console.log(`      ${d.name || r.id}  (${r.id})`);
    });
    // 그려진 노선의 경로 촘촘함 — 점이 너무 적으면 그것도 직선처럼 보인다.
    const drawn = routes.docs.filter((r) => Array.isArray(r.data().routePath) && r.data().routePath.length >= 2);
    const pts = drawn.map((r) => r.data().routePath.length).sort((a, b) => a - b);
    if (pts.length) {
      console.log(`\n  그려진 노선 ${pts.length}개의 경로 점 개수: 최소 ${pts[0]} · 중앙 ${pts[Math.floor(pts.length / 2)]} · 최대 ${pts[pts.length - 1]}`);
      const coarse = drawn.filter((r) => r.data().routePath.length < 10);
      if (coarse.length) {
        console.log(`  ⚠ 점 10개 미만(직선처럼 보일 수 있음) ${coarse.length}개:`);
        coarse.slice(0, 6).forEach((r) => console.log(`      ${r.data().name || r.id}: ${r.data().routePath.length}점`));
      }
    }
  }
  process.exit(0);
})().catch((e) => { console.error("실패:", e); process.exit(1); });
