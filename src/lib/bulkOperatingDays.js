// 거래처 통합 운행일 설정 (2026-09-04 배시현 개선요청 `Fk7rY3Ey…`)
//
// 요청: 「방학·재량휴업일·공휴일처럼 다수 노선이 같이 쉬는 기간에 배차 일정을 건별로
//   고쳐야 한다 — 한 번에 설정하게 해 달라」.
//
// 🔴 **새 데이터 모델을 만들지 않는다.** 일정별 휴무일은 이미 `dispatchSchedules/{id}.excludeDates`
//   이고 그 값을 읽는 정본은 `dispatchSchedule.js shouldExpandOn`(+ 서버 미러 `expandDispatchSchedules`)이다.
//   여기서 «통합 휴무 기간» 같은 별도 컬렉션을 만들면 **두 곳이 같은 질문에 다른 답을 하게 되고**,
//   서버 미러까지 손대야 해서 클라·서버가 갈리는 사고(2026-07-27 요일 밀림 계열)를 새로 연다.
//   이 모듈이 하는 일은 **여러 일정의 `excludeDates` 를 한 번에 계산해 주는 것**뿐이다.
//
// 🔴 «운행 재개» 는 만능이 아니다 — `excludeDates` 에서 날짜를 빼는 것뿐이라
//   ⓐ 공휴일(`excludeHolidays`) ⓑ 운행 요일이 아닌 날 ⓒ 일정 기간(`startDate`~`endDate`) 밖은
//   그대로 쉰다. 호출부는 `blockedReasons` 로 그 사실을 **화면에 밝혀야** 한다
//   (안 밝히면 「켰는데 왜 안 나오냐」가 그대로 다음 문의가 된다).
//
// 이 모듈은 **순수**(Firebase import 0) — 격리 테스트가 그대로 태운다.

import { shouldExpandOn, dayOfWeekForDate } from "./dispatchSchedule";
import { routeKind } from "./routeKind";

/** 한 번에 다룰 수 있는 최대 기간(일). 방학 두 달을 넉넉히 담으면서 연도 오타(2026→2036)를 막는다. */
export const BULK_MAX_DAYS = 186;

export const BULK_MODES = { OFF: "off", ON: "on" };
export const BULK_MODE_LABELS = {
  off: "운행 중지 (이 기간은 쉽니다)",
  on: "운행 (막아 둔 날을 되돌립니다)",
};

/**
 * `from`~`to`(포함) 날짜 문자열 배열. 잘못된 입력·역순·상한 초과는 **빈 배열**.
 * 🔴 UTC 자정으로 더한다 — 로컬 시간대로 하루씩 더하면 서버(UTC)에서 날짜가 밀린다
 *   (2026-07-27 `getDay()` 사고와 같은 계열).
 */
export function expandDateRange(from, to) {
  const RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
  if (typeof from !== "string" || typeof to !== "string") return [];
  if (!RE.test(from) || !RE.test(to)) return [];
  if (to < from) return [];
  const out = [];
  let t = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(t) || !Number.isFinite(end)) return [];
  while (t <= end) {
    out.push(new Date(t).toISOString().slice(0, 10));
    if (out.length > BULK_MAX_DAYS) return [];
    t += 86400000;
  }
  return out;
}

/**
 * 그 일정이 **원래** 그 날 운행하는가 — `excludeDates` 만 빼고 본다.
 * 🔴 규칙을 여기서 다시 쓰지 않고 정본 `shouldExpandOn` 에 빈 `excludeDates` 를 넘긴다.
 *   복제하면 요일·공휴일·기간 판정이 언젠가 갈린다.
 */
export function runsOnIgnoringExcludes(schedule, day) {
  if (!schedule) return false;
  return shouldExpandOn({ ...schedule, excludeDates: [] }, day);
}

/**
 * «운행 재개» 를 눌러도 그 날이 여전히 쉬는 이유. 없으면 빈 배열.
 * 화면이 이 이유를 그대로 보여 준다 — 「되돌렸는데 안 나온다」를 막는 유일한 장치다.
 */
export function blockedReasons(schedule, day) {
  const out = [];
  if (!schedule) return out;
  if (schedule.startDate && day < schedule.startDate) out.push("일정 시작일 이전");
  if (schedule.endDate && day > schedule.endDate) out.push("일정 종료일 이후");
  const wd = schedule.weekdays;
  if (!Array.isArray(wd) || wd.length === 0 || !wd.includes(dayOfWeekForDate(day))) out.push("운행 요일 아님");
  // 공휴일 판정은 정본에만 있으므로 나머지가 전부 통과했는데도 false 면 공휴일이다.
  if (out.length === 0 && !runsOnIgnoringExcludes(schedule, day)) out.push("공휴일");
  return out;
}

/**
 * 이번 일괄 적용의 대상 일정 고르기.
 * @param {Array}  schedules  회사 전체 배차 일정
 * @param {Array}  routes     회사 전체 노선(거래처·구분 판정용)
 * @param {string} partnerCode 거래처 업체코드(필수 — 「전체 거래처」는 허용하지 않는다)
 * @param {Array}  kinds      운행 구분(`routeKind`) 목록. 비었으면 **전체 구분**
 * @returns {{targets:Array, skippedInactive:Array}}
 *
 * 🔴 **비활성 일정은 대상에서 뺀다** — 지금 안 나가는 일정에 휴무일을 심어 두면
 *   나중에 켰을 때 «왜 이 날만 빠지지» 를 아무도 설명 못 한다. 대신 몇 개를 뺐는지 돌려준다.
 * 🔴 **거래처는 반드시 지정한다** — 「전체 거래처」를 허용하면 한 번의 실수로 회사 전 노선이 멈춘다.
 */
