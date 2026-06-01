import { db } from "../firebase";
import { doc, setDoc, addDoc, deleteDoc, collection, serverTimestamp } from "firebase/firestore";
import { projectToPolyline, buildCumulativeLengths } from "./routeProgress";

const MIN_DISTANCE_M = 5;
const MIN_INTERVAL_MS = 3000;
const HEARTBEAT_MS = 15000; // 정차·미세이동이어도 이 주기마다 강제 1회 전송 (실시간 리스너 갱신 보장)
const STOP_ARRIVE_M = 100; // 100m 이내 = 정류장 도착
// 통신장애 복구 백필 마진: 버스 진행률이 정류장 진행률 + 이 거리(m)를 넘었는데
// 아직 visitedStops에 없으면 GPS 끊김 중 통과한 것으로 판정.
const PASS_MARGIN_M = 40;

// ── GPS 측위 옵션 (콜드스타트 출발지 미수신 수정, 2026-05-18) ──
// 초기 1회 fix: 정밀도보다 "즉시 한 점"이 목적 — 캐시 허용·짧은 타임아웃으로 출발 직후 공백 제거.
const INITIAL_FIX_OPTS = { enableHighAccuracy: false, maximumAge: 30000, timeout: 8000 };
// watch: 콜드스타트 첫 측위가 10초를 넘겨 TIMEOUT으로 묻히던 문제 → 타임아웃 30s·캐시 10s 완화.
const WATCH_OPTS = { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 };

// watchId → cleanup 매핑 (watchId는 number라 속성 부착 불가 → 모듈 레지스트리 사용)
const cleanupRegistry = new Map();
// watchId → 마지막 GPS 좌표 캡쳐(triggerHeartbeat 용 — 통신 복구 시 즉시 1회 sendGPS 트리거).
// startGPS 컨텍스트(companyId/vehicleId 등)와 마지막 좌표를 함께 보관 — 외부 호출자가
// 정보 미입력으로 sendGPS 호출하지 않도록 캡슐화.
const heartbeatRegistry = new Map();

