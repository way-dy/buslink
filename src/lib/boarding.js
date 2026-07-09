import { db } from "../firebase";
import {
  doc, setDoc, getDoc, getDocs, addDoc, collection, query, where, serverTimestamp, Timestamp
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

// ─── 승객 발행 QR (역방향, 2026-05-27) ─────────────────────
// 카메라 권한이 없는 협력사 직원이 본인 폰에서 QR을 발행 → 기사가 자기 폰 카메라로 스캔.
// 별도 컬렉션 `passengerTokens` 로 분리: rules 영향 좁고, 만료/소각 정책 독립(2분 만료).
// tokenId 는 기존 generateTokenId() 재사용(20자 영숫자).
export async function createPassengerToken({ companyId, empNo, name, partnerCode }) {
  const tokenId = generateTokenId();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 2 * 60 * 1000); // 2분 후 만료

  await setDoc(doc(db, "passengerTokens", tokenId), {
    tokenId,
    companyId,
    empNo: (empNo || "").toString().trim(),
    name: (name || "").toString().trim(),
    partnerCode: partnerCode || null,
    createdAt: serverTimestamp(),
    expiresAt: Timestamp.fromDate(expiresAt),
    used: false,
  });

  return tokenId;
}

// ─── 승객 토큰 검증 + 탑승 기록 (기사 스캔측) ──────────────
// 기사앱이 스캔한 승객 QR(JSON 페이로드의 tokenId)로 호출.
// 흐름은 validateAndBoard 와 동일한 boardings 스키마(통계 화면 무영향) 유지하되,
// 입력 출처가 다르므로 별도 함수로 분리(소각 컬렉션도 passengerTokens 로 다름).
export async function validateAndBoardByDriver({
  tokenId, driverId,
  companyId, routeId, routeName, vehicleId, vehicleNo, dispatchDate,
  stopId, stopName,
}) {
  const ref = doc(db, "passengerTokens", tokenId);
  const snap = await getDoc(ref);

  if (!snap.exists()) throw new Error("유효하지 않은 QR코드입니다");

  const token = snap.data();
  const now = new Date();
  const expiresAt = token.expiresAt.toDate();

  if (now > expiresAt) throw new Error("QR코드가 만료되었습니다\n직원에게 새 QR 발행을 요청하세요");
  if (token.used) throw new Error("이미 사용된 QR코드입니다");
  // 서로 다른 회사 토큰 차단(직원이 다른 회사 QR을 본인 폰에서 띄워도 다른 회사 기사가 스캔 못 함).
  if (token.companyId && companyId && token.companyId !== companyId) {
    throw new Error("회사가 일치하지 않는 QR코드입니다");
  }

  const empNo = (token.empNo || "").toString().trim();
  const name = (token.name || "").toString().trim();
  if (!empNo) throw new Error("사번 정보가 없는 QR코드입니다");

  // partnerCode 는 토큰에 이미 포함(직원 발행 시 session.partnerCode 저장).
  // 비어있으면(레거시/구버전) passengers/{empNo}.partnerCode 폴백 — validateAndBoard 와 동일 패턴.
  let partnerCode = token.partnerCode || null;
  if (!partnerCode) {
    try {
      const passSnap = await getDoc(doc(db, "companies", companyId, "passengers", empNo));
      if (passSnap.exists()) partnerCode = passSnap.data().partnerCode || null;
    } catch (_) { /* 권한/네트워크 오류는 partnerCode 부재로 처리 — 탑승 기록 자체는 진행 */ }
  }

  // 차량 GPS 위치 캡처 — validateAndBoard 와 동일(통계 일관성).
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

  // 탑승 기록 저장 — 기존 boardings 스키마와 100% 동일.
  const boardingRef = collection(db, "companies", companyId, "boardings", dispatchDate, "list");
  await addDoc(boardingRef, {
    empNo,
    name,
    tokenId,
    companyId, routeId, routeName,
    vehicleId, vehicleNo, driverId,
    stopId: stopId || "",
    stopName: stopName || "",
    partnerCode,
    vehicleLat, vehicleLng, vehicleSpeed,
    boardedAt: serverTimestamp(),
  });

  // 토큰 소각(재사용 방지) — 기사 본인 식별자 기록.
  await setDoc(ref, {
    used: true,
    usedAt: serverTimestamp(),
    usedByDriverId: driverId || "",
  }, { merge: true });

  return { routeName, vehicleNo, dispatchDate, empNo, name };
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

// ─── 정적(고정) QR 탑승 (2026-07-08 RQ#3 유비칸 후속) ─────────
// GPS 단말 차량은 기사가 앱을 안 켜 매일 바뀌는 동적 QR(boardingTokens)을 못 만든다.
// 관리자가 차량에 붙일 고정 QR(만료/소각 없음·재사용)을 인쇄 → 직원이 스캔하면 탑승 기록.
// URL은 토큰(`?t=`) 대신 차량ID만 인코딩(`?c={companyId}&v={vehicleId}`) → BoardingApp 이
// "오늘 배차"로 routeId 를 해석한다. 유비칸 차량 보안 완화 수용(동적 QR 대체·회의 결정).
export function getStaticBoardingUrl({ companyId, vehicleId }) {
  const base = window.location.origin;
  return `${base}/board?c=${encodeURIComponent(companyId)}&v=${encodeURIComponent(vehicleId)}`;
}

// ─── 정적 QR 검증 + 탑승 기록 ────────────────────────────
// 만료/소각 없음(재사용 가능). 중복 방지 = 멱등(직원 1인 × 차량 × 당일 1건).
// boardings 스키마는 validateAndBoard 와 100% 동일(통계 화면 무영향) + via:"static" 만 추가.
export async function validateAndBoardStatic({ companyId, vehicleId, empNo, name }) {
  if (!empNo || !empNo.trim()) throw new Error("사번을 입력해주세요");

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());

  // 오늘 배차 해석 — 이 차량의 오늘 dispatch 로 routeId/routeName/driverId/vehicleNo 확보.
  // 배차 없으면 탑승 불가(어느 노선 탑승인지 결정 불가) — 관리자 문의 안내.
  const dispSnap = await getDocs(
    query(collection(db, "companies", companyId, "dispatches", today, "list"), where("vehicleId", "==", vehicleId))
  );
  if (dispSnap.empty) throw new Error("오늘 이 차량은 운행 배차가 없습니다\n관리자에게 문의하세요");

  const disp = dispSnap.docs[0].data();
  const routeId = disp.routeId || "";
  const routeName = disp.routeName || "";
  const driverId = disp.driverId || "";
  let vehicleNo = disp.vehicleNo || "";
  // 배차에 vehicleNo 없으면 vehicles/{vehicleId}.plateNo 폴백.
  if (!vehicleNo) {
    try {
      const vSnap = await getDoc(doc(db, "companies", companyId, "vehicles", vehicleId));
      if (vSnap.exists()) vehicleNo = vSnap.data().plateNo || "";
    } catch (_) { /* 권한/네트워크 오류 → vehicleNo 빈 문자열, 탑승 자체는 진행 */ }
  }

  // partnerCode 자동 채움 — validateAndBoard 와 동일 패턴(협력사별 통계용).
  let partnerCode = null;
  try {
    const passSnap = await getDoc(doc(db, "companies", companyId, "passengers", empNo.trim()));
    if (passSnap.exists()) partnerCode = passSnap.data().partnerCode || null;
  } catch (_) { /* 권한/네트워크 오류는 partnerCode 부재로 처리 — 탑승 기록 자체는 진행 */ }

  // 차량 GPS 위치 캡처 — validateAndBoard 와 동일 패턴(정류장 매핑용).
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

  // 멱등 boarding — 결정적 doc id(직원 1인 × 차량 × 당일 1건). 이미 있으면 첫 스캔 보존.
  const boardingRef = doc(db, "companies", companyId, "boardings", today, "list", `${empNo.trim()}__${vehicleId}`);
  const existing = await getDoc(boardingRef);
  if (existing.exists()) {
    return { routeName, vehicleNo, dispatchDate: today, alreadyBoarded: true };
  }

  await setDoc(boardingRef, {
    empNo: empNo.trim(),
    name: name?.trim() || "",
    tokenId: "",           // 정적 QR 은 토큰 없음(스키마 자리 유지)
    companyId, routeId, routeName,
    vehicleId, vehicleNo, driverId,
    stopId: "",
    stopName: "",
    partnerCode,
    vehicleLat, vehicleLng, vehicleSpeed,
    via: "static",         // 정적 QR 탑승 식별(통계 read 호환·옵셔널)
    boardedAt: serverTimestamp(),
  });

  return { routeName, vehicleNo, dispatchDate: today, alreadyBoarded: false };
}
