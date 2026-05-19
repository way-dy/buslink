// src/lib/routeProgress.js — 경로(폴리라인) 진행거리·투영 유틸 (순수 함수)
// ---------------------------------------------------------------------------
// EmployeeApp(/p)·PassengerApp(/bus)가 공통 import. 노선 사전경로(routePath)에
// 버스/내 정류장 좌표를 투영해 진행거리 기반 도착·지나감 판정과 경로 진행 시각화를 제공.
// react-kakao-maps-sdk·Firebase import 없음(순수 계산).
// ---------------------------------------------------------------------------

const R = 6371000; // 지구 반경(m)

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