function getDistance(p1, p2) {
  const R = 6371000;
  const dLat = (p2.lat - p1.lat) * Math.PI / 180;
  const dLng = (p2.lng - p1.lng) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(p1.lat*Math.PI/180) * Math.cos(p2.lat*Math.PI/180) *
    Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// 정류장 좌표 lat·lng 정규화 — Firestore 저장 형식 다양성(number / string "37.5" /
// GeoPoint{latitude,longitude} / {location:{latitude,longitude}}) 흡수. 엄격한
// `typeof === "number"` 비교가 string·GeoPoint 좌표를 전부 탈락시켜 도착 감지·진행률
// 백필이 통째로 비활성화되던 결함 차단(2026-06-02, issues.md 등록 함정의 감지층 적용).
// 유효 시 { lat, lng }(number), 아니면 null.
function toLatLng(s) {
  if (!s) return null;
  const rawLat = s.lat ?? s.latitude ?? s.location?.latitude ?? s._latitude;
  const rawLng = s.lng ?? s.longitude ?? s.location?.longitude ?? s._longitude;
  const lat = Number(rawLat), lng = Number(rawLng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
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
// onGpsError(있을 때만 호출, 하위호환): 측위 실패를 상위(DriverApp)로 전파해 화면 안내.
// routePath(옵션, [{lat,lng}]): 노선 사전경로. 유효(길이≥2)하면 GPS 신호 복구 시
//   진행률 기반 백필로 통신장애 중 통과한 정류장을 회복. 없으면 100m 직접 감지만(폴백).
export function startGPS({ companyId, vehicleId, vehicleNo, driverId, driverName, routeId, routeName, stops = [], routePath = [], onStopReached, onGpsError }) {
  // 상태 격리: 모듈 전역이 아닌 startGPS 클로저 지역 변수 (다중 watch·해제 시 누수 방지)
  let lastPos = null;
  let lastSentTime = 0;
  let trailingTimer = null; // 스로틀로 버려진 마지막 좌표의 지연 전송 타이머
  let watchRestarted = false; // TIMEOUT 시 watch 1회 재시작 가드 (재시작 무한루프 방지)
  const visitedStops = new Set(); // 이미 도착 처리된 정류장 ID

  // ── 통신장애 정류장 누락 백필 준비 (2026-05-22) ──────────────────────────
  // 문제: watchPosition 콜백이 GPS 끊김(터널·약전계)으로 끊기면 버스가 정류장
  //   100m 반경을 통과하는 순간 콜백이 없어 visitedStops에 영구 미등록 → currentStopIdx
  //   가 옛 정류장에 멈춤. 100m 직접 감지만으로는 복구 불가.
  // 해법: routePath 유효 시 버스/정류장을 폴리라인에 투영해 진행률(progress)을 비교.
  //   GPS 복구 후 buthProgress가 어떤 정류장 progress + PASS_MARGIN_M을 넘었는데
  //   visitedStops에 없으면 = 통과 누락 → order 낮은 것부터 순차 onStopReached 호출.
  const usePath = Array.isArray(routePath) && routePath.length >= 2;
  const pathCum = usePath ? buildCumulativeLengths(routePath) : null;
  // 각 정류장 progress 사전 산출 1회 캐시(반복 투영 비용 절감).
  const stopProg = usePath
    ? stops.map(s => {
        const ll = toLatLng(s);
        if (!ll) return null;
        const proj = projectToPolyline(ll, routePath, pathCum);
        return proj ? proj.progress : null;
      })
    : null;

  // 실제 전송 + 상태 갱신 공통 처리
  const flush = async (pos) => {
    // 역행/중복 가드: 초기 fix가 watch 첫 콜백보다 늦게 도착해도 더 최신(lastSentTime)이면 무시
    if (lastSentTime && pos._ts && pos._ts < lastSentTime) return;
    lastPos = { lat: pos.lat, lng: pos.lng, speed: pos.speed, accuracy: pos.accuracy };
    lastSentTime = Date.now();
    await sendGPS({ companyId, vehicleId, vehicleNo, driverId, driverName, routeId, routeName, lat: pos.lat, lng: pos.lng, speed: pos.speed, accuracy: pos.accuracy });
  };

  // ── triggerHeartbeat 캡슐 — 외부(useOnlineRecover 복구 콜백)가 호출 시 마지막
  //    좌표를 즉시 1회 sendGPS로 발송. 통신 복구 후 watch 자체는 살아있어도
  //    Firestore가 마커를 신선화하기까지 지연 가능 → 즉시 1회 강제 갱신.
  const triggerHeartbeatFn = () => {
    if (!lastPos) return false;
    sendGPS({
      companyId, vehicleId, vehicleNo, driverId, driverName, routeId, routeName,
      lat: lastPos.lat, lng: lastPos.lng,
      speed: lastPos.speed, accuracy: lastPos.accuracy,
    }).catch((e) => console.warn("[BusLink] heartbeat 전송 실패:", e.message));
    lastSentTime = Date.now();
    return true;
  };

  // 정류장 도착 감지 — 콜백마다 호출. 두 경로:
  //   ① 100m 직접 감지(STOP_ARRIVE_M) — 기존 동작 유지(정밀 케이스).
  //   ② routePath 진행률 백필 — GPS 끊김 중 100m 반경을 못 잡고 통과한 정류장을
  //      복구 후 회복(통신장애 정류장 누락 해결). order 낮은 것부터 순차 호출.
  // onStopReached가 한 콜백에서 여러 번·순차 호출될 수 있음 — 호출측(DriverApp)이 멱등.
  const detectStops = (curr) => {
    if (stops.length === 0 || !onStopReached) return;

    // ① 100m 직접 감지 (기존 로직 — 폴백·정밀 케이스). viaBackfill=false.
    stops.forEach(stop => {
      if (visitedStops.has(stop.id)) return;
      const ll = toLatLng(stop);
      if (!ll) return;
      const dist = getDistance(curr, ll);
      if (dist <= STOP_ARRIVE_M) {
        visitedStops.add(stop.id);
        onStopReached(stop, Math.round(dist), false);
      }
    });

    // ② routePath 진행률 백필 — usePath 유효할 때만(미설정이면 skip = 회귀 0).
    if (usePath && stopProg) {
      const proj = projectToPolyline(curr, routePath, pathCum);
      if (proj) {
        const busProgress = proj.progress;
        // order(=배열) 낮은 정류장부터 순차 — currentStopIdx 역행 방지.
        for (let i = 0; i < stops.length; i++) {
          const stop = stops[i];
          if (visitedStops.has(stop.id)) continue;
          const sp = stopProg[i];
          if (sp == null) continue;
          if (busProgress > sp + PASS_MARGIN_M) {
            visitedStops.add(stop.id);
            // 추정 거리 = 현재 좌표 → 정류장 직선거리(통과 누락분이라 정확한 통과
            // 시각·거리는 추정 불가 — 진단/알림용 근사값). viaBackfill=true.
            const ll = toLatLng(stop);
            const approxDist = ll ? Math.round(getDistance(curr, ll)) : 0;
            onStopReached(stop, approxDist, true);
          }
        }
      }
    }
  };

  // 콜드스타트 첫 측위가 watch 첫 콜백(최대 30초)보다 늦으면 출발 직후 공백 발생 →
  // 즉시 1회 getCurrentPosition으로 첫 좌표를 빠르게 발행(중복은 flush 역행가드가 차단).
  navigator.geolocation.getCurrentPosition(
    (position) => {
      flush({
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        speed: Math.round((position.coords.speed || 0) * 3.6),
        accuracy: Math.round(position.coords.accuracy),
        _ts: position.timestamp || Date.now(),
      }).catch((e) => console.error("[BusLink] 초기 GPS 전송 오류:", e));
    },
    (err) => {
      // 초기 fix 실패는 watch가 이어받음 — 권한 거부만 상위 전파(즉시 안내)
      console.warn("[BusLink] 초기 GPS 측위 실패:", err.message);
      if (err.code === 1 && onGpsError) onGpsError(err);
    },
    INITIAL_FIX_OPTS
  );

  const watchId = navigator.geolocation.watchPosition(
    async (position) => {
      const now = Date.now();
      const curr = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        speed: Math.round((position.coords.speed || 0) * 3.6),
        accuracy: Math.round(position.coords.accuracy),
        _ts: position.timestamp || now,
      };

      // 정류장 근접 감지 (GPS 필터링 전에 먼저 체크 — 기존 동작 유지)
      // 100m 직접 감지 + routePath 진행률 백필(통신장애 누락 복구).
      detectStops(curr);

      const moved = !lastPos || getDistance(lastPos, curr) >= MIN_DISTANCE_M;
      const intervalOk = now - lastSentTime >= MIN_INTERVAL_MS;
      const heartbeat = now - lastSentTime >= HEARTBEAT_MS;

      // 전송 조건: (이동거리 충족 AND 간격 충족) OR 하트비트 경과
      // → 정차·미세이동이어도 HEARTBEAT_MS마다 강제 1회 전송해 updatedAt 주기 갱신
      if ((moved && intervalOk) || heartbeat) {
        if (trailingTimer) { clearTimeout(trailingTimer); trailingTimer = null; }
        await flush(curr);
        return;
      }

      // 스로틀(간격 미달 등)로 버려진 좌표: 마지막 좌표를 MIN_INTERVAL_MS 후 1회 전송 예약.
      // 새 좌표가 정상 전송되면 위에서 clearTimeout으로 취소(중복 전송 방지).
      // 정차 직후 마지막 위치가 영구 누락되는 것을 방지.
      if (trailingTimer) clearTimeout(trailingTimer);
      trailingTimer = setTimeout(() => {
        trailingTimer = null;
        flush(curr).catch((e) => console.error("GPS 오류:", e));
      }, MIN_INTERVAL_MS);
    },
    (err) => {
      // err.code: 1=PERMISSION_DENIED, 2=POSITION_UNAVAILABLE, 3=TIMEOUT
      if (err.code === 3) {
        // 콜드스타트/약전계 TIMEOUT — watch는 계속 시도하므로 조용히 로깅.
        // 단, watch가 죽었을 가능성 대비 1회만 재시작 가드(무한루프 방지).
        console.warn("[BusLink] GPS 측위 시간초과 — 재시도 중");
        if (!watchRestarted) {
          watchRestarted = true;
          try {
            navigator.geolocation.clearWatch(watchId);
            const rid = navigator.geolocation.watchPosition(
              (p) => {
                const rc = {
                  lat: p.coords.latitude, lng: p.coords.longitude,
                  speed: Math.round((p.coords.speed || 0) * 3.6),
                  accuracy: Math.round(p.coords.accuracy),
                  _ts: p.timestamp || Date.now(),
                };
                // GPS 복구 직후 — 통신장애 중 통과한 정류장 백필이 가장 필요한 시점.
                detectStops(rc);
                flush(rc).catch((e) => console.error("[BusLink] GPS 전송 오류:", e));
              },
              (e) => console.warn("[BusLink] GPS 재시작 후 오류:", e.message),
              WATCH_OPTS
            );
            // 재시작된 watch의 cleanup도 동일 트레일링 타이머를 정리하도록 재등록
            cleanupRegistry.set(rid, () => {
              if (trailingTimer) { clearTimeout(trailingTimer); trailingTimer = null; }
            });
          } catch (e) {
            console.warn("[BusLink] GPS watch 재시작 실패:", e.message);
          }
        }
        if (onGpsError) onGpsError(err);
        return;
      }
      console.error("[BusLink] GPS 오류:", err);
      if (onGpsError) onGpsError(err); // PERMISSION_DENIED 등 상위 전파
    },
    WATCH_OPTS
  );

  // stopGPS가 trailing 타이머까지 정리할 수 있도록 watchId→cleanup 등록
  cleanupRegistry.set(watchId, () => {
    if (trailingTimer) { clearTimeout(trailingTimer); trailingTimer = null; }
  });
  // 마지막 좌표 캡쳐 트리거 등록 — 통신 복구 시 즉시 1회 sendGPS 강제.
  heartbeatRegistry.set(watchId, triggerHeartbeatFn);
  return watchId;
}

export function stopGPS(watchId) {
  const cleanup = cleanupRegistry.get(watchId);
  if (cleanup) { cleanup(); cleanupRegistry.delete(watchId); }
  heartbeatRegistry.delete(watchId);
  navigator.geolocation.clearWatch(watchId);
}

// 통신 복구 시 호출 — 마지막 GPS 좌표로 즉시 1회 sendGPS 트리거. 호출자(useOnlineRecover)는
// online 전이 감지 후 driving=true인 watchId를 넘김. lastPos 없으면 noop·false 반환.
export function triggerHeartbeat(watchId) {
  const fn = heartbeatRegistry.get(watchId);
  if (typeof fn === "function") return fn();
  return false;
}
