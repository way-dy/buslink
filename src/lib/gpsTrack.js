// GPS 이력 궤적 분해 — 순수 모듈(Firebase import 0). 운행 이력 지도의 정본 판정.
//
// 배경(2026-08-18 way 점검 "경로가 정확하지 않고 직선으로 나온다"):
//   운행 이력의 파랑 선은 도로 경로가 아니라 **수신한 GPS 점을 순서대로 이은 선**이다.
//   단말(유비칸) 차량은 좌표를 1~2분에 한 번 보내므로(prod 실측: 원천 CarLocationAll 이
//   중앙 120초 간격·점 사이 중앙 463m) 점과 점 사이는 필연적으로 직선이 된다.
//   즉 "굽지 않는 것"은 그리기 결함이 아니라 표본 간격이다.
//
//   그래서 화면이 해야 할 일은 두 가지다.
//     ① 표본 간격을 숫자로 드러내 "왜 직선인지"를 알 수 있게 한다.
//     ② 정상 간격과 **진짜 신호 공백**(단말 꺼짐·터널·폴러 누락)을 시각적으로 가른다.
//        공백 구간은 이은 선 자체가 추정이므로 실선으로 그리면 안 된다.
//
// 🔴 여기서 좌표를 보정하거나 스무딩하지 않는다 — 운행 이력은 감사 자료다.
//    없는 구간은 없는 대로 두고 "비었다"고 말하는 것이 맞다.

/** 공백 판정 임계(초). 단말 정상 간격이 60~120초라 3분을 넘으면 수신이 끊긴 것으로 본다. */
export const TRACK_GAP_SEC = 180;

/** Firestore Timestamp / number / ISO 문자열 / null 을 ms 로. 못 구하면 null. */
export function tsToMs(ts) {
  if (ts === null || ts === undefined) return null;
  if (typeof ts === "number") return Number.isFinite(ts) ? ts : null;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.toDate === "function") {
    const ms = ts.toDate().getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  const ms = new Date(ts).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** 두 좌표 간 거리(m) — Haversine. */
export function metersBetween(a, b) {
  if (!a || !b) return 0;
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * GPS 포인트 배열 → { runs, gaps, stats }.
 *   runs  : 연속 수신 구간(실선으로 그릴 폴리라인들). 1점짜리 구간은 선이 안 되므로 제외.
 *   gaps  : 공백 구간 [{ from, to, sec, meters }] — 점선으로 그린다.
 *   stats : { count, duplicates, medianGapSec, maxGapSec, medianMoveGapSec, medianStepM, maxStepM, spanSec }
 *
 * 🔴 **동일 좌표 재기록을 통계에서 분리한다.** prod 실측(2026-08-18 [한남1] 등교 45점):
 *    점간 거리가 `0,0,0,332,0,544,0,385,…` 로 정확히 한 칸 걸러 0 이었다 — 서버 폴러가
 *    1분마다 도는데 단말 원천(busin)은 2분마다 좌표를 주므로 **같은 좌표를 두 번 기록**한다.
 *    그래서 "기록 간격"은 60초지만 **좌표가 실제로 바뀌는 간격은 120초**이고, 직선의 길이를
 *    정하는 건 후자다. 전부 섞어서 중앙값을 내면 점간 거리 중앙이 **0m** 로 나와(실제 463m)
 *    화면이 거짓말을 한다.
 *
 * ⚠ `Number("")`·`Number(null)` 이 0 이라 빈 좌표를 통과시키면 (0,0) 대서양 점이 생긴다
 *   → 유한값만 통과(routeProgress.toLatLngPath 와 같은 규칙).
 */
export function trackSegments(points, gapSec = TRACK_GAP_SEC) {
  const pts = [];
  for (const p of Array.isArray(points) ? points : []) {
    if (!p) continue;
    const lat = p.lat === null || p.lat === undefined || p.lat === "" ? NaN : Number(p.lat);
    const lng = p.lng === null || p.lng === undefined || p.lng === "" ? NaN : Number(p.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    pts.push({ lat, lng, ms: tsToMs(p.ts) });
  }

  const empty = {
    runs: [], gaps: [],
    stats: { count: pts.length, duplicates: 0, medianGapSec: null, maxGapSec: null, medianMoveGapSec: null, medianStepM: null, maxStepM: null, spanSec: null },
  };
  if (pts.length < 2) return empty;

  const gapMs = Math.max(1, gapSec) * 1000;
  const runs = [];
  const gaps = [];
  const gapSecs = [], steps = [], moveGapSecs = [];
  let duplicates = 0;
  let lastMovedMs = pts[0].ms;
  let cur = [pts[0]];

  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dMs = a.ms != null && b.ms != null ? b.ms - a.ms : null;
    const meters = metersBetween(a, b);
    if (dMs != null) gapSecs.push(dMs / 1000);
    if (meters === 0) {
      duplicates++;
    } else {
      steps.push(meters); // 이동한 구간만 — 직선의 길이를 정하는 건 이쪽이다
      if (b.ms != null && lastMovedMs != null) moveGapSecs.push((b.ms - lastMovedMs) / 1000);
      if (b.ms != null) lastMovedMs = b.ms;
    }
    // 시각을 못 구하는 포인트가 섞이면 공백 판정을 하지 않는다(모르는 것을 공백이라 하지 않음).
    if (dMs != null && dMs > gapMs) {
      runs.push(cur);
      gaps.push({ from: { lat: a.lat, lng: a.lng }, to: { lat: b.lat, lng: b.lng }, sec: Math.round(dMs / 1000), meters: Math.round(meters) });
      cur = [b];
    } else {
      cur.push(b);
    }
  }
  runs.push(cur);

  const first = pts.find(p => p.ms != null);
  const last = [...pts].reverse().find(p => p.ms != null);
  return {
    runs: runs.filter(r => r.length >= 2).map(r => r.map(p => ({ lat: p.lat, lng: p.lng }))),
    gaps,
    stats: {
      count: pts.length,
      duplicates,
      medianGapSec: gapSecs.length ? Math.round(median(gapSecs)) : null,
      maxGapSec: gapSecs.length ? Math.round(Math.max(...gapSecs)) : null,
      medianMoveGapSec: moveGapSecs.length ? Math.round(median(moveGapSecs)) : null,
      medianStepM: steps.length ? Math.round(median(steps)) : null,
      maxStepM: steps.length ? Math.round(Math.max(...steps)) : null,
      spanSec: first && last && first !== last ? Math.round((last.ms - first.ms) / 1000) : null,
    },
  };
}

/** "1분 30초" 대신 관제용 짧은 표기 — 초/분 단위. */
export function formatDuration(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return "–";
  if (sec < 60) return `${Math.round(sec)}초`;
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return s ? `${m}분 ${s}초` : `${m}분`;
}
