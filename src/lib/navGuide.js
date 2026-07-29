// 기사 길안내 계산(순수 · Firebase import 0) — 2026-07-28 way 요청("초보 기사를 위한 길안내").
//
// 배경: 기사앱에는 지도가 아예 없었다(승객·직원·관리자 앱엔 전부 있는데). 초행 노선을 맡은
// 기사가 다음에 어디로 가야 하는지 앱에서 확인할 방법이 없어 종이·기억에 의존했다.
//
// 여기서는 "다음에 가야 할 곳이 어디고, 얼마나 남았고, 어느 쪽인가"만 계산한다.
// 지도 렌더·외부 앱 실행은 호출부(DriverApp)의 몫.
//
// ⚠ 설계 제약(중요)
//  - 웹은 **턴바이턴 음성 안내를 할 수 없다**. 음성이 필요하면 외부 내비 앱으로 넘겨야 하고,
//    그 순간 우리 앱은 백그라운드로 가 위치 전송이 끊긴다(2026-06-26 실측: 앱이 앞에 있어도
//    GPS 가 65분 비었던 사례). 그래서 **앱 안 안내가 기본, 외부 내비는 선택**이고 호출부는
//    폰 GPS 차량에 경고를 띄운다. 단말(device) 차량은 위치가 단말에서 오므로 무관.
//  - 좌표는 number/문자열/GeoPoint/중첩 4형식으로 들어온다 → `stopLatLng` 로 흡수.
//    `Number("")` 도 `Number(null)` 도 0 이라 그대로 통과시키면 (0,0) 대서양 점이 된다.
//
// 격리 테스트: node scripts/test_nav_guide.cjs

import { haversine, buildCumulativeLengths, projectToPolyline, pathUpTo, pathFrom } from "./routeProgress";

