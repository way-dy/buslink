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

/** 경로에서 이보다 멀면 "노선 위에 있지 않다"고 본다(m).
 *  왕복 도로폭·GPS 오차·정류장 진입로를 감안한 값. 너무 크면 옆 도로를 달리면서도
 *  노선 위로 오판하고, 너무 작으면 정상 운행 중에 자꾸 벗어났다고 나온다. */
export const OFF_ROUTE_M = 300;

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
export function splitGuidePath({ path, pos, targetLL, prevLL, maxOffRouteM = OFF_ROUTE_M } = {}) {
  const empty = { passed: [], ahead: [], later: [], onRoute: false };
  if (!Array.isArray(path) || path.length < 2) return empty;
  const cum = buildCumulativeLengths(path);
  const total = cum[cum.length - 1];
  if (!(total > 0)) return empty;

  // ⚠ projectToPolyline 은 아무리 멀어도 최근접점으로 투영한다 → 경로에서 한참 떨어진
  //   곳(차고지·집·사무실)에서 보면 노선 중간 엉뚱한 지점이 "내 위치"가 되어 그 뒤 안내가
  //   전부 어긋난다(2026-07-29 way 현장 확인: 16km 밖에서 "1.3km 앞 우회전"이 떴다).
  //   그래서 수직거리를 검사해 **경로 위에 있을 때만** 내 위치를 기준점으로 쓴다.
  const myProj = pos ? projectToPolyline(pos, path, cum) : null;
  const onRoute = !!(myProj && myProj.perpDist <= maxOffRouteM);
  const tgtProj = targetLL ? projectToPolyline(targetLL, path, cum) : null;
  const tgtM = tgtProj ? tgtProj.progress : total;
  // 경로 밖이면 "직전 정류장 → 다음 정류장"이 지금 가야 할 구간이다(직전이 없으면 노선 시작).
  const prevProj = prevLL ? projectToPolyline(prevLL, path, cum) : null;
  const myM = onRoute ? myProj.progress : (prevProj ? prevProj.progress : 0);

  const passed = myM > 0 ? pathUpTo(path, cum, myM) : [];
  let ahead = [];
  if (tgtM > myM) {
    // 내 위치 이후 경로를 뽑고, 거기서 다음 정류장까지만 자른다.
    const rest = pathFrom(path, cum, myM);
    ahead = pathUpTo(rest, null, tgtM - myM);
  } else if (onRoute && pos && targetLL) {
    // 이미 지나쳤는데 도착 감지가 안 된 경우 — 경로 대신 직선으로라도 방향을 준다.
    ahead = [pos, targetLL];
  }
  const later = tgtM < total ? pathFrom(path, cum, tgtM) : [];
  return { passed, ahead, later, onRoute };
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
 * 진행 방향(도) — 차량 마커를 어느 쪽으로 돌릴지.
 *
 * ⚠ 카카오 지도 웹 API 는 **지도 회전을 지원하지 않는다**(setBearing/rotate 없음·북쪽 고정).
 *   그래서 "진행 방향이 위"로 만들 수 없고, 대신 **마커가 향한 방향**으로 알려준다.
 *
 * `coords.heading` 은 정지·저속에서 null 이거나 튄다 → 최근 이동 벡터를 우선 쓰고
 * 그것도 없으면 heading, 둘 다 없으면 직전 값을 유지한다(홱홱 돌면 오히려 못 읽는다).
 *
 * @param {Object} p
 * @param {Object} [p.prev]    직전 위치 {lat,lng}
 * @param {Object} [p.cur]     현재 위치 {lat,lng}
 * @param {number} [p.gpsHeading]  navigator 가 준 heading(도)
 * @param {number} [p.fallback]    직전에 쓰던 방향(유지용)
 * @param {number} [p.minMoveM]    이만큼은 움직여야 이동 벡터를 신뢰
 * @returns {number|null}
 */
export function travelHeading({ prev, cur, gpsHeading, fallback = null, minMoveM = 8 } = {}) {
  if (prev && cur && haversine(prev, cur) >= minMoveM) {
    const b = bearing(prev, cur);
    if (Number.isFinite(b)) return b;
  }
  if (Number.isFinite(gpsHeading) && gpsHeading >= 0) return gpsHeading;
  return Number.isFinite(fallback) ? fallback : null;
}

/**
 * 카카오맵 확대 단계 → 화면 1픽셀이 몇 m인가.
 * 실측 기준: level 4 에서 축척 막대가 "100m ≈ 50px" = 2 m/px 이고 단계마다 2배씩.
 * (지도 시점을 "내 앞쪽"으로 밀 때 얼마나 밀지 계산하는 데 쓴다.)
 */
export function metersPerPixel(level) {
  const lv = Number.isFinite(level) ? level : 4;
  return Math.pow(2, lv - 3);
}

/** 한 점에서 방위 `headingDeg` 로 `meters` 만큼 이동한 좌표. */
export function offsetLatLng(pos, headingDeg, meters) {
  if (!pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) return null;
  if (!Number.isFinite(headingDeg) || !Number.isFinite(meters) || meters === 0) return { ...pos };
  const rad = Math.PI / 180;
  const dLat = (meters * Math.cos(headingDeg * rad)) / 111320;
  const cosLat = Math.cos(pos.lat * rad);
  const dLng = Math.abs(cosLat) < 1e-9 ? 0 : (meters * Math.sin(headingDeg * rad)) / (111320 * cosLat);
  return { lat: pos.lat + dLat, lng: pos.lng + dLng };
}

/**
 * 길안내 지도 중심 — 내 차를 화면 **아래쪽**에 두고 갈 길을 넓게 보여준다.
 *
 * 내 위치를 화면 정중앙에 두면 앞으로 갈 길이 화면의 절반밖에 안 보인다(뒤쪽 절반은
 * 이미 지나온 길이라 볼 필요가 없다) — 그래서 실제 내비는 차를 아래쪽 1/4 지점에 둔다.
 * 진행 방향을 모르면(정차 등) 밀지 않는다 — 엉뚱한 쪽으로 밀면 내 차가 화면 밖으로 나간다.
 *
 * @param {Object} p
 * @param {Object} p.pos        내 위치
 * @param {number} [p.heading]  진행 방위(도)
 * @param {number} [p.level]    카카오 확대 단계
 * @param {number} [p.heightPx] 지도 높이(px)
 * @param {number} [p.aheadRatio] 화면 높이의 몇 배만큼 앞으로 밀지(0=정중앙)
 */
export function navCenter({ pos, heading, level = 4, heightPx = 400, aheadRatio = 0.25 } = {}) {
  if (!pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) return null;
  if (!Number.isFinite(heading)) return { ...pos };
  const h = Number.isFinite(heightPx) && heightPx > 0 ? heightPx : 400;
  const meters = metersPerPixel(level) * h * aheadRatio;
  return offsetLatLng(pos, heading, meters) || { ...pos };
}

/**
 * 지금 안내할 회전 지점 — 내 위치보다 **앞에 있는** 안내 중 가장 가까운 것.
 *
 * 카카오모빌리티 길찾기가 준 `guides`(회전 안내)를 경로 진행거리 기준으로 고른다.
 * 직선거리로 고르면 자기교차·왕복 노선에서 이미 지나친 안내가 다시 잡힌다.
 *
 * @returns {{guide, aheadMeters, label}|null}
 */
export function nextNaviGuide({ guides, path, pos, maxOffRouteM = OFF_ROUTE_M } = {}) {
  if (!Array.isArray(guides) || guides.length === 0) return null;
  if (!Array.isArray(path) || path.length < 2 || !pos) return null;
  const cum = buildCumulativeLengths(path);
  const my = projectToPolyline(pos, path, cum);
  if (!my) return null;
  // 🔴 경로 밖이면 아예 안내하지 않는다 — 엉뚱한 회전을 알려주는 것보다 없는 게 낫다
  //   (16km 밖에서 "1.3km 앞 우회전"이 뜨던 결함, 2026-07-29).
  if (my.perpDist > maxOffRouteM) return null;
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

/**
 * 회전 안내 화살표 글리프 — 2026-08-05 way 현장 지적 "지시하고 방향하고 안맞음".
 *
 * 🔴 예전엔 배너에 `↱`(우회전) 를 **하드코딩**해서, 좌회전 안내에도 우회전 화살표가
 *    떴다. 운전 중에는 글자보다 화살표가 먼저 읽히므로 이건 그냥 틀린 안내다.
 *
 * 🔴 판정은 **화면에 실제로 찍히는 문구(guidance)를 1순위**로 본다 — 화살표와 글자가
 *    같은 문자열에서 나오면 둘이 어긋나는 일 자체가 불가능하다. `type` 은 문구로
 *    못 가릴 때만 쓰는 보조 신호(카카오 type 표에 의존하면 표가 바뀌는 순간 조용히 틀린다).
 * 🔴 **모르면 화살표를 그리지 않는다**(null 반환) — 없는 것보다 틀린 방향이 훨씬 나쁘다.
 *    이 화면의 기존 원칙(경로 밖이면 회전 안내를 아예 안 준다)과 같은 판단.
 */
/* 2026-08-06 실측한 카카오 안내 type 표(과천대로·군포 노선 실호출):
 *   1 좌회전 · 2 우회전 · 3 유턴 · 5 왼쪽 방향 · 6 오른쪽 방향 · 9 고속도로 출구
 *   12 고속도로 입구 · 14 고가도로 진입 · 15 지하차도 진입 · 16 고가도로 옆길
 *   17 지하차도 옆길 · 29 12시 방향 · 44 도시고속 출구 · 47 도시고속 입구
 *   49 고속도로 진입 · 82 왼쪽 직진 · 83 오른쪽 직진 · 84 톨게이트 진입
 *   100 출발지 · 101 목적지 · 1000 경유지
 * 🔴 그래도 판정은 문구 우선이다. 예전 코드에 `type === 4` 를 유턴으로 둔 자리가 있었는데
 *    **카카오 유턴은 3 이다** — 숫자표를 짐작으로 박으면 이렇게 조용히 틀린다.
 *    (문구가 항상 "유턴"을 담고 있어 화면에는 안 드러났다.) */
export function turnGlyph(guidance) {
  const t = String(guidance || "").trim();
  if (/유턴|U턴/i.test(t)) return "⤶";
  if (/지하차도/.test(t)) return "⤓";           // 진입·옆길 모두 — 좌우는 카카오가 안 준다
  if (/고가도로/.test(t)) return "⤒";
  if (/톨게이트|하이패스/.test(t)) return "⌸";
  if (/좌회전/.test(t)) return "↰";
  if (/우회전/.test(t)) return "↱";
  if (/왼쪽|좌측/.test(t)) return "↖";
  if (/오른쪽|우측/.test(t)) return "↗";
  if (/직진|(^|\s)12시\s*방향/.test(t)) return "↑";
  if (/목적지|도착/.test(t)) return "⚑";
  return null;                                  // 방향이 안 정해지는 안내 — 틀린 화살표보다 없는 게 낫다
}

/** 교통 상태 코드 → 짧은 라벨·색. 카카오 `traffic_state`(도로 단위).
 *  0 정보없음 · 1 원활 · 2 서행 · 3 지체 · 4 정체 (실측 응답의 값 범위). */
export function trafficLabel(state) {
  switch (Number(state)) {
    case 1: return { text: "원활", tone: "positive" };
    case 2: return { text: "서행", tone: "cautionary" };
    case 3: return { text: "지체", tone: "cautionary" };
    case 4: return { text: "정체", tone: "destructive" };
    default: return null;                       // 0·미상은 표시하지 않는다(모르는 걸 지어내지 않는다)
  }
}

/** m/s → km/h 정수. 음수·비수치·미측정(null)은 null. */
export function speedKmh(metersPerSec) {
  // 🔴 `Number(null)`·`Number("")` 은 **0** 이다 — 그대로 통과시키면 측정이 안 된 상태를
  //    화면에 "0 km/h" 로 지어내 보여준다(정차와 구분이 안 된다). 먼저 걸러낸다.
  if (metersPerSec === null || metersPerSec === undefined || metersPerSec === "") return null;
  const v = Number(metersPerSec);
  if (!Number.isFinite(v) || v < 0) return null;
  return Math.round(v * 3.6);
}

/**
 * 회전한 지도 판 위에서의 드래그 보정 — 2026-08-05 way 현장 지적
 * "지도 움직일 때 손가락 방향대로 안 움직임".
 *
 * 지도 판을 CSS 로 `rotate(rotDeg)` 해 놓으면, 카카오는 자기 좌표계(=판 좌표계)로
 * 드래그를 해석하는데 손가락은 **화면 좌표계**로 움직인다 → 회전각만큼 어긋난다.
 * 화면 델타를 판 좌표계로 되돌린 뒤 `panBy` 에 넘겨야 손가락을 따라온다.
 *
 * @param dx,dy   화면 좌표계 이동량(px, 오른쪽·아래가 +)
 * @param rotDeg  판에 걸린 회전각(deg). 0이면 그대로 통과.
 * @returns {{dx,dy}} `map.panBy(-dx, -dy)` 에 넣을 판 좌표계 이동량
 *          (panBy 는 중심을 옮기므로 내용이 손가락을 따라오려면 부호를 뒤집는다)
 */
export function rotateDragDelta({ dx, dy, rotDeg = 0 } = {}) {
  const x = Number(dx), y = Number(dy);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { dx: 0, dy: 0 };
  const r = Number(rotDeg);
  if (!Number.isFinite(r) || r % 360 === 0) return { dx: x, dy: y };
  const a = (-r * Math.PI) / 180;               // 판 → 화면이 +r 이므로 되돌리려면 −r
  const cos = Math.cos(a), sin = Math.sin(a);
  return { dx: x * cos - y * sin, dy: x * sin + y * cos };
}
