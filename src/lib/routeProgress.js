// src/lib/routeProgress.js — 경로(폴리라인) 진행거리·투영 유틸 (순수 함수)
// ---------------------------------------------------------------------------
// EmployeeApp(/p)·PassengerApp(/bus)가 공통 import. 노선 사전경로(routePath)에
// 버스/내 정류장 좌표를 투영해 진행거리 기반 도착·지나감 판정과 경로 진행 시각화를 제공.
// react-kakao-maps-sdk·Firebase import 없음(순수 계산).
// ---------------------------------------------------------------------------

const R = 6371000; // 지구 반경(m)

/**
 * 좌표 배열을 지도에 그릴 수 있는 `[{lat,lng}]` 로 정규화(2026-07-27).
 *
 * Firestore 좌표는 number 외에 문자열("37.5")·GeoPoint(`{latitude,longitude}`)·
 * 중첩(`{location:GeoPoint}`) 로 들어올 수 있다(엑셀 import·콘솔 수기·SDK 차이).
 * `typeof === "number"` 로 엄격 필터하면 그런 노선은 **전 좌표가 탈락해 경로가 통째로
 * 사라지고 정류장 직선 폴백처럼 보인다**(issues.md stops 좌표 3분기 항목과 같은 계열).
 * 유효 좌표가 2개 미만이면 빈 배열 → 호출부가 폴백을 고르게 한다.
 */
export function toLatLngPath(raw) {
  if (!Array.isArray(raw)) return [];
  // ⚠ `Number("")` 도 `Number(null)` 도 0 이다 — 그대로 통과시키면 빈 좌표가
  //   (0,0) 대서양 한복판 점이 되어 경로가 아프리카까지 뻗는다. 빈 값은 NaN 으로.
  const num = (v) => {
    if (v === null || v === undefined) return NaN;
    if (typeof v === "string" && v.trim() === "") return NaN;
    return Number(v);
  };
  const out = [];
  for (const p of raw) {
    if (!p) continue;
    const lat = num(p.lat !== undefined ? p.lat : (p.latitude !== undefined ? p.latitude : p.location?.latitude));
    const lng = num(p.lng !== undefined ? p.lng : (p.longitude !== undefined ? p.longitude : p.location?.longitude));
    if (Number.isFinite(lat) && Number.isFinite(lng)) out.push({ lat, lng });
  }
  return out.length >= 2 ? out : [];
}

// 두 좌표 간 거리(m) — Haversine
export function haversine(a, b) {
  if (!a || !b) return Infinity;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

// 폴리라인 각 정점까지의 누적 거리 배열. cumLen[i] = path[0]→path[i] 누적(m).
// 마지막 원소 = 전체 경로 길이.
export function buildCumulativeLengths(path) {
  const cum = [0];
  for (let i = 1; i < path.length; i++) {
    cum[i] = cum[i - 1] + haversine(path[i - 1], path[i]);
  }
  return cum;
}

export function polylineLength(path) {
  if (!path || path.length < 2) return 0;
  const cum = buildCumulativeLengths(path);
  return cum[cum.length - 1];
}

// 위도·경도를 로컬 평면(m)으로 근사 — 짧은 세그먼트 투영용(한국 위도에서 충분히 정확).
function toLocalXY(p, origin) {
  const latRad = origin.lat * Math.PI / 180;
  return {
    x: (p.lng - origin.lng) * Math.PI / 180 * R * Math.cos(latRad),
    y: (p.lat - origin.lat) * Math.PI / 180 * R,
  };
}

// 한 점을 폴리라인에 투영.
// 반환: {
//   progress: 시작점(path[0])부터 투영점까지의 경로 누적거리(m),
//   perpDist: 점→경로 최단(수직) 거리(m) — 경로 이탈 판정용,
//   segIndex: 투영된 세그먼트 인덱스(path[segIndex]→path[segIndex+1]),
//   t       : 그 세그먼트 내 비율(0~1)
// }
// 가장 가까운 세그먼트를 perpDist 최소 기준으로 선택.
export function projectToPolyline(point, path, cumLen) {
  if (!point || !path || path.length === 0) return null;
  if (path.length === 1) {
    return { progress: 0, perpDist: haversine(point, path[0]), segIndex: 0, t: 0 };
  }
  const cum = cumLen || buildCumulativeLengths(path);
  let best = null;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1];
    const A = toLocalXY(a, a);
    const B = toLocalXY(b, a);
    const P = toLocalXY(point, a);
    const dx = B.x - A.x, dy = B.y - A.y;
    const segLen2 = dx * dx + dy * dy;
    let t = 0;
    if (segLen2 > 0) {
      t = ((P.x - A.x) * dx + (P.y - A.y) * dy) / segLen2;
      t = Math.max(0, Math.min(1, t));
    }
    const projX = A.x + t * dx, projY = A.y + t * dy;
    const perpDist = Math.hypot(P.x - projX, P.y - projY);
    const segLen = cum[i + 1] - cum[i];
    const progress = cum[i] + segLen * t;
    if (!best || perpDist < best.perpDist) {
      best = { progress, perpDist, segIndex: i, t };
    }
  }
  return best;
}

