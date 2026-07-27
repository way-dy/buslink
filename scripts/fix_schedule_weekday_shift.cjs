// 배차 일정 요일 밀림 데이터 정리 (2026-07-27)
//
// 배경: 서버(UTC)에서 요일을 계산해 배차 일정이 하루씩 밀려 펼쳐졌다
//   (월요일 일정 → 화요일 생성 / 월요일 배차 0건 / 토요일에 평일 배차 생성).
//   코드는 `dayOfWeekKST` 를 getUTCDay 로 고쳐 배포했고, 이 스크립트는 **이미 잘못
//   만들어진 데이터**를 정리한다.
//
// 하는 일 두 가지 (오늘 이후만 — 지난 날짜는 기록이라 건드리지 않는다):
//   ① 일정 요일에 맞지 않는 날짜에 생긴 **펼침 배차 삭제**
//   ② 일정 요일인데 배차가 없는 날짜에 **누락 배차 생성**
//
// 안전장치:
//   - 삭제 대상은 펼침 산출물(`id === scheduleId_날짜`)만. 수동 등록·복사본은 손대지 않는다.
//   - 운행 흔적(stopArrivals·preArrivalNotified)이 있으면 **삭제하지 않고 보고**만 한다.
//   - 지난 날짜는 대상에서 제외.
//   - 기본은 dry-run. 실제 반영은 `--apply` 를 붙여야 한다.
//
// 사용:
//   node scripts/fix_schedule_weekday_shift.cjs            (dry-run · 수치만)
//   node scripts/fix_schedule_weekday_shift.cjs --apply    (실제 반영)
const fs = require("fs");
const path = require("path");
const admin = require(path.join(__dirname, "..", "functions", "node_modules", "firebase-admin"));

const APPLY = process.argv.includes("--apply");
const LOOKAHEAD_DAYS = 7; // functions/index.js 와 동일

const kd = path.join(__dirname, "..", "key");
const kf = fs.existsSync(kd) && fs.readdirSync(kd).find(f => f.endsWith(".json"));
if (!kf) { console.error("❌ app/buslink/key/*.json 서비스 계정 키가 없습니다."); process.exit(1); }
const key = require(path.join(kd, kf));
if (key.project_id !== "buslink-prod") {
  console.error(`❌ project_id 불일치: ${key.project_id} (buslink-prod 기대)`); process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();

const N = ["일", "월", "화", "수", "목", "금", "토"];
const ymdKST = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(d);
// functions/index.js dayOfWeekKST 와 동일 계약(달력 요일·시간대 무관)
const dayOfWeek = (dateStr) => new Date(`${dateStr}T00:00:00Z`).getUTCDay();

// functions/index.js shouldExpand 미러 — 공휴일 판정은 여기선 생략하고
// "일정이 지정한 요일인가"만 본다(공휴일 제외분을 이 스크립트가 되살리지 않도록 생성은 보수적으로).
function matchesWeekday(schedule, day) {
  if (schedule.startDate && day < schedule.startDate) return false;
  if (schedule.endDate && day > schedule.endDate) return false;
  if (!Array.isArray(schedule.weekdays) || schedule.weekdays.length === 0) return false;
  if (!schedule.weekdays.includes(dayOfWeek(day))) return false;
  if (Array.isArray(schedule.excludeDates) && schedule.excludeDates.includes(day)) return false;
  return true;
}

(async () => {
  console.log(APPLY ? "⚠️  APPLY 모드 — 실제로 반영합니다\n" : "🔍 DRY-RUN — 아무것도 바꾸지 않습니다 (--apply 로 실제 반영)\n");

  const companies = await db.collection("companies").get();
  let totalDel = 0, totalAdd = 0, totalKept = 0;

  for (const c of companies.docs) {
    const cid = c.id;
    const schedSnap = await db.collection("companies").doc(cid)
      .collection("dispatchSchedules").where("active", "==", true).get();
    if (schedSnap.empty) continue;
    const byId = {};
    schedSnap.docs.forEach(d => { byId[d.id] = d.data(); });

    const today = new Date();
    const days = [];
    for (let i = 0; i < LOOKAHEAD_DAYS; i++) days.push(ymdKST(new Date(today.getTime() + i * 86400000)));

    console.log(`### ${cid} (${c.data().name || "-"}) — 활성 일정 ${schedSnap.size}건 · 대상 ${days[0]} ~ ${days[days.length - 1]}`);

    for (const day of days) {
      const listRef = db.collection("companies").doc(cid).collection("dispatches").doc(day).collection("list");
      const snap = await listRef.get();
      const present = new Set();     // 이 날짜에 이미 있는 펼침 dispatchId
      const toDelete = [];
      const keptWithRuns = [];

      for (const d of snap.docs) {
        const x = d.data();
        if (!x.scheduleId) continue;
        if (d.id !== `${x.scheduleId}_${day}`) continue;   // 펼침 산출물만(복사본·수동 제외)
        const s = byId[x.scheduleId];
        if (!s) continue;                                   // 삭제된 일정의 산출물은 판단 보류
        if (matchesWeekday(s, day)) { present.add(d.id); continue; }
        // 요일이 안 맞는 = 밀려서 생긴 배차
        const hasRun = (x.stopArrivals && Object.keys(x.stopArrivals).length > 0)
          || (Array.isArray(x.preArrivalNotified) && x.preArrivalNotified.length > 0);
        if (hasRun) keptWithRuns.push({ id: d.id, name: s.name || x.routeName });
        else toDelete.push({ ref: d.ref, id: d.id, name: s.name || x.routeName });
      }

      // 누락분 = 요일은 맞는데 그 날짜에 펼침 배차가 없는 일정
      const toAdd = [];
      for (const [sid, s] of Object.entries(byId)) {
        if (!matchesWeekday(s, day)) continue;
        const id = `${sid}_${day}`;
        if (present.has(id)) continue;
        if (snap.docs.some(d => d.id === id)) continue;
        toAdd.push({ sid, s, id });
      }

      if (toDelete.length || toAdd.length || keptWithRuns.length) {
        console.log(`  ${day}(${N[dayOfWeek(day)]}) — 삭제 ${toDelete.length} · 생성 ${toAdd.length}` +
          (keptWithRuns.length ? ` · ⚠운행흔적으로 보존 ${keptWithRuns.length}` : ""));
        for (const k of keptWithRuns) console.log(`      보존: ${k.name} (${k.id})`);
      }

      if (APPLY) {
        for (const t of toDelete) await t.ref.delete();
        for (const a of toAdd) {
          await listRef.doc(a.id).set({
            driverId: a.s.driverId || "",
            driverName: a.s.driverName || "",
            routeId: a.s.routeId || "",
            routeName: a.s.routeName || "",
            vehicleNo: a.s.vehicleNo || "",
            vehicleId: a.s.vehicleId || "",
            departTime: a.s.departTime || "",
            date: day,
            scheduleId: a.sid,
            source: "schedule",
            createdAt: new Date().toISOString(),
          });
        }
      }
      totalDel += toDelete.length; totalAdd += toAdd.length; totalKept += keptWithRuns.length;
    }
  }

  console.log(`\n합계 — 삭제 ${totalDel}건 · 생성 ${totalAdd}건 · 운행흔적 보존 ${totalKept}건`);
  if (!APPLY) console.log("\n실제 반영: node scripts/fix_schedule_weekday_shift.cjs --apply");
})().catch(e => { console.error(e); process.exit(1); });
