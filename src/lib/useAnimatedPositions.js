import { useState, useEffect, useRef, useCallback } from "react";

const ANIM_DURATION = 1500; // 1.5초 동안 부드럽게 이동

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
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
      animStartTime.current[id] = performance.now();
    });
  }, [rawVehicles]); // eslint-disable-line react-hooks/exhaustive-deps

  // 애니메이션 루프
  const animate = useCallback(() => {
    const now = performance.now();
    const raw = rawRef.current;

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
      const progress = Math.min(elapsed / ANIM_DURATION, 1);
      const eased = easeInOutCubic(progress);

      return {
        ...v,
        lat: lerp(prev.lat, target.lat, eased),
        lng: lerp(prev.lng, target.lng, eased),
      };
    });

    setDisplayVehicles(updated);
    rafRef.current = requestAnimationFrame(animate);
  }, []);

  useEffect(() => {
    rafRef.current = requestAnimationFrame(animate);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [animate]);

  return displayVehicles.length > 0 ? displayVehicles : rawVehicles;
}