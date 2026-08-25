// 승객 명부 인증 전제 실측 — 2026-08-25 QR 본인확인 설계용. **읽기 전용**(prod 쓰기 0).
//   node scripts/inspect_passenger_auth_fields.cjs
// 보는 것: pinHash 보유율 · active 필드 분포 · 문서에 담긴 필드 종류(PII 노출 범위 판단용).
const path = require("path");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
const sa = require(path.join(ROOT, "key", kf));
if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치");
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

(async () => {
  const snap = await db.collection("companies").doc("dy001").collection("passengers").get();
  const n = snap.size;
  let noPin = 0, inactive = 0, pinInitial = 0, pinLocked = 0;
  const fieldCount = {};
  const noPinIds = [];
  snap.forEach((d) => {
    const p = d.data() || {};
    Object.keys(p).forEach((k) => { fieldCount[k] = (fieldCount[k] || 0) + 1; });
    if (!p.pinHash) { noPin++; if (noPinIds.length < 10) noPinIds.push(d.id); }
    if (p.active === false) inactive++;
    if (p.pinInitial) pinInitial++;
    if (p.pinLocked) pinLocked++;
  });
  console.log(`\n승객 ${n}명 (companies/dy001/passengers)`);
  console.log(`  pinHash 없음 ${noPin}명${noPin ? " → " + noPinIds.join(", ") : ""}`);
  console.log(`  active===false ${inactive}명 · pinInitial ${pinInitial}명 · pinLocked ${pinLocked}명`);
  console.log("\n필드별 보유 문서 수(익명 read 로 노출되는 범위):");
  Object.entries(fieldCount).sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`  ${k.padEnd(18)} ${v}`));
  process.exit(0);
})();
