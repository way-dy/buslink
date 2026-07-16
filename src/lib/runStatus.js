// 운행 종료 판정(표시 전용) — 2026-07-16 개선요청(배시현, kgyvTKo0GF5N1KyySlFO).
// 근인: 기사 운행 종료 시 clearGPS 가 gps/{cid}_{vid} 문서를 삭제해도 오늘 dispatch 의
// stopArrivals 는 남음 → computeStopEstimates 의 inOperation(실측 도착 존재)이 true 유지
// → 직원앱 "내 정류장" 카드가 "이미 지나침"으로 영구 잔존.
//
// 판정(전부 기존 구독 데이터의 파생값 — 신규 Firestore 구독/쿼리 0):
//   runEnded = (오늘 배차 존재) && (마지막 정류장 도착 기록) && (신선한 버스 GPS 없음)
// - 마지막 정류장 = stops 를 order 오름차순 정렬한 배열의 마지막(결번 안전 — raw order 산술 금지).
// - GPS 신선도 = AdminApp isGpsFresh(2026-06-23) 의미 미러: updatedAt null/pending
//   (serverTimestamp 쓰기 직후 미해결) = 방금 = fresh 취급(깜빡임 차단), 60초 이내 = fresh.
// - mobile 차량은 clearGPS 로 gps 문서 삭제 → gpsDocs 빈배열. device(유비칸 단말) 차량은
//   문서가 남으므로 신선도 게이트가 필수. 재운행 시 이전 회차 stopArrivals 잔존 케이스도
//   fresh GPS 면 ended 아님으로 자연 방어.
//
// 순수 함수(Firebase import 0) — 격리 node 테스트 대상.

export const RUN_GPS_FRESH_MS = 60000; // AdminApp GPS_FRESH_MS 와 동일 의미(60초)

// gps 문서 updatedAt(serverTimestamp) → 경과 ms. null/pending/파싱불가 = 0(방금) = fresh.
export function gpsAgeMs(updatedAt, now = Date.now()) {
  if (!updatedAt) return 0;
  if (typeof updatedAt.toMillis === "function") return now - updatedAt.toMillis();
  const d = typeof updatedAt.toDate === "function" ? updatedAt.toDate() : new Date(updatedAt);
  const ms = d.getTime();
  return isNaN(ms) ? 0 : now - ms;
}

/**
 * 운행 종료 여부 판정.
 * @param {Object} p
 * @param {boolean} p.hasTodayDispatch  오늘 이 노선 배차 존재 여부
 * @param {Object}  p.stopArrivals      { stopId: 도착ms } (HomeTab 병합본. null 허용)
 * @param {Array}   p.stops             정류장 배열(각 {id, order}). 빈배열이면 판정 불가=false
 * @param {Array}   p.gpsDocs           이 노선 gps 원본 문서 배열(각 {updatedAt}). 빈배열=GPS 없음
 * @param {number}  [p.now]             현재 시각 ms(테스트 주입용)
 * @param {number}  [p.freshMs]         신선도 임계 ms(기본 60초)
 * @returns {boolean} true = 운행 종료(카드 "운행 종료" 표기)
 */
export function computeRunEnded({ hasTodayDispatch, stopArrivals, stops, gpsDocs, now = Date.now(), freshMs = RUN_GPS_FRESH_MS }) {
  if (!hasTodayDispatch) return false; // 운행 전(오늘 배차 없음) — 현재 동작 보존
  if (!Array.isArray(stops) || stops.length === 0) return false;

  // 마지막 정류장 — order 오름차순 정렬 후 배열 마지막(결번 안전).
  // HomeTab 의 stops 는 이미 orderBy(order asc) 쿼리 결과지만 방어적으로 재정렬.
  const ordered = [...stops].sort((a, b) => {
    const ao = typeof a.order === "number" ? a.order : Number.MAX_SAFE_INTEGER;
    const bo = typeof b.order === "number" ? b.order : Number.MAX_SAFE_INTEGER;
    return ao - bo;
  });
  const lastStop = ordered[ordered.length - 1];
  const arrivals = stopArrivals || {};
  if (!lastStop || arrivals[lastStop.id] == null) return false; // 종점 미기록 = 운행 전/운행 중

  // 신선한 GPS 가 한 대라도 있으면 운행 중(재운행 포함) → ended 아님
  const docs = Array.isArray(gpsDocs) ? gpsDocs : [];
  if (docs.some(g => g && gpsAgeMs(g.updatedAt, now) < freshMs)) return false;

  return true;
}
