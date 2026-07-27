// 운행 강제 종료 — 2026-07-28 개선요청(배시현, cv4XzFYLUdUfzqBEuDQw).
//
// 기사가 "운행 종료" 를 누르지 못한 채(앱 종료·폰 꺼짐·차량 재배정·계정 삭제) 남은
// 운행 흔적을 관리자가 정리하는 통로. 판정은 `lib/runSignals.js`(순수), 쓰기는 여기.
//
// 지우는 것 2가지 — 기사앱 handleStop 과 **같은 필드·같은 값 계약**(새 필드 도입 금지):
//   ① `gps/{companyId}_{vehicleId}` 삭제  = clearGPS 와 동일(직원·승객앱 "운행중" 표시의 근거)
//   ② `drivers/{driverId}` → `status:"대기"`, `endedAt: new Date().toISOString()`
//
// 권한(rules 변경 0): `gps` write = isAuth() · `companies/{cid}/drivers` update = isAdmin(cid).
//
// ⚠ device(유비칸 단말) 차량은 `pollDeviceVehicleGps` 가 운행 시간대에 1분 내 신호를 다시
//   올린다 → 지워도 곧 재생성된다(무해하지만 호출부가 그 사실을 안내해야 한다).

import { db } from "../firebase";
import { doc, deleteDoc, getDoc, updateDoc } from "firebase/firestore";

/**
 * @param {Object} p
 * @param {string} p.companyId
 * @param {string} [p.vehicleId]  있으면 그 차량의 gps 문서 삭제
 * @param {string} [p.driverId]   있으면 그 기사 상태를 "대기" 로 되돌림
 * @returns {Promise<{gpsDeleted:boolean, driverReset:boolean}>}
 */
export async function forceEndRun({ companyId, vehicleId, driverId }) {
  if (!companyId) throw new Error("companyId 없음");
  let gpsDeleted = false;
  let driverReset = false;

  if (vehicleId) {
    const ref = doc(db, "gps", `${companyId}_${vehicleId}`);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      await deleteDoc(ref);
      gpsDeleted = true;
    }
  }

  if (driverId) {
    await updateDoc(doc(db, "companies", companyId, "drivers", driverId), {
      status: "대기",
      endedAt: new Date().toISOString(),
    });
    driverReset = true;
  }

  return { gpsDeleted, driverReset };
}
