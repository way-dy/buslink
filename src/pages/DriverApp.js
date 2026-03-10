import { useState, useEffect } from "react";
import { auth, db } from "../firebase";
import { signOut } from "firebase/auth";
import { collection, query, where, getDocs } from "firebase/firestore";
import { startGPS, stopGPS } from "../lib/gps";

export default function DriverApp() {
  const [driver, setDriver] = useState(null);
  const [dispatch, setDispatch] = useState(null);
  const [driving, setDriving] = useState(false);
  const [watchId, setWatchId] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const u = auth.currentUser;
    if (!u) return;
    const init = async () => {
      const q = query(
        collection(db, "companies", "dy001", "drivers"),
        where("uid", "==", u.uid)
      );
      const snap = await getDocs(q);
      if (!snap.empty) {
        const d = { id: snap.docs[0].id, ...snap.docs[0].data() };
        setDriver(d);
        await loadDispatch(d.id);
      }
      setLoading(false);
    };
    init();
  }, []);

  const loadDispatch = async (driverId) => {
    const today = new Date().toISOString().slice(0, 10);
    const q = query(
      collection(db, "companies", "dy001", "dispatches", today, "list"),
      where("driverId", "==", driverId)
    );
    const snap = await getDocs(q);
    if (!snap.empty) setDispatch({ id: snap.docs[0].id, ...snap.docs[0].data() });
  };

  const handleStart = () => {
    const id = startGPS({
      companyId: "dy001",
      vehicleId: driver.vehicleId,
      driverId: driver.id,
      routeId: dispatch?.routeId,
    });
    setWatchId(id);
    setDriving(true);
  };

  const handleStop = () => {
    stopGPS(watchId);
    setDriving(false);
    setWatchId(null);
  };

  const handleLogout = () => {
    if (driving) handleStop();
    signOut(auth);
  };

  if (loading) return (
    <div style={{ minHeight:"100vh", background:"#0B1A2E", display:"flex", alignItems:"center", justifyContent:"center", color:"#00C2FF", fontSize:18, fontFamily:"'Noto Sans KR',sans-serif" }}>
      로딩 중...
    </div>
  );

  return (
    <div style={S.container}>
      <div style={S.card}>
        <div style={S.header}>
          <div>
            <p style={S.greeting}>안녕하세요 👋</p>
            <p style={S.driverName}>{driver?.name} 기사님</p>
          </div>
          <button style={S.logoutBtn} onClick={handleLogout}>로그아웃</button>
        </div>

        {dispatch ? (
          <div style={S.dispatchBox}>
            <p style={S.label}>오늘 배차</p>
            <p style={S.routeName}>{dispatch.routeName}</p>
            <p style={S.vehicleNo}>{dispatch.vehicleNo}</p>
            <p style={S.departTime}>출발 {dispatch.departTime}</p>
          </div>
        ) : (
          <div style={S.dispatchBox}>
            <p style={{ color: "#8896AA", textAlign:"center" }}>오늘 배차된 노선이 없습니다</p>
          </div>
        )}

        {!driving ? (
          <button style={{ ...S.btn, background: "#00C48C" }} onClick={handleStart}>
            🟢 운행 시작
          </button>
        ) : (
          <>
            <div style={S.gpsStatus}>
              <span style={S.dot} /> GPS 전송 중...
            </div>
            <button style={{ ...S.btn, background: "#FF4D6A" }} onClick={handleStop}>
              🔴 운행 종료
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const S = {
  container: { minHeight:"100vh", background:"#0B1A2E", display:"flex", alignItems:"center", justifyContent:"center", padding:20, fontFamily:"'Noto Sans KR',sans-serif" },
  card: { background:"#112240", borderRadius:20, padding:"32px", width:"100%", maxWidth:360, display:"flex", flexDirection:"column", gap:16, boxShadow:"0 20px 60px rgba(0,0,0,0.4)" },
  header: { display:"flex", justifyContent:"space-between", alignItems:"flex-start" },
  greeting: { color:"#8896AA", fontSize:13, margin:0 },
  driverName: { color:"#F0F4FF", fontSize:18, fontWeight:700, margin:"4px 0 0" },
  logoutBtn: { background:"transparent", border:"1px solid #1E3A5F", borderRadius:8, padding:"6px 12px", color:"#8896AA", fontSize:12, cursor:"pointer", fontFamily:"inherit" },
  dispatchBox: { background:"#0B1A2E", borderRadius:12, padding:20, border:"1px solid #1E3A5F" },
  label: { color:"#8896AA", fontSize:12, marginBottom:8, margin:"0 0 8px" },
  routeName: { color:"#00C2FF", fontSize:18, fontWeight:700, margin:"0 0 4px" },
  vehicleNo: { color:"#F0F4FF", fontSize:15, margin:"0 0 4px" },
  departTime: { color:"#FFD166", fontSize:14, margin:0 },
  btn: { border:"none", borderRadius:10, padding:"14px", color:"#fff", fontSize:16, fontWeight:700, cursor:"pointer", fontFamily:"inherit" },
  gpsStatus: { color:"#00C48C", fontSize:14, display:"flex", alignItems:"center", gap:8, justifyContent:"center" },
  dot: { width:10, height:10, borderRadius:"50%", background:"#00C48C", display:"inline-block" },
};