/** 정류장 좌표 4형식 흡수. 못 얻으면 null(0,0 은 좌표 없음으로 본다). */
export function stopLatLng(s) {
  if (!s) return null;
  const pick = (a, b, c) => (a !== undefined && a !== null && a !== "" ? a : b !== undefined && b !== null && b !== "" ? b : c);
  const lat = Number(pick(s.lat, s.latitude, s.location?.latitude));
  const lng = Number(pick(s.lng, s.longitude, s.location?.longitude));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

/** 미터 → 사람이 읽는 거리. 1km 미만은 10m 단위(과도한 정밀도는 신뢰만 깎는다). */
export function formatDistance(m) {
  if (!Number.isFinite(m) || m < 0) return "–";
  if (m < 1000) return `${Math.max(10, Math.round(m / 10) * 10)}m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)}km`;
}

const COMPASS = ["북", "북동", "동", "남동", "남", "남서", "서", "북서"];

/** 두 지점 사이 방위(도) — 정북 0, 시계방향. */
export function bearing(from, to) {
  if (!from || !to) return null;
  const rad = Math.PI / 180;
  const y = Math.sin((to.lng - from.lng) * rad) * Math.cos(to.lat * rad);
  const x = Math.cos(from.lat * rad) * Math.sin(to.lat * rad) -
    Math.sin(from.lat * rad) * Math.cos(to.lat * rad) * Math.cos((to.lng - from.lng) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

/** 방위(도) → 한글 8방위. */
export function compassLabel(deg) {
  if (!Number.isFinite(deg)) return "";
  return COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

/**
 * 지금 안내해야 할 정류장 = "아직 안 지난 첫 정류장".
 * currentStopIdx 는 마지막으로 도착한 정류장(-1=아직 출발 전)이므로 그 다음.
 * 종점까지 지났으면 null(운행 종료).
 */
export function guideTargetIndex(stops, currentStopIdx = -1) {
  // ⚠ 기본값(`stops = []`)은 undefined 만 막는다 — Firestore 는 null 을 그대로 준다.
  const list = Array.isArray(stops) ? stops : [];
  const next = (Number.isFinite(currentStopIdx) ? currentStopIdx : -1) + 1;
  if (!list.length || next >= list.length) return -1;
  return Math.max(0, next);
}

/**
 * 길안내 한 줄 요약.
 * @param {Object} p
 * @param {Array}  p.stops          order 오름차순 정류장
 * @param {number} p.currentStopIdx 마지막 도착 정류장 인덱스(-1=출발 전)
 * @param {Object} [p.pos]          현재 차량 위치 {lat,lng}
 * @param {Object} [p.estByStopId]  computeStopEstimates 결과(예정 시각 표시용·계산 안 함)
 * @returns {{targetIdx, stop, remainMeters, remainLabel, headingDeg, headingLabel,
 *            plannedAt, isLast, hasPos, finished}}
 */
export function computeGuide({ stops, currentStopIdx = -1, pos = null, estByStopId = null } = {}) {
  const list = Array.isArray(stops) ? stops : [];
  const targetIdx = guideTargetIndex(list, currentStopIdx);
  if (targetIdx < 0) {
    return { targetIdx: -1, stop: null, remainMeters: null, remainLabel: "–", headingDeg: null,
      headingLabel: "", plannedAt: null, isLast: false, hasPos: !!pos, finished: list.length > 0 };
  }
  const stop = list[targetIdx];
  const to = stopLatLng(stop);
  const from = pos && Number.isFinite(pos.lat) && Number.isFinite(pos.lng) ? pos : null;
  const remainMeters = from && to ? haversine(from, to) : null;
  const headingDeg = from && to ? bearing(from, to) : null;
  const est = estByStopId && stop ? estByStopId[stop.id] : null;
  return {
    targetIdx,
    stop,
    remainMeters,
    remainLabel: remainMeters == null ? "–" : formatDistance(remainMeters),
    headingDeg,
    headingLabel: compassLabel(headingDeg),
    plannedAt: est?.plannedAt || stop?.plannedAt || null,
    isLast: targetIdx === list.length - 1,
    hasPos: !!from,
    finished: false,
  };
}

/**
 * 노선 경로를 **지나온 / 지금 가야 할 / 그 이후** 3구간으로 나눈다.
 *
 * 길안내의 핵심은 "선이 그려져 있다"가 아니라 **"지금 어디로 가라"** 다.
 * 노선 전체를 한 줄로 그리면 기사는 자기가 그 선 위 어디에 있고 어디까지 가야 하는지
 * 읽어내야 한다 → 가야 할 구간만 굵게 뽑아 눈이 바로 가게 한다.
 *
 * @returns {{passed:Array, ahead:Array, later:Array}}
 *   passed 지나온 구간 · ahead **지금부터 다음 정류장까지(강조 대상)** · later 그 이후
 */
export function splitGuidePath({ path, pos, targetLL } = {}) {
  const empty = { passed: [], ahead: [], later: [] };
  if (!Array.isArray(path) || path.length < 2) return empty;
  const cum = buildCumulativeLengths(path);
  const total = cum[cum.length - 1];
  if (!(total > 0)) return empty;

  const myProj = pos ? projectToPolyline(pos, path, cum) : null;
  const tgtProj = targetLL ? projectToPolyline(targetLL, path, cum) : null;
  const myM = myProj ? myProj.progress : 0;
  const tgtM = tgtProj ? tgtProj.progress : total;

  const passed = myM > 0 ? pathUpTo(path, cum, myM) : [];
  let ahead = [];
  if (tgtM > myM) {
    // 내 위치 이후 경로를 뽑고, 거기서 다음 정류장까지만 자른다.
    const rest = pathFrom(path, cum, myM);
    ahead = pathUpTo(rest, null, tgtM - myM);
  } else if (pos && targetLL) {
    // 이미 지나쳤는데 도착 감지가 안 된 경우 — 경로 대신 직선으로라도 방향을 준다.
    ahead = [pos, targetLL];
  }
  const later = tgtM < total ? pathFrom(path, cum, tgtM) : [];
  return { passed, ahead, later };
}

/** 두 지점이 한 화면에 들어오는 카카오맵 확대 단계(작을수록 확대). */
export function fitLevel(meters) {
  if (!Number.isFinite(meters) || meters <= 0) return 4;
  if (meters < 300) return 3;
  if (meters < 700) return 4;
  if (meters < 1500) return 5;
  if (meters < 3500) return 6;
  if (meters < 8000) return 7;
  if (meters < 20000) return 8;
  return 9;
}

/**
 * 지도 시점 — 주어진 지점들이 **한 화면에 다 들어오게** 중심·확대를 잡는다.
 *
 * `path` 를 함께 주면 노선 전체가 보이도록 잡는다(운행 시작 전엔 기사가 "이 노선이 어디로
 * 도는지"를 먼저 알아야 한다 — 다음 정류장만 기준으로 확대하면 나머지 노선이 화면 밖으로
 * 나가 정작 길안내가 안 된다. 2026-07-28 실화면 확인).
 *
 * ⚠ 이 값을 매 렌더 그대로 <Map center> 에 넣으면 GPS 갱신마다 지도가 튕겨
 *   기사가 손으로 움직인 화면과 싸운다 → 호출부는 **안내 대상이 바뀔 때만** 적용한다.
 */
export function guideView({ pos, targetLL, path } = {}) {
  const pts = [];
  if (pos && Number.isFinite(pos.lat) && Number.isFinite(pos.lng)) pts.push(pos);
  if (targetLL) pts.push(targetLL);
  if (Array.isArray(path)) {
    for (const p of path) {
      if (p && Number.isFinite(p.lat) && Number.isFinite(p.lng)) pts.push(p);
    }
  }
  if (!pts.length) return null;
  if (pts.length === 1) return { center: pts[0], level: 4 };

  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const p of pts) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  return {
    center: { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 },
    level: fitLevel(haversine({ lat: minLat, lng: minLng }, { lat: maxLat, lng: maxLng })),
  };
}

/**
 * 지금 안내할 회전 지점 — 내 위치보다 **앞에 있는** 안내 중 가장 가까운 것.
 *
 * 카카오모빌리티 길찾기가 준 `guides`(회전 안내)를 경로 진행거리 기준으로 고른다.
 * 직선거리로 고르면 자기교차·왕복 노선에서 이미 지나친 안내가 다시 잡힌다.
 *
 * @returns {{guide, aheadMeters, label}|null}
 */
export function nextNaviGuide({ guides, path, pos } = {}) {
  if (!Array.isArray(guides) || guides.length === 0) return null;
  if (!Array.isArray(path) || path.length < 2 || !pos) return null;
  const cum = buildCumulativeLengths(path);
  const my = projectToPolyline(pos, path, cum);
  if (!my) return null;
  let best = null;
  for (const g of guides) {
    if (!g || !Number.isFinite(g.lat) || !Number.isFinite(g.lng)) continue;
    const p = projectToPolyline({ lat: g.lat, lng: g.lng }, path, cum);
    if (!p) continue;
    const ahead = p.progress - my.progress;
    if (ahead <= 0) continue;                       // 이미 지난 안내
    if (!best || ahead < best.aheadMeters) best = { guide: g, aheadMeters: ahead };
  }
  if (!best) return null;
  const text = (best.guide.guidance || best.guide.name || "").trim();
  return {
    ...best,
    // "300m 앞 우회전" — 거리를 앞에 둬야 운전 중 눈에 먼저 들어온다.
    label: text ? `${formatDistance(best.aheadMeters)} 앞 ${text}` : formatDistance(best.aheadMeters),
  };
}

/**
 * 카카오맵 길찾기 링크 — SDK·앱키 불필요, 아이폰·안드로이드 모두 동작.
 * 앱이 깔려 있으면 앱으로, 아니면 웹으로 열린다.
 * ⚠ 좌표 없는 정류장은 null → 호출부가 버튼을 숨긴다(빈 링크로 카카오맵을 열면 엉뚱한 곳).
 */
export function kakaoMapDirectionsUrl(stop) {
  const ll = stopLatLng(stop);
  if (!ll) return null;
  const name = String(stop?.name || "정류장").replace(/[,\n\r]/g, " ").trim() || "정류장";
  return `https://map.kakao.com/link/to/${encodeURIComponent(name)},${ll.lat},${ll.lng}`;
}
