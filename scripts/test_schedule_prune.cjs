// 격리 테스트 — 배차 일정 변경 후 남는 펼침 배차 정리(2026-08-12 배시현 개선요청 k49E7GXEVfe0WT9h4QI6).
//   node scripts/test_schedule_prune.cjs
//
// 두 가지를 잰다:
//   ① 클라 미러 `src/lib/dispatchSchedule.js` 의 펼침 판정이 서버 `functions/index.js shouldExpand`
//      와 **완전히 같은가**. 어긋나면 관리 화면이 지운 배차를 그날 밤 CF 가 다시 만든다
//      (NFC UID 이중 구현·GPS 시간창과 같은 클래스라 두 소스에서 직접 뽑아 대조).
//   ② 정리 대상 선정이 안전한가 — 과거·수동 배차·운행 흔적은 절대 대상에 들어오면 안 된다.
//
// 🔴 신호 유무 검사 포함: "정리 대상 0건" 은 규칙이 옳아서일 수도, 입력이 비어서일 수도 있다.
//    신고 상황(시작일을 미래로 민 일정)에서 실제로 대상이 잡히는지를 먼저 단언한다.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const { HOLIDAY_SET } = require(path.join(root, "functions/holidays.js"));

// ── 서버 구현 추출 (functions/index.js) ──
function loadServer() {
  const src = fs.readFileSync(path.join(root, "functions/index.js"), "utf8");
  const grab = (name) => {
    const i = src.indexOf(`function ${name}(`);
    if (i < 0) throw new Error(`서버 함수 ${name} 없음`);
    let d = 0, started = false, j = i;
    for (; j < src.length; j++) {
      if (src[j] === "{") { d++; started = true; }
      else if (src[j] === "}") { d--; if (started && d === 0) { j++; break; } }
    }
    return src.slice(i, j);
  };
  const code = [grab("dayOfWeekKST"), grab("shouldExpand")].join("\n");
  const ctx = vm.createContext({ console, Date, Array, HOLIDAY_SET });
  vm.runInContext(code, ctx);
  return ctx;
}

