// 채드윅 하교·방과후 — 첫 구간 계획 시간 보정 (2026-10-01 way 승인 «지금 적용»)
//   node scripts/apply_first_segment_offset.cjs            # dry-run(기본) — 바뀔 값만 출력
//   node scripts/apply_first_segment_offset.cjs --apply    # 백업 JSON 저장 후 반영
//   node scripts/apply_first_segment_offset.cjs --restore <백업.json>
//
// 근거 = scripts/inspect_eta_deviation.cjs (9/28~30 · GPS 궤적 보간 · 출발지=떠난 시각) 의
//   «첫 구간 계획 보정 후보» 중앙 오차. |중앙| ≥ 5분인 10개 노선만.
// 규칙 = 첫 정류장 이후(order 인덱스 ≥ 1) **모든** offsetMin 에서 같은 폭을 뺀다 — 첫 구간 뒤
//   구간 오차는 |중앙| 2분이라 정류장 간 간격은 그대로 둔다. 출발지(0)는 건드리지 않는다.
// 🔴 노선 식별은 이름 앞 코드+구분으로(같은 코드의 등교 노선을 건드리지 않게 KIND 동시 검사).
// 🔴 결과가 단조 증가가 아니거나 첫 정류장이 1분 미만이 되면 그 노선은 건너뛴다.
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const SHIFT = [ // [노선명 접두, 당기는 분]
  ["[G1] 방과후하교", 22], ["[H1-1] 하교", 17], ["[A] 하교", 13], ["[H1] 방과후하교", 11],
  ["[B] 하교", 7], ["[A] 방과후하교", 7], ["[S] 방과후하교", 7],
  ["[P] 하교", 6], ["[S] 하교", 5], ["[P] 방과후하교", 5],
];
const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
const sa = require(path.join(ROOT, "key", kf));
if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치");
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const COMPANY = "dy001";
const mode = process.argv[2] || "--dry-run";

(async () => {
  if (mode === "--restore") {
    const bk = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
    const batch = db.batch();
    for (const r of bk.routes) for (const s of r.stops)
      batch.update(db.doc(`companies/${COMPANY}/routes/${r.routeId}/stops/${s.id}`), { offsetMin: s.offsetMin });
    await batch.commit();
    console.log(`복원 완료 — 노선 ${bk.routes.length}개`);
    process.exit(0);
  }
  const rs = await db.collection("companies").doc(COMPANY).collection("routes").get();
  const chad = rs.docs.filter((d) => /채드윅/.test(d.data().partnerCode || ""));
  const backup = { at: new Date().toISOString(), routes: [] };
  const batch = db.batch();
  let n = 0;
  for (const [prefix, shift] of SHIFT) {
    const hits = chad.filter((d) => (d.data().name || "").startsWith(prefix + " "));
    if (hits.length !== 1) { console.log(`⚠ ${prefix}: 노선 ${hits.length}개 일치 — 건너뜀`); continue; }
    const rd = hits[0];
    const ss = await rd.ref.collection("stops").orderBy("order", "asc").get();
    const stops = ss.docs.map((d) => ({ id: d.id, offsetMin: d.data().offsetMin }));
    if (stops.some((s) => typeof s.offsetMin !== "number")) { console.log(`⚠ ${prefix}: offsetMin 숫자 아님 — 건너뜀`); continue; }
    const next = stops.map((s, i) => (i === 0 ? s.offsetMin : s.offsetMin - shift));
    const mono = next.every((v, i) => i === 0 || v > next[i - 1]);
    if (!mono || next[1] < 1) { console.log(`⚠ ${prefix}: 결과 비정상(${next}) — 건너뜀`); continue; }
    console.log(`${prefix.padEnd(14)} ${stops.map((s) => s.offsetMin).join(",")} → ${next.join(",")}  (−${shift})`);
    backup.routes.push({ routeId: rd.id, name: rd.data().name, stops });
    stops.forEach((s, i) => { if (i > 0) { batch.update(ss.docs[i].ref, { offsetMin: next[i] }); n++; } });
  }
  if (mode !== "--apply") { console.log(`\n(dry-run) 정류장 ${n}건 변경 예정 · 반영하려면 --apply`); process.exit(0); }
  const bkPath = path.join(ROOT, "scripts", "backups", `first_segment_offset_${Date.now()}.json`);
  fs.mkdirSync(path.dirname(bkPath), { recursive: true });
  fs.writeFileSync(bkPath, JSON.stringify(backup, null, 1));
  await batch.commit();
  console.log(`\n반영 완료 — 정류장 ${n}건 · 백업 ${path.relative(ROOT, bkPath)}`);
  process.exit(0);
})();
