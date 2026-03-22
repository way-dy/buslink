import { db } from "../firebase";
import { doc, setDoc, addDoc, deleteDoc, collection, serverTimestamp } from "firebase/firestore";

let lastPos = null;
let lastSentTime = 0;
const MIN_DISTANCE_M = 5;
const MIN_INTERVAL_MS = 5000;
const STOP_ARRIVE_M = 100; // 100m 이내 = 정류장 도착

function getDistance(p1, p2) {
  const R = 6371000;
  const dLat = (p2.lat - p1.lat) * Math.PI / 180;
  const dLng = (p2.lng - p1.lng) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(p1.lat*Math.PI/180) * Math.cos(p2.lat*Math.PI/180) *
    Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// 각 정류장까지 거리 계산 → 가장 가까운 정류장 반환
export function getNearestStop(pos, stops) {
  if (!stops || stops.length === 0) return null;
  let min = Infinity, nearest = null;
  stops.forEach(s => {
    const d = getDistance(pos, { lat: s.lat, lng: s.lng });
    if (d < min) { min = d; nearest = { ...s, distance: Math.round(d) }; }
  });
  return nearest;
}

// 목적지(내 정류장)까지 거리 기반 ETA(분) 계산
export function calcETA(vehiclePos, targetStop, speedKmh) {
  if (!vehiclePos || !targetStop) return null;
  const dist = getDistance(vehiclePos, { lat: targetStop.lat, lng: targetStop.lng });
  const speed = (speedKmh > 5 ? speedKmh : 30); // 정지 시 기본 30km/h 가정
  return Math.ceil((dist / 1000) / speed * 60);
}

// ✅ sendGPS: 시뮬레이터/외부에서도 직접 호출 가능
export async function sendGPS({ companyId, vehicleId, vehicleNo, driverId, driverName, routeId, routeName, lat, lng, speed, accuracy }) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
  await setDoc(doc(db, "gps", `${companyId}_${vehicleId}`), {
    lat, lng, speed: speed ?? 0, accuracy: accuracy ?? 0,
    companyId, vehicleId, vehicleNo,
    driverId, driverName,
    routeId, routeName,
    updatedAt: serverTimestamp(),
  });
  await addDoc(
    collection(db, "gpsHistory", companyId, vehicleId, today, "points"),
    { lat, lng, speed: speed ?? 0, ts: serverTimestamp() }
  );
}

// ✅ clearGPS: 운행 종료 시 실시간 GPS 문서 삭제
export async function clearGPS({ companyId, vehicleId }) {
  try {
    await deleteDoc(doc(db, "gps", `${companyId}_${vehicleId}`));
  } catch (e) {
    console.warn("[BusLink] GPS 문서 삭제 실패:", e.message);
  }
}

// ✅ startGPS: stops + onStopReached 콜백 추가
export function startGPS({ companyId, vehicleId, vehicleNo, driverId, driverName, routeId, routeName, stops = [], onStopReached }) {
  lastPos = null;
  lastSentTime = 0;
  const visitedStops = new Set(); // 이미 도착 처리된 정류장 ID

  return navigator.geolocation.watchPosition(
    async (position) => {
      const now = Date.now();
      const curr = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        speed: Math.round((position.coords.speed || 0) * 3.6),
        accuracy: Math.round(position.coords.accuracy),
      };

      // 정류장 근접 감지 (GPS 필터링 전에 먼저 체크)
      if (stops.length > 0 && onStopReached) {
        stops.forEach(stop => {
          if (visitedStops.has(stop.id)) return;
          const dist = getDistance(curr, { lat: stop.lat, lng: stop.lng });
          if (dist <= STOP_ARRIVE_M) {
            visitedStops.add(stop.id);
            onStopReached(stop, Math.round(dist));
          }
        });
      }

      // 거리/시간 필터
      if (lastPos && getDistance(lastPos, curr) < MIN_DISTANCE_M) return;
      if (now - lastSentTime < MIN_INTERVAL_MS) return;
      lastPos = curr;
      lastSentTime = now;

      await sendGPS({ companyId, vehicleId, vehicleNo, driverId, driverName, routeId, routeName, ...curr });
    },
    (err) => console.error("GPS 오류:", err),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
  );
}

export function stopGPS(watchId) {
  navigator.geolocation.clearWatch(watchId);
  lastPos = null;
  lastSentTime = 0;
}
