import { useState, useEffect, useRef, useCallback } from "react";
import jsQR from "jsqr";
import { initNotifications, listenForegroundMessages } from "../lib/notifications";
import { Map, MapMarker, Polyline, CustomOverlayMap } from "react-kakao-maps-sdk";
import { db, auth } from "../firebase";
import { signInAnonymously } from "firebase/auth";
import {
  doc, getDoc, getDocs, collection, onSnapshot,
  query, where, orderBy, updateDoc
} from "firebase/firestore";
import { useAnimatedPositions } from "../lib/useAnimatedPositions";
import { calcETA } from "../lib/gps";
import { validateAndBoard } from "../lib/boarding";
import { hashPin } from "../lib/partner";
import { BusLinkLogo, StatusDot } from "../components/ui";

// ─── URL 파라미터 ──────────────────────────────────────
function getParam(k) {
  return new URLSearchParams(window.location.search).get(k);
}

// ─── localStorage 헬퍼 ────────────────────────────────
const LS_KEY = "buslink_employee";
function loadSession() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "null"); } catch { return null; }
}
function saveSession(data) {
  localStorage.setItem(LS_KEY, JSON.stringify(data));
}
function clearSession() {
  localStorage.removeItem(LS_KEY);
}

// ─── 탭 정의 ──────────────────────────────────────────
const TABS = [
  { id: "home",     icon: "🏠", label: "홈" },
  { id: "routes",   icon: "🗺", label: "노선" },
  { id: "scan",     icon: "📷", label: "탑승" },
  { id: "settings", icon: "⚙️", label: "설정" },
];

