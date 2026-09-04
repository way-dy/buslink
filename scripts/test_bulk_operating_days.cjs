// 격리 테스트 — 거래처 통합 운행일 설정(2026-09-04 배시현 개선요청 `Fk7rY3Ey…`).
//   node scripts/test_bulk_operating_days.cjs
// 🔴 Firebase 접속 0 · prod 읽기/쓰기 0. 정본을 **베끼지 않고 그대로 vm 에 태운다**.
//
// 이 기능은 **한 번 누르면 수십 개 일정이 동시에 바뀐다**. 그래서 잣대의 절반이
// «건드리면 안 되는 것을 안 건드렸는가» 쪽이다 — 비활성 일정 · 남의 거래처 · 다른 구분 ·
// 원래 안 다니는 날 · 거래처를 안 고른 상태.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const { HOLIDAY_SET } = require(path.join(root, "functions/holidays.js"));

function strip(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["'][^"']+["'];?$/gm, "")
    .replace(/^export\s+function\s+/gm, "function ")
    .replace(/^export\s+const\s+/gm, "var ");
}

// dispatchSchedule(판정 정본) → routeKind → bulkOperatingDays 순으로 한 컨텍스트에 쌓는다.
const ctx = vm.createContext({
  console, Date, Array, Object, Intl, Number, String, Set, Map, JSON,
  isKoreanHoliday: (d) => HOLIDAY_SET.has(d),
});
vm.runInContext(strip("src/lib/dispatchSchedule.js"), ctx);
vm.runInContext(strip("src/lib/routeKind.js"), ctx);
vm.runInContext(strip("src/lib/bulkOperatingDays.js"), ctx);

const {
  expandDateRange, runsOnIgnoringExcludes, blockedReasons,
  selectBulkTargets, planBulkOperatingDays, summarizeChange,
  BULK_MAX_DAYS, BULK_MODES,
} = ctx;

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log(`  ✅ ${n}`); }
  else { fail++; console.log(`  ❌ ${n}${x !== undefined ? ` — ${JSON.stringify(x)}` : ""}`); }
};

// ── 실제 모양의 표본(채드윅 = 등교/하교/방과후, 다른 거래처 하나를 섞는다) ──
const CHAD = "DY001-채드윅송도국제학교-2026-XXXX";
const OTHER = "DY001-다우디지털스퀘어-2026-YYYY";
// 🔴 구분(`routeKind`)은 이름이 아니라 `shift`/`type` 으로 갈린다 — 방과후만 이름으로 가른다.
//    그리고 prod 실측(2026-08-18)상 **하교와 방과후는 `shift`·`type` 이 똑같다**(하교/퇴근).
//    그래서 r2·r3 를 그 모양 그대로 둔다 — 이름으로 안 가르면 둘이 한 덩어리가 된다.
const ROUTES = [
  { id: "r1", name: "[G1] 등교(월~수,금) / To School", partnerCode: CHAD, shift: "등교", type: "출근" },
  { id: "r2", name: "[G1] 하교(15:50)", partnerCode: CHAD, shift: "하교", type: "퇴근" },
  { id: "r3", name: "[P] 방과후하교 / Late Activity Bus", partnerCode: CHAD, shift: "하교", type: "퇴근" },
  { id: "r4", name: "[한남1] 등교", partnerCode: CHAD, shift: "등교", type: "출근" },
  { id: "r9", name: "판교역 출근", partnerCode: OTHER, type: "출근" },
  { id: "rx", name: "거래처 미지정 노선", partnerCode: null, shift: "등교" },
  // 🔴 빈 문자열 거래처 — 「거래처 미지정 조기 반환」이 없으면 **거래처를 안 고른 상태가
  //    이 노선과 우연히 일치**해 그 일정이 대상으로 잡힌다(뮤테이션으로 실제로 확인한 구멍).
  { id: "r0", name: "거래처 빈값 노선", partnerCode: "", shift: "등교" },
];
const sched = (id, routeId, extra = {}) => ({
  id, name: `일정-${id}`, routeId,
  routeName: (ROUTES.find(r => r.id === routeId) || {}).name || "",
  weekdays: [1, 2, 3, 4, 5], startDate: "2026-03-02", endDate: null,
  excludeDates: [], excludeHolidays: true, active: true, ...extra,
});
const SCHEDULES = [
  sched("s1", "r1"),                              // 등교 · 평일
  sched("s2", "r2"),                              // 하교 · 평일
  sched("s3", "r3"),                              // 방과후 · 평일
  sched("s4", "r4", { weekdays: [1, 2, 3, 5] }),  // 등교 · 월화수금(목 제외)
  sched("s5", "r1", { active: false }),           // 🔴 비활성 — 건드리면 안 된다
  sched("s6", "r9"),                              // 🔴 남의 거래처
  sched("s7", "rx"),                              // 🔴 거래처 미지정 노선
  sched("s8", "r2", { excludeDates: ["2026-07-22"] }), // 이미 하루 쉬는 일정
  sched("s0", "r0"),                              // 🔴 거래처가 빈 문자열인 노선의 일정
];