// 진행거리(progressM)까지의 경로를 slice해 반환(지나온 경로 폴리라인용).
// 진행점이 세그먼트 중간이면 그 점을 보간해 마지막 정점으로 추가.
export function pathUpTo(path, cumLen, progressM) {
  if (!path || path.length < 2 || progressM <= 0) return [];
  const cum = cumLen || buildCumulativeLengths(path);
  const total = cum[cum.length - 1];
  if (progressM >= total) return path.slice();
  const out = [];
  for (let i = 0; i < path.length; i++) {
    if (cum[i] <= progressM) {
      out.push(path[i]);
    } else {
      // path[i-1] → path[i] 사이에서 progressM 지점 보간
      const segLen = cum[i] - cum[i - 1];
      const t = segLen > 0 ? (progressM - cum[i - 1]) / segLen : 0;
      out.push({
        lat: path[i - 1].lat + (path[i].lat - path[i - 1].lat) * t,
        lng: path[i - 1].lng + (path[i].lng - path[i - 1].lng) * t,
      });
      break;
    }
  }
  return out;
}

// 진행거리(progressM) 이후 남은 경로를 반환(남은 경로 폴리라인용).
export function pathFrom(path, cumLen, progressM) {
  if (!path || path.length < 2) return path ? path.slice() : [];
  const cum = cumLen || buildCumulativeLengths(path);
  if (progressM <= 0) return path.slice();
  const total = cum[cum.length - 1];
  if (progressM >= total) return [];
  const out = [];
  for (let i = 0; i < path.length; i++) {
    if (cum[i] < progressM) continue;
    if (out.length === 0 && i > 0) {
      // 진행점(보간) 을 남은 경로 시작점으로
      const segLen = cum[i] - cum[i - 1];
      const t = segLen > 0 ? (progressM - cum[i - 1]) / segLen : 0;
      out.push({
        lat: path[i - 1].lat + (path[i].lat - path[i - 1].lat) * t,
        lng: path[i - 1].lng + (path[i].lng - path[i - 1].lng) * t,
      });
    }
    out.push(path[i]);
  }
  return out;
}

/**
 * 진행거리를 "한 운행 안에서 뒤로 가지 않게" 고른다 — 2026-08-25 채드윅(배시현) 신고.
 *
 * 신고: "운행이 끝나 다 회색으로 바뀌었는데 10분 20분 뒤에 갑자기 어느 부분에서만 파란색으로 뜬다.
 *        기사가 운행 끝나고 저기 밑에 판교 쪽에 가 있으면."
 *
 * 🔴 근인 = **운행이 끝난 버스가 종점을 지나 차고지로 가며 노선 경로를 되짚는다.** 그 좌표는
 *    경로 이탈이 `offRouteM` 안이라 유효 좌표로 먹혀 `progress` 가 **역행**하고,
 *    "지나온 회색 / 남은 파랑" 분할(`pathUpTo`/`pathFrom`)이 되감겨 **회색이던 구간이 다시 파래진다**.
 *    prod 실측 `[A] 방과후하교` 2026-08-24 — 19:03 종점 `54245m` → 19:10 `52483m` → 19:14 `47404m`
 *    (= 6.8km 가 다시 파랑). 잔떨림 수준의 GPS 역행도 같은 식으로 잡힌다.
 * 🔴 **버스는 노선을 되돌아가지 않는다** — 편도 전제이므로 역행은 언제나 표시 오류다.
 * ⚠ 같은 노선을 하루 두 번 도는 순환 운행은 제품이 아직 지원하지 않는다(issues.md) —
 *    그 경우 2회차가 완주 상태로 굳는다. 호출부는 **노선이 바뀌면 `prev` 를 리셋**해야 한다
 *    (안 하면 이전 노선 진행거리를 새 노선이 물려받는다).
 *
 * @param {{progress:number, perpDist:number}|null} proj  projectToPolyline 결과
 * @param {number|null} prev      직전까지 채택된 진행거리(없으면 null)
 * @param {number} offRouteM      경로 이탈 임계(m)
 * @returns {number|null} 채택할 진행거리
 */
export function advanceProgress(proj, prev, offRouteM) {
  if (!proj) return prev == null ? null : prev;
  if (proj.perpDist > offRouteM) return prev == null ? null : prev;   // 이탈 좌표는 버린다
  if (prev != null && proj.progress < prev) return prev;              // 🔴 역행 금지
  return proj.progress;
}