// ════════════════════════════════════════════════════════
export default function EmployeeApp() {
  const companyId = getParam("c") || "dy001";
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState(null);   // { empNo, name, dept, routeId, pinHash }
  const [tab, setTab] = useState("home");
  const [activeNotice, setActiveNotice] = useState(null); // 공지 배너

  // 익명 인증
  useEffect(() => {
    signInAnonymously(auth).finally(() => setReady(true));
  }, []);

  // 저장된 세션 복원
  useEffect(() => {
    if (!ready) return;
    const s = loadSession();
    if (s?.companyId === companyId) setSession(s);
  }, [ready, companyId]);

  const handleLogin = (s) => {
    const data = { ...s, companyId };
    saveSession(data);
    setSession(data);
  };

  const handleLogout = () => {
    clearSession();
    setSession(null);
    setTab("home");
  };

  // ── 공지 실시간 구독 ─────────────────────────────────
  useEffect(() => {
    if (!session?.companyId) return;
    return onSnapshot(
      query(
        collection(db, "companies", session.companyId, "notices"),
        where("active", "==", true),
        orderBy("createdAt", "desc")
      ),
      snap => {
        if (!snap.empty) setActiveNotice({ id: snap.docs[0].id, ...snap.docs[0].data() });
        else setActiveNotice(null);
      },
      err => console.warn("[공지 구독 오류]", err.message)
    );
  }, [session?.companyId]);

  // ── FCM 초기화 ───────────────────────────────────────
  useEffect(() => {
    if (!session?.empNo || !session?.companyId) return;
    initNotifications({ companyId: session.companyId, empNo: session.empNo })
      .catch(() => {});
    let unsubFn = () => {};
    listenForegroundMessages(msg => {
      setActiveNotice({ title: msg.title, body: msg.body, type: msg.type, id: Date.now() });
    }).then(fn => { unsubFn = fn || (() => {}); }).catch(() => {});
    return () => unsubFn();
  }, [session?.empNo]);

  if (!ready) return (
    <div style={S.fullCenter}>
      <div style={S.spinner} />
    </div>
  );

  if (!session) return <LoginScreen companyId={companyId} onLogin={handleLogin} />;

  return (
    <div style={S.appWrap}>
      {/* ── 공지 배너 ── */}
      {activeNotice && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, zIndex: 999,
          background: activeNotice.type === "emergency" ? "var(--color-destructive)" : "var(--color-primary)",
          padding: "10px 14px",
          display: "flex", alignItems: "flex-start", gap: 10,
          boxShadow: "var(--shadow-strong)",
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: "#fff", marginBottom: 2 }}>
              {activeNotice.type === "emergency" ? "🚨 긴급 공지" : "📢 공지"} · {activeNotice.title}
            </div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,.88)", lineHeight: 1.4 }}>
              {activeNotice.body}
            </div>
          </div>
          <button onClick={() => setActiveNotice(null)}
            style={{ background: "rgba(255,255,255,.25)", border: "none", borderRadius: 6,
              padding: "3px 8px", color: "#fff", fontSize: 12, cursor: "pointer",
              fontFamily: "inherit", flexShrink: 0, marginTop: 1 }}>
            ✕
          </button>
        </div>
      )}
      <div style={{ ...S.content, marginTop: activeNotice ? 60 : 0 }}>
        {tab === "home"     && <HomeTab companyId={companyId} session={session} onScanTab={() => setTab("scan")} onSessionUpdate={(s)=>{saveSession({...session,...s});setSession(p=>({...p,...s}));}} />}
        {tab === "routes"   && <RoutesTab companyId={companyId} session={session} onSessionUpdate={(s) => { saveSession({...session,...s}); setSession(p=>({...p,...s})); }} />}
        {tab === "scan"     && <ScanTab companyId={companyId} session={session} />}
        {tab === "settings" && <SettingsTab companyId={companyId} session={session} onLogout={handleLogout} onSessionUpdate={(s)=>{saveSession({...session,...s});setSession(p=>({...p,...s}));}} />}
      </div>

      <div style={S.tabBar}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{ ...S.tabBtn, color: tab === t.id ? "var(--color-primary)" : "var(--color-label-mute)" }}>
            <span style={{ fontSize: 20 }}>{t.icon}</span>
            <span style={{ fontSize: 10, fontWeight: tab === t.id ? 700 : 500 }}>{t.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════
// 로그인 화면
// ════════════════════════════════════════════════════════
function LoginScreen({ companyId, onLogin }) {
  const [empNo, setEmpNo] = useState("");
  const [pin, setPin] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [isFirst, setIsFirst] = useState(false);

  const handleSubmit = async () => {
    if (!empNo.trim() || pin.length < 4) return;
    setLoading(true); setError("");
    try {
      const ref = doc(db, "companies", companyId, "passengers", empNo.trim());
      const snap = await getDoc(ref);
      if (!snap.exists()) throw new Error("등록되지 않은 사번입니다\n담당자에게 문의하세요");
      const p = snap.data();
      if (!p.active) throw new Error("비활성화된 계정입니다");
      const hashed = await hashPin(pin);
      if (p.pinHash !== hashed) throw new Error("PIN이 올바르지 않습니다");
      onLogin({ empNo: p.empNo, name: p.name, dept: p.dept, routeId: p.routeId, pinHash: hashed, pinInitial: p.pinInitial, favorites: p.favorites || [] });
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  };

  return (
    <div style={S.fullCenter}>
      <div style={S.loginCard}>
        <div style={S.header}>
          <BusLinkLogo size={26} sub="직원 탑승 서비스" />
        </div>
        <div style={{ fontSize: 20, fontWeight: 800, color: "var(--color-label)", letterSpacing: "-0.02em", marginBottom: 4 }}>로그인</div>
        <div style={{ fontSize: 13, color: "var(--color-label-mute)", marginBottom: 18, lineHeight: 1.55 }}>
          사번과 PIN을 입력하세요<br/>
          <span style={{ color: "var(--color-cautionary)", fontWeight: 600 }}>초기 PIN: 000000 (첫 로그인 후 변경 필요)</span>
        </div>
        <input style={S.input} type="tel" inputMode="numeric" placeholder="사번"
          value={empNo} onChange={e => setEmpNo(e.target.value)} autoFocus />
        <input style={{ ...S.input, marginTop: 10 }} type="password" inputMode="numeric"
          placeholder="PIN (4~6자리)" maxLength={6}
          value={pin} onChange={e => setPin(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleSubmit()} />
        {error && <div style={S.errorMsg}>{error}</div>}
        <button style={{ ...S.btn, marginTop: 14, opacity: (!empNo || pin.length < 4 || loading) ? 0.5 : 1, cursor: (!empNo || pin.length < 4 || loading) ? "not-allowed" : "pointer" }}
          onClick={handleSubmit} disabled={!empNo || pin.length < 4 || loading}>
          {loading ? "확인 중..." : "로그인"}
        </button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════
// 홈 탭 — 내 노선 버스 위치 + ETA
// ════════════════════════════════════════════════════════
function HomeTab({ companyId, session, onScanTab, onSessionUpdate }) {
  const [routes, setRoutes]         = useState([]);
  const [activeRouteId, setActiveRouteId] = useState(session.routeId || null);
  const [stops, setStops]           = useState([]);
  const [myStopIdx, setMyStopIdx]   = useState(null);
  const [rawBuses, setRawBuses]     = useState([]);
  const [center, setCenter]         = useState({ lat: 37.3894, lng: 126.9522 });
  const [mapLevel, setMapLevel]     = useState(9);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [tick, setTick]             = useState(0);
  const [allRoutes, setAllRoutes]   = useState([]);    // 노선 변경 모달용 전체 노선
  const [routePicker, setRoutePicker] = useState(false); // 노선 변경 모달 표시
  const [routeQuery, setRouteQuery] = useState("");    // 노선 검색어
  const [stopInfo, setStopInfo]     = useState(null);  // 지도 정류장 클릭 정보 카드
  const buses = useAnimatedPositions(rawBuses);
  const favorites = session.favorites || [];

  useEffect(() => {
    const t = setInterval(() => setTick(x => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // 노선 목록 (배정 + 즐겨찾기). 동일 getDocs로 전체 노선(노선 변경 모달용)도 함께 보관
  useEffect(() => {
    if (!companyId) return;
    getDocs(collection(db, 'companies', companyId, 'routes')).then(snap => {
      const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setAllRoutes(all);
      const shown = all.filter(r => r.id === session.routeId || favorites.includes(r.id));
      setRoutes(shown.length > 0 ? shown : all.slice(0, 3));
      if (!activeRouteId && shown.length > 0) setActiveRouteId(shown[0].id);
    });
  }, [companyId, session.routeId]);

  // 기준 노선(session.routeId) 변경 시 활성 노선·내 정류장 재바인딩
  useEffect(() => {
    if (session.routeId) { setActiveRouteId(session.routeId); setMyStopIdx(null); }
  }, [session.routeId]);

  // 노선 변경 확정 — 기준 노선 갱신 + localStorage 영속(다음 로그인까지 유지) + 재바인딩
  const chooseRoute = (rid) => {
    onSessionUpdate({ routeId: rid });   // saveSession으로 localStorage 자동 영속
    setActiveRouteId(rid);
    setMyStopIdx(null);
    setStops([]);
    setStopInfo(null);
    setRoutePicker(false);
    setRouteQuery("");
  };

  // 노선 변경 모달 검색 필터 (노선명·구분·코드·거래처)
  const filteredAllRoutes = allRoutes.filter(r => {
    const q = routeQuery.trim().toLowerCase();
    if (!q) return true;
    return [r.name, r.type, r.code, r.partnerName].some(v => (v || "").toString().toLowerCase().includes(q));
  });

  // 정류장 로드
  useEffect(() => {
    if (!activeRouteId || !companyId) return;
    setStops([]);
    getDocs(query(
      collection(db, 'companies', companyId, 'routes', activeRouteId, 'stops'),
      orderBy('order', 'asc')
    )).then(snap => {
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setStops(list);
      if (list.length > 0) setCenter({ lat: list[0].lat, lng: list[0].lng });
    });
  }, [activeRouteId, companyId]);

  // 실시간 GPS
  useEffect(() => {
    if (!companyId) return;
    const q = query(collection(db, 'gps'), where('companyId', '==', companyId));
    return onSnapshot(q, snap => {
      let list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (activeRouteId) list = list.filter(b => b.routeId === activeRouteId);
      setRawBuses(list);
      setLastUpdate(new Date());
    });
  }, [companyId, activeRouteId]);

  const mainBus   = buses[0] || null;
  const myStop    = myStopIdx !== null ? stops[myStopIdx] : null;
  const routePath = stops.map(s => ({ lat: s.lat, lng: s.lng }));
  const activeRoute = routes.find(r => r.id === activeRouteId) || allRoutes.find(r => r.id === activeRouteId);

  // ── 노선 순서 기반 ETA 상태 계산 ──────────────────────
  // 버스 → 가장 가까운 정류장 인덱스 (이미 아래에 busStopIdx로 계산됨)
  // busStopIdx를 먼저 계산해서 etaStatus에서 사용
  const _busStopIdx = (() => {
    if (!mainBus || stops.length === 0) return -1;
    let minDist = Infinity, idx = 0;
    stops.forEach((s, i) => {
      const d = Math.hypot(s.lat - mainBus.lat, s.lng - mainBus.lng);
      if (d < minDist) { minDist = d; idx = i; }
    });
    return idx;
  })();

  // 버스와 내 정류장의 직선 거리(m) 계산
  const _distToMyStop = mainBus && myStop ? (() => {
    const R = 6371000;
    const dLat = (myStop.lat - mainBus.lat) * Math.PI / 180;
    const dLng = (myStop.lng - mainBus.lng) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(mainBus.lat*Math.PI/180)*Math.cos(myStop.lat*Math.PI/180)*Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  })() : null;

  // ★ 핵심 — 노선 순서로 상태 판단
  const etaStatus = (() => {
    if (!mainBus || myStopIdx === null) return { type: 'waiting' };        // 버스 없음
    if (_distToMyStop !== null && _distToMyStop < 150) return { type: 'arriving' }; // 150m 이내 = 곧 도착
    if (_busStopIdx > myStopIdx) return { type: 'passed' };               // 버스가 내 정류장 지남
    if (_busStopIdx < myStopIdx) {
      const eta = calcETA({ lat: mainBus.lat, lng: mainBus.lng }, myStop, mainBus.speed);
      return { type: 'approaching', eta };                                  // 접근 중
    }
    return { type: 'arriving' };                                           // 동일 정류장
  })();

  // 표시용 색상
  const etaColor = etaStatus.type === 'passed'
    ? 'var(--color-cautionary)'
    : etaStatus.type === 'arriving'
      ? 'var(--color-destructive)'
      : etaStatus.eta !== undefined && etaStatus.eta <= 3
        ? 'var(--color-destructive)'
        : etaStatus.eta !== undefined && etaStatus.eta <= 10
          ? 'var(--color-cautionary)'
          : 'var(--color-primary)';

  // 버스와 내 정류장 사이로 지도 중심 설정
  useEffect(() => {
    if (mainBus?.lat && myStop?.lat) {
      setCenter({ lat: (mainBus.lat + myStop.lat) / 2, lng: (mainBus.lng + myStop.lng) / 2 });
    } else if (myStop?.lat) {
      setCenter({ lat: myStop.lat, lng: myStop.lng });
    } else if (mainBus?.lat) {
      setCenter({ lat: mainBus.lat, lng: mainBus.lng });
    }
  }, [mainBus?.lat, mainBus?.lng, myStop?.lat, myStop?.lng]);

  const timeSince = d => {
    if (!d) return '';
    const s = Math.floor((new Date() - d) / 1000);
    return s < 10 ? '방금' : s < 60 ? `${s}초 전` : `${Math.floor(s/60)}분 전`;
  };

  // _busStopIdx 는 위 etaStatus 블록에서 이미 계산됨
  const busStopIdx = _busStopIdx;

  // 마지막 정류장 = 도착지(=회사, 탑승자 없음). 이 정류장을 내 정류장으로
  // 선택했을 때만 하단 ETA 패널 문구를 "목적지 도착" 류로 대체(표시 문자열만 분기).
  const isDestStop = stops.length >= 2 && myStopIdx === stops.length - 1;
  // 표시 색상: 도착지에서 passed(=목적지 도착 완료)는 cautionary가 부적절 → positive.
  // 그 외는 기존 etaColor 로직 그대로(비-도착지 픽셀 불변).
  const etaDisplayColor = isDestStop && etaStatus.type === 'passed'
    ? 'var(--color-positive)'
    : etaColor;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--color-bg-alt)' }}>

      {/* ── 상단 헤더 ── */}
      <div style={{ background: 'var(--color-bg)', padding: '10px 14px', flexShrink: 0, borderBottom: '1px solid var(--color-line)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-label)' }}>
            {session.name}
            <span style={{ fontSize: 12, color: 'var(--color-label-mute)', fontWeight: 500, marginLeft: 6 }}>{session.dept}</span>
          </div>
          <div style={{ fontSize: 10, color: 'var(--color-label-alt)', textAlign: 'right' }}>
            {lastUpdate && <>{timeSince(lastUpdate)} 갱신<br/></>}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 2, color: buses.length > 0 ? 'var(--color-positive)' : 'var(--color-label-mute)', fontWeight: 600 }}>
              <StatusDot tone={buses.length > 0 ? 'positive' : 'neutral'} size={7} pulse={buses.length > 0} />
              {buses.length > 0 ? `${buses.length}대 운행중` : '운행 없음'}
            </span>
          </div>
        </div>
        {/* 현재 노선 + 노선 변경 진입점 (기준 노선 갱신) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <div style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 700, color: 'var(--color-label)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {activeRoute ? activeRoute.name : '노선을 선택하세요'}
          </div>
          <button onClick={() => { setRouteQuery(''); setRoutePicker(true); }}
            style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 13px', borderRadius: 'var(--radius-pill)', border: '1px solid var(--color-primary)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, fontWeight: 700, background: 'var(--color-primary-soft)', color: 'var(--color-primary-deep)' }}>
            🔄 노선 변경
          </button>
        </div>
        {/* 노선 칩 (배정+즐겨찾기 복수일 때 — 빠른 전환, 영속 아님) */}
        {routes.length > 1 && (
          <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginTop: 8, paddingBottom: 2 }}>
            {routes.map(r => (
              <button key={r.id} onClick={() => { setActiveRouteId(r.id); setMyStopIdx(null); }}
                style={{ flexShrink: 0, padding: '4px 12px', borderRadius: 'var(--radius-pill)', border: `1px solid ${activeRouteId === r.id ? 'var(--color-primary)' : 'var(--color-line)'}`, cursor: 'pointer',
                  fontFamily: 'inherit', fontSize: 11, fontWeight: 600,
                  background: activeRouteId === r.id ? 'var(--color-primary)' : 'var(--color-bg-soft)',
                  color: activeRouteId === r.id ? '#fff' : 'var(--color-label-mute)' }}>
                {r.name.length > 14 ? r.name.substring(0,14)+'…' : r.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── 지도 (상단 55%) ── */}
      <div style={{ flex: '0 0 55%', minHeight: 0, position: 'relative' }}>
        <Map center={center} style={{ width: '100%', height: '100%' }} level={mapLevel}
          onZoomChanged={map => setMapLevel(map.getLevel())}>

          {/* 노선 폴리라인 */}
          {routePath.length >= 2 && (
            <Polyline path={routePath} strokeWeight={5} strokeColor="#0066FF" strokeOpacity={0.75} strokeStyle="solid" />
          )}

          {/* 정류장 마커 — 클릭 시 정류장 정보 카드 */}
          {stops.map((s, i) => {
            const isMyStop = myStopIdx === i;
            const isFirst  = i === 0;
            const isLast   = i === stops.length - 1;
            return (
              <MapMarker key={s.id} position={{ lat: s.lat, lng: s.lng }}
                onClick={() => setStopInfo({ ...s, idx: i })}
                image={{
                  src: isMyStop
                    ? 'https://t1.daumcdn.net/localimg/localimages/07/mapapidoc/markerStar.png'
                    : 'https://t1.daumcdn.net/localimg/localimages/07/mapapidoc/marker_red.png',
                  size: isMyStop ? { width: 24, height: 35 } : isFirst||isLast ? { width: 18, height: 26 } : { width: 12, height: 18 }
                }}
              />
            );
          })}

          {/* 모든 정류장 이름 레이블 — 출발/도착/내 정류장 강조, 중간 정류장 소형. 클릭 시 정보 */}
          {stops.map((s, i) => {
            const isMyStop = myStopIdx === i;
            const isFirst  = i === 0;
            const isLast   = i === stops.length - 1;
            const emphasize = isMyStop || isFirst || isLast;
            return (
              <CustomOverlayMap key={`lbl-${s.id}`} position={{ lat: s.lat, lng: s.lng }} yAnchor={isMyStop ? 3.6 : emphasize ? 3.1 : 2.5}>
                <div onClick={() => setStopInfo({ ...s, idx: i })}
                  style={ emphasize ? {
                    background: isMyStop ? 'var(--color-primary)' : isFirst ? 'var(--color-positive)' : 'var(--color-destructive)',
                    color: '#fff', borderRadius: 10, padding: '3px 9px',
                    fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap',
                    boxShadow: 'var(--shadow-float)', cursor: 'pointer'
                  } : {
                    background: 'var(--color-bg)', color: 'var(--color-label-mute)',
                    border: '1px solid var(--color-line)', borderRadius: 8,
                    padding: '1px 6px', fontSize: 9, fontWeight: 600, whiteSpace: 'nowrap',
                    maxWidth: 88, overflow: 'hidden', textOverflow: 'ellipsis',
                    boxShadow: 'var(--shadow-emphasize)', cursor: 'pointer'
                  }}>
                  {isMyStop ? '📍 ' : isFirst ? '출 ' : isLast ? '도 ' : ''}{s.name.length > 10 ? s.name.substring(0,10)+'…' : s.name}
                </div>
              </CustomOverlayMap>
            );
          })}

          {/* 버스 마커 — 작은 원형 아이콘 */}
          {buses.map(b => b.lat && b.lng && (
            <CustomOverlayMap key={b.id} position={{ lat: b.lat, lng: b.lng }} yAnchor={1.5}>
              <div style={{
                background: 'var(--color-primary)', border: '2px solid #fff',
                borderRadius: '50%', width: 20, height: 20,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, boxShadow: '0 0 0 3px rgba(0,102,255,.30), var(--shadow-float)',
                cursor: 'default'
              }}>
                🚌
              </div>
            </CustomOverlayMap>
          ))}
        </Map>

        {/* 정류장 미선택 안내 */}
        {stops.length > 0 && myStopIdx === null && (
          <div style={{
            position: 'absolute', bottom: 10, left: '50%', transform: 'translateX(-50%)',
            background: 'var(--color-bg)', border: '1.5px solid var(--color-primary)',
            borderRadius: 'var(--radius-pill)', padding: '7px 16px',
            fontSize: 11, color: 'var(--color-primary)', fontWeight: 700, zIndex: 5, whiteSpace: 'nowrap',
            boxShadow: 'var(--shadow-float)'
          }}>
            📍 아래 노선도에서 내 정류장을 클릭하세요
          </div>
        )}
      </div>

      {/* ── 노선도 스트립 (중간) ── */}
      <div style={{ background: 'var(--color-bg)', borderTop: '1px solid var(--color-line)', borderBottom: '1px solid var(--color-line)', flexShrink: 0, padding: '10px 0' }}>
        {stops.length === 0 ? (
          <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--color-label-alt)', padding: '4px 0' }}>
            {activeRoute ? '정류장 정보가 없습니다' : '노선을 선택해주세요'}
          </div>
        ) : (
          <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', paddingBottom: 4 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', paddingLeft: 16, paddingRight: 16, minWidth: 'max-content', gap: 0 }}>
              {stops.map((s, i) => {
                const isMyStop  = myStopIdx === i;
                const isFirst   = i === 0;
                const isLast    = i === stops.length - 1;
                const isBusHere = busStopIdx === i;
                const isPassed  = myStopIdx !== null && i < myStopIdx && busStopIdx >= 0 && i <= busStopIdx;
                // 버스가 이 정류장과 다음 정류장 사이에 있는지 (노선도에 버스 아이콘 표시)
                const showBusBetween = busStopIdx === i && !isBusHere;

                return (
                  <div key={s.id} style={{ display: 'flex', alignItems: 'center' }}>
                    {/* 정류장 노드 */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 64 }}
                      onClick={() => { setMyStopIdx(i); setCenter({ lat: s.lat, lng: s.lng }); }}>
                      {/* 버스 아이콘 (이 정류장 근처) */}
                      <div style={{ height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 2 }}>
                        {isBusHere && (
                          <div style={{ background: 'var(--color-primary)', borderRadius: '50%', width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, boxShadow: '0 0 0 3px rgba(0,102,255,.25)' }}>🚌</div>
                        )}
                      </div>
                      {/* 정류장 원 */}
                      <div style={{
                        width: isMyStop ? 18 : isFirst||isLast ? 14 : 10,
                        height: isMyStop ? 18 : isFirst||isLast ? 14 : 10,
                        borderRadius: '50%', flexShrink: 0,
                        background: isMyStop ? 'var(--color-primary)' : isBusHere ? 'var(--color-primary)' : isFirst ? 'var(--color-positive)' : isLast ? 'var(--color-destructive)' : 'var(--color-primary)',
                        border: isMyStop ? '2px solid #fff' : '2px solid var(--color-bg)',
                        boxShadow: isMyStop ? '0 0 0 3px rgba(0,102,255,.30)' : 'var(--shadow-emphasize)',
                        cursor: 'pointer'
                      }} />
                      {/* 정류장 이름 */}
                      <div style={{
                        fontSize: 9, marginTop: 5, textAlign: 'center', width: 60,
                        color: isMyStop ? 'var(--color-primary)' : isFirst ? 'var(--color-positive)' : isLast ? 'var(--color-destructive)' : 'var(--color-label-mute)',
                        fontWeight: isMyStop ? 800 : isFirst||isLast ? 700 : 500,
                        wordBreak: 'keep-all', lineHeight: 1.3
                      }}>
                        {s.name}
                        {isMyStop && <div style={{ color: 'var(--color-primary)', fontSize: 8, fontWeight: 700 }}>내 정류장</div>}
                      </div>
                    </div>

                    {/* 연결선 (마지막 제외) */}
                    {!isLast && (
                      <div style={{
                        width: 28, height: 3, flexShrink: 0, marginTop: -22,
                        background: busStopIdx >= 0 && i < busStopIdx ? 'var(--color-primary)' : 'var(--color-line)',
                        borderRadius: 2, position: 'relative'
                      }}>
                        {/* 버스가 이 구간(i → i+1) 이동 중 */}
                        {busStopIdx === i && mainBus && (
                          <div style={{ position: 'absolute', top: -6, left: '40%', fontSize: 10, color: 'var(--color-primary)' }}>🚌</div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ── 하단 ETA + QR 패널 ── */}
      <div style={{ background: 'var(--color-bg)', flexShrink: 0, padding: '12px 14px', borderTop: '1px solid var(--color-line)' }}>
        {myStop ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, color: 'var(--color-label-mute)', marginBottom: 2, fontWeight: 600 }}>
                📍 {myStop.name}
              </div>
              <div style={{ fontSize: 24, fontWeight: 900, color: etaDisplayColor, lineHeight: 1.1 }}>
                {etaStatus.type === 'passed'
                  ? (isDestStop ? '목적지 도착 완료' : '이미 지나침')
                  : etaStatus.type === 'arriving'
                    ? (isDestStop ? '🏁 목적지 도착' : '🚌 곧 도착!')
                    : etaStatus.type === 'approaching' && etaStatus.eta !== undefined
                      ? (isDestStop ? `목적지까지 약 ${etaStatus.eta}분` : `약 ${etaStatus.eta}분 후 도착`)
                      : '버스 대기 중'}
              </div>
              {/* 부가 정보 */}
              {etaStatus.type === 'passed' && !isDestStop && (
                <div style={{ fontSize: 11, color: 'var(--color-cautionary)', marginTop: 3, fontWeight: 600 }}>
                  다음 버스를 기다려주세요
                </div>
              )}
              {etaStatus.type === 'arriving' && (
                <div style={{ fontSize: 11, color: 'var(--color-destructive)', marginTop: 3, fontWeight: 700 }}>
                  {isDestStop ? '하차해 주세요' : '탑승 준비하세요!'}
                </div>
              )}
              {etaStatus.type === 'approaching' && isDestStop && (
                <div style={{ fontSize: 11, color: 'var(--color-label-mute)', marginTop: 3, fontWeight: 600 }}>
                  목적지로 이동 중
                </div>
              )}
              {mainBus && etaStatus.type === 'approaching' && (
                <div style={{ fontSize: 10, color: 'var(--color-label-mute)', marginTop: 2 }}>
                  {mainBus.vehicleNo} · {mainBus.speed ?? 0} km/h
                </div>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, flexShrink: 0 }}>
              <button onClick={onScanTab}
                style={{ background: 'var(--color-primary)', border: 'none', borderRadius: 'var(--radius-12)', padding: '10px 16px', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', boxShadow: 'var(--shadow-strong)' }}>
                📱 QR 탑승
              </button>
              <button onClick={() => setMyStopIdx(null)}
                style={{ background: 'var(--color-bg-soft)', border: '1px solid var(--color-line)', borderRadius: 'var(--radius-8)', padding: '5px 10px', color: 'var(--color-label-mute)', fontSize: 10, cursor: 'pointer', fontFamily: 'inherit' }}>
                정류장 변경
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1, fontSize: 12, color: 'var(--color-label-mute)' }}>
              {buses.length === 0 ? '현재 운행중인 버스가 없습니다' : '노선도에서 내 탑승 정류장을 클릭하세요'}
            </div>
            <button onClick={onScanTab}
              style={{ background: 'var(--color-primary)', border: 'none', borderRadius: 'var(--radius-12)', padding: '10px 16px', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', flexShrink: 0, boxShadow: 'var(--shadow-strong)' }}>
              📱 QR 탑승
            </button>
          </div>
        )}
      </div>

      {/* ── 노선 변경 모달 — 선택 시 chooseRoute로 기준 노선 갱신·영속·재바인딩 ── */}
      {routePicker && (
        <div onClick={() => setRoutePicker(false)}
          style={{ position: 'fixed', inset: 0, background: 'var(--color-overlay)', zIndex: 200, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: 'var(--color-bg)', borderRadius: '20px 20px 0 0', width: '100%', maxHeight: '82dvh', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-heavy)' }}>
            <div style={{ padding: '14px 16px 12px', borderBottom: '1px solid var(--color-line)', flexShrink: 0 }}>
              <div style={{ width: 36, height: 4, background: 'var(--color-line)', borderRadius: 2, margin: '0 auto 12px' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 15, fontWeight: 800, color: 'var(--color-label)' }}>노선 변경</span>
                <button onClick={() => setRoutePicker(false)}
                  style={{ background: 'var(--color-bg-soft)', border: '1px solid var(--color-line)', borderRadius: 'var(--radius-8)', padding: '6px 12px', color: 'var(--color-label-mute)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12 }}>
                  ✕
                </button>
              </div>
              {allRoutes.length > 6 && (
                <input style={{ ...S.input, marginTop: 10 }} placeholder="🔍 노선명·구분·코드 검색"
                  value={routeQuery} onChange={e => setRouteQuery(e.target.value)} />
              )}
            </div>
            <div style={{ overflowY: 'auto', padding: '12px 16px 24px', flex: 1 }}>
              {filteredAllRoutes.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 30, color: 'var(--color-label-alt)', fontSize: 13 }}>
                  {allRoutes.length === 0 ? '등록된 노선이 없습니다' : '검색 결과가 없습니다'}
                </div>
              ) : filteredAllRoutes.map(r => {
                const isCur = activeRouteId === r.id;
                return (
                  <div key={r.id} onClick={() => chooseRoute(r.id)}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', marginBottom: 8, borderRadius: 'var(--radius-12)', cursor: 'pointer',
                      border: `1px solid ${isCur ? 'var(--color-primary)' : 'var(--color-line)'}`,
                      background: isCur ? 'var(--color-primary-soft)' : 'var(--color-bg)' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 10, padding: '3px 9px', borderRadius: 'var(--radius-pill)', fontWeight: 600,
                          background: r.type === '출근' ? 'var(--color-primary-soft)' : 'var(--color-atomic-orange-90)',
                          color: r.type === '출근' ? 'var(--color-primary-deep)' : '#B95300' }}>
                          {r.type || '노선'}
                        </span>
                        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-label)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name || r.id}</span>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--color-label-mute)', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {r.departTime && <span>🕒 {r.departTime}</span>}
                        {r.partnerName && <span>· {r.partnerName}</span>}
                        {r.shift && <span>· {r.shift}</span>}
                      </div>
                    </div>
                    {isCur && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-primary-deep)', background: 'var(--color-bg)', border: '1px solid var(--color-primary)', borderRadius: 'var(--radius-pill)', padding: '3px 9px', flexShrink: 0 }}>현재</span>}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ── 지도 정류장 클릭 정보 카드 ── */}
      {stopInfo && (
        <div onClick={() => setStopInfo(null)}
          style={{ position: 'fixed', inset: 0, background: 'var(--color-overlay)', zIndex: 200, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: 'var(--color-bg)', borderRadius: '20px 20px 0 0', width: '100%', maxHeight: '80dvh', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-heavy)' }}>
            <div style={{ padding: '14px 16px 12px', borderBottom: '1px solid var(--color-line)', flexShrink: 0 }}>
              <div style={{ width: 36, height: 4, background: 'var(--color-line)', borderRadius: 2, margin: '0 auto 12px' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: 'var(--color-label-mute)', fontWeight: 600, marginBottom: 2 }}>
                    {stopInfo.idx === 0 ? '출발 정류장' : stopInfo.idx === stops.length - 1 ? '도착 정류장' : `정류장 ${stopInfo.idx + 1}`}
                  </div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--color-label)' }}>{stopInfo.name}</div>
                </div>
                <button onClick={() => setStopInfo(null)}
                  style={{ background: 'var(--color-bg-soft)', border: '1px solid var(--color-line)', borderRadius: 'var(--radius-8)', padding: '6px 12px', color: 'var(--color-label-mute)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, flexShrink: 0 }}>
                  ✕
                </button>
              </div>
            </div>
            <div style={{ overflowY: 'auto', padding: '14px 16px 20px', flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {stopInfo.address && <div style={{ fontSize: 12, color: 'var(--color-label-mute)' }}>{stopInfo.address}</div>}
              {stopInfo.photo && (
                <img src={stopInfo.photo} alt={`${stopInfo.name} 정류장`}
                  onClick={() => setStopInfo(null)}
                  style={{ width: '100%', maxHeight: 200, objectFit: 'cover', borderRadius: 'var(--radius-12)', border: '1px solid var(--color-line)', cursor: 'pointer', display: 'block' }} />
              )}
              {stopInfo.description && (
                <div style={{ fontSize: 13, color: 'var(--color-label)', lineHeight: 1.55, wordBreak: 'keep-all', background: 'var(--color-bg-soft)', borderRadius: 'var(--radius-8)', padding: '10px 12px' }}>
                  {stopInfo.description}
                </div>
              )}
              {!stopInfo.photo && !stopInfo.description && !stopInfo.address && (
                <div style={{ fontSize: 12, color: 'var(--color-label-alt)' }}>추가 정보가 없습니다</div>
              )}
              <button onClick={() => { setMyStopIdx(stopInfo.idx); setCenter({ lat: stopInfo.lat, lng: stopInfo.lng }); setStopInfo(null); }}
                style={{ ...S.btn, marginTop: 4 }}>
                📍 이 정류장을 내 정류장으로 설정
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RoutesTab({ companyId, session, onSessionUpdate }) {
  const [routes, setRoutes] = useState([]);
  const [gpsData, setGpsData] = useState({});
  const [filter, setFilter] = useState("전체");
  const [search, setSearch] = useState("");
  const [stopModal, setStopModal] = useState(null);     // 정류장+지도 바텀시트
  const [modalStops, setModalStops] = useState([]);
  const [modalBuses, setModalBuses] = useState([]);      // 해당 노선 실시간 버스
  const [modalMapView, setModalMapView] = useState(false); // 바텀시트 내 지도 토글
  const [modalCenter, setModalCenter] = useState({ lat: 37.3894, lng: 126.9522 });
  const [loadingStops, setLoadingStops] = useState(false);
  const [photoView, setPhotoView] = useState(null); // 정류장 사진 라이트박스
  const favorites = session.favorites || [];

  useEffect(() => {
    if (!companyId) return;
    getDocs(collection(db, "companies", companyId, "routes")).then(snap => {
      setRoutes(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });
    // 노선별 현재 버스 대수
    const q = query(collection(db, "gps"), where("companyId", "==", companyId));
    return onSnapshot(q, snap => {
      const map = {};
      snap.docs.forEach(d => {
        const { routeId } = d.data();
        if (routeId) map[routeId] = (map[routeId] || 0) + 1;
      });
      setGpsData(map);
    });
  }, [companyId]);

  // 정류장 모달 열릴 때 로드
  useEffect(() => {
    if (!stopModal || !companyId) return;
    setLoadingStops(true); setModalStops([]);
    getDocs(query(
      collection(db, "companies", companyId, "routes", stopModal.id, "stops"),
      orderBy("order", "asc")
    )).then(snap => {
      setModalStops(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      setLoadingStops(false);
    }).catch(() => setLoadingStops(false));
  }, [stopModal, companyId]);

  // 선택 노선 실시간 버스 구독
  useEffect(() => {
    if (!stopModal || !companyId) return;
    const q = query(collection(db, "gps"),
      where("companyId", "==", companyId),
      where("routeId", "==", stopModal.id)
    );
    return onSnapshot(q, snap => {
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setModalBuses(list);
      // 버스가 있으면 지도 중심을 첫 번째 버스로
      if (list.length > 0 && list[0].lat && list[0].lng)
        setModalCenter({ lat: list[0].lat, lng: list[0].lng });
    });
  }, [stopModal, companyId]);

  const toggleFavorite = async (routeId) => {
    const newFavs = favorites.includes(routeId)
      ? favorites.filter(id => id !== routeId)
      : [...favorites, routeId];
    // localStorage 업데이트
    onSessionUpdate({ favorites: newFavs });
    // Firestore passengers 문서에도 저장
    try {
      await updateDoc(doc(db, "companies", companyId, "passengers", session.empNo), { favorites: newFavs });
    } catch {}
  };

  const filtered = routes.filter(r => {
    if (filter === "즐겨찾기" && !favorites.includes(r.id)) return false;
    if (filter === "운행중" && !gpsData[r.id]) return false;
    if (filter !== "전체" && filter !== "즐겨찾기" && filter !== "운행중" && r.type !== filter) return false;
    if (search && !r.name.includes(search) && !r.code?.includes(search)) return false;
    return true;
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden", background: "var(--color-bg-alt)" }}>
      <div style={{ background: "var(--color-bg)", padding: "14px 16px", borderBottom: "1px solid var(--color-line)" }}>
        <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 10, color: "var(--color-label)", letterSpacing: "-0.02em" }}>노선 목록</div>
        <input style={{ ...S.input, marginBottom: 10 }} placeholder="🔍 노선명·코드 검색"
          value={search} onChange={e => setSearch(e.target.value)} />
        <div style={{ display: "flex", gap: 6, overflowX: "auto" }}>
          {["전체", "즐겨찾기", "운행중", "출근", "퇴근"].map(f => (
            <button key={f} onClick={() => setFilter(f)}
              style={{ flexShrink: 0, padding: "5px 13px", borderRadius: "var(--radius-pill)", border: `1px solid ${filter === f ? "var(--color-primary)" : "var(--color-line)"}`, cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 600,
                background: filter === f ? "var(--color-primary)" : "var(--color-bg-soft)",
                color: filter === f ? "#fff" : "var(--color-label-mute)" }}>
              {f === "즐겨찾기" ? `⭐ ${f}` : f === "운행중" ? `🟢 ${f}` : f}
              {f === "즐겨찾기" && favorites.length > 0 ? ` ${favorites.length}` : ""}
            </button>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px" }}>
        {filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: 40, color: "var(--color-label-alt)", fontSize: 13, whiteSpace: "pre-line" }}>
            {filter === "즐겨찾기" ? "즐겨찾기한 노선이 없습니다\n노선 옆 ⭐를 눌러 추가하세요" : "해당하는 노선이 없습니다"}
          </div>
        ) : filtered.map(r => (
          <div key={r.id} style={{ background: "var(--color-bg)", border: `1px solid ${favorites.includes(r.id) ? "var(--color-cautionary)" : "var(--color-line)"}`, borderRadius: "var(--radius-16)", padding: "14px 16px", marginBottom: 10, boxShadow: "var(--shadow-emphasize)" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <span style={{ fontSize: 10, padding: "3px 9px", borderRadius: "var(--radius-pill)", background: r.type === "출근" ? "var(--color-primary-soft)" : "var(--color-atomic-orange-90)", color: r.type === "출근" ? "var(--color-primary-deep)" : "#B95300", fontWeight: 600 }}>
                    {r.type}
                  </span>
                  {r.shift && <span style={{ fontSize: 10, color: "var(--color-label-mute)" }}>{r.shift}</span>}
                  {r.code && <span style={{ fontSize: 10, color: "var(--color-label-mute)", fontFamily: "var(--font-mono)" }}>{r.code}</span>}
                  {gpsData[r.id] && (
                    <span style={{ fontSize: 10, padding: "3px 9px", borderRadius: "var(--radius-pill)", background: "#E6F7EB", color: "#007A29", fontWeight: 600 }}>
                      🟢 {gpsData[r.id]}대 운행중
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "var(--color-label)", marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.name}
                </div>
                <div style={{ fontSize: 12, color: "var(--color-label-mute)" }}>
                  출발 {r.departTime} · 좌석 {r.seats || "–"}석
                </div>
              </div>
              {/* 즐겨찾기 버튼 */}
              <button onClick={() => toggleFavorite(r.id)}
                style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 22, padding: 4, flexShrink: 0 }}>
                {favorites.includes(r.id) ? "⭐" : "☆"}
              </button>
            </div>
            {/* 배정 노선 배지 + 정류장 보기 */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8 }}>
              {r.id === session.routeId ? (
                <div style={{ fontSize: 11, color: "var(--color-primary-deep)", background: "var(--color-primary-soft)", borderRadius: "var(--radius-6)", padding: "4px 10px", fontWeight: 600 }}>
                  ✓ 내 배정 노선
                </div>
              ) : <div />}
              <div style={{ display:"flex", gap:4 }}>
                <button onClick={(e) => { e.stopPropagation(); setStopModal(r); setModalMapView(false); }}
                  style={{ fontSize: 11, color: "var(--color-label-mute)", background: "var(--color-bg-soft)", border: "1px solid var(--color-line)", borderRadius: "var(--radius-6)", padding: "4px 10px", cursor: "pointer", fontFamily: "inherit" }}>
                  📍 정류장
                </button>
                <button onClick={(e) => { e.stopPropagation(); setStopModal(r); setModalMapView(true);
                    if (modalStops.length > 0) setModalCenter({ lat: modalStops[0].lat, lng: modalStops[0].lng });
                  }}
                  style={{ fontSize: 11, color: gpsData[r.id] ? "#007A29" : "var(--color-label-mute)", background: gpsData[r.id] ? "#E6F7EB" : "var(--color-bg-soft)", border: gpsData[r.id] ? "1px solid rgba(0,191,64,.3)" : "1px solid var(--color-line)", borderRadius: "var(--radius-6)", padding: "4px 10px", cursor: "pointer", fontFamily: "inherit" }}>
                  🗺 {gpsData[r.id] ? `${gpsData[r.id]}대 운행중` : "지도"}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
      {/* ── 정류장 + 지도 통합 바텀시트 ── */}
      {stopModal && (
        <div style={{ position:"fixed", inset:0, background:"var(--color-overlay)", zIndex:200, display:"flex", flexDirection:"column", justifyContent:"flex-end" }}
          onClick={() => setStopModal(null)}>
          <div style={{ background:"var(--color-bg)", borderRadius:"20px 20px 0 0", width:"100%", maxHeight:"88dvh", display:"flex", flexDirection:"column", boxShadow:"var(--shadow-heavy)" }}
            onClick={e => e.stopPropagation()}>

            {/* 핸들 + 헤더 */}
            <div style={{ padding:"12px 16px 10px", borderBottom:"1px solid var(--color-line)", flexShrink:0 }}>
              <div style={{ width:36, height:4, background:"var(--color-line)", borderRadius:2, margin:"0 auto 10px" }} />
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:3, flexWrap:"wrap" }}>
                    <span style={{ fontSize:10, padding:"3px 9px", borderRadius:"var(--radius-pill)",
                      background: stopModal.type==="출근"?"var(--color-primary-soft)":"var(--color-atomic-orange-90)",
                      color: stopModal.type==="출근"?"var(--color-primary-deep)":"#B95300", fontWeight:600 }}>
                      {stopModal.type}
                    </span>
                    {stopModal.shift && <span style={{ fontSize:10, color:"var(--color-label-mute)" }}>{stopModal.shift}</span>}
                    {modalBuses.length > 0 && (
                      <span style={{ fontSize:10, padding:"3px 9px", borderRadius:"var(--radius-pill)", background:"#E6F7EB", color:"#007A29", fontWeight:600 }}>
                        🚌 {modalBuses.length}대 운행중
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize:15, fontWeight:800, color:"var(--color-label)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{stopModal.name}</div>
                  <div style={{ fontSize:11, color:"var(--color-label-mute)" }}>출발 {stopModal.departTime}</div>
                </div>
                <button onClick={() => setStopModal(null)}
                  style={{ background:"var(--color-bg-soft)", border:"1px solid var(--color-line)", borderRadius:"var(--radius-8)", padding:"6px 12px", color:"var(--color-label-mute)", cursor:"pointer", fontFamily:"inherit", fontSize:12, flexShrink:0, marginLeft:8 }}>
                  닫기
                </button>
              </div>

              {/* 보기 모드 전환 탭 */}
              <div style={{ display:"flex", gap:6, marginTop:10, background:"var(--color-bg-soft)", borderRadius:"var(--radius-8)", padding:3 }}>
                {[["list","📋 정류장 목록"],["map","🗺 실시간 지도"]].map(([v,label])=>(
                  <button key={v} onClick={()=>setModalMapView(v==="map")}
                    style={{ flex:1, padding:"8px", border:"none", borderRadius:"var(--radius-6)", cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight:600,
                      background: (modalMapView ? v==="map" : v==="list") ? "var(--color-primary)" : "transparent",
                      color: (modalMapView ? v==="map" : v==="list") ? "#fff" : "var(--color-label-mute)" }}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* ── 정류장 목록 보기 ── */}
            {!modalMapView && (
              <div style={{ overflowY:"auto", padding:"12px 16px 24px", flex:1 }}>
                {loadingStops ? (
                  <div style={{ textAlign:"center", padding:24, color:"var(--color-label-mute)", fontSize:13 }}>로딩 중...</div>
                ) : modalStops.length === 0 ? (
                  <div style={{ textAlign:"center", padding:24, color:"var(--color-label-alt)", fontSize:13 }}>등록된 정류장이 없습니다</div>
                ) : (
                  <div style={{ position:"relative" }}>
                    <div style={{ position:"absolute", left:13, top:14, bottom:14, width:2, background:"var(--color-line)", zIndex:0 }} />
                    {modalStops.map((s, i) => (
                      <div key={s.id} style={{ display:"flex", alignItems:"flex-start", gap:12, marginBottom:14, position:"relative", zIndex:1 }}>
                        <div style={{ width:26, height:26, borderRadius:"50%", flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center", fontSize:10, fontWeight:700,
                          background: i===0?"var(--color-positive)":i===modalStops.length-1?"var(--color-destructive)":"var(--color-primary)", color:"#fff", border:"3px solid var(--color-bg)" }}>
                          {i===0?"출":i===modalStops.length-1?"도":i+1}
                        </div>
                        <div style={{ flex:1, paddingTop:3, minWidth:0 }}>
                          <div style={{ fontSize:13, fontWeight: i===0||i===modalStops.length-1?700:600,
                            color: i===0?"#007A29":i===modalStops.length-1?"var(--color-destructive)":"var(--color-label)" }}>
                            {s.name}
                          </div>
                          {s.address && <div style={{ fontSize:11, color:"var(--color-label-mute)", marginTop:1 }}>{s.address}</div>}
                          {s.description && <div style={{ fontSize:11, color:"var(--color-label-mute)", marginTop:2, lineHeight:1.45, wordBreak:"keep-all" }}>{s.description}</div>}
                          {s.photo && (
                            <img src={s.photo} alt={`${s.name} 정류장`}
                              onClick={()=>setPhotoView({ src:s.photo, name:s.name, desc:s.description })}
                              style={{ marginTop:6, width:"100%", maxWidth:200, height:90, objectFit:"cover", borderRadius:"var(--radius-8)", border:"1px solid var(--color-line)", cursor:"pointer", display:"block" }}/>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── 실시간 지도 보기 ── */}
            {modalMapView && (
              <div style={{ flex:1, minHeight:300, position:"relative" }}>
                <Map center={modalCenter} style={{ width:"100%", height:"100%" }} level={9}
                  onCenterChanged={map => setModalCenter({ lat: map.getCenter().getLat(), lng: map.getCenter().getLng() })}>

                  {/* 노선 폴리라인 */}
                  {modalStops.length >= 2 && (
                    <Polyline
                      path={modalStops.map(s=>({ lat:s.lat, lng:s.lng }))}
                      strokeWeight={4} strokeColor="#0066FF" strokeOpacity={0.7} strokeStyle="solid"
                    />
                  )}

                  {/* 정류장 마커 */}
                  {modalStops.map((s, i) => (
                    <MapMarker key={s.id} position={{ lat:s.lat, lng:s.lng }}
                      image={{ src: i===0
                        ? "https://t1.daumcdn.net/localimg/localimages/07/mapapidoc/red_b.png"
                        : i===modalStops.length-1
                          ? "https://t1.daumcdn.net/localimg/localimages/07/mapapidoc/red_b.png"
                          : "https://t1.daumcdn.net/localimg/localimages/07/mapapidoc/marker_red.png",
                        size: { width:i===0||i===modalStops.length-1?24:14, height:i===0||i===modalStops.length-1?35:20 }
                      }}
                    />
                  ))}

                  {/* 정류장 이름 오버레이 (출발/도착만) */}
                  {modalStops.length > 0 && (
                    <>
                      <CustomOverlayMap position={{ lat:modalStops[0].lat, lng:modalStops[0].lng }} yAnchor={2.8}>
                        <div style={{ background:"var(--color-positive)", color:"#fff", borderRadius:8, padding:"3px 9px", fontSize:10, fontWeight:700, whiteSpace:"nowrap", boxShadow:"var(--shadow-float)" }}>
                          출발 · {modalStops[0].name}
                        </div>
                      </CustomOverlayMap>
                      <CustomOverlayMap position={{ lat:modalStops[modalStops.length-1].lat, lng:modalStops[modalStops.length-1].lng }} yAnchor={2.8}>
                        <div style={{ background:"var(--color-destructive)", color:"#fff", borderRadius:8, padding:"3px 9px", fontSize:10, fontWeight:700, whiteSpace:"nowrap", boxShadow:"var(--shadow-float)" }}>
                          도착 · {modalStops[modalStops.length-1].name}
                        </div>
                      </CustomOverlayMap>
                    </>
                  )}

                  {/* 실시간 버스 마커 */}
                  {modalBuses.map(b => b.lat && b.lng && (
                    <CustomOverlayMap key={b.id} position={{ lat:b.lat, lng:b.lng }} yAnchor={1.7}>
                      <div style={{ background:"var(--color-bg)", border:"2px solid var(--color-primary)", borderRadius:"var(--radius-pill)", padding:"5px 11px", display:"flex", alignItems:"center", gap:5, boxShadow:"var(--shadow-float)" }}>
                        <span style={{ fontSize:14 }}>🚌</span>
                        <div>
                          <div style={{ fontSize:11, fontWeight:800, color:"var(--color-primary)" }}>{b.vehicleNo||b.vehicleId}</div>
                          <div style={{ fontSize:10, color:"var(--color-label-mute)" }}>{b.speed??0} km/h</div>
                        </div>
                      </div>
                    </CustomOverlayMap>
                  ))}
                </Map>

                {/* 버스 없을 때 안내 */}
                {modalBuses.length === 0 && (
                  <div style={{ position:"absolute", bottom:12, left:"50%", transform:"translateX(-50%)", background:"var(--color-bg)", border:"1px solid var(--color-line)", borderRadius:"var(--radius-pill)", padding:"7px 16px", fontSize:11, color:"var(--color-label-mute)", whiteSpace:"nowrap", boxShadow:"var(--shadow-float)" }}>
                    현재 운행 중인 버스가 없습니다
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 정류장 사진 라이트박스 — 위치 확인용 확대 보기 */}
      {photoView && (
        <div onClick={() => setPhotoView(null)}
          style={{ position:"fixed", inset:0, background:"rgba(11,16,32,0.82)", zIndex:300, display:"flex", alignItems:"center", justifyContent:"center", padding:18 }}>
          <div onClick={(e)=>e.stopPropagation()}
            style={{ background:"var(--color-bg)", borderRadius:"var(--radius-12)", overflow:"hidden", maxWidth:520, width:"100%", maxHeight:"88vh", display:"flex", flexDirection:"column" }}>
            <img src={photoView.src} alt={`${photoView.name} 정류장`} style={{ width:"100%", maxHeight:"60vh", objectFit:"contain", background:"#000" }}/>
            <div style={{ padding:"14px 16px" }}>
              <div style={{ fontWeight:800, fontSize:15 }}>{photoView.name}</div>
              {photoView.desc && <div style={{ fontSize:13, color:"var(--color-label-mute)", marginTop:4, lineHeight:1.5 }}>{photoView.desc}</div>}
            </div>
            <button onClick={()=>setPhotoView(null)}
              style={{ margin:"0 16px 16px", padding:"11px", border:"none", borderRadius:"var(--radius-8)", background:"var(--color-bg-soft)", color:"var(--color-label)", fontSize:14, fontWeight:700, cursor:"pointer", fontFamily:"inherit" }}>
              ✕ 닫기
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════
// 탑승 탭 — QR 스캔
// ════════════════════════════════════════════════════════
function ScanTab({ companyId, session }) {
  const [step, setStep] = useState("ready"); // ready|loading|scanning|confirm|success|error
  // jsQR npm 패키지로 직접 import — 항상 사용 가능
  const [scannedToken, setScannedToken] = useState(null);
  const [tokenData, setTokenData] = useState(null);
  const [errMsg, setErrMsg] = useState("");
  const [scanStatus, setScanStatus] = useState("");
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const activeRef = useRef(false); // 스캔 루프 활성 여부

  // 언마운트 시 카메라 정리
  useEffect(() => {
    return () => { activeRef.current = false; stopStream(); };
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
      // 1. 카메라 권한 요청
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      streamRef.current = stream;

      // 2. scanning 상태로 전환 → video 엘리먼트 DOM에 렌더됨
      setStep("scanning");
      setScanStatus("QR코드를 사각형 안에 맞춰주세요");

      // 3. 다음 렌더 사이클 후 video에 stream 연결
      await new Promise(resolve => setTimeout(resolve, 100));

      if (!videoRef.current) throw new Error("카메라 화면을 초기화할 수 없습니다");
      videoRef.current.srcObject = stream;
      await videoRef.current.play().catch(() => {}); // autoplay 정책 우회

      // 4. 스캔 루프 시작
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
    // 오프스크린 canvas 생성 (display:none 우회)
    const canvas = document.createElement("canvas");
    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0);
    let imageData;
    try { imageData = ctx.getImageData(0, 0, canvas.width, canvas.height); }
    catch { rafRef.current = requestAnimationFrame(tick); return; }

    const code = jsQR(imageData.data, canvas.width, canvas.height, {
      inversionAttempts: "attemptBoth",
    });

    if (code?.data) {
      activeRef.current = false;
      stopStream();
      handleTokenScanned(code.data);
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  };

  const handleTokenScanned = async (rawValue) => {
    setScanStatus("QR 확인 중...");
    try {
      let token = rawValue.trim();
      try { token = new URL(rawValue).searchParams.get("t") || token; } catch {}
      const snap = await getDoc(doc(db, "boardingTokens", token));
      if (!snap.exists()) throw new Error("유효하지 않은 QR코드입니다");
      const data = snap.data();
      if (data.used)  throw new Error("이미 사용된 QR코드입니다");
      if (data.expiresAt.toDate() < new Date()) throw new Error("만료된 QR코드입니다.\n기사님께 새 QR코드를 요청하세요");
      setScannedToken(token); setTokenData(data); setStep("confirm");
    } catch (e) { setErrMsg(e.message); setStep("error"); }
  };

  const handleBoard = async () => {
    setStep("processing");
    try {
      await validateAndBoard({ tokenId: scannedToken, empNo: session.empNo, name: session.name });
      if ("vibrate" in navigator) navigator.vibrate([100, 50, 100]);
      setStep("success");
    } catch (e) { setErrMsg(e.message); setStep("error"); }
  };

  const reset = () => {
    stopStream();
    setStep("ready"); setScannedToken(null); setTokenData(null);
    setErrMsg(""); setScanStatus("");
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", flex:1, overflow:"hidden", background:"var(--color-bg-alt)" }}>
      <div style={{ background:"var(--color-bg)", padding:"14px 16px", borderBottom:"1px solid var(--color-line)" }}>
        <div style={{ fontSize:16, fontWeight:800, color:"var(--color-label)", letterSpacing:"-0.02em" }}>QR 탑승</div>
        <div style={{ fontSize:12, color:"var(--color-label-mute)", marginTop:2 }}>기사 폰의 QR코드를 스캔하세요</div>
      </div>

      <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:24, gap:20, overflowY:"auto" }}>

        {/* ── 준비 화면 ── */}
        {step === "ready" && (
          <>
            <div style={{ width:90, height:90, borderRadius:"50%", background:"var(--color-primary-soft)", border:"2px solid var(--color-primary)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:40 }}>📷</div>
            <div style={{ textAlign:"center" }}>
              <div style={{ fontSize:17, fontWeight:800, color:"var(--color-label)", marginBottom:6 }}>탑승 QR 스캔</div>
              <div style={{ fontSize:13, color:"var(--color-label-mute)", lineHeight:1.6 }}>
                {session.name} ({session.empNo})<br/>으로 탑승 처리됩니다
              </div>
            </div>
            <button style={{ ...S.btn, maxWidth:280 }} onClick={startScan}>
              📷 카메라 열기
            </button>
          </>
        )}

        {/* ── 스캔 화면 ── */}
        {step === "scanning" && (
          <div style={{ width:"100%", maxWidth:360 }}>
            <div style={{ position:"relative", borderRadius:20, overflow:"hidden", background:"#000", aspectRatio:"1/1" }}>
              <video ref={videoRef} autoPlay playsInline muted
                style={{ width:"100%", height:"100%", objectFit:"cover", display:"block" }} />
              {/* 오버레이 */}
              <div style={{ position:"absolute", inset:0, pointerEvents:"none" }}>
                <div style={{ position:"absolute", top:0, left:0, right:0, height:"18%", background:"rgba(0,0,0,.6)" }}/>
                <div style={{ position:"absolute", bottom:0, left:0, right:0, height:"18%", background:"rgba(0,0,0,.6)" }}/>
                <div style={{ position:"absolute", top:"18%", left:0, width:"10%", height:"64%", background:"rgba(0,0,0,.6)" }}/>
                <div style={{ position:"absolute", top:"18%", right:0, width:"10%", height:"64%", background:"rgba(0,0,0,.6)" }}/>
                {/* 모서리 */}
                <div style={{ position:"absolute", top:"18%", left:"10%", width:30, height:30, borderTop:"3px solid var(--color-primary)", borderLeft:"3px solid var(--color-primary)", borderRadius:"6px 0 0 0" }}/>
                <div style={{ position:"absolute", top:"18%", right:"10%", width:30, height:30, borderTop:"3px solid var(--color-primary)", borderRight:"3px solid var(--color-primary)", borderRadius:"0 6px 0 0" }}/>
                <div style={{ position:"absolute", bottom:"18%", left:"10%", width:30, height:30, borderBottom:"3px solid var(--color-primary)", borderLeft:"3px solid var(--color-primary)", borderRadius:"0 0 0 6px" }}/>
                <div style={{ position:"absolute", bottom:"18%", right:"10%", width:30, height:30, borderBottom:"3px solid var(--color-primary)", borderRight:"3px solid var(--color-primary)", borderRadius:"0 0 6px 0" }}/>
              </div>
            </div>
            <div style={{ textAlign:"center", marginTop:14, fontSize:13, color:"var(--color-primary)", fontWeight:600 }}>{scanStatus}</div>
            <button style={{ ...S.btnSecondary, marginTop:12, width:"100%" }} onClick={reset}>취소</button>
          </div>
        )}

        {/* ── 탑승 확인 ── */}
        {step === "confirm" && tokenData && (
          <div style={{ width:"100%", maxWidth:320 }}>
            <div style={{ background:"var(--color-bg)", borderRadius:"var(--radius-16)", padding:20, marginBottom:16, border:"1px solid rgba(0,191,64,.3)", boxShadow:"var(--shadow-emphasize)" }}>
              <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:14 }}>
                <span style={{ fontSize:22 }}>✅</span>
                <div style={{ fontSize:14, fontWeight:800, color:"#007A29" }}>QR 인식 완료</div>
              </div>
              {[["노선",tokenData.routeName],["차량",tokenData.vehicleNo],["탑승자",`${session.name} (${session.empNo})`],["부서",session.dept||"–"]].map(([k,v])=>(
                <div key={k} style={{ display:"flex", justifyContent:"space-between", padding:"8px 0", borderBottom:"1px solid var(--color-line)" }}>
                  <span style={{ fontSize:12, color:"var(--color-label-mute)" }}>{k}</span>
                  <span style={{ fontSize:13, fontWeight:700, color:"var(--color-label)" }}>{v}</span>
                </div>
              ))}
            </div>
            <button style={{ ...S.btn, marginBottom:8 }} onClick={handleBoard}>✅ 탑승 확인</button>
            <button style={S.btnSecondary} onClick={reset}>취소</button>
          </div>
        )}

        {/* ── 처리 중 ── */}
        {step === "processing" && (
          <>
            <div style={S.spinner}/>
            <div style={{ fontSize:13, color:"var(--color-label-mute)" }}>탑승 처리 중...</div>
          </>
        )}

        {/* ── 탑승 완료 ── */}
        {step === "success" && (
          <>
            <div style={{ width:80, height:80, borderRadius:"50%", background:"#E6F7EB", border:"2px solid var(--color-positive)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:36, color:"#007A29" }}>✓</div>
            <div style={{ fontSize:22, fontWeight:800, color:"#007A29" }}>탑승 완료!</div>
            <div style={{ fontSize:14, color:"var(--color-label)", fontWeight:700 }}>{session.name} ({session.dept})</div>
            <div style={{ fontSize:12, color:"var(--color-label-mute)" }}>{new Date().toLocaleTimeString("ko-KR")}</div>
            <button style={{ ...S.btnSecondary, marginTop:8, maxWidth:280 }} onClick={reset}>확인</button>
          </>
        )}

        {/* ── 오류 ── */}
        {step === "error" && (
          <>
            <div style={{ width:72, height:72, borderRadius:"50%", background:"var(--color-atomic-red-90)", border:"2px solid var(--color-destructive)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:32, color:"var(--color-destructive)" }}>✕</div>
            <div style={{ fontSize:18, fontWeight:800, color:"var(--color-destructive)" }}>오류</div>
            <div style={{ fontSize:13, color:"var(--color-label-mute)", textAlign:"center", whiteSpace:"pre-line", lineHeight:1.6 }}>{errMsg}</div>
            <button style={{ ...S.btn, maxWidth:280 }} onClick={reset}>다시 시도</button>
          </>
        )}

      </div>
    </div>
  );
}

function SettingsTab({ companyId, session, onLogout, onSessionUpdate }) {
  const [showPinChange, setShowPinChange] = useState(session.pinInitial || false);
  const [oldPin, setOldPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState(session.pinInitial ? { type:"warn", text:"초기 PIN(000000)을 사용 중입니다. 변경해주세요." } : null);

  const handlePinChange = async () => {
    if (newPin.length < 4) return setMsg({ type:"error", text:"PIN은 4자리 이상이어야 합니다" });
    if (newPin !== confirmPin) return setMsg({ type:"error", text:"새 PIN이 일치하지 않습니다" });
    setLoading(true); setMsg(null);
    try {
      const oldHash = await hashPin(oldPin);
      if (oldHash !== session.pinHash) throw new Error("현재 PIN이 올바르지 않습니다");
      const newHash = await hashPin(newPin);
      await updateDoc(doc(db, "companies", companyId, "passengers", session.empNo), {
        pinHash: newHash, pinInitial: false,
      });
      onSessionUpdate({ pinHash: newHash, pinInitial: false });
      setMsg({ type:"success", text:"PIN이 변경되었습니다" });
      setShowPinChange(false);
      setOldPin(""); setNewPin(""); setConfirmPin("");
    } catch (e) {
      setMsg({ type:"error", text: e.message });
    }
    setLoading(false);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, overflowY: "auto", background: "var(--color-bg-alt)" }}>
      <div style={{ background: "var(--color-bg)", padding: "14px 16px", borderBottom: "1px solid var(--color-line)" }}>
        <div style={{ fontSize: 16, fontWeight: 800, color: "var(--color-label)", letterSpacing: "-0.02em" }}>설정</div>
      </div>

      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        {/* 내 정보 */}
        <div style={{ background: "var(--color-bg)", borderRadius: "var(--radius-16)", padding: "16px 18px", border: "1px solid var(--color-line)", boxShadow: "var(--shadow-emphasize)" }}>
          <div style={{ fontSize: 11, color: "var(--color-label-mute)", marginBottom: 10, fontWeight: 700, letterSpacing: "0.05em" }}>내 정보</div>
          {[["이름", session.name], ["사번", session.empNo], ["부서", session.dept || "–"], ["배정 노선", session.routeId || "–"]].map(([k,v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid var(--color-line)" }}>
              <span style={{ fontSize: 13, color: "var(--color-label-mute)" }}>{k}</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: "var(--color-label)" }}>{v}</span>
            </div>
          ))}
        </div>

        {/* PIN 변경 */}
        {msg && (
          <div style={{ background: msg.type==="error"?"var(--color-atomic-red-90)":msg.type==="warn"?"var(--color-atomic-orange-90)":"#E6F7EB", border: `1px solid ${msg.type==="error"?"rgba(229,34,34,.25)":msg.type==="warn"?"rgba(255,122,0,.25)":"rgba(0,191,64,.3)"}`, borderRadius: "var(--radius-8)", padding: "10px 14px", fontSize: 13, fontWeight: 600, color: msg.type==="error"?"#A81818":msg.type==="warn"?"#B95300":"#007A29" }}>
            {msg.text}
          </div>
        )}

        <div style={{ background: "var(--color-bg)", borderRadius: "var(--radius-16)", overflow: "hidden", border: "1px solid var(--color-line)", boxShadow: "var(--shadow-emphasize)" }}>
          <button onClick={() => setShowPinChange(p => !p)}
            style={{ width: "100%", padding: "14px 18px", background: "transparent", border: "none", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", fontFamily: "inherit", color: "var(--color-label)" }}>
            <span style={{ fontSize: 14, fontWeight: 700 }}>🔐 PIN 변경</span>
            <span style={{ fontSize: 12, color: "var(--color-label-mute)" }}>{showPinChange ? "▲" : "▼"}</span>
          </button>
          {showPinChange && (
            <div style={{ padding: "0 18px 18px", display: "flex", flexDirection: "column", gap: 8, borderTop: "1px solid var(--color-line)" }}>
              <input style={{ ...S.input, marginTop: 12 }} type="password" inputMode="numeric"
                placeholder="현재 PIN" maxLength={6} value={oldPin} onChange={e => setOldPin(e.target.value)} />
              <input style={S.input} type="password" inputMode="numeric"
                placeholder="새 PIN (4~6자리)" maxLength={6} value={newPin} onChange={e => setNewPin(e.target.value)} />
              <input style={S.input} type="password" inputMode="numeric"
                placeholder="새 PIN 확인" maxLength={6} value={confirmPin} onChange={e => setConfirmPin(e.target.value)} />
              <button style={{ ...S.btn, opacity: loading ? 0.6 : 1, cursor: loading ? "not-allowed" : "pointer" }} onClick={handlePinChange} disabled={loading}>
                {loading ? "변경 중..." : "PIN 변경"}
              </button>
            </div>
          )}
        </div>

        {/* 로그아웃 */}
        <button style={{ background: "var(--color-bg)", border: "1px solid #F6C9C9", borderRadius: "var(--radius-12)", padding: "14px", color: "var(--color-destructive)", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", boxShadow: "var(--shadow-emphasize)" }}
          onClick={() => { if (window.confirm("로그아웃하시겠습니까?")) onLogout(); }}>
          로그아웃
        </button>

        <div style={{ fontSize: 11, color: "var(--color-label-alt)", textAlign: "center" }}>BusLink v1.0 · buslink-prod.web.app</div>
      </div>
    </div>
  );
}

// ─── 스타일 (라이트 — tokens.css 변수 기반, 리디자인 6단계) ──────────
const S = {
  appWrap: { display: "flex", flexDirection: "column", height: "100dvh", maxHeight: "100dvh", background: "var(--color-bg-alt)", fontFamily: "var(--font-base)", color: "var(--color-label)", overflow: "hidden" },
  content: { flex: 1, display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" },
  tabBar: { display: "flex", background: "var(--color-bg)", borderTop: "1px solid var(--color-line)", flexShrink: 0, paddingBottom: "env(safe-area-inset-bottom, 0px)", boxShadow: "0 -1px 12px rgba(11,16,32,0.05)" },
  tabBtn: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "8px 0", background: "transparent", border: "none", cursor: "pointer", fontFamily: "inherit", transition: "color .15s" },
  fullCenter: { minHeight: "100vh", background: "var(--color-bg-alt)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-base)", padding: 20 },
  loginCard: { background: "var(--color-bg)", borderRadius: "var(--radius-24)", padding: "32px 28px", width: "100%", maxWidth: 380, display: "flex", flexDirection: "column", gap: 0, boxShadow: "var(--shadow-heavy)", border: "1px solid var(--color-line)" },
  header: { display: "flex", alignItems: "center", gap: 12, marginBottom: 24 },
  input: { background: "var(--color-bg)", border: "1px solid var(--color-line)", borderRadius: "var(--radius-12)", padding: "13px 14px", color: "var(--color-label)", fontSize: 15, outline: "none", fontFamily: "inherit", width: "100%", boxSizing: "border-box" },
  btn: { background: "var(--color-primary)", border: "none", borderRadius: "var(--radius-12)", padding: "15px", color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", width: "100%", boxShadow: "var(--shadow-strong)" },
  btnSecondary: { background: "var(--color-bg-soft)", border: "1px solid var(--color-line)", borderRadius: "var(--radius-12)", padding: "13px", color: "var(--color-label-mute)", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", width: "100%" },
  errorMsg: { background: "var(--color-atomic-red-90)", border: "1px solid rgba(229,34,34,.25)", borderRadius: "var(--radius-8)", padding: "10px 14px", fontSize: 13, color: "#A81818", whiteSpace: "pre-line", marginTop: 8 },
  spinner: { width: 36, height: 36, borderRadius: "50%", border: "3px solid var(--color-line)", borderTopColor: "var(--color-primary)", animation: "spin 0.8s linear infinite" },
};

const style = document.createElement("style");
style.textContent = "@keyframes spin{to{transform:rotate(360deg)}} @keyframes slideDown{from{transform:translateY(-100%)}to{transform:translateY(0)}}";
document.head.appendChild(style);
