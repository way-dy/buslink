// 승객 PIN 해시 이관 — passengers.pinHash → passengerSecrets/{empNo} (2026-08-28 P3-a)
//   점검(기본)   : node scripts/backfill_passenger_secrets.cjs
//   1단계 복사   : node scripts/backfill_passenger_secrets.cjs --apply
//   2단계 걷어내기: node scripts/backfill_passenger_secrets.cjs --strip --apply
//
// 🔴 두 단계를 **한 번에 하지 않는다**. 복사(1단계) 뒤 로그인이 정상인 것을 확인하고 나서
//    명부에서 걷어낸다(2단계). 서버 `readPinHash` 는 secrets 우선 → 명부 폴백이라,
//    1단계만 끝나도 동작은 그대로이고 2단계가 실제 노출을 없앤다.
// 🔴 트리거 확인함(2026-08-28): `passengers`·`passengerSecrets` 에 걸린 Firestore 트리거는
//    없다(index.js 의 트리거 4개는 fcmQueue·dispatches·improvement_requests 뿐).
//    그래서 이 백필은 알림을 하나도 깨우지 않는다.
// prod 데이터 write 라 `--apply` 는 way 승인 뒤에만.
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const COMPANY = process.env.COMPANY || "dy001";
const APPLY = process.argv.includes("--apply");
const STRIP = process.argv.includes("--strip");

function loadAdmin() {
  const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
  const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
  const sa = require(path.join(ROOT, "key", kf));
  if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치");
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(sa) });
  return admin;
}

(async () => {
  const admin = loadAdmin();
  const db = admin.firestore();
  const col = db.collection("companies").doc(COMPANY).collection("passengers");
  const secCol = db.collection("companies").doc(COMPANY).collection("passengerSecrets");

  console.log(`\n대상 회사 ${COMPANY} · 모드 ${STRIP ? "2단계 걷어내기" : "1단계 복사"} · ${APPLY ? "🔴 실제 반영" : "점검(dry-run)"}`);

  const snap = await col.get();
  const withHash = [];
  let noHash = 0;
  snap.forEach((d) => {
    const h = (d.data() || {}).pinHash;
    if (h) withHash.push({ empNo: d.id, pinHash: String(h) });
    else noHash++;
  });
  console.log(`명부 ${snap.size.toLocaleString()}건 · pinHash 보유 ${withHash.length.toLocaleString()} · 없음 ${noHash.toLocaleString()}`);

  // 이미 옮겨진 것 세기
  const secSnap = await secCol.get();
  const already = new Map();
  secSnap.forEach((d) => { const h = (d.data() || {}).pinHash; if (h) already.set(d.id, String(h)); });
  console.log(`secrets 기존 ${already.size.toLocaleString()}건`);

  if (!STRIP) {
    const todo = withHash.filter((p) => already.get(p.empNo) !== p.pinHash);
    const conflict = withHash.filter((p) => already.has(p.empNo) && already.get(p.empNo) !== p.pinHash);
    console.log(`\n[1단계] 복사 대상 ${todo.length.toLocaleString()}건` +
      (conflict.length ? ` · ⚠ 값이 다른 기존 secret ${conflict.length}건(secrets 가 최신일 수 있다 — 아래 규칙 확인)` : ""));
    // 🔴 값이 다르면 **명부 쪽이 낡은 것**이다: 그 사이 passengerSetPin/재발급이 secrets 를 갱신했다.
    //    덮어쓰면 방금 바꾼 비밀번호가 옛것으로 되돌아간다 → 건너뛴다.
    const safe = todo.filter((p) => !already.has(p.empNo));
    if (conflict.length) console.log(`  → 값 충돌 ${conflict.length}건은 **건너뛴다**(secrets 가 정본).`);
    console.log(`  실제 쓸 건수 ${safe.length.toLocaleString()}`);
    if (!APPLY) { console.log("\n점검만 했다. 반영하려면 --apply"); process.exit(0); }
    const writer = db.bulkWriter();
    let done = 0;
    for (const p of safe) {
      writer.set(secCol.doc(p.empNo), {
        companyId: COMPANY, empNo: p.empNo, pinHash: p.pinHash,
        migratedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      if (++done % 2000 === 0) console.log(`  ... ${done.toLocaleString()}`);
    }
    await writer.close();
    console.log(`\n✅ 복사 완료 ${safe.length.toLocaleString()}건`);
    process.exit(0);
  }

  // ── 2단계: 명부에서 pinHash 를 걷어낸다 ─────────────────────────────
  // 🔴 **secrets 에 같은 값이 있는 문서만** 지운다. 안 옮겨진 사람의 해시를 지우면
  //    그 사람은 그 순간 로그인 불가가 된다(폴백까지 사라지므로).
  const strippable = withHash.filter((p) => already.get(p.empNo) === p.pinHash);
  const notMigrated = withHash.filter((p) => already.get(p.empNo) !== p.pinHash);
  console.log(`\n[2단계] 걷어낼 대상 ${strippable.length.toLocaleString()}건` +
    (notMigrated.length ? ` · 🔴 아직 안 옮겨진 ${notMigrated.length}건은 **건드리지 않는다**` : ""));
  if (notMigrated.length) console.log(`  → 1단계를 먼저 끝낼 것(${notMigrated.slice(0, 5).map((p) => p.empNo).join(", ")}…)`);
  if (!APPLY) { console.log("\n점검만 했다. 반영하려면 --strip --apply"); process.exit(0); }
  const writer = db.bulkWriter();
  let done = 0;
  for (const p of strippable) {
    writer.update(col.doc(p.empNo), { pinHash: admin.firestore.FieldValue.delete() });
    if (++done % 2000 === 0) console.log(`  ... ${done.toLocaleString()}`);
  }
  await writer.close();
  console.log(`\n✅ 명부에서 해시 제거 ${strippable.length.toLocaleString()}건`);
  process.exit(0);
})();
