import { useState, useEffect, useRef } from "react";
import { Map, MapMarker, Polyline, CustomOverlayMap } from "react-kakao-maps-sdk";
import { db, auth } from "../firebase";
import { signInAnonymously } from "firebase/auth";
import { collection, onSnapshot, query, where, doc, getDoc, getDocs, orderBy } from "firebase/firestore";
import { useAnimatedPositions } from "../lib/useAnimatedPositions";
import { calcETA } from "../lib/gps";
import { BusLinkLogo, Pill, StatusDot, Icon } from "../components/ui";

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
  const companyId = getParam("c") || "dy001";
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
  const buses = useAnimatedPositions(rawBuses);
  const [selected, setSelected] = useState(null);
  const [myStopIdx, setMyStopIdx] = useState(null); // 내 정류장 인덱스
  const [photoView, setPhotoView] = useState(null); // 정류장 사진 라이트박스(data URI)
  const [center, setCenter] = useState({ lat: 37.3894, lng: 126.9522 });
  const [lastUpdate, setLastUpdate] = useState(null);
  const [routeList, setRouteList] = useState([]);     // 회사 노선 목록(선택 UI용)
  const [showPicker, setShowPicker] = useState(false); // 노선 변경 모달 표시
  const [routeQuery, setRouteQuery] = useState("");    // 노선 검색어

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
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      list.sort((a, b) => (a.departTime || "") > (b.departTime || "") ? 1 : -1);
      setRouteList(list);
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

  // 실시간 버스 위치 구독
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
  }, [companyId, routeId, ready]);

  // 노선 미선택 첫 진입 시 노선 선택 모달 1회 자동 노출(리디자인 의도 보존).
  // 지도는 이미 렌더됨 — 모달은 비차단 오버레이라 닫으면 전체 버스 지도.
  const pickerAutoOpened = useRef(false);
  useEffect(() => {
    if (ready && !routeId && !pickerAutoOpened.current) {
      pickerAutoOpened.current = true;
      setShowPicker(true);
    }
  }, [ready, routeId]);

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

  // 내 정류장까지 ETA
  const getMyETA = () => {
    if (!mainBus || myStopIdx === null || !stops[myStopIdx]) return null;
    return calcETA(
      { lat: mainBus.lat, lng: mainBus.lng },
      stops[myStopIdx],
      mainBus.speed
    );
  };

  // 폴리라인 경로
  const routePath = stops.map(s => ({ lat: s.lat, lng: s.lng }));

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
          placeholder="노선명·거래처·구분 검색"
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

  if (!ready) return (
    <div style={S.fullCenter}>
      <div style={{ color: "var(--color-primary)", fontSize: 16, fontWeight: 600 }}>로딩 중...</div>
    </div>
  );

  // 노선 미선택 시: 풀스크린 지도(전 노선 버스 표시 — 구버전 동작)는 그대로
  // 렌더하고, 그 위에 노선 선택 모달을 1회 자동 노출(리디자인 의도=자가 선택·
  // 기준노선 기억 보존). 닫으면 전체 버스 지도만 본다(딥링크/QR 무 파라미터 호환).
  // 회귀: 기존 `if(!routeId) return <picker전용화면>` 하드 게이트가 무 파라미터
  // /bus 진입 시 지도를 아예 막던 것을 제거(증상1 원인) — 지도 경로는 routeId
  // null 을 이미 전 구간 가드(폴리라인/필터/center)하므로 로직 추가 없음.

  const eta = getMyETA();
  const myStop = myStopIdx !== null ? stops[myStopIdx] : null;
  // 진행률 — 노선 모드에서 내 정류장 기준(시각 전용, 실제 stops 인덱스 기반)
  const progressPct = (myStopIdx !== null && stops.length > 1)
    ? Math.round((myStopIdx / (stops.length - 1)) * 100)
    : 0;

  return (
    <div style={S.wrap}>
      {/* 풀스크린 지도 (카카오맵 — 구조 불변) */}
      <div style={S.mapLayer}>
        <Map center={center} style={{ width: "100%", height: "100%" }} level={routeId ? 9 : 7}
          onCenterChanged={map => {}}>

          {/* 노선 폴리라인 */}
          {routePath.length >= 2 && (
            <Polyline path={routePath} strokeWeight={5} strokeColor="#0066FF" strokeOpacity={0.85} strokeStyle="solid" />
          )}

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

          {/* 정류장 번호 오버레이 */}
          {stops.map((s, i) => (
            <CustomOverlayMap key={`ov-${s.id}`} position={{ lat: s.lat, lng: s.lng }} yAnchor={2.8}>
              <div style={{
                background: myStopIdx === i ? "var(--color-primary)" : "#fff",
                color: myStopIdx === i ? "#fff" : "var(--color-label)",
                borderRadius: 999, padding: "2px 8px", fontSize: 10, fontWeight: 700,
                border: `1px solid ${myStopIdx === i ? "var(--color-primary)" : "rgba(112,115,124,0.18)"}`,
                whiteSpace: "nowrap", boxShadow: "0 1px 3px rgba(23,23,23,0.12)",
              }}>
                {i+1}. {s.name}
              </div>
            </CustomOverlayMap>
          ))}

          {/* 버스 마커 */}
          {buses.map(b => b.lat && b.lng && (
            <CustomOverlayMap key={b.id} position={{ lat: b.lat, lng: b.lng }} yAnchor={1.5}>
              <div onClick={() => setSelected(b === selected ? null : b)}
                style={{
                  background: selected?.id === b.id ? "var(--color-primary)" : "#fff",
                  border: `2px solid var(--color-primary)`,
                  borderRadius: 999, padding: "5px 11px", cursor: "pointer",
                  display: "flex", alignItems: "center", gap: 7,
                  boxShadow: "0 4px 14px rgba(0,102,255,0.28)",
                }}>
                <span style={{ fontSize: 15 }}>🚌</span>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 800, color: selected?.id === b.id ? "#fff" : "var(--color-label)" }}>{b.vehicleNo || b.id}</div>
                  <div style={{ fontSize: 10, fontWeight: 600, color: selected?.id === b.id ? "rgba(255,255,255,0.85)" : "var(--color-label-mute)" }}>{b.speed ?? 0} km/h</div>
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
        {/* 노선 변경 진입점 — 기준 노선 갱신 */}
        <button onClick={() => { setRouteQuery(""); setShowPicker(true); }} style={S.changeRouteBtn}>
          <Icon name="route" size={13} /> 노선 변경
        </button>
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
              도착 카운트다운
            </Pill>
            <span style={S.etaLive}>
              {lastUpdate ? `${timeSince(lastUpdate)} 갱신` : "실시간"}
            </span>
          </div>

          {eta !== null ? (
            <div style={S.etaBig}>
              <span style={{ ...S.etaNum, color: eta <= 5 ? "var(--color-destructive)" : "var(--color-primary)" }}>{eta}</span>
              <span style={S.etaUnit}>분</span>
              <span style={S.etaSub}>후 도착 예정</span>
            </div>
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
            <span>출발 정류장</span>
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
                  </div>
                  {myStopIdx === i && (
                    <span style={S.tagMyStop}>내 정류장</span>
                  )}
                  {mainBus && myStopIdx === null && (
                    <span style={S.stopEta}>
                      {calcETA({ lat: mainBus.lat, lng: mainBus.lng }, s, mainBus.speed)}분
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
    fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
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
