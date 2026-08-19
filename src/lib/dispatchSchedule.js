// 배차 일정(dispatchSchedules) → 펼침 배차(dispatches) 판정 — 순수 모듈(Firebase import 0).
//
// 배경(2026-08-12 배시현 개선요청 `k49E7GXEVfe0WT9h4QI6` "배차일정 8/18로 수정했는데 금일 오전 관제가 됨"):
//   `expandDispatchSchedules`(CF)는 **만들기만 하고 지우지 않는다**(멱등 id `${scheduleId}_${day}` +
//   exists() skip — 일별 수동 수정을 보존하려는 의도적 설계). 그래서 일정의 시작일을 미래로 밀거나
//   요일을 줄이거나 비활성으로 바꿔도 **이미 펼쳐진 배차는 그대로 남는다.**
//   남은 배차는 단순한 표시 문제가 아니다 — `pollDeviceVehicleGps` 가 그것을 "오늘 배차"로 읽어
//   단말 차량 좌표를 쓰기 시작하므로 승객·직원앱에 `1대 운행중` 이 뜬다(신고 화면 그대로).
//
// 🔴 서버 미러: `dayOfWeekForDate`/`shouldExpandOn` 은 functions/index.js 의
//    `dayOfWeekKST`/`shouldExpand` 와 **같은 계약**이다. 한쪽만 고치면 관리 화면이 지운 배차를
//    그날 밤 CF 가 다시 만들어 놓는다(또는 그 반대). 반드시 둘을 함께 고칠 것 —
//    일치는 `scripts/test_schedule_prune.cjs` 가 두 소스에서 직접 뽑아 대조한다.
import { isKoreanHoliday } from "./holidays";

// 관리 화면이 정리 대상을 훑는 날짜 범위. CF 펼침은 today+6 까지라 14일이면 충분한 여유.
export const PRUNE_LOOKAHEAD_DAYS = 14;

/**
 * 'YYYY-MM-DD' 의 요일(일=0 ... 토=6).
 * 🔴 `getDay()` 를 쓰지 말 것 — 로컬 시간대를 타서 UTC 서버에서 하루 밀린다
 *    (2026-07-27 "배차일정 하루 밀림" 결함의 근인). 날짜 문자열의 요일은 시간대와 무관한
 *    달력 계산이므로 UTC 자정 + getUTCDay 로 고정한다.
 */
