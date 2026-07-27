// 잔존 운행 신호 판정(순수 · Firebase import 0) — 2026-07-28 개선요청(배시현, cv4XzFYLUdUfzqBEuDQw).
//
// 신고: "기기 로그아웃 후에도 계속 운행 중으로 보인다. 강제 로그아웃 기능을 만들어달라."
//
// prod 실측으로 확인된 잔존 상태는 **두 방향**이고, 둘 다 스스로 사라지지 않는다:
//   ① 잔존 신호(stale gps 문서) — `gps/{cid}_{vid}` 가 남아 직원·승객앱 노선 탭이
//      "🟢 N대 운행중" 을 계속 표시. 실측 예: 마지막 신호 309시간 전인데 표시 유지.
//      ⚠ 그중엔 **고아 신호**(그 차량을 배정받은 기사가 지금 없음 — 기사 삭제·차량 재배정)
//      도 있어서, 어떤 기사가 로그아웃해도 절대 지워지지 않는다.
//   ② 잔존 상태(stranded driver) — `drivers/{id}.status="운행중"` 인데 신선한 gps 없음.
//      실측 예: startedAt 2026-07-10 · endedAt 없음(18일째).
//
// 왜 자동으로 안 없어지나: mobile 차량의 gps 문서를 지우는 곳은 기사앱 "운행 종료"
// (`clearGPS`) 하나뿐이다. 앱이 죽거나·폰이 꺼지거나·차량이 재배정되면 그 경로를 못 탄다.
// device(유비칸 단말) 차량은 `pollDeviceVehicleGps` 의 cleanupDeviceGpsDoc 이 정리하지만
// **source==="device" 만** 삭제한다(mobile 보호가 회귀 가드) → mobile 은 청소 주체가 없음.
//
// 이 모듈은 "무엇이 잔존인가"만 판정한다(표시·삭제는 호출부). 순수 함수 = 격리 node 테스트 대상.
//   테스트: node scripts/test_run_signals.cjs

import { gpsAgeMs, RUN_GPS_FRESH_MS } from "./runStatus";

// 잔존 후보 임계(분). 60초(GPS 신선도)보다 훨씬 보수적으로 잡는다 —
// 신호등·터널·건물 그늘로 수십 초~수 분 끊기는 것은 정상 운행이고,
// 실제 운행 중 GPS 가 65분 통째로 비었던 사례도 있다(2026-06-26 진단).
// 그래서 "10분 넘음"은 잔존 **후보**일 뿐이고, 지울지는 경과시간을 보고 사람이 정한다.
export const STALE_SIGNAL_MIN = 10;

/** gps 문서 updatedAt 이 임계(분)를 넘겨 잔존 후보인가. null/pending = 방금 = 아님. */
export function isSignalStale(updatedAt, now = Date.now(), minutes = STALE_SIGNAL_MIN) {
  return gpsAgeMs(updatedAt, now) >= minutes * 60 * 1000;
}

/** 경과 ms → "13일 전"/"3시간 전"/"25분 전" (확인 카드에 그대로 노출 — 운영자 판단 근거). */
export function formatSignalAge(ms) {
  if (!(ms > 0)) return "방금";
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}시간 전`;
  return `${Math.floor(hr / 24)}일 전`;
}

/**
 * 잔존 운행 신호·잔존 운행 상태 분류.
 *
 * @param {Object} p
 * @param {Array}  p.gpsDocs  gps 문서 배열(`{id, vehicleId, source, routeId, routeName, driverName, updatedAt}`)
 * @param {Array}  p.drivers  기사 배열(`{id, name, status, vehicleId, vehicleNo, startedAt}`)
 * @param {number} [p.now]
 * @param {number} [p.staleMinutes]
 * @returns {{staleSignals: Array, strandedDrivers: Array}}
 *   staleSignals    — 지워야 할 후보 신호(오래된 순). `orphan:true` = 배정 기사 없음.
 *   strandedDrivers — status 만 "운행중" 으로 남은 기사(신선 gps 없음).
 */
export function classifyRunSignals({ gpsDocs = [], drivers = [], now = Date.now(), staleMinutes = STALE_SIGNAL_MIN } = {}) {
  // vehicleId → 그 차량을 현재 배정받은 기사(강제 종료 시 상태를 되돌릴 대상).
  const driverByVehicle = new Map();
  for (const d of drivers) {
    if (d && d.vehicleId && !driverByVehicle.has(d.vehicleId)) driverByVehicle.set(d.vehicleId, d);
  }

  const staleSignals = gpsDocs
    .filter((g) => g && isSignalStale(g.updatedAt, now, staleMinutes))
    .map((g) => {
      const owner = g.vehicleId ? driverByVehicle.get(g.vehicleId) : null;
      const ageMs = gpsAgeMs(g.updatedAt, now);
      return {
        id: g.id,
        vehicleId: g.vehicleId || "",
        source: g.source || "mobile",
        routeId: g.routeId || "",
        routeName: g.routeName || "",
        driverName: g.driverName || "",
        vehicleNo: owner?.vehicleNo || g.vehicleNo || "",
        ageMs,
        ageLabel: formatSignalAge(ageMs),
        ownerDriverId: owner ? owner.id : null,
        ownerDriverName: owner ? owner.name : null,
        orphan: !owner,
      };
    })
    .sort((a, b) => b.ageMs - a.ageMs); // 오래된 것 먼저

  // 신선한 신호를 내고 있는 차량 = 실제 운행 중.
  const liveVehicleIds = new Set(
    gpsDocs.filter((g) => g && gpsAgeMs(g.updatedAt, now) < RUN_GPS_FRESH_MS).map((g) => g.vehicleId).filter(Boolean)
  );
  const gpsDocVehicleIds = new Set(gpsDocs.map((g) => g && g.vehicleId).filter(Boolean));

  const strandedDrivers = drivers
    .filter((d) => d && d.status === "운행중" && !liveVehicleIds.has(d.vehicleId))
    .map((d) => ({
      id: d.id,
      name: d.name || "",
      vehicleId: d.vehicleId || "",
      vehicleNo: d.vehicleNo || "",
      startedAt: d.startedAt || null,
      hasGpsDoc: !!(d.vehicleId && gpsDocVehicleIds.has(d.vehicleId)),
    }));

  return { staleSignals, strandedDrivers };
}
