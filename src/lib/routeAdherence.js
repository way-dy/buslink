// 노선 준수 점검 — "배차된 차량이 그 노선을 실제로 지났는가" 판정 정본
// (2026-09-21 신촌세브란스 도봉 사고: 9/18~9/21 사흘간 배차 차량과 실 운행 차량이
//  달랐는데 아무 화면에도 안 드러나 승객만 겪었다. 그 사흘을 당일에 잡기 위한 판정.)
//
// 🔴 **이탈거리(경로에 수직 투영)로는 못 가른다** — 2026-09-21 실측:
//    사고 배차 1,320m 인데 정상인 용인 1,014m · 주안 1,264m · DB하이텍 1,559m 였다.
//    정류장 간격이 먼 노선은 정류장 직선과 실제 도로가 원래 크게 다르기 때문이다
//    (routePath 를 그려 둔 노선만 5~7m 로 정확한데, 노선 대부분은 routePath 가 없다).
//    그래서 **정류장을 실제로 지났는가** 두 가지로 판정한다:
//      ① 통과율 = 반경 NEAR_M 안에 궤적이 들어온 정류장 수 / 전체 정류장 수
//      ② 최근접 중앙값 = 정류장마다 가장 가까웠던 거리의 중앙값
//
//    2026-09-21 실측 분리(같은 날 오전 배차 전수):
//      사고 배차   1/11(9%)  · 1,568m      ← 이상
//      파주운정교하 3/10(30%) ·   376m      ← 정상(정류장 좌표가 도로에서 떨어진 노선)
//      김포        4/11(36%) ·   824m      ← 정상(단말 신호가 희박한 차량)
//      사고 배차 정상일(9/15) 10/11(91%) · 38m
//    → 두 조건을 **AND** 로 걸면 정상 배차가 한 건도 안 걸린다.
//
// 🔴 한쪽만 쓰지 말 것 — 통과율만 보면 파주(30%)·김포(36%)가 걸리고,
//    중앙값만 보면 김포(824m)가 애매해진다. 둘이 같이 나빠야 "다른 노선을 뛴 것"이다.
//
// 순수 함수 — Firebase import 금지.

/** 정류장 도착으로 칠 반경(m). 회사 설정 stopArriveRadiusM 과 별개 —
 *  여기서는 "지나갔나"를 넉넉하게 본다(도착 감지보다 느슨해야 오탐이 안 난다). */
export const NEAR_M = 300;

/** 이 점수 미만이면 궤적이 너무 적어 판정하지 않는다("신호 부족"으로 따로 분류).
 *  단말 2분 간격 기준 10점 = 약 20분치. 그보다 적으면 노선을 논할 근거가 없다. */
export const MIN_POINTS = 10;

/** 정류장이 이보다 적으면 통과율이 거칠어 판정하지 않는다. */
export const MIN_STOPS = 3;

/** 통과율이 이 값 미만이고 … */
export const RATIO_BAD = 0.25;
/** … 최근접 중앙값이 이 값을 넘으면 "다른 노선" 으로 본다. */
export const MEDIAN_BAD_M = 1000;

/** 운행 창 — 궤적을 이 범위로 좁혀 점수를 낸다(출발 전 차고지·다음 회차 혼입 차단). */
export const WINDOW_PRE_MIN = 30;
export const WINDOW_POST_MIN = 60;

const R = 6371000;
const RAD = Math.PI / 180;

