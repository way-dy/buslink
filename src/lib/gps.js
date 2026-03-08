import { db } from "../firebase";
import { doc, setDoc, addDoc, collection, serverTimestamp } from "firebase/firestore";

let lastPos = null;

function getDistance(p1, p2) {
  const R = 6371000;
  const dLat = (p2.lat - p1.lat) * Math.PI / 180;
  const dLng = (p2.lng - p1.lng) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(p1.lat*Math.PI/180) *
    Math.cos(p2.lat*Math.PI/180) *
    Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

export function startGPS({ companyId, vehicleId, driverId, routeId }) {
  return navigator.geolocation.watchPosition(
    async (position) => {
      const curr = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        speed: Math.round((position.coords.speed || 0) * 3.6),
        accuracy: Math.round(position.coords.accuracy),
      };

      // 10m 미만 이동 시 전송 스킵
      if (lastPos && getDistance(lastPos, curr) < 10) return;
      lastPos = curr;

      // 실시간 위치 업데이트
      await setDoc(doc(db, "gps", `${companyId}_${vehicleId}`), {
        ...curr, companyId, driverId, routeId,
        updatedAt: serverTimestamp(),
      });

      // 운행 이력 저장
      const today = new Date().toISOString().slice(0, 10);
      await addDoc(
        collection(db, "gpsHistory", companyId, vehicleId, today, "points"),
        { lat: curr.lat, lng: curr.lng, speed: curr.speed, ts: serverTimestamp() }
      );
    },
    (err) => console.error("GPS 오류:", err),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
  );
}

export function stopGPS(watchId) {
  navigator.geolocation.clearWatch(watchId);
  lastPos = null;
}