// ── 클라 구현 추출 (src/lib/dispatchSchedule.js) ──
function loadClient() {
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

const S = loadServer();
const C = loadClient();

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`); }
}

function datesFrom(start, n) {
  const base = new Date(`${start}T00:00:00Z`).getTime();
  return Array.from({ length: n }, (_, i) =>
    new Date(base + i * 86400000).toISOString().slice(0, 10));
}

console.log("── ① 서버 shouldExpand ↔ 클라 shouldExpandOn 일치 ──");

// 신고 구성(채드윅 등교 월~수,금 / 하교 평일 / 목요일 전용)과 경계 케이스를 섞는다.
const SCHEDULES = [
  { name: "월~수,금", weekdays: [1, 2, 3, 5], startDate: "2026-08-18", endDate: null, excludeHolidays: true, excludeDates: [] },
  { name: "평일", weekdays: [1, 2, 3, 4, 5], startDate: "2026-08-18", endDate: null, excludeHolidays: true, excludeDates: [] },
  { name: "목만", weekdays: [4], startDate: "2026-08-18", endDate: null, excludeHolidays: true, excludeDates: [] },
  { name: "과거시작·무기한", weekdays: [1, 2, 3, 4, 5], startDate: "2026-01-01", endDate: null, excludeHolidays: true, excludeDates: [] },
  { name: "종료일있음", weekdays: [1, 2, 3, 4, 5], startDate: "2026-01-01", endDate: "2026-08-11", excludeHolidays: true, excludeDates: [] },
  { name: "공휴일도운행", weekdays: [0, 1, 2, 3, 4, 5, 6], startDate: "2026-01-01", endDate: null, excludeHolidays: false, excludeDates: [] },
  { name: "제외일", weekdays: [1, 2, 3, 4, 5], startDate: "2026-01-01", endDate: null, excludeHolidays: true, excludeDates: ["2026-08-13", "2026-08-14"] },
  { name: "요일없음", weekdays: [], startDate: "2026-01-01", endDate: null, excludeHolidays: true, excludeDates: [] },
  { name: "주말만", weekdays: [0, 6], startDate: "2026-01-01", endDate: null, excludeHolidays: true, excludeDates: [] },
];
// 광복절(토)·대체공휴일(월)·주말·평일이 모두 들어가는 구간
const SWEEP_DAYS = datesFrom("2026-08-10", 30);

let mismatch = 0, expandTrue = 0;
for (const s of SCHEDULES) {
  for (const day of SWEEP_DAYS) {
    const sv = S.shouldExpand(s, day);
    const cv = C.shouldExpandOn(s, day);
    if (sv !== cv) { mismatch++; if (mismatch <= 3) console.log(`     ↳ 불일치 ${s.name} ${day}: 서버=${sv} 클라=${cv}`); }
    if (sv) expandTrue++;
  }
}
ok(`판정 일치 (${SCHEDULES.length}일정 × ${SWEEP_DAYS.length}일 = ${SCHEDULES.length * SWEEP_DAYS.length}조합)`, mismatch === 0, { mismatch });
// 🔴 신호 유무 — 전부 false 면 "일치"가 공허하다
ok(`스윕에 실제 펼침 대상이 있다 (${expandTrue}건)`, expandTrue > 30, { expandTrue });

// 요일 계산도 직접 대조(2026-07-27 하루 밀림 결함의 급소)
let dowMismatch = 0;
for (const day of datesFrom("2026-01-01", 400)) {
  if (S.dayOfWeekKST(day) !== C.dayOfWeekForDate(day)) dowMismatch++;
}
ok("요일 계산 400일 일치 (getUTCDay 고정)", dowMismatch === 0, { dowMismatch });
ok("2026-08-12 는 수요일(3)", C.dayOfWeekForDate("2026-08-12") === 3, C.dayOfWeekForDate("2026-08-12"));
ok("2026-08-17 는 광복절 대체공휴일이라 평일 일정도 제외",
  C.shouldExpandOn(SCHEDULES[3], "2026-08-17") === false);

console.log("\n── ② isExpandTarget — active 게이트 ──");
const live = { ...SCHEDULES[3], active: true };
ok("active:true 면 대상", C.isExpandTarget(live, "2026-08-12") === true);
ok("active:false 면 비대상", C.isExpandTarget({ ...live, active: false }, "2026-08-12") === false);
ok("active 필드 없으면 비대상(CF where active==true 미러)",
  C.isExpandTarget({ ...SCHEDULES[3] }, "2026-08-12") === false);
ok("일정 자체가 없으면(삭제) 비대상", C.isExpandTarget(null, "2026-08-12") === false);

console.log("\n── ③ 펼침 산출물 판별 ──");
const SID = "HHwd9AEAtm7iSIU5mrOm";
const expanded = { id: `${SID}_2026-08-12`, source: "schedule", scheduleId: SID };
ok("id·source·scheduleId 세 조건 만족 = 산출물",
  C.isExpandedArtifact(expanded, SID, "2026-08-12") === true);
ok("🔴 수동 배차(랜덤 id)는 산출물 아님",
  C.isExpandedArtifact({ id: "abc123", source: "schedule", scheduleId: SID }, SID, "2026-08-12") === false);
ok("🔴 복사본(source 없음)은 산출물 아님",
  C.isExpandedArtifact({ id: `${SID}_2026-08-12`, scheduleId: SID }, SID, "2026-08-12") === false);
ok("다른 일정의 산출물은 제외",
  C.isExpandedArtifact({ id: `other_2026-08-12`, source: "schedule", scheduleId: "other" }, SID, "2026-08-12") === false);
ok("날짜가 어긋난 id 는 제외",
  C.isExpandedArtifact({ id: `${SID}_2026-08-11`, source: "schedule", scheduleId: SID }, SID, "2026-08-12") === false);

console.log("\n── ④ 운행 흔적 판정 ──");
ok("stopArrivals 있으면 흔적", C.hasRunTrace({ stopArrivals: { s1: {} } }) === true);
ok("preArrivalNotified 있으면 흔적", C.hasRunTrace({ preArrivalNotified: ["s1:pre1"] }) === true);
ok("빈 객체·빈 배열은 흔적 아님",
  C.hasRunTrace({ stopArrivals: {}, preArrivalNotified: [] }) === false);
ok("필드 부재는 흔적 아님", C.hasRunTrace({}) === false);

console.log("\n── ⑤ 정리 대상 선정 (신고 상황 재현) ──");
// 배시현 신고: 채드윅 등교 일정을 8/18 시작으로 수정 → 8/12~8/14 배차가 그대로 남음
const TODAY = "2026-08-12";
const changed = { active: true, weekdays: [1, 2, 3, 5], startDate: "2026-08-18", endDate: null, excludeHolidays: true, excludeDates: [] };
const mk = (day, extra = {}) => ({
  id: `${SID}_${day}`, source: "schedule", scheduleId: SID,
  routeName: "[한남1] 등교(월~수,금)", departTime: "06:25", ...extra,
});
const byDay = {
  "2026-08-10": [mk("2026-08-10")],                                   // 과거 — 보존
  "2026-08-11": [mk("2026-08-11", { stopArrivals: { a: {} } })],      // 과거 — 보존
  "2026-08-12": [mk("2026-08-12")],                                   // 오늘 — 대상
  "2026-08-13": [mk("2026-08-13")],                                   // 대상
  "2026-08-14": [mk("2026-08-14")],                                   // 대상
  "2026-08-18": [mk("2026-08-18")],                                   // 새 시작일 = 유지
  "2026-08-19": [mk("2026-08-19")],                                   // 유지
};
const r1 = C.selectPrunableDispatches({ scheduleId: SID, schedule: changed, dispatchesByDay: byDay, today: TODAY });
ok("🔴 신고 재현 — 8/12·13·14 3건이 정리 대상으로 잡힌다",
  r1.prunable.length === 3 && r1.prunable.map(p => p.day).join(",") === "2026-08-12,2026-08-13,2026-08-14",
  r1.prunable.map(p => p.day));
ok("과거 배차는 대상에서 제외(기록 보존)",
  !r1.prunable.some(p => p.day < TODAY) && !r1.keptWithTrace.some(p => p.day < TODAY));
ok("새 조건에 맞는 8/18·8/19 는 유지",
  !r1.prunable.some(p => p.day === "2026-08-18" || p.day === "2026-08-19"));
ok("결과는 날짜 오름차순",
  r1.prunable.map(p => p.day).join() === [...r1.prunable.map(p => p.day)].sort().join());

console.log("\n── ⑥ 정리 대상 선정 (보호 규칙) ──");
const withTrace = {
  "2026-08-12": [mk("2026-08-12", { stopArrivals: { s1: { actualAt: 1 } } })],
  "2026-08-13": [mk("2026-08-13")],
};
const r2 = C.selectPrunableDispatches({ scheduleId: SID, schedule: changed, dispatchesByDay: withTrace, today: TODAY });
ok("🔴 오늘 이미 운행 기록이 찍힌 배차는 지우지 않고 보고만",
  r2.prunable.length === 1 && r2.prunable[0].day === "2026-08-13" &&
  r2.keptWithTrace.length === 1 && r2.keptWithTrace[0].day === "2026-08-12",
  { prunable: r2.prunable.map(p => p.day), kept: r2.keptWithTrace.map(p => p.day) });

const manual = {
  "2026-08-12": [
    { id: "randomId123", source: "schedule", scheduleId: SID, routeName: "수기", departTime: "06:25" },
    { id: "copied456", scheduleId: SID, routeName: "복사본", departTime: "06:25" },
  ],
};
const r3 = C.selectPrunableDispatches({ scheduleId: SID, schedule: changed, dispatchesByDay: manual, today: TODAY });
ok("🔴 수동·복사 배차는 조건이 안 맞아도 건드리지 않는다",
  r3.prunable.length === 0 && r3.keptWithTrace.length === 0, r3);

const r4 = C.selectPrunableDispatches({ scheduleId: SID, schedule: null, dispatchesByDay: byDay, today: TODAY });
ok("일정 삭제 시 오늘 이후 산출물 전부가 대상(5건)",
  r4.prunable.length === 5, r4.prunable.map(p => p.day));

const stillOn = { active: true, weekdays: [1, 2, 3, 4, 5], startDate: "2026-01-01", endDate: null, excludeHolidays: true, excludeDates: [] };
const r5 = C.selectPrunableDispatches({ scheduleId: SID, schedule: stillOn, dispatchesByDay: byDay, today: TODAY });
ok("🔴 조건을 안 바꿨으면 아무것도 지우지 않는다(회귀 0)",
  r5.prunable.length === 0 && r5.keptWithTrace.length === 0, r5.prunable.map(p => p.day));

const r6 = C.selectPrunableDispatches({ scheduleId: SID, schedule: { ...stillOn, active: false }, dispatchesByDay: byDay, today: TODAY });
ok("비활성 전환 시 오늘 이후 산출물이 대상",
  r6.prunable.length === 5, r6.prunable.map(p => p.day));

ok("today 없으면 아무것도 고르지 않는다(안전 기본값)",
  C.selectPrunableDispatches({ scheduleId: SID, schedule: null, dispatchesByDay: byDay, today: null }).prunable.length === 0);
ok("빈 입력에서 throw 하지 않는다",
  C.selectPrunableDispatches({ scheduleId: SID, schedule: null, dispatchesByDay: {}, today: TODAY }).prunable.length === 0);

console.log("\n── ⑦ 날짜 범위 헬퍼 ──");
const up = C.upcomingDates("2026-08-12", 14);
ok("오늘 포함 14일", up.length === 14 && up[0] === "2026-08-12" && up[13] === "2026-08-25", [up[0], up[13]]);
ok("CF 펼침 범위(today+6)를 덮는다", C.PRUNE_LOOKAHEAD_DAYS >= 7, C.PRUNE_LOOKAHEAD_DAYS);
ok("월 경계를 넘긴다", C.upcomingDates("2026-08-30", 3).join() === "2026-08-30,2026-08-31,2026-09-01");

console.log("\n── ⑧ 소스 회귀 가드 ──");
const admin = fs.readFileSync(path.join(root, "src/pages/AdminApp.js"), "utf8");
ok("AdminApp 이 pruneScheduleDispatches 를 정의한다",
  /const pruneScheduleDispatches = async/.test(admin));
// 정의는 `const pruneScheduleDispatches = async (…)` 라 `이름(` 패턴에 안 걸린다 = 전부 호출부
const callCount = (admin.match(/await pruneScheduleDispatches\(/g) || []).length;
ok("수정·삭제·비활성 3경로에서 호출한다", callCount === 3, { callCount });
ok("정리 전 사용자 확인을 받는다",
  /window\.confirm\([\s\S]{0,400}함께 삭제할까요/.test(admin));
ok("🔴 삭제는 dispatches/{day}/list 문서 단위(컬렉션 통삭제 아님)",
  /deleteDoc\(doc\(db, "companies", companyId, "dispatches", p\.day, "list", p\.id\)\)/.test(admin));
const lib = fs.readFileSync(path.join(root, "src/lib/dispatchSchedule.js"), "utf8");
ok("🔴 클라 미러가 getDay() 를 쓰지 않는다", !/\.getDay\(\)/.test(lib));
ok("클라 미러에 Firebase import 가 없다", !/from ["']firebase/.test(lib));
const fn = fs.readFileSync(path.join(root, "functions/index.js"), "utf8");
ok("서버 shouldExpand 가 그대로 있다(미러 대상 존재)", /function shouldExpand\(schedule, day\)/.test(fn));

console.log(`\n${fail === 0 ? "✅ 전부 통과" : "❌ 실패 있음"} — pass ${pass} / fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