console.log("\n[A] 기간 전개 — 잘못된 입력은 «빈 배열»(= 아무것도 안 한다)");
ok("정상 범위", expandDateRange("2026-07-20", "2026-07-24").join(",") === "2026-07-20,2026-07-21,2026-07-22,2026-07-23,2026-07-24");
ok("하루짜리", expandDateRange("2026-08-14", "2026-08-14").length === 1);
ok("역순은 빈 배열", expandDateRange("2026-08-14", "2026-07-20").length === 0);
ok("형식 오류는 빈 배열",
  expandDateRange("2026-7-20", "2026-07-24").length === 0 && expandDateRange("", "2026-07-24").length === 0);
ok("null·숫자도 빈 배열", expandDateRange(null, "2026-07-24").length === 0 && expandDateRange(20260720, 20260724).length === 0);
// 🔴 연도 오타(2026→2036)로 회사 전체를 10년치 멈추는 사고를 상한이 막는다.
ok(`상한 ${BULK_MAX_DAYS}일 초과는 빈 배열`, expandDateRange("2026-01-01", "2036-01-01").length === 0);
ok("상한 경계(정확히 상한)는 통과", expandDateRange("2026-01-01", "2026-07-05").length === BULK_MAX_DAYS);
// 🔴 UTC 로 더한다 — 로컬 시간대로 더하면 서버·다른 PC 에서 하루씩 밀린다(2026-07-27 계열).
ok("월·연 경계에서 밀리지 않는다",
  expandDateRange("2026-12-30", "2027-01-02").join(",") === "2026-12-30,2026-12-31,2027-01-01,2027-01-02");
ok("2월 말(윤년 아님) 경계", expandDateRange("2026-02-27", "2026-03-01").join(",") === "2026-02-27,2026-02-28,2026-03-01");

console.log("\n[B] 그 일정이 «원래» 그 날 다니는가 · 안 다니면 이유는");
const s1 = SCHEDULES[0];
ok("평일은 다닌다(2026-07-20 월)", runsOnIgnoringExcludes(s1, "2026-07-20") === true);
ok("토요일은 안 다닌다", runsOnIgnoringExcludes(s1, "2026-07-25") === false);
// excludeDates 를 무시하고 본다 — 이 함수의 존재 이유다.
ok("이미 쉬는 날이어도 «원래는 다닌다» 로 본다",
  runsOnIgnoringExcludes({ ...s1, excludeDates: ["2026-07-20"] }, "2026-07-20") === true);
ok("시작일 이전은 안 다닌다", runsOnIgnoringExcludes(s1, "2026-01-05") === false);
ok("종료일 이후는 안 다닌다", runsOnIgnoringExcludes({ ...s1, endDate: "2026-06-30" }, "2026-07-20") === false);
ok("이유: 운행 요일 아님", blockedReasons(s1, "2026-07-25").includes("운행 요일 아님"));
ok("이유: 일정 시작일 이전", blockedReasons(s1, "2026-01-05").includes("일정 시작일 이전"));
ok("이유: 일정 종료일 이후", blockedReasons({ ...s1, endDate: "2026-06-30" }, "2026-07-20").includes("일정 종료일 이후"));
ok("정상 운행일은 이유 없음", blockedReasons(s1, "2026-07-20").length === 0);
// 🔴 신호 유무 — 표본에 진짜 공휴일이 있어야 아래 단언이 공허하지 않다.
ok("표본 공휴일 실재(2026-08-15 광복절)", HOLIDAY_SET.has("2026-08-15"));
ok("이유: 공휴일", blockedReasons(s1, "2026-08-17").includes("공휴일") || blockedReasons(s1, "2026-08-15").length > 0);

