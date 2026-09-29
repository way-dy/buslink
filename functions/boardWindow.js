// 노선별 「태깅 가능 시간」 게이트 — 순수 모듈(Firestore 접근 0 · 테스트가 격리 실행한다).
//
// 🔴 왜 생겼나 (2026-09-29 개선요청 3whpOuuC · 최우석)
//    같은 차량이 출근·퇴근을 둘 다 뛰는데 승객 앱은 「고른 노선」을 그대로 보낸다
//    (resolveStaticDispatchAdmin 의 selectedRouteId). 저녁 퇴근차에 타면서 앱에 출근
//    노선이 남아 있으면 **출근 노선으로 적재**됐다 — 시간 게이트가 없었다.
//
// 계약
//  - routes 문서의 선택 필드 `boardStart`/`boardEnd`("HH:MM"). **둘 다 유효할 때만** 창으로 인정.
//  - 한쪽만·둘 다 없음·형식 오류 = 게이트 없음(현상 유지). 🔴 displayStart·departTime 파생 창으로
//    **폴백하지 말 것** — 켜는 순간 창을 안 넣은 기존 노선이 전부 막힌다.
//  - 종료 < 시작 이면 자정을 넘긴 창(예 22:00~02:00). 종료 시각 그 분까지 포함.
//  - 판정만 한다. 다른 노선으로 **자동 적재하지 않는다**(승객이 앱에서 바꾸게 안내만).

/** "H:MM"/"HH:MM" → 분(0~1439) 또는 null. */
function hhmmToMin(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v == null ? "" : v).trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (h > 23 || mm > 59) return null;
  return h * 60 + mm;
}

function minToHHMM(n) {
  return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
}

/** 노선 문서 → { startMin, endMin } 또는 null(게이트 없음). */
function boardWindowOf(route) {
  if (!route) return null;
  const s = hhmmToMin(route.boardStart);
  const e = hhmmToMin(route.boardEnd);
  if (s === null || e === null) return null;
  return { startMin: s, endMin: e };
}

/** 창 안 판정 — 창 null 이면 항상 허용. 자정 넘김 처리. */
function boardWindowContains(win, nowMin) {
  if (!win) return true;
  if (nowMin === null || nowMin === undefined || !Number.isFinite(nowMin)) return true; // 시각 모름 → 막지 않는다
  if (win.startMin <= win.endMin) return nowMin >= win.startMin && nowMin <= win.endMin;
  return nowMin >= win.startMin || nowMin <= win.endMin;
}

function boardWindowLabel(win) {
  return win ? `${minToHHMM(win.startMin)}~${minToHHMM(win.endMin)}` : "";
}

/** Date → KST 분(0~1439). */
function kstNowMinutes(date) {
  const hm = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date || new Date());
  const v = hhmmToMin(hm === "24:00" ? "00:00" : hm);
  return v;
}

/**
 * 같은 차량 오늘 배차 중 하나 고르기 — resolveStaticDispatchAdmin 의 선택 규칙.
 * 기존 규칙 = departTime 이 지금과 가장 가까운 회차(미설정은 뒤로·동점은 앞선 것).
 * 보강(routesById 를 줄 때만) = 후보를 먼저 좁힌다:
 *   ① 태깅 창이 **지금 열린** 배차가 있으면 그것들만
 *   ② 없으면 창이 **닫힌** 배차를 뺀 것(창 미설정 배차)
 *   ③ 그것도 없으면 전체(= 판정은 게이트가 한다)
 * 🔴 창을 넣은 노선이 하나도 없으면 ①②가 전체와 같아 **결과가 기존과 동일**하다.
 * @param {Array<{routeId?:string, departTime?:string}>} pool
 * @param {number|null} nowMin
 * @param {Object<string,object>|null} routesById routeId → routes 문서 데이터
 */
function pickDispatch(pool, nowMin, routesById) {
  if (!Array.isArray(pool) || !pool.length) return null;
  let cand = pool;
  if (routesById && nowMin !== null && nowMin !== undefined) {
    const winOf = (d) => boardWindowOf(routesById[d.routeId]);
    const open = pool.filter((d) => { const w = winOf(d); return w && boardWindowContains(w, nowMin); });
    const noWin = pool.filter((d) => !winOf(d));
    cand = open.length ? open : (noWin.length ? noWin : pool);
  }
  const gap = (d) => {
    const m = hhmmToMin(d.departTime);
    return (m === null || nowMin === null || nowMin === undefined) ? Infinity : Math.abs(m - nowMin);
  };
  return cand.reduce((best, d) => (gap(d) < gap(best) ? d : best), cand[0]);
}

/**
 * 탑승 게이트 판정.
 * @param {object} p
 * @param {string} p.routeId      확정된 노선
 * @param {string} p.routeName    표시용(배차 routeName)
 * @param {Array<{routeId?:string, routeName?:string}>} p.dispatches 같은 차량 오늘 배차 전부(안내용)
 * @param {Object<string,object>} p.routesById
 * @param {number|null} p.nowMin
 * @returns {{ ok:true } | { ok:false, window:string, altRouteId:string|null, altRouteName:string|null, message:string }}
 */
function evaluateBoardGate({ routeId, routeName, dispatches, routesById, nowMin }) {
  const routes = routesById || {};
  const win = boardWindowOf(routes[routeId]);
  if (!win || boardWindowContains(win, nowMin)) return { ok: true };

  const nameOf = (rid, fallback) => fallback || (routes[rid] && routes[rid].name) || rid || "이 노선";
  const myName = nameOf(routeId, routeName);
  // 지금 창이 **명시적으로 열린** 다른 노선만 안내한다(창 미설정 노선은 근거가 없어 권하지 않는다).
  let alt = null;
  for (const d of (dispatches || [])) {
    if (!d || !d.routeId || d.routeId === routeId) continue;
    const w = boardWindowOf(routes[d.routeId]);
    if (w && boardWindowContains(w, nowMin)) { alt = d; break; }
  }
  const label = boardWindowLabel(win);
  let message = `지금은 ${myName} 태깅 시간이 아닙니다\n태깅 가능 시간: ${label}`;
  if (alt) {
    message += `\n지금은 ${nameOf(alt.routeId, alt.routeName)} 운행 시간입니다 — 앱에서 노선을 바꾼 뒤 다시 찍어주세요`;
  }
  return {
    ok: false,
    window: label,
    altRouteId: alt ? alt.routeId : null,
    altRouteName: alt ? nameOf(alt.routeId, alt.routeName) : null,
    message,
  };
}

module.exports = {
  hhmmToMin,
  boardWindowOf,
  boardWindowContains,
  boardWindowLabel,
  kstNowMinutes,
  pickDispatch,
  evaluateBoardGate,
};
