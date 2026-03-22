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