console.log("\n[C] 대상 선별 — 건드리면 안 되는 것을 안 건드리는가");
const all = selectBulkTargets({ schedules: SCHEDULES, routes: ROUTES, partnerCode: CHAD, kinds: [] });
ok("채드윅 전체 구분 = 활성 5건(s1·s2·s3·s4·s8)",
  all.targets.map(t => t.id).join(",") === "s1,s2,s3,s4,s8", all.targets.map(t => t.id));
ok("🔴 비활성 일정은 대상에서 빠진다", !all.targets.some(t => t.id === "s5") && all.skippedInactive.length === 1);
ok("🔴 남의 거래처(s6) 미포함", !all.targets.some(t => t.id === "s6"));
ok("🔴 거래처 미지정 노선(s7) 미포함", !all.targets.some(t => t.id === "s7"));
// 🔴 거래처를 안 고르면 아무것도 안 잡힌다 — 「전체 거래처」 실수로 회사가 멈추는 것을 막는다.
// 🔴 표본에 `partnerCode: ""` 인 노선을 일부러 넣어 뒀다 — 조기 반환이 없으면 «거래처를 안 고른
//    상태» 가 그 노선과 일치해 그 일정이 대상에 들어온다(뮤테이션으로 실제로 확인한 구멍).
ok("🔴 표본에 빈 문자열 거래처 노선이 실재(신호 유무)", ROUTES.some(r => r.partnerCode === ""));
ok("거래처 미지정이면 대상 0건",
  selectBulkTargets({ schedules: SCHEDULES, routes: ROUTES, partnerCode: "", kinds: [] }).targets.length === 0);
ok("거래처 미지정이면 undefined·null 도 0건",
  selectBulkTargets({ schedules: SCHEDULES, routes: ROUTES, partnerCode: undefined, kinds: [] }).targets.length === 0 &&
  selectBulkTargets({ schedules: SCHEDULES, routes: ROUTES, partnerCode: null, kinds: [] }).targets.length === 0);
ok("구분 필터 — 등교만", selectBulkTargets({ schedules: SCHEDULES, routes: ROUTES, partnerCode: CHAD, kinds: ["등교"] })
  .targets.map(t => t.id).join(",") === "s1,s4");
ok("구분 필터 — 방과후만", selectBulkTargets({ schedules: SCHEDULES, routes: ROUTES, partnerCode: CHAD, kinds: ["방과후"] })
  .targets.map(t => t.id).join(",") === "s3");
// 🔴 하교와 방과후는 `shift` 로는 안 갈린다(2026-08-18) — 이름으로 가른 결과를 여기서 재확인.
ok("하교에 방과후가 섞이지 않는다", selectBulkTargets({ schedules: SCHEDULES, routes: ROUTES, partnerCode: CHAD, kinds: ["하교"] })
  .targets.map(t => t.id).join(",") === "s2,s8");
ok("모르는 구분을 고르면 대상 0건",
  selectBulkTargets({ schedules: SCHEDULES, routes: ROUTES, partnerCode: CHAD, kinds: ["야간"] }).targets.length === 0);
ok("빈 입력에도 안 던진다",
  selectBulkTargets({ schedules: null, routes: null, partnerCode: CHAD, kinds: null }).targets.length === 0);

