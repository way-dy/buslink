// src/lib/stopSchedule.js — 정류장 계획시각·실시간 도착예정 산출 (순수 함수)
// ---------------------------------------------------------------------------
// EmployeeApp(/p) · PassengerApp(/bus) · DriverApp(/) 공통 import.
//   - planTimeForStop: 노선 출발시각(departTime "HH:MM") + 정류장 offsetMin(분)
//     → 정류장 계획 진입시각("HH:MM" 또는 null).
//   - computeStopEstimates: 정류장별 status·계획시각·예상시각·지연(초) 산출.
//     실 도착(actualArrivals) 누적지연을 미통과 정류장에 적용 + 다음 1개는
//     GPS 잔여거리/속도와 30:70 가중평균(2026-05-21 ETA 안정화: GPS 비중 축소,
//     plan+delay 안정성 우세 — GPS 노이즈 30~70km/h 흔들림 vs plan+delay는
//     정류장 통과 후 1회만 갱신). offsetMin 미설정 정류장은 calcETA 폴백.
//   - formatPassengerEta: 부드러워진 ETA(초)를 버킷 라벨(곧 도착/N분 후/약 N분/
//     HH:MM 예상)로 변환 + 신뢰도 톤(primary/warn/mute).
// react-kakao-maps-sdk · Firebase import 없음(순수 계산).
// ---------------------------------------------------------------------------

import { haversine, projectToPolyline, buildCumulativeLengths } from "./routeProgress";

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

  return stops.map((s, i) => {
    const offset = (typeof s.offsetMin === "number" && isFinite(s.offsetMin))
      ? s.offsetMin : null;
    const plannedAt = (hasPlanBase && offset != null) ? fmtHHMM(baseMin + offset) : null;
    const plannedMs = (hasPlanBase && offset != null)
      ? hhmmToTodayMillis(plannedAt, T_NOW) : null;

    // (a) 이미 통과(실 도착 있음) → 실측.
    if (arrivals[s.id] != null) {
      const actualMs = arrivals[s.id];
      const estimatedAt = fmtHHMM(
        new Date(actualMs).getHours() * 60 + new Date(actualMs).getMinutes()
      );
      const delaySec = (plannedMs != null)
        ? Math.round((actualMs - plannedMs) / 1000) : null;
      return {
        stopId: s.id, plannedAt, estimatedAt, delaySec,
        status: "arrived", source: "actual",
      };
    }

    // (b) offsetMin 없음 = 계획 자체가 없음 → 폴백(calcETA류) 단위로 표시.
    if (offset == null) {
      // 폴백 ETA는 페이지에서 calcETA 직접 호출하므로 여기선 status만 알린다.
      return {
        stopId: s.id, plannedAt: null, estimatedAt: null, delaySec: null,
        status: "unplanned", source: "fallback",
      };
    }

    // (c) 계획 + 누적지연 적용.
    const planDelayMs = plannedMs != null
      ? plannedMs + cumulativeDelaySec * 1000
      : null;

    // (d) "다음 1개" 정류장은 GPS 잔여거리 기반 추정 + 가중 평균.
    let gpsMs = null;
    if (i === nextIdx && v) {
      let remainM;
      if (usePath && busProgress != null) {
        const stopProj = projectToPolyline({ lat: s.lat, lng: s.lng }, routePath, cum);
        if (stopProj) remainM = Math.max(0, stopProj.progress - busProgress);
      }
      if (remainM == null) {
        // 폴백: 직선 거리
        remainM = haversine(v, { lat: s.lat, lng: s.lng });
      }
      const etaMinFloat = (remainM / 1000) / spdKmh * 60;
      gpsMs = T_NOW + Math.max(0, etaMinFloat) * 60 * 1000;
    }

    // (e) 가중 평균 — 둘 다 있을 때 plan+delay 70 : gps 30 (2026-05-21).
    // GPS 잔여거리/속도 추정은 노이즈가 크므로(같은 50km/h라도 30~70 흔들림)
    // 계획+누적지연(정류장 통과 후 1회만 갱신) 쪽에 더 비중. 누적지연이 미반영된
    // 노선 첫 정류장도 plan 자체로 안정 — 5km/h 임계점프(`(speed>5?speed:30)`)에
    // 직접 노출되는 표면을 줄임. UI(`useSmoothedEta`)와 함께 이중 완충.
    let estMs = null;
    let source = "plan+delay";
    if (planDelayMs != null && gpsMs != null) {
      estMs = 0.7 * planDelayMs + 0.3 * gpsMs;
      source = "gps";
    } else if (planDelayMs != null) {
      estMs = planDelayMs;
      source = "plan+delay";
    } else if (gpsMs != null) {
      estMs = gpsMs;
      source = "gps";
    }
    // 누적지연 참조점이 없고 다음정류장도 아닌 경우는 estMs == planDelayMs(==plannedMs).

    // 과거로 추정된 경우(이미 지났어야 함) — 약한 보정: '지금 또는 임박'으로 끌어올림.
    // (status 자체는 next/upcoming 유지 — 도착감지가 곧 actual로 덮어씀.)
    if (estMs != null && estMs < T_NOW - 30 * 1000) {
      estMs = T_NOW;
    }

    const estimatedAt = estMs != null
      ? fmtHHMM(new Date(estMs).getHours() * 60 + new Date(estMs).getMinutes())
      : null;
    const delaySec = (estMs != null && plannedMs != null)
      ? Math.round((estMs - plannedMs) / 1000)
      : (hasDelayRef ? cumulativeDelaySec : null);

    return {
      stopId: s.id, plannedAt, estimatedAt, delaySec,
      status: i === nextIdx ? "next" : "upcoming",
      source,
    };
  });
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
//   ≤-2분 조기 → { tone: 'warn',    label: '조기 N분' }
//   그 외(±1분)→ { tone: 'ok',      label: '정시' }
//   null        → { tone: 'mute',    label: '' }
// 정류장 미설정(offsetMin null) 케이스는 computeStopEstimates 가 delaySec=null 반환 →
// 여기서 mute('')로 빠짐 → 페이지 게이트(driving·plannedAt 등)와 무관하게 라벨 미표시
// (정류장 진입시각 미설정시 지연 안내 자체가 불가능 — AdminApp 정류장 폼 입력 안내).
export function formatDelayLabel(delaySec) {
  if (delaySec == null || !isFinite(delaySec)) return { tone: "mute", label: "" };
  const m = Math.round(delaySec / 60);
  if (m >= 2)  return { tone: "danger", label: `지연 ${m}분` };
  if (m <= -2) return { tone: "warn",   label: `조기 ${-m}분` };
  return { tone: "ok", label: "정시" };
}
