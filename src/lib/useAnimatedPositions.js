import { useState, useEffect, useRef, useCallback } from "react";

const ANIM_DURATION = 1500; // 기본/폴백 이동 시간(첫 도착·간격 미기록 시)
const MIN_DUR = 1200;       // per-vehicle 동적 duration 하한
const MAX_DUR = 8000;       // per-vehicle 동적 duration 상한

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * 차량 GPS 좌표를 부드럽게 애니메이션하는 훅
 * @param {Array} rawVehicles - Firestore에서 받은 실시간 차량 목록
 * @returns {Array} 애니메이션 적용된 차량 목록 (displayVehicles)
 */
export function useAnimatedPositions(rawVehicles) {
  const [displayVehicles, setDisplayVehicles] = useState([]);
  const prevPositions = useRef({}); // { vehicleId: { lat, lng } }
  const targetPositions = useRef({}); // { vehicleId: { lat, lng } }
  const animStartTime = useRef({}); // { vehicleId: timestamp }
  const lastArrivalTime = useRef({}); // { vehicleId: 마지막 타겟 갱신 시각 } — 도착 간격 측정용
  const durRef = useRef({}); // { vehicleId: 동적 이동 시간(ms) } = 실제 도착 간격(clamp)
  const rafRef = useRef(null);
  const rawRef = useRef(rawVehicles);

  // rawVehicles 변경 시 타겟 위치 업데이트
  useEffect(() => {
    rawRef.current = rawVehicles;

    rawVehicles.forEach((v) => {
      if (!v.lat || !v.lng) return;
      const id = v.id;
      const newPos = { lat: v.lat, lng: v.lng };

      // 이전 위치가 없으면 즉시 설정 (첫 로드)
      if (!prevPositions.current[id]) {
        prevPositions.current[id] = { ...newPos };
        targetPositions.current[id] = { ...newPos };
        return;
      }

      // 위치 변화가 있을 때만 애니메이션 시작
      const target = targetPositions.current[id];
      if (target && Math.abs(target.lat - newPos.lat) < 0.000001 && Math.abs(target.lng - newPos.lng) < 0.000001) {
        return; // 변화 없음
      }

      // 현재 표시 위치를 prev로 저장, 새 위치를 target으로
      const currentDisplay = displayVehicles.find((d) => d.id === id);
      if (currentDisplay && currentDisplay.lat && currentDisplay.lng) {
        prevPositions.current[id] = { lat: currentDisplay.lat, lng: currentDisplay.lng };
      }
      targetPositions.current[id] = { ...newPos };
      const now = performance.now();
      // per-vehicle 동적 duration = 실제 도착 간격(clamp) — "받은 시간만큼" 이동해 정지 구간 제거.
      // 첫 도착·기록 없음 = 기본 ANIM_DURATION.
      const prevArrival = lastArrivalTime.current[id];
      durRef.current[id] = prevArrival ? clamp(now - prevArrival, MIN_DUR, MAX_DUR) : ANIM_DURATION;
      lastArrivalTime.current[id] = now;
      animStartTime.current[id] = now;
    });
  }, [rawVehicles]); // eslint-disable-line react-hooks/exhaustive-deps

  // 애니메이션 루프
  const animate = useCallback(() => {
    const now = performance.now();
    const raw = rawRef.current;
    let hasActiveAnimation = false; // ★ 진행 중인 애니메이션 추적

    const updated = raw.map((v) => {
      if (!v.lat || !v.lng) return v;
      const id = v.id;
      const prev = prevPositions.current[id];
      const target = targetPositions.current[id];
      const startTime = animStartTime.current[id];

      if (!prev || !target || !startTime) {
        return v; // 데이터 없으면 원본 반환
      }

      const elapsed = now - startTime;
      const progress = Math.min(elapsed / (durRef.current[id] || ANIM_DURATION), 1);
      const eased = progress; // 선형(등속) — 구간별 감속·가속 제거, 연속 추적

      if (progress < 1) hasActiveAnimation = true; // ★ 아직 움직이는 차량 있음

      return {
        ...v,
        lat: lerp(prev.lat, target.lat, eased),
        lng: lerp(prev.lng, target.lng, eased),
      };
    });

    setDisplayVehicles(updated);

    // ★ 진행 중인 애니메이션이 있을 때만 다음 프레임 요청
    if (hasActiveAnimation) {
      rafRef.current = requestAnimationFrame(animate);
    } else {
      rafRef.current = null;
    }
  }, []);

  // ★ rawVehicles 변경 시 rAF 루프 재시작 (멈춰있을 수 있으므로)
  useEffect(() => {
    if (rawVehicles.length > 0 && !rafRef.current) {
      rafRef.current = requestAnimationFrame(animate);
    }
  }, [rawVehicles, animate]);

  useEffect(() => {
    rafRef.current = requestAnimationFrame(animate);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [animate]);

  return displayVehicles.length > 0 ? displayVehicles : rawVehicles;
}