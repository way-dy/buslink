import { useState, useEffect, useRef } from "react";
import { auth, db } from "../firebase";
import { signOut } from "firebase/auth";
import { collection, query, where, getDocs, doc, updateDoc, getDoc, onSnapshot, orderBy } from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import { startGPS, stopGPS, clearGPS, triggerHeartbeat } from "../lib/gps";
import { planTimeForStop, computeStopEstimates, formatDelayLabel } from "../lib/stopSchedule";
import { buildCumulativeLengths, projectToPolyline } from "../lib/routeProgress";
import { buildRunId, recordEtaDiagnostic, throttleGate } from "../lib/etaDiag";
import { ensureGeolocationPermission } from "../lib/usePermissions";
import { useOnlineRecover } from "../lib/useOnlineRecover";
import { createBoardingToken, getBoardingUrl, validateAndBoardByDriver } from "../lib/boarding";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { BusLinkLogo, Pill, StatusDot, Icon } from "../components/ui";
import InstallPrompt from "../components/InstallPrompt";
import { applyAppManifest } from "../lib/pwaManifest";
import PermissionGate from "../components/PermissionGate";
import { resolveByHostname } from "../lib/companyResolver";

// 2026-06-01 — stopArrivals 기록 위임 채널(CF `recordStopArrival`).
// 클라이언트 직접 updateDoc 이 silent fail(rules 매핑·drivers.uid 누락 등) 하던 결함
// 차단 — Admin SDK 가 rules 우회. region 명시(PartnerApp 패턴 일관).
const functions = getFunctions(undefined, "us-central1");

// 빌드 식별자 — 진단 JSON 의 appVersion 으로 회수돼 "어느 번들이 실제 폰에서
// 돌았는지" 확정(설치형 PWA 가 옛 캐시를 돌리는 경우 vs 코드 결함 구분). 배포마다 갱신.
const DRIVER_BUILD = "2026-06-02-detect-v2";

