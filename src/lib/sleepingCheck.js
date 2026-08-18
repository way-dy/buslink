// 슬리핑 차일드 확인 — 표시·판정 정본 (2026-08-18 배시현 건의 `Eg8ZbQTMmPR6AAYo4fp0`)
//
// 기록은 서버(CF `recordSleepingCheck`)가 배차 문서의 `sleepingCheck` 에 남긴다.
// 여기서는 **화면이 "확인됨 / 확인 대기 / 미확인(늦음)" 을 같은 규칙으로** 읽게 한다.
//
// 🔴 "미확인" 은 시계만으로 정하지 않는다 — **운행이 끝났다는 선행 사건**(마지막 정류장 도착)
//    이 있어야 한다. 출발도 안 한 배차를 미확인으로 세면 아침마다 빨간 목록이 쌓이고,
//    그 목록은 곧 아무도 안 본다.
//
// 🔴 마지막 정류장은 `order` 로 **정렬한 배열의 마지막**이다(raw order 산술 금지 — 결번 안전.
//    `runStatus.js`·CF `notifyPreArrival` 과 같은 규칙).
//
// 순수 함수 — Firebase import 금지.

// 종점 도착 후 이 시간이 지나도록 확인이 없으면 "미확인"으로 본다.
// 🔴 0 으로 두지 말 것 — 기사가 승객을 내려주고 뒷자리까지 걸어가는 데 걸리는 시간이다.
export const SLEEP_CHECK_GRACE_MS = 10 * 60 * 1000;

/** Timestamp | number | Date → ms. 못 읽으면 null. */
export function toMs(v) {
  if (!v) return null;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (typeof v === "number") return v;
  const d = typeof v.toDate === "function" ? v.toDate() : new Date(v);
  const ms = d.getTime();
  return isNaN(ms) ? null : ms;
}

/** 이 배차의 확인 시각(ms). 없으면 null. */
export function sleepCheckedAt(dispatch) {
  return toMs(dispatch && dispatch.sleepingCheck && dispatch.sleepingCheck.checkedAt);
}

/** 이 배차의 종점 도착 시각(ms). 정류장 정보가 없거나 아직이면 null. */
export function terminalArrivalMs(dispatch, stops) {
  const list = (stops || []).filter(s => s && s.id);
  if (list.length === 0) return null;
  const sorted = [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const last = sorted[sorted.length - 1];
  const rec = (dispatch && dispatch.stopArrivals) ? dispatch.stopArrivals[last.id] : null;
  return toMs(rec && rec.actualAt);
}

/**
 * 배차 하나의 상태.
 *  "checked"  — 확인 완료
 *  "late"     — 운행이 끝났는데 유예 시간이 지나도록 확인 없음(=관리자가 봐야 할 것)
 *  "waiting"  — 운행이 끝났고 유예 시간 안(정상 대기)
 *  "running"  — 아직 종점 도착 기록이 없음(운행 전·운행 중) → 목록에 올리지 않는다
 */
export function sleepCheckState(dispatch, stops, now = Date.now(), graceMs = SLEEP_CHECK_GRACE_MS) {
  if (sleepCheckedAt(dispatch)) return "checked";
  const end = terminalArrivalMs(dispatch, stops);
  if (end == null) return "running";
  return (now - end) >= graceMs ? "late" : "waiting";
}

/**
 * 관리자 화면용 — 지금 손봐야 할 배차(late)만, 오래 기다린 순.
 * @param {Array}  dispatches   오늘 배차 [{id, routeId, routeName, vehicleNo, driverName, stopArrivals, sleepingCheck}]
 * @param {Object} stopsByRoute { routeId: [{id, order}] }
 */
export function pendingSleepChecks(dispatches, stopsByRoute, now = Date.now(), graceMs = SLEEP_CHECK_GRACE_MS) {
  const out = [];
  (dispatches || []).forEach(d => {
    const stops = (stopsByRoute || {})[d.routeId];
    if (sleepCheckState(d, stops, now, graceMs) !== "late") return;
    const end = terminalArrivalMs(d, stops);
    out.push({ ...d, endedAt: end, waitedMs: end == null ? 0 : now - end });
  });
  return out.sort((a, b) => b.waitedMs - a.waitedMs);
}

// 🔴 **QR 은 사진으로 복제된다**(2026-08-18 way 지적). 종이 QR 로 "그 자리에 있었다"를
//    증명하는 건 원리적으로 불가능하다 — 실질 방어는 NFC 태그뿐이다. 그래서 QR 확인은
//    **막지 말고 드러낸다**: 아래 판정이 관제에 "확인은 됐지만 미심쩍다"를 띄운다.
//    ⚠ 이건 고발이 아니라 **눈에 띄게 하기**다 — 자동으로 무효화하지 않는다.
//       (위치는 권한 거부·실내 오차로 빌 수 있고, 그걸로 확인을 무효화하면 기능이 죽는다)
export const SLEEP_CHECK_FAST_SEC = 20; // 종점 도착 후 이보다 빨리 찍히면 "걸어갈 시간이 없었다"

/**
 * 확인 기록이 미심쩍은가 — { suspicious, reasons[] }.
 *  - far      : 종점(또는 차량)에서 300m 넘게 떨어진 곳에서 찍힘(서버가 nearOk=false 로 기록)
 *  - noPlace  : 위치를 못 받음(권한 거부·실내) — 단독으로는 약한 신호
 *  - tooFast  : 종점 도착 20초 안에 찍힘(맨 뒤까지 걸어갈 수 없는 시간)
 * 🔴 NFC 확인은 물리적 접촉이 강제되므로 위치 신호로 의심하지 않는다.
 */
export function sleepCheckAudit(dispatch) {
  const c = dispatch && dispatch.sleepingCheck;
  if (!c || !c.checkedAt) return { suspicious: false, reasons: [] };
  const reasons = [];
  if (c.via !== "nfc") {
    if (c.nearOk === false) reasons.push("far");
    else if (c.nearOk == null && c.distanceM == null) reasons.push("noPlace");
  }
  if (typeof c.afterTerminalSec === "number" && c.afterTerminalSec < SLEEP_CHECK_FAST_SEC) reasons.push("tooFast");
  // 위치 없음(noPlace) 하나만으로는 의심으로 올리지 않는다 — 실내·권한 거부가 흔하다.
  const strong = reasons.some(r => r === "far" || r === "tooFast");
  return { suspicious: strong, reasons };
}

export function sleepAuditLabel(reasons) {
  if (!reasons || reasons.length === 0) return "";
  const m = { far: "종점에서 먼 곳", noPlace: "위치 미확인", tooFast: "도착 직후 즉시" };
  return reasons.map(r => m[r] || r).join(" · ");
}
/** 오늘 확인 현황 요약 — 종점 도착한 배차 기준(운행 전은 모수에서 뺀다). */
export function sleepCheckSummary(dispatches, stopsByRoute, now = Date.now(), graceMs = SLEEP_CHECK_GRACE_MS) {
  let done = 0, late = 0, waiting = 0;
  (dispatches || []).forEach(d => {
    const s = sleepCheckState(d, (stopsByRoute || {})[d.routeId], now, graceMs);
    if (s === "checked") done++;
    else if (s === "late") late++;
    else if (s === "waiting") waiting++;
  });
  return { done, late, waiting, total: done + late + waiting };
}

export function formatWaited(ms) {
  if (!ms || ms < 0) return "";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}분째`;
  const h = Math.floor(m / 60);
  return `${h}시간 ${m % 60}분째`;
}
