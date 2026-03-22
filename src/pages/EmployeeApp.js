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
          background: activeNotice.type === "emergency" ? "#FF4D6A" : "#1A6BFF",
          padding: "10px 14px",
          display: "flex", alignItems: "flex-start", gap: 10,
          boxShadow: "0 4px 16px rgba(0,0,0,.4)",
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: "#fff", marginBottom: 2 }}>
              {activeNotice.type === "emergency" ? "🚨 긴급 공지" : "📢 공지"} · {activeNotice.title}
            </div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,.85)", lineHeight: 1.4 }}>
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
        {tab === "home"     && <HomeTab companyId={companyId} session={session} onScanTab={() => setTab("scan")} />}
        {tab === "routes"   && <RoutesTab companyId={companyId} session={session} onSessionUpdate={(s) => { saveSession({...session,...s}); setSession(p=>({...p,...s})); }} />}
        {tab === "scan"     && <ScanTab companyId={companyId} session={session} />}
        {tab === "settings" && <SettingsTab companyId={companyId} session={session} onLogout={handleLogout} onSessionUpdate={(s)=>{saveSession({...session,...s});setSession(p=>({...p,...s}));}} />}
      </div>

      <div style={S.tabBar}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{ ...S.tabBtn, color: tab === t.id ? "#00C2FF" : "#8896AA" }}>
            <span style={{ fontSize: 20 }}>{t.icon}</span>
            <span style={{ fontSize: 10, fontWeight: tab === t.id ? 700 : 400 }}>{t.label}</span>
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
          <div style={S.logo}>BL</div>
          <div>
            <div style={S.logoText}>BusLink</div>
            <div style={S.logoSub}>직원 탑승 서비스</div>
          </div>
        </div>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#F0F4FF", marginBottom: 4 }}>로그인</div>
        <div style={{ fontSize: 12, color: "#8896AA", marginBottom: 16 }}>
          사번과 PIN을 입력하세요<br/>
          <span style={{ color: "#FFD166" }}>초기 PIN: 000000 (첫 로그인 후 변경 필요)</span>
        </div>
        <input style={S.input} type="tel" inputMode="numeric" placeholder="사번"
          value={empNo} onChange={e => setEmpNo(e.target.value)} autoFocus />
        <input style={{ ...S.input, marginTop: 8 }} type="password" inputMode="numeric"
          placeholder="PIN (4~6자리)" maxLength={6}
          value={pin} onChange={e => setPin(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleSubmit()} />
        {error && <div style={S.errorMsg}>{error}</div>}
        <button style={{ ...S.btn, marginTop: 12, opacity: (!empNo || pin.length < 4 || loading) ? 0.5 : 1 }}
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
function HomeTab({ companyId, session, onScanTab }) {
  const [routes, setRoutes]         = useState([]);
  const [activeRouteId, setActiveRouteId] = useState(session.routeId || null);
  const [stops, setStops]           = useState([]);
  const [myStopIdx, setMyStopIdx]   = useState(null);
  const [rawBuses, setRawBuses]     = useState([]);
  const [center, setCenter]         = useState({ lat: 37.3894, lng: 126.9522 });
  const [mapLevel, setMapLevel]     = useState(9);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [tick, setTick]             = useState(0);
  const buses = useAnimatedPositions(rawBuses);
  const favorites = session.favorites || [];

  useEffect(() => {
    const t = setInterval(() => setTick(x => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // 노선 목록 (배정 + 즐겨찾기)
  useEffect(() => {
    if (!companyId) return;
    getDocs(collection(db, 'companies', companyId, 'routes')).then(snap => {
      const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      const shown = all.filter(r => r.id === session.routeId || favorites.includes(r.id));
      setRoutes(shown.length > 0 ? shown : all.slice(0, 3));
      if (!activeRouteId && shown.length > 0) setActiveRouteId(shown[0].id);
    });
  }, [companyId, session.routeId]);

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
  const activeRoute = routes.find(r => r.id === activeRouteId);

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
    ? '#FF8C42'
    : etaStatus.type === 'arriving'
      ? '#FF4D6A'
      : etaStatus.eta !== undefined && etaStatus.eta <= 3
        ? '#FF4D6A'
        : etaStatus.eta !== undefined && etaStatus.eta <= 10
          ? '#FFD166'
          : '#00C2FF';

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

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#0B1A2E' }}>

      {/* ── 상단 헤더 ── */}
      <div style={{ background: '#112240', padding: '8px 14px', flexShrink: 0, borderBottom: '1px solid #1E3A5F' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>
            {session.name}
            <span style={{ fontSize: 11, color: '#8896AA', fontWeight: 400, marginLeft: 6 }}>{session.dept}</span>
          </div>
          <div style={{ fontSize: 10, color: '#4A6FA5', textAlign: 'right' }}>
            {lastUpdate && <>{timeSince(lastUpdate)} 갱신<br/></>}
            <span style={{ color: buses.length > 0 ? '#00C48C' : '#4A6FA5' }}>
              {buses.length > 0 ? `● ${buses.length}대 운행중` : '● 운행 없음'}
            </span>
          </div>
        </div>
        {/* 노선 칩 (복수일 때) */}
        {routes.length > 1 && (
          <div style={{ display: 'flex', gap: 5, overflowX: 'auto', marginTop: 6, paddingBottom: 2 }}>
            {routes.map(r => (
              <button key={r.id} onClick={() => { setActiveRouteId(r.id); setMyStopIdx(null); }}
                style={{ flexShrink: 0, padding: '3px 10px', borderRadius: 12, border: 'none', cursor: 'pointer',
                  fontFamily: 'inherit', fontSize: 11, fontWeight: 600,
                  background: activeRouteId === r.id ? 'linear-gradient(135deg,#1A6BFF,#00C2FF)' : '#1E3A5F',
                  color: activeRouteId === r.id ? '#fff' : '#8896AA' }}>
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
            <Polyline path={routePath} strokeWeight={5} strokeColor="#1A6BFF" strokeOpacity={0.75} strokeStyle="solid" />
          )}

          {/* 정류장 마커 */}
          {stops.map((s, i) => {
            const isMyStop = myStopIdx === i;
            const isFirst  = i === 0;
            const isLast   = i === stops.length - 1;
            return (
              <MapMarker key={s.id} position={{ lat: s.lat, lng: s.lng }}
                onClick={() => setMyStopIdx(i)}
                image={{
                  src: isMyStop
                    ? 'https://t1.daumcdn.net/localimg/localimages/07/mapapidoc/markerStar.png'
                    : 'https://t1.daumcdn.net/localimg/localimages/07/mapapidoc/marker_red.png',
                  size: isMyStop ? { width: 24, height: 35 } : isFirst||isLast ? { width: 18, height: 26 } : { width: 12, height: 18 }
                }}
              />
            );
          })}

          {/* 출발/도착/내 정류장 레이블 */}
          {stops.map((s, i) => {
            const isMyStop = myStopIdx === i;
            const isFirst  = i === 0;
            const isLast   = i === stops.length - 1;
            if (!isMyStop && !isFirst && !isLast) return null;
            return (
              <CustomOverlayMap key={`lbl-${s.id}`} position={{ lat: s.lat, lng: s.lng }} yAnchor={isMyStop ? 3.6 : 3.1}>
                <div style={{
                  background: isMyStop ? '#00C2FF' : isFirst ? '#00C48C' : '#FF4D6A',
                  color: '#fff', borderRadius: 10, padding: '2px 9px',
                  fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap',
                  boxShadow: '0 2px 6px rgba(0,0,0,.5)'
                }}>
                  {isMyStop ? '📍 ' : isFirst ? '출 ' : '도 '}{s.name.length > 10 ? s.name.substring(0,10)+'…' : s.name}
                </div>
              </CustomOverlayMap>
            );
          })}

          {/* 버스 마커 — 작은 원형 아이콘 */}
          {buses.map(b => b.lat && b.lng && (
            <CustomOverlayMap key={b.id} position={{ lat: b.lat, lng: b.lng }} yAnchor={1.5}>
              <div style={{
                background: '#00C2FF', border: '2px solid #fff',
                borderRadius: '50%', width: 20, height: 20,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, boxShadow: '0 0 0 3px rgba(0,194,255,.35), 0 2px 8px rgba(0,0,0,.5)',
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
            background: 'rgba(11,26,46,.95)', border: '1.5px solid #1A6BFF',
            borderRadius: 16, padding: '6px 16px',
            fontSize: 11, color: '#00C2FF', fontWeight: 700, zIndex: 5, whiteSpace: 'nowrap'
          }}>
            📍 아래 노선도에서 내 정류장을 클릭하세요
          </div>
        )}
      </div>

      {/* ── 노선도 스트립 (중간) ── */}
      <div style={{ background: '#112240', borderTop: '1px solid #1E3A5F', borderBottom: '1px solid #1E3A5F', flexShrink: 0, padding: '10px 0' }}>
        {stops.length === 0 ? (
          <div style={{ textAlign: 'center', fontSize: 12, color: '#4A6FA5', padding: '4px 0' }}>
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
                          <div style={{ background: '#00C2FF', borderRadius: '50%', width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, boxShadow: '0 0 0 3px rgba(0,194,255,.3)' }}>🚌</div>
                        )}
                      </div>
                      {/* 정류장 원 */}
                      <div style={{
                        width: isMyStop ? 18 : isFirst||isLast ? 14 : 10,
                        height: isMyStop ? 18 : isFirst||isLast ? 14 : 10,
                        borderRadius: '50%', flexShrink: 0,
                        background: isMyStop ? '#00C2FF' : isBusHere ? '#00C2FF' : isFirst ? '#00C48C' : isLast ? '#FF4D6A' : '#1A6BFF',
                        border: isMyStop ? '2px solid #fff' : '2px solid #112240',
                        boxShadow: isMyStop ? '0 0 0 3px rgba(0,194,255,.4)' : 'none',
                        cursor: 'pointer'
                      }} />
                      {/* 정류장 이름 */}
                      <div style={{
                        fontSize: 9, marginTop: 5, textAlign: 'center', width: 60,
                        color: isMyStop ? '#00C2FF' : isFirst ? '#00C48C' : isLast ? '#FF4D6A' : '#8896AA',
                        fontWeight: isMyStop ? 800 : isFirst||isLast ? 700 : 400,
                        wordBreak: 'keep-all', lineHeight: 1.3
                      }}>
                        {s.name}
                        {isMyStop && <div style={{ color: '#00C2FF', fontSize: 8, fontWeight: 700 }}>내 정류장</div>}
                      </div>
                    </div>

                    {/* 연결선 (마지막 제외) */}
                    {!isLast && (
                      <div style={{
                        width: 28, height: 3, flexShrink: 0, marginTop: -22,
                        background: busStopIdx >= 0 && i < busStopIdx ? '#00C2FF' : '#1E3A5F',
                        borderRadius: 2, position: 'relative'
                      }}>
                        {/* 버스가 이 구간(i → i+1) 이동 중 */}
                        {busStopIdx === i && mainBus && (
                          <div style={{ position: 'absolute', top: -6, left: '40%', fontSize: 10, color: '#00C2FF' }}>🚌</div>
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
      <div style={{ background: '#0B1A2E', flexShrink: 0, padding: '10px 14px' }}>
        {myStop ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 10, color: '#8896AA', marginBottom: 1 }}>
                📍 {myStop.name}
              </div>
              <div style={{ fontSize: 24, fontWeight: 900, color: etaColor, lineHeight: 1.1 }}>
                {etaStatus.type === 'passed'
                  ? '이미 지나침'
                  : etaStatus.type === 'arriving'
                    ? '🚌 곧 도착!'
                    : etaStatus.type === 'approaching' && etaStatus.eta !== undefined
                      ? `약 ${etaStatus.eta}분 후 도착`
                      : '버스 대기 중'}
              </div>
              {/* 부가 정보 */}
              {etaStatus.type === 'passed' && (
                <div style={{ fontSize: 11, color: '#FF8C42', marginTop: 3 }}>
                  다음 버스를 기다려주세요
                </div>
              )}
              {etaStatus.type === 'arriving' && (
                <div style={{ fontSize: 11, color: '#FF4D6A', marginTop: 3, fontWeight: 700 }}>
                  탑승 준비하세요!
                </div>
              )}
              {mainBus && etaStatus.type === 'approaching' && (
                <div style={{ fontSize: 10, color: '#8896AA', marginTop: 2 }}>
                  {mainBus.vehicleNo} · {mainBus.speed ?? 0} km/h
                </div>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, flexShrink: 0 }}>
              <button onClick={onScanTab}
                style={{ background: 'linear-gradient(135deg,#1A6BFF,#00C2FF)', border: 'none', borderRadius: 10, padding: '9px 14px', color: '#fff', fontSize: 13, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
                📱 QR 탑승
              </button>
              <button onClick={() => setMyStopIdx(null)}
                style={{ background: '#1E3A5F', border: 'none', borderRadius: 8, padding: '5px 10px', color: '#8896AA', fontSize: 10, cursor: 'pointer', fontFamily: 'inherit' }}>
                정류장 변경
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1, fontSize: 11, color: '#8896AA' }}>
              {buses.length === 0 ? '현재 운행중인 버스가 없습니다' : '노선도에서 내 탑승 정류장을 클릭하세요'}
            </div>
            <button onClick={onScanTab}
              style={{ background: 'linear-gradient(135deg,#1A6BFF,#00C2FF)', border: 'none', borderRadius: 10, padding: '9px 14px', color: '#fff', fontSize: 13, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', flexShrink: 0 }}>
              📱 QR 탑승
            </button>
          </div>
        )}
      </div>
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
    <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden", background: "#0B1A2E" }}>
      <div style={{ background: "#112240", padding: "14px 16px", borderBottom: "1px solid #1E3A5F" }}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>노선 목록</div>
        <input style={{ ...S.input, marginBottom: 10 }} placeholder="🔍 노선명·코드 검색"
          value={search} onChange={e => setSearch(e.target.value)} />
        <div style={{ display: "flex", gap: 6, overflowX: "auto" }}>
          {["전체", "즐겨찾기", "운행중", "출근", "퇴근"].map(f => (
            <button key={f} onClick={() => setFilter(f)}
              style={{ flexShrink: 0, padding: "4px 12px", borderRadius: 14, border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 600,
                background: filter === f ? "linear-gradient(135deg,#1A6BFF,#00C2FF)" : "#1E3A5F",
                color: filter === f ? "#fff" : "#8896AA" }}>
              {f === "즐겨찾기" ? `⭐ ${f}` : f === "운행중" ? `🟢 ${f}` : f}
              {f === "즐겨찾기" && favorites.length > 0 ? ` ${favorites.length}` : ""}
            </button>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px" }}>
        {filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: 40, color: "#4A6FA5", fontSize: 13 }}>
            {filter === "즐겨찾기" ? "즐겨찾기한 노선이 없습니다\n노선 옆 ⭐를 눌러 추가하세요" : "해당하는 노선이 없습니다"}
          </div>
        ) : filtered.map(r => (
          <div key={r.id} style={{ background: "#112240", border: `1px solid ${favorites.includes(r.id) ? "rgba(255,209,102,.3)" : "#1E3A5F"}`, borderRadius: 12, padding: "14px 16px", marginBottom: 10 }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 10, background: r.type === "출근" ? "rgba(26,107,255,.2)" : "rgba(255,140,66,.15)", color: r.type === "출근" ? "#3D8BFF" : "#FF8C42", fontWeight: 600 }}>
                    {r.type}
                  </span>
                  {r.shift && <span style={{ fontSize: 10, color: "#8896AA" }}>{r.shift}</span>}
                  {r.code && <span style={{ fontSize: 10, color: "#8896AA", fontFamily: "monospace" }}>{r.code}</span>}
                  {gpsData[r.id] && (
                    <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 10, background: "rgba(0,196,140,.15)", color: "#00C48C", fontWeight: 600 }}>
                      🟢 {gpsData[r.id]}대 운행중
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#F0F4FF", marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.name}
                </div>
                <div style={{ fontSize: 12, color: "#8896AA" }}>
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
                <div style={{ fontSize: 11, color: "#00C2FF", background: "rgba(0,194,255,.08)", borderRadius: 6, padding: "4px 10px" }}>
                  ✓ 내 배정 노선
                </div>
              ) : <div />}
              <div style={{ display:"flex", gap:4 }}>
                <button onClick={(e) => { e.stopPropagation(); setStopModal(r); setModalMapView(false); }}
                  style={{ fontSize: 11, color: "#8896AA", background: "#1E3A5F", border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontFamily: "inherit" }}>
                  📍 정류장
                </button>
                <button onClick={(e) => { e.stopPropagation(); setStopModal(r); setModalMapView(true);
                    if (modalStops.length > 0) setModalCenter({ lat: modalStops[0].lat, lng: modalStops[0].lng });
                  }}
                  style={{ fontSize: 11, color: gpsData[r.id] ? "#00C48C" : "#8896AA", background: gpsData[r.id] ? "rgba(0,196,140,.15)" : "#1E3A5F", border: gpsData[r.id] ? "1px solid rgba(0,196,140,.3)" : "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontFamily: "inherit" }}>
                  🗺 {gpsData[r.id] ? `${gpsData[r.id]}대 운행중` : "지도"}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
      {/* ── 정류장 + 지도 통합 바텀시트 ── */}
      {stopModal && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.75)", zIndex:200, display:"flex", flexDirection:"column", justifyContent:"flex-end" }}
          onClick={() => setStopModal(null)}>
          <div style={{ background:"#112240", borderRadius:"20px 20px 0 0", width:"100%", maxHeight:"88dvh", display:"flex", flexDirection:"column" }}
            onClick={e => e.stopPropagation()}>

            {/* 핸들 + 헤더 */}
            <div style={{ padding:"12px 16px 10px", borderBottom:"1px solid #1E3A5F", flexShrink:0 }}>
              <div style={{ width:36, height:4, background:"#1E3A5F", borderRadius:2, margin:"0 auto 10px" }} />
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:3, flexWrap:"wrap" }}>
                    <span style={{ fontSize:10, padding:"2px 8px", borderRadius:10,
                      background: stopModal.type==="출근"?"rgba(26,107,255,.2)":"rgba(255,140,66,.15)",
                      color: stopModal.type==="출근"?"#3D8BFF":"#FF8C42", fontWeight:600 }}>
                      {stopModal.type}
                    </span>
                    {stopModal.shift && <span style={{ fontSize:10, color:"#8896AA" }}>{stopModal.shift}</span>}
                    {modalBuses.length > 0 && (
                      <span style={{ fontSize:10, padding:"2px 8px", borderRadius:10, background:"rgba(0,196,140,.15)", color:"#00C48C", fontWeight:600 }}>
                        🚌 {modalBuses.length}대 운행중
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize:14, fontWeight:700, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{stopModal.name}</div>
                  <div style={{ fontSize:11, color:"#8896AA" }}>출발 {stopModal.departTime}</div>
                </div>
                <button onClick={() => setStopModal(null)}
                  style={{ background:"#1E3A5F", border:"none", borderRadius:8, padding:"6px 12px", color:"#8896AA", cursor:"pointer", fontFamily:"inherit", fontSize:12, flexShrink:0, marginLeft:8 }}>
                  닫기
                </button>
              </div>

              {/* 보기 모드 전환 탭 */}
              <div style={{ display:"flex", gap:6, marginTop:10, background:"#0B1A2E", borderRadius:8, padding:3 }}>
                {[["list","📋 정류장 목록"],["map","🗺 실시간 지도"]].map(([v,label])=>(
                  <button key={v} onClick={()=>setModalMapView(v==="map")}
                    style={{ flex:1, padding:"7px", border:"none", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight:600,
                      background: (modalMapView ? v==="map" : v==="list") ? "linear-gradient(135deg,#1A6BFF,#00C2FF)" : "transparent",
                      color: (modalMapView ? v==="map" : v==="list") ? "#fff" : "#8896AA" }}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* ── 정류장 목록 보기 ── */}
            {!modalMapView && (
              <div style={{ overflowY:"auto", padding:"12px 16px 24px", flex:1 }}>
                {loadingStops ? (
                  <div style={{ textAlign:"center", padding:24, color:"#8896AA", fontSize:13 }}>로딩 중...</div>
                ) : modalStops.length === 0 ? (
                  <div style={{ textAlign:"center", padding:24, color:"#4A6FA5", fontSize:13 }}>등록된 정류장이 없습니다</div>
                ) : (
                  <div style={{ position:"relative" }}>
                    <div style={{ position:"absolute", left:13, top:14, bottom:14, width:2, background:"#1E3A5F", zIndex:0 }} />
                    {modalStops.map((s, i) => (
                      <div key={s.id} style={{ display:"flex", alignItems:"flex-start", gap:12, marginBottom:14, position:"relative", zIndex:1 }}>
                        <div style={{ width:26, height:26, borderRadius:"50%", flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center", fontSize:10, fontWeight:700,
                          background: i===0?"#00C48C":i===modalStops.length-1?"#FF4D6A":"#1A6BFF", color:"#fff", border:"3px solid #112240" }}>
                          {i===0?"출":i===modalStops.length-1?"도":i+1}
                        </div>
                        <div style={{ flex:1, paddingTop:3 }}>
                          <div style={{ fontSize:13, fontWeight: i===0||i===modalStops.length-1?700:500,
                            color: i===0?"#00C48C":i===modalStops.length-1?"#FF4D6A":"#F0F4FF" }}>
                            {s.name}
                          </div>
                          {s.address && <div style={{ fontSize:11, color:"#8896AA", marginTop:1 }}>{s.address}</div>}
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
                      strokeWeight={4} strokeColor="#1A6BFF" strokeOpacity={0.7} strokeStyle="solid"
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
                        <div style={{ background:"#00C48C", color:"#fff", borderRadius:8, padding:"2px 8px", fontSize:10, fontWeight:700, whiteSpace:"nowrap" }}>
                          출발 · {modalStops[0].name}
                        </div>
                      </CustomOverlayMap>
                      <CustomOverlayMap position={{ lat:modalStops[modalStops.length-1].lat, lng:modalStops[modalStops.length-1].lng }} yAnchor={2.8}>
                        <div style={{ background:"#FF4D6A", color:"#fff", borderRadius:8, padding:"2px 8px", fontSize:10, fontWeight:700, whiteSpace:"nowrap" }}>
                          도착 · {modalStops[modalStops.length-1].name}
                        </div>
                      </CustomOverlayMap>
                    </>
                  )}

                  {/* 실시간 버스 마커 */}
                  {modalBuses.map(b => b.lat && b.lng && (
                    <CustomOverlayMap key={b.id} position={{ lat:b.lat, lng:b.lng }} yAnchor={1.7}>
                      <div style={{ background:"#0B1A2E", border:"2px solid #00C2FF", borderRadius:18, padding:"4px 10px", display:"flex", alignItems:"center", gap:5, boxShadow:"0 2px 8px rgba(0,0,0,.6)" }}>
                        <span style={{ fontSize:14 }}>🚌</span>
                        <div>
                          <div style={{ fontSize:11, fontWeight:700, color:"#00C2FF" }}>{b.vehicleNo||b.vehicleId}</div>
                          <div style={{ fontSize:10, color:"#8896AA" }}>{b.speed??0} km/h</div>
                        </div>
                      </div>
                    </CustomOverlayMap>
                  ))}
                </Map>

                {/* 버스 없을 때 안내 */}
                {modalBuses.length === 0 && (
                  <div style={{ position:"absolute", bottom:12, left:"50%", transform:"translateX(-50%)", background:"rgba(17,34,64,.95)", border:"1px solid #1E3A5F", borderRadius:16, padding:"6px 16px", fontSize:11, color:"#8896AA", whiteSpace:"nowrap" }}>
                    현재 운행 중인 버스가 없습니다
                  </div>
                )}
              </div>
            )}
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
    <div style={{ display:"flex", flexDirection:"column", flex:1, overflow:"hidden", background:"#0B1A2E" }}>
      <div style={{ background:"#112240", padding:"14px 16px", borderBottom:"1px solid #1E3A5F" }}>
        <div style={{ fontSize:15, fontWeight:700 }}>QR 탑승</div>
        <div style={{ fontSize:12, color:"#8896AA", marginTop:2 }}>기사 폰의 QR코드를 스캔하세요</div>
      </div>

      <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:24, gap:20, overflowY:"auto" }}>

        {/* ── 준비 화면 ── */}
        {step === "ready" && (
          <>
            <div style={{ width:90, height:90, borderRadius:"50%", background:"rgba(26,107,255,.15)", border:"2px solid #1A6BFF", display:"flex", alignItems:"center", justifyContent:"center", fontSize:40 }}>📷</div>
            <div style={{ textAlign:"center" }}>
              <div style={{ fontSize:16, fontWeight:700, color:"#F0F4FF", marginBottom:6 }}>탑승 QR 스캔</div>
              <div style={{ fontSize:12, color:"#8896AA", lineHeight:1.6 }}>
                {session.name} ({session.empNo})<br/>으로 탑승 처리됩니다
              </div>
            </div>
            <button style={S.btn} onClick={startScan}>
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
                <div style={{ position:"absolute", top:"18%", left:"10%", width:30, height:30, borderTop:"3px solid #00C2FF", borderLeft:"3px solid #00C2FF", borderRadius:"6px 0 0 0" }}/>
                <div style={{ position:"absolute", top:"18%", right:"10%", width:30, height:30, borderTop:"3px solid #00C2FF", borderRight:"3px solid #00C2FF", borderRadius:"0 6px 0 0" }}/>
                <div style={{ position:"absolute", bottom:"18%", left:"10%", width:30, height:30, borderBottom:"3px solid #00C2FF", borderLeft:"3px solid #00C2FF", borderRadius:"0 0 0 6px" }}/>
                <div style={{ position:"absolute", bottom:"18%", right:"10%", width:30, height:30, borderBottom:"3px solid #00C2FF", borderRight:"3px solid #00C2FF", borderRadius:"0 0 6px 0" }}/>
              </div>
            </div>
            <div style={{ textAlign:"center", marginTop:14, fontSize:13, color:"#00C2FF", fontWeight:600 }}>{scanStatus}</div>
            <button style={{ ...S.btnSecondary, marginTop:12, width:"100%" }} onClick={reset}>취소</button>
          </div>
        )}

        {/* ── 탑승 확인 ── */}
        {step === "confirm" && tokenData && (
          <div style={{ width:"100%", maxWidth:320 }}>
            <div style={{ background:"#112240", borderRadius:16, padding:20, marginBottom:16, border:"1px solid rgba(0,196,140,.3)" }}>
              <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:14 }}>
                <span style={{ fontSize:22 }}>✅</span>
                <div style={{ fontSize:14, fontWeight:700, color:"#00C48C" }}>QR 인식 완료</div>
              </div>
              {[["노선",tokenData.routeName],["차량",tokenData.vehicleNo],["탑승자",`${session.name} (${session.empNo})`],["부서",session.dept||"–"]].map(([k,v])=>(
                <div key={k} style={{ display:"flex", justifyContent:"space-between", padding:"8px 0", borderBottom:"1px solid #1E3A5F" }}>
                  <span style={{ fontSize:12, color:"#8896AA" }}>{k}</span>
                  <span style={{ fontSize:13, fontWeight:600, color:"#F0F4FF" }}>{v}</span>
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
            <div style={{ fontSize:13, color:"#8896AA" }}>탑승 처리 중...</div>
          </>
        )}

        {/* ── 탑승 완료 ── */}
        {step === "success" && (
          <>
            <div style={{ width:80, height:80, borderRadius:"50%", background:"rgba(0,196,140,.15)", border:"2px solid #00C48C", display:"flex", alignItems:"center", justifyContent:"center", fontSize:36, color:"#00C48C" }}>✓</div>
            <div style={{ fontSize:22, fontWeight:800, color:"#00C48C" }}>탑승 완료!</div>
            <div style={{ fontSize:14, color:"#F0F4FF", fontWeight:600 }}>{session.name} ({session.dept})</div>
            <div style={{ fontSize:12, color:"#8896AA" }}>{new Date().toLocaleTimeString("ko-KR")}</div>
            <button style={{ ...S.btnSecondary, marginTop:8 }} onClick={reset}>확인</button>
          </>
        )}

        {/* ── 오류 ── */}
        {step === "error" && (
          <>
            <div style={{ width:72, height:72, borderRadius:"50%", background:"rgba(255,77,106,.15)", border:"2px solid #FF4D6A", display:"flex", alignItems:"center", justifyContent:"center", fontSize:32, color:"#FF4D6A" }}>✕</div>
            <div style={{ fontSize:18, fontWeight:700, color:"#FF4D6A" }}>오류</div>
            <div style={{ fontSize:13, color:"#8896AA", textAlign:"center", whiteSpace:"pre-line", lineHeight:1.6 }}>{errMsg}</div>
            <button style={S.btn} onClick={reset}>다시 시도</button>
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
    <div style={{ display: "flex", flexDirection: "column", flex: 1, overflowY: "auto", background: "#0B1A2E" }}>
      <div style={{ background: "#112240", padding: "14px 16px", borderBottom: "1px solid #1E3A5F" }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>설정</div>
      </div>

      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        {/* 내 정보 */}
        <div style={{ background: "#112240", borderRadius: 14, padding: "16px 18px" }}>
          <div style={{ fontSize: 11, color: "#8896AA", marginBottom: 10, fontWeight: 600, letterSpacing: "0.05em" }}>내 정보</div>
          {[["이름", session.name], ["사번", session.empNo], ["부서", session.dept || "–"], ["배정 노선", session.routeId || "–"]].map(([k,v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid #1E3A5F" }}>
              <span style={{ fontSize: 13, color: "#8896AA" }}>{k}</span>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{v}</span>
            </div>
          ))}
        </div>

        {/* PIN 변경 */}
        {msg && (
          <div style={{ background: msg.type==="error"?"rgba(255,77,106,.1)":msg.type==="warn"?"rgba(255,209,102,.08)":"rgba(0,196,140,.1)", border: `1px solid ${msg.type==="error"?"rgba(255,77,106,.3)":msg.type==="warn"?"rgba(255,209,102,.2)":"rgba(0,196,140,.3)"}`, borderRadius: 8, padding: "10px 14px", fontSize: 13, color: msg.type==="error"?"#FF4D6A":msg.type==="warn"?"#FFD166":"#00C48C" }}>
            {msg.text}
          </div>
        )}

        <div style={{ background: "#112240", borderRadius: 14, overflow: "hidden" }}>
          <button onClick={() => setShowPinChange(p => !p)}
            style={{ width: "100%", padding: "14px 18px", background: "transparent", border: "none", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", fontFamily: "inherit", color: "#F0F4FF" }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>🔐 PIN 변경</span>
            <span style={{ fontSize: 12, color: "#8896AA" }}>{showPinChange ? "▲" : "▼"}</span>
          </button>
          {showPinChange && (
            <div style={{ padding: "0 18px 18px", display: "flex", flexDirection: "column", gap: 8, borderTop: "1px solid #1E3A5F" }}>
              <input style={{ ...S.input, marginTop: 12 }} type="password" inputMode="numeric"
                placeholder="현재 PIN" maxLength={6} value={oldPin} onChange={e => setOldPin(e.target.value)} />
              <input style={S.input} type="password" inputMode="numeric"
                placeholder="새 PIN (4~6자리)" maxLength={6} value={newPin} onChange={e => setNewPin(e.target.value)} />
              <input style={S.input} type="password" inputMode="numeric"
                placeholder="새 PIN 확인" maxLength={6} value={confirmPin} onChange={e => setConfirmPin(e.target.value)} />
              <button style={{ ...S.btn, opacity: loading ? 0.6 : 1 }} onClick={handlePinChange} disabled={loading}>
                {loading ? "변경 중..." : "PIN 변경"}
              </button>
            </div>
          )}
        </div>

        {/* 로그아웃 */}
        <button style={{ background: "rgba(255,77,106,.1)", border: "1px solid rgba(255,77,106,.3)", borderRadius: 12, padding: "14px", color: "#FF4D6A", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}
          onClick={() => { if (window.confirm("로그아웃하시겠습니까?")) onLogout(); }}>
          로그아웃
        </button>

        <div style={{ fontSize: 11, color: "#4A6FA5", textAlign: "center" }}>BusLink v1.0 · buslink-prod.web.app</div>
      </div>
    </div>
  );
}

// ─── 스타일 ────────────────────────────────────────────
const S = {
  appWrap: { display: "flex", flexDirection: "column", height: "100dvh", maxHeight: "100dvh", background: "#0B1A2E", fontFamily: "'Noto Sans KR',sans-serif", color: "#F0F4FF", overflow: "hidden" },
  content: { flex: 1, display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" },
  tabBar: { display: "flex", background: "#112240", borderTop: "1px solid #1E3A5F", flexShrink: 0, paddingBottom: "env(safe-area-inset-bottom, 0px)" },
  tabBtn: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "8px 0", background: "transparent", border: "none", cursor: "pointer", fontFamily: "inherit", transition: "color .15s" },
  fullCenter: { minHeight: "100vh", background: "#0B1A2E", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Noto Sans KR',sans-serif" },
  loginCard: { background: "#112240", borderRadius: 24, padding: "32px 28px", width: "100%", maxWidth: 360, display: "flex", flexDirection: "column", gap: 0, boxShadow: "0 24px 64px rgba(0,0,0,.5)" },
  header: { display: "flex", alignItems: "center", gap: 12, marginBottom: 20 },
  logo: { width: 36, height: 36, borderRadius: 10, background: "linear-gradient(135deg,#1A6BFF,#00C2FF)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 14, color: "#fff", flexShrink: 0 },
  logoText: { fontSize: 18, fontWeight: 800, background: "linear-gradient(90deg,#1A6BFF,#00C2FF)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" },
  logoSub: { fontSize: 11, color: "#8896AA" },
  input: { background: "#0B1A2E", border: "1px solid #1E3A5F", borderRadius: 10, padding: "12px 14px", color: "#F0F4FF", fontSize: 15, outline: "none", fontFamily: "inherit", width: "100%", boxSizing: "border-box" },
  btn: { background: "linear-gradient(135deg,#1A6BFF,#00C2FF)", border: "none", borderRadius: 12, padding: "14px", color: "#fff", fontSize: 15, fontWeight: 800, cursor: "pointer", fontFamily: "inherit", width: "100%" },
  btnSecondary: { background: "#1E3A5F", border: "none", borderRadius: 10, padding: "12px", color: "#8896AA", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", width: "100%" },
  errorMsg: { background: "rgba(255,77,106,.1)", border: "1px solid rgba(255,77,106,.3)", borderRadius: 8, padding: "10px 14px", fontSize: 13, color: "#FF4D6A", whiteSpace: "pre-line", marginTop: 8 },
  spinner: { width: 36, height: 36, borderRadius: "50%", border: "3px solid #1E3A5F", borderTopColor: "#00C2FF", animation: "spin 0.8s linear infinite" },
};

const style = document.createElement("style");
style.textContent = "@keyframes spin{to{transform:rotate(360deg)}} @keyframes slideDown{from{transform:translateY(-100%)}to{transform:translateY(0)}}";
document.head.appendChild(style);
