// src/lib/stopSchedule.js — 정류장 계획시각·실시간 도착예정 산출 (순수 함수)
// ---------------------------------------------------------------------------
// EmployeeApp(/p) · PassengerApp(/bus) · DriverApp(/) 공통 import.
//   - planTimeForStop: 노선 출발시각(departTime "HH:MM") + 정류장 offsetMin(분)
//     → 정류장 계획 진입시각("HH:MM" 또는 null).
//   - computeStopEstimates: 정류장별 status·계획시각·예상시각·지연(초) 산출.
//     정류장을 order 순서대로 순회하며 estMs를 "단조증가"로 강제(2026-05-22).
//
//   2026-05-28 plan-uvert(GPS 0%) 변경:
//     segTravelMs(a,b)를 "계획 offsetMin 델타 우선"으로 전환. 둘 다 offsetMin
//     있으면 (offsetB - offsetA)*60*1000 — DWELL 가산 X(offsetMin 자체가 정차/
//     감속/가속 포함된 진입시각 차이). chain 전파 = actualLast + Σ(plan 델타) =
//     plannedMs[i] + (actualLast - plannedLast). 즉 "각 정류장 실 도착시간 기준
//     으로 다음 정류장까지 미리 설정한 offsetMin만큼 더해 도착시간 정밀 예측"이라는
//     사용자 의도와 수학적 등가. 한쪽 offsetMin 누락 시 geometric(routePath/직선
//     ÷ 유효속도 + DWELL_SEC) 폴백.
//     `next` 정류장의 GPS 가중치 완전 제거(0%) — chain 우선·없으면 plan+delay·
//     없으면 gps 폴백. 이전 0.7:0.3 가중이 터널·GPS 노이즈에서 ETA 튀는 결함을
//     원천 차단. source enum 4종(actual/plan+delay/gps/fallback) 호환 유지.
//
//     estMs[i] >= estMs[i-1]+MIN_STOP_GAP_SEC + estMs[i] >= now+버퍼(과거 금지).
//     → 도착지·이전 정류장 동일값·역전·과거 시각 표시 결함 원천 차단.
//     offsetMin 미설정 정류장은 calcETA 폴백.
//   - formatPassengerEta: 부드러워진 ETA(초)를 버킷 라벨(곧 도착/N분 후/약 N분/
//     HH:MM 예상)로 변환 + 신뢰도 톤(primary/warn/mute).
// react-kakao-maps-sdk · Firebase import 없음(순수 계산).
// ---------------------------------------------------------------------------

import { haversine, projectToPolyline, buildCumulativeLengths } from "./routeProgress";

// ── 단조증가 estimates 상수 ──────────────────────────────────────────────────
// computeStopEstimates는 정류장을 order 순서대로 순회하며 estMs를 "단조증가"로
// 강제한다. 단조증가가 필요한 이유 = 다음 3가지 결함을 원천 차단:
//   ① 동일값: 여러 미통과 정류장의 plan+delay 추정이 모두 과거가 되면 과거 보정
//      clamp가 전부 T_NOW로 끌어올려 도착지·이전 정류장이 같은 시각으로 표시됨.
//   ② 역전: nextIdx보다 그 다음 정류장의 plan+delay가 더 이른 시각이 될 수 있음.
//   ③ 과거 표시: 누적지연이 작으면 plannedMs+delay가 현재시각 이전이 되어
//      "도착예정시간이 현재시간 이전"으로 표시됨.
// 해법 = 각 정류장 estMs[i] >= estMs[i-1] + MIN_STOP_GAP_SEC 보장 +
//        estMs[i] >= T_NOW + MIN_FUTURE_BUFFER_SEC(과거 금지).
// 2026-05-26 보강: MIN_STOP_GAP_SEC을 25→60으로 상향. 이유 = `fmtHHMM`이 초 단위
// 절삭(Date.getMinutes 분 단위)하기 때문에 25초 간격은 같은 "HH:MM"으로 표시되어
// "도착지·이전 정류장 동일 시각" 결함이 반복됨. 60초 보장하면 라운딩 후에도 distinct.
const MIN_STOP_GAP_SEC = 60;       // 정류장 간 최소 시각 간격(초) — HH:MM 라운딩 후에도 distinct
const MIN_FUTURE_BUFFER_SEC = 30;  // 미통과 정류장 estimate 최소 미래 버퍼(초)
const DEFAULT_SPEED_KMH = 30;      // routePath/속도 없을 때 구간이동시간 기본 속도
const MIN_EFFECTIVE_SPEED_KMH = 20; // 정차/저속 노이즈 하한 — 구간이동시간 계산용
// 2026-06-08 GPS 진척률 통과 안전망 — busProgress 가 정류장 progress 를 이 마진(m)
// 이상 지났으면 통과로 간주(도착 감지 onStopReached 미발화 시 실위치 기준 앵커).
const GPS_PASS_MARGIN_M = 40;
// 정류장당 정차/감속/가속 추가 시간(초). 실제 도착→다음 도착 시간은 단순 주행거리
// /속도가 아닌, 정차(승하차)+감속+가속 포함이라 segTravelMs에 가산. 근접 정류장
// (200~500m)의 "지나치게 짧음" 결함을 직접 차단.
const DWELL_SEC = 30;
// 2026-05-29 routePath 진척률 안분 — 다음 정류장(next) 한정.
// busProgress / segmentLength ≥ ARRIVING_PROGRESS_THRESHOLD 면 "거의 도착" → ETA를
// ARRIVING_BUFFER_SEC(45초) 단순 표시로 고정(점프 차단·"곧 도착" 자연 노출).
const ARRIVING_BUFFER_SEC = 45;
const ARRIVING_PROGRESS_THRESHOLD = 0.95;
// 시작 직후 노이즈 구간(actualProgress ≤ 이 값)에선 진척률 채택 안 함.
const PROGRESS_NOISE_FLOOR = 0.05;