// 리디자인 2단계(2026-05-16): 라이트 테마 리스킨.
// ── 로직 100% 불변: state/effect·init(driver/dispatch/stops 로드)·loadDispatch
//    ·loadStops·Wake Lock·Notification·handleStart/handleStop/refreshToken
//    ·startGPS/stopGPS/clearGPS·createBoardingToken/getBoardingUrl·QRCode.toDataURL
//    ·setInterval 5분 토큰 갱신·signOut·companyId(propCompanyId||"dy001")
//    ·activeTab("운행"|"탑승 QR")·currentStopIdx·App.js 분기 전부 그대로.
//    마크업/스타일(S 객체)만 다크 하드코딩 → tokens.css 변수·components/ui 로 교체.
// ── 목업 design/src/screens-mobile.jsx DriverApp 의 "시각 언어"만 차용:
//    헤더→인사→#0066FF→#003DCC 그라데이션 히어로 배차카드(다음정류장 진행바)
//    →MiniStat 3→QR/탭 버튼→정류장 리스트→하단 검정 운행종료.
//    목업의 가짜 수치(속도 42·GPS ±4m·탑승 38/45·가짜 시간·회차)는 도입 금지 —
//    실제 dispatch/stops/currentStopIdx 데이터만 리스킨.
export default function DriverApp({ companyId: propCompanyId }) {
  const [driver, setDriver] = useState(null);
  // 다중 배차 지원: 같은 기사·날짜에 dispatch 여러 건 가능 → 칩으로 선택.
  // 기존 `dispatch` 단일 참조는 derived 값으로 호환(아래 derived dispatch).
  const [dispatches, setDispatches] = useState([]);
  const [activeDispatchId, setActiveDispatchId] = useState(null);
  const dispatch = dispatches.find(d => d.id === activeDispatchId) || null;
  // 배차 선택 모달 (EmployeeApp routePicker 패턴) — 가로 칩을 모달로 교체.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dispatchQuery, setDispatchQuery] = useState("");
  const filteredDispatches = dispatches.filter(d => {
    const q = dispatchQuery.trim().toLowerCase();
    if (!q) return true;
    return (d.routeName || "").toLowerCase().includes(q)
      || (d.vehicleNo || "").toLowerCase().includes(q)
      || (d.departTime || "").includes(q)
      || (d.partnerName || "").toLowerCase().includes(q);
  });
  const [stops, setStops] = useState([]);
  const [routePath, setRoutePath] = useState([]); // 노선 사전경로 — GPS 복구 백필·estimates 구간전파용
  // 노선 데이터(stops+routePath) 로드 완료 플래그(2026-06-02). startGPS 는 호출 시점의
  // stops/routePath 를 1회 캡처 → 로드 전 "운행 시작"을 누르면 빈 routePath 가 캡처돼
  // 도착 진행률 백필이 세션 내내 비활성화(고속 주행 시 100m 직접 감지만으론 정류장
  // 통과를 놓침 → 도착시간 0건). 로드 완료 전 운행 시작 버튼을 막아 경합 차단.
  const [routeDataReady, setRouteDataReady] = useState(false);
  const [currentStopIdx, setCurrentStopIdx] = useState(-1);
  // [DIAG-ETA 제거예정] 진단 오버레이 토글 (운행 중일 때만 노출, 기본 닫힘)
  // 사용자가 폰 실측 시 정류장별 ETA·source·delay를 직접 캡쳐하기 위한 임시 카드.
  // 다음 커밋에 grep "[DIAG-ETA" 1줄로 통째 제거.
  const [diagOpen, setDiagOpen] = useState(false);
  // [/DIAG-ETA]
  const [boardingToken, setBoardingToken] = useState(null);   // 현재 탑승 토큰
  const [qrUrl, setQrUrl] = useState(null);        // 탑승 링크 URL
  const [qrDataUrl, setQrDataUrl] = useState(null); // canvas → base64 이미지
  const [activeTab, setActiveTab] = useState("운행");          // "운행" | "QR"
  const tokenTimerRef = useRef(null);
  // 협력사 boardingMode (2026-05-27, 역방향 QR) — 'driver-qr'(기본·null도 동치) | 'passenger-qr'
  // dispatch.routeId → routes/{id}.partnerCode → partnerCodes/{code}.boardingMode 체인.
  // 미설정·null·조회 실패 = 'driver-qr' (기본·회귀 0).
  const [boardingMode, setBoardingMode] = useState("driver-qr");
  const [nextStopDist, setNextStopDist] = useState(null);
  const [driving, setDriving] = useState(false);
  const [watchId, setWatchId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Phase 1.1 (2026-05-28): App.js propCompanyId 우선, 없으면 hostname 매핑, 최종 dy001.
  // /driver 직접 진입(Auth users 문서 미존재) 시에도 hostname 으로 자기 회사 자동 결정.
  const [companyId, setCompanyId] = useState(
    propCompanyId || resolveByHostname(window.location.hostname) || "dy001"
  );
  const [gpsStatus, setGpsStatus] = useState("");   // GPS 신호 안내 ("" | "확보중" | "권한")
  const wakeLockRef = useRef(null);
  const currentStopRowRef = useRef(null);
  // ETA 자동 진단 로깅(2026-05-29) — 운행 1회 단위 runId. 운행 시작 시 산출, 종료 시 null.
  // 30초 interval + stopArrivals 변경 시 즉시 1건 기록 → etaDiagnostics/{date}/runs/{runId}/points.
  const [runId, setRunId] = useState(null);
  // 마지막 차량 GPS 좌표(diagnostic 기록용) — gps/{companyId}_{vehicleId} 본인 발신값 1회 getDoc.
  const lastVehiclePosRef = useRef(null);
  const lastVehicleSpeedRef = useRef(null);
  // 2026-06-01 — stopArrivals 기록 결과 로그(진단 첨부용, 최근 20건만 유지).
  // 각 entry = { stopId, ok, alreadyExists?, error?, code?, viaBackfill, ts }
  // 다음 진단 JSON(recordEtaDiagnostic) 에 stopArrivalsLog 로 첨부 → 어느 정류장이
  // 어떻게 기록됐는지(권한 거부·not-found·alreadyExists 등) 추적 가능.
  const stopArrivalsLogRef = useRef([]);
  // ref 로 최신 노선데이터 노출(2026-06-02) — startGPS 는 호출 시점의 stops/routePath 를
  // 1회 캡처하는데, 비동기 로드 전이면 빈값에 갇혀 도착 백필이 세션 내내 비활성(2일 연속
  // 도착 0건의 근인). gps.js 가 매 감지 시 ref.current(최신 state)를 읽도록 getter 주입 →
  // 로드 타이밍·버튼 게이트 경합과 무관하게 백필 작동. 렌더마다 최신값 동기화.
  const stopsRef = useRef([]);
  const routePathRef = useRef([]);
  stopsRef.current = stops;
  routePathRef.current = Array.isArray(routePath) ? routePath : [];
  // 오프라인→온라인 복구 시 onSnapshot 재구독 + Firestore reconnect 강제(2026-05-28).
  // 통신 안 좋다가 좋아져도 기사앱이 자동 활성화 안 되던 결함 차단 — DriverApp은 GPS 발신측
  // 이라 useWakeTick 적용 안 했었으나, 장시간 오프라인 후 stale 리스너 가능성 확인되어
  // useOnlineRecover로 보강. forceFirestoreReconnect=true 로 disableNetwork→enableNetwork
  // 1회 강제(reconnect 지연 우회).
  const recoverTick = useOnlineRecover({ forceFirestoreReconnect: true });

  // 현재 정류장 변경 시 리스트에서 자동 스크롤(중앙 정렬) — 운행 시작 전/리스트 없음/이미 보임 케이스는 skip
  useEffect(() => {
    if (currentStopIdx < 0) return;
    const el = currentStopRowRef.current;
    if (!el || typeof el.scrollIntoView !== "function") return;
    // 약간의 지연 — 카드 배경 전환 직후 위치 안정 후 스크롤
    const t = setTimeout(() => {
      try { el.scrollIntoView({ behavior: "smooth", block: "center" }); } catch { /* 일부 구형 브라우저 무해 */ }
    }, 80);
    return () => clearTimeout(t);
  }, [currentStopIdx]);

  // 알림 권한 요청
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  // 설치형 앱(PWA) 조건용 SW 등록 1회 — 브라우저가 URL+scope 로 dedupe.
  // DriverApp 은 FCM 미사용이나 설치 가능 조건 충족 위해 등록만 추가. 실패 무해 처리.
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/firebase-messaging-sw.js")
        .catch(() => {});
    }
  }, []);

  // 앱별 PWA 설치 아이콘(기사앱) — DriverApp 은 / 에서 Auth 역할 분기로 마운트되므로
  // 정적 path-scope 불가 → 마운트 시점에 manifest/apple-touch/제목 교체. 1회.
  useEffect(() => {
    applyAppManifest({
      manifestHref: "/manifest-driver.json",
      appleTouchHref: "/icons/driver-1024.png",
      title: "BusLink 기사",
    });
  }, []);

  useEffect(() => {
    const u = auth.currentUser;
    if (!u) return;
    const cid = propCompanyId || resolveByHostname(window.location.hostname) || "dy001";
    setCompanyId(cid);
    const init = async () => {
      try {
        let snap = await getDocs(query(
          collection(db, "companies", cid, "drivers"),
          where("uid", "==", u.uid)
        ));
        if (snap.empty && u.email?.endsWith("@buslink.com")) {
          const empNo = u.email.replace("@buslink.com", "");
          snap = await getDocs(query(
            collection(db, "companies", cid, "drivers"),
            where("empNo", "==", empNo)
          ));
          if (!snap.empty) {
            await updateDoc(doc(db, "companies", cid, "drivers", snap.docs[0].id), { uid: u.uid });
          }
        }
        if (!snap.empty) {
          const d = { id: snap.docs[0].id, ...snap.docs[0].data() };
          setDriver(d);
          await loadDispatch(d.id, cid);
        } else {
          setError("기사 정보를 찾을 수 없습니다.\n관리자에게 문의하세요.");
        }
      } catch (e) {
        setError("데이터 로드 중 오류가 발생했습니다.");
      }
      setLoading(false);
    };
    init();
  }, [propCompanyId]);

  const loadDispatch = async (driverId, cid) => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
    const snap = await getDocs(query(
      collection(db, "companies", cid, "dispatches", today, "list"),
      where("driverId", "==", driverId)
    ));
    if (snap.empty) { setDispatches([]); setActiveDispatchId(null); return; }
    const list = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.departTime || "").localeCompare(b.departTime || ""));  // 출발시간 오름차순
    setDispatches(list);
    // 활성 선택: localStorage 우선(같은 날 재진입 시 복원) > 첫 항목
    let pick = null;
    try {
      const saved = localStorage.getItem(`buslink_driver_active_dispatch_${today}`);
      if (saved && list.some(d => d.id === saved)) pick = saved;
    } catch {}
    pick = pick || list[0].id;
    setActiveDispatchId(pick);
    // 정류장 로드는 activeDispatchId 변경 useEffect 가 책임(중복 호출 회피)
  };

  const loadStops = async (routeId, cid) => {
    setRouteDataReady(false); // 로드 시작 — 완료까지 운행 시작 게이트
    try {
      const snap = await getDocs(query(
        collection(db, "companies", cid, "routes", routeId, "stops"),
        orderBy("order", "asc")
      ));
      setStops(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (e) {
      console.warn("[BusLink] 정류장 로드 실패:", e.message);
    }
    // 노선 사전경로(routePath) 로드 — GPS 복구 시 정류장 진행률 백필·estimates
    // 구간전파에 사용. 빈배열/없음이면 직선 폴백(하위호환 — 회귀 0).
    try {
      const rd = await getDoc(doc(db, "companies", cid, "routes", routeId));
      const rp = rd.exists() ? rd.data().routePath : null;
      setRoutePath(Array.isArray(rp) ? rp : []);
    } catch (e) {
      console.warn("[BusLink] 노선 경로 로드 실패:", e.message);
      setRoutePath([]);
    }
    // stops + routePath fetch 완료 → 운행 시작 허용(startGPS 가 실 데이터 캡처 보장).
    setRouteDataReady(true);
  };

  // 운행 중 "GPS 신호 확보 중…" 안내 자동 해제 — 실제 측위가 들어오면 표시 끔.
  // (startGPS 파이프라인을 건드리지 않고 동일 위치권한으로 1회 확인 — 권한 거부는 유지)
  useEffect(() => {
    if (!driving || gpsStatus !== "확보중") return;
    let cancelled = false;
    const w = navigator.geolocation.watchPosition(
      () => { if (!cancelled) setGpsStatus(""); },
      () => {},
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 }
    );
    return () => { cancelled = true; navigator.geolocation.clearWatch(w); };
  }, [driving, gpsStatus]);

  // 활성 배차 변경 시 stops 재로드 + 선택 영속화
  useEffect(() => {
    if (!dispatch?.routeId || !companyId) { setStops([]); setRouteDataReady(false); return; }
    loadStops(dispatch.routeId, companyId);
    try {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
      localStorage.setItem(`buslink_driver_active_dispatch_${today}`, dispatch.id);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDispatchId, dispatch?.routeId, companyId]);

  // boardingMode 조회 (2026-05-27 역방향 QR) — 우선순위: routes.boardingMode > partnerCodes.boardingMode > 'driver-qr'.
  // 노선 단위 override가 우선 — 혼승 노선(여러 협력사 직원 공유) 대응. 명시 미설정 시 협력사 정책 fallback.
  // 'passenger-qr' 시 기사앱이 발행 대신 카메라로 스캔. 미설정·null·실패 = 'driver-qr'(회귀 0).
  useEffect(() => {
    let cancelled = false;
    if (!dispatch?.routeId || !companyId) { setBoardingMode("driver-qr"); return; }
    (async () => {
      try {
        const routeSnap = await getDoc(doc(db, "companies", companyId, "routes", dispatch.routeId));
        if (!routeSnap.exists()) { if (!cancelled) setBoardingMode("driver-qr"); return; }
        const r = routeSnap.data();
        // (1) 노선 단위 override
        if (r.boardingMode === "passenger-qr" || r.boardingMode === "driver-qr") {
          if (!cancelled) setBoardingMode(r.boardingMode);
          return;
        }
        // (2) 협력사 단위 fallback
        const partnerCode = r.partnerCode || null;
        if (!partnerCode) { if (!cancelled) setBoardingMode("driver-qr"); return; }
        const pcSnap = await getDoc(doc(db, "partnerCodes", partnerCode));
        if (cancelled) return;
        const mode = pcSnap.exists() ? (pcSnap.data().boardingMode || "driver-qr") : "driver-qr";
        setBoardingMode(mode === "passenger-qr" ? "passenger-qr" : "driver-qr");
      } catch (e) {
        if (!cancelled) {
          console.warn("[boardingMode 조회 실패]", e.message);
          setBoardingMode("driver-qr"); // 안전한 폴백
        }
      }
    })();
    return () => { cancelled = true; };
  }, [dispatch?.routeId, companyId]);

  // ── 활성 dispatch 문서 실시간 구독 — stopArrivals 표시·멱등 가드용 ──
  // 운행중일 때만 구독(미운행 시엔 정류장 표시 자체가 없으므로 비용 절감).
  // dispatch.stopArrivals = { [stopId]: { actualAt: serverTimestamp, plannedAt, delaySec } }
  const [stopArrivals, setStopArrivals] = useState({});
  useEffect(() => {
    if (!companyId || !dispatch?.id) { setStopArrivals({}); return; }
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
    const ref = doc(db, "companies", companyId, "dispatches", today, "list", dispatch.id);
    return onSnapshot(ref, snap => {
      if (!snap.exists()) { setStopArrivals({}); return; }
      const sa = snap.data().stopArrivals || {};
      const out = {};
      Object.entries(sa).forEach(([sid, v]) => {
        const at = v?.actualAt?.toMillis ? v.actualAt.toMillis() : (typeof v?.actualAt === 'number' ? v.actualAt : null);
        if (at != null) out[sid] = at;
      });
      setStopArrivals(out);
    }, () => setStopArrivals({}));
    // recoverTick 변화 시 본 effect cleanup→재실행으로 onSnapshot 재구독(통신 복구 후
    // stale 리스너 신선화). companyId/dispatch.id 외 deps라 정상 흐름엔 영향 0.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, dispatch?.id, recoverTick]);

  // 통신 복구(online 전이) + 운행 중 + watchId 보유 시 즉시 1회 heartbeat sendGPS —
  // 승객앱·관제 마커가 옛 좌표에 멈춰있던 결함 차단. recoverTick 증가가 트리거 신호.
  useEffect(() => {
    if (recoverTick === 0) return; // 첫 마운트 skip
    if (!driving || !watchId) return;
    const ok = triggerHeartbeat(watchId);
    if (ok) console.log("[BusLink] 통신 복구 — heartbeat sendGPS 1회 발송");
  }, [recoverTick, driving, watchId]);

  // Wake Lock 재획득
  useEffect(() => {
    const fn = async () => {
      if (document.visibilityState === "visible" && driving && "wakeLock" in navigator) {
        try { wakeLockRef.current = await navigator.wakeLock.request("screen"); } catch {}
      }
    };
    document.addEventListener("visibilitychange", fn);
    return () => document.removeEventListener("visibilitychange", fn);
  }, [driving]);

  // ── 정류장 estimates(계획·예상시각·지연) ──
  // 기사 화면엔 GPS 가중 무의미(차량 자기 좌표) → vehiclePos 미주입, plan+delay 모드.
  // routePath는 주입 — computeStopEstimates 단조증가 구간전파(chainCandidate)가
  // routePath 구간거리 기반으로 더 정밀해짐(vehiclePos 없으면 gpsCandidate는 미발생,
  // 회귀 표면 없음). todayDispatch.stopArrivals 갱신 → 누적지연 자동 반영.
  // 단조증가 로직이 "도착예정시간이 현재시간 이전" 결함을 해결(이슈 #2).
  const stopEstimates = computeStopEstimates({
    stops,
    departTime: dispatch?.departTime,
    actualArrivals: stopArrivals,
    vehiclePos: null,
    speed: null,
    routePath: Array.isArray(routePath) && routePath.length >= 2 ? routePath : null,
  });
  const estByStopId = Object.fromEntries(stopEstimates.map(e => [e.stopId, e]));

  // ── ETA 자동 진단 로깅(2026-05-29) ─────────────────────────────────────────
  // 운행 중일 때만 활성. 30초 interval + stopArrivals 변경 시 즉시 1건 기록.
  // 차량 좌표는 gps/{companyId}_{vehicleId} 1회 getDoc(본인 발신값 — driverApp이 발신측).
  // routePath 유효 시 busProgress / nextStopProgress 도 같이 산출(부모 진단용).
  const flushDiag = useRef(null);
  flushDiag.current = async (triggerSource) => {
    if (!driving || !runId || !companyId || !dispatch?.id) return;
    // 차량 GPS 1회 조회(본인 발신 doc — 비용 1회 read)
    let vehiclePos = null, vehicleSpeed = null;
    try {
      if (driver?.vehicleId) {
        const gpsSnap = await getDoc(doc(db, "gps", `${companyId}_${driver.vehicleId}`));
        if (gpsSnap.exists()) {
          const g = gpsSnap.data();
          if (typeof g.lat === "number" && typeof g.lng === "number") {
            vehiclePos = { lat: g.lat, lng: g.lng };
            vehicleSpeed = typeof g.speed === "number" ? g.speed : null;
            lastVehiclePosRef.current = vehiclePos;
            lastVehicleSpeedRef.current = vehicleSpeed;
          }
        }
      }
    } catch { /* 무해 — null 인 채로 기록 */ }
    // busProgress / nextStopProgress 산출 (routePath 유효 + vehiclePos 있을 때만)
    let busProgress = null, nextStopProgress = null;
    const validPath = Array.isArray(routePath) && routePath.length >= 2;
    if (validPath && vehiclePos) {
      try {
        const cum = buildCumulativeLengths(routePath);
        const proj = projectToPolyline(vehiclePos, routePath, cum);
        if (proj) busProgress = proj.progress;
        // nextIdx = stopEstimates 의 status==='next' 첫 항목 인덱스(stops 배열 기준).
        const nextStopId = (stopEstimates.find(e => e.status === "next") || {}).stopId;
        if (nextStopId) {
          const ns = stops.find(s => s.id === nextStopId);
          if (ns && typeof ns.lat === "number" && typeof ns.lng === "number") {
            const sp = projectToPolyline({ lat: ns.lat, lng: ns.lng }, routePath, cum);
            if (sp) nextStopProgress = sp.progress;
          }
        }
      } catch { /* 무해 */ }
    }
    // nextIdx 산출 (stops 배열 기준 — etaDiag payload용)
    const nextIdx = stops.findIndex(s => {
      const e = estByStopId[s.id];
      return e && e.status === "next";
    });
    // 2026-06-01 — stopArrivals 기록 결과 로그 첨부(최근 20건).
    // 어느 정류장이 ok/alreadyExists/error/code 로 기록됐는지 다음 진단 JSON 에서 추적.
    const stopArrivalsLog = stopArrivalsLogRef.current.slice(-20);
    await recordEtaDiagnostic({
      companyId, runId,
      vehiclePos, vehicleSpeed,
      busProgress, nextStopProgress,
      estimates: stopEstimates,
      nextIdx,
      T_NOW: Date.now(),
      source: triggerSource || "auto",
      stopArrivalsLog,
      appVersion: DRIVER_BUILD,
    });
  };

  // 30초 interval — 운행 중 + runId 있을 때만.
  useEffect(() => {
    if (!driving || !runId) return;
    const tick = () => {
      if (!throttleGate({ runId, intervalMs: 30_000 })) return;
      flushDiag.current && flushDiag.current("interval");
    };
    // 첫 tick 즉시(throttle 통과 — 마지막 기록 없음)
    tick();
    const t = setInterval(tick, 30_000);
    return () => clearInterval(t);
  }, [driving, runId]);

  // stopArrivals 변경 시 즉시 1건 기록(throttle 우회 — 이벤트 기반 핵심 데이터)
  useEffect(() => {
    if (!driving || !runId) return;
    // 첫 마운트(빈 stopArrivals)는 interval이 처리 — stopArrivals 갱신만 트리거.
    if (!stopArrivals || Object.keys(stopArrivals).length === 0) return;
    throttleGate({ runId, force: true }); // last 시각 갱신(다음 interval 30초 카운트 리셋)
    flushDiag.current && flushDiag.current("stopArrivals");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopArrivals, driving, runId]);

  const sendNotification = (stop, dist) => {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("🚌 정류장 도착", {
        body: `${stop.name} 도착 (${dist}m)`,
        icon: "/favicon.ico",
      });
    }
  };

  const handleStart = async () => {
    if (!driver.vehicleId) {
      alert("배정된 차량이 없습니다.\n관리자에게 차량 배정을 요청하세요.");
      return;
    }
    // 위치 권한 사전 점검(작업4 헬퍼 재사용) — 미허용이면 startGPS 전에 권한 요청 흐름.
    // ensureGeolocationPermission: granted|prompt면 OS 팝업 유도, denied면 false 반환.
    setGpsStatus("확보중");
    const ok = await ensureGeolocationPermission();
    if (!ok) {
      setGpsStatus("권한");
      alert("GPS 권한이 필요합니다.\n위치 권한을 허용해주세요.");
      return;
    }
    // ── 2026-05-28 버튼 응답성 수정 ─────────────────────────────────────────
    // 통신 불량 시 `await updateDoc`이 hang하면 setDriving(true) 등 로컬 state 갱신이
    // 영영 실행 안 됨 → 사용자 인식 "버튼이 안 눌림". 해법 = 로컬 state·startGPS는 즉시,
    // Firestore 쓰기·refreshToken은 fire-and-forget(`.catch` 로 graceful).
    // WakeLock도 await 하지 말고 background — 실패해도 운행은 진행.
    if ("wakeLock" in navigator) {
      navigator.wakeLock.request("screen")
        .then(w => { wakeLockRef.current = w; })
        .catch(() => {});
    }
    // Firestore drivers 상태 update — fire-and-forget. 실패해도 운행 흐름 차단 X.
    updateDoc(doc(db, "companies", companyId, "drivers", driver.id), {
      status: "운행중", startedAt: new Date().toISOString(),
    }).catch(e => console.warn("[BusLink] drivers 상태 update 실패(통신):", e.message));
    // 운행 시작 시점의 활성 dispatch·노선 정보를 캡쳐(중간에 dispatch picker 전환되어도
    // 콜백 클로저는 시작 dispatch에 stopArrivals 기록 — 단일 운행 단위 일관성).
    const activeDispId = dispatch?.id || null;
    const activeRouteDepart = dispatch?.departTime || null;
    const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
    // 2026-06-01 — 운행 1회 단위 stopArrivals 기록 로그 초기화(이전 운행 잔존 차단).
    stopArrivalsLogRef.current = [];
    const id = startGPS({
      companyId, vehicleId: driver.vehicleId, vehicleNo: driver.vehicleNo || "",
      driverId: driver.id, driverName: driver.name || "",
      routeId: dispatch?.routeId || "", routeName: dispatch?.routeName || "",
      stops,
      // 노선 사전경로 — GPS 복구 시 진행률 기반 정류장 누락 백필(빈배열=직선 폴백).
      routePath: Array.isArray(routePath) ? routePath : [],
      // 최신 노선데이터 getter(2026-06-02) — startGPS 1회 캡처가 빈값이어도 ref 로 최신값을
      // 읽어 백필이 항상 작동(로드 타이밍 경합 무관). gps.js 가 매 감지 시 호출.
      getStops: () => stopsRef.current,
      getRoutePath: () => routePathRef.current,
      onStopReached: async (stop, dist, viaBackfill) => {
        // 백필이 한 콜백에서 여러 정류장을 순차 호출할 수 있음 → Math.max로 역행 방지
        // (옛 정류장 인덱스가 현재값을 끌어내리지 않도록).
        const newIdx = stops.findIndex(s => s.id === stop.id);
        if (newIdx >= 0) setCurrentStopIdx(prev => Math.max(prev, newIdx));
        sendNotification(stop, dist);
        // ── stopArrivals 기록(CF 위임, 2026-06-01) ─────────────────────────────
        // 기존 클라이언트 updateDoc 경로는 rules driver 본인 검증(drivers.uid 매핑) 통과
        // 실패 시 silent fail — 2026-06-01 진단 JSON 분석으로 stopArrivals 갱신 0건
        // 확정 → CF `recordStopArrival` 위임으로 본질 우회(Admin SDK 가 rules 우회).
        // 멱등 가드는 CF 측이 수행(alreadyExists 반환). 결과는 stopArrivalsLogRef 에
        // 누적해 다음 진단 JSON 에 첨부 → 어느 정류장이 어떻게 기록됐는지 추적.
        const ts = Date.now();
        if (!activeDispId) {
          stopArrivalsLogRef.current.push({
            stopId: stop.id, ok: false, error: "activeDispId null", viaBackfill: !!viaBackfill, ts,
          });
          if (stopArrivalsLogRef.current.length > 40) stopArrivalsLogRef.current.shift();
          return;
        }
        const plannedAt = planTimeForStop(activeRouteDepart, stop.offsetMin);
        // delaySec 추정: plannedAt(오늘 ms) - now. 클라 추정값(서버는 actualAt에 serverTimestamp).
        let delaySec = null;
        if (plannedAt && typeof stop.offsetMin === "number") {
          const m = plannedAt.match(/^(\d{2}):(\d{2})$/);
          if (m) {
            const planDate = new Date(); planDate.setHours(+m[1], +m[2], 0, 0);
            delaySec = Math.round((Date.now() - planDate.getTime()) / 1000);
          }
        }
        try {
          const callable = httpsCallable(functions, "recordStopArrival");
          const res = await callable({
            companyId,
            date: todayStr,
            dispatchId: activeDispId,
            stopId: stop.id,
            plannedAt: plannedAt || null,
            delaySec,
            viaBackfill: !!viaBackfill,
          });
          stopArrivalsLogRef.current.push({
            stopId: stop.id,
            ok: true,
            alreadyExists: !!(res && res.data && res.data.alreadyExists),
            viaBackfill: !!viaBackfill,
            ts,
          });
        } catch (e) {
          stopArrivalsLogRef.current.push({
            stopId: stop.id,
            ok: false,
            error: e?.message || String(e),
            code: e?.code || null,
            viaBackfill: !!viaBackfill,
            ts,
          });
          console.warn("[BusLink] stopArrivals 기록 실패:", e?.code, e?.message);
        }
        if (stopArrivalsLogRef.current.length > 40) stopArrivalsLogRef.current.shift();
      },
      onGpsError: (err) => {
        // err.code 1=PERMISSION_DENIED, 3=TIMEOUT — 화면 안내(작업4 권한 UI와 연동)
        setGpsStatus(err.code === 1 ? "권한" : "확보중");
      },
    });
    // 로컬 state는 즉시 반영(버튼 응답성 보장 — 통신 불량과 무관).
    setWatchId(id);
    setDriving(true);
    // ETA 자동 진단 로깅 runId 산출(2026-05-29) — 운행 1회 단위.
    setRunId(buildRunId({ driverId: driver.id, vehicleId: driver.vehicleId, startedAtMs: Date.now() }));
    // ✅ 탑승 QR 토큰 최초 생성 — passenger-qr 모드(역방향: 직원 발행/기사 스캔)는 skip.
    // 2026-05-28: await 제거 — 통신 불량 시 hang으로 운행 시작 자체가 지연되던 결함 차단.
    // refreshToken 내부에 try/catch 보호장치 있음(이미). 5분 자동 갱신 인터벌은 무관하게 등록.
    if (boardingMode !== "passenger-qr") {
      refreshToken(driver, dispatch);
      tokenTimerRef.current = setInterval(() => refreshToken(driver, dispatch), 5 * 60 * 1000);
    }
  };

  const handleStop = async () => {
    // ── 2026-05-28 버튼 응답성 수정 ─────────────────────────────────────────
    // 통신 불량 시 `await clearGPS`/`await updateDoc`이 hang하면 setDriving(false) 등
    // 로컬 state 갱신이 영영 실행 안 됨 → "운행 종료 버튼 안 눌림". 해법 = 로컬 state·
    // stopGPS는 즉시, Firestore 쓰기는 fire-and-forget(`.catch` 로 graceful).
    const watchToStop = watchId;
    const vehId = driver?.vehicleId;
    // 로컬 state 즉시 갱신(통신과 무관 — 버튼 누름 즉시 UI 반응).
    setDriving(false);
    setWatchId(null);
    setGpsStatus("");
    setCurrentStopIdx(-1);
    // ETA 자동 진단 로깅 runId 해제(2026-05-29) — interval은 effect cleanup으로 자동 정지.
    setRunId(null);
    lastVehiclePosRef.current = null;
    lastVehicleSpeedRef.current = null;
    // 2026-06-01 — stopArrivals 기록 로그 정리(다음 운행 시 재초기화 + 누적 차단).
    stopArrivalsLogRef.current = [];
    setBoardingToken(null);
    setQrUrl(null);
    setActiveTab("운행");
    if (wakeLockRef.current) {
      try { wakeLockRef.current.release(); } catch {}
      wakeLockRef.current = null;
    }
    if (tokenTimerRef.current) { clearInterval(tokenTimerRef.current); tokenTimerRef.current = null; }
    // GPS watch 정지는 동기 — 즉시 안전.
    if (watchToStop != null) stopGPS(watchToStop);
    // Firestore 쓰기는 background — 실패해도 사용자는 이미 "운행 종료" 인지 가능.
    if (vehId) {
      clearGPS({ companyId, vehicleId: vehId })
        .catch(e => console.warn("[BusLink] clearGPS 실패(통신):", e.message));
    }
    if (driver?.id) {
      updateDoc(doc(db, "companies", companyId, "drivers", driver.id), {
        status: "대기", endedAt: new Date().toISOString(),
      }).catch(e => console.warn("[BusLink] drivers 상태 update 실패(통신):", e.message));
    }
  };

  const refreshToken = async (drv, disp) => {
    try {
      const tokenId = await createBoardingToken({
        companyId,
        routeId: disp?.routeId || "",
        routeName: disp?.routeName || "",
        vehicleId: drv.vehicleId,
        vehicleNo: drv.vehicleNo || "",
        driverId: drv.id,
      });
      const url = getBoardingUrl(tokenId);
      setBoardingToken(tokenId);
      setQrUrl(url);
      // ✅ qrcode 라이브러리로 로컬 생성 (외부 API 의존성 없음, 오프라인 동작)
      const dataUrl = await QRCode.toDataURL(url, {
        width: 220,
        margin: 2,
        color: { dark: "#0B1A2E", light: "#FFFFFF" },
        errorCorrectionLevel: "M",
      });
      setQrDataUrl(dataUrl);
    } catch (e) {
      console.warn("[BusLink] 토큰 생성 실패:", e.message);
    }
  };

  const handleLogout = async () => {
    if (driving) await handleStop();
    signOut(auth);
  };

  // 오늘 날짜 — 인사 영역 표시용(시각 전용, 로직 무관)
  const todayLabel = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  }).format(new Date());

  if (loading) return (
    <div style={S.fullCenter}>
      <InstallPrompt />
      <div style={{ color: "var(--color-primary)", fontSize: 16, fontWeight: 600 }}>로딩 중...</div>
    </div>
  );

  if (error) return (
    <div style={{ ...S.fullCenter, flexDirection: "column", gap: 16 }}>
      <InstallPrompt />
      <div style={{ color: "var(--color-destructive)", fontSize: 15, textAlign: "center", whiteSpace: "pre-line", fontWeight: 600 }}>{error}</div>
      <button style={S.outlineBtn} onClick={() => signOut(auth)}>로그아웃</button>
    </div>
  );

  return (
    <div style={S.container}>
      <InstallPrompt />
      <div style={S.card}>
        {/* 헤더 */}
        <div style={S.header}>
          <BusLinkLogo size={18} sub="기사" />
          <button style={S.logoutBtn} onClick={handleLogout}>로그아웃</button>
        </div>

        {/* 권한 경고 배너 + 앱 설치 버튼 (운행 화면 상단) */}
        <PermissionGate />

        {/* GPS 신호 안내 — 운행 시작 시 측위 확보 전/권한 미허용일 때만 */}
        {gpsStatus && (
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "9px 12px", borderRadius: "var(--radius-12)",
            background: gpsStatus === "권한" ? "#FDECEC" : "var(--color-primary-soft)",
            border: gpsStatus === "권한" ? "1px solid var(--color-destructive)" : "1px solid var(--color-primary)",
            color: gpsStatus === "권한" ? "var(--color-destructive)" : "var(--color-primary-deep)",
            fontSize: 13, fontWeight: 700,
          }}>
            <StatusDot tone={gpsStatus === "권한" ? "danger" : "primary"} size={8} pulse />
            {gpsStatus === "권한" ? "GPS 권한을 허용해주세요" : "GPS 신호 확보 중…"}
          </div>
        )}

        {/* 인사 */}
        <div>
          <div style={S.greetingDate}>{todayLabel}</div>
          <div style={S.greetingName}>
            {driver?.name ? `${driver.name} 기사님, 안녕하세요` : "안녕하세요"}
          </div>
        </div>

        {/* 배차 정보 — 그라데이션 히어로 카드 */}
        {dispatch ? (
          <div style={S.heroCard}>
            {/* 흐린 버스 아이콘 */}
            <svg viewBox="0 0 100 100" style={S.heroBusIcon}>
              <rect x="10" y="20" width="80" height="48" rx="10" fill="#fff" />
              <circle cx="28" cy="76" r="8" fill="#fff" /><circle cx="72" cy="76" r="8" fill="#fff" />
            </svg>
            <div style={{ position: "relative" }}>
              <div style={S.heroTop}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <Pill tone="dark" dot style={{ background: "rgba(255,255,255,0.18)", color: "#fff" }}>
                    오늘 배차
                  </Pill>
                  {dispatches.length > 1 && (
                    <button
                      onClick={() => { setDispatchQuery(""); setPickerOpen(true); }}
                      style={S.dispatchChangeBtn}
                    >
                      🔄 배차 변경 ({dispatches.length}건)
                    </button>
                  )}
                </div>
                {driving && (
                  <span style={S.heroLiveBadge}>
                    <StatusDot tone="positive" size={6} pulse /> 운행중
                  </span>
                )}
              </div>
              <div style={S.heroRoute}>{dispatch.routeName}</div>
              <div style={S.heroMetaRow}>
                <div><span style={S.heroMetaLabel}>차량 </span><span style={S.heroMetaVal}>{dispatch.vehicleNo || "-"}</span></div>
                {dispatch.departTime && (
                  <div><span style={S.heroMetaLabel}>출발 </span><span style={S.heroMetaVal}>{dispatch.departTime}</span></div>
                )}
              </div>

              {/* 정류장 진행 — 운행 중이고 현재 정류장이 잡혔을 때만 실제 데이터로 */}
              {driving && stops.length > 0 && (() => {
                const total = stops.length;
                const done = currentStopIdx < 0 ? 0 : Math.min(currentStopIdx + 1, total);
                const next = stops[currentStopIdx + 1] || stops[currentStopIdx] || null;
                const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                const nextEst = next ? estByStopId[next.id] : null;
                const lab = nextEst ? formatDelayLabel(nextEst.delaySec) : { tone: "mute", label: "" };
                const labColor = lab.tone === 'danger' ? '#FFD8D8'
                  : lab.tone === 'warn' ? '#FFE7BF'
                  : '#CFEFE0';
                return (
                  <div style={S.heroProgress}>
                    <div style={S.heroProgressTop}>
                      <span>다음 정류장</span>
                      <span style={S.heroProgressCount}>{done}/{total} 정류장</span>
                    </div>
                    <div style={S.heroNextStop}>{next ? next.name : "운행 시작"}</div>
                    {nextEst && nextEst.plannedAt && (
                      <div style={{ fontSize: 17, color: "#fff", marginTop: 8, fontWeight: 800, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
                        <span style={{ opacity: 0.85, fontWeight: 700 }}>계획</span>
                        <span style={{ fontSize: 20 }}>{nextEst.plannedAt}</span>
                        {nextEst.estimatedAt && nextEst.estimatedAt !== nextEst.plannedAt && (
                          <>
                            <span style={{ opacity: 0.55 }}>·</span>
                            <span style={{ opacity: 0.85, fontWeight: 700 }}>예상</span>
                            <span style={{ fontSize: 20 }}>{nextEst.estimatedAt}</span>
                          </>
                        )}
                        {lab.label && lab.tone !== 'mute' && (
                          <span style={{ background: "rgba(255,255,255,0.22)", border: `2px solid ${labColor}`, color: labColor, borderRadius: 999, padding: "4px 13px", fontSize: 15, fontWeight: 800 }}>
                            {lab.label}
                          </span>
                        )}
                      </div>
                    )}
                    <div style={S.heroBar}>
                      <div style={{ ...S.heroBarFill, width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        ) : (
          <div style={S.emptyDispatch}>
            <Icon name="bus" size={28} />
            <div style={{ marginTop: 8 }}>오늘 배차된 노선이 없습니다</div>
          </div>
        )}

        {/* 라이브 상태 스트립 — GPS 전송 상태(실제 driving / Wake Lock 만, 가짜 수치 없음) */}
        {driving && (
          <div style={S.statStrip}>
            <div style={S.miniStat}>
              <div style={S.miniStatLabel}>상태</div>
              <div style={{ ...S.miniStatVal, color: "var(--color-positive)" }}>운행중</div>
            </div>
            <div style={S.miniStat}>
              <div style={S.miniStatLabel}>GPS</div>
              <div style={{ ...S.miniStatVal, color: "var(--color-positive)" }}>전송중</div>
            </div>
            <div style={S.miniStat}>
              <div style={S.miniStatLabel}>화면</div>
              <div style={S.miniStatVal}>{"wakeLock" in navigator ? "켜짐 유지" : "기본"}</div>
            </div>
          </div>
        )}

        {/* 운행 시작 버튼 (미운행 시) — 노선 데이터(stops+routePath) 로드 완료 후에만 활성화.
            로드 전 시작 시 startGPS 가 빈 routePath 를 캡처해 도착 백필이 꺼지는 경합 차단(2026-06-02). */}
        {!driving && (
          <button
            style={{ ...S.primaryBtn, ...(dispatch && routeDataReady ? {} : S.primaryBtnDisabled) }}
            onClick={handleStart}
            disabled={!dispatch || !routeDataReady}
          >
            <Icon name="play" size={18} /> {dispatch && !routeDataReady ? "노선 불러오는 중…" : "운행 시작"}
          </button>
        )}

        {/* 탭 전환 — 항상 표시. passenger-qr 모드는 라벨이 'QR 스캔'(기사가 스캔측). */}
        <div style={S.tabRow}>
          {["운행", "탑승 QR"].map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              style={{ ...S.tabBtn, ...(activeTab === tab ? S.tabBtnActive : S.tabBtnIdle) }}>
              {tab === "탑승 QR" && <Icon name="qr" size={16} />} {tab === "탑승 QR" && boardingMode === "passenger-qr" ? "QR 스캔" : tab}
            </button>
          ))}
        </div>

        {/* ─ 운행 탭: 정류장 현황 ─ */}
        {(!driving || activeTab === "운행") && stops.length > 0 && (
          <div style={S.listCard}>
            <div style={S.listHeader}>
              <span style={S.listTitle}>오늘 운행 정류장</span>
              <span style={S.listCount}>{stops.length}개소</span>
            </div>
            {/* 정류장 리스트 — 자체 스크롤 컨테이너로 가둬야 `scrollIntoView({block:'center'})`
                가 페이지 전체가 아닌 리스트 내부에서 카지노 릴처럼 동작.
                stops 5개 이하: maxHeight 의미 거의 없음(자연 높이 < 60vh).
                stops 6개+: 스크롤 활성 + 현재 정류장 중앙 정렬.
                스크롤바 시각 정리는 `data-stop-list` + index.css(인라인 불가). */}
            <div data-stop-list style={{
              display: "flex", flexDirection: "column", gap: 2, marginTop: 8,
              maxHeight: "60vh", overflowY: "auto",
              WebkitOverflowScrolling: "touch", // iOS 부드러운 관성 스크롤
            }}>
              {stops.map((stop, i) => {
                const isDone = i < currentStopIdx;
                const isCurrent = i === currentStopIdx;
                const isNext = i === currentStopIdx + 1;
                const est = estByStopId[stop.id];
                const lab = est ? formatDelayLabel(est.delaySec) : { tone: "mute", label: "" };
                const labColor = lab.tone === 'danger' ? 'var(--color-destructive)'
                  : lab.tone === 'warn' ? 'var(--color-cautionary)'
                  : 'var(--color-positive)';
                const labBg = lab.tone === 'danger' ? '#FDECEC'
                  : lab.tone === 'warn' ? '#FFF3E0'
                  : '#E6F7EB';
                const arrived = est && est.status === 'arrived';
                // 행 배경 — 도착(arrived)=positive 카드, 현재=primary 카드, 그 외=투명
                const rowBg = arrived ? '#F0FAF4'
                  : isCurrent ? 'var(--color-primary-soft)'
                  : 'transparent';
                const rowBorder = arrived ? '1px solid #B6E6C6'
                  : isCurrent ? '1px solid var(--color-primary)'
                  : '1px solid transparent';
                return (
                  <div key={stop.id}
                    ref={isCurrent ? currentStopRowRef : null}
                    style={{
                      ...S.stopRow,
                      background: rowBg, border: rowBorder,
                      // 현재 정류장 글로우 — 어르신 기사 시인성
                      boxShadow: isCurrent ? "0 0 0 4px rgba(0,102,255,0.18), 0 4px 14px rgba(0,102,255,0.20)" : "none",
                      transition: "box-shadow .25s ease, background .25s ease",
                      // 현재 정류장은 살짝 padding 더(더 큰 카드 느낌)
                      padding: isCurrent ? "18px 14px" : "14px 10px",
                    }}>
                    {/* 현재 정류장 dot은 펄스 ring으로 강조(buspulse 재사용) */}
                    <div style={{ position: "relative", flexShrink: 0 }}>
                      <div style={{
                        ...S.stopDot,
                        // 현재 정류장은 한 단계 더 큼
                        width: isCurrent ? 18 : 14, height: isCurrent ? 18 : 14,
                        background: arrived ? "var(--color-positive)"
                          : isCurrent ? "var(--color-primary)"
                          : isDone ? "var(--color-primary)" : "#fff",
                        border: `3px solid ${arrived ? "var(--color-positive)"
                          : (isCurrent || isDone) ? "var(--color-primary)"
                          : "var(--color-atomic-coolNeutral-90)"}`,
                      }} />
                      {isCurrent && (
                        <div style={{
                          position: "absolute", inset: -3,
                          borderRadius: "50%", background: "var(--color-primary)",
                          animation: "buspulse 2s ease-out infinite",
                          pointerEvents: "none",
                        }} />
                      )}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {/* 정류장 이름 — 통과한 정류장(도착 제외)은 흐리되, 시각·지연 정보는 또렷 유지 */}
                      <div style={{
                        ...S.stopName,
                        color: isCurrent ? "var(--color-primary-deep)" : "var(--color-label)",
                        opacity: (isDone && !arrived) ? 0.55 : 1,
                      }}>
                        {stop.name}
                      </div>
                      {/* 계획·실제 시각 — plannedAt 또는 chain-propagated estimatedAt 있는 정류장.
                          (2026-05-26 보강: offsetMin 미설정 정류장도 chain 전파된 예상시각·지연 표시)
                          예상/지연은 운행 중 또는 도착 실측이 있을 때만 — 어르신 기사 가독성 위해 크게+칩 형태. */}
                      {est && (est.plannedAt || est.estimatedAt) && (
                        <div style={{ fontSize: 16, marginTop: 5, fontWeight: 700, color: "var(--color-label)", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                          <span style={{ color: "var(--color-label-mute)" }}>
                            {arrived ? "도착" : est.plannedAt ? "계획" : "예상"}
                          </span>
                          <span style={{ color: arrived ? 'var(--color-positive)' : 'var(--color-primary-deep)', fontWeight: 800, fontSize: 18 }}>
                            {arrived ? est.estimatedAt : (est.plannedAt || est.estimatedAt)}
                          </span>
                          {!arrived && driving && est.plannedAt && est.estimatedAt && est.estimatedAt !== est.plannedAt && (
                            <>
                              <span style={{ color: "var(--color-label-alt)" }}>·</span>
                              <span style={{ color: "var(--color-label-mute)" }}>예상</span>
                              <span style={{ color: 'var(--color-primary-deep)', fontWeight: 800, fontSize: 18 }}>{est.estimatedAt}</span>
                            </>
                          )}
                          {(arrived || driving) && lab.label && lab.tone !== 'mute' && (
                            <span style={{
                              background: labBg, color: labColor, fontWeight: 800, fontSize: 15,
                              padding: "3px 11px", borderRadius: 999, border: `1.5px solid ${labColor}`,
                            }}>
                              {lab.label}
                            </span>
                          )}
                        </div>
                      )}
                      {stop.address && (
                        <div style={{ ...S.stopAddr, opacity: (isDone && !arrived) ? 0.55 : 1 }}>
                          {stop.address}
                        </div>
                      )}
                    </div>
                    {isCurrent && <span style={S.tagCurrent}>현재</span>}
                    {isNext && <span style={S.tagNext}>다음</span>}
                  </div>
                );
              })}
            </div>

            {/* [DIAG-ETA 제거예정] 진단 오버레이 — driving + 운행 탭 한정.
                정류장별 ETA·source·delay를 표로 가시화해 사용자가 폰으로 직접 캡쳐.
                다음 커밋에 grep "[DIAG-ETA" 1줄로 통째 제거. */}
            {driving && (
              <div style={{ marginTop: 10 }}>
                <button
                  onClick={() => setDiagOpen(v => !v)}
                  style={{
                    fontSize: 11, padding: "5px 10px",
                    borderRadius: 8, border: "1px dashed var(--color-label-mute)",
                    background: "transparent", color: "var(--color-label-mute)",
                    cursor: "pointer", fontFamily: "inherit",
                  }}>
                  🔍 진단 {diagOpen ? "▲" : "▼"}
                </button>
                {diagOpen && (
                  <div style={{
                    marginTop: 6, padding: 8, borderRadius: 8,
                    background: "#FFFBEA", border: "1px dashed #C99A2E",
                    fontSize: 10, fontFamily: "monospace", lineHeight: 1.4,
                    color: "#3a2e08", overflowX: "auto", whiteSpace: "nowrap",
                  }}>
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>[DIAG-ETA] 정류장 ETA 진단</div>
                    {stopEstimates.map((e, i) => {
                      const stop = stops.find(s => s.id === e.stopId);
                      const name = stop?.name || e.stopId;
                      const delayMin = e.delaySec != null ? Math.round(e.delaySec / 60) : null;
                      const delayLab = delayMin == null ? "—"
                        : delayMin === 0 ? "0분"
                        : delayMin > 0 ? `+${delayMin}분`
                        : `${delayMin}분`;
                      return (
                        <div key={e.stopId}>
                          [{i}] {name.length > 8 ? name.slice(0, 8) + "…" : name}
                          {" | plan "}{e.plannedAt || "—"}
                          {" | est "}{e.estimatedAt || "—"}
                          {" | delay "}{delayLab}
                          {" | "}{e.status}
                          {" | "}{e.source}
                        </div>
                      );
                    })}
                    <div style={{ marginTop: 4, opacity: 0.7 }}>
                      currentStopIdx={currentStopIdx} | stops={stops.length}
                    </div>
                  </div>
                )}
              </div>
            )}
            {/* [/DIAG-ETA] */}
          </div>
        )}

        {/* ─ 탑승 QR 탭 — boardingMode 분기 ─ */}
        {/* (a) driver-qr 모드(기본): 기사 발행 → 직원 스캔 (기존 흐름 100% 보존) */}
        {activeTab === "탑승 QR" && boardingMode !== "passenger-qr" && !driving && (
          <div style={S.qrNotice}>
            <Icon name="qr" size={26} />
            <div>
              <div style={S.qrNoticeTitle}>운행 시작 후 QR이 활성화됩니다</div>
              <div style={S.qrNoticeSub}>운행 시작 버튼을 누르면 탑승 QR이 자동 생성됩니다</div>
            </div>
          </div>
        )}
        {activeTab === "탑승 QR" && boardingMode !== "passenger-qr" && driving && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
            {qrUrl ? (
              <>
                <div style={S.qrGuide}>승객이 아래 QR을 스캔하면 탑승이 기록됩니다</div>
                {/* QR 코드 이미지 - qrcode 라이브러리 (로컬 생성, 오프라인 동작) */}
                <div style={S.qrBox}>
                  {qrDataUrl
                    ? <img src={qrDataUrl} alt="탑승 QR" width={220} height={220} style={{ display: "block", borderRadius: 8 }} />
                    : <div style={S.qrPlaceholder}>생성 중...</div>
                  }
                </div>
                <div style={S.qrRouteBox}>
                  <div style={S.qrRouteLabel}>노선</div>
                  <div style={S.qrRouteVal}>{dispatch?.routeName}</div>
                </div>
                <div style={S.qrAutoNote}>QR코드는 5분마다 자동 갱신됩니다</div>
                <button onClick={() => refreshToken(driver, dispatch)} style={S.refreshBtn}>
                  QR 즉시 갱신
                </button>
              </>
            ) : (
              <div style={S.qrGuide}>QR 생성 중...</div>
            )}
          </div>
        )}

        {/* (b) passenger-qr 모드: 직원 발행 → 기사 스캔 (2026-05-27 역방향) */}
        {activeTab === "탑승 QR" && boardingMode === "passenger-qr" && !driving && (
          <div style={S.qrNotice}>
            <Icon name="qr" size={26} />
            <div>
              <div style={S.qrNoticeTitle}>운행 시작 후 스캔이 활성화됩니다</div>
              <div style={S.qrNoticeSub}>직원이 발행한 QR을 스캔하여 탑승을 기록합니다</div>
            </div>
          </div>
        )}
        {activeTab === "탑승 QR" && boardingMode === "passenger-qr" && driving && (
          <DriverPassengerScan
            companyId={companyId}
            driver={driver}
            dispatch={dispatch}
            currentStop={(currentStopIdx >= 0 && stops[currentStopIdx]) ? stops[currentStopIdx] : null}
          />
        )}
      </div>

      {/* 하단 운행 종료 바 — 운행 중에만 (목업: 검정 sticky) */}
      {driving && (
        <div style={S.bottomBar}>
          <button style={S.endBtn} onClick={handleStop}>
            <StatusDot tone="positive" size={8} pulse /> 운행 중 — 종료
          </button>
        </div>
      )}

      {/* ── 배차 선택 모달 — EmployeeApp routePicker 패턴(풀모달 오버레이·검색·카드 리스트) ── */}
      {pickerOpen && (
        <div onClick={() => setPickerOpen(false)} style={S.pickerBack}>
          <div onClick={e => e.stopPropagation()} style={S.pickerModal}>
            <div style={S.pickerHead}>
              <div style={{ width: 36, height: 4, background: "var(--color-line)", borderRadius: 2, margin: "0 auto 12px" }} />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 15, fontWeight: 800 }}>오늘 배차 선택 ({dispatches.length}건)</span>
                <button onClick={() => setPickerOpen(false)} style={S.pickerClose}>✕</button>
              </div>
              {dispatches.length > 6 && (
                <input
                  style={{ ...S.pickerSearch, marginTop: 10 }}
                  placeholder="🔍 노선·차량·시간·거래처 검색"
                  value={dispatchQuery}
                  onChange={e => setDispatchQuery(e.target.value)}
                  autoFocus
                />
              )}
            </div>
            <div style={S.pickerBody}>
              {filteredDispatches.length === 0 ? (
                <div style={{ textAlign: "center", padding: "32px 16px", color: "var(--color-label-mute)", fontSize: 13 }}>
                  {dispatches.length === 0 ? "오늘 배차된 노선이 없습니다" : "검색 결과가 없습니다"}
                </div>
              ) : filteredDispatches.map(d => {
                const cur = d.id === activeDispatchId;
                return (
                  <div
                    key={d.id}
                    onClick={() => { setActiveDispatchId(d.id); setPickerOpen(false); }}
                    style={{ ...S.pickerCard, ...(cur ? S.pickerCardActive : {}) }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5, flexWrap: "wrap" }}>
                      <span style={S.pickerTime}>{d.departTime || "--:--"}</span>
                      <span style={S.pickerType}>{d.routeType || ""}</span>
                      {cur && <span style={S.pickerCurrent}>현재</span>}
                    </div>
                    <div style={S.pickerRoute}>{d.routeName || "노선?"}</div>
                    <div style={S.pickerMeta}>
                      {d.vehicleNo && <span>🚌 {d.vehicleNo}</span>}
                      {d.partnerName && <span> · {d.partnerName}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// DriverApp 한정 인라인 스타일. 색/라운드/그림자는 tokens.css 변수 기반(라이트).
const S = {
  fullCenter: {
    minHeight: "100vh", background: "var(--color-bg-alt)", display: "flex",
    alignItems: "center", justifyContent: "center", fontFamily: "var(--font-base)",
  },
  outlineBtn: {
    background: "var(--color-bg)", border: "1px solid var(--color-line)",
    borderRadius: "var(--radius-8)", padding: "8px 20px", color: "var(--color-label)",
    cursor: "pointer", fontFamily: "inherit", fontWeight: 600, fontSize: 14,
  },

  // 배차 변경 — hero 카드 안의 작은 버튼(흰 반투명, 그라데이션 위 라이트 토큰만)
  dispatchChangeBtn: {
    background: "rgba(255,255,255,0.18)", border: "1px solid rgba(255,255,255,0.4)",
    borderRadius: "var(--radius-pill)", padding: "4px 11px", color: "#fff",
    fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
    backdropFilter: "blur(4px)",
  },

  // 배차 선택 모달 (EmployeeApp routePicker 패턴 차용)
  pickerBack: {
    position: "fixed", inset: 0, background: "var(--color-overlay)", zIndex: 200,
    display: "flex", flexDirection: "column", justifyContent: "flex-end",
  },
  pickerModal: {
    background: "var(--color-bg)", borderRadius: "20px 20px 0 0",
    width: "100%", maxHeight: "82dvh", display: "flex", flexDirection: "column",
    boxShadow: "var(--shadow-heavy)",
  },
  pickerHead: {
    padding: "14px 16px 12px", borderBottom: "1px solid var(--color-line)",
    flexShrink: 0,
  },
  pickerClose: {
    background: "var(--color-bg-soft)", border: "1px solid var(--color-line)",
    borderRadius: "var(--radius-8)", padding: "6px 12px",
    color: "var(--color-label-mute)", cursor: "pointer",
    fontFamily: "inherit", fontSize: 12,
  },
  pickerSearch: {
    width: "100%", padding: "9px 12px",
    border: "1px solid var(--color-line)", borderRadius: "var(--radius-8)",
    fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box",
  },
  pickerBody: { padding: "12px 16px 22px", overflowY: "auto", flex: 1 },
  pickerCard: {
    display: "block", padding: "12px 14px", marginBottom: 8,
    borderRadius: "var(--radius-12)", cursor: "pointer",
    border: "1px solid var(--color-line)", background: "var(--color-bg)",
  },
  pickerCardActive: {
    border: "1px solid var(--color-primary)", background: "var(--color-primary-soft)",
  },
  pickerTime: { fontSize: 13, fontWeight: 800, color: "var(--color-primary-deep)" },
  pickerType: {
    fontSize: 10, padding: "3px 9px", borderRadius: "var(--radius-pill)",
    background: "var(--color-bg-soft)", color: "var(--color-label-mute)", fontWeight: 600,
  },
  pickerCurrent: {
    fontSize: 10, padding: "3px 9px", borderRadius: "var(--radius-pill)",
    background: "var(--color-primary)", color: "#fff", fontWeight: 700, marginLeft: "auto",
  },
  pickerRoute: {
    fontSize: 14, fontWeight: 700, color: "var(--color-label)", marginBottom: 3,
    wordBreak: "keep-all",
  },
  pickerMeta: { fontSize: 11, color: "var(--color-label-mute)" },

  container: {
    minHeight: "100vh", background: "var(--color-bg-alt)", display: "flex",
    alignItems: "flex-start", justifyContent: "center", padding: 16,
    fontFamily: "var(--font-base)", color: "var(--color-label)", overflowY: "auto",
  },
  card: {
    background: "transparent", borderRadius: 0, padding: 0, width: "100%", maxWidth: 420,
    display: "flex", flexDirection: "column", gap: 14, marginTop: 8, marginBottom: 96,
  },

  header: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "4px 4px 0",
  },
  logoutBtn: {
    background: "var(--color-bg)", border: "1px solid var(--color-line)",
    borderRadius: "var(--radius-8)", padding: "6px 12px", color: "var(--color-label-mute)",
    fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
  },

  greetingDate: { fontSize: 13, color: "var(--color-label-mute)", fontWeight: 600, padding: "0 4px" },
  greetingName: {
    fontSize: 22, fontWeight: 800, marginTop: 2, letterSpacing: "-0.02em",
    color: "var(--color-label)", padding: "0 4px",
  },

  // 그라데이션 히어로 배차카드 (목업 #0066FF → #003DCC)
  heroCard: {
    padding: "20px 20px 18px", borderRadius: "var(--radius-20)",
    background: "linear-gradient(155deg, var(--color-primary) 0%, var(--color-primary-deep) 100%)",
    color: "#fff", position: "relative", overflow: "hidden",
    boxShadow: "var(--shadow-strong)",
  },
  heroBusIcon: { position: "absolute", right: -10, top: -10, width: 140, opacity: 0.15 },
  heroTop: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  heroLiveBadge: {
    display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12,
    fontWeight: 700, color: "#fff",
  },
  heroRoute: {
    fontFamily: "var(--font-brand)", fontSize: 28, fontWeight: 800, marginTop: 14,
    letterSpacing: "-0.025em",
  },
  heroMetaRow: { display: "flex", gap: 16, marginTop: 10, fontSize: 13 },
  heroMetaLabel: { color: "rgba(255,255,255,0.6)" },
  heroMetaVal: { fontWeight: 700, fontFamily: "var(--font-mono)" },
  heroProgress: {
    marginTop: 18, padding: 14, background: "rgba(255,255,255,0.10)",
    borderRadius: "var(--radius-12)",
  },
  heroProgressTop: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    fontSize: 13, fontWeight: 700, color: "rgba(255,255,255,0.85)",
  },
  heroProgressCount: { fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 14 },
  heroNextStop: { fontSize: 24, fontWeight: 800, marginTop: 6, letterSpacing: "-0.01em" },
  heroBar: {
    marginTop: 10, height: 6, background: "rgba(255,255,255,0.18)",
    borderRadius: 3, overflow: "hidden",
  },
  heroBarFill: { height: "100%", background: "#fff", borderRadius: 3, transition: "width .4s ease" },

  emptyDispatch: {
    background: "var(--color-bg)", borderRadius: "var(--radius-16)", padding: "32px 20px",
    border: "1px solid var(--color-line)", textAlign: "center",
    color: "var(--color-label-mute)", fontSize: 14, fontWeight: 600,
    display: "flex", flexDirection: "column", alignItems: "center",
    boxShadow: "var(--shadow-emphasize)",
  },

  statStrip: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 },
  miniStat: {
    background: "var(--color-bg)", borderRadius: "var(--radius-12)", padding: "10px 12px",
    textAlign: "center", boxShadow: "var(--shadow-emphasize)",
  },
  miniStatLabel: { fontSize: 11, color: "var(--color-label-mute)", fontWeight: 600 },
  miniStatVal: {
    fontFamily: "var(--font-brand)", fontSize: 15, fontWeight: 800,
    color: "var(--color-label)", marginTop: 3,
  },

  primaryBtn: {
    border: "none", borderRadius: "var(--radius-16)", padding: "18px 0",
    background: "var(--color-primary)", color: "#fff", fontSize: 16, fontWeight: 700,
    cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center",
    justifyContent: "center", gap: 8, boxShadow: "var(--shadow-strong)",
  },
  primaryBtnDisabled: {
    background: "var(--color-atomic-coolNeutral-90)", color: "var(--color-label-mute)",
    cursor: "not-allowed", boxShadow: "none",
  },

  tabRow: { display: "flex", gap: 6 },
  tabBtn: {
    flex: 1, padding: "10px", borderRadius: "var(--radius-12)", border: "none",
    cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 700,
    display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
  },
  tabBtnActive: { background: "var(--color-primary)", color: "#fff" },
  tabBtnIdle: { background: "var(--color-bg)", color: "var(--color-label-mute)", boxShadow: "var(--shadow-emphasize)" },

  listCard: {
    background: "var(--color-bg)", borderRadius: "var(--radius-16)", padding: "14px 16px",
    boxShadow: "var(--shadow-emphasize)",
  },
  listHeader: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  listTitle: { fontSize: 16, fontWeight: 800, color: "var(--color-label)" },
  listCount: { fontSize: 14, color: "var(--color-primary)", fontWeight: 700 },
  stopRow: { display: "flex", alignItems: "center", gap: 14, padding: "14px 10px", borderRadius: "var(--radius-12)" },
  stopDot: { width: 14, height: 14, borderRadius: "50%", flexShrink: 0 },
  stopName: {
    fontSize: 18, fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    letterSpacing: "-0.01em",
  },
  stopAddr: {
    fontSize: 13, color: "var(--color-label-mute)", overflow: "hidden",
    textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 2, fontWeight: 600,
  },
  tagCurrent: {
    fontSize: 13, background: "var(--color-primary-soft)", color: "var(--color-primary-deep)",
    borderRadius: 999, padding: "5px 12px", flexShrink: 0, fontWeight: 800,
  },
  tagNext: {
    fontSize: 13, background: "var(--color-atomic-orange-90)", color: "#B95300",
    borderRadius: 999, padding: "5px 12px", flexShrink: 0, fontWeight: 800,
  },

  qrNotice: {
    background: "var(--color-atomic-orange-90)", borderRadius: "var(--radius-12)",
    padding: "16px 18px", display: "flex", alignItems: "center", gap: 12, color: "#B95300",
  },
  qrNoticeTitle: { fontSize: 13, fontWeight: 700, marginBottom: 4 },
  qrNoticeSub: { fontSize: 12, color: "#B95300", opacity: 0.85 },
  qrGuide: { fontSize: 12, color: "var(--color-label-mute)", textAlign: "center" },
  qrBox: {
    background: "#fff", borderRadius: "var(--radius-16)", padding: 16,
    display: "inline-block", boxShadow: "var(--shadow-strong)",
  },
  qrPlaceholder: {
    width: 220, height: 220, display: "flex", alignItems: "center",
    justifyContent: "center", color: "var(--color-label-mute)", fontSize: 12,
  },
  qrRouteBox: {
    background: "var(--color-bg)", borderRadius: "var(--radius-12)", padding: "10px 16px",
    textAlign: "center", width: "100%", boxShadow: "var(--shadow-emphasize)",
  },
  qrRouteLabel: { fontSize: 11, color: "var(--color-label-mute)", marginBottom: 4 },
  qrRouteVal: { fontSize: 14, fontWeight: 700, color: "var(--color-primary)" },
  qrAutoNote: { fontSize: 11, color: "var(--color-cautionary)", textAlign: "center", fontWeight: 600 },
  refreshBtn: {
    border: "1px solid var(--color-line)", borderRadius: "var(--radius-12)",
    padding: "12px", color: "var(--color-label)", fontSize: 13, fontWeight: 700,
    cursor: "pointer", fontFamily: "inherit", background: "var(--color-bg)", width: "100%",
  },

  // 하단 운행 종료 바 (목업: 검정 sticky)
  bottomBar: {
    position: "fixed", left: 0, right: 0, bottom: 0, padding: "12px 16px 20px",
    background: "linear-gradient(to top, var(--color-bg-alt) 60%, rgba(247,247,248,0))",
    display: "flex", justifyContent: "center",
  },
  endBtn: {
    width: "100%", maxWidth: 420, padding: "18px 0", borderRadius: "var(--radius-16)",
    border: "none", background: "var(--color-label)", color: "#fff", fontSize: 16,
    fontWeight: 800, fontFamily: "inherit", boxShadow: "var(--shadow-heavy)",
    display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
    cursor: "pointer",
  },
};

// ─── 기사용 승객 QR 스캔 컴포넌트 (passenger-qr 모드, 2026-05-27) ─────
// 직원이 본인 폰에서 발행한 passengerTokens QR을 기사 폰 카메라로 스캔.
// EmployeeApp ScanTab 카메라 로직(getUserMedia+jsQR 루프) 패턴 차용.
// 성공 시 3초 success 토스트 → 자동 다음 스캔 모드(연속 탑승).
function DriverPassengerScan({ companyId, driver, dispatch, currentStop }) {
  const [step, setStep] = useState("ready"); // ready|scanning|processing|success|error
  const [errMsg, setErrMsg] = useState("");
  const [boarded, setBoarded] = useState(null); // { empNo, name } 성공 토스트용
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const activeRef = useRef(false);

  // 언마운트 시 카메라 정리
  useEffect(() => {
    return () => { activeRef.current = false; stopStream(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopStream = () => {
    activeRef.current = false;
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
  };

  const startScan = async () => {
    setErrMsg("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      streamRef.current = stream;
      setStep("scanning");
      await new Promise(r => setTimeout(r, 100));
      if (!videoRef.current) throw new Error("카메라 화면을 초기화할 수 없습니다");
      videoRef.current.srcObject = stream;
      await videoRef.current.play().catch(() => {});
      activeRef.current = true;
      tick();
    } catch (e) {
      stopStream();
      setErrMsg(
        e.name === "NotAllowedError"
          ? "카메라 권한을 허용해주세요.\n브라우저 주소창 왼쪽 자물쇠 아이콘 → 카메라 허용"
          : "카메라 오류: " + e.message
      );
      setStep("error");
    }
  };

  const tick = () => {
    if (!activeRef.current) return;
    const video = videoRef.current;
    if (!video || video.readyState < 2 || !video.videoWidth) {
      rafRef.current = requestAnimationFrame(tick);
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0);
    let imageData;
    try { imageData = ctx.getImageData(0, 0, canvas.width, canvas.height); }
    catch { rafRef.current = requestAnimationFrame(tick); return; }
    const code = jsQR(imageData.data, canvas.width, canvas.height, { inversionAttempts: "attemptBoth" });
    if (code?.data) {
      activeRef.current = false;
      stopStream();
      handleScanned(code.data);
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  };

  const handleScanned = async (rawValue) => {
    setStep("processing");
    try {
      // 페이로드 = JSON { v:1, t:"passenger", tokenId, companyId, empNo }
      let payload;
      try { payload = JSON.parse(rawValue.trim()); }
      catch { throw new Error("승객 QR 형식이 아닙니다"); }
      if (payload?.t !== "passenger" || !payload?.tokenId) {
        throw new Error("승객 QR 형식이 아닙니다");
      }
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
      const r = await validateAndBoardByDriver({
        tokenId: payload.tokenId,
        driverId: driver?.id || "",
        companyId,
        routeId: dispatch?.routeId || "",
        routeName: dispatch?.routeName || "",
        vehicleId: dispatch?.vehicleId || driver?.vehicleId || "",
        vehicleNo: dispatch?.vehicleNo || driver?.vehicleNo || "",
        dispatchDate: today,
        stopId: currentStop?.id || "",
        stopName: currentStop?.name || "",
      });
      if ("vibrate" in navigator) navigator.vibrate([100, 50, 100]);
      setBoarded({ empNo: r.empNo, name: r.name });
      setStep("success");
      // 3초 후 자동 다음 스캔 모드 복귀(연속 탑승)
      setTimeout(() => { setBoarded(null); setStep("ready"); startScan(); }, 3000);
    } catch (e) {
      setErrMsg(e.message || String(e));
      setStep("error");
    }
  };

  const reset = () => {
    stopStream();
    setStep("ready"); setErrMsg(""); setBoarded(null);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, width: "100%" }}>
      {step === "ready" && (
        <>
          <div style={{ width: 90, height: 90, borderRadius: "50%", background: "var(--color-primary-soft)", border: "2px solid var(--color-primary)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 40 }}>📷</div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: "var(--color-label)", marginBottom: 4 }}>탑승 QR 스캔</div>
            <div style={{ fontSize: 12, color: "var(--color-label-mute)", lineHeight: 1.5 }}>
              직원의 본인 QR을 카메라로 비춰주세요
            </div>
          </div>
          <button onClick={startScan} style={{ ...S.primaryBtn, maxWidth: 280 }}>
            <Icon name="qr" size={18} /> 카메라 열기
          </button>
        </>
      )}

      {step === "scanning" && (
        <div style={{ width: "100%", maxWidth: 360 }}>
          <div style={{ position: "relative", borderRadius: 20, overflow: "hidden", background: "#000", aspectRatio: "1/1" }}>
            <video ref={videoRef} autoPlay playsInline muted
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
            {/* 오버레이 — EmployeeApp ScanTab 패턴 동일 */}
            <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
              <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: "18%", background: "rgba(0,0,0,.6)" }} />
              <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: "18%", background: "rgba(0,0,0,.6)" }} />
              <div style={{ position: "absolute", top: "18%", left: 0, width: "10%", height: "64%", background: "rgba(0,0,0,.6)" }} />
              <div style={{ position: "absolute", top: "18%", right: 0, width: "10%", height: "64%", background: "rgba(0,0,0,.6)" }} />
              <div style={{ position: "absolute", top: "18%", left: "10%", width: 30, height: 30, borderTop: "3px solid var(--color-primary)", borderLeft: "3px solid var(--color-primary)", borderRadius: "6px 0 0 0" }} />
              <div style={{ position: "absolute", top: "18%", right: "10%", width: 30, height: 30, borderTop: "3px solid var(--color-primary)", borderRight: "3px solid var(--color-primary)", borderRadius: "0 6px 0 0" }} />
              <div style={{ position: "absolute", bottom: "18%", left: "10%", width: 30, height: 30, borderBottom: "3px solid var(--color-primary)", borderLeft: "3px solid var(--color-primary)", borderRadius: "0 0 0 6px" }} />
              <div style={{ position: "absolute", bottom: "18%", right: "10%", width: 30, height: 30, borderBottom: "3px solid var(--color-primary)", borderRight: "3px solid var(--color-primary)", borderRadius: "0 0 6px 0" }} />
            </div>
          </div>
          <div style={{ textAlign: "center", marginTop: 12, fontSize: 13, color: "var(--color-primary)", fontWeight: 600 }}>
            직원의 QR을 사각형 안에 맞춰주세요
          </div>
          <button onClick={reset} style={{ ...S.refreshBtn, marginTop: 10 }}>취소</button>
        </div>
      )}

      {step === "processing" && (
        <>
          <div style={{ width: 36, height: 36, borderRadius: "50%", border: "3px solid var(--color-line)", borderTopColor: "var(--color-primary)", animation: "spin 0.8s linear infinite" }} />
          <div style={{ fontSize: 13, color: "var(--color-label-mute)" }}>탑승 처리 중...</div>
        </>
      )}

      {step === "success" && boarded && (
        <>
          <div style={{ width: 80, height: 80, borderRadius: "50%", background: "#E6F7EB", border: "2px solid var(--color-positive)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 36, color: "#007A29" }}>✓</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "#007A29" }}>탑승 완료!</div>
          <div style={{ fontSize: 14, color: "var(--color-label)", fontWeight: 700 }}>
            {boarded.name} ({boarded.empNo})
          </div>
          <div style={{ fontSize: 11, color: "var(--color-label-alt)" }}>잠시 후 다음 스캔을 시작합니다…</div>
        </>
      )}

      {step === "error" && (
        <>
          <div style={{ width: 72, height: 72, borderRadius: "50%", background: "var(--color-atomic-red-90)", border: "2px solid var(--color-destructive)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 32, color: "var(--color-destructive)" }}>✕</div>
          <div style={{ fontSize: 16, fontWeight: 800, color: "var(--color-destructive)" }}>오류</div>
          <div style={{ fontSize: 13, color: "var(--color-label-mute)", textAlign: "center", whiteSpace: "pre-line", lineHeight: 1.6 }}>{errMsg}</div>
          <button onClick={reset} style={{ ...S.primaryBtn, maxWidth: 280 }}>다시 시도</button>
        </>
      )}
    </div>
  );
}