/** 두 좌표 사이 거리(m). */
export function distanceM(aLat, aLng, bLat, bLng) {
  const dLat = (bLat - aLat) * RAD;
  const dLng = (bLng - aLng) * RAD;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * RAD) * Math.cos(bLat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** "HH:MM" → 분. 못 읽으면 null. */
export function hhmmToMin(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
  if (!m) return null;
  const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
  if (!(h >= 0 && h < 24 && mi >= 0 && mi < 60)) return null;
  return h * 60 + mi;
}

/** Timestamp | number | Date → ms. 못 읽으면 null. */
export function toMs(v) {
  if (!v) return null;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (typeof v === "number") return v;
  const d = typeof v.toDate === "function" ? v.toDate() : new Date(v);
  const ms = d.getTime();
  return isNaN(ms) ? null : ms;
}

/** 좌표가 유효한 정류장만. order 오름차순은 호출측 쿼리가 이미 보장하지만 여기서도 안전하게. */
export function usableStops(stops) {
  return (stops || [])
    .filter((s) => s && typeof s.lat === "number" && typeof s.lng === "number" &&
      isFinite(s.lat) && isFinite(s.lng))
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/**
 * 배차의 운행 창 [startMs, endMs]. 기준일 자정(ms)과 배차·정류장으로 만든다.
 * departTime 이 없으면 null(창 없음 = 궤적 전체를 쓴다).
 */
export function runWindow(dayStartMs, departTime, stops) {
  const dep = hhmmToMin(departTime);
  if (dep === null || !isFinite(dayStartMs)) return null;
  let maxOffset = 0;
  usableStops(stops).forEach((s) => {
    if (typeof s.offsetMin === "number" && isFinite(s.offsetMin) && s.offsetMin > maxOffset) {
      maxOffset = s.offsetMin;
    }
  });
  const span = maxOffset > 0 ? maxOffset : 120;
  return {
    startMs: dayStartMs + (dep - WINDOW_PRE_MIN) * 60000,
    endMs: dayStartMs + (dep + span + WINDOW_POST_MIN) * 60000,
  };
}

/**
 * 궤적 ↔ 노선 정류장 채점.
 * @param {Array} points [{lat,lng,ms}]
 * @param {Array} stops  [{id,name,lat,lng,order,offsetMin}]
 * @returns {{ n:number, total:number, hit:number, ratio:number, medianM:number|null,
 *             near:Array<{id,name,m,ms}> }}
 */
export function scoreAdherence(points, stops, opts) {
  const nearM = (opts && opts.nearM) || NEAR_M;
  const pts = (points || []).filter((p) => p && isFinite(p.lat) && isFinite(p.lng));
  const list = usableStops(stops);
  const near = list.map((s) => {
    let best = Infinity, bestMs = null;
    for (const p of pts) {
      const d = distanceM(s.lat, s.lng, p.lat, p.lng);
      if (d < best) { best = d; bestMs = p.ms ?? null; }
    }
    return { id: s.id, name: s.name || "", m: isFinite(best) ? Math.round(best) : null, ms: bestMs };
  });
  const measured = near.map((x) => x.m).filter((m) => m !== null).sort((a, b) => a - b);
  const hit = near.filter((x) => x.m !== null && x.m <= nearM).length;
  return {
    n: pts.length,
    total: list.length,
    hit,
    ratio: list.length ? hit / list.length : 0,
    medianM: measured.length ? measured[Math.floor(measured.length / 2)] : null,
    near,
  };
}

/**
 * 판정.
 *  "offroute"     — 배차된 차량이 그 노선을 안 지났다(관리자가 봐야 할 것)
 *  "insufficient" — 궤적·정류장이 모자라 판정 불가(신호 부족·정류장 미등록)
 *  "ok"           — 정상
 * 🔴 두 조건은 AND 다. 하나만으로 판정하면 정상 배차가 걸린다(머리 주석 실측 참조).
 * 🔴 **아직 출발 전인 배차는 여기 오기 전에 "pending" 으로 걸러진다**(adherenceRows).
 *    안 거르면 아침 점검에서 그날 퇴근 배차가 전부 "판정 불가" 로 쌓여 목록이 잡음이 된다
 *    (2026-09-21 실화면 실측: 67건 중 37건 · sleepingCheck 와 같은 교훈).
 */
export function adherenceVerdict(score, opts) {
  const o = opts || {};
  const minPoints = o.minPoints ?? MIN_POINTS;
  const minStops = o.minStops ?? MIN_STOPS;
  const ratioBad = o.ratioBad ?? RATIO_BAD;
  const medianBad = o.medianBadM ?? MEDIAN_BAD_M;
  if (!score || score.n < minPoints || score.total < minStops || score.medianM === null) {
    return "insufficient";
  }
  return (score.ratio < ratioBad && score.medianM > medianBad) ? "offroute" : "ok";
}

/** 화면용 한 줄 요약. */
export function adherenceLabel(score) {
  if (!score) return "—";
  const pct = score.total ? Math.round((score.hit / score.total) * 100) : 0;
  return `${score.hit}/${score.total} 통과 (${pct}%) · 최근접 중앙 ${score.medianM === null ? "—" : score.medianM + "m"}`;
}

/**
 * 배차 목록 채점 — 화면이 쓰는 진입점.
 * @param {Array} dispatches [{id, routeId, routeName, vehicleId, vehicleNo, driverName, departTime}]
 * @param {Object} stopsByRoute { routeId: stops[] }
 * @param {Object} pointsByVehicle { vehicleId: [{lat,lng,ms}] }
 * @param {number} dayStartMs 기준일 자정 ms
 * @param {Object} opts `nowMs` 를 주면 **아직 출발 전인 배차는 "pending"** 으로 표시한다
 *                      (화면은 기본으로 감춘다 — 그날 퇴근 배차가 아침 목록을 덮는 것 차단).
 * @returns {Array} 이상 → 판정불가 → 정상 → 운행 전 순, 같은 등급 안에서는 통과율 낮은 순
 */
export function adherenceRows(dispatches, stopsByRoute, pointsByVehicle, dayStartMs, opts) {
  const nowMs = opts && typeof opts.nowMs === "number" ? opts.nowMs : null;
  const rows = [];
  (dispatches || []).forEach((d) => {
    if (!d || !d.routeId || !d.vehicleId) return;
    const stops = (stopsByRoute || {})[d.routeId] || [];
    const all = (pointsByVehicle || {})[d.vehicleId] || [];
    const win = runWindow(dayStartMs, d.departTime, stops);
    const pts = win
      ? all.filter((p) => p && p.ms != null && p.ms >= win.startMs && p.ms <= win.endMs)
      : all;
    const score = scoreAdherence(pts, stops, opts);
    // 🔴 아직 운행 창이 열리지도 않았으면 판정하지 않는다(= 잡음). 창이 없으면(departTime 부재)
    //    판정을 미룰 근거가 없으므로 평소대로 본다.
    const pending = !!(nowMs !== null && win && nowMs < win.startMs);
    rows.push({
      id: d.id,
      routeId: d.routeId,
      routeName: d.routeName || "",
      vehicleId: d.vehicleId,
      vehicleNo: d.vehicleNo || "",
      driverName: d.driverName || "",
      departTime: d.departTime || "",
      score,
      verdict: pending ? "pending" : adherenceVerdict(score, opts),
    });
  });
  const rank = { offroute: 0, insufficient: 1, ok: 2, pending: 3 };
  return rows.sort((a, b) =>
    (rank[a.verdict] - rank[b.verdict]) ||
    (a.score.ratio - b.score.ratio) ||
    String(a.departTime).localeCompare(String(b.departTime)));
}