export function selectBulkTargets({ schedules, routes, partnerCode, kinds }) {
  const targets = [];
  const skippedInactive = [];
  if (!partnerCode) return { targets, skippedInactive };
  const routeById = new Map((Array.isArray(routes) ? routes : []).map((r) => [r.id, r]));
  const kindSet = Array.isArray(kinds) && kinds.length > 0 ? new Set(kinds) : null;
  for (const s of Array.isArray(schedules) ? schedules : []) {
    if (!s || !s.id) continue;
    const r = routeById.get(s.routeId);
    if (!r || r.partnerCode !== partnerCode) continue;
    if (kindSet && !kindSet.has(routeKind(r))) continue;
    if (s.active === false) { skippedInactive.push(s); continue; }
    targets.push(s);
  }
  return { targets, skippedInactive };
}

/**
 * 대상 일정마다 바뀔 `excludeDates` 를 계산한다. **쓰기는 하지 않는다**(호출부 몫).
 * @param {Array}  targets  `selectBulkTargets` 결과
 * @param {Array}  days     `expandDateRange` 결과
 * @param {string} mode     BULK_MODES.OFF | BULK_MODES.ON
 * @returns {{changes:Array, unchanged:Array, blocked:Array}}
 *   changes  = [{ scheduleId, name, routeName, nextExcludeDates, added:[], removed:[] }]
 *   unchanged= 바꿀 것이 없는 일정(이미 그렇게 돼 있음)
 *   blocked  = ON 인데 다른 이유로 여전히 쉬는 날 [{ scheduleId, name, day, reasons }]
 *
 * 🔴 OFF 는 **그 일정이 원래 운행하는 날만** 담는다 — 토요일까지 넣으면 `휴무 N일` 숫자가
 *   의미를 잃고 배열만 커진다(문서 1MB 상한도 이 배열이 먹는다).
 */
export function planBulkOperatingDays({ targets, days, mode }) {
  const changes = [];
  const unchanged = [];
  const blocked = [];
  const dayList = Array.isArray(days) ? days : [];
  for (const s of Array.isArray(targets) ? targets : []) {
    const cur = Array.isArray(s.excludeDates) ? s.excludeDates.filter((d) => typeof d === "string") : [];
    const curSet = new Set(cur);
    const added = [];
    const removed = [];
    if (mode === BULK_MODES.ON) {
      for (const d of dayList) {
        if (curSet.has(d)) { removed.push(d); continue; }
        const why = blockedReasons(s, d);
        if (why.length > 0) blocked.push({ scheduleId: s.id, name: s.name || "", day: d, reasons: why });
      }
    } else {
      for (const d of dayList) {
        if (curSet.has(d)) continue;                 // 이미 쉬는 날
        if (!runsOnIgnoringExcludes(s, d)) continue; // 원래 안 다니는 날
        added.push(d);
      }
    }
    if (added.length === 0 && removed.length === 0) { unchanged.push(s); continue; }
    const next = mode === BULK_MODES.ON
      ? cur.filter((d) => !removed.includes(d))
      : [...cur, ...added];
    changes.push({
      scheduleId: s.id,
      name: s.name || "",
      routeName: s.routeName || "",
      nextExcludeDates: Array.from(new Set(next)).sort(),
      added, removed,
    });
  }
  return { changes, unchanged, blocked };
}

/**
 * 날짜별로 읽어 온 배차를 `selectPrunableDispatches` 가 받는 모양
 * (`{ [scheduleId]: { [day]: [배차] } }`)으로 묶는다.
 *
 * 🔴 일정마다 14일치를 따로 읽지 않기 위한 함수다 — 일정 29개면 406번 읽는다.
 *   날짜별로 **한 번씩만** 읽고(14번) 여기서 나눈다.
 * 🔴 `scheduleIds` 에 없는 배차는 버린다 — 이번에 안 건드린 일정의 배차가 섞이면
 *   그 일정 기준으로 «조건에 안 맞는다» 는 판정이 나와 **엉뚱한 배차가 지워진다.**
 *
 * @param {Array} entries  [{ day, docs:[{id, scheduleId, ...}] }]
 * @param {Array} scheduleIds 이번에 바뀐 일정 id 목록
 */
export function collectByScheduleDay(entries, scheduleIds) {
  const allow = new Set(Array.isArray(scheduleIds) ? scheduleIds : []);
  const out = {};
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || !e.day) continue;
    for (const d of Array.isArray(e.docs) ? e.docs : []) {
      if (!d || !d.scheduleId || !allow.has(d.scheduleId)) continue;
      const byDay = (out[d.scheduleId] = out[d.scheduleId] || {});
      (byDay[e.day] = byDay[e.day] || []).push(d);
    }
  }
  return out;
}

/** 미리보기 한 줄 — `[강남1] 등교 · 12일 휴무 추가`. */
export function summarizeChange(c) {
  const n = c.added.length || c.removed.length;
  return `${c.name || c.routeName || c.scheduleId} · ${n}일 ${c.added.length ? "휴무 추가" : "휴무 해제"}`;
}
