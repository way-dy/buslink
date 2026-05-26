import { db } from "../firebase";
import {
  doc, setDoc, getDoc, addDoc, collection, serverTimestamp, Timestamp
} from "firebase/firestore";

// ─── 토큰 생성 ───────────────────────────────────────────
export async function createBoardingToken({ companyId, routeId, routeName, vehicleId, vehicleNo, driverId }) {
  const tokenId = generateTokenId();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 5 * 60 * 1000); // 5분 후 만료
  const dispatchDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(now);

  await setDoc(doc(db, "boardingTokens", tokenId), {
    tokenId,
    companyId, routeId, routeName,
    vehicleId, vehicleNo, driverId,
    dispatchDate,
    createdAt: serverTimestamp(),
    expiresAt: Timestamp.fromDate(expiresAt),
    used: false,
  });

  return tokenId;
}

// ─── 토큰 검증 + 탑승 기록 ───────────────────────────────
export async function validateAndBoard({ tokenId, empNo, name, stopId, stopName }) {
  const ref = doc(db, "boardingTokens", tokenId);
  const snap = await getDoc(ref);

  if (!snap.exists()) throw new Error("유효하지 않은 QR코드입니다");

  const token = snap.data();
  const now = new Date();
  const expiresAt = token.expiresAt.toDate();

  if (now > expiresAt) throw new Error("QR코드가 만료되었습니다\n기사님께 새 QR코드를 요청하세요");
  if (token.used) throw new Error("이미 사용된 QR코드입니다");
  if (!empNo.trim()) throw new Error("사번을 입력해주세요");

  const { companyId, routeId, routeName, vehicleId, vehicleNo, driverId, dispatchDate } = token;

  // partnerCode 자동 채움 — 직원(passengers/{empNo}) 문서에서 조회 (협력사별 탑승 통계용 denormalize).
  // 직원 미등록(passengers 없음) 또는 partnerCode 미설정 → null. 통계 화면에서 "미지정"으로 표시.
  let partnerCode = null;
  try {
    const passSnap = await getDoc(doc(db, "companies", companyId, "passengers", empNo.trim()));
    if (passSnap.exists()) partnerCode = passSnap.data().partnerCode || null;
  } catch (_) { /* 권한/네트워크 오류는 partnerCode 부재로 처리 — 탑승 기록 자체는 진행 */ }

  // 차량 GPS 위치 캡처 (2026-05-26) — 탑승 시점의 차량 좌표를 보존해 사후 정류장 매핑 가능.
  // gps/{companyId}_{vehicleId} 는 실시간 현재 위치(덮어쓰기) — 토큰 발급 후 짧은 시간 내 사용 전제로
  // 탑승 순간과 거의 동시 위치. 미수신 차량/네트워크 오류 → null. 통계에서 "미매핑"으로 분리.
  let vehicleLat = null, vehicleLng = null, vehicleSpeed = null;
  try {
    const gpsSnap = await getDoc(doc(db, "gps", `${companyId}_${vehicleId}`));
    if (gpsSnap.exists()) {
      const g = gpsSnap.data();
      vehicleLat = typeof g.lat === "number" ? g.lat : null;
      vehicleLng = typeof g.lng === "number" ? g.lng : null;
      vehicleSpeed = typeof g.speed === "number" ? g.speed : null;
    }
  } catch (_) { /* GPS 미수신/권한 → null 처리, 탑승 자체는 진행 */ }

  // 탑승 기록 저장
  const boardingRef = collection(db, "companies", companyId, "boardings", dispatchDate, "list");
  await addDoc(boardingRef, {
    empNo: empNo.trim(),
    name: name?.trim() || "",
    tokenId,
    companyId, routeId, routeName,
    vehicleId, vehicleNo, driverId,
    stopId: stopId || "",
    stopName: stopName || "",
    partnerCode, // 신규 필드 (2026-05-26) — 통계 화면 협력사 필터/그룹용
    vehicleLat, vehicleLng, vehicleSpeed, // 신규 필드 (2026-05-26) — 정류장별 GPS 매핑용
    boardedAt: serverTimestamp(),
  });

  // 토큰 소각 (재사용 방지)
  await setDoc(ref, { used: true, usedAt: serverTimestamp(), usedBy: empNo.trim() }, { merge: true });

  return { routeName, vehicleNo, dispatchDate };
}

// ─── 유틸 ────────────────────────────────────────────────
function generateTokenId() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: 20 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

export function getBoardingUrl(tokenId) {
  const base = window.location.origin;
  return `${base}/board?t=${tokenId}`;
}
