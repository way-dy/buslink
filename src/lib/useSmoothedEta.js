// src/lib/useSmoothedEta.js — 승객 도착 예정 ETA 부드럽기 훅 (EMA + rate-limit)
// ---------------------------------------------------------------------------
// 카운트다운이 GPS 속도 노이즈(같은 50km/h라도 30~70 흔들림) + Math.ceil 분 단위 점프
// + `(speed>5 ? speed : 30)` 5km/h 임계점프로 "갑자기 늘어났다 줄어드는" 현상을
// 부드럽게 다듬는다.
//
//   - 입력: rawSec(초 단위, number|null). null이면 즉시 reset.
//   - 출력: smoothedSec(number|null). 표시 헬퍼(formatPassengerEta)로 라벨화.
//   - 동작:
//     ① raw==null → 즉시 null(예: 운행 종료/대기).
//     ② 직전 값 없음 → 즉시 raw 채택(초기 표시 지연 없음).
//     ③ |raw - prev_predicted| > jumpThresholdSec(기본 300s=5분) → 즉시 raw
//        (stopArrivals 누적지연 갱신 같은 의미 있는 변화는 곧장 반영).
//     ④ 그 외 → 자연 감소(prev - dt) + 새 raw에 EMA α=0.25 + 변화량 캡.
//
// React 훅. Firebase·외부 SDK import 없음(순수).
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from "react";

const DEFAULT_OPTS = {
  // 한 갱신 사이 증가 캡(초/초). 0.5 = 1초 흐를 때 ETA 증가는 0.5초까지만 허용
  // → 5km/h 임계점프(30→6km/h 가정 변경으로 ETA 5배 증가)를 완만하게.
  maxIncreasePerSec: 0.5,
  // 한 갱신 사이 감소 캡(초/초). 1.5 = 실제 시간 흐름(1.0)보다 빠른 감소까지 일부 허용
  // → 버스가 빨리 다가오는 정상 시나리오는 부드럽게 줄어듦.
  maxDecreasePerSec: 1.5,
  // 3분 이상 점프는 의미 있는 변화로 간주(정류장 통과 시점 갱신·누적지연·노선 변경) ·
  // 즉시 반영. 2026-05-29 routePath 진척률 안분 도입 후 정상 진행 중에도 ETA가 시간/거리
  // 비례로 부드럽게 변동 → 큰 점프 사례 자체가 줄어듦. 300→180으로 좁혀 정류장 통과
  // 시점의 의미 있는 변경만 즉시 반영, 자연 감소·노이즈는 EMA로 흡수.
  jumpThresholdSec: 180,
  // EMA 가중치 — raw 0.25 + prev_predicted 0.75. 너무 높으면 노이즈 따라가고,
  // 너무 낮으면 실제 변화 늦게 반영. 0.25가 5km/h 임계점프엔 충분히 매끈.
  alpha: 0.25,
};

export function useSmoothedEta(rawSec, opts) {
  const { maxIncreasePerSec, maxDecreasePerSec, jumpThresholdSec, alpha } = {
    ...DEFAULT_OPTS,
    ...(opts || {}),
  };
  const prevRef = useRef(null);          // 직전 smoothed 값(초)
  const lastUpdateRef = useRef(0);       // 직전 갱신 시각(ms) — dt 계산
  const [smoothed, setSmoothed] = useState(null);

  useEffect(() => {
    // null·NaN → reset(운행 종료/myStop 미선택/대기).
    if (rawSec == null || !isFinite(rawSec)) {
      prevRef.current = null;
      lastUpdateRef.current = 0;
      setSmoothed(null);
      return;
    }

    const now = Date.now();
    const prev = prevRef.current;

    // 첫 값 → 즉시 채택.
    if (prev == null) {
      prevRef.current = rawSec;
      lastUpdateRef.current = now;
      setSmoothed(rawSec);
      return;
    }

    // 시간 흐름 보정: 직전 표시값에서 dt초만큼 자연 감소(prev_predicted).
    const dt = lastUpdateRef.current > 0
      ? Math.max(0, (now - lastUpdateRef.current) / 1000) : 0;
    const prevPredicted = Math.max(0, prev - dt);

    // 의미 있는 점프(5분 이상) → 즉시 raw(예: 도착 이벤트 후 누적지연 갱신).
    if (Math.abs(rawSec - prevPredicted) > jumpThresholdSec) {
      prevRef.current = rawSec;
      lastUpdateRef.current = now;
      setSmoothed(rawSec);
      return;
    }

    // EMA: raw·prev_predicted 가중평균.
    let next = alpha * rawSec + (1 - alpha) * prevPredicted;

    // 변화량 캡(dt 비례). dt=0(즉시 재실행)은 캡 0 → 변화 차단.
    const maxUp = maxIncreasePerSec * dt;
    const maxDown = maxDecreasePerSec * dt;
    if (next > prevPredicted + maxUp) next = prevPredicted + maxUp;
    if (next < prevPredicted - maxDown) next = prevPredicted - maxDown;
    if (next < 0) next = 0;

    prevRef.current = next;
    lastUpdateRef.current = now;
    setSmoothed(next);
  }, [rawSec, maxIncreasePerSec, maxDecreasePerSec, jumpThresholdSec, alpha]);

  return smoothed;
}
