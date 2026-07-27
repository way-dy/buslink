// 관리자 계정 가시범위 진단 (읽기 전용, Admin SDK)
//   "관리자 화면에 내가 입력한 것만 보인다" 류 신고의 원인을 실측으로 가른다.
//   AdminApp 의 게이팅 술어(partnerAccess.js + createdBy 격리)를 그대로 미러해서
//   각 탭이 그 계정에 몇 건을 보여주는지 계산한다.
//
// 사용:
//   node scripts/inspect_admin_visibility.cjs <이메일 또는 uid>
//   node scripts/inspect_admin_visibility.cjs --company dy001      (회사 admin 전원 요약)
//
// 읽기 전용 — write 없음.
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

// --- src/lib/partnerAccess.js 미러 (계약 동일 유지) ---
const resolveAllowed = (role, v) => {
  if (role === "superadmin") return ["*"];
  if (!Array.isArray(v)) return ["*"];
  if (v.includes("*")) return ["*"];
  return Array.from(new Set(v.filter((c) => typeof c === "string" && c)));
};
const isAllAccess = (a) => Array.isArray(a) && a.includes("*");
const partnerCodeAllowed = (a, code) => (isAllAccess(a) ? true : !code ? false : a.includes(code));

const kstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

async function loadUser(arg) {
  // uid 직접 조회 → 실패 시 users where email 로.
  const byId = await db.collection("users").doc(arg).get();
  if (byId.exists) return { uid: byId.id, ...byId.data() };
  const q = await db.collection("users").where("email", "==", arg).get();
  if (!q.empty) return { uid: q.docs[0].id, ...q.docs[0].data() };
  // Auth 에서 이메일 → uid 로 재시도(users 에 email 필드가 없는 계정 대비)
  try {
    const rec = await admin.auth().getUserByEmail(arg);
    const d = await db.collection("users").doc(rec.uid).get();
    if (d.exists) return { uid: d.id, ...d.data() };
    return { uid: rec.uid, _noUserDoc: true, email: rec.email };
  } catch (e) { return null; }
}

async function report(u) {
  const cid = u.companyId;
  console.log("\n" + "=".repeat(72));
  console.log(`계정  ${u.name || "(이름없음)"}  <${u.email || "-"}>`);
  console.log(`uid=${u.uid}  role=${u.role}  companyId=${cid}`);
  console.log(`allowedPartnerCodes(원본) = ${JSON.stringify(u.allowedPartnerCodes)}`);
  if (u._noUserDoc) { console.log("⚠ users/{uid} 문서 없음 — 로그인해도 권한 판정 불가"); return; }

  const rawAllowed = resolveAllowed(u.role, u.allowedPartnerCodes);
  const allAccess = isAllAccess(rawAllowed);

  const [pcSnap, rSnap, dvSnap, vhSnap] = await Promise.all([
    db.collection("partnerCodes").where("companyId", "==", cid).get(),
    db.collection("companies").doc(cid).collection("routes").get(),
    db.collection("companies").doc(cid).collection("drivers").get(),
    db.collection("companies").doc(cid).collection("vehicles").get(),
  ]);
  const partners = pcSnap.docs.map((d) => ({ code: d.id, ...d.data() }));
  const routes = rSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const drivers = dvSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const vehicles = vhSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  // AdminApp:216 — 본인 생성 거래처는 권한과 무관하게 합산
  const createdCodes = partners.filter((p) => p.createdBy === u.uid).map((p) => p.code);
  const allowed = allAccess ? rawAllowed : Array.from(new Set([...rawAllowed, ...createdCodes]));

  console.log(`\n[유효 가시범위] ${allAccess ? "⭐ 전체권한(무제한)" : `거래처 ${allowed.length}개: ${JSON.stringify(allowed)}`}`);
  console.log(`  (그중 본인 생성 거래처 ${createdCodes.length}개: ${JSON.stringify(createdCodes)})`);

  const uid = u.uid;
  const seeRoute = (r) => allAccess || partnerCodeAllowed(allowed, r.partnerCode) || r.createdBy === uid;
  const routeById = new Map(routes.map((r) => [r.id, r]));
  const seeDispatch = (d) => {
    if (allAccess) return true;
    const r = routeById.get(d.routeId);
    return partnerCodeAllowed(allowed, r?.partnerCode) || r?.createdBy === uid || d.createdBy === uid;
  };

  // 오늘 + 향후 7일 배차
  const today = kstToday();
  const days = Array.from({ length: 8 }, (_, i) => {
    const t = new Date(today + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + i);
    return t.toISOString().slice(0, 10);
  });
  let disp = [];
  for (const day of days) {
    const s = await db.collection("companies").doc(cid).collection("dispatches").doc(day).collection("list").get();
    disp = disp.concat(s.docs.map((d) => ({ id: d.id, date: day, ...d.data() })));
  }

  const rows = [
    ["거래처(협력사)", partners.length, allAccess ? partners.length : partners.filter((p) => allowed.includes(p.code)).length],
    ["노선", routes.length, routes.filter(seeRoute).length],
    ["기사", drivers.length, allAccess ? drivers.length : drivers.filter((d) => d.createdBy === uid).length],
    ["차량", vehicles.length, allAccess ? vehicles.length : vehicles.filter((v) => v.createdBy === uid).length],
    [`배차(${today}~+7일)`, disp.length, disp.filter(seeDispatch).length],
  ];
  console.log("\n화면별 표시 건수 (전체 → 이 계정에 보이는 수)");
  for (const [label, total, vis] of rows) {
    const mark = vis === total ? "  " : vis === 0 ? "❌" : "⚠ ";
    console.log(`  ${mark} ${label.padEnd(18)} ${String(vis).padStart(4)} / ${total}`);
  }

  if (!allAccess) {
    const hiddenRoutes = routes.filter((r) => !seeRoute(r));
    const noPartner = hiddenRoutes.filter((r) => !r.partnerCode).length;
    console.log(`\n숨김 사유 분해 — 노선 ${hiddenRoutes.length}건 미표시`);
    console.log(`   · 거래처 미지정(partnerCode 없음): ${noPartner}건`);
    console.log(`   · 담당 아닌 거래처 소속        : ${hiddenRoutes.length - noPartner}건`);
    const byOwner = {};
    for (const r of hiddenRoutes) byOwner[r.createdBy || "(createdBy 없음)"] = (byOwner[r.createdBy || "(createdBy 없음)"] || 0) + 1;
    console.log(`   · 생성자별: ${JSON.stringify(byOwner)}`);
  }
}

(async () => {
  const arg = process.argv[2];
  if (!arg) { console.error("사용: node scripts/inspect_admin_visibility.cjs <이메일|uid> | --company <cid>"); process.exit(1); }

  if (arg === "--company") {
    const cid = process.argv[3];
    const s = await db.collection("users").where("companyId", "==", cid).get();
    console.log(`\n${cid} 계정 ${s.size}개`);
    for (const d of s.docs) {
      const v = d.data();
      console.log(`  ${(v.role || "?").padEnd(11)} ${(v.name || "-").padEnd(10)} ${(v.email || "-").padEnd(28)} allowed=${JSON.stringify(v.allowedPartnerCodes)}  uid=${d.id}`);
    }
    process.exit(0);
  }

  const u = await loadUser(arg);
  if (!u) { console.error(`❌ 계정을 찾을 수 없습니다: ${arg}`); process.exit(1); }
  await report(u);
  process.exit(0);
})();
