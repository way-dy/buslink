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
import LoadingScreen from "./components/LoadingScreen";
import { resolveCompanyIdForAuth } from "./lib/companyResolver";

const path = window.location.pathname;
const host = (typeof window !== "undefined" && window.location)
  ? window.location.hostname.toLowerCase() : "";

// ── 앱별 서브도메인 라우팅 (2026-06-05) ──────────────────────────────
// 4개 서브도메인이 CNAME 으로 같은 Firebase Hosting 빌드(buslink-prod.web.app)를
// 동일 서빙하므로, 경로가 아니라 호스트명으로 앱을 가른다. HOST_APP 에 없는 호스트
// (*.web.app / *.firebaseapp.com / localhost)는 기존 경로 기반 분기 그대로(회귀 0).
// ⚠ 신규 도메인 추가 시 companyResolver.HOSTNAME_TO_COMPANY + SW SW_HOSTNAME_TO_COMPANY 동기.
const HOST_APP = {
  "d.buslink.co.kr": "driver",
  "admin.buslink.co.kr": "admin",
  "p.buslink.co.kr": "employee",
  "partner.buslink.co.kr": "partner",
};
const hostApp = HOST_APP[host] || null;

// 경로 기반 원시 플래그. /bus·/board(QR 딥링크)는 호스트 무관 항상 경로 우선.
const pPartner  = path.startsWith("/partner");
const pEmployee = path.startsWith("/p") && !pPartner;
const pDriver   = path.startsWith("/driver");
const pathSpecified = path.startsWith("/bus") || path.startsWith("/board")
  || pPartner || pEmployee || pDriver;

const isPassengerRoute = path.startsWith("/bus");
const isBoardingRoute  = path.startsWith("/board");
// 경로가 앱을 명시하면 경로 우선, 루트(미명시)면 호스트 매핑 적용.
const isPartnerRoute   = pPartner  || (!pathSpecified && hostApp === "partner");
const isEmployeeRoute  = pEmployee || (!pathSpecified && hostApp === "employee");
// 기사앱: 경로 /driver 또는 d.buslink.co.kr 루트. 위 셋 다 false 면 "그 외(/)" = AdminApp
// 분기로 자연 진입(hostApp==="admin" 포함) — Auth·loading·kakao 로직 그대로.
const isDriverRoute    = pDriver   || (!pathSpecified && hostApp === "driver");

function App() {
  const [user, setUser]       = useState(null);
  const [role, setRole]       = useState(null);
  const [companyId, setCompanyId] = useState(null);
  // Phase B (2026-06-08): admin 별 협력사 권한 범위. users/{uid}.allowedPartnerCodes
  // 그대로 AdminApp 에 전달(부재 시 undefined → AdminApp resolveAllowed 폴백 ["*"]).
  const [allowedPartnerCodes, setAllowedPartnerCodes] = useState(undefined);
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
          // Phase 1.1 (2026-05-28): users.companyId > hostname 매핑 > dy001 폴백.
          setCompanyId(resolveCompanyIdForAuth(data));
          // Phase B (2026-06-08): 협력사 권한 범위 추출(필드 부재 시 undefined 그대로 — AdminApp 폴백).
          setAllowedPartnerCodes(data.allowedPartnerCodes);
        } else {
          setRole("driver");
          // users 문서 부재(비정상) — hostname 매핑 우선, 최종 dy001 폴백.
          setCompanyId(resolveCompanyIdForAuth(null));
          setAllowedPartnerCodes(undefined);
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
  // Phase 1.3 (2026-05-28): PartnerApp 운영 포털 mainTab="ops"에 카카오맵 사용 — isPartnerRoute 포함.
  // 회귀 표면: PartnerApp 진입 시 카카오 로드 대기(최대 5초). 기존 EmployeeApp/PassengerApp 동일 패턴.
  const needsKakao = isPassengerRoute || isEmployeeRoute || isPartnerRoute ||
    (!isPassengerRoute && !isBoardingRoute && !isPartnerRoute && !isEmployeeRoute);

  if (needsKakao && !kakaoReady) return (
    <LoadingScreen message="버스가 출발 준비 중이에요" sub="노선 정보를 불러오고 있어요" />
  );

  if (isEmployeeRoute) return <EmployeeApp />;
  if (isPartnerRoute)  return <PartnerApp />;
  if (isBoardingRoute) return <BoardingApp />;
  if (isPassengerRoute) return <PassengerApp />;

  if (loading) return (
    <LoadingScreen message="BusLink에 들어가는 중이에요" sub="로그인 정보를 확인하고 있어요" />
  );

  if (!user) return <LoginApp />;
  // /driver 경로 = 기사앱 직결(역할 무관 — 경로가 의도. 데이터 없으면 DriverApp이 안내).
  if (isDriverRoute) return <DriverApp companyId={companyId} />;
  if (role === "admin" || role === "superadmin")
    return <AdminApp user={user} companyId={companyId} role={role} allowedPartnerCodes={allowedPartnerCodes} />;
  // / 진입 + 기사 역할 → /driver 로 이동(PWA scope 분리 — 직원앱 /p 와 설치 충돌 방지).
  // 기존 / 북마크·로그인 흐름은 이 리다이렉트로 자연 흡수.
  if (typeof window !== "undefined") window.location.replace("/driver");
  return (
    <LoadingScreen message="기사님 화면으로 이동 중이에요" sub="잠시만 기다려 주세요" />
  );
}

export default App;
