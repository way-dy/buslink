// NFC 카드 등록 현황 점검 (읽기 전용) — 도입 범위·등록 방식 판단용.
//   node scripts/inspect_nfc_status.cjs
//
// 보는 것: 회사별 승객 수 / 카드 등록 수 / 거래처·노선별 인원 분포(등록 대행 시 한 번에
// 몇 명을 상대해야 하는지) / 미등록 태깅(부정승차) 누적.
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

(async () => {
  const companies = await db.collection("companies").get();
  for (const c of companies.docs) {
    const cid = c.id;
    const ps = await c.ref.collection("passengers").get();
    if (ps.empty) continue;
    const all = ps.docs.map((d) => ({ empNo: d.id, ...d.data() }));
    const active = all.filter((p) => p.active !== false);
    const withCard = all.filter((p) => p.nfcUid);

    console.log(`\n=== ${cid} (${c.data().name || "-"}) ===`);
    console.log(`승객 ${all.length}명(활성 ${active.length}) · 카드 등록 ${withCard.length}명`);

    // 거래처별
    const byPartner = {};
    for (const p of active) {
      const k = p.partnerCode || "(거래처 미지정)";
      byPartner[k] = byPartner[k] || { n: 0, card: 0 };
      byPartner[k].n++;
      if (p.nfcUid) byPartner[k].card++;
    }
    console.log("\n  거래처별 인원 / 등록:");
    Object.entries(byPartner).sort((a, b) => b[1].n - a[1].n).forEach(([k, v]) => {
      console.log(`    ${String(v.n).padStart(4)}명  등록 ${v.card}  ${k}`);
    });

    // 노선별(등록 대행 1회에 상대할 인원 = 이 숫자)
    const routes = await c.ref.collection("routes").get();
    const routeName = {};
    routes.docs.forEach((r) => { routeName[r.id] = r.data().name || r.id; });
    const byRoute = {};
    for (const p of active) {
      const k = p.routeId || "(노선 미배정)";
      byRoute[k] = (byRoute[k] || 0) + 1;
    }
    const rows = Object.entries(byRoute).sort((a, b) => b[1] - a[1]);
    console.log(`\n  노선별 인원(상위 10 / 전체 ${rows.length}개 노선):`);
    rows.slice(0, 10).forEach(([k, n]) => console.log(`    ${String(n).padStart(4)}명  ${routeName[k] || k}`));
    const sizes = rows.map((r) => r[1]);
    if (sizes.length) {
      const mid = sizes.slice().sort((a, b) => a - b)[Math.floor(sizes.length / 2)];
      console.log(`    → 노선당 중앙값 ${mid}명 · 최대 ${Math.max(...sizes)}명`);
    }
  }

  // 미등록 태깅 누적(부정승차)
  const rej = await db.collection("nfcRejects").listDocuments();
  let total = 0;
  for (const d of rej) {
    const l = await d.collection("list").get();
    total += l.size;
  }
  console.log(`\n미등록 카드 태깅 기록: ${rej.length}일치 · ${total}건`);
  process.exit(0);
})().catch((e) => { console.error("실패:", e); process.exit(1); });
