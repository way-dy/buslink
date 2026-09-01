// 「내 정류장·탑승 노선 불일치」 영향 인원을 거래처별로 센다 (읽기 전용) — 2026-09-01.
//   node scripts/inspect_mystop_impact_by_partner.cjs
//
// 층을 나눠 센다 — 「걸릴 수 있었다」와 「실제로 걸렸다」는 다른 수다.
//   ⓐ 노출  = 즐겨찾기가 있는데 배정 노선이 거기 없다(홈이 튕기는 조건)
//   ⓑ 실피해 = 그 상태에서 **내 정류장을 실제로 지정**했고 그 노선이 배정 노선과 다르다
//              (= 화면은 A 노선, 스캐너는 B 노선 → "선택한 노선의 차량이 아닙니다")
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
const cid = "dy001";

(async () => {
  const routesSnap = await db.collection("companies").doc(cid).collection("routes").get();
  const routeName = new Map(routesSnap.docs.map((d) => [d.id, (d.data() || {}).name || d.id]));

  // fcmTokens 전건(내 정류장 지정 실값) — 승객 수보다 훨씬 작다.
  const tSnap = await db.collection("companies").doc(cid).collection("fcmTokens").get();
  const tok = new Map(tSnap.docs.map((d) => [d.id, d.data() || {}]));
  console.log(`fcmTokens 문서 ${tSnap.size}건 · 그중 내 정류장 지정 ${[...tok.values()].filter(t => t.stopId).length}명\n`);

  const psSnap = await db.collection("companies").doc(cid).collection("passengers").get();
  const per = new Map(); // partner -> {total, fav, exposed, hit, rows:[]}
  const bump = (k) => { if (!per.has(k)) per.set(k, { total: 0, fav: 0, exposed: 0, hit: 0, rows: [] }); return per.get(k); };

  for (const d of psSnap.docs) {
    const v = d.data() || {};
    const p = bump(v.partnerName || v.partnerCode || "(거래처 없음)");
    p.total++;
    const favs = Array.isArray(v.favorites) ? v.favorites.filter(Boolean) : [];
    if (!favs.length) continue;
    p.fav++;
    const exposed = !v.routeId || !favs.includes(v.routeId);
    if (!exposed) continue;
    p.exposed++;
    const t = tok.get(d.id);
    // 실피해 = 내 정류장을 지정했는데 그 노선이 스캐너가 보내는 노선(배정)과 다르다
    if (t && t.stopId && t.routeId && t.routeId !== v.routeId) {
      p.hit++;
      p.rows.push({ empNo: d.id, name: v.name || "",
        assigned: routeName.get(v.routeId) || v.routeId || "(배정없음)",
        myStop: routeName.get(t.routeId) || t.routeId,
        at: t.myStopUpdatedAt?.toDate?.().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) || "-" });
    }
  }

  console.log("거래처                        승객수   즐겨찾기  노출   🔴실피해");
  const sorted = [...per.entries()].sort((a, b) => b[1].hit - a[1].hit || b[1].exposed - a[1].exposed);
  for (const [name, s] of sorted) {
    if (!s.fav && !s.hit) continue;
    console.log(`${name.padEnd(28)}${String(s.total).padStart(7)}${String(s.fav).padStart(10)}${String(s.exposed).padStart(7)}${String(s.hit).padStart(9)}`);
  }
  const totHit = sorted.reduce((a, [, s]) => a + s.hit, 0);
  const totExp = sorted.reduce((a, [, s]) => a + s.exposed, 0);
  console.log(`${"합계".padEnd(28)}${String(psSnap.size).padStart(7)}${"".padStart(10)}${String(totExp).padStart(7)}${String(totHit).padStart(9)}`);

  console.log("\n🔴 실피해자 — 내 정류장 노선 ≠ 스캐너가 보내는 노선");
  for (const [name, s] of sorted) {
    for (const r of s.rows) {
      console.log(`  [${name}] ${r.empNo} ${r.name} · 배정(스캐너)=${r.assigned} · 내정류장=${r.myStop} · 지정 ${r.at}`);
    }
  }
  process.exit(0);
})();