export function dayOfWeekForDate(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

/** 오늘(KST) 'YYYY-MM-DD'. */
export function todayKST(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(now);
}

/** today 부터 days 일치 날짜 배열(오늘 포함). */
export function upcomingDates(today, days = PRUNE_LOOKAHEAD_DAYS) {
  const base = new Date(`${today}T00:00:00Z`).getTime();
  const out = [];
  for (let i = 0; i < days; i++) {
    out.push(new Date(base + i * 86400000).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * 일정 하나가 그 날짜에 펼쳐져야 하는지. **CF `shouldExpand` 미러**(active 는 보지 않는다 —
 * CF 는 `where active==true` 쿼리로 걸러 오므로 그 조건은 `isExpandTarget` 이 담당).
 */
export function shouldExpandOn(schedule, day) {
  if (!schedule) return false;
  if (schedule.startDate && day < schedule.startDate) return false;
  if (schedule.endDate && day > schedule.endDate) return false;
  if (!Array.isArray(schedule.weekdays) || schedule.weekdays.length === 0) return false;
  if (!schedule.weekdays.includes(dayOfWeekForDate(day))) return false;
  if (Array.isArray(schedule.excludeDates) && schedule.excludeDates.includes(day)) return false;
  if (schedule.excludeHolidays !== false && isKoreanHoliday(day)) return false;
  return true;
}

/** CF 가 실제로 그 날짜에 배차를 만들 대상인지(비활성 일정 포함 판정). */
export function isExpandTarget(schedule, day) {
  return !!schedule && schedule.active === true && shouldExpandOn(schedule, day);
}

/** 멱등 배차 ID — CF 와 같은 규칙. */
export function expandedDispatchId(scheduleId, day) {
  return `${scheduleId}_${day}`;
}

/**
 * 그 배차가 이 일정의 **펼침 산출물**인지. id 규칙과 `source` 를 모두 본다.
 * 🔴 이 검사를 느슨하게 하지 말 것 — 운영자가 손으로 만든 배차(랜덤 id)나 복사본이
 *    정리 대상으로 딸려 들어가면 그날 운행이 통째로 사라진다.
 */
export function isExpandedArtifact(dispatch, scheduleId, day) {
  if (!dispatch || !scheduleId) return false;
  if (dispatch.source !== "schedule") return false;
  if (dispatch.scheduleId !== scheduleId) return false;
  return dispatch.id === expandedDispatchId(scheduleId, day);
}

/**
 * 그 배차에 운행 흔적이 남아 있는지(도착 기록·도착임박 발송 마커).
 * 흔적이 있으면 그날 실제로 차가 다녔다는 뜻이라 **지우지 않고 보고만** 한다.
 */
export function hasRunTrace(dispatch) {
  if (!dispatch) return false;
  const arrivals = dispatch.stopArrivals;
  if (arrivals && typeof arrivals === "object" && Object.keys(arrivals).length > 0) return true;
  if (Array.isArray(dispatch.preArrivalNotified) && dispatch.preArrivalNotified.length > 0) return true;
  return false;
}

/**
 * 일정이 바뀐(또는 삭제된) 뒤 남아 있는 펼침 배차 중 정리 대상을 고른다.
 *
 * @param {object}      p
 * @param {string}      p.scheduleId
 * @param {object|null} p.schedule        변경 후 일정(삭제면 null)
 * @param {object}      p.dispatchesByDay { 'YYYY-MM-DD': [{id, ...배차}] }
 * @param {string}      p.today           'YYYY-MM-DD'(KST)
 * @returns {{prunable: Array, keptWithTrace: Array}}
 *   prunable      — 지워도 되는 것(날짜 오름차순)
 *   keptWithTrace — 조건은 안 맞지만 운행 흔적이 있어 남기는 것
 */
/**
 * 일정이 펼침 배차에 물려주는 필드. 여기 없는 것(date·scheduleId·source·stopArrivals 등)은
 * 배차 고유값이라 절대 덮어쓰지 않는다.
 */
export const SCHEDULE_SYNCED_FIELDS = [
  "driverId", "driverName", "routeId", "routeName", "vehicleId", "vehicleNo", "departTime",
];

/**
 * 그 배차가 **그날 하루만 손으로 고친 것**인지.
 * CF 펼침은 만들기만 하고 지우지 않는 대신 일별 수동 수정을 보존한다 — 그 약속을 깨지 않으려면
 * 일정 값을 되씌우기 전에 이 표시를 봐야 한다. 표시가 붙기 전(2026-08-20 이전)에 고친 배차는
 * 구분할 방법이 없어 일정 값으로 맞춰진다(일정이 정본이라는 기본 규칙 쪽으로 넘어간다).
 */
export function isManuallyOverridden(dispatch) {
  return !!dispatch && dispatch.manualOverride === true;
}

/**
 * 일정이 바뀐 뒤에도 **여전히 펼침 대상인** 날짜에서, 배차 값이 일정과 어긋난 것을 고른다.
 *
 * 배경(2026-08-20 배시현 개선요청 `mXPK2Y19LvONbgJTMgar` "배차차량을 바꿔도 다음날 다시 돌아옵니다"):
 *   CF 는 `exists()` 면 skip 하므로 **일정을 고쳐도 이미 펼쳐진 날짜는 옛 값 그대로** 남는다.
 *   운영자가 그날 배차를 손으로 고쳐도 다음 날짜에 또 옛 값이 나와 "매일 바꾸는데 돌아온다"가 된다
 *   (prod 실측: 차량을 8/18 에 바꿨는데 8/21·8/24 배차가 옛 차량을 들고 있었다).
 *   `selectPrunableDispatches` 는 **대상에서 빠진 날짜**만 다루므로 이 함수가 나머지 절반이다.
 *
 * @returns {{updatable: Array, keptManual: Array, keptWithTrace: Array}}
 *   updatable    — 일정 값으로 맞출 것. `{day, id, routeName, departTime, changes:[{field,from,to}], patch}`
 *   keptManual   — 그날만 손으로 고쳐 둔 것(건드리지 않음)
 *   keptWithTrace— 이미 운행 흔적이 남은 것(건드리지 않음)
 */
export function selectUpdatableDispatches({ scheduleId, schedule, dispatchesByDay, today }) {
  const updatable = [];
  const keptManual = [];
  const keptWithTrace = [];
  if (!schedule) return { updatable, keptManual, keptWithTrace };
  const days = Object.keys(dispatchesByDay || {}).sort();
  for (const day of days) {
    // 과거는 기록이다 — 일정이 바뀌어도 지난 배차는 그날 실제 운행 계획으로 남긴다.
    if (!today || day < today) continue;
    if (!isExpandTarget(schedule, day)) continue; // 빠진 날짜는 prune 쪽 몫
    for (const d of dispatchesByDay[day] || []) {
      if (!isExpandedArtifact(d, scheduleId, day)) continue;
      const changes = SCHEDULE_SYNCED_FIELDS
        .map(f => ({ field: f, from: d[f] ?? "", to: schedule[f] ?? "" }))
        .filter(c => c.from !== c.to);
      if (changes.length === 0) continue;
      const row = { day, id: d.id, routeName: d.routeName || "", departTime: d.departTime || "", changes };
      // 🔴 순서가 곧 정책이다 — 운행 흔적이 먼저다. 그날 차가 이미 다녔으면 손으로 고쳤든
      //    아니든 기록이라 덮어쓰지 않는다.
      if (hasRunTrace(d)) { keptWithTrace.push(row); continue; }
      if (isManuallyOverridden(d)) { keptManual.push(row); continue; }
      row.patch = Object.fromEntries(changes.map(c => [c.field, c.to]));
      updatable.push(row);
    }
  }
  return { updatable, keptManual, keptWithTrace };
}

export function selectPrunableDispatches({ scheduleId, schedule, dispatchesByDay, today }) {
  const prunable = [];
  const keptWithTrace = [];
  const days = Object.keys(dispatchesByDay || {}).sort();
  for (const day of days) {
    // 과거는 기록이다 — 조건이 안 맞아도 손대지 않는다.
    if (!today || day < today) continue;
    for (const d of dispatchesByDay[day] || []) {
      if (!isExpandedArtifact(d, scheduleId, day)) continue;
      if (isExpandTarget(schedule, day)) continue; // 여전히 정상 대상
      const row = { day, id: d.id, routeName: d.routeName || "", departTime: d.departTime || "" };
      if (hasRunTrace(d)) keptWithTrace.push(row);
      else prunable.push(row);
    }
  }
  return { prunable, keptWithTrace };
}
