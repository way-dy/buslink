import { useState, useEffect, useRef } from "react";
import { auth, db } from "../firebase";
import { signOut } from "firebase/auth";
import { collection, query, where, getDocs, doc, updateDoc, orderBy } from "firebase/firestore";
import { startGPS, stopGPS, clearGPS } from "../lib/gps";
import { createBoardingToken, getBoardingUrl } from "../lib/boarding";
import QRCode from "qrcode";

export default function DriverApp({ companyId: propCompanyId }) {
  const [driver, setDriver] = useState(null);
  const [dispatch, setDispatch] = useState(null);
  const [stops, setStops] = useState([]);
  const [currentStopIdx, setCurrentStopIdx] = useState(-1);
  const [boardingToken, setBoardingToken] = useState(null);   // 현재 탑승 토큰
  const [qrUrl, setQrUrl] = useState(null);        // 탑승 링크 URL
  const [qrDataUrl, setQrDataUrl] = useState(null); // canvas → base64 이미지
  const [activeTab, setActiveTab] = useState("운행");          // "운행" | "QR"
  const tokenTimerRef = useRef(null);
  const [nextStopDist, setNextStopDist] = useState(null);
  const [driving, setDriving] = useState(false);
  const [watchId, setWatchId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [companyId, setCompanyId] = useState(propCompanyId || "dy001");
  const wakeLockRef = useRef(null);

  // 알림 권한 요청
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  useEffect(() => {
    const u = auth.currentUser;
    if (!u) return;
    const cid = propCompanyId || "dy001";
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
    if (!snap.empty) {
      const d = { id: snap.docs[0].id, ...snap.docs[0].data() };
      setDispatch(d);
      // 정류장 로드
      if (d.routeId) await loadStops(d.routeId, cid);
    }
  };

  const loadStops = async (routeId, cid) => {
    try {
      const snap = await getDocs(query(
        collection(db, "companies", cid, "routes", routeId, "stops"),
        orderBy("order", "asc")
      ));
      setStops(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (e) {
      console.warn("[BusLink] 정류장 로드 실패:", e.message);
    }
  };

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
    if ("wakeLock" in navigator) {
      try { wakeLockRef.current = await navigator.wakeLock.request("screen"); } catch {}
    }
    await updateDoc(doc(db, "companies", companyId, "drivers", driver.id), {
      status: "운행중", startedAt: new Date().toISOString(),
    });
    const id = startGPS({
      companyId, vehicleId: driver.vehicleId, vehicleNo: driver.vehicleNo || "",
      driverId: driver.id, driverName: driver.name || "",
      routeId: dispatch?.routeId || "", routeName: dispatch?.routeName || "",
      stops,
      onStopReached: (stop, dist) => {
        setCurrentStopIdx(stops.findIndex(s => s.id === stop.id));
        sendNotification(stop, dist);
      },
    });
    setWatchId(id);
    setDriving(true);
    // ✅ 탑승 QR 토큰 최초 생성
    await refreshToken(driver, dispatch);
    // 5분마다 자동 갱신
    tokenTimerRef.current = setInterval(() => refreshToken(driver, dispatch), 5 * 60 * 1000);
  };

  const handleStop = async () => {
    stopGPS(watchId);
    await clearGPS({ companyId, vehicleId: driver.vehicleId });
    await updateDoc(doc(db, "companies", companyId, "drivers", driver.id), {
      status: "대기", endedAt: new Date().toISOString(),
    });
    if (wakeLockRef.current) { wakeLockRef.current.release(); wakeLockRef.current = null; }
    if (tokenTimerRef.current) { clearInterval(tokenTimerRef.current); tokenTimerRef.current = null; }
    setDriving(false);
    setWatchId(null);
    setCurrentStopIdx(-1);
    setBoardingToken(null);
    setQrUrl(null);
    setActiveTab("운행");
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

  if (loading) return (
    <div style={{ minHeight:"100vh", background:"#0B1A2E", display:"flex", alignItems:"center", justifyContent:"center", color:"#00C2FF", fontSize:18, fontFamily:"'Noto Sans KR',sans-serif" }}>
      로딩 중...
    </div>
  );

  if (error) return (
    <div style={{ minHeight:"100vh", background:"#0B1A2E", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:16, fontFamily:"'Noto Sans KR',sans-serif" }}>
      <div style={{ color:"#FF4D6A", fontSize:16, textAlign:"center", whiteSpace:"pre-line" }}>{error}</div>
      <button style={{ background:"transparent", border:"1px solid #1E3A5F", borderRadius:8, padding:"8px 20px", color:"#8896AA", cursor:"pointer", fontFamily:"inherit" }}
        onClick={() => signOut(auth)}>로그아웃</button>
    </div>
  );

  return (
    <div style={S.container}>
      <div style={S.card}>
        {/* 헤더 */}
        <div style={S.header}>
          <div>
            <p style={S.greeting}>안녕하세요 👋</p>
            <p style={S.driverName}>{driver?.name} 기사님</p>
          </div>
          <button style={S.logoutBtn} onClick={handleLogout}>로그아웃</button>
        </div>

        {/* 운행중 상태 배지 */}
        {driving && (
          <div style={{ background:"rgba(0,196,140,.12)", border:"1px solid rgba(0,196,140,.3)", borderRadius:8, padding:"8px 14px", display:"flex", alignItems:"center", gap:8 }}>
            <span style={{ width:8, height:8, borderRadius:"50%", background:"#00C48C", display:"inline-block" }}/>
            <span style={{ fontSize:13, color:"#00C48C", fontWeight:600 }}>운행중</span>
            {"wakeLock" in navigator && <span style={{ fontSize:11, color:"#FFD166", marginLeft:"auto" }}>🔆 화면 꺼짐 방지 ON</span>}
          </div>
        )}

        {/* 배차 정보 */}
        {dispatch ? (
          <div style={S.dispatchBox}>
            <p style={S.label}>오늘 배차</p>
            <p style={S.routeName}>{dispatch.routeName}</p>
            <p style={S.vehicleNo}>{dispatch.vehicleNo}</p>
            <p style={S.departTime}>출발 {dispatch.departTime}</p>
          </div>
        ) : (
          <div style={S.dispatchBox}>
            <p style={{ color:"#8896AA", textAlign:"center" }}>오늘 배차된 노선이 없습니다</p>
          </div>
        )}

        {/* 운행 시작/종료 버튼 */}
        {!driving ? (
          <button style={{ ...S.btn, background: dispatch ? "#00C48C" : "#1E3A5F", opacity: dispatch ? 1 : 0.6 }}
            onClick={handleStart} disabled={!dispatch}>
            🟢 운행 시작
          </button>
        ) : (
          <>
            <div style={S.gpsStatus}>
              <span style={S.dot} /> GPS 전송 중...
            </div>
            <button style={{ ...S.btn, background:"#FF4D6A" }} onClick={handleStop}>
              🔴 운행 종료
            </button>
          </>
        )}

        {/* 탭 전환 — 항상 표시 */}
        <div style={{ display:"flex", gap:6, borderTop:"1px solid #1E3A5F", paddingTop:14 }}>
          {["운행", "탑승 QR"].map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              style={{ flex:1, padding:"8px", borderRadius:8, border:"none", cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:600,
                background: activeTab === tab ? "linear-gradient(135deg,#1A6BFF,#00C2FF)" : "#1E3A5F",
                color: activeTab === tab ? "#fff" : "#8896AA" }}>
              {tab === "탑승 QR" && "📱 "}{tab}
            </button>
          ))}
        </div>

        {/* ─ 운행 탭: 정류장 현황 ─ */}
        {(!driving || activeTab === "운행") && stops.length > 0 && (
          <div style={{ borderTop: driving ? "none" : "1px solid #1E3A5F", paddingTop: driving ? 0 : 14 }}>
            {!driving && <p style={{ ...S.label, marginBottom:10 }}>정류장 현황 ({stops.length}개소)</p>}
            <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
              {stops.map((stop, i) => {
                const isDone = i < currentStopIdx;
                const isCurrent = i === currentStopIdx;
                const isNext = i === currentStopIdx + 1;
                return (
                  <div key={stop.id} style={{ display:"flex", alignItems:"center", gap:10, opacity: isDone ? 0.45 : 1 }}>
                    <div style={{ width:24, height:24, borderRadius:"50%", flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:700,
                      background: isDone ? "#00C48C22" : isCurrent ? "#00C2FF" : "#1E3A5F",
                      color: isDone ? "#00C48C" : isCurrent ? "#fff" : "#8896AA",
                      border: isCurrent ? "none" : `1px solid ${isDone?"#00C48C33":"#1E3A5F"}` }}>
                      {isDone ? "✓" : i + 1}
                    </div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:13, fontWeight: isCurrent ? 700 : 400,
                        color: isCurrent ? "#00C2FF" : isDone ? "#4A6FA5" : "#F0F4FF",
                        overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                        {stop.name}
                      </div>
                      {stop.address && <div style={{ fontSize:11, color:"#4A6FA5", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{stop.address}</div>}
                    </div>
                    {isCurrent && <span style={{ fontSize:10, background:"#00C2FF22", color:"#00C2FF", borderRadius:10, padding:"2px 8px", flexShrink:0 }}>현재</span>}
                    {isNext && <span style={{ fontSize:10, background:"#FFD16622", color:"#FFD166", borderRadius:10, padding:"2px 8px", flexShrink:0 }}>다음</span>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ─ 탑승 QR 탭 ─ */}
        {activeTab === "탑승 QR" && !driving && (
          <div style={{ background:"rgba(255,209,102,.08)", border:"1px solid rgba(255,209,102,.2)", borderRadius:12, padding:"16px 18px", display:"flex", alignItems:"center", gap:12 }}>
            <span style={{ fontSize:28, flexShrink:0 }}>⚠️</span>
            <div>
              <div style={{ fontSize:13, fontWeight:700, color:"#FFD166", marginBottom:4 }}>운행 시작 후 QR이 활성화됩니다</div>
              <div style={{ fontSize:12, color:"#8896AA" }}>운행 시작 버튼을 누르면 탑승 QR이 자동 생성됩니다</div>
            </div>
          </div>
        )}
        {activeTab === "탑승 QR" && driving && (
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:12 }}>
            {qrUrl ? (
              <>
                <div style={{ fontSize:12, color:"#8896AA", textAlign:"center" }}>
                  승객이 아래 QR을 스캔하면 탑승이 기록됩니다
                </div>
                {/* QR 코드 이미지 - qrcode 라이브러리 (로컬 생성, 오프라인 동작) */}
                <div style={{ background:"#fff", borderRadius:16, padding:16, display:"inline-block", boxShadow:"0 4px 20px rgba(0,0,0,.3)" }}>
                  {qrDataUrl
                    ? <img src={qrDataUrl} alt="탑승 QR" width={220} height={220} style={{ display:"block", borderRadius:8 }} />
                    : <div style={{ width:220, height:220, display:"flex", alignItems:"center", justifyContent:"center", color:"#8896AA", fontSize:12 }}>생성 중...</div>
                  }
                </div>
                <div style={{ background:"#0B1A2E", borderRadius:10, padding:"10px 16px", textAlign:"center", width:"100%" }}>
                  <div style={{ fontSize:11, color:"#8896AA", marginBottom:4 }}>노선</div>
                  <div style={{ fontSize:13, fontWeight:700, color:"#00C2FF" }}>{dispatch?.routeName}</div>
                </div>
                <div style={{ fontSize:11, color:"#FFD166", textAlign:"center" }}>
                  ⏱ QR코드는 5분마다 자동 갱신됩니다
                </div>
                <button onClick={() => refreshToken(driver, dispatch)}
                  style={{ ...S.btn, background:"#1E3A5F", fontSize:13, padding:"10px" }}>
                  🔄 QR 즉시 갱신
                </button>
              </>
            ) : (
              <div style={{ color:"#8896AA", fontSize:13, padding:20, textAlign:"center" }}>
                QR 생성 중...
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const S = {
  container: { minHeight:"100vh", background:"#0B1A2E", display:"flex", alignItems:"flex-start", justifyContent:"center", padding:20, fontFamily:"'Noto Sans KR',sans-serif", overflowY:"auto" },
  card: { background:"#112240", borderRadius:20, padding:"32px", width:"100%", maxWidth:400, display:"flex", flexDirection:"column", gap:16, boxShadow:"0 20px 60px rgba(0,0,0,0.4)", marginTop:20, marginBottom:20 },
  header: { display:"flex", justifyContent:"space-between", alignItems:"flex-start" },
  greeting: { color:"#8896AA", fontSize:13, margin:0 },
  driverName: { color:"#F0F4FF", fontSize:18, fontWeight:700, margin:"4px 0 0" },
  logoutBtn: { background:"transparent", border:"1px solid #1E3A5F", borderRadius:8, padding:"6px 12px", color:"#8896AA", fontSize:12, cursor:"pointer", fontFamily:"inherit" },
  dispatchBox: { background:"#0B1A2E", borderRadius:12, padding:20, border:"1px solid #1E3A5F" },
  label: { color:"#8896AA", fontSize:12, margin:0 },
  routeName: { color:"#00C2FF", fontSize:18, fontWeight:700, margin:"0 0 4px" },
  vehicleNo: { color:"#F0F4FF", fontSize:15, margin:"0 0 4px" },
  departTime: { color:"#FFD166", fontSize:14, margin:0 },
  btn: { border:"none", borderRadius:10, padding:"14px", color:"#fff", fontSize:16, fontWeight:700, cursor:"pointer", fontFamily:"inherit" },
  gpsStatus: { color:"#00C48C", fontSize:14, display:"flex", alignItems:"center", gap:8, justifyContent:"center" },
  dot: { width:10, height:10, borderRadius:"50%", background:"#00C48C", display:"inline-block" },
};
