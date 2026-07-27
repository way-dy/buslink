// 관리자 계정의 담당 거래처 범위(users.allowedPartnerCodes) 변경 — Admin SDK.
//   슈퍼관리자 콘솔의 "🛡 권한" 모달과 같은 일을 CLI 로 한다(CF updateCompanyAdminPermissions 미러).
//
// 사용:
//   node scripts/set_admin_partner_access.cjs <이메일|uid> "*"                 (전체권한·dry-run)
//   node scripts/set_admin_partner_access.cjs <이메일|uid> "*" --apply
//   node scripts/set_admin_partner_access.cjs <이메일|uid> "CODE1,CODE2" --apply
//   node scripts/set_admin_partner_access.cjs <이메일|uid> "" --apply          (전체 해제=[])
//
// 안전장치: dry-run 기본 · project_id 검증 · role!=="admin" 거부(superadmin/driver 보호)
//          · allowedPartnerCodes 외 필드 절대 미변경 · 변경 전 값 출력(되돌리기용)
const fs = require("fs");
const path = require("path");
const admin = require(path.join(__dirname, "..", "functions", "node_modules", "firebase-admin"));

const kd = path.join(__dirname, "..", "key");
const kf = fs.existsSync(kd) && fs.readdirSync(kd).find((f) => f.endsWith(".json"));
if (!kf) { console.error("❌ app/buslink/key/*.json 서비스 계정 키가 없습니다."); process.exit(1); }
const key = require(path.join(kd, kf));
if (key.project_id !== "buslink-prod") { console.error(`❌ project_id 불일치: ${key.project_id}`); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();

// CF normalizeAllowedPartnerCodes 미러: "*" 포함 시 ["*"] 로 정규화 + 중복 제거.
const normalize = (raw) => {
  const arr = String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  if (arr.includes("*")) return ["*"];
  return Array.from(new Set(arr));
};

(async () => {
  const [, , who, codesArg, ...flags] = process.argv;
  if (!who || codesArg === undefined) {
    console.error('사용: node scripts/set_admin_partner_access.cjs <이메일|uid> "*|CODE1,CODE2|" [--apply]');
    process.exit(1);
  }
  const apply = flags.includes("--apply");
  const next = normalize(codesArg);

  let ref = db.collection("users").doc(who);
  let snap = await ref.get();
  if (!snap.exists) {
    const q = await db.collection("users").where("email", "==", who).get();
    if (q.empty) { console.error(`❌ 계정을 찾을 수 없습니다: ${who}`); process.exit(1); }
    ref = q.docs[0].ref; snap = q.docs[0];
  }
  const u = snap.data();
  if (u.role !== "admin") { console.error(`❌ role=${u.role} — admin 계정만 변경합니다(슈퍼관리자·기사 보호).`); process.exit(1); }

  console.log(`대상  ${u.name || "-"} <${u.email || "-"}>  uid=${snap.id}  company=${u.companyId}`);
  console.log(`  변경 전: ${JSON.stringify(u.allowedPartnerCodes)}`);
  console.log(`  변경 후: ${JSON.stringify(next)}`);
  if (!apply) { console.log("\n[dry-run] 실제 적용하려면 --apply 를 붙이세요."); process.exit(0); }

  await ref.update({ allowedPartnerCodes: next });
  const after = (await ref.get()).data();
  console.log(`✅ 적용 완료 — 실측 재조회: ${JSON.stringify(after.allowedPartnerCodes)}`);
  process.exit(0);
})();
