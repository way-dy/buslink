import { useState, useEffect } from "react";
import { auth, db } from "./firebase";
import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import DriverApp from "./pages/DriverApp";
import AdminApp from "./pages/AdminApp";
import LoginApp from "./pages/LoginApp";
import PassengerApp from "./pages/PassengerApp";
import BoardingApp from "./pages/BoardingApp";
import PartnerApp from "./pages/PartnerApp";
import EmployeeApp from "./pages/EmployeeApp";

const path = window.location.pathname;
const isPassengerRoute = path.startsWith("/bus");
const isBoardingRoute  = path.startsWith("/board");
const isPartnerRoute   = path.startsWith("/partner");
const isEmployeeRoute  = path.startsWith("/p") && !path.startsWith("/partner");

function App() {
  const [user, setUser]       = useState(null);
  const [role, setRole]       = useState(null);
  const [companyId, setCompanyId] = useState(null);
  const [loading, setLoading] = useState(
    !isPassengerRoute && !isBoardingRoute && !isPartnerRoute && !isEmployeeRoute
  );
  const [kakaoReady, setKakaoReady] = useState(!!window.kakao?.maps);

  // 카카오 SDK 로드 대기
  useEffect(() => {
    if (window.kakao?.maps) { setKakaoReady(true); return; }

    const check = setInterval(() => {
      if (window.kakao?.maps) {
        clearInterval(check);
        setKakaoReady(true);
      }
    }, 100);

    // 5초 타임아웃 — 로드 실패해도 앱은 정상 표시
    const timeout = setTimeout(() => {
      clearInterval(check);
      setKakaoReady(true);
    }, 5000);

    return () => { clearInterval(check); clearTimeout(timeout); };
  }, []);

  useEffect(() => {
    if (isPassengerRoute || isBoardingRoute || isPartnerRoute || isEmployeeRoute) return;
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (u) {
        const snap = await getDoc(doc(db, "users", u.uid));
        if (snap.exists()) {
          const data = snap.data();
          setRole(data.role);
          setCompanyId(data.companyId || "dy001");
        } else {
          setRole("driver");
          setCompanyId("dy001");
        }
        setUser(u);
      } else {
        setUser(null); setRole(null); setCompanyId(null);
      }
      setLoading(false);
    });
    return () => unsub();
  }, []);

  // 카카오 SDK 로드 전 대기 (지도가 필요한 화면)
  const needsKakao = isPassengerRoute || isEmployeeRoute ||
    (!isPassengerRoute && !isBoardingRoute && !isPartnerRoute && !isEmployeeRoute);

  if (needsKakao && !kakaoReady) return (
    <div style={{ minHeight:"100vh", background:"#0B1A2E", display:"flex", alignItems:"center", justifyContent:"center", color:"#00C2FF", fontSize:16 }}>
      지도 로딩 중...
    </div>
  );

  if (isEmployeeRoute) return <EmployeeApp />;
  if (isPartnerRoute)  return <PartnerApp />;
  if (isBoardingRoute) return <BoardingApp />;
  if (isPassengerRoute) return <PassengerApp />;

  if (loading) return (
    <div style={{ minHeight:"100vh", background:"#0B1A2E", display:"flex", alignItems:"center", justifyContent:"center", color:"#00C2FF", fontSize:18 }}>
      로딩 중...
    </div>
  );

  if (!user) return <LoginApp />;
  if (role === "admin" || role === "superadmin")
    return <AdminApp user={user} companyId={companyId} />;
  return <DriverApp companyId={companyId} />;
}

export default App;
