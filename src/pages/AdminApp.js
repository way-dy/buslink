import { useState, useEffect, useRef } from "react";
import { db } from "../firebase";
import { collection, onSnapshot, query, where } from "firebase/firestore";

const COMPANY_ID = "dy001";

export default function AdminApp() {
  const [vehicles, setVehicles] = useState([]);
  const [selected, setSelected] = useState(null);
  const [mapReady, setMapReady] = useState(false);
  const mapRef = useRef(null);
  const kakaoMapRef = useRef(null);
  const markersRef = useRef({});
  const vehiclesRef = useRef([]);

  // 카카오맵 초기화
  useEffect(() => {
    const initMap = () => {
      const container = mapRef.current;
      if (!container) return;
      kakaoMapRef.current = new window.kakao.maps.Map(container, {
        center: new window.kakao.maps.LatLng(36.3504, 127.3845),
        level: 7,
      });
      setMapReady(true);
    };

    const waitForKakao = () => {
      if (window._kakaoReady && window.kakao && window.kakao.maps) {
        initMap();
      } else {
        setTimeout(waitForKakao, 200);
      }
    };

    waitForKakao();
  }, []);

  useEffect(() => {
    if (mapReady && vehiclesRef.current.length > 0) {
      updateMarkers(vehiclesRef.current);
    }
  }, [mapReady]); // eslint-disable-line

  useEffect(() => {
    const q = query(collection(db, "gps"), where("companyId", "==", COMPANY_ID));
    const unsub = onSnapshot(q, (snap) => {
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      vehiclesRef.current = list;
      setVehicles(list);
      if (mapReady) updateMarkers(list);
    });
    return () => unsub();
  }, [mapReady]); // eslint-disable-line

  const updateMarkers = (list) => {
    if (!kakaoMapRef.current || !window.kakao) return;
    list.forEach(v => {
      if (!v.lat || !v.lng) return;
      const pos = new window.kakao.maps.LatLng(v.lat, v.lng);
      if (markersRef.current[v.id]) {
        markersRef.current[v.id].setPosition(pos);
      } else {
        const marker = new window.kakao.maps.Marker({ position: pos, map: kakaoMapRef.current });
        window.kakao.maps.event.addListener(marker, "click", () => {
          setSelected(v);
          kakaoMapRef.current.panTo(pos);
        });
        markersRef.current[v.id] = marker;
      }
      kakaoMapRef.current.panTo(pos);
    });
  };

  return (
    <div style={S.wrap}>
      <div style={S.sidebar}>
        <div style={S.logo}>
          <span style={S.logoText}>BusLink</span>
          <span style={S.logoSub}>관리자</span>
        </div>
        <div style={S.sectionTitle}>운행 중인 차량</div>
        {vehicles.length === 0 ? (
          <div style={S.empty}>운행 중인 차량 없음</div>
        ) : vehicles.map(v => (
          <div key={v.id} onClick={() => {
            setSelected(v);
            if (kakaoMapRef.current && v.lat && v.lng)
              kakaoMapRef.current.panTo(new window.kakao.maps.LatLng(v.lat, v.lng));
          }} style={{ ...S.vehicleCard, border: selected?.id === v.id ? "1px solid #00C2FF" : "1px solid #1E3A5F" }}>
            <div style={S.vehicleTop}><span style={S.dot} /><span style={S.vehicleName}>{v.id}</span></div>
            <div style={S.vehicleInfo}>기사: {v.driverId}</div>
            <div style={S.vehicleInfo}>속도: {v.speed} km/h</div>
            <div style={S.vehicleInfo}>정확도: ±{v.accuracy}m</div>
          </div>
        ))}
      </div>

      <div style={S.mapArea}>
        <div style={S.mapHeader}>
          <span style={S.mapTitle}>실시간 차량 관제</span>
          <span style={S.mapCount}>{vehicles.length}대 운행 중</span>
        </div>
        <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
          <div ref={mapRef} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }} />
          {!mapReady && <div style={S.mapLoading}>지도 로딩 중...</div>}
          {selected && (
            <div style={S.infoBox}>
              <div style={S.infoTitle}>📍 {selected.id}</div>
              <div style={S.infoRow}>위도: {selected.lat?.toFixed(6)}</div>
              <div style={S.infoRow}>경도: {selected.lng?.toFixed(6)}</div>
              <div style={S.infoRow}>속도: {selected.speed} km/h</div>
              <div style={S.infoRow}>정확도: ±{selected.accuracy}m</div>
              <div style={S.infoRow}>노선: {selected.routeId}</div>
              <button onClick={() => setSelected(null)} style={S.closeBtn}>닫기</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const S = {
  wrap: { display: "flex", height: "100vh", background: "#0B1A2E", fontFamily: "'Noto Sans KR',sans-serif", color: "#F0F4FF" },
  sidebar: { width: 280, background: "#112240", borderRight: "1px solid #1E3A5F", display: "flex", flexDirection: "column", padding: 20, gap: 12, overflowY: "auto" },
  logo: { display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8, paddingBottom: 16, borderBottom: "1px solid #1E3A5F" },
  logoText: { fontSize: 20, fontWeight: 800, background: "linear-gradient(90deg,#1A6BFF,#00C2FF)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" },
  logoSub: { fontSize: 12, color: "#8896AA" },
  sectionTitle: { fontSize: 12, color: "#8896AA", fontWeight: 600, letterSpacing: 1 },
  empty: { color: "#4A6FA5", fontSize: 13, textAlign: "center", padding: 20 },
  vehicleCard: { background: "#0B1A2E", borderRadius: 10, padding: "12px 14px", cursor: "pointer", transition: "all .2s" },
  vehicleTop: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 },
  dot: { width: 8, height: 8, borderRadius: "50%", background: "#00C48C", flexShrink: 0, boxShadow: "0 0 6px #00C48C" },
  vehicleName: { fontSize: 13, fontWeight: 600 },
  vehicleInfo: { fontSize: 12, color: "#8896AA", marginTop: 2 },
  mapArea: { flex: 1, display: "flex", flexDirection: "column", minHeight: 0 },
  mapHeader: { padding: "16px 24px", borderBottom: "1px solid #1E3A5F", display: "flex", alignItems: "center", justifyContent: "space-between", background: "#112240" },
  mapTitle: { fontSize: 16, fontWeight: 700 },
  mapCount: { fontSize: 13, color: "#00C48C", fontWeight: 600 },
  mapLoading: { position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", color: "#4A6FA5", fontSize: 14 },
  infoBox: { position: "absolute", top: 20, right: 20, background: "#112240", border: "1px solid #1E3A5F", borderRadius: 12, padding: 20, minWidth: 220, zIndex: 10 },
  infoTitle: { fontSize: 14, fontWeight: 700, marginBottom: 12, color: "#00C2FF" },
  infoRow: { fontSize: 13, color: "#8896AA", marginBottom: 6 },
  closeBtn: { marginTop: 8, width: "100%", padding: "8px", background: "rgba(255,255,255,.05)", border: "1px solid #1E3A5F", borderRadius: 8, color: "#8896AA", cursor: "pointer", fontFamily: "inherit" },
};