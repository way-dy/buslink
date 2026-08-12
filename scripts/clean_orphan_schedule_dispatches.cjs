// 배차 일정 조건과 안 맞는데 남아 있는 "펼침 배차" 정리 (기본 dry-run).
//
//   배경(2026-08-12 배시현 개선요청 k49E7GXEVfe0WT9h4QI6 "배차일정 8/18로 수정했는데 금일 오전 관제됨"):
//   CF `expandDispatchSchedules` 는 멱등 id `${scheduleId}_${day}` 로 **만들기만 하고 지우지 않는다**
//   (일별 수동 수정 보존이 목적). 그래서 일정의 시작일을 미래로 밀거나 요일을 줄이거나
//   비활성으로 바꿔도 **이미 펼쳐진 배차가 남고**, `pollDeviceVehicleGps` 가 그것을 오늘 배차로 읽어
//   단말 차량 좌표를 쓰기 시작한다 → 승객·직원앱에 `1대 운행중`.
//
//   AdminApp 은 2026-08-12 부터 일정 변경 직후 이 정리를 확인받아 수행한다. 이 스크립트는
//   **그 전에 이미 쌓인 잔여분**을 한 번에 걷어내는 일회성 도구다.
//
// 사용:
//   node scripts/clean_orphan_schedule_dispatches.cjs                 — dry-run(기본·쓰기 0)
//   node scripts/clean_orphan_schedule_dispatches.cjs --days 21       — 훑는 범위(기본 14일)
//   node scripts/clean_orphan_schedule_dispatches.cjs --apply         — 실제 삭제(백업 JSON 저장)
//   node scripts/clean_orphan_schedule_dispatches.cjs --restore <파일> --apply   — 되돌리기
//
// 🔴 안전장치(복원 금지):
//   ① 오늘(KST) 이전 날짜는 손대지 않는다 — 과거는 기록이다.
//   ② `id === ${scheduleId}_${day}` && `source === "schedule"` 인 **펼침 산출물만** 대상.
//      운영자가 손으로 만든 배차·복사본(랜덤 id)은 조건이 안 맞아도 건드리지 않는다.
//   ③ `stopArrivals`·`preArrivalNotified` 가 있으면 그날 실제로 차가 다녔다는 뜻이라 **보고만** 한다.
//   ④ 판정은 `src/lib/dispatchSchedule.js` 를 그대로 평가해 쓴다(규칙 사본을 만들지 않는다).
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const admin = require(path.join(root, "functions", "node_modules", "firebase-admin"));
const { HOLIDAY_SET } = require(path.join(root, "functions/holidays.js"));

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const DAYS = (() => {
  const i = args.indexOf("--days");
  const v = i >= 0 ? parseInt(args[i + 1], 10) : NaN;
  return Number.isFinite(v) && v > 0 && v <= 60 ? v : 14;
})();
const RESTORE = (() => {
  const i = args.indexOf("--restore");
  return i >= 0 ? args[i + 1] : null;
})();

// ── 판정 규칙은 클라 정본을 그대로 평가(사본 금지) ──
function loadRules() {
  const src = fs.readFileSync(path.join(root, "src/lib/dispatchSchedule.js"), "utf8")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["'][^"']+["'];?$/gm, "")
    .replace(/^export\s+function\s+/gm, "function ")
    .replace(/^export\s+const\s+/gm, "var ");
  const ctx = vm.createContext({
    console, Date, Array, Object, Intl, Number, String,
    isKoreanHoliday: (d) => HOLIDAY_SET.has(d),
  });
  vm.runInContext(src, ctx);
  return ctx;
}
const R = loadRules();

