// 읽기 전용 — 통합 운행일 설정의 «쓰기 경로» 를 샘플 거래처로 검증해도 되는지 재 본다.
//   node scripts/inspect_bulk_sample_scope.cjs
// 🔴 쓰기 0. 어떤 거래처가 몇 개 일정을 갖는지, 그 일정으로 이미 펼쳐진 배차가 있는지만 센다.
const path = require("path");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
const sa = require(path.join(ROOT, "key", kf));
if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치");
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const COMPANY = "dy001";

(async () => {
  const [rs, ss] = await Promise.all([
    db.collection("companies").doc(COMPANY).collection("routes").get(),
    db.collection("companies").doc(COMPANY).collection("dispatchSchedules").get(),
  ]);
  const routes = new Map(rs.docs.map(d => [d.id, { id: d.id, ...d.data() }]));
  const byPartner = new Map();
  ss.docs.forEach(d => {
    const s = { id: d.id, ...d.data() };
    const r = routes.get(s.routeId);
    const key = r?.partnerCode || "(거래처 없음)";
    const name = r?.partnerName || key;
    const e = byPartner.get(key) || { name, total: 0, active: 0, ids: [] };
    e.total++; if (s.active !== false) { e.active++; e.ids.push(s.id); }
    byPartner.set(key, e);
  });
  console.log("거래처별 배차 일정 수 (활성/전체)");
  [...byPartner.entries()].sort((a, b) => b[1].active - a[1].active)
    .forEach(([code, e]) => console.log(`  ${String(e.active).padStart(3)} / ${String(e.total).padStart(3)}  ${e.name}   [${code}]`));

  const SAMPLE = [...byPartner.entries()].find(([c]) => /샘플|SMPL/i.test(c));
  if (!SAMPLE) { console.log("\n샘플 거래처의 배차 일정이 없다 — 쓰기 경로는 샘플로 검증 불가."); return; }
  console.log(`\n샘플 거래처 = ${SAMPLE[1].name} · 활성 일정 ${SAMPLE[1].active}개`);
  // 그 일정으로 이미 펼쳐진 배차(앞으로 14일)가 있는지 — 있으면 검증이 그것을 지우게 된다.
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  let expanded = 0;
  for (let i = 0; i < 14; i++) {
    const day = new Date(Date.parse(`${today}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10);
    const snap = await db.collection("companies").doc(COMPANY).collection("dispatches").doc(day).collection("list").get();
    snap.docs.forEach(d => { if (SAMPLE[1].ids.includes((d.data() || {}).scheduleId)) expanded++; });
  }
  console.log(`이미 펼쳐진 배차(오늘~+13일): ${expanded}건`);
  console.log(expanded === 0
    ? "→ 쓰기 경로를 샘플로 검증해도 삭제될 배차가 없다(excludeDates 만 바뀌고 원복 가능)."
    : "→ 검증하면 이 배차들이 삭제 대상이 된다. 되돌리려면 「지금 펼치기」가 필요하다.");
})();
