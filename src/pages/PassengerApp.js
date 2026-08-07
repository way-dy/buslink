import { useState, useEffect, useRef } from "react";
import { Map, MapMarker, Polyline, CustomOverlayMap } from "react-kakao-maps-sdk";
import { db, auth } from "../firebase";
import { signInAnonymously } from "firebase/auth";
import { collection, onSnapshot, query, where, doc, getDoc, getDocs, orderBy } from "firebase/firestore";
import { useAnimatedPositions } from "../lib/useAnimatedPositions";
import { computeRouteWindow, isWithinRouteWindow, normalizeWindowOpts, nowMinutesKST } from "../lib/routeWindow";
import { calcETA } from "../lib/gps";
import { buildCumulativeLengths, projectToPolyline, pathUpTo, pathFrom } from "../lib/routeProgress";
import { computeStopEstimates, formatDelayLabel, formatPassengerEta, describeEtaSource } from "../lib/stopSchedule";
import { useSmoothedEta } from "../lib/useSmoothedEta";
import { useWakeTick } from "../lib/useWakeTick";
import { useOnlineRecover } from "../lib/useOnlineRecover";
import { forceReconnect } from "../lib/forceReconnect";
import { BusLinkLogo, Pill, StatusDot, Icon } from "../components/ui";
import { resolveCompanyIdForAnon } from "../lib/companyResolver";
import { useExitConfirm } from "../lib/useExitConfirm";
import { sortRoutes } from "../lib/routeOrder";

// ── 경로 진행 판정 임계값 (작업2, 2026-05-18 — EmployeeApp과 동일 정책) ──
const OFF_ROUTE_M = 70;       // 버스 투영 수직거리 초과 시 경로 이탈로 보고 직전 진행 유지
const PASSED_MARGIN_M = 40;   // busProgress > myStopProgress + 마진 → 지나감
const ARRIVING_M = 150;       // 남은 경로거리 < 이 값 → 곧 도착
const TRAVELED_COLOR = "#9AA3B2"; // 지나온 경로 회색(Polyline strokeColor는 SDK prop)

// 리디자인 2단계(2026-05-16): 라이트 테마 리스킨.
// ── 로직 100% 불변: getParam(c/route/r)·signInAnonymously·회사/노선/정류장
//    getDoc/getDocs·onSnapshot gps 구독·useAnimatedPositions(rAF 보간)
//    ·calcETA·react-kakao-maps-sdk Map/MapMarker/Polyline/CustomOverlayMap
//    초기화·myStopIdx/selected/center state·timeSince/formatTime·App.js
//    /bus 분기 전부 그대로. 마크업/스타일(S 객체)만 다크 → tokens.css 라이트.
// ── 목업 design/src/screens-mobile.jsx PassengerApp 의 "시각 언어"만 차용:
//    풀스크린 맵 + 상단 상태바 카드 + 부유 ETA 카드(큰 카운트다운) +
//    정류장 진행바 + 하단 시트. 카카오맵 마커/CustomOverlay 구조는 유지하고
//    카드/오버레이/시트/ETA 스타일만 차용(목업 MapMock·BusMarker 가짜 — 미도입).
//    목업의 가짜 QR/전화 버튼·"오늘 다른 일정"은 실제 기능 없어 도입 안 함 —
//    실제 buses/stops/eta 데이터만 리스킨.
function getParam(key) {
  return new URLSearchParams(window.location.search).get(key);
}

// 기준 노선 localStorage 키 — 회사별 구분(멀티테넌트 대비, 단일 dy001도 안전)
const routeStoreKey = (cid) => `buslink_passenger_route_${cid}`;
function loadSavedRoute(cid) {
  try { return window.localStorage.getItem(routeStoreKey(cid)) || null; }
  catch { return null; }
}
function saveRoute(cid, rid) {
  try {
    if (rid) window.localStorage.setItem(routeStoreKey(cid), rid);
    else window.localStorage.removeItem(routeStoreKey(cid));
  } catch { /* localStorage 미가용(시크릿/제한) — 무시, 세션 내 동작은 유지 */ }
}

