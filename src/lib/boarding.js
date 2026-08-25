import { db } from "../firebase";
import {
  doc, setDoc, getDoc, addDoc, collection, serverTimestamp, Timestamp
} from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";

const functions = getFunctions(undefined, "us-central1");

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

// ─── NFC 사원증 탑승 (2026-07-22) ─────────────────────────
// 기사앱(Android Chrome)이 NDEFReader 로 읽은 카드 serial 을 서버에 넘겨 판정받는다.
// 카드→탑승자 조회·미등록 기록(nfcRejects)·멱등 boarding 은 전부 CF boardNfc(Admin SDK).
// 클라가 직접 못 하는 이유는 functions/index.js boardNfc 주석 참조(룰·정보노출·정규화).
//
// ⚠ **미등록 카드는 throw 가 아니라 `registered:false` 로 돌아온다** — 기사 화면이
//   빨간 "미등록" UI 를 그려야 하고, throw 로 만들면 네트워크 오류와 구분이 안 된다.
//   호출부는 반드시 `res.registered` 를 분기할 것(try/catch 만으론 미등록을 못 잡는다).
export async function boardByNfc({ companyId, vehicleId, uid, selectedRouteId }) {
  const { data } = await httpsCallable(functions, "boardNfc")({
    companyId, vehicleId, uid, selectedRouteId: selectedRouteId || null,
  });
  return data; // { ok, registered, empNo?, name?, alreadyBoarded?, uid?, routeName, vehicleNo, dispatchDate, todayCount }
}

// ─── NFC 카드 등록 대행 (2026-07-22) ──────────────────────
// 기존 사원증을 재사용하는 현장에는 UID 목록이 없다 → 기사 폰(Android)이 카드를 읽어
// 승객에게 매핑한다. 중복 카드 검사·정규화는 서버(CF registerNfcCard)가 강제.
// 다른 사람에게 등록된 카드면 `already-exists` 로 throw(조용히 뺏지 않음).
// partnerCode: 협력사 포털(익명 인증·role 없음)에서 호출할 때 필수 — 서버가 업체코드를
// 검증하고 **그 거래처 소속 승객인지**까지 확인한다. 기사·관리자는 role 로 통과(미전달 가능).
export async function registerNfcCard({ companyId, empNo, uid, partnerCode }) {
  const { data } = await httpsCallable(functions, "registerNfcCard")({
    companyId, empNo, uid, partnerCode: partnerCode || null,
  });
  return data; // { ok, empNo, name, replaced }
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

// 슬리핑 차일드 — 맨 뒷좌석 확인 QR 주소(2026-08-18).
// 🔴 탑승 QR(`/board`) 과 **반드시 다른 경로**다 — 같은 주소로 두면 승객이 뒷좌석 QR 을
//    찍었을 때 탑승이 적재되고, 기사가 탑승 QR 을 찍으면 확인이 안 된다.
export function getSleepCheckUrl({ companyId, vehicleId }) {
  const base = window.location.origin;
  return `${base}/sleep?c=${encodeURIComponent(companyId)}&v=${encodeURIComponent(vehicleId)}`;
}

// ─── 정적 QR — 오늘 배차 해석 ────────────────────────────
// 차량ID만 있는 고정 QR 은 "오늘 이 차량이 어느 노선을 뛰는가"를 배차에서 읽어야 한다.
// 탑승 기록(validateAndBoardStatic) 과 스캔 직후 확인 화면(직원앱 ScanTab) 이 함께 쓴다.
// 배차 없으면 throw — 어느 노선 탑승인지 결정 불가.
// selectedRouteId(옵션): 승객이 앱에서 선택한 노선 — 있으면 서버가 그 노선 배차만 매칭,
// 불일치 시 차단(오탑승 방지, 2026-07-16 회의 #1). 없으면 기존 동작(전체 배차 해석).
export async function resolveStaticDispatch({ companyId, vehicleId, selectedRouteId }) {
  // 배차 읽기 규칙은 admin/driver 잠금 → 익명 진입점은 쿼리 거부됨.
  // CF resolveStaticBoarding(Admin SDK)이 서버에서 배차 해석(반환 shape 동일).
  const { data } = await httpsCallable(functions, "resolveStaticBoarding")({ companyId, vehicleId, selectedRouteId: selectedRouteId || null });
  return data; // { today, routeId, routeName, driverId, vehicleNo }
}

// ─── 정적 QR 검증 + 탑승 기록 ────────────────────────────
// 만료/소각 없음(재사용 가능). 중복 방지 = 멱등(직원 1인 × 차량 × 당일 1건).
// boardings 스키마는 validateAndBoard 와 100% 동일(통계 화면 무영향) + via:"static" 만 추가.
// 본인 확인(2026-08-25 P2): 서버가 **로그인 토큰의 사번**으로 적재한다 — 여기서 보내는
//   `empNo` 는 토큰이 있으면 무시된다(위조 방지). 그래서 이 함수를 부르기 전에 반드시
//   승객 로그인(`lib/passengerAuth`)이 끝나 있어야 한다. 예전엔 클라가 만든 `pinHash` 를
//   증거로 보냈는데, 그 값은 명부에서 누구나 읽을 수 있어 증거가 못 됐다.
export async function validateAndBoardStatic({ companyId, vehicleId, empNo, name, selectedRouteId }) {
  if (!empNo || !empNo.trim()) throw new Error("사번을 입력해주세요"); // 빠른 UX 가드(클라)

  // 배차 재해석·partnerCode/GPS 캡처·멱등 boarding 생성은 서버(CF boardStatic·Admin SDK)에 위임.
  // 익명 진입점이 배차 읽기 규칙(admin/driver 잠금)에서 거부되던 문제 회피. 반환 계약 보존.
  // selectedRouteId 있으면 서버가 선택 노선 배차만 매칭(불일치=차단·적재 노선=선택 노선).
  const { data } = await httpsCallable(functions, "boardStatic")({
    companyId, vehicleId, empNo: empNo.trim(), name: name || "", selectedRouteId: selectedRouteId || null,
  });
  return {
    routeName: data.routeName,
    vehicleNo: data.vehicleNo,
    dispatchDate: data.dispatchDate,
    alreadyBoarded: !!data.alreadyBoarded,
  };
}