// "HH:MM" 문자열을 0~24*60 분으로. 형식 불량(빈값/NaN/범위 초과) 시 null.
function parseHHMM(s) {
  if (typeof s !== "string") return null;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

function fmtHHMM(totalMin) {
  if (totalMin == null || !isFinite(totalMin)) return null;
  // 24시 넘어가면 모듈로(다음날 새벽 출발 노선 대비 — 표시 한정).
  const t = ((totalMin % (24 * 60)) + 24 * 60) % (24 * 60);
  const h = Math.floor(t / 60), mi = Math.round(t % 60);
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

// 노선 출발시각 + 정류장 오프셋(분) → "HH:MM" 계획 진입시각.
// offsetMin 미설정(null/undefined)이거나 departTime 비정상이면 null.
export function planTimeForStop(departTime, offsetMin) {
  const base = parseHHMM(departTime);
  if (base == null) return null;
  if (typeof offsetMin !== "number" || !isFinite(offsetMin)) return null;
  return fmtHHMM(base + offsetMin);
}

// 역변환: "HH:MM" 정류장 진입시각 + 노선 출발시각 → offsetMin(분, ≥0).
// 입력값 비정상이거나 진입시각이 출발시각보다 빠르면 null(통근버스 모델: 정류장은
// 노선 출발 이후만 — 자정 넘김 노선이 필요해지면 별도 처리). 0 허용(첫 정류장).
// AdminApp 정류장 폼이 시각(HH:MM)을 입력받고 저장 시 분으로 변환할 때 사용.
export function offsetMinFromPlanTime(departTime, plannedTime) {
  const base = parseHHMM(departTime);
  const t = parseHHMM(plannedTime);
  if (base == null || t == null) return null;
  const off = t - base;
  if (off < 0) return null;
  return off;
}

// 오늘 "HH:MM" → millis(now 기준 같은 날 가정). 자정 넘어가는 노선은 표시 한정 안전.
function hhmmToTodayMillis(hhmm, now) {
  const base = parseHHMM(hhmm);
  if (base == null) return null;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime() + base * 60 * 1000;
}

// 정류장 estimates 산출. 신호:
//   stops: [{ id, lat, lng, order, offsetMin? }, ...]  (order asc)
//   departTime: "HH:MM"
//   actualArrivals: { [stopId]: millis }   // 오늘 실 도착(없으면 빈객체 OK)
//   vehiclePos: { lat, lng } | null
//   speed: km/h(차량 현재 속도, 5km/h 이하 시 30 보정)
//   routePath: [{lat,lng}] | null  // 사전경로(없으면 stops 직선)
//   now: millis (테스트성 주입 가능, 기본 Date.now())
// 반환: 각 정류장에 대해 {
//   stopId, plannedAt: "HH:MM"|null, estimatedAt: "HH:MM"|null,
//   delaySec: number|null,  // 예상 - 계획(초). +지연/-조기. status='unplanned' 면 null.
//   status: 'arrived' | 'next' | 'upcoming' | 'unplanned',
//   source: 'actual' | 'plan+delay' | 'gps' | 'fallback'
// }
export function computeStopEstimates({
  stops,
  departTime,
  actualArrivals,
  vehiclePos,
  speed,
  routePath,
  now,
}) {
  const T_NOW = now || Date.now();
  const arrivals = actualArrivals || {};
  if (!Array.isArray(stops) || stops.length === 0) return [];

  // 계획시각이 전혀 안 잡히는 케이스(노선 departTime 누락) → 전부 폴백.
  const baseMin = parseHHMM(departTime);
  const hasPlanBase = baseMin != null;

  // 1) 통과 정류장의 누적지연(초) 산출 — 가장 최근에 실 도착 기록된 정류장 기준.
  //    가장 최근 통과 = order 가장 큰 actual 기록(여러 개면 마지막).
  let cumulativeDelaySec = 0;
  let hasDelayRef = false;
  if (hasPlanBase) {
    let lastIdxWithActual = -1;
    stops.forEach((s, i) => {
      if (arrivals[s.id] != null) lastIdxWithActual = i;
    });
    if (lastIdxWithActual >= 0) {
      const s = stops[lastIdxWithActual];
      const plannedMs = (typeof s.offsetMin === "number")
        ? hhmmToTodayMillis(fmtHHMM(baseMin + s.offsetMin), T_NOW)
        : null;
      const actualMs = arrivals[s.id];
      if (plannedMs != null && actualMs != null) {
        cumulativeDelaySec = Math.round((actualMs - plannedMs) / 1000);
        hasDelayRef = true;
      }
    }
  }

  // 2) routePath 활용 가능 여부 + cum 사전 계산(반복 호출 비용 절감).
  const usePath = Array.isArray(routePath) && routePath.length >= 2;
  const cum = usePath ? buildCumulativeLengths(routePath) : null;

  // 차량/속도 정상화 — 5km/h 이하면 30km/h 가정(calcETA 정책 일관).
  const v = vehiclePos && typeof vehiclePos.lat === "number" && typeof vehiclePos.lng === "number"
    ? vehiclePos : null;
  const spdKmh = (typeof speed === "number" && speed > 5) ? speed : 30;

  // 운행 중 여부 — 차량 실시간 위치 또는 오늘 실측 도착이 하나라도 있으면 운행 중.
  // 둘 다 없으면 "운행시간 아닐 때"(접속만 함) → 일정(계획시각)을 그대로 예상시각으로
  // 노출하고, 과거 금지 클램프를 적용하지 않는다(과거 계획시각이 현재시각으로 끌려
  // 올라가 "예상: 현재시간"으로 보이던 결함 차단, 2026-06-25). 운행 중이면 true 라
  // 기존 동작 100% 보존(회귀 0).
  const inOperation = v != null || Object.keys(arrivals).length > 0;

  // 차량 progress(routePath 기준) — 다음 1개 정류장 잔여거리 계산용.
  let busProgress = null;
  if (usePath && v) {
    const proj = projectToPolyline(v, routePath, cum);
    if (proj) busProgress = proj.progress;
  }

  // 3) "다음 1개" 정류장 = 통과 아닌 최저 인덱스. (status='next' 1개만)
  let nextIdx = -1;
  for (let i = 0; i < stops.length; i++) {
    if (arrivals[stops[i].id] == null) { nextIdx = i; break; }
  }

  // 4) 정류장별 routePath 진행거리(progress, m) 사전 산출 — 구간이동시간 계산용.
  //    routePath 미설정이면 null(직선거리 폴백).
  const stopProgress = stops.map(s =>
    (usePath && typeof s.lat === "number" && typeof s.lng === "number")
      ? (projectToPolyline({ lat: s.lat, lng: s.lng }, routePath, cum)?.progress ?? null)
      : null
  );

  // 두 정류장(인덱스 a→b) 간 구간 이동시간(ms).
  // 2026-05-28 plan-uvert: 둘 다 offsetMin 설정되어 있으면 계획 offsetMin 델타
  //   ((offsetB - offsetA) * 60 * 1000)를 그대로 채택. DWELL 별도 가산 X —
  //   offsetMin 자체가 dwell(정차/감속/가속) 포함된 진입시각 차이라 이중계산 회피.
  //   chain 전파 결과 = actualLast + Σ(plan 델타) = plannedMs[i] + (actualLast -
  //   plannedLast) → "각 정류장 실 도착시간 기준 + 계획 offsetMin"의 사용자 의도.
  // 한쪽 offsetMin 누락 시 geometric 폴백(routePath/직선거리 ÷ 유효속도 + DWELL_SEC).
  const segTravelMs = (a, b) => {
    // (i) plan 우선 — 둘 다 offsetMin 있을 때
    const offA = (stops[a] && typeof stops[a].offsetMin === "number" && isFinite(stops[a].offsetMin))
      ? stops[a].offsetMin : null;
    const offB = (stops[b] && typeof stops[b].offsetMin === "number" && isFinite(stops[b].offsetMin))
      ? stops[b].offsetMin : null;
    if (offA != null && offB != null) {
      // 계획 델타는 음/0 가능(데이터 오류) → 음수 방지로 0 하한.
      // DWELL 가산 안 함 — offsetMin 자체가 진입시각 차이라 이중계산 회피.
      return Math.max(0, (offB - offA) * 60 * 1000);
    }
    // (ii) 폴백 — geometric(routePath 구간거리 or haversine 직선) + DWELL.
    let distM = null;
    if (stopProgress[a] != null && stopProgress[b] != null) {
      distM = Math.max(0, stopProgress[b] - stopProgress[a]);
    } else {
      const pa = stops[a], pb = stops[b];
      if (pa && pb && typeof pa.lat === "number" && typeof pb.lat === "number") {
        distM = haversine({ lat: pa.lat, lng: pa.lng }, { lat: pb.lat, lng: pb.lng });
      }
    }
    if (distM == null) distM = 0;
    // 유효속도: 차량 속도 반영하되 20km/h 하한(정차 중 chain이 무한대로 늘어남 방지).
    const effSpeed = Math.max(
      (typeof speed === "number" && speed > MIN_EFFECTIVE_SPEED_KMH)
        ? speed : DEFAULT_SPEED_KMH,
      MIN_EFFECTIVE_SPEED_KMH
    );
    // 주행시간 + 정차시간(DWELL_SEC) — geometric 폴백에선 정차/감속/가속 포함.
    return (distM / 1000) / effSpeed * 3600 * 1000 + DWELL_SEC * 1000;
  };

  // 5) 정류장 메타(plannedAt/plannedMs/offset)를 1패스로 산출.
  const meta = stops.map((s) => {
    const offset = (typeof s.offsetMin === "number" && isFinite(s.offsetMin))
      ? s.offsetMin : null;
    const plannedAt = (hasPlanBase && offset != null) ? fmtHHMM(baseMin + offset) : null;
    const plannedMs = (hasPlanBase && offset != null)
      ? hhmmToTodayMillis(plannedAt, T_NOW) : null;
    return { offset, plannedAt, plannedMs };
  });

  // 5.5) ── GPS 진척률 통과 안전망 (2026-06-08) ──────────────────────────────
  // 근본 문제: "통과" 판정을 actualArrivals(도착 감지 stopArrivals)로만 함 → 감지
  //   (onStopReached)가 발화 안 하면 출발 정류장이 영원히 'next' 로 남아, 버스가 실제로
  //   14km 갔어도 "now − 출발계획" 균일 지연(예: 24분)을 전 하류에 carry 하는 아티팩트.
  // 해법: busProgress(routePath 투영·신뢰 가능)가 정류장 progress 를 지났으면 통과로
  //   간주. 버스 현재위치의 계획시각을 (lastPassed~next) 보간해 "현재 지연"을 산출하고,
  //   통과 정류장에 합성 도착(계획+현재지연)을 주입 → 실위치 기준으로 앵커링.
  // 안전: routePath+vehiclePos 없으면 비활성(회귀 0). 실측 도착(arrivals)이 있으면 우선
  //   (덮어쓰지 않음). 합성 통과는 source 'gps'(추정)로 구분 — 실측 'actual' 과 구별.
  // 회귀 가드(복원 금지): ① 실측 arrivals 우선(merged 에서 기존값 보존) ② vehiclePos/
  //   routePath 부재 시 완전 비활성 ③ source 'gps' 유지(실측 위장 금지).
  let effArr = arrivals;
  const gpsPassedIds = new Set();
  if (usePath && busProgress != null && hasPlanBase) {
    let lastPassed = -1;
    for (let i = 0; i < stops.length; i++) {
      if (stopProgress[i] != null && busProgress > stopProgress[i] + GPS_PASS_MARGIN_M) lastPassed = i;
    }
    if (lastPassed >= 0) {
      const nextI = Math.min(lastPassed + 1, stops.length - 1);
      const pmA = meta[lastPassed].plannedMs;
      const pmB = meta[nextI].plannedMs;
      let schedMs = pmA;
      if (pmA != null && pmB != null && stopProgress[nextI] != null && stopProgress[lastPassed] != null
          && stopProgress[nextI] > stopProgress[lastPassed]) {
        const frac = Math.min(1, Math.max(0,
          (busProgress - stopProgress[lastPassed]) / (stopProgress[nextI] - stopProgress[lastPassed])));
        schedMs = pmA + frac * (pmB - pmA);
      }
      const gpsDelaySec = (schedMs != null) ? Math.round((T_NOW - schedMs) / 1000) : null;
      if (gpsDelaySec != null) {
        const merged = { ...arrivals };
        let injected = false;
        for (let i = 0; i <= lastPassed; i++) {
          const s = stops[i];
          if (merged[s.id] == null && meta[i].plannedMs != null) {
            merged[s.id] = meta[i].plannedMs + gpsDelaySec * 1000; // 합성 도착(계획+현재지연)
            gpsPassedIds.add(s.id);
            injected = true;
          }
        }
        if (injected) {
          effArr = merged;
          // 누적지연·nextIdx 를 effArr 기준으로 재산출(실측 + GPS 추정 통과).
          let lastIdxWithActual = -1;
          stops.forEach((s, i) => { if (effArr[s.id] != null) lastIdxWithActual = i; });
          if (lastIdxWithActual >= 0 && meta[lastIdxWithActual].plannedMs != null) {
            cumulativeDelaySec = Math.round((effArr[stops[lastIdxWithActual].id] - meta[lastIdxWithActual].plannedMs) / 1000);
            hasDelayRef = true;
          }
          nextIdx = -1;
          for (let i = 0; i < stops.length; i++) { if (effArr[stops[i].id] == null) { nextIdx = i; break; } }
        }
      }
    }
  }

  // 6) order 순서대로 순회하며 estMs를 단조증가로 누적 산출.
  //    prevEstMs = 직전 정류장의 확정 estMs(arrived는 actualMs, 미통과는 보정된 estMs).
  //    prevEstMs가 null이면(노선 시작 전 기준점 없음) T_NOW를 기준으로 사용.
  //    prevDelaySec = 직전까지 알려진 가장 최근 지연(초). arrived 누적지연 우선,
  //    이후 planned 정류장이 자체 산출한 delaySec로도 갱신 → unplanned 정류장
  //    delay carry-forward에 사용(arrived 기록이 아직 없어도 planned 추정 지연으로
  //    "지연 라벨" 노출 가능).
  let prevEstMs = null;
  let prevDelaySec = hasDelayRef ? cumulativeDelaySec : null;
  const out = [];
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i];
    const { offset, plannedAt, plannedMs } = meta[i];

    // (a) 이미 통과(실측 도착 OR GPS 진척률 통과) → prevEstMs를 도착시각으로 갱신(체인 기준점).
    //     GPS 추정 통과(gpsPassedIds)는 source 'gps'(추정)로 구분 — 실측 'actual' 위장 금지.
    if (effArr[s.id] != null) {
      const actualMs = effArr[s.id];
      const estimatedAt = fmtHHMM(
        new Date(actualMs).getHours() * 60 + new Date(actualMs).getMinutes()
      );
      const delaySec = (plannedMs != null)
        ? Math.round((actualMs - plannedMs) / 1000) : null;
      prevEstMs = actualMs;
      if (delaySec != null) prevDelaySec = delaySec;
      out.push({
        stopId: s.id, plannedAt, estimatedAt, delaySec,
        status: "arrived", source: gpsPassedIds.has(s.id) ? "gps" : "actual",
      });
      continue;
    }

    // (b) offsetMin 없음 = 계획 자체가 없음.
    //     2026-05-26 보강: 이전엔 estimatedAt도 null로 반환했으나, 운영 현장에서
    //     일부 정류장만 offsetMin 설정한 노선이 다수 → 지연/예상시각 영구 숨김 결함.
    //     해법 = chain 전파(직전 estMs+segTravelMs)로 estimatedAt 산출 + prevDelaySec
    //     carry-forward(arrived 또는 planned 추정 지연 둘 다 활용) → 지연 라벨도 표시.
    //     plannedAt은 여전히 null(계획 자체가 없음을 보존), status='unplanned'로 구분.
    if (offset == null) {
      const chainBase = (prevEstMs != null) ? prevEstMs : T_NOW;
      let estMs = (i > 0) ? chainBase + segTravelMs(i - 1, i) : chainBase;
      if (prevEstMs != null) {
        estMs = Math.max(estMs, prevEstMs + MIN_STOP_GAP_SEC * 1000);
      }
      // 과거 금지 클램프는 운행 중일 때만 — 운행 전엔 일정 기준 체인값을 그대로 노출
      // (계획시각으로부터 전파된 시각이 현재로 끌려올라가 "예상: 현재시간" 되는 것 차단).
      if (inOperation) estMs = Math.max(estMs, T_NOW + MIN_FUTURE_BUFFER_SEC * 1000);
      prevEstMs = estMs;
      out.push({
        stopId: s.id, plannedAt: null, estimatedAt: fmtHHMM(
          new Date(estMs).getHours() * 60 + new Date(estMs).getMinutes()
        ), delaySec: prevDelaySec,
        status: "unplanned", source: "fallback",
      });
      continue;
    }

    // (b-2) 운행 중이 아님(차량 위치·실측 도착 모두 없음) = "운행시간 아닐 때".
    //   미래 클램프(과거 금지)가 과거 계획시각을 현재시각으로 끌어올려 "예상: 현재시간"
    //   으로 보이던 결함(사용자 호소 2026-06-25) 차단. 일정(계획시각)을 그대로 예상
    //   시각으로 표시한다. delaySec=null(운행 전이라 지연 개념 없음 → 라벨 미표시).
    //   운행 중이면 inOperation=true 라 이 분기 미진입 → 기존 동작 100% 보존.
    if (!inOperation) {
      prevEstMs = plannedMs;
      out.push({
        stopId: s.id, plannedAt, estimatedAt: plannedAt, delaySec: null,
        status: i === nextIdx ? "next" : "upcoming", source: "plan+delay",
      });
      continue;
    }

    // ── 미통과·계획 있음 정류장 = 후보 3개를 산출해 max로 결합 ──
    // (c) planCandidate = 계획시각 + 누적지연.
    const planCandidate = plannedMs != null
      ? plannedMs + cumulativeDelaySec * 1000
      : null;

    // (d) gpsCandidate = nextIdx 정류장 한정 GPS 잔여거리/속도 추정.
    let gpsCandidate = null;
    if (i === nextIdx && v) {
      let remainM = null;
      if (usePath && busProgress != null && stopProgress[i] != null) {
        remainM = Math.max(0, stopProgress[i] - busProgress);
      }
      if (remainM == null) {
        remainM = haversine(v, { lat: s.lat, lng: s.lng }); // 직선거리 폴백
      }
      const etaMinFloat = (remainM / 1000) / spdKmh * 60;
      gpsCandidate = T_NOW + Math.max(0, etaMinFloat) * 60 * 1000;
    }

    // (e) chainCandidate = 직전 정류장 estMs + 구간이동시간.
    //     prevEstMs가 없으면(노선 시작점·기준 부재) T_NOW를 기준으로 chain 시작.
    const chainBase = (prevEstMs != null) ? prevEstMs : T_NOW;
    let chainCandidate = null;
    if (i > 0) {
      chainCandidate = chainBase + segTravelMs(i - 1, i);
    }

    // (f) 후보 결합 — 2026-05-28 plan-uvert(GPS 0%) + 2026-05-29 routePath 진척률
    //     안분(next 한정).
    //   변경 배경(2026-05-28): 이전 정책(next에 chain·gps 0.7:0.3 가중)에서 GPS 속도가
    //   터널·약전계에서 죽거나 30~70km/h로 노이즈하면 gpsCandidate가 출렁여 ETA가
    //   "갑자기 늘었다 줄어드는" 결함이 직접 노출됨.
    //   추가 결함(2026-05-29 사용자 실측): chain plan-uvert 후 next 정류장 ETA는
    //   actualLast+plan 델타로 정류장 통과 시점에만 갱신되므로 정류장 사이에선 정적
    //   → T_NOW만 흐르며 남은 시간 자연 감소 → 정류장 도착 직전 갱신 시 큰 점프
    //   → useSmoothedEta가 5분 이상 점프 시 raw 채택 → "갑자기 곧 도착"으로 도약.
    //   사용자 요구: "노선그린 베이스 기준으로 다음 정류장까지 교통상황 등으로
    //   늦어진다면 진척에 대한 안분으로 계산해서 예정보다 조금씩 늦어지거나 반대로
    //   빨라지는 로직".
    //
    //   해법(next 정류장 한정·routePath 있을 때만):
    //     actualProgress = (busProgress - stopProgress[i-1]) / segDist
    //     expectedProgressByTime = elapsedSinceSegmentStart / expectedTotalMs
    //     slowFactor = max(1, expectedProgressByTime / actualProgress)
    //                  (빠른 방향은 1로 클램프 — 갑작스러운 "곧 도착" 점프 차단)
    //     remainingMs = (1 - actualProgress) * expectedTotalMs * slowFactor
    //     estMs = T_NOW + remainingMs
    //   actualProgress ≥ 0.95 → ARRIVING_BUFFER_SEC(45초) 표시(거의 도착).
    //   actualProgress ≤ 0.05 → 노이즈 구간, chain 그대로(분기 안 함).
    //   진척률 안분은 source='gps'로 표시(사용자가 "GPS 추정" 라벨로 인식).
    //
    //   - next/upcoming 모두: chainCandidate 있으면 그대로 채택(source='plan+delay').
    //   - chain 부재 시 planCandidate 폴백, 그도 없으면 gpsCandidate(상수 보존 — 최후
    //     안전망), 그도 없으면 null.
    //   - next 한정 추가 단계: chain 채택 후 routePath+busProgress 있고 i>0이면
    //     위 진척률 안분으로 estMs 덮어씀(가능할 때만).
    //   source enum 4종(actual/plan+delay/gps/fallback) 호환 유지.
    let estMs = null;
    let source = "plan+delay";
    if (i === nextIdx) {
      // next: chain 우선·GPS 0%(2026-05-28).
      if (chainCandidate != null) {
        estMs = chainCandidate;
        // source 'plan+delay' 유지(chain도 plan과 같은 계열 = actual 후 plan 갱신).
      } else if (planCandidate != null) {
        estMs = planCandidate;
        source = "plan+delay";
      } else if (gpsCandidate != null) {
        // 안전망 — 정상 운영에선 도달 안 함(chain 또는 plan 항상 존재).
        estMs = gpsCandidate;
        source = "gps";
      }
    } else {
      // upcoming: chain 우선(직전 actual·estMs 기반 전파). plan+delay는 chain 부재 시 fallback.
      if (chainCandidate != null) {
        estMs = chainCandidate;
        // source 'plan+delay' 유지(chain은 plan과 무관한 actual+구간이동시간 전파이나
        // describeEtaSource 라벨 한국어("계획+지연")가 사용자에게 자연스러움 = actual
        // 후 추정 = 계획 갱신 형태).
      } else if (planCandidate != null) {
        estMs = planCandidate;
      }
    }
    if (estMs == null) estMs = planCandidate; // 최종 폴백(이론상 plannedMs는 항상 존재)

    // (f-1) routePath 진척률 안분 — next 정류장 한정, busProgress·stopProgress 있을 때만.
    //   2026-05-29 사용자 실측 결함 fix.
    if (
      i === nextIdx &&
      usePath &&
      busProgress != null &&
      i > 0 &&
      stopProgress[i - 1] != null &&
      stopProgress[i] != null
    ) {
      const sa = stopProgress[i - 1];
      const sb = stopProgress[i];
      const segDistM = sb - sa;
      if (segDistM > 0) {
        const traveledM = Math.max(0, busProgress - sa);
        const actualProgress = Math.min(1, traveledM / segDistM);

        if (actualProgress >= ARRIVING_PROGRESS_THRESHOLD) {
          // 거의 도착 — 45초 단순 표시(점프 차단, "곧 도착" 자연 노출).
          estMs = T_NOW + ARRIVING_BUFFER_SEC * 1000;
          source = "gps";
        } else if (actualProgress > PROGRESS_NOISE_FLOOR) {
          // 정상 진행 중 — 시간 진척률 vs 거리 진척률 비교 안분.
          // chain 채택값이 estMs(미래 시각)이므로 segmentStartMs = chainBase 로 가정.
          //   - chainBase = 직전 정류장 actualMs 또는 직전 estMs 또는 T_NOW(노선 시작).
          //   - expectedTotalMs = segTravelMs(i-1, i)
          //   - elapsedMs = max(0, T_NOW - segmentStartMs)
          const segmentStartMs = chainBase; // 위 (e)에서 정의된 직전 기준점
          const expectedTotalMs = segTravelMs(i - 1, i);
          if (expectedTotalMs > 0) {
            const elapsedMs = Math.max(0, T_NOW - segmentStartMs);
            const expectedProgressByTime = Math.min(1, elapsedMs / expectedTotalMs);
            // slowFactor = 시간/거리 비. >1=느림(교통체증), <1=빠름.
            // 빠른 방향은 1로 클램프 — 갑작스러운 "곧 도착" 점프 차단(사용자 호소 #3).
            const slowFactor = (actualProgress > 0)
              ? Math.max(1, expectedProgressByTime / actualProgress)
              : 1;
            const remainingMs = (1 - actualProgress) * expectedTotalMs * slowFactor;
            estMs = T_NOW + remainingMs;
            source = "gps"; // 진척률 기반 표시
          }
        }
        // actualProgress <= 0.05 — 시작 직후 노이즈, chain 그대로(분기 안 함).
      }
    }

    // (f-2) delaySec 표시용 raw 후보 — 가드 적용 전 값 보존.
    //   사용자 신호 #1("정시보다 빨리 와도 지연이 누적") 해결:
    //   가드 적용된 estMs로 delaySec 계산하면 단조증가(60s)·과거금지(30s)에 의해
    //   음수(조기) 지연이 양수(지연)로 뒤집힐 수 있음.
    //   해법 = arrived는 (actualMs - plannedMs) 그대로(불변, 위 (a) 분기), 미통과는
    //   가드 적용 *전* raw 후보(chain → plan → est 순) 기준으로 delaySec 산출.
    //   estMs(표시 시각)는 가드 적용해서 단조증가/과거금지 정합 유지.
    const rawForDelay = (chainCandidate != null) ? chainCandidate
      : (planCandidate != null) ? planCandidate
      : estMs;

    // (g) 단조증가 강제 — 직전 정류장 estMs보다 최소 MIN_STOP_GAP_SEC 이후.
    //     동일값·역전을 원천 차단(이슈 2·3의 핵심 메커니즘 제거).
    if (prevEstMs != null) {
      estMs = Math.max(estMs, prevEstMs + MIN_STOP_GAP_SEC * 1000);
    }
    // (h) 과거 금지 — 미통과 정류장 estimate는 항상 미래.
    //     단조증가가 우선(i가 크면 누적 segTravelTime으로 자연히 미래).
    estMs = Math.max(estMs, T_NOW + MIN_FUTURE_BUFFER_SEC * 1000);

    // 체인 기준점 갱신.
    prevEstMs = estMs;

    const estimatedAt = fmtHHMM(
      new Date(estMs).getHours() * 60 + new Date(estMs).getMinutes()
    );
    // delaySec은 raw(가드 적용 전) 기준 — 음수 지연(조기 도착) 뒤집힘 차단.
    const delaySec = (plannedMs != null)
      ? Math.round((rawForDelay - plannedMs) / 1000)
      : (hasDelayRef ? cumulativeDelaySec : null);
    // 가장 최근 알려진 지연 갱신(unplanned 정류장 carry-forward용).
    if (delaySec != null) prevDelaySec = delaySec;

    out.push({
      stopId: s.id, plannedAt, estimatedAt, delaySec,
      status: i === nextIdx ? "next" : "upcoming",
      source,
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// formatPassengerEta(etaSec, now?) — 부드러워진 ETA(초) → 승객용 라벨·신뢰도 톤.
//   입력: etaSec (number|null) — useSmoothedEta 통과한 값 또는 null.
//        now (millis, optional) — 테스트성. 기본 Date.now().
//   출력: {
//     primary: 큰 글씨 라벨 ("곧 도착" | "5분 후" | "약 10분" | "07:35 예상" | "지나감" | "대기 중"),
//     tone: 'primary' | 'warn' | 'mute' (강조 색),
//     precise: "HH:MM" — 보조 작은 글씨용 도착 예상 시각 (null 가능),
//     bucket: 디버그/테스트용 라벨 ('soon'/'min'/'about5'/'time'/'wait'/'passed')
//   }
// 버킷:
//   null/NaN          → "대기 중", mute, precise=null
//   < 0 초            → "지나감", warn, precise=null (음수 = 이미 지난 시각)
//   < 60s             → "곧 도착", primary
//   < 5분(300s)       → "{n}분 후", primary (n=Math.max(1, round(sec/60)))
//   < 60분(3600s)     → "약 {round5}분", primary (5분 단위 반올림)
//   ≥ 60분            → "{HH:MM} 예상", mute
// ────────────────────────────────────────────────────────────────────────────
export function formatPassengerEta(etaSec, now) {
  if (etaSec == null || !isFinite(etaSec)) {
    return { primary: "대기 중", tone: "mute", precise: null, bucket: "wait" };
  }
  const T_NOW = now || Date.now();
  if (etaSec < 0) {
    return { primary: "지나감", tone: "warn", precise: null, bucket: "passed" };
  }
  // 보조 precise 시각(HH:MM) — 모든 정상 케이스에서 제공.
  const arriveMs = T_NOW + etaSec * 1000;
  const d = new Date(arriveMs);
  const precise = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

  if (etaSec < 60) {
    return { primary: "곧 도착", tone: "primary", precise, bucket: "soon" };
  }
  if (etaSec < 300) {
    const n = Math.max(1, Math.round(etaSec / 60));
    return { primary: `${n}분 후`, tone: "primary", precise, bucket: "min" };
  }
  if (etaSec < 3600) {
    // 5분 단위 반올림 — 분 단위 깜빡임 흡수(예: 12·13·14분 → "약 15분"·"약 10분")
    const minutes = etaSec / 60;
    const rounded = Math.max(5, Math.round(minutes / 5) * 5);
    return { primary: `약 ${rounded}분`, tone: "primary", precise, bucket: "about5" };
  }
  // 60분 이상은 분이 무의미 → 도착 예상 시각만.
  return { primary: `${precise} 예상`, tone: "mute", precise, bucket: "time" };
}

// estimate.source(=computeStopEstimates의 source) → 짧은 한국어 라벨.
// 메인 카운트다운 밑 11px 보조 표시 — 사용자가 "어떤 데이터인지" 알아 신뢰.
//   'actual'      → '실측'
//   'plan+delay'  → '계획+지연'
//   'gps'         → 'GPS 추정'
//   'fallback'    → '대략'
//   그 외/null    → null
export function describeEtaSource(source) {
  switch (source) {
    case "actual":     return "실측";
    case "plan+delay": return "계획+지연";
    case "gps":        return "GPS 추정";
    case "fallback":   return "대략";
    default: return null;
  }
}

// 지연(초) → 한국어 짧은 라벨. 정시 임계 ±1분(2026-05-21 좁힘),
// 지연 ≥2분, 조기 ≤-2분 — 어르신 가독성 위해 2~3분 지연도 가시화.
//   ≥2분 지연  → { tone: 'danger',  label: '지연 N분' }
//   ≤-2분 조기 → { tone: 'warn',    label: '조기도착 N분' }  (조기출발 오인 방지, 2026-06-24 채드윅)
//   그 외(±1분)→ { tone: 'ok',      label: '정시' }
//   null        → { tone: 'mute',    label: '' }
// 정류장 미설정(offsetMin null) 케이스는 computeStopEstimates 가 delaySec=null 반환 →
// 여기서 mute('')로 빠짐 → 페이지 게이트(driving·plannedAt 등)와 무관하게 라벨 미표시
// (정류장 진입시각 미설정시 지연 안내 자체가 불가능 — AdminApp 정류장 폼 입력 안내).
export function formatDelayLabel(delaySec) {
  if (delaySec == null || !isFinite(delaySec)) return { tone: "mute", label: "" };
  const m = Math.round(delaySec / 60);
  if (m >= 2)  return { tone: "danger", label: `지연 ${m}분` };
  if (m <= -2) return { tone: "warn",   label: `조기도착 ${-m}분` };
  return { tone: "ok", label: "정시" };
}
