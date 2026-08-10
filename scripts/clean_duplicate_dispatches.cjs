// 중복 배차 정리 (2026-08-10) — dry-run 기본. `--apply` 로만 실제 삭제.
//
//   node scripts/clean_duplicate_dispatches.cjs                 # 미리보기
//   node scripts/clean_duplicate_dispatches.cjs --apply         # 실행(백업 JSON 자동 생성)
//   node scripts/clean_duplicate_dispatches.cjs --restore <파일> --apply   # 되돌리기
//
// 배경: 2026-07-22 이전 `handleCopyDispatches` 가 배차를 통째 복사해(명시 필드 화이트리스트
//   도입 전) **같은 노선·같은 시각·같은 차량 배차가 여러 건** 생겼다. 근인은 그때 고쳤고
//   도착기록/푸시마커는 `clean_stale_arrivals.cjs` 로 정리했으나 **배차 행 자체는 남아 있다**
//   (tasks.md "잔존 관찰(미조치)"). 통계가 부풀고 관제 목록이 지저분해진다.
//
// 🔴 안전장치(복원 금지)
//   ① **완전중복만 삭제** = `routeId + departTime + vehicleId` 가 전부 같은 건들.
//      차량이 다르면(한 노선 2대 운용) 의도된 배차일 수 있으므로 **손대지 않고 보고만** 한다.
//   ② 그룹에서 **운행 흔적(stopArrivals·preArrivalNotified)이 있는 건을 남긴다.**
//      흔적이 2건 이상이면 **어느 쪽이 정본인지 알 수 없으므로 그룹 전체를 건너뛴다.**
//   ③ **오늘·미래 날짜는 제외** — 지금 기사 앱이 붙들고 있는 배차를 지우면 운행이 끊긴다.
//   ④ 삭제분은 전량 JSON 백업 → `--restore` 로 되돌릴 수 있다(hide_old_notices 선례).
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));

const kd = path.join(ROOT, "key");
const kf = fs.existsSync(kd) && fs.readdirSync(kd).find((f) => f.endsWith(".json"));
if (!kf) { console.error("❌ key/*.json 없음"); process.exit(1); }
const key = require(path.join(kd, kf));
if (key.project_id !== "buslink-prod") { console.error(`❌ project_id 불일치: ${key.project_id}`); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();

const APPLY = process.argv.includes("--apply");
const CID = process.env.COMPANY || "dy001";
const ri = process.argv.indexOf("--restore");
const RESTORE = ri > -1 ? process.argv[ri + 1] : null;

const todayKST = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());

const hasRun = (v) =>
  (v.stopArrivals && Object.keys(v.stopArrivals).length > 0) ||
  (Array.isArray(v.preArrivalNotified) && v.preArrivalNotified.length > 0);

async function restore(file) {
  const rows = JSON.parse(fs.readFileSync(file, "utf8"));
  console.log(`되돌리기 대상 ${rows.length}건 (${file})`);
  if (!APPLY) { console.log("\n(미리보기) --apply 를 붙이면 실제로 복원합니다."); return; }
  let n = 0;
  for (const r of rows) {
    await db.collection("companies").doc(r.companyId).collection("dispatches")
      .doc(r.date).collection("list").doc(r.id).set(r.data);
    n++;
  }
  console.log(`✅ 복원 ${n}건`);
}