const kd = path.join(root, "key");
const kf = fs.existsSync(kd) && fs.readdirSync(kd).find((f) => f.endsWith(".json"));
if (!kf) { console.error("❌ app/buslink/key/*.json 서비스 계정 키가 없습니다."); process.exit(1); }
const key = require(path.join(kd, kf));
if (key.project_id !== "buslink-prod") {
  console.error(`❌ project_id 불일치: ${key.project_id} (buslink-prod 기대)`); process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();

async function restore() {
  const rows = JSON.parse(fs.readFileSync(RESTORE, "utf8"));
  console.log(`되돌리기 대상 ${rows.length}건 (${RESTORE})`);
  if (!APPLY) { console.log("dry-run — 실제로 쓰려면 --apply"); return; }
  let n = 0;
  for (const r of rows) {
    await db.doc(`companies/${r.companyId}/dispatches/${r.day}/list/${r.id}`).set(r.data);
    n++;
  }
  console.log(`✅ ${n}건 복원`);
}

async function main() {
  if (RESTORE) return restore();

  const today = R.todayKST();
  const days = R.upcomingDates(today, DAYS);
  console.log(`=== 잔존 펼침 배차 점검 · ${today} ~ ${days[days.length - 1]} (${DAYS}일) ===`);
  console.log(APPLY ? "모드: 🔴 실제 삭제\n" : "모드: dry-run (쓰기 0)\n");

  const companiesSnap = await db.collection("companies").get();
  const backup = [];
  let totalPrunable = 0, totalTrace = 0;

  for (const c of companiesSnap.docs) {
    const companyId = c.id;
    const schedSnap = await db.collection(`companies/${companyId}/dispatchSchedules`).get();
    if (schedSnap.empty) continue;
    const schedById = new Map();
    schedSnap.forEach((d) => schedById.set(d.id, d.data()));

    // 날짜별 배차를 한 번씩 읽어 일정별로 나눈다.
    const rawByDay = {};
    for (const day of days) {
      const snap = await db.collection(`companies/${companyId}/dispatches/${day}/list`).get();
      rawByDay[day] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    }

    const prunable = [], kept = [];
    for (const [scheduleId, schedule] of schedById) {
      const byDay = {};
      for (const day of days) {
        byDay[day] = (rawByDay[day] || []).filter((d) => d.scheduleId === scheduleId);
      }
      const r = R.selectPrunableDispatches({ scheduleId, schedule, dispatchesByDay: byDay, today });
      prunable.push(...r.prunable.map((x) => ({ ...x, scheduleId, name: schedule.name || "" })));
      kept.push(...r.keptWithTrace.map((x) => ({ ...x, scheduleId, name: schedule.name || "" })));
    }
    // 일정 문서가 사라졌는데 남은 산출물(삭제된 일정의 잔여)
    for (const day of days) {
      if (day < today) continue;
      for (const d of rawByDay[day] || []) {
        if (d.source !== "schedule" || !d.scheduleId) continue;
        if (schedById.has(d.scheduleId)) continue;
        if (d.id !== `${d.scheduleId}_${day}`) continue;
        const row = { day, id: d.id, routeName: d.routeName || "", departTime: d.departTime || "", scheduleId: d.scheduleId, name: "(삭제된 일정)" };
        if (R.hasRunTrace(d)) kept.push(row); else prunable.push(row);
      }
    }

    if (prunable.length === 0 && kept.length === 0) continue;
    console.log(`[${companyId}] 삭제 대상 ${prunable.length}건 · 운행흔적으로 보존 ${kept.length}건`);
    prunable.sort((a, b) => (a.day + a.departTime).localeCompare(b.day + b.departTime));
    for (const p of prunable) console.log(`   삭제  ${p.day} ${p.departTime} ${p.routeName}  ← ${p.name}`);
    for (const p of kept) console.log(`   보존  ${p.day} ${p.departTime} ${p.routeName}  (운행 기록 있음)`);
    totalPrunable += prunable.length;
    totalTrace += kept.length;

    if (APPLY) {
      for (const p of prunable) {
        const ref = db.doc(`companies/${companyId}/dispatches/${p.day}/list/${p.id}`);
        const snap = await ref.get();
        if (!snap.exists) continue;
        backup.push({ companyId, day: p.day, id: p.id, data: snap.data() });
        await ref.delete();
      }
    }
  }

  console.log(`\n합계: 삭제 대상 ${totalPrunable}건 · 운행흔적 보존 ${totalTrace}건`);
  if (!APPLY) {
    console.log("dry-run 입니다. 실제 삭제는 --apply");
    return;
  }
  const out = path.join(root, `deleted_orphan_dispatches_${today}.json`);
  fs.writeFileSync(out, JSON.stringify(backup, null, 2), "utf8");
  console.log(`✅ ${backup.length}건 삭제 · 백업 → ${out}`);
  console.log(`   되돌리기: node scripts/clean_orphan_schedule_dispatches.cjs --restore ${path.basename(out)} --apply`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("❌", e); process.exit(1); });
