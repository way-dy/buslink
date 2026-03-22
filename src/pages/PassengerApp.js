import { useState, useEffect } from "react";
import { Map, MapMarker, Polyline, CustomOverlayMap } from "react-kakao-maps-sdk";
import { db, auth } from "../firebase";
import { signInAnonymously } from "firebase/auth";
import { collection, onSnapshot, query, where, doc, getDoc, getDocs, orderBy } from "firebase/firestore";
import { useAnimatedPositions } from "../lib/useAnimatedPositions";
import { calcETA } from "../lib/gps";

function getParam(key) {
  return new URLSearchParams(window.location.search).get(key);
}

export default function PassengerApp() {
  const companyId = getParam("c") || "dy001";
  const routeId   = getParam("route") || getParam("r"); // route=routeId 또는 r=routeId

  const [ready, setReady] = useState(false);
  const [company, setCompany] = useState(null);
  const [route, setRoute] = useState(null);
  const [stops, setStops] = useState([]);
  const [rawBuses, setRawBuses] = useState([]);
  const buses = useAnimatedPositions(rawBuses);
  const [selected, setSelected] = useState(null);
  const [myStopIdx, setMyStopIdx] = useState(null); // 내 정류장 인덱스
  const [center, setCenter] = useState({ lat: 37.3894, lng: 126.9522 });
  const [lastUpdate, setLastUpdate] = useState(null);

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

  if (!ready) return (
    <div style={{ minHeight:"100vh", background:"#0B1A2E", display:"flex", alignItems:"center", justifyContent:"center", color:"#00C2FF", fontSize:16 }}>
      로딩 중...
    </div>
  );

  const eta = getMyETA();

  return (
    <div style={S.wrap}>
      {/* 헤더 */}
      <div style={S.header}>
        <div style={S.headerLeft}>
          <div style={S.brandMark}>BL</div>
          <div>
            <div style={S.headerTitle}>
              {company?.name || "BusLink"}
              {route && <span style={{ fontSize:12, color:"#8896AA", fontWeight:400, marginLeft:6 }}>· {route.name}</span>}
            </div>
            {!route && <div style={{ fontSize:11, color:"#8896AA" }}>실시간 위치</div>}
          </div>
        </div>
        <div style={S.headerRight}>
          {buses.length > 0 && <div style={S.liveDot} />}
          <span style={{ fontSize:12, color: buses.length > 0 ? "#00C48C" : "#8896AA", fontWeight:600 }}>
            {buses.length > 0 ? `${buses.length}대 운행 중` : "운행 없음"}
          </span>
        </div>
      </div>

      {/* ETA 배너 (노선 모드 + 내 정류장 선택 시) */}
      {route && myStopIdx !== null && stops[myStopIdx] && (
        <div style={{ background: eta !== null && eta <= 5 ? "rgba(255,77,106,.15)" : "rgba(0,194,255,.1)", borderBottom:"1px solid rgba(0,194,255,.2)", padding:"10px 16px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <div>
            <div style={{ fontSize:11, color:"#8896AA" }}>내 정류장 · {stops[myStopIdx].name}</div>
            {eta !== null ? (
              <div style={{ fontSize:20, fontWeight:800, color: eta <= 5 ? "#FF4D6A" : "#00C2FF" }}>
                약 {eta}분 후 도착
              </div>
            ) : (
              <div style={{ fontSize:14, color:"#8896AA" }}>버스 운행 대기 중</div>
            )}
          </div>
          <button onClick={() => setMyStopIdx(null)} style={{ background:"transparent", border:"1px solid #1E3A5F", borderRadius:6, padding:"4px 10px", color:"#8896AA", fontSize:11, cursor:"pointer", fontFamily:"inherit" }}>
            변경
          </button>
        </div>
      )}

      {/* 지도 */}
      <div style={{ flex: routeId ? "1 1 55%" : "1 1 50%", minHeight:0, position:"relative" }}>
        <Map center={center} style={{ width:"100%", height:"100%" }} level={routeId ? 9 : 7}
          onCenterChanged={map => {}}>

          {/* 노선 폴리라인 */}
          {routePath.length >= 2 && (
            <Polyline path={routePath} strokeWeight={4} strokeColor="#1A6BFF" strokeOpacity={0.6} strokeStyle="solid" />
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
              <div style={{ background: myStopIdx===i ? "#00C2FF" : "#112240", color: myStopIdx===i ? "#0B1A2E" : "#8896AA", borderRadius:10, padding:"1px 6px", fontSize:10, fontWeight:700, border:`1px solid ${myStopIdx===i?"#00C2FF":"#1E3A5F"}`, whiteSpace:"nowrap" }}>
                {i+1}. {s.name}
              </div>
            </CustomOverlayMap>
          ))}

          {/* 버스 마커 */}
          {buses.map(b => b.lat && b.lng && (
            <CustomOverlayMap key={b.id} position={{ lat: b.lat, lng: b.lng }} yAnchor={1.5}>
              <div onClick={() => setSelected(b === selected ? null : b)}
                style={{ background: selected?.id===b.id ? "#00C2FF" : "#112240", border:`2px solid ${selected?.id===b.id?"#00C2FF":"#1A6BFF"}`, borderRadius:20, padding:"4px 10px", cursor:"pointer", display:"flex", alignItems:"center", gap:6, boxShadow:"0 2px 12px rgba(0,0,0,.4)" }}>
                <span style={{ fontSize:16 }}>🚌</span>
                <div>
                  <div style={{ fontSize:11, fontWeight:700, color: selected?.id===b.id ? "#0B1A2E" : "#F0F4FF" }}>{b.vehicleNo || b.id}</div>
                  <div style={{ fontSize:10, color: selected?.id===b.id ? "#0B1A2E88" : "#8896AA" }}>{b.speed ?? 0} km/h</div>
                </div>
              </div>
            </CustomOverlayMap>
          ))}
        </Map>

        {/* 내 정류장 선택 안내 (노선 모드) */}
        {route && stops.length > 0 && myStopIdx === null && (
          <div style={{ position:"absolute", bottom:12, left:"50%", transform:"translateX(-50%)", background:"#112240", border:"1px solid #1A6BFF", borderRadius:20, padding:"8px 16px", fontSize:12, color:"#00C2FF", fontWeight:600, zIndex:5, whiteSpace:"nowrap" }}>
            📍 내 탑승 정류장을 클릭하면 ETA를 확인할 수 있습니다
          </div>
        )}
      </div>

      {/* 하단 정류장 목록 또는 버스 목록 */}
      <div style={S.bottomSheet}>
        <div style={S.sheetHandle} />

        {routeId && stops.length > 0 ? (
          /* 정류장 목록 모드 */
          <>
            <div style={S.sheetTitle}>
              <span>정류장 목록 ({stops.length})</span>
              {lastUpdate && <span style={S.updateTime}>{timeSince(lastUpdate)} 갱신</span>}
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
              {stops.map((s, i) => (
                <div key={s.id} onClick={() => { setMyStopIdx(i); setCenter({ lat:s.lat, lng:s.lng }); }}
                  style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 10px", borderRadius:10, cursor:"pointer",
                    background: myStopIdx===i ? "rgba(0,194,255,.1)" : "transparent",
                    border: `1px solid ${myStopIdx===i ? "rgba(0,194,255,.3)" : "transparent"}` }}>
                  <div style={{ width:22, height:22, borderRadius:"50%", background: myStopIdx===i ? "#00C2FF" : "#1E3A5F", color: myStopIdx===i ? "#0B1A2E" : "#8896AA", display:"flex", alignItems:"center", justifyContent:"center", fontSize:10, fontWeight:700, flexShrink:0 }}>
                    {i+1}
                  </div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:13, fontWeight: myStopIdx===i ? 700 : 400, color: myStopIdx===i ? "#00C2FF" : "#F0F4FF", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                      {s.name}
                    </div>
                    {s.address && <div style={{ fontSize:11, color:"#8896AA", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{s.address}</div>}
                  </div>
                  {myStopIdx === i && (
                    <span style={{ fontSize:10, background:"#00C2FF22", color:"#00C2FF", borderRadius:10, padding:"2px 8px", flexShrink:0 }}>내 정류장</span>
                  )}
                  {mainBus && myStopIdx === null && (
                    <span style={{ fontSize:10, color:"#4A6FA5", flexShrink:0 }}>
                      {calcETA({ lat:mainBus.lat, lng:mainBus.lng }, s, mainBus.speed)}분
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
              운행 중인 버스
              {lastUpdate && <span style={S.updateTime}>{timeSince(lastUpdate)} 갱신</span>}
            </div>
            {buses.length === 0 ? (
              <div style={S.emptyMsg}>
                <div style={{ fontSize:36, marginBottom:8 }}>🚌</div>
                <div>현재 운행 중인 버스가 없습니다</div>
                <div style={{ fontSize:12, color:"#8896AA", marginTop:4 }}>운행이 시작되면 자동으로 표시됩니다</div>
              </div>
            ) : (
              <div style={S.busList}>
                {buses.map(b => (
                  <div key={b.id}
                    style={{ ...S.busCard, border: selected?.id===b.id ? "1px solid #00C2FF" : "1px solid #1E3A5F" }}
                    onClick={() => { setSelected(b === selected ? null : b); if (b.lat && b.lng) setCenter({ lat:b.lat, lng:b.lng }); }}>
                    <div style={S.busCardTop}>
                      <div style={S.busIcon}>🚌</div>
                      <div style={{ flex:1, minWidth:0 }}>
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
    </div>
  );
}

const S = {
  wrap: { display:"flex", flexDirection:"column", height:"100vh", background:"#0B1A2E", fontFamily:"'Noto Sans KR',sans-serif", color:"#F0F4FF" },
  header: { display:"flex", justifyContent:"space-between", alignItems:"center", padding:"10px 16px", background:"#112240", borderBottom:"1px solid #1E3A5F", flexShrink:0, zIndex:10 },
  headerLeft: { display:"flex", alignItems:"center", gap:10 },
  brandMark: { width:30, height:30, background:"linear-gradient(135deg,#1A6BFF,#00C2FF)", borderRadius:8, display:"flex", alignItems:"center", justifyContent:"center", fontWeight:800, fontSize:11, color:"#fff", flexShrink:0 },
  headerTitle: { fontSize:14, fontWeight:700 },
  headerRight: { display:"flex", alignItems:"center", gap:6 },
  liveDot: { width:8, height:8, borderRadius:"50%", background:"#00C48C", boxShadow:"0 0 8px #00C48C" },
  bottomSheet: { background:"#112240", borderTop:"1px solid #1E3A5F", padding:"8px 16px 16px", maxHeight:"38vh", overflowY:"auto", flexShrink:0 },
  sheetHandle: { width:36, height:4, background:"#1E3A5F", borderRadius:2, margin:"0 auto 10px" },
  sheetTitle: { fontSize:14, fontWeight:700, marginBottom:10, display:"flex", justifyContent:"space-between", alignItems:"center" },
  updateTime: { fontSize:11, color:"#8896AA", fontWeight:400 },
  emptyMsg: { textAlign:"center", padding:"16px 0", color:"#4A6FA5", fontSize:14 },
  busList: { display:"flex", flexDirection:"column", gap:8 },
  busCard: { background:"#0B1A2E", borderRadius:10, padding:"12px 14px", cursor:"pointer", transition:"border .15s" },
  busCardTop: { display:"flex", alignItems:"center", gap:10 },
  busIcon: { fontSize:22, width:38, height:38, background:"#1A6BFF22", borderRadius:10, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 },
  busName: { fontSize:14, fontWeight:700 },
  busRoute: { fontSize:11, color:"#8896AA", marginTop:2, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" },
  busSpeed: { textAlign:"center", flexShrink:0 },
  speedNum: { fontSize:20, fontWeight:800, color:"#00C2FF" },
  speedUnit: { fontSize:10, color:"#8896AA" },
  busCardBottom: { display:"flex", justifyContent:"space-between", marginTop:8, paddingTop:8, borderTop:"1px solid #1E3A5F" },
  busAccuracy: { fontSize:11, color:"#8896AA" },
  busTime: { fontSize:11, color:"#8896AA" },
};
