// 노선 표시 시간창 (2026-08-05 회의 #2·#3) — 순수 함수. Firebase import 금지.
//
// 문제: 운행과 무관한 시각·장소에 있는 차가 승객/직원 앱 노선도에 떠 있었다
//   ("출발도착지에 아예 가지도 않았는데 노선도상에 버스가 표시되고 있다").
// 결정(way): "일단은 시간을 사용자가 입력하게끔 해 달라" — **노선 단위 직접 입력**
//   + 회사 기본값(출발 N분 전 ~ 도착 M분 후). 거래처 단위는 회의 앞부분 안이었으나
//   뒤에서 노선 단위로 뒤집혔다(늦은 발언이 정본).
// 🔴 '출발지 반경 진입' 조건은 1차에서 제외(way 승인) — 반경을 한 번 놓치면
//   그 운행 내내 차가 안 보이는 실패 모드가 생긴다. 시간창 효과부터 보고 판단.
//
// 서버 미러: functions/index.js 의 computeGpsWindow / routeWindowContains.
// 🔴 둘 중 하나만 고치지 말 것 — 표시(클라)와 수집(폴러)이 어긋나면 "관제엔 있는데
//    승객앱엔 없는" 상태가 된다.

export const WINDOW_PRE_MIN_DEFAULT = 30;      // 출발 전 여유
export const WINDOW_POST_MIN_DEFAULT = 30;     // 도착 후 여유
export const WINDOW_DEFAULT_DURATION_MIN = 120; // 정류장 offsetMin 이 전무할 때 기본 소요

/** "HH:MM" → 분(0~1439). 형식이 아니면 null. */
export function hhmmToMinutes(s) {
  if (typeof s !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/** 지금(Date) 의 KST 분(0~1439). */
export function nowMinutesKST(now = new Date()) {
  const s = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(now);
  return hhmmToMinutes(s);
}

function clampMin(v) { return v < 0 ? 0 : v > 1439 ? 1439 : v; }

/**
 * 노선 표시 시간창 산출.
 * @param route  { departTime?, displayStart?, displayEnd? }
 * @param stops  [{ offsetMin? }]  — 파생 창의 소요시간 산출용
 * @param opts   { preMin?, postMin? } 회사 기본값
 * @returns { startMin, endMin, source: "explicit"|"derived" } | null
 *
 * 🔴 null = 게이트 없음(관대한 폴백). 관리자가 시간을 안 넣었고 출발시각도 없으면
 *    예전처럼 항상 보인다 — 설정 전에 차가 통째로 사라지면 안 된다.
 */
export function computeRouteWindow(route, stops, opts) {
  if (!route) return null;

  // ① 관리자가 직접 넣은 창이 최우선(온세미처럼 하루 4~6회 도는 노선용)
  const es = hhmmToMinutes(route.displayStart);
  const ee = hhmmToMinutes(route.displayEnd);
  if (es !== null && ee !== null) return { startMin: es, endMin: ee, source: "explicit" };

  // ② 없으면 출발시각 ± 회사 기본값에서 파생
  const dep = hhmmToMinutes(route.departTime);
  if (dep === null) return null;

  const pre = Number.isFinite(opts?.preMin) ? opts.preMin : WINDOW_PRE_MIN_DEFAULT;
  const post = Number.isFinite(opts?.postMin) ? opts.postMin : WINDOW_POST_MIN_DEFAULT;

  let maxOffset = 0;
  for (const st of (stops || [])) {
    const o = st && st.offsetMin;
    if (typeof o === "number" && isFinite(o) && o > maxOffset) maxOffset = o;
  }
  const span = maxOffset > 0 ? maxOffset : WINDOW_DEFAULT_DURATION_MIN;
  return {
    startMin: clampMin(dep - pre),
    endMin: clampMin(dep + span + post),
    source: "derived",
  };
}

/** 창 안인가. 창이 null 이면 항상 true(게이트 없음).
 *  ⚠ end < start 면 자정을 넘긴 창(예 22:00~02:00)으로 해석한다. */
export function isWithinRouteWindow(win, nowMin) {
  if (!win) return true;
  if (nowMin === null || nowMin === undefined) return true; // 시각을 못 구하면 가리지 않는다
  const { startMin, endMin } = win;
  if (startMin <= endMin) return nowMin >= startMin && nowMin <= endMin;
  return nowMin >= startMin || nowMin <= endMin; // 자정 넘김
}

/** 화면 안내용 문구 — "07:20~09:40 에만 표시됩니다" 형태. 창 없으면 null. */
export function describeRouteWindow(win) {
  if (!win) return null;
  const f = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return `${f(win.startMin)}~${f(win.endMin)}`;
}

/** 회사 문서 → { preMin, postMin } 정규화(범위 밖·비수치는 기본값). */
export function normalizeWindowOpts(company) {
  const pick = (v, dflt) => {
    const n = Number(v);
    return isFinite(n) && n >= 0 && n <= 240 ? n : dflt;
  };
  return {
    preMin: pick(company?.gpsWindowPreMin, WINDOW_PRE_MIN_DEFAULT),
    postMin: pick(company?.gpsWindowPostMin, WINDOW_POST_MIN_DEFAULT),
  };
}
