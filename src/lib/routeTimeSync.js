// 노선 출발시각 변경 → 배차 일정·앞으로의 배차 함께 맞추기 — 순수 판정(Firebase import 0).
//
// 배경(2026-10-07 way): 출발시각이 세 군데(노선 `routes.departTime` · 배차 일정
//   `dispatchSchedules.departTime` · 날짜별 배차 `dispatches/{day}/list.departTime`)에 따로 있고,
//   배차·일정은 노선을 고를 때 시각을 **한 번 복사**할 뿐이다. 그래서 노선 시각을 바꾸면
//   승객앱만 바뀌고 일정·배차는 옛 시각 그대로 → 운영자가 세 곳을 각각 고쳐야 했다.
//
// 🔴 «옛 노선 시각과 같던 것만» 옮긴다. 한 노선을 하루 여러 번 도는 곳(7:10/7:50)은 일정·배차가
//    노선과 일부러 다른 시각을 들고 있다 — 그것까지 덮으면 회차가 하나로 뭉개진다.
// 🔴 과거 배차와 운행 흔적이 있는 배차는 기록이라 건드리지 않는다(dispatchSchedule.js 와 같은 규칙).
// 🔴 바꾸는 필드는 departTime 하나뿐이다. 기사·차량을 손으로 고친 배차(manualOverride)도
//    시각이 옛 노선 시각과 같았다면 «노선 시각을 따르던 것» 이므로 시각만 옮긴다.
import { hasRunTrace } from "./dispatchSchedule";

/** 노선 시각을 바꾼 뒤 배차를 살필 날짜 수(오늘 포함). 일정 펼침(today+6)·손 배차 여유분. */
export const ROUTE_TIME_SYNC_DAYS = 31;

/**
 * @param {object} p
 * @param {string} p.routeId
 * @param {string} p.oldTime          바꾸기 전 노선 출발시각 "HH:MM"
 * @param {string} p.newTime          바꾼 뒤 노선 출발시각 "HH:MM"
 * @param {Array}  p.schedules        [{id, routeId, departTime, ...}]
 * @param {object} p.dispatchesByDay  { 'YYYY-MM-DD': [{id, routeId, departTime, ...}] }
 * @param {string} p.today            'YYYY-MM-DD'(KST)
 * @returns {{schedules:Array, dispatches:Array, keptOtherTime:Array, keptWithTrace:Array}}
 *   schedules     — 시각을 옮길 일정 `{id, label}`
 *   dispatches    — 시각을 옮길 배차 `{day, id, routeName}`(날짜 오름차순)
 *   keptOtherTime — 이 노선이지만 다른 시각(다른 회차)이라 그대로 두는 일정·배차 수에 쓰는 목록
 *   keptWithTrace — 옛 시각이지만 이미 운행 기록이 있어 그대로 두는 배차
 */
export function selectRouteTimeSync({ routeId, oldTime, newTime, schedules, dispatchesByDay, today }) {
  const out = { schedules: [], dispatches: [], keptOtherTime: [], keptWithTrace: [] };
  const from = (oldTime || "").trim();
  const to = (newTime || "").trim();
  // 옛 시각이 없으면 «따르던 것» 을 가를 기준이 없다 → 아무것도 옮기지 않는다.
  if (!routeId || !from || !to || from === to) return out;

  for (const s of schedules || []) {
    if (!s || s.routeId !== routeId) continue;
    if ((s.departTime || "") === from) out.schedules.push({ id: s.id, label: s.name || s.routeName || "" });
    else out.keptOtherTime.push({ kind: "schedule", id: s.id, departTime: s.departTime || "" });
  }

  const days = Object.keys(dispatchesByDay || {}).sort();
  for (const day of days) {
    if (!today || day < today) continue; // 지난 배차는 그날 실제 운행 계획 = 기록
    for (const d of dispatchesByDay[day] || []) {
      if (!d || d.routeId !== routeId) continue;
      const row = { day, id: d.id, routeName: d.routeName || "" };
      if ((d.departTime || "") !== from) { out.keptOtherTime.push({ kind: "dispatch", ...row, departTime: d.departTime || "" }); continue; }
      if (hasRunTrace(d)) { out.keptWithTrace.push(row); continue; }
      out.dispatches.push(row);
    }
  }
  return out;
}
