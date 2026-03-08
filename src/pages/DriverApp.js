import { useState, useEffect } from "react";
import { auth, db } from "../firebase";
import { signInWithEmailAndPassword } from "firebase/auth";
import { collection, query, where, getDocs } from "firebase/firestore";
import { startGPS, stopGPS } from "../lib/gps";

export default function DriverApp() {
  const [screen, setScreen] = useState("login"); // login | main
  const [empNo, setEmpNo] = useState("");
  const [pin, setPin] = useState("");
  const [driver, setDriver] = useState(null);
  const [dispatch, setDispatch] = useState(null);
  const [driving, setDriving] = useState(false);
  const [watchId, setWatchId] = useState(null);
  const [error, setError] = useState("");

const handleLogin = async () => {
  try {
    setError("");
    const email = `${empNo}@buslink.com`;
    console.log("로그인 시도:", email); // 추가
    const { user } = await signInWithEmailAndPassword(auth, email, pin);
    console.log("로그인 성공:", user.uid); // 추가

    const q = query(
      collection(db, "companies", "dy001", "drivers"),
      where("uid", "==", user.uid)
    );
    const snap = await getDocs(q);
    console.log("기사 조회 결과:", snap.size); // 추가
    
    if (!snap.empty) {
      setDriver({ id: snap.docs[0].id, ...snap.docs[0].data() });
      setScreen("main");
      loadDispatch(snap.docs[0].id);
    } else {
      setError("기사 정보를 찾을 수 없습니다");
    }
  } catch (e) {
    console.error("에러 상세:", e.code, e.message); // 추가
    setError("사번 또는 PIN이 올바르지 않습니다");
  }
};
  // 오늘 배차 조회
  const loadDispatch = async (driverId) => {
    const today = new Date().toISOString().slice(0, 10);
    const q = query(
      collection(db, "companies", "dy001", "dispatches", today, "list"),
      where("driverId", "==", driverId)
    );
    const snap = await getDocs(q);
    if (!snap.empty) {
      setDispatch({ id: snap.docs[0].id, ...snap.docs[0].data() });
    }
  };

  // 운행 시작
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

  // 운행 종료
  const handleStop = () => {
    stopGPS(watchId);
    setDriving(false);
    setWatchId(null);
  };

  // 로그인 화면
  if (screen === "login") return (
    <div style={styles.container}>
      <div style={styles.card}>
        <div style={styles.logo}>🚌</div>
        <h2 style={styles.title}>BusLink 기사앱</h2>
        <input style={styles.input} placeholder="사번" value={empNo}
          onChange={e => setEmpNo(e.target.value)} />
        <input style={styles.input} placeholder="PIN 6자리" type="password"
          maxLength={6} value={pin} onChange={e => setPin(e.target.value)} />
        {error && <p style={styles.error}>{error}</p>}
        <button style={styles.btn} onClick={handleLogin}>로그인</button>
      </div>
    </div>
  );

  // 메인 화면
  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <p style={styles.greeting}>안녕하세요, {driver?.name} 기사님 👋</p>

        {dispatch ? (
          <div style={styles.dispatchBox}>
            <p style={styles.label}>오늘 배차</p>
            <p style={styles.routeName}>{dispatch.routeName}</p>
            <p style={styles.vehicleNo}>{dispatch.vehicleNo}</p>
            <p style={styles.departTime}>출발 {dispatch.departTime}</p>
          </div>
        ) : (
          <div style={styles.dispatchBox}>
            <p style={{ color: "#8896AA" }}>오늘 배차된 노선이 없습니다</p>
          </div>
        )}

        {!driving ? (
          <button style={{ ...styles.btn, background: "#00C48C" }}
            onClick={handleStart}>🟢 운행 시작</button>
        ) : (
          <>
            <div style={styles.gpsStatus}>
              <span style={styles.dot} />  GPS 전송 중...
            </div>
            <button style={{ ...styles.btn, background: "#FF4D6A" }}
              onClick={handleStop}>🔴 운행 종료</button>
          </>
        )}
      </div>
    </div>
  );
}

const styles = {
  container: { minHeight: "100vh", background: "#0B1A2E", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 },
  card: { background: "#112240", borderRadius: 16, padding: 32, width: "100%", maxWidth: 360, display: "flex", flexDirection: "column", gap: 16 },
  logo: { fontSize: 48, textAlign: "center" },
  title: { color: "#F0F4FF", textAlign: "center", fontSize: 20, fontWeight: 700 },
  input: { background: "#0B1A2E", border: "1px solid #1E3A5F", borderRadius: 10, padding: "12px 16px", color: "#F0F4FF", fontSize: 16, outline: "none" },
  btn: { background: "#1A6BFF", border: "none", borderRadius: 10, padding: "14px", color: "#fff", fontSize: 16, fontWeight: 700, cursor: "pointer" },
  error: { color: "#FF4D6A", fontSize: 13, textAlign: "center" },
  greeting: { color: "#F0F4FF", fontSize: 16, fontWeight: 600 },
  dispatchBox: { background: "#0B1A2E", borderRadius: 12, padding: 20, border: "1px solid #1E3A5F" },
  label: { color: "#8896AA", fontSize: 12, marginBottom: 8 },
  routeName: { color: "#00C2FF", fontSize: 18, fontWeight: 700, marginBottom: 4 },
  vehicleNo: { color: "#F0F4FF", fontSize: 15, marginBottom: 4 },
  departTime: { color: "#FFD166", fontSize: 14 },
  gpsStatus: { color: "#00C48C", fontSize: 14, display: "flex", alignItems: "center", gap: 8, justifyContent: "center" },
  dot: { width: 10, height: 10, borderRadius: "50%", background: "#00C48C", display: "inline-block", animation: "pulse 1s infinite" },
};