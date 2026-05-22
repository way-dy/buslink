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
// 기사앱 전용 경로 — PWA scope 를 /driver 로 분리(직원앱 /p 와 scope 중첩·설치 충돌 방지).
// /driver 는 isPassenger/Boarding/Partner/Employee 전부 false → 기존 "그 외(/)" 분기에
// 자연 포함되어 Auth·loading·kakao 로직이 그대로 적용됨.
const isDriverRoute    = path.startsWith("/driver");

function App() {
  const [user, setUser]       = useState(null);
  const [role, setRole]       = useState(null);
  const [companyId, setCompanyId] = useState(null);
  const [loading, setLoading] = useState(
    !isPassengerRoute && !isBoardingRoute && !isPartnerRoute && !isEmployeeRoute
  );
  // autoload=false 이므로 window.kakao.maps 가 truthy 여도 엔진/services 는
  // window.kakao.maps.load(cb) 콜백 전까지 미초기화 → truthy ≠ ready.
  const [kakaoReady, setKakaoReady] = useState(false);

  // 카카오 SDK 로드 대기 — autoload=false: maps.load() 콜백에서만 ready
  useEffect(() => {
    let done = false;
    const finish = () => { if (!done) { done = true; setKakaoReady(true); } };

    // 캐시·autoload 케이스 방어: 엔진이 이미 초기화돼 있으면 즉시 ready
    if (window.kakao?.maps?.Map) { finish(); return; }

    const check = setInterval(() => {
      if (window.kakao && window.kakao.maps && typeof window.kakao.maps.load === 'function') {
        clearInterval(check);
        if (window.kakao.maps.Map) { finish(); return; }   // 이미 초기화됨
        window.kakao.maps.load(() => finish());             // 엔진/services 초기화 완료 후 ready
      }
    }, 100);

    // 5초 타임아웃 — 로드 실패해도 앱은 정상 표시(이 경우 지도만 흰화면일 수 있음, 기존 동작 동일)
    const timeout = setTimeout(() => {
      clearInterval(check);
      finish();
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
  // /driver 경로 = 기사앱 직결(역할 무관 — 경로가 의도. 데이터 없으면 DriverApp이 안내).
  if (isDriverRoute) return <DriverApp companyId={companyId} />;
  if (role === "admin" || role === "superadmin")
    return <AdminApp user={user} companyId={companyId} />;
  // / 진입 + 기사 역할 → /driver 로 이동(PWA scope 분리 — 직원앱 /p 와 설치 충돌 방지).
  // 기존 / 북마크·로그인 흐름은 이 리다이렉트로 자연 흡수.
  if (typeof window !== "undefined") window.location.replace("/driver");
  return (
    <div style={{ minHeight:"100vh", background:"#0B1A2E", display:"flex", alignItems:"center", justifyContent:"center", color:"#00C2FF", fontSize:18 }}>
      이동 중...
    </div>
  );
}

export default App;