(async () => {
  if (RESTORE) { await restore(RESTORE); process.exit(0); }

  const dateDocs = await db.collection("companies").doc(CID).collection("dispatches").listDocuments();
  const dates = dateDocs.map((d) => d.id).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();

  const toDelete = [];
  const skipped = [];   // 흔적 2건 이상 — 사람이 판단
  const multiVeh = [];  // 차량이 다른 다중 배차 — 의도일 수 있어 미조치
  let scanned = 0;

  for (const date of dates) {
    // ③ 오늘·미래 제외
    if (date >= todayKST) continue;
    const snap = await db.collection("companies").doc(CID)
      .collection("dispatches").doc(date).collection("list").get();
    if (snap.empty) continue;
    scanned += snap.size;

    const groups = {};
    snap.docs.forEach((d) => {
      const v = d.data() || {};
      const k = `${v.routeId || "-"}|${v.departTime || "-"}|${v.vehicleId || "-"}`;
      (groups[k] = groups[k] || []).push({ id: d.id, v });
    });

    // ① 차량이 다른 다중 배차는 별도 집계(삭제 대상 아님)
    const byRouteTime = {};
    snap.docs.forEach((d) => {
      const v = d.data() || {};
      const k = `${v.routeId || "-"}|${v.departTime || "-"}`;
      (byRouteTime[k] = byRouteTime[k] || []).push(v.vehicleId || "-");
    });
    Object.entries(byRouteTime).forEach(([k, vids]) => {
      if (vids.length > 1 && new Set(vids).size > 1) {
        multiVeh.push({ date, key: k, vehicles: [...new Set(vids)] });
      }
    });

    for (const [k, arr] of Object.entries(groups)) {
      if (arr.length < 2) continue;
      const withRun = arr.filter((a) => hasRun(a.v));
      if (withRun.length > 1) { skipped.push({ date, key: k, n: arr.length, run: withRun.length }); continue; } // ②

      // 남길 1건: 운행 흔적 > driverName 보유 > createdAt 이름순 > doc id
      const score = (a) => (hasRun(a.v) ? 100 : 0) + (a.v.driverName ? 10 : 0);
      const sorted = arr.slice().sort((a, b) => {
        const s = score(b) - score(a);
        if (s !== 0) return s;
        const ca = a.v.createdAt?.toMillis?.() ?? Infinity;
        const cb = b.v.createdAt?.toMillis?.() ?? Infinity;
        if (ca !== cb) return ca - cb;
        return a.id.localeCompare(b.id);
      });
      sorted.slice(1).forEach((a) => toDelete.push({ companyId: CID, date, id: a.id, key: k, data: a.v }));
    }
  }

  const routes = {};
  (await db.collection("companies").doc(CID).collection("routes").get()).docs
    .forEach((d) => { routes[d.id] = (d.data() || {}).name || d.id; });
  const label = (k) => { const [r, t] = k.split("|"); return `${routes[r] || r} ${t}`; };

  console.log(`\n스캔: 날짜 ${dates.filter((d) => d < todayKST).length}일 · 배차 ${scanned}건 (오늘 ${todayKST} 이후 제외)`);
  console.log(`\n[삭제 대상] 완전중복(노선+시각+차량 동일) ${toDelete.length}건`);
  const byDate = {};
  toDelete.forEach((t) => { (byDate[t.date] = byDate[t.date] || []).push(t); });
  Object.keys(byDate).sort().forEach((d) => {
    console.log(`  ${d} — ${byDate[d].length}건`);
    byDate[d].slice(0, 6).forEach((t) => console.log(`      ${label(t.key)}  (${t.id})`));
    if (byDate[d].length > 6) console.log(`      ... 외 ${byDate[d].length - 6}건`);
  });

  if (skipped.length) {
    console.log(`\n[건너뜀] 운행 흔적이 2건 이상이라 어느 쪽이 정본인지 알 수 없음 — ${skipped.length}건`);
    skipped.slice(0, 10).forEach((s) => console.log(`  ${s.date} ${label(s.key)} — 배차 ${s.n}건 중 흔적 ${s.run}건`));
  }
  if (multiVeh.length) {
    console.log(`\n[미조치] 같은 노선·시각인데 **차량이 다름**(의도된 2대 운용일 수 있음) — ${multiVeh.length}건`);
    multiVeh.slice(0, 10).forEach((m) => console.log(`  ${m.date} ${label(m.key)} — 차량 ${m.vehicles.length}대`));
  }

  if (!toDelete.length) { console.log("\n정리할 것이 없습니다."); process.exit(0); }

  if (!APPLY) {
    console.log(`\n(미리보기) 실제 삭제하려면 --apply 를 붙이세요. 실행 시 백업 JSON 이 생성됩니다.`);
    process.exit(0);
  }

  // ④ 백업 먼저 — 백업이 실패하면 삭제하지 않는다
  const backup = path.join(ROOT, `deleted_dispatches_${todayKST}.json`);
  fs.writeFileSync(backup, JSON.stringify(toDelete.map((t) => ({
    companyId: t.companyId, date: t.date, id: t.id,
    data: JSON.parse(JSON.stringify(t.data, (k2, v2) => (v2 && v2._seconds !== undefined ? { __ts: v2._seconds } : v2))),
  })), null, 1));
  console.log(`\n백업 저장: ${backup}`);

  let n = 0;
  for (const t of toDelete) {
    await db.collection("companies").doc(t.companyId).collection("dispatches")
      .doc(t.date).collection("list").doc(t.id).delete();
    n++;
  }
  console.log(`✅ 삭제 ${n}건 완료. 되돌리려면:\n   node scripts/clean_duplicate_dispatches.cjs --restore ${path.basename(backup)} --apply`);
  process.exit(0);
})().catch((e) => { console.error("실패:", e); process.exit(1); });