console.log("\n[D] 운행 중지 — 방학 2026-07-20~08-14(신고 상황 재현)");
const VAC = expandDateRange("2026-07-20", "2026-08-14");
ok("🔴 신호 유무 — 기간이 실제로 26일", VAC.length === 26);
const off = planBulkOperatingDays({ targets: all.targets, days: VAC, mode: BULK_MODES.OFF });
ok("대상 5건 전부 바뀐다", off.changes.length === 5, off.changes.map(c => c.scheduleId));
const c1 = off.changes.find(c => c.scheduleId === "s1");
// 07-20~08-14 의 평일 수 = 20일(주말 6일 제외 · 이 기간에 공휴일 없음).
ok("평일 일정은 평일만 담는다(20일)", c1.added.length === 20, c1.added.length);
ok("🔴 주말은 담지 않는다", !c1.added.some(d => ["2026-07-25", "2026-07-26"].includes(d)));
ok("결과 배열은 정렬·중복 없음",
  c1.nextExcludeDates.join(",") === Array.from(new Set(c1.nextExcludeDates)).sort().join(","));
const c4 = off.changes.find(c => c.scheduleId === "s4");
ok("목요일 안 다니는 일정은 목요일을 안 담는다(16일)", c4.added.length === 16, c4.added.length);
const c8 = off.changes.find(c => c.scheduleId === "s8");
ok("이미 쉬는 날은 다시 담지 않는다", !c8.added.includes("2026-07-22") && c8.added.length === 19, c8.added.length);
ok("기존 휴무일은 보존된다", c8.nextExcludeDates.includes("2026-07-22"));
// 두 번 눌러도 같은 결과 — 운영자가 확인 없이 재실행할 수 있어야 한다.
const off2 = planBulkOperatingDays({
  targets: all.targets.map(t => ({ ...t, excludeDates: (off.changes.find(c => c.scheduleId === t.id) || {}).nextExcludeDates || t.excludeDates })),
  days: VAC, mode: BULK_MODES.OFF,
});
ok("🔴 멱등 — 다시 적용하면 바뀔 것이 없다", off2.changes.length === 0 && off2.unchanged.length === 5);
ok("공휴일이 낀 기간은 공휴일을 안 담는다(2026-08-15 광복절)", (() => {
  const days = expandDateRange("2026-08-10", "2026-08-21");
  const p = planBulkOperatingDays({ targets: [s1], days, mode: BULK_MODES.OFF });
  return !p.changes[0].added.includes("2026-08-15");
})());

console.log("\n[E] 운행 재개 — 막아 둔 날 되돌리기 · 못 되돌리는 날은 이유를 남긴다");
const onPlan = planBulkOperatingDays({
  targets: [{ ...s1, excludeDates: ["2026-07-21", "2026-07-22", "2026-09-01"] }],
  days: expandDateRange("2026-07-20", "2026-07-24"), mode: BULK_MODES.ON,
});
ok("기간 안의 휴무일만 해제(2건)", onPlan.changes[0].removed.join(",") === "2026-07-21,2026-07-22");
ok("🔴 기간 밖 휴무일(09-01)은 건드리지 않는다", onPlan.changes[0].nextExcludeDates.includes("2026-09-01"));
ok("해제할 것이 없으면 unchanged", (() => {
  const p = planBulkOperatingDays({ targets: [s1], days: VAC, mode: BULK_MODES.ON });
  return p.changes.length === 0 && p.unchanged.length === 1;
})());
// 🔴 이 화면이 거짓말하지 않게 하는 장치 — 되돌려도 여전히 쉬는 날의 이유를 모은다.
const onWeekend = planBulkOperatingDays({ targets: [s1], days: expandDateRange("2026-07-25", "2026-07-26"), mode: BULK_MODES.ON });
ok("주말을 켜려 하면 «운행 요일 아님» 이유가 남는다",
  onWeekend.blocked.length === 2 && onWeekend.blocked.every(b => b.reasons.includes("운행 요일 아님")));
ok("그때 excludeDates 는 안 바뀐다", onWeekend.changes.length === 0);