export default function PassengerApp() {
  // 뒤로가기 종료 확인(마운트 시 1회 발판 push, 인증/로딩 분기와 무관).
  useExitConfirm();
  // Phase 1.1 (2026-05-28): URL param > hostname 매핑 > dy001.
  // PassengerApp 의 localStorage 키 `buslink_passenger_route_{cid}` 는 노선 저장용
  // (companyId 분리 키 없음 — 키 자체에 cid 가 들어있어 chicken-and-egg). URL+hostname 만.
  const companyId = resolveCompanyIdForAnon({ urlParam: getParam("c") });
  // 노선 결정 우선순위: ① URL route/r 파라미터(딥링크 — 동작 보존) ② localStorage 기준노선 ③ null(노선 선택 화면)
  const urlRouteId = getParam("route") || getParam("r"); // route=routeId 또는 r=routeId
  const [selectedRouteId, setSelectedRouteId] = useState(
    () => urlRouteId || loadSavedRoute(companyId)
  );
  const routeId = selectedRouteId; // 기존 코드 호환: 이하 로직은 routeId 그대로 사용

  const [ready, setReady] = useState(false);
  const [company, setCompany] = useState(null);
  const [route, setRoute] = useState(null);
  const [stops, setStops] = useState([]);
  const [rawBuses, setRawBuses] = useState([]);
  const busesRaw = useAnimatedPositions(rawBuses);
  // 노선 표시 시간창(2026-08-05 회의 #2·#3) — 직원앱 HomeTab 과 같은 판정.
  // 창 없음(출발시각·표시시간 미설정)이면 게이트 없음 = 예전 동작 보존.
  const routeWindow = computeRouteWindow(route, stops, normalizeWindowOpts(company));
  const windowOpen = isWithinRouteWindow(routeWindow, nowMinutesKST());
  const buses = windowOpen ? busesRaw : [];
  const [selected, setSelected] = useState(null);
  const [myStopIdx, setMyStopIdx] = useState(null); // 내 정류장 인덱스
  const [photoView, setPhotoView] = useState(null); // 정류장 사진 라이트박스(data URI)
  const [center, setCenter] = useState({ lat: 37.3894, lng: 126.9522 });
  const [lastUpdate, setLastUpdate] = useState(null);
  const [routeList, setRouteList] = useState([]);     // 회사 노선 목록(선택 UI용)
  const [showPicker, setShowPicker] = useState(false); // 노선 변경 모달 표시
  const [routeQuery, setRouteQuery] = useState("");    // 노선 검색어
  const lastBusProgressRef = useRef(null); // 경로 이탈 시 직전 유효 진행거리 유지

  // 백그라운드(전날부터 등)에서 깨어났을 때 onSnapshot 강제 재구독 — 모바일/PWA에서
  // 탭 frozen 후 stale 리스너 살아나는 듯하나 새 doc 변경 못 받음. wakeTick deps로
  // unsub→재구독 → Firestore가 현재 docs 즉시 fire → state 신선화.
  const wakeTick = useWakeTick();
  // 통신 끊김→복구(online 전이) 시 Firestore reconnect 강제 + onSnapshot 재구독.
  // wakeTick(visibilitychange)와 별개 트리거 — 탭은 켜진 채 데이터망만 끊겼다 복구한 케이스.
  const recoverTick = useOnlineRecover({ forceFirestoreReconnect: true });
  const [manualTick, setManualTick] = useState(0);     // 새로고침 버튼 → onSnapshot 재구독
  const [refreshing, setRefreshing] = useState(false);

  // 노선 새로고침(#2) — Firestore 강제 재연결 + GPS/dispatch onSnapshot 재구독.
  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    await forceReconnect();
    setManualTick(t => t + 1);
    setLastUpdate(new Date());
    setTimeout(() => setRefreshing(false), 600);
  };

  // 노선 선택 확정 — active 노선 설정 + localStorage 저장(다음 방문 자동) + 재바인딩
  const chooseRoute = (rid) => {
    setSelectedRouteId(rid);
    saveRoute(companyId, rid);
    setRoute(null);
    setStops([]);
    setMyStopIdx(null);
    setSelected(null);
    setShowPicker(false);
    setRouteQuery("");
  };

  // 익명 로그인
  useEffect(() => {
    signInAnonymously(auth)
      .then(() => setReady(true))
      .catch(() => setReady(true));
  }, []);

  // 회사 정보
  useEffect(() => {
    if (!ready) return;
    getDoc(doc(db, "companies", companyId)).then(snap => {
      if (snap.exists()) setCompany(snap.data());
    });
  }, [companyId, ready]);

  // 회사 노선 목록 — 노선 선택/변경 UI용. 단일 컬렉션이라 복합인덱스 불요(클라 정렬)
  useEffect(() => {
    if (!ready) return;
    return onSnapshot(collection(db, "companies", companyId, "routes"), (snap) => {
      // 관리자가 노선 관리에서 정한 표시 순서(order) → 출발시각 → 노선명 (2026-07-10)
      setRouteList(sortRoutes(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
    }, () => setRouteList([])); // 권한/네트워크 오류 시 우아 실패(딥링크 동작은 영향 없음)
  }, [companyId, ready]);

  // 노선 + 정류장 로드
  useEffect(() => {
    if (!ready || !routeId) return;
    getDoc(doc(db, "companies", companyId, "routes", routeId)).then(snap => {
      if (snap.exists()) setRoute({ id: snap.id, ...snap.data() });
    });
    getDocs(query(
      collection(db, "companies", companyId, "routes", routeId, "stops"),
      orderBy("order", "asc")
    )).then(snap => {
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setStops(list);
      if (list.length > 0) setCenter({ lat: list[0].lat, lng: list[0].lng });
    });
  }, [companyId, routeId, ready]);

  // 실시간 버스 위치 구독 — wakeTick 으로 백그라운드 복귀 시 재구독.
  useEffect(() => {
    if (!ready) return;
    const q = query(collection(db, "gps"), where("companyId", "==", companyId));
    return onSnapshot(q, (snap) => {
      let list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      // routeId가 있으면 해당 노선 버스만
      if (routeId) list = list.filter(b => b.routeId === routeId);
      setRawBuses(list);
      setLastUpdate(new Date());
      if (list.length > 0 && list[0].lat && list[0].lng && !routeId)
        setCenter({ lat: list[0].lat, lng: list[0].lng });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, routeId, ready, wakeTick, recoverTick, manualTick]);

  // 오늘 dispatch stopArrivals 구독(routeId 한정) — 정류장 리스트 계획·예상 시간 표시용.
  const [todayDispatch, setTodayDispatch] = useState(null);
  useEffect(() => {
    if (!ready || !routeId) { setTodayDispatch(null); return; }
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
    const q = query(
      collection(db, "companies", companyId, "dispatches", today, "list"),
      where("routeId", "==", routeId)
    );
    return onSnapshot(q, snap => {
      if (snap.empty) { setTodayDispatch(null); return; }
      const merged = {};
      snap.docs.forEach(d => {
        const sa = d.data().stopArrivals || {};
        Object.entries(sa).forEach(([sid, v]) => {
          const at = v?.actualAt?.toMillis ? v.actualAt.toMillis() : (typeof v?.actualAt === 'number' ? v.actualAt : null);
          if (at == null) return;
          if (merged[sid] == null || at < merged[sid]) merged[sid] = at;
        });
      });
      setTodayDispatch({ stopArrivals: merged });
    }, () => setTodayDispatch(null));
    // (manualTick: 노선 새로고침 버튼 재구독)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, routeId, ready, wakeTick, recoverTick, manualTick]);

  const timeSince = (date) => {
    if (!date) return "";
    const sec = Math.floor((new Date() - date) / 1000);
    if (sec < 10) return "방금 전";
    if (sec < 60) return `${sec}초 전`;
    if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
    return `${Math.floor(sec / 3600)}시간 전`;
  };

  const formatTime = (ts) => {
    if (!ts) return "–";
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  };

  // 주요 버스 (선택됐거나 첫 번째)
  const mainBus = selected || (buses.length > 0 ? buses[0] : null);

  // ── 사전 경로(routePath) 우선, 없으면 stops 직선 폴백(하위호환 필수) ──
  const preDrawnPath = Array.isArray(route?.routePath)
    ? route.routePath.filter(p => typeof p?.lat === 'number' && typeof p?.lng === 'number')
    : [];
  const usePathProgress = preDrawnPath.length >= 2;
  const routePath = usePathProgress
    ? preDrawnPath
    : stops.map(s => ({ lat: s.lat, lng: s.lng }));
  const routeCum = usePathProgress ? buildCumulativeLengths(routePath) : null;

  // 버스를 경로에 투영 — 이탈(수직거리>OFF_ROUTE_M) 시 직전 유효 진행거리 유지
  const busProj = (usePathProgress && mainBus)
    ? projectToPolyline({ lat: mainBus.lat, lng: mainBus.lng }, routePath, routeCum) : null;
  let busProgress = null;
  if (busProj) {
    if (busProj.perpDist <= OFF_ROUTE_M) {
      busProgress = busProj.progress;
      lastBusProgressRef.current = busProgress;
    } else {
      busProgress = lastBusProgressRef.current; // 이탈 좌표 제외
    }
  }
  const myStopProgress = (usePathProgress && myStopIdx !== null && stops[myStopIdx])
    ? projectToPolyline({ lat: stops[myStopIdx].lat, lng: stops[myStopIdx].lng }, routePath, routeCum)?.progress
    : null;

  // ── 정류장 estimates(계획 + 누적지연 + GPS 가중, 다음 1개) ──
  // routePath 없으면 GPS 가중도 직선거리 폴백. offsetMin 미설정 정류장은 unplanned 처리.
  const stopEstimates = computeStopEstimates({
    stops,
    departTime: route?.departTime,
    actualArrivals: todayDispatch?.stopArrivals || {},
    vehiclePos: mainBus ? { lat: mainBus.lat, lng: mainBus.lng } : null,
    speed: mainBus?.speed,
    routePath: usePathProgress ? routePath : null,
  });
  const estByStopId = Object.fromEntries(stopEstimates.map(e => [e.stopId, e]));

  // 내 정류장까지 ETA — routePath 있으면 경로거리 기반, 없으면 기존 직선 calcETA(폴백)
  const getMyETA = () => {
    if (!mainBus || myStopIdx === null || !stops[myStopIdx]) return null;
    if (usePathProgress && busProgress !== null && myStopProgress !== null) {
      const remain = myStopProgress - busProgress;
      if (busProgress > myStopProgress + PASSED_MARGIN_M) return null; // 지나감
      const speed = (mainBus.speed > 5 ? mainBus.speed : 30);
      return Math.ceil((Math.max(remain, 0) / 1000) / speed * 60);
    }
    return calcETA(
      { lat: mainBus.lat, lng: mainBus.lng },
      stops[myStopIdx],
      mainBus.speed
    );
  };

  // 내 정류장까지 ETA(초 단위 raw) — useSmoothedEta 입력용. 2026-05-21 도착 안정화.
  // myStopEst의 estimatedAt(plan+delay+GPS 30:70)이 정본 우선 — 분 단위 ceil 점프
  // 회피·myStopEst 미존재(offsetMin 미설정) 시 routePath 또는 직선 폴백.
  const getMyETASec = () => {
    if (!mainBus || myStopIdx === null || !stops[myStopIdx]) return null;
    const myStopId = stops[myStopIdx].id;
    const e = estByStopId[myStopId];
    if (e && e.estimatedAt && e.status !== 'unplanned' && e.status !== 'arrived') {
      const base = new Date(); base.setHours(0, 0, 0, 0);
      const m = e.estimatedAt.match(/^(\d{2}):(\d{2})$/);
      if (m) {
        const arriveMs = base.getTime() + (+m[1] * 60 + +m[2]) * 60 * 1000;
        const diff = Math.round((arriveMs - Date.now()) / 1000);
        if (diff > -60 && diff < 6 * 3600) return Math.max(0, diff);
      }
    }
    if (usePathProgress && busProgress !== null && myStopProgress !== null) {
      const remain = myStopProgress - busProgress;
      if (busProgress > myStopProgress + PASSED_MARGIN_M) return null;
      const speed = (mainBus.speed > 5 ? mainBus.speed : 30);
      return Math.max(0, (remain / 1000) / speed * 3600);
    }
    // 폴백: 직선거리
    const stop = stops[myStopIdx];
    const R = 6371000;
    const dLat = (stop.lat - mainBus.lat) * Math.PI / 180;
    const dLng = (stop.lng - mainBus.lng) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(mainBus.lat * Math.PI / 180) * Math.cos(stop.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    const dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const speed = (mainBus.speed > 5 ? mainBus.speed : 30);
    return Math.max(0, (dist / 1000) / speed * 3600);
  };

  // 노선 검색 필터 (노선명·거래처명·구분)
  const filteredRoutes = routeList.filter(r => {
    const q = routeQuery.trim().toLowerCase();
    if (!q) return true;
    return [r.name, r.partnerName, r.type, r.code].some(
      v => (v || "").toString().toLowerCase().includes(q)
    );
  });

  // 노선 목록 카드 렌더 (선택 화면 / 변경 모달 공유)
  const renderRouteList = () => (
    <>
      {routeList.length > 6 && (
        <input
          style={S.routeSearch}
          placeholder="노선명·협력사·구분 검색"
          value={routeQuery}
          onChange={e => setRouteQuery(e.target.value)}
        />
      )}
      <div style={S.routeListBox}>
        {filteredRoutes.length === 0 ? (
          <div style={S.emptyMsg}>
            <div style={{ fontSize: 30, marginBottom: 6 }}>🚏</div>
            <div style={{ fontWeight: 700, color: "var(--color-label)" }}>
              {routeList.length === 0 ? "등록된 노선이 없습니다" : "검색 결과가 없습니다"}
            </div>
          </div>
        ) : filteredRoutes.map(r => (
          <div key={r.id} onClick={() => chooseRoute(r.id)}
            style={{
              ...S.routeItem,
              border: selectedRouteId === r.id
                ? "1px solid var(--color-primary)" : "1px solid var(--color-line)",
              background: selectedRouteId === r.id
                ? "var(--color-primary-soft)" : "var(--color-bg)",
            }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={S.routeItemTop}>
                <span style={{
                  ...S.routeTypeBadge,
                  background: r.type === "출근" ? "var(--color-primary-soft)" : "#FFF1E0",
                  color: r.type === "출근" ? "var(--color-primary-deep)" : "#B95300",
                }}>{r.type || "노선"}</span>
                <span style={S.routeItemName}>{r.name || r.id}</span>
              </div>
              <div style={S.routeItemMeta}>
                {r.departTime && <span>🕒 {r.departTime}</span>}
                {r.partnerName && <span>· {r.partnerName}</span>}
                {r.shift && <span>· {r.shift}</span>}
              </div>
            </div>
            {selectedRouteId === r.id && <span style={S.tagMyStop}>현재</span>}
          </div>
        ))}
      </div>
    </>
  );

  // ── 훅 호출 순서 고정(early return 전): useSmoothedEta 위치 ──
  // raw 초 산출은 myStopIdx/stops 의존 — 조건 미충족이면 null 반환되어 훅이 reset.
  // React rules-of-hooks: 조건부 호출 금지(early return 뒤에 두면 hook 순서 위반).
  const myStopRawSec = getMyETASec();
  const smoothedMyEtaSec = useSmoothedEta(myStopRawSec);

  // ── ArrivalProximityModal (2026-05-28) ──────────────────────────────────
  // 내 정류장(myStopIdx) 직전 정류장(myStopIdx-1)이 stopArrivals에 새로 등장(actualAt
  // 최근 5분 이내)하면 풀스크린 모달로 "곧 도착" 안내. 1회만(dismissed) + 새 routeId
  // 변경 시 reset. myStopIdx==0이면 직전 없음=비표시. notifyPreArrival CF FCM과 별도
  // 인-앱 보장 통로(중복 무해 — NoticeForceModal 패턴 준용).
  const [proximityModal, setProximityModal] = useState(null); // { stopName } | null
  const proximityDismissedRef = useRef(new Set()); // 이 routeId 안에서 이미 dismiss 한 stopId
  // route 변경 시 dismissed reset.
  useEffect(() => {
    proximityDismissedRef.current = new Set();
    setProximityModal(null);
  }, [routeId]);
  // 직전 정류장 도착 감지.
  useEffect(() => {
    if (myStopIdx === null || myStopIdx <= 0 || stops.length === 0) return;
    const prevStop = stops[myStopIdx - 1];
    if (!prevStop) return;
    const sa = todayDispatch?.stopArrivals || {};
    const arrivedMs = sa[prevStop.id];
    if (arrivedMs == null) return;
    // 최근 5분 이내 도착만 트리거(과거 도착으로 모달 갑자기 뜨는 결함 방지).
    if (Date.now() - arrivedMs > 5 * 60 * 1000) return;
    if (proximityDismissedRef.current.has(prevStop.id)) return;
    setProximityModal({ stopName: prevStop.name });
  }, [myStopIdx, stops, todayDispatch?.stopArrivals]);
  const closeProximityModal = () => {
    if (proximityModal && stops[myStopIdx - 1]) {
      proximityDismissedRef.current.add(stops[myStopIdx - 1].id);
    }
    setProximityModal(null);
  };

  if (!ready) return (
    <div style={S.fullCenter}>
      <div style={{ color: "var(--color-primary)", fontSize: 16, fontWeight: 600 }}>로딩 중...</div>
    </div>
  );

  // 노선 미선택(URL 파라미터·저장 기준노선 모두 없음) → 노선 선택 화면
  if (!routeId) return (
    <div style={S.pickerScreen}>
      <div style={S.pickerHead}>
        <BusLinkLogo size={20} />
        <div style={{ marginTop: 14 }}>
          <div style={S.pickerTitle}>{company?.name || "BusLink"}</div>
          <div style={S.pickerSub}>탑승하실 노선을 선택하세요</div>
        </div>
      </div>
      <div style={S.pickerBody}>{renderRouteList()}</div>
    </div>
  );

  const eta = getMyETA();
  const myStop = myStopIdx !== null ? stops[myStopIdx] : null;
  const myPassengerLabel = (eta !== null && smoothedMyEtaSec != null)
    ? formatPassengerEta(smoothedMyEtaSec)
    : null;
  const myStopEst = myStop ? estByStopId[myStop.id] : null;
  // 마지막 정류장 = 도착지(=회사, 탑승자 없음). 이 정류장 선택 시에만
  // ETA 카드 문구를 "목적지 도착" 류로 대체(표시 문자열만 분기, eta 로직 불변).
  const isDestStop = stops.length >= 2 && myStopIdx === stops.length - 1;
  // 진행률 — 노선 모드에서 내 정류장 기준(시각 전용, 실제 stops 인덱스 기반)
  const progressPct = (myStopIdx !== null && stops.length > 1)
    ? Math.round((myStopIdx / (stops.length - 1)) * 100)
    : 0;

  // [DIAG-ETA 제거예정] URL ?debug=1 일 때만 노출. prod 영향 0.
  const diagEnabled = getParam("debug") === "1";
  // [/DIAG-ETA]

  return (
    <div style={S.wrap}>
      {/* 풀스크린 지도 (카카오맵 — 구조 불변) */}
      <div style={S.mapLayer}>
        <Map center={center} style={{ width: "100%", height: "100%" }} level={routeId ? 9 : 7}
          onCenterChanged={map => {}}>

          {/* 노선 폴리라인 — routePath 진행 모드면 지나온(회색)/남은(파랑) 분할, 아니면 단일 파랑(폴백) */}
          {routePath.length >= 2 && usePathProgress && busProgress !== null ? (
            <>
              {(() => { const t = pathUpTo(routePath, routeCum, busProgress); return t.length >= 2 ? (
                <Polyline path={t} strokeWeight={5} strokeColor={TRAVELED_COLOR} strokeOpacity={0.7} strokeStyle="solid" />
              ) : null; })()}
              {(() => { const r = pathFrom(routePath, routeCum, busProgress); return r.length >= 2 ? (
                <Polyline path={r} strokeWeight={5} strokeColor="#0066FF" strokeOpacity={0.85} strokeStyle="solid" />
              ) : null; })()}
            </>
          ) : routePath.length >= 2 ? (
            <Polyline path={routePath} strokeWeight={5} strokeColor="#0066FF" strokeOpacity={0.85} strokeStyle="solid" />
          ) : null}

          {/* 정류장 마커 */}
          {stops.map((s, i) => (
            <MapMarker key={s.id} position={{ lat: s.lat, lng: s.lng }}
              onClick={() => { setMyStopIdx(i); setCenter({ lat: s.lat, lng: s.lng }); }}
              image={{
                src: myStopIdx === i
                  ? "https://t1.daumcdn.net/localimg/localimages/07/mapapidoc/markerStar.png"
                  : "https://t1.daumcdn.net/localimg/localimages/07/mapapidoc/marker_red.png",
                size: myStopIdx === i ? { width:24, height:35 } : { width:18, height:26 }
              }}
            />
          ))}

          {/* 정류장 번호 오버레이 — 계획·예상시각(offsetMin 설정 시) 둘째 줄 표시. */}
          {stops.map((s, i) => {
            const isMyStop = myStopIdx === i;
            const est = estByStopId[s.id];
            let timeLabel = null, timeColor = null;
            if (est) {
              if (est.status === 'arrived' && est.estimatedAt) {
                timeLabel = `도착 ${est.estimatedAt}`;
                timeColor = isMyStop ? 'rgba(255,255,255,0.92)' : 'var(--color-positive)';
              } else if (est.status === 'next' && est.estimatedAt) {
                timeLabel = `예상 ${est.estimatedAt}`;
                timeColor = isMyStop ? '#fff' : 'var(--color-primary-deep)';
              } else if (est.status === 'upcoming' && est.plannedAt) {
                timeLabel = est.plannedAt;
                timeColor = isMyStop ? 'rgba(255,255,255,0.92)' : 'var(--color-label-mute)';
              } else if (est.estimatedAt) {
                // 2026-05-26: offsetMin 미설정(status='unplanned')이지만 chain 전파된 예상시각 보유.
                timeLabel = `예상 ${est.estimatedAt}`;
                timeColor = isMyStop ? 'rgba(255,255,255,0.92)' : 'var(--color-label-mute)';
              }
            }
            return (
              <CustomOverlayMap key={`ov-${s.id}`} position={{ lat: s.lat, lng: s.lng }} yAnchor={2.8}>
                <div style={{
                  background: isMyStop ? "var(--color-primary)" : "#fff",
                  color: isMyStop ? "#fff" : "var(--color-label)",
                  borderRadius: 12, padding: "3px 9px",
                  border: `1px solid ${isMyStop ? "var(--color-primary)" : "rgba(112,115,124,0.18)"}`,
                  whiteSpace: "nowrap", boxShadow: "0 1px 3px rgba(23,23,23,0.12)",
                  textAlign: "center", lineHeight: 1.25,
                }}>
                  <div style={{ fontSize: 10, fontWeight: 700 }}>{i+1}. {s.name}</div>
                  {/* #5 — 도착/예상시각은 선택한 내 정류장에만 표시(전 정류장 표시 클러터 제거) */}
                  {timeLabel && isMyStop && (
                    <div style={{ fontSize: 11, fontWeight: 700, color: timeColor, marginTop: 1 }}>{timeLabel}</div>
                  )}
                </div>
              </CustomOverlayMap>
            );
          })}

          {/* 버스 마커 — 펄스 ring + 키운 pill (정지 시에도 시인성). 클릭 색반전 유지. */}
          {buses.map(b => b.lat && b.lng && (
            // #4 — yAnchor 0.5(중심 정렬)로 버스 pill 을 노선 라인 위에 안착(이전 1.5=라인보다 위로 뜸).
            <CustomOverlayMap key={b.id} position={{ lat: b.lat, lng: b.lng }} yAnchor={0.5}>
              <div style={{ position: "relative", display: "inline-block" }}>
                <span style={{
                  position: "absolute", inset: -2, borderRadius: 999,
                  background: "var(--color-primary)", opacity: 0.45,
                  animation: "buspulse 2s ease-out infinite", pointerEvents: "none"
                }} />
                <div onClick={() => setSelected(b === selected ? null : b)}
                  style={{
                    position: "relative",
                    background: selected?.id === b.id ? "var(--color-primary)" : "#fff",
                    border: `3px solid var(--color-primary)`,
                    borderRadius: 999, padding: "7px 14px", cursor: "pointer",
                    display: "flex", alignItems: "center", gap: 8,
                    boxShadow: "0 6px 20px rgba(0,102,255,0.45)",
                  }}>
                  <span style={{ fontSize: 22 }}>🚌</span>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 800, color: selected?.id === b.id ? "#fff" : "var(--color-label)" }}>{b.vehicleNo || b.id}</div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: selected?.id === b.id ? "rgba(255,255,255,0.85)" : "var(--color-label-mute)" }}>{b.speed ?? 0} km/h</div>
                  </div>
                </div>
              </div>
            </CustomOverlayMap>
          ))}
        </Map>

        {/* 내 정류장 선택 안내 (노선 모드) */}
        {route && stops.length > 0 && myStopIdx === null && (
          <div style={S.pickHint}>
            <Icon name="pin" size={14} /> 내 탑승 정류장을 클릭하면 ETA를 확인할 수 있습니다
          </div>
        )}

        {/* [DIAG-ETA 제거예정] PassengerApp 진단 — URL ?debug=1 일 때만.
            본인 정류장 한정(myStopIdx). prod 영향 0(URL 파라미터 없으면 미렌더). */}
        {diagEnabled && myStopIdx !== null && stops[myStopIdx] && (() => {
          const e = estByStopId[stops[myStopIdx].id];
          if (!e) return null;
          const delayMin = e.delaySec != null ? Math.round(e.delaySec / 60) : null;
          const delayLab = delayMin == null ? "—"
            : delayMin === 0 ? "0분"
            : delayMin > 0 ? `+${delayMin}분`
            : `${delayMin}분`;
          const segProg = (typeof busProgress === "number" && myStopProgress != null && myStopIdx > 0)
            ? (() => {
                const prev = stops[myStopIdx - 1];
                const prevProj = projectToPolyline({ lat: prev.lat, lng: prev.lng }, routePath, routeCum);
                if (!prevProj) return null;
                const sa = prevProj.progress, sb = myStopProgress;
                if (sb <= sa) return null;
                const ratio = (busProgress - sa) / (sb - sa);
                return Math.max(0, Math.min(1, ratio));
              })()
            : null;
          return (
            <div style={{
              position: "absolute", left: 8, right: 8, top: 60, zIndex: 5,
              padding: 8, borderRadius: 8,
              background: "#FFFBEA", border: "1px dashed #C99A2E",
              fontSize: 10, fontFamily: "monospace", lineHeight: 1.5,
              color: "#3a2e08",
            }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>[DIAG-ETA] 내 정류장 진단</div>
              <div>[{myStopIdx}] {stops[myStopIdx].name}</div>
              <div>plan {e.plannedAt || "—"} | est {e.estimatedAt || "—"} | delay {delayLab}</div>
              <div>status {e.status} | source {e.source}</div>
              <div>busProgress={typeof busProgress === "number" ? Math.round(busProgress) + "m" : "—"}
                {" | "}myStopProgress={myStopProgress != null ? Math.round(myStopProgress) + "m" : "—"}
                {segProg != null && <> | segProgress={(segProg * 100).toFixed(1)}%</>}
              </div>
              <div>speed={mainBus?.speed != null ? mainBus.speed.toFixed(1) + "km/h" : "—"}</div>
            </div>
          );
        })()}
        {/* [/DIAG-ETA] */}
      </div>

      {/* 상단 상태바 카드 (목업: 부유 상단 카드) */}
      <div style={S.topBar}>
        <div style={S.topCard}>
          <BusLinkLogo size={16} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={S.topLabel}>
              {route ? "오늘 노선" : "실시간 위치"}
            </div>
            <div style={S.topTitle}>
              {company?.name || "BusLink"}
              {route && <span style={{ fontWeight: 600, color: "var(--color-label-mute)" }}> · {route.name}</span>}
            </div>
          </div>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
            {buses.length > 0 && <StatusDot tone="positive" size={7} pulse />}
            <span style={{ fontSize: 12, fontWeight: 700, color: buses.length > 0 ? "var(--color-positive)" : "var(--color-label-mute)" }}>
              {buses.length > 0 ? `${buses.length}대 운행` : "운행 없음"}
            </span>
          </span>
        </div>
        {/* 노선 변경 + 새로고침(#2) 진입점 */}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={() => { setRouteQuery(""); setShowPicker(true); }} style={S.changeRouteBtn}>
            <Icon name="route" size={13} /> 노선 변경
          </button>
          <button onClick={handleRefresh} disabled={refreshing}
            style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "5px 11px", borderRadius: "var(--radius-pill)", border: "1px solid var(--color-line)", cursor: refreshing ? "default" : "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 700, background: "var(--color-bg-soft)", color: "var(--color-label-mute)", opacity: refreshing ? 0.6 : 1 }}>
            <span style={{ display: "inline-block", animation: refreshing ? "blspin 0.8s linear infinite" : "none" }}>↻</span>
            {refreshing ? "새로고침 중" : "새로고침"}
          </button>
        </div>
      </div>

      {/* 노선 변경 모달 — 선택 시 chooseRoute로 기준노선 갱신·재바인딩 */}
      {showPicker && (
        <div onClick={() => setShowPicker(false)} style={S.pickerModalBack}>
          <div onClick={e => e.stopPropagation()} style={S.pickerModal}>
            <div style={S.pickerModalHead}>
              <span style={{ fontSize: 15, fontWeight: 800 }}>노선 변경</span>
              <button onClick={() => setShowPicker(false)} style={S.pickerModalClose}>✕</button>
            </div>
            {renderRouteList()}
          </div>
        </div>
      )}

      {/* 부유 ETA 카드 — 노선 모드 + 내 정류장 선택 시 (큰 카운트다운) */}
      {route && myStop && (
        <div style={S.etaCard}>
          <div style={S.etaTop}>
            <Pill tone={eta !== null && eta <= 5 ? "danger" : "primary"} dot>
              {isDestStop ? "목적지" : "도착 카운트다운"}
            </Pill>
            <span style={S.etaLive}>
              {lastUpdate ? `${timeSince(lastUpdate)} 갱신` : "실시간"}
            </span>
          </div>

          {eta !== null && myPassengerLabel ? (
            isDestStop ? (
              <div style={{ ...S.etaBig, alignItems: "center", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 22, fontWeight: 800, color: myPassengerLabel.bucket === 'soon' || (smoothedMyEtaSec != null && smoothedMyEtaSec <= 300) ? "var(--color-destructive)" : "var(--color-primary)" }}>
                  {myPassengerLabel.bucket === 'soon' ? '🏁 목적지 도착' : `목적지까지 ${myPassengerLabel.primary}`}
                </span>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--color-label-mute)" }}>
                  {myPassengerLabel.bucket === 'soon' ? "하차해 주세요" : "목적지로 이동 중"}
                  {myPassengerLabel.precise && myPassengerLabel.bucket !== 'time' && myPassengerLabel.bucket !== 'soon' && (
                    <> · {myPassengerLabel.precise} 예상</>
                  )}
                </span>
              </div>
            ) : (
            <div style={{ ...S.etaBig, flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
              <span style={{ fontSize: 38, fontWeight: 900, color: smoothedMyEtaSec != null && smoothedMyEtaSec <= 300 ? "var(--color-destructive)" : "var(--color-primary)", lineHeight: 1.05 }}>
                {myPassengerLabel.primary}
              </span>
              {myPassengerLabel.precise && myPassengerLabel.bucket !== 'time' && (
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--color-label-mute)" }}>
                  {myPassengerLabel.precise} 예상
                  {myStopEst && (() => {
                    const src = describeEtaSource(myStopEst.source);
                    return src ? <> · <span style={{ color: "var(--color-label-alt)" }}>{src}</span></> : null;
                  })()}
                </span>
              )}
            </div>
            )
          ) : (
            <div style={{ ...S.etaBig, alignItems: "center" }}>
              <span style={{ fontSize: 22, fontWeight: 700, color: "var(--color-label-mute)" }}>버스 운행 대기 중</span>
            </div>
          )}

          <div style={S.etaStopRow}>
            <Icon name="pin" size={16} />
            <span><strong style={{ color: "var(--color-label)" }}>{myStop.name}</strong>에서 탑승</span>
            <button onClick={() => setMyStopIdx(null)} style={S.etaChangeBtn}>변경</button>
          </div>

          {/* 정류장 진행바 (실제 myStopIdx 인덱스 기반) */}
          <div style={S.progressTrack}>
            <div style={{ ...S.progressFill, width: `${progressPct}%` }}>
              <div style={S.progressKnob} />
            </div>
          </div>
          <div style={S.progressMeta}>
            <span>{isDestStop ? "도착지" : "출발 정류장"}</span>
            <span>{myStopIdx + 1} / {stops.length} 정류장</span>
          </div>
        </div>
      )}

      {/* 하단 시트 — 정류장 목록 또는 버스 목록 */}
      <div style={S.bottomSheet}>
        <div style={S.sheetHandle} />

        {routeId && stops.length > 0 ? (
          /* 정류장 목록 모드 */
          <>
            <div style={S.sheetTitle}>
              <span>정류장 목록 ({stops.length})</span>
              {lastUpdate && <span style={S.updateTime}>{timeSince(lastUpdate)} 갱신</span>}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {stops.map((s, i) => (
                <div key={s.id} onClick={() => { setMyStopIdx(i); setCenter({ lat: s.lat, lng: s.lng }); }}
                  style={{
                    ...S.stopItem,
                    background: myStopIdx === i ? "var(--color-primary-soft)" : "transparent",
                    border: `1px solid ${myStopIdx === i ? "var(--color-primary)" : "transparent"}`,
                  }}>
                  <div style={{
                    ...S.stopBadge,
                    background: myStopIdx === i ? "var(--color-primary)" : "#fff",
                    color: myStopIdx === i ? "#fff" : "var(--color-label-mute)",
                    border: `1.5px solid ${myStopIdx === i ? "var(--color-primary)" : "var(--color-atomic-coolNeutral-90)"}`,
                  }}>
                    {i+1}
                  </div>
                  {s.photo && (
                    <img src={s.photo} alt={`${s.name} 정류장`}
                      onClick={(e) => { e.stopPropagation(); setPhotoView({ src: s.photo, name: s.name, desc: s.description }); }}
                      style={S.stopThumb}/>
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      ...S.stopItemName,
                      fontWeight: myStopIdx === i ? 700 : 600,
                      color: myStopIdx === i ? "var(--color-primary-deep)" : "var(--color-label)",
                    }}>
                      {s.name}
                    </div>
                    {s.address && <div style={S.stopItemAddr}>{s.address}</div>}
                    {s.description && <div style={S.stopItemDesc}>{s.description}</div>}
                    {/* 계획·예상시각 — plannedAt 또는 chain-propagated estimatedAt 보유 정류장. */}
                    {(() => {
                      const e = estByStopId[s.id];
                      if (!e || (!e.plannedAt && !e.estimatedAt)) return null;
                      const lab = formatDelayLabel(e.delaySec);
                      const labColor = lab.tone === 'danger' ? 'var(--color-destructive)'
                        : lab.tone === 'warn' ? 'var(--color-cautionary)'
                        : 'var(--color-positive)';
                      const arrived = e.status === 'arrived';
                      return (
                        <div style={{ fontSize:11, marginTop:2, fontWeight:600, color:"var(--color-label-mute)" }}>
                          {arrived ? "도착 " : e.plannedAt ? "계획 " : "예상 "}
                          <span style={{ color: arrived ? 'var(--color-positive)' : 'var(--color-primary-deep)', fontWeight:700 }}>{arrived ? e.estimatedAt : (e.plannedAt || e.estimatedAt)}</span>
                          {!arrived && e.plannedAt && e.estimatedAt && e.estimatedAt !== e.plannedAt && (
                            <> · 예상 <span style={{ color: 'var(--color-primary-deep)', fontWeight:700 }}>{e.estimatedAt}</span></>
                          )}
                          {lab.label && lab.tone !== 'mute' && (
                            <> · <span style={{ color: labColor, fontWeight:700 }}>{lab.label}</span></>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                  {myStopIdx === i && (
                    <span style={S.tagMyStop}>내 정류장</span>
                  )}
                  {mainBus && myStopIdx === null && (
                    <span style={S.stopEta}>
                      {(() => {
                        // offsetMin 설정 + plan+delay 산출 가능 → estimatedAt(HH:MM) 우선 표시.
                        // 아니면 calcETA 폴백을 formatPassengerEta 버킷화 — 분 단위 깜빡임 흡수.
                        // 정류장이 많아 EMA 훅은 사용 안 함(버킷화로 자연 안정).
                        const e = estByStopId[s.id];
                        if (e && e.estimatedAt && e.status !== 'unplanned' && e.status !== 'arrived') {
                          return e.estimatedAt;
                        }
                        const m = calcETA({ lat: mainBus.lat, lng: mainBus.lng }, s, mainBus.speed);
                        if (m == null) return "–";
                        const lab = formatPassengerEta(m * 60);
                        return lab.primary;
                      })()}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </>
        ) : (
          /* 버스 목록 모드 */
          <>
            <div style={S.sheetTitle}>
              <span>운행 중인 버스</span>
              {lastUpdate && <span style={S.updateTime}>{timeSince(lastUpdate)} 갱신</span>}
            </div>
            {buses.length === 0 ? (
              <div style={S.emptyMsg}>
                <div style={{ fontSize: 34, marginBottom: 8 }}>🚌</div>
                <div style={{ fontWeight: 700, color: "var(--color-label)" }}>현재 운행 중인 버스가 없습니다</div>
                <div style={{ fontSize: 12, color: "var(--color-label-mute)", marginTop: 4 }}>운행이 시작되면 자동으로 표시됩니다</div>
              </div>
            ) : (
              <div style={S.busList}>
                {buses.map(b => (
                  <div key={b.id}
                    style={{ ...S.busCard, border: selected?.id === b.id ? "1px solid var(--color-primary)" : "1px solid var(--color-line)" }}
                    onClick={() => { setSelected(b === selected ? null : b); if (b.lat && b.lng) setCenter({ lat: b.lat, lng: b.lng }); }}>
                    <div style={S.busCardTop}>
                      <div style={S.busIcon}>🚌</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={S.busName}>{b.vehicleNo || b.id}</div>
                        <div style={S.busRoute}>{b.routeName || b.routeId || "노선 미지정"}</div>
                      </div>
                      <div style={S.busSpeed}>
                        <div style={S.speedNum}>{b.speed ?? 0}</div>
                        <div style={S.speedUnit}>km/h</div>
                      </div>
                    </div>
                    <div style={S.busCardBottom}>
                      <span style={S.busAccuracy}>정확도 ±{b.accuracy ?? "–"}m</span>
                      <span style={S.busTime}>갱신 {formatTime(b.updatedAt)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* ── 도착 임박 모달(2026-05-28) — 내 정류장 직전 정류장 도착 시 풀스크린 안내 ── */}
      {proximityModal && (
        <div onClick={closeProximityModal}
          style={{
            position: "fixed", inset: 0, background: "rgba(11,16,32,0.78)",
            zIndex: 300, display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center", padding: 24,
            backdropFilter: "blur(4px)",
          }}>
          <div onClick={e => e.stopPropagation()}
            style={{
              background: "var(--color-bg)", borderRadius: "var(--radius-24)",
              padding: "32px 24px 24px", width: "100%", maxWidth: 360,
              boxShadow: "var(--shadow-heavy)", textAlign: "center",
            }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>🚌</div>
            <div style={{ fontSize: 22, fontWeight: 900, color: "var(--color-primary)", marginBottom: 8 }}>
              곧 도착합니다
            </div>
            <div style={{ fontSize: 15, color: "var(--color-label)", lineHeight: 1.55, marginBottom: 20 }}>
              <span style={{ fontWeight: 800 }}>{proximityModal.stopName}</span>에 버스가 도착했어요.<br/>
              다음이 <span style={{ fontWeight: 800, color: "var(--color-primary-deep)" }}>내 정류장</span>입니다.<br/>
              <span style={{ fontSize: 13, color: "var(--color-label-mute)" }}>탑승 준비를 해주세요</span>
            </div>
            <button onClick={closeProximityModal}
              style={{
                width: "100%", background: "var(--color-primary)", color: "#fff",
                border: "none", borderRadius: "var(--radius-12)", padding: "14px 16px",
                fontSize: 15, fontWeight: 800, cursor: "pointer", fontFamily: "inherit",
                boxShadow: "var(--shadow-strong)",
              }}>
              확인
            </button>
          </div>
        </div>
      )}

      {/* 정류장 사진 라이트박스 — 위치 확인용 확대 보기 */}
      {photoView && (
        <div onClick={() => setPhotoView(null)} style={S.lightbox}>
          <div onClick={(e) => e.stopPropagation()} style={S.lightboxInner}>
            <img src={photoView.src} alt={`${photoView.name} 정류장`} style={S.lightboxImg}/>
            <div style={S.lightboxCaption}>
              <div style={{ fontWeight: 800, fontSize: 15 }}>{photoView.name}</div>
              {photoView.desc && <div style={{ fontSize: 13, color: "var(--color-label-mute)", marginTop: 4, lineHeight: 1.5 }}>{photoView.desc}</div>}
            </div>
            <button onClick={() => setPhotoView(null)} style={S.lightboxClose}>✕ 닫기</button>
          </div>
        </div>
      )}
    </div>
  );
}

// PassengerApp 한정 인라인 스타일. 색/라운드/그림자는 tokens.css 변수 기반(라이트).
const S = {
  fullCenter: {
    minHeight: "100vh", background: "var(--color-bg-alt)", display: "flex",
    alignItems: "center", justifyContent: "center", fontFamily: "var(--font-base)",
  },

  wrap: {
    position: "relative", height: "100vh", width: "100%", overflow: "hidden",
    background: "var(--color-bg-alt)", fontFamily: "var(--font-base)",
    color: "var(--color-label)",
  },

  // 풀스크린 지도
  mapLayer: { position: "absolute", inset: 0 },
  pickHint: {
    position: "absolute", bottom: 16, left: "50%", transform: "translateX(-50%)",
    background: "var(--color-label)", color: "#fff", borderRadius: 999,
    padding: "9px 16px", fontSize: 12, fontWeight: 600, zIndex: 5,
    whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 7,
    boxShadow: "var(--shadow-strong)",
  },

  // 상단 상태바 카드 (부유)
  topBar: { position: "absolute", top: 14, left: 14, right: 14, zIndex: 10 },
  topCard: {
    background: "var(--color-bg)", padding: "11px 14px", borderRadius: "var(--radius-16)",
    display: "flex", alignItems: "center", gap: 11, boxShadow: "var(--shadow-strong)",
  },
  topLabel: { fontSize: 11, color: "var(--color-label-mute)", fontWeight: 600 },
  topTitle: {
    fontSize: 14, fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis",
    whiteSpace: "nowrap", marginTop: 1,
  },

  // 부유 ETA 카드 (큰 카운트다운)
  etaCard: {
    position: "absolute", left: 14, right: 14, bottom: 178, zIndex: 10,
    background: "var(--color-bg)", borderRadius: "var(--radius-20)", padding: "20px",
    boxShadow: "var(--shadow-heavy)",
  },
  etaTop: { display: "flex", alignItems: "center", gap: 8 },
  etaLive: { fontSize: 11, color: "var(--color-label-mute)", marginLeft: "auto", fontWeight: 600 },
  etaBig: { display: "flex", alignItems: "baseline", gap: 6, marginTop: 12 },
  etaNum: {
    fontFamily: "var(--font-brand)", fontSize: 56, fontWeight: 900,
    letterSpacing: "-0.035em", lineHeight: 1,
  },
  etaUnit: { fontSize: 22, fontWeight: 700, color: "var(--color-label)" },
  etaSub: { fontSize: 14, color: "var(--color-label-mute)", marginLeft: 8 },
  etaStopRow: {
    display: "flex", alignItems: "center", gap: 10, marginTop: 12,
    color: "var(--color-label-mute)", fontSize: 14,
  },
  etaChangeBtn: {
    marginLeft: "auto", background: "var(--color-bg)", border: "1px solid var(--color-line)",
    borderRadius: "var(--radius-8)", padding: "5px 12px", color: "var(--color-label-mute)",
    fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
  },
  progressTrack: {
    marginTop: 16, height: 6, background: "var(--color-bg-soft)",
    borderRadius: 3, overflow: "visible",
  },
  progressFill: {
    height: "100%", background: "linear-gradient(90deg, var(--color-primary), var(--color-atomic-blue-50))",
    borderRadius: 3, position: "relative", transition: "width .4s ease",
  },
  progressKnob: {
    position: "absolute", right: -6, top: -3, width: 12, height: 12,
    borderRadius: "50%", background: "var(--color-primary)", border: "2px solid #fff",
  },
  progressMeta: {
    display: "flex", justifyContent: "space-between", marginTop: 10,
    fontSize: 11, color: "var(--color-label-mute)", fontFamily: "var(--font-mono)",
  },

  // 하단 시트
  bottomSheet: {
    position: "absolute", left: 0, right: 0, bottom: 0, zIndex: 10,
    background: "var(--color-bg)", borderTopLeftRadius: "var(--radius-24)",
    borderTopRightRadius: "var(--radius-24)", padding: "12px 18px 18px",
    boxShadow: "0 -8px 28px rgba(11,16,32,0.10)", maxHeight: "44vh", overflowY: "auto",
  },
  sheetHandle: {
    width: 36, height: 4, background: "var(--color-atomic-coolNeutral-90)",
    borderRadius: 2, margin: "0 auto 12px",
  },
  sheetTitle: {
    fontSize: 14, fontWeight: 800, marginBottom: 10, display: "flex",
    justifyContent: "space-between", alignItems: "center",
  },
  updateTime: { fontSize: 11, color: "var(--color-label-mute)", fontWeight: 600 },
  emptyMsg: { textAlign: "center", padding: "18px 0", color: "var(--color-label-mute)", fontSize: 14 },

  stopItem: {
    display: "flex", alignItems: "center", gap: 10, padding: "9px 10px",
    borderRadius: "var(--radius-12)", cursor: "pointer",
  },
  stopBadge: {
    width: 24, height: 24, borderRadius: "50%", display: "flex",
    alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700,
    flexShrink: 0,
  },
  stopItemName: {
    fontSize: 17, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  stopItemAddr: {
    fontSize: 11, color: "var(--color-label-mute)", overflow: "hidden",
    textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 1,
  },
  stopItemDesc: {
    fontSize: 11, color: "var(--color-label-mute)", marginTop: 2,
    lineHeight: 1.45, wordBreak: "keep-all",
  },
  stopThumb: {
    width: 42, height: 42, borderRadius: "var(--radius-8)", objectFit: "cover",
    flexShrink: 0, border: "1px solid var(--color-line)", cursor: "pointer",
  },
  lightbox: {
    position: "fixed", inset: 0, background: "rgba(11,16,32,0.82)", zIndex: 300,
    display: "flex", alignItems: "center", justifyContent: "center", padding: 18,
  },
  lightboxInner: {
    background: "var(--color-bg)", borderRadius: "var(--radius-12)",
    overflow: "hidden", maxWidth: 520, width: "100%", maxHeight: "88vh",
    display: "flex", flexDirection: "column",
  },
  lightboxImg: { width: "100%", maxHeight: "60vh", objectFit: "contain", background: "#000" },
  lightboxCaption: { padding: "14px 16px" },
  lightboxClose: {
    margin: "0 16px 16px", padding: "11px", border: "none",
    borderRadius: "var(--radius-8)", background: "var(--color-bg-soft)",
    color: "var(--color-label)", fontSize: 14, fontWeight: 700,
    cursor: "pointer", fontFamily: "inherit",
  },
  tagMyStop: {
    fontSize: 10, background: "var(--color-primary)", color: "#fff",
    borderRadius: 999, padding: "3px 9px", flexShrink: 0, fontWeight: 700,
  },
  stopEta: { fontSize: 11, color: "var(--color-primary)", flexShrink: 0, fontWeight: 700 },

  busList: { display: "flex", flexDirection: "column", gap: 8 },
  busCard: {
    background: "var(--color-bg-alt)", borderRadius: "var(--radius-12)",
    padding: "12px 14px", cursor: "pointer", transition: "border .15s",
  },
  busCardTop: { display: "flex", alignItems: "center", gap: 10 },
  busIcon: {
    fontSize: 20, width: 38, height: 38, background: "var(--color-primary-soft)",
    borderRadius: "var(--radius-12)", display: "flex", alignItems: "center",
    justifyContent: "center", flexShrink: 0,
  },
  busName: { fontSize: 14, fontWeight: 800 },
  busRoute: {
    fontSize: 11, color: "var(--color-label-mute)", marginTop: 2,
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  busSpeed: { textAlign: "center", flexShrink: 0 },
  speedNum: { fontSize: 20, fontWeight: 800, color: "var(--color-primary)", fontFamily: "var(--font-brand)" },
  speedUnit: { fontSize: 10, color: "var(--color-label-mute)" },
  busCardBottom: {
    display: "flex", justifyContent: "space-between", marginTop: 8,
    paddingTop: 8, borderTop: "1px solid var(--color-line)",
  },
  busAccuracy: { fontSize: 11, color: "var(--color-label-mute)" },
  busTime: { fontSize: 11, color: "var(--color-label-mute)" },

  // 노선 선택 화면 (미선택 시 풀스크린)
  pickerScreen: {
    minHeight: "100vh", background: "var(--color-bg-alt)",
    fontFamily: "var(--font-base)", color: "var(--color-label)",
    display: "flex", flexDirection: "column",
  },
  pickerHead: {
    background: "var(--color-bg)", padding: "28px 22px 22px",
    borderBottom: "1px solid var(--color-line)",
  },
  pickerTitle: { fontSize: 20, fontWeight: 800 },
  pickerSub: { fontSize: 13, color: "var(--color-label-mute)", marginTop: 4, fontWeight: 600 },
  pickerBody: { flex: 1, padding: "16px 18px 28px", overflowY: "auto" },

  // 노선 변경 버튼 (상단 카드 하단)
  changeRouteBtn: {
    marginTop: 8, width: "100%", background: "var(--color-bg)",
    border: "1px solid var(--color-line)", borderRadius: "var(--radius-12)",
    padding: "9px", color: "var(--color-primary)", fontSize: 12,
    fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
    boxShadow: "var(--shadow-strong)",
  },

  // 노선 변경 모달
  pickerModalBack: {
    position: "fixed", inset: 0, background: "rgba(11,16,32,0.5)", zIndex: 200,
    display: "flex", alignItems: "flex-end", justifyContent: "center",
  },
  pickerModal: {
    background: "var(--color-bg)", borderTopLeftRadius: "var(--radius-24)",
    borderTopRightRadius: "var(--radius-24)", padding: "16px 18px 22px",
    width: "100%", maxWidth: 560, maxHeight: "82vh",
    display: "flex", flexDirection: "column",
  },
  pickerModalHead: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    marginBottom: 12,
  },
  pickerModalClose: {
    background: "var(--color-bg-soft)", border: "none", borderRadius: "var(--radius-8)",
    width: 30, height: 30, fontSize: 14, cursor: "pointer",
    color: "var(--color-label-mute)", fontFamily: "inherit",
  },

  // 노선 목록 (선택 화면 / 변경 모달 공유)
  routeSearch: {
    width: "100%", padding: "10px 12px", borderRadius: "var(--radius-12)",
    border: "1px solid var(--color-line)", fontSize: 13, marginBottom: 10,
    fontFamily: "inherit", outline: "none", boxSizing: "border-box",
    background: "var(--color-bg-alt)", color: "var(--color-label)",
  },
  routeListBox: {
    display: "flex", flexDirection: "column", gap: 8, overflowY: "auto",
  },
  routeItem: {
    display: "flex", alignItems: "center", gap: 10, padding: "13px 14px",
    borderRadius: "var(--radius-12)", cursor: "pointer",
  },
  routeItemTop: { display: "flex", alignItems: "center", gap: 8 },
  routeTypeBadge: {
    fontSize: 10, fontWeight: 700, borderRadius: 999, padding: "3px 8px",
    flexShrink: 0,
  },
  routeItemName: {
    fontSize: 14, fontWeight: 700, overflow: "hidden",
    textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  routeItemMeta: {
    fontSize: 11, color: "var(--color-label-mute)", marginTop: 5,
    display: "flex", flexWrap: "wrap", gap: 6, fontWeight: 600,
  },
};
