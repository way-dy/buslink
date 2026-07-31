// buslink 과거 공지 일괄 숨김 (2026-07-31 배시현 개선요청 후속 정리)
//
//   승객앱 공지함은 `where("active","==",true)` 만 걸려 있어 **개수·기간 상한이 없다** →
//   3월부터 쌓인 테스트 공지가 학부모 앱에 그대로 노출된다. 이 스크립트는 기준일 **이전**
//   공지를 `active:false` 로 내려 앱에서만 감춘다(문서는 남는다).
//
//   🔴 **삭제가 아니라 숨김이다.** 되돌리려면 아래 --restore 또는 관리자 콘솔의 되돌리기 버튼.
//   숨긴 문서 ID 를 항상 파일로 남겨 되돌릴 근거를 확보한다(100건을 손으로 되찾을 수는 없다).
//
// 사용:
//   node scripts/hide_old_notices.cjs                      — dry-run(기본·아무것도 안 바꿈)
//   node scripts/hide_old_notices.cjs --apply              — 오늘(KST) 이전 active 공지 숨김
//   node scripts/hide_old_notices.cjs --before 2026-07-01  — 기준일 지정 dry-run
//   node scripts/hide_old_notices.cjs --restore <파일>      — 그 파일의 ID 를 다시 표시(dry-run)
//   node scripts/hide_old_notices.cjs --restore <파일> --apply
//
// 안전: project_id 를 buslink-prod 로 검증. 기준일 **당일 것은 건드리지 않는다**(방금 올린 공지 보호).
const fs = require("fs");
const path = require("path");
const admin = require(path.join(__dirname, "..", "functions", "node_modules", "firebase-admin"));

const kd = path.join(__dirname, "..", "key");
const kf = fs.existsSync(kd) && fs.readdirSync(kd).find((f) => f.endsWith(".json"));
if (!kf) { console.error("❌ app/buslink/key/*.json 서비스 계정 키가 없습니다."); process.exit(1); }
const key = require(path.join(kd, kf));
if (key.project_id !== "buslink-prod") {
  console.error(`❌ project_id 불일치: ${key.project_id} (buslink-prod 기대)`);
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null; };
const APPLY = argv.includes("--apply");
const CID = flag("--company") || "dy001";
const RESTORE = flag("--restore");
const kstToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const BEFORE = flag("--before") || kstToday();

const col = db.collection("companies").doc(CID).collection("notices");
const dstr = (n) => (n.createdAt && n.createdAt.toDate ? n.createdAt.toDate() : null);
const kstDay = (d) => (d ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(d) : "-");

async function commitInChunks(ids, value) {
  let done = 0;
  for (let i = 0; i < ids.length; i += 400) {
    const batch = db.batch();
    ids.slice(i, i + 400).forEach((id) => batch.update(col.doc(id), { active: value }));
    await batch.commit();
    done += Math.min(400, ids.length - i);
    console.log(`  … ${done}/${ids.length}`);
  }
}

(async () => {
  if (RESTORE) {
    const ids = JSON.parse(fs.readFileSync(RESTORE, "utf8")).ids;
    console.log(`복원 대상 ${ids.length}건 (${RESTORE})`);
    if (!APPLY) { console.log("\n[dry-run] --apply 를 붙이면 다시 앱에 표시됩니다."); return; }
    await commitInChunks(ids, true);
    console.log(`✅ ${ids.length}건 복원(active:true)`);
    return;
  }

  const snap = await col.orderBy("createdAt", "desc").get();
  const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  // 🔴 소비측 쿼리와 같은 정의 — active===true 인 것만 "앱에 보이는" 상태다.
  const active = all.filter((n) => n.active === true);
  const target = active.filter((n) => {
    const d = dstr(n);
    if (!d) return false;            // 날짜 없는 문서는 건드리지 않는다(판정 불가)
    return kstDay(d) < BEFORE;       // 기준일 당일은 제외 — 방금 올린 공지 보호
  });
  const kept = active.filter((n) => !target.includes(n));

  console.log(`회사 ${CID} · 공지 전체 ${all.length}건 · 앱 표시 중 ${active.length}건`);
  console.log(`기준일 ${BEFORE} **이전** → 숨김 대상 ${target.length}건 / 유지 ${kept.length}건\n`);
  const byDay = {};
  target.forEach((n) => { const k = kstDay(dstr(n)); byDay[k] = (byDay[k] || 0) + 1; });
  console.log("숨김 대상 날짜별:");
  Object.entries(byDay).sort().forEach(([k, v]) => console.log(`  ${k}: ${v}건`));
  console.log("\n유지되는 공지:");
  kept.forEach((n) => console.log(`  ${kstDay(dstr(n))} [${n.partnerCode ? n.partnerCode.split("-")[1] : "전체"}] ${String(n.title || "").slice(0, 40)}`));

  if (!APPLY) {
    console.log("\n[dry-run] 아무것도 바꾸지 않았습니다. --apply 를 붙이면 실행됩니다.");
    return;
  }
  const out = path.join(__dirname, "..", `hidden_notices_${BEFORE}.json`);
  fs.writeFileSync(out, JSON.stringify({ companyId: CID, before: BEFORE, at: new Date().toISOString(), ids: target.map((n) => n.id) }, null, 1), "utf8");
  console.log(`\n되돌릴 근거 저장: ${out}`);
  await commitInChunks(target.map((n) => n.id), false);
  console.log(`✅ ${target.length}건 숨김(active:false) — 되돌리기: --restore "${out}" --apply`);
})().catch((e) => { console.error(e); process.exit(1); });