console.log("\n[F] 펼쳐진 배차 정리 — 무엇이 지워지는지까지 잰다");
// 🔴 이 경로가 유일하게 «삭제» 를 한다. 날짜별로 한 번씩 읽은 결과를 일정별로 나누는데,
//    남의 일정 배차가 섞이면 그 일정 기준으로 «조건에 안 맞는다» 판정이 나 **엉뚱한 배차가 지워진다.**
const day = (i) => new Date(Date.parse("2026-07-20T00:00:00Z") + i * 86400000).toISOString().slice(0, 10);
const disp = (sid, i, extra = {}) => ({
  id: `${sid}_${day(i)}`, scheduleId: sid, source: "schedule",
  routeName: "r", departTime: "07:00", ...extra,
});
const ENTRIES = [
  { day: day(0), docs: [disp("s1", 0), disp("s2", 0), disp("sX", 0)] },      // sX = 이번에 안 건드린 일정
  { day: day(1), docs: [disp("s1", 1), { id: "manual-1", routeName: "손으로 만든 배차" }] },
  { day: day(2), docs: [disp("s1", 2, { stopArrivals: { a: 1 } })] },        // 운행 흔적
];
const grouped = ctx.collectByScheduleDay(ENTRIES, ["s1", "s2"]);
ok("일정별·날짜별로 묶인다", Object.keys(grouped).sort().join(",") === "s1,s2");
ok("s1 은 3일치", Object.keys(grouped.s1).length === 3);
ok("🔴 이번에 안 건드린 일정(sX)은 안 들어온다", !grouped.sX);
ok("🔴 scheduleId 없는 수동 배차는 안 들어온다",
  !Object.values(grouped.s1).flat().some(d => d.id === "manual-1"));
ok("빈 입력에도 안 던진다", Object.keys(ctx.collectByScheduleDay(null, null)).length === 0);
// 실제 삭제 대상 판정까지 이어 본다 — 방학으로 막은 일정의 배차가 잡히는가.
const s1Off = { ...s1, excludeDates: [day(0), day(1), day(2)] };
const prune = ctx.selectPrunableDispatches({
  scheduleId: "s1", schedule: s1Off, dispatchesByDay: grouped.s1, today: day(0),
});
ok("🔴 신호 유무 — 막은 날의 배차가 실제로 잡힌다", prune.prunable.length === 2, prune.prunable.length);
ok("🔴 운행 기록이 있는 배차는 삭제 대상이 아니다",
  prune.keptWithTrace.length === 1 && !prune.prunable.some(p => p.day === day(2)));
// 대조군 — 안 막았으면 아무것도 안 지운다(이 검사가 공허하지 않다는 증거).
ok("막지 않은 일정은 삭제 대상 0건",
  ctx.selectPrunableDispatches({ scheduleId: "s1", schedule: s1, dispatchesByDay: grouped.s1, today: day(0) }).prunable.length === 0);

console.log("\n[G] 미리보기 문구 · 배선 가드");
ok("요약 한 줄", summarizeChange(c1).includes("휴무 추가") && summarizeChange(c1).includes("20일"));
ok("해제는 «휴무 해제»", summarizeChange(onPlan.changes[0]).includes("휴무 해제"));
const src = fs.readFileSync(path.join(root, "src/lib/bulkOperatingDays.js"), "utf8");
// 🔴 규칙 복제 금지 — 요일·공휴일 판정을 여기서 다시 쓰면 서버 미러와 갈린다.
ok("판정을 정본 shouldExpandOn 에 위임한다", /shouldExpandOn\(\{ \.\.\.schedule, excludeDates: \[\] \}/.test(src));
ok("공휴일 목록을 이 모듈이 직접 갖지 않는다", !/HOLIDAY|공휴일\s*목록|isKoreanHoliday/.test(src.replace(/^\s*\/\/.*$/gm, "")));
ok("거래처 미지정 조기 반환이 살아 있다", /if \(!partnerCode\) return \{ targets, skippedInactive \};/.test(src));
ok("비활성 일정 제외가 살아 있다", /s\.active === false/.test(src));
const adm = fs.readFileSync(path.join(root, "src/pages/AdminApp.js"), "utf8");
ok("관리자 화면이 이 모듈을 쓴다", /from "\.\.\/lib\/bulkOperatingDays"/.test(adm));

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass}/${pass + fail} 통과`);
process.exit(fail === 0 ? 0 : 1);
