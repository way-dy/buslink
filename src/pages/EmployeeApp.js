import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import jsQR from "jsqr";
import { initNotifications, listenForegroundMessages } from "../lib/notifications";
import { Map, MapMarker, Polyline, CustomOverlayMap, Roadview } from "react-kakao-maps-sdk";
import { db, auth } from "../firebase";
import { signInAnonymously } from "firebase/auth";
import {
  doc, getDoc, getDocs, collection, onSnapshot,
  query, where, orderBy, updateDoc, setDoc, serverTimestamp
} from "firebase/firestore";
import { useAnimatedPositions } from "../lib/useAnimatedPositions";
import { calcETA } from "../lib/gps";
import { buildCumulativeLengths, projectToPolyline, pathUpTo, pathFrom, toLatLngPath, advanceProgress } from "../lib/routeProgress";
import { computeStopEstimates, formatDelayLabel, formatPassengerEta, describeEtaSource } from "../lib/stopSchedule";
import { useSmoothedEta } from "../lib/useSmoothedEta";
import { computeRunEnded } from "../lib/runStatus";
import { useOneRouteStopArrivals } from "../lib/useRouteStopArrivals";
import { useWakeTick } from "../lib/useWakeTick";
import { useOnlineRecover } from "../lib/useOnlineRecover";
import { forceReconnect } from "../lib/forceReconnect";
import { compareRoutes, sortRoutes, homeRouteList } from "../lib/routeOrder";
import { splitRouteNameNote } from "../lib/routeKind";

import { validateAndBoard, createPassengerToken, resolveStaticDispatch, validateAndBoardStatic } from "../lib/boarding";
import { passengerLogin, passengerResume, passengerMigrate, passengerSetPin, passengerLogout } from "../lib/passengerAuth";
import QRCode from "qrcode";
import { BusLinkLogo, StatusDot, Icon } from "../components/ui";
import { computeRouteWindow, isWithinRouteWindow, normalizeWindowOpts, nowMinutesKST, describeRouteWindow } from "../lib/routeWindow";
import InstallPrompt, { InstallGuide } from "../components/InstallPrompt";
import { applyAppManifest } from "../lib/pwaManifest";
import PermissionGate from "../components/PermissionGate";
import HelpSheet from "../components/HelpSheet";
import { resolveCompanyIdForAnon } from "../lib/companyResolver";
// 거래처 브랜딩(2026-07-16 회의 #5) — 메인 컬러 CSS 변수 + 헤더 로고. 미설정=기본 테마.
import { applyPartnerBranding, clearPartnerBranding, fetchPartnerCodeData, logoHeightOf, brandBand } from "../lib/partnerBranding";
// 문의 게시판(2026-08-06 미팅) — dycs CS 위젯 연동. 거래처별 opt-in.
import { resolveInquiryConfig, buildInquiryUrl } from "../lib/inquiry";
import { resolveHomepageConfig, homepageDisplayHost } from "../lib/homepage";
import { resolveTagSoundConfig, applyTagSoundPolicy, clearTagSoundPolicy, unlockTagSound, playTagBeep, isTagSoundOn, setTagSoundOn, isTagSoundForced } from "../lib/tagSound";
import { useExitConfirm } from "../lib/useExitConfirm";

// ── 경로 진행 판정 임계값 (작업2, 2026-05-18) ──
// 버스 투영 수직거리가 이 값 초과면 경로 이탈로 보고 진행거리 갱신·지나온경로 그리기에서 제외
// (직전 유효 progress 유지) — 우회/잡신호로 진행이 튀는 것 방지(고객 신뢰도 보호).
const OFF_ROUTE_M = 70;
// 버스 progress가 내 정류장 progress + 이 마진을 넘으면 '지나감'(passed) 확정.
const PASSED_MARGIN_M = 40;
// 남은 경로거리가 이 값 미만이면 '곧 도착'(arriving).
const ARRIVING_M = 150;
// 경로 진행거리를 못 쓸 때(routePath 없음·아직 노선에 안 오름) 쓰는 최근접 정류장 폴백의
// **거리 상한**. 이보다 멀면 "어느 정류장에도 있지 않다"(-1)로 본다 — 몇 km 밖 버스를
// 정류장에 세워 두면 그 앞 정류장이 전부 '지나침'으로 표시된다(2026-08-06 신고).
const NEAR_STOP_M = 400;

/** 두 점 사이 실거리(m). 좌표가 없으면 null. */
function haversineM(a, b) {
  if (!a || !b || !isFinite(a.lat) || !isFinite(a.lng) || !isFinite(b.lat) || !isFinite(b.lng)) return null;
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(s));
}
// 지나온 경로(회색) 색상 — Polyline strokeColor는 SDK prop이라 토큰값 직접.
const TRAVELED_COLOR = "#9AA3B2";

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

// ─── 공지함 읽음 시각 헬퍼 (작업A, 2026-05-22) ──────────
// 마지막으로 공지함을 연 시각(ms)을 사번별 키에 저장. 이보다 나중 createdAt 공지 = 안 읽음.
// 키는 buslink_ 접두사 + empNo 포함(기존 buslink_employee 세션 키 컨벤션 일관, 직원별 분리).
function noticeReadKey(empNo) {
  return `buslink_notice_read_${empNo || "_"}`;
}
function loadNoticeReadAt(empNo) {
  try {
    const v = localStorage.getItem(noticeReadKey(empNo));
    return v ? parseInt(v, 10) || 0 : 0;
  } catch { return 0; }
}
function saveNoticeReadAt(empNo, ms) {
  try { localStorage.setItem(noticeReadKey(empNo), String(ms)); } catch { /* 무해 처리 */ }
}

// notices 문서의 createdAt(serverTimestamp 또는 number)을 ms 로 정규화.
function noticeCreatedMs(n) {
  const c = n?.createdAt;
  if (!c) return 0;
  if (typeof c?.toMillis === "function") return c.toMillis();
  if (typeof c === "number") return c;
  return 0;
}

// ─── 내 정류장 영속화 헬퍼 (도착 임박 푸시, 2026-05-22) ──
// 직원이 고른 '내 정류장'을 fcmTokens/{empNo} 문서에 routeId+stopId 로 denormalize.
// 도착 임박 푸시 CF(notifyPreArrival)가 fcmTokens 한 컬렉션만 보고 대상을 찾도록 함.
//  - 선택  : routeId·stopId 저장
//  - 해제  : 두 필드 null
// merge:true 라 lib/notifications.js initNotifications 의 토큰 upsert 와 충돌 없음.
// 문서가 없어도(알림 미허용) merge 로 생성 — token 없으면 CF 가 skip(정상).
async function persistMyStop(companyId, empNo, routeId, stopId) {
  if (!companyId || !empNo) return;
  try {
    await setDoc(
      doc(db, "companies", companyId, "fcmTokens", empNo),
      {
        empNo, companyId,
        routeId: routeId || null,
        stopId: stopId || null,
        myStopUpdatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  } catch (e) {
    // 영속화 실패는 비치명적 — 새로고침 복원·푸시만 영향(현 세션 동작은 유지).
    console.warn("[내 정류장 저장 실패]", e.message);
  }
}

// ─── 기기 감지 헬퍼 (작업B, 2026-05-22) ────────────────
// 배터리 절전 안내 카드용. PWA는 시스템 설정 화면을 못 여므로 텍스트 안내만.
//  - 'samsung' : 삼성 갤럭시(딥슬립 절전이 특히 공격적) → 갤럭시용 단계 안내
//  - 'android' : 그 외 안드로이드 → 일반 안드로이드 단계 안내
//  - null      : iOS·데스크톱 등 → 안내 미노출(iOS는 배터리 최적화 개념 없음)
function detectBatteryGuidePlatform() {
  const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  if (!/Android/.test(ua)) return null; // 안드로이드만 노출
  // 삼성 갤럭시: 모델 코드(SM-)·SamsungBrowser·Samsung 문자열로 감지
  if (/SM-[A-Z0-9]+|SamsungBrowser|Samsung/.test(ua)) return "samsung";
  return "android";
}

// ─── 강제 공지 모달 (2026-05-27) ─────────────────────────
// PWA 푸시가 OS 절전·Doze 로 가끔 누락되는 환경에서 도달성 보장 통로.
// notices 가 onSnapshot 실시간 갱신 → unreadCount > 0 이면 자동 노출,
// 사용자가 "확인했습니다" 누르면 markNoticesRead 호출 → unreadCount 0 → 모달 자동 사라짐.
// 새 공지 도착 시 다시 unreadCount > 0 → 자동 재노출(별도 dismissed state 불필요).
//   - 일반 공지: 즉시 닫기 가능
//   - 긴급 공지(type==='emergency'): 5초 카운트다운 후 닫기 활성 + 진동
function NoticeForceModal({ notice, onClose }) {
  const isEmergency = notice.type === "emergency";
  const [countdown, setCountdown] = useState(isEmergency ? 5 : 0);

  useEffect(() => {
    if (!isEmergency) return;
    if ("vibrate" in navigator) {
      try { navigator.vibrate([200, 100, 200, 100, 200]); } catch { /* 무해 */ }
    }
  }, [isEmergency]);

  useEffect(() => {
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  const canClose = !isEmergency || countdown <= 0;
  const headerBg = isEmergency ? "var(--color-destructive)" : "var(--color-primary)";

  // 🔴 화면을 통째로 덮는 모달은 **자기 힘으로 닫힐 수 있어야 한다**(2026-08-11).
  //    예전엔 닫힘이 전적으로 부모의 `markNoticesRead` 부수효과에 달려 있어서,
  //    그게 조용히 실패하면(세션에 empNo 없음 등) 사용자가 앱을 아예 못 썼다.
  //    로컬 dismissed 를 두면 부모에서 무슨 일이 나든 버튼은 항상 듣는다.
  //    ⚠ 부모가 `key={notice.id}` 로 렌더하므로 **새 공지는 새 인스턴스**라 다시 뜬다.
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  const createdLabel = (() => {
    const ms = noticeCreatedMs(notice);
    if (!ms) return "";
    const d = new Date(ms);
    return `${d.getMonth() + 1}월 ${d.getDate()}일 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  })();

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", zIndex: 99999,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
    }}>
      <div style={{
        background: "var(--color-bg)", borderRadius: "var(--radius-16)",
        maxWidth: 480, width: "100%", maxHeight: "85vh",
        display: "flex", flexDirection: "column", overflow: "hidden",
        boxShadow: "var(--shadow-emphasize)",
      }}>
        <div style={{
          padding: "16px 20px", background: headerBg, color: "#fff",
          fontWeight: 800, fontSize: 15, display: "flex", alignItems: "center", gap: 8,
        }}>
          <span style={{ display: "inline-flex", color: isEmergency ? "var(--color-destructive)" : "var(--color-primary)" }}>
          <Icon name="bell" size={18} stroke={2} solid={isEmergency} />
        </span>
          <span>{isEmergency ? "긴급 공지" : "공지사항"}</span>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "22px 22px 16px" }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: "var(--color-label)", marginBottom: 8, lineHeight: 1.4 }}>
            {notice.title}
          </div>
          {createdLabel && (
            <div style={{ fontSize: 12, color: "var(--color-label-mute)", marginBottom: 14 }}>
              {createdLabel}
            </div>
          )}
          <div style={{ fontSize: 14.5, color: "var(--color-label)", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
            {notice.body}
          </div>
        </div>
        <div style={{ padding: "12px 16px 16px", borderTop: "1px solid var(--color-line)" }}>
          <button
            onClick={canClose ? () => { setDismissed(true); try { onClose && onClose(); } catch (e) { console.warn("[공지 읽음 처리 실패]", e); } } : undefined}
            disabled={!canClose}
            style={{
              width: "100%", padding: "14px",
              borderRadius: "var(--radius-12)",
              background: canClose ? "var(--color-primary)" : "var(--color-bg-soft)",
              color: canClose ? "#fff" : "var(--color-label-mute)",
              border: "none", fontSize: 15, fontWeight: 800,
              cursor: canClose ? "pointer" : "not-allowed",
              fontFamily: "inherit",
            }}
          >
            {canClose ? "확인했습니다" : `${countdown}초 후 닫기 활성화`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── 탭 정의 ──────────────────────────────────────────
// 아이콘은 이모지가 아니라 디자인시스템 벡터(`Icon`) — 이모지는 색을 못 바꿔
// 거래처 브랜드 컬러(--color-primary)가 하단 탭에만 적용이 안 됐다(2026-08-05 회의 #5).
// `Icon` 은 currentColor 기반이라 활성 탭이 자동으로 브랜드 색을 탄다.
// 🔴 아이콘 파일 업로드는 도입하지 않는다(way 결정 — 크기·품질이 제각각이면 앱이 싸구려로 보인다).
//    표준 아이콘 + 컬러 변경까지만.
const TABS = [
  { id: "home",     icon: "home",     label: "홈" },
  { id: "routes",   icon: "route",    label: "노선" },
  { id: "notices",  icon: "bell",     label: "공지" },
  { id: "scan",     icon: "qr",       label: "탑승" },
  { id: "settings", icon: "settings", label: "설정" },
];

// 문의 탭(2026-08-06 오전 미팅) — **거래처별 opt-in**이라 기본 탭 목록에 넣지 않는다.
// 설정 앞에 끼워 넣는다(설정은 늘 맨 끝이 관례).
const INQUIRY_TAB = { id: "inquiry", icon: "chat", label: "문의" };

// 홈페이지 탭(2026-08-25 미팅) — 문의 탭과 **같은 자리**를 쓴다.
// way 결정: "문의를 홈페이지로 한 다음에 전화를 하더라도 그냥 거기서 해라"(별도 전화 버튼 없음).
// 그래서 홈페이지를 켠 거래처는 문의 탭이 **홈페이지 탭으로 대체**된다 — 둘을 나란히 두면
// 승객이 어디로 문의해야 하는지 갈린다.
// ⚠ 대체되는 순간 그 거래처의 dycs 문의 위젯 유입은 끊긴다(켜기 전 확인 필요).
const HOMEPAGE_TAB = { id: "homepage", icon: "globe", label: "홈페이지" };

function visibleTabsFor(inquiryOn, homepageOn) {
  const extra = homepageOn ? HOMEPAGE_TAB : (inquiryOn ? INQUIRY_TAB : null);
  if (!extra) return TABS;
  const at = TABS.findIndex(t => t.id === "settings");
  const i = at < 0 ? TABS.length : at;
  return [...TABS.slice(0, i), extra, ...TABS.slice(i)];
}

// ════════════════════════════════════════════════════════
export default function EmployeeApp() {
  // Phase 1.1 (2026-05-28): URL param > hostname 매핑 > dy001.
  // EmployeeApp 의 localStorage `buslink_employee` 는 세션(empNo/name/dept/routeId)
  // 저장용이라 companyId 분리 키는 없음(과거 단일테넌트 전제) — URL+hostname 만 활용.
  const companyId = resolveCompanyIdForAnon({ urlParam: getParam("c") });
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState(null);   // { empNo, name, dept, routeId, resumeToken, ... }
  const [tab, setTab] = useState("home");
  const [helpOpen, setHelpOpen] = useState(false);   // 도움말 시트(2026-08-10)
  const [activeNotice, setActiveNotice] = useState(null); // 공지 배너
  // 공지 배너가 차지하는 실제 높이(px) — 아래 본문을 그만큼 내려 가려지지 않게 한다.
  const noticeBarRef = useRef(null);
  const [noticeBarH, setNoticeBarH] = useState(60);
  const [notices, setNotices] = useState([]);             // 공지함 목록(필터 후, 최신순)
  const [noticeReadAt, setNoticeReadAt] = useState(0);    // 마지막 공지함 진입 시각(ms)

  // 백그라운드 → foreground 복귀 시 공지 onSnapshot 재구독(stale 리스너 신선화).
  // 통근버스 사용자는 등하교 전후 장시간 백그라운드 상태가 흔함(issues.md useWakeTick 패턴).
  const wakeTick = useWakeTick();

  // 뒤로가기 종료 확인(마운트 시 1회 발판 push, 인증/로딩 분기와 무관).
  useExitConfirm();

  // ── 인증 부팅 (2026-08-25 P1) ─────────────────────────
  // 저장된 세션이 있으면 **승객 신원**(커스텀 토큰)으로 복원하고, 없으면 익명으로 들어간다.
  // 익명이 여전히 필요한 이유 = 로그인 화면도 회사·노선 read 규칙(`isAuth()`)을 탄다.
  // ⚠ 승객앱은 `inMemoryPersistence` 라(firebase.js) **새로고침마다 여기를 다시 지난다** —
  //   토큰은 사라지고 기기에 남는 건 `resumeToken` 뿐이다.
  useEffect(() => {
    let alive = true;
    const done = () => { if (alive) setReady(true); };
    const stored = loadSession();
    const mine = (stored && stored.companyId === companyId) ? stored : null;

    // 복원에 실패하면 **익명으로 내려앉히고 로그인 화면**을 보여준다. 깨진 세션을 붙들면
    // 로그인도 못 하고 화면도 안 뜨는 상태가 된다.
    const fallback = (why) => {
      console.warn("[승객 세션 복원 실패]", why);
      clearSession();
      if (alive) setSession(null);
      return signInAnonymously(auth).catch(() => {});
    };
    const adopt = ({ resumeToken, passenger }) => {
      if (!alive) return;
      // 🔴 `routeId` 는 서버 값으로 덮지 않는다 — 승객이 앱에서 고른 **기준 노선**은
      //    localStorage 에만 사는 값이고(RoutesTab.chooseRoute), 예전에는 새로고침해도
      //    유지됐다. 복원 때마다 명부 값으로 되돌리면 "노선을 바꿔도 자꾸 돌아온다"가 된다.
      const merged = { ...passenger, companyId, resumeToken };
      if (mine && mine.routeId) merged.routeId = mine.routeId;
      saveSession(merged);
      setSession(merged);
    };

    let p;
    if (mine && mine.resumeToken) {
      p = passengerResume({ companyId, resumeToken: mine.resumeToken }).then(adopt).catch(e => fallback(e && e.message));
    } else if (mine && mine.pinHash && mine.empNo) {
      // 🔴 이 배포 **이전에** 로그인해 둔 기기 — 승계표가 없고 `pinHash` 만 있다.
      //    한 번만 조용히 승계한다(서버에 하드 만료일 있음). 실패하면 다시 로그인받는다.
      p = passengerMigrate({ companyId, empNo: mine.empNo, pinHash: mine.pinHash }).then(adopt).catch(e => fallback(e && e.message));
    } else {
      if (mine) clearSession();   // 신원 근거가 없는 세션은 쓸 수 없다
      p = signInAnonymously(auth).catch(() => {});
    }
    p.finally(done);
    return () => { alive = false; };
    // companyId 는 URL·호스트에서 나오는 상수라 사실상 마운트 1회.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  // 설치형 앱(PWA) 조건용 SW 등록 1회 — 브라우저가 URL+scope 로 dedupe 하므로
  // FCM SDK(lib/notifications)가 같은 파일을 다시 등록해도 충돌·이중등록 없음.
  // 캐시 추가 없음(no-op fetch 핸들러만). 실패는 무해 처리.
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/firebase-messaging-sw.js")
        .catch(() => {});
    }
  }, []);

  // 앱별 PWA 설치 아이콘(직원앱) — /p 전용 manifest/apple-touch/제목 교체. 마운트 1회.
  useEffect(() => {
    applyAppManifest({
      manifestHref: "/manifest-employee.json",
      appleTouchHref: "/icons/passenger-1024.png",
      title: "BusLink 승객",
    });
  }, []);

  // 세션 복원은 위 "인증 부팅"이 겸한다 — 신원(토큰) 없이 화면만 복원하면 탑승 CF 가
  // 거부하므로 **둘을 갈라 놓으면 안 된다**(2026-08-25 P1).

  const handleLogin = (s) => {
    const data = { ...s, companyId };
    saveSession(data);
    setSession(data);
  };

  const handleLogout = () => {
    const rt = session && session.resumeToken;
    clearSession();
    setSession(null);
    setTab("home");
    // 서버에 남은 승계표까지 끊고 익명으로 되돌린다(공용 폰 대비). 실패해도 화면은 이미 로그아웃.
    passengerLogout({ companyId, resumeToken: rt }).catch(() => {});
  };

  // 저장된 공지함 읽음 시각 복원
  useEffect(() => {
    if (session?.empNo) setNoticeReadAt(loadNoticeReadAt(session.empNo));
  }, [session?.empNo]);

  // ── 공지 실시간 구독 ─────────────────────────────────
  // 기존 공지배너(최신 1건) + 공지함 목록(전체)을 한 구독으로 처리.
  // partnerCode 필터: notices.partnerCode==null(전체) 또는 세션 partnerCode 일치만 노출.
  // 인덱스는 기존 notices(active+createdAt) 그대로 — partnerCode 는 클라이언트 필터(신규 인덱스 회피).
  // wakeTick: 백그라운드 복귀 시 재구독해 stale 리스너 신선화.
  useEffect(() => {
    if (!session?.companyId) return;
    const myPartner = session.partnerCode || null;
    return onSnapshot(
      query(
        collection(db, "companies", session.companyId, "notices"),
        where("active", "==", true),
        orderBy("createdAt", "desc")
      ),
      snap => {
        const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        // partnerCode 규칙(공지배너와 동일): null=전체, 그 외엔 세션 partnerCode 일치만.
        const visible = all.filter(n => {
          const p = n.partnerCode || null;
          return p === null || p === myPartner;
        });
        setNotices(visible);
        setActiveNotice(visible.length > 0 ? visible[0] : null);
      },
      err => console.warn("[공지 구독 오류]", err.message)
    );
  }, [session?.companyId, session?.partnerCode, wakeTick]);

  // 공지함 진입 시 읽음 시각 갱신(가장 최신 공지보다 나중으로 — 안 읽음 0건 처리).
  const markNoticesRead = useCallback(() => {
    const latest = notices.reduce((m, n) => Math.max(m, noticeCreatedMs(n)), 0);
    const now = Math.max(Date.now(), latest + 1);
    // 🔴 empNo 가 없어도 **화면 상태는 반드시 갱신한다**(2026-08-11 way 신고).
    //    예전엔 맨 앞에서 `if (!session?.empNo) return;` 으로 조용히 빠져나가
    //    강제 공지 모달이 안 닫히고 **앱 전체가 잠겼다** — 그 모달은 inset:0·z-index 99999 라
    //    탭바까지 덮어서 사용자가 할 수 있는 게 아무것도 없어진다.
    //    영속화(localStorage)만 empNo 가 있을 때 하고, 세션 내 읽음 처리는 항상 한다.
    if (session?.empNo) saveNoticeReadAt(session.empNo, now);
    setNoticeReadAt(now);
  }, [session?.empNo, notices]);

  // 안 읽음 공지 수 — 마지막 읽은 시각보다 나중 createdAt 공지 개수.
  const unreadCount = notices.filter(n => noticeCreatedMs(n) > noticeReadAt).length;

  // 강제 공지 모달 — 안 읽음이 1건 이상이면 가장 최신 공지를 풀스크린으로 노출.
  // 닫기(markNoticesRead) 호출 시 noticeReadAt 갱신되어 unreadCount=0 → 자동 사라짐.
  // 새 공지 도착 시 다시 unreadCount>0 → 자동 재노출.
  const forceNotice = (unreadCount > 0 && notices.length > 0) ? notices[0] : null;

  // ── FCM 초기화 ───────────────────────────────────────
  // partnerCode 도 deps 에 포함 → 협력사 변경 시 fcmTokens 자동 재upsert (idempotent).
  useEffect(() => {
    if (!session?.empNo || !session?.companyId) return;
    initNotifications({
      companyId: session.companyId,
      empNo: session.empNo,
      partnerCode: session.partnerCode || null,
    }).catch(() => {});
    let unsubFn = () => {};
    listenForegroundMessages(msg => {
      setActiveNotice({ title: msg.title, body: msg.body, type: msg.type, id: Date.now() });
    }).then(fn => { unsubFn = fn || (() => {}); }).catch(() => {});
    return () => unsubFn();
  }, [session?.empNo, session?.companyId, session?.partnerCode]);

  // ── 거래처 표시 옵션 — 로그인 승객의 partnerCode 문서 1회 조회 ──
  //   브랜딩(2026-07-16 회의 #5) + 문의 게시판(2026-08-06 미팅)이 같은 문서에서 나오므로
  //   읽기는 한 번(`fetchPartnerCodeData`)만 하고 각 헬퍼가 필요한 필드만 뽑는다.
  const [branding, setBranding] = useState(null);
  const [inquiry, setInquiry] = useState(null); // {enabled,tenantId,token} | null(=미조회/거래처 없음)
  const [homepage, setHomepage] = useState(null); // {enabled,url} | null (2026-08-25)
  useEffect(() => {
    let cancelled = false;
    const pc = session?.partnerCode;
    if (!pc) {
      clearPartnerBranding(); clearTagSoundPolicy();
      setBranding(null); setInquiry(null); setHomepage(null);
      return;
    }
    fetchPartnerCodeData(pc).then(d => {
      if (cancelled) return;
      const b = d ? (d.branding || null) : null;
      setBranding(b);
      applyPartnerBranding(b);
      setInquiry(resolveInquiryConfig(d)); // 부재·모르는 값 = 꺼짐(회귀 0)
      setHomepage(resolveHomepageConfig(d));
      // 태깅 소리 강제 여부(2026-08-25). 프롭으로 여러 겹 내려보내지 않는 이유 =
      // 거래처 문서를 읽는 곳이 여기 한 군데뿐이고, 브랜딩(applyPartnerBranding)이 이미 같은 패턴.
      applyTagSoundPolicy(resolveTagSoundConfig(d));
    });
    return () => { cancelled = true; clearPartnerBranding(); clearTagSoundPolicy(); };
  }, [session?.partnerCode]);

  // 배너 높이 실측 — 공지가 바뀌거나(문구 길이 변동) 화면이 회전해도 따라간다.
  useEffect(() => {
    if (!activeNotice) return undefined;
    const el = noticeBarRef.current;
    if (!el) return undefined;
    const measure = () => {
      const h = Math.round(el.getBoundingClientRect().height);
      if (h > 0) setNoticeBarH(h);
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (ro) ro.observe(el);
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
    };
  }, [activeNotice]);

  // 문의 탭은 켠 거래처에만 보인다. 켜 둔 상태에서 관리자가 끄면(재접속 시) 홈으로 되돌린다
  // — 안 그러면 빈 탭에 갇힌다(탭 목록에서는 이미 사라진 뒤라 돌아올 버튼이 없다).
  const inquiryOn = !!(inquiry && inquiry.enabled);
  const homepageOn = !!(homepage && homepage.enabled);
  const visibleTabs = useMemo(() => visibleTabsFor(inquiryOn, homepageOn), [inquiryOn, homepageOn]);
  useEffect(() => {
    // 홈페이지가 켜지면 문의 탭은 사라진다 — 문의 탭에 있던 사람도 홈으로 되돌린다.
    if (tab === "inquiry" && (!inquiryOn || homepageOn)) setTab("home");
    if (tab === "homepage" && !homepageOn) setTab("home");
  }, [tab, inquiryOn, homepageOn]);

  // 태깅 소리 잠금 해제 — 브라우저는 사용자 제스처 없이 만든 오디오를 정지 상태로 둔다.
  // 이걸 안 걸면 **첫 태깅에서만 소리가 안 나는** 증상이 된다. 한 번 성공하면 뗀다.
  useEffect(() => {
    const on = () => { unlockTagSound(); window.removeEventListener("pointerdown", on); };
    window.addEventListener("pointerdown", on);
    return () => window.removeEventListener("pointerdown", on);
  }, []);

  if (!ready) return (
    <div style={S.fullCenter}>
      <div style={S.spinner} />
    </div>
  );

  if (!session) return <LoginScreen companyId={companyId} onLogin={handleLogin} />;

  // ── 첫 로그인 비밀번호 설정 강제(2026-07-27) ──────────────
  // 관리자가 발급한 초기 비밀번호를 그대로 쓰면 안내문을 본 사람 누구나 그 계정에
  // 들어갈 수 있다. 예전엔 설정 탭에서 "변경해주세요" 배너로 권유만 해 사실상 아무도
  // 바꾸지 않았다(실측: 대상 전원 미변경). 공용 계정(pinLocked)은 여러 명이 함께 쓰므로 제외.
  if (session.pinInitial && !session.pinLocked) {
    return (
      <FirstPinSetup
        companyId={companyId}
        session={session}
        onDone={(s) => { saveSession({ ...session, ...s }); setSession(p => ({ ...p, ...s })); }}
        onLogout={handleLogout}
      />
    );
  }

  return (
    <div style={S.appWrap}>
      <InstallPrompt />
      {/* ── 강제 공지 모달 — 안 읽음 공지 1건을 풀스크린으로 노출(푸시 누락 대비 도달성 보장 통로) ── */}
      {/* key={id} 필수 — 모달이 로컬 dismissed 를 갖게 됐으므로, 키가 없으면 인스턴스가
          재사용되어 **새 공지가 도착해도 다시 뜨지 않는다**(2026-08-11). */}
      {forceNotice && <NoticeForceModal key={forceNotice.id} notice={forceNotice} onClose={markNoticesRead} />}
      {/* ── 공지 배너 — 본문 영역 탭 시 공지함으로 이동(읽음 처리) ── */}
      {activeNotice && (
        <div ref={noticeBarRef} style={{
          position: "fixed", top: 0, left: 0, right: 0, zIndex: 999,
          background: activeNotice.type === "emergency" ? "var(--color-destructive)" : "var(--color-primary)",
          padding: "10px 14px",
          display: "flex", alignItems: "flex-start", gap: 10,
          boxShadow: "var(--shadow-strong)",
        }}>
          <div onClick={() => { setTab("notices"); markNoticesRead(); }}
            style={{ flex: 1, minWidth: 0, cursor: "pointer" }}>
            {/* 제목도 2줄까지만 — 영문 병기 공지는 제목만으로도 화면을 밀어낸다 */}
            <div style={{ fontSize: 12, fontWeight: 800, color: "#fff", marginBottom: 2,
              display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", wordBreak: "keep-all" }}>
              {activeNotice.type === "emergency" ? "긴급 공지" : "공지"} · {activeNotice.title}
            </div>
            {/* 본문 2줄 미리보기(2026-08-07 배시현 개선요청) — 전문은 탭해서 공지함에서 본다.
                🔴 배너는 `position:fixed` 라 길어지면 아래 화면을 그대로 덮는다. */}
            <div style={{ fontSize: 11, color: "rgba(255,255,255,.88)", lineHeight: 1.4,
              display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", wordBreak: "keep-all" }}>
              {activeNotice.body}
            </div>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,.7)", marginTop: 3, fontWeight: 600 }}>
              탭하면 전체 공지 보기 →
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
      {/* 🔴 배너 자리는 **실측**한다 — 예전엔 `60px` 고정이었는데 배너는 `position:fixed` 라
          제목·본문이 길어지면 60px 을 넘겨 **아래 화면을 그대로 덮었다**(요청자가 신고한 그 증상).
          줄 수를 2줄로 묶어도 글꼴·기기·언어에 따라 높이는 달라지므로 고정 px 로 되돌리지 말 것.
          되먹임 없음 — 배너는 fixed 라 이 margin 이 배너 높이에 영향을 주지 않는다. */}
      <div style={{ ...S.content, marginTop: activeNotice ? noticeBarH : 0 }}>
        {/* PermissionGate 는 HomeTab **안**(브랜드 밴드 아래)에서 렌더한다 — 2026-08-10.
            예전엔 여기 밴드보다 위에 있어서 앱을 처음 여는 사람이 브랜드가 아니라
            회색 카드부터 봤다. 🔴 위치만 바꿨고 **노출 조건은 그대로**다(권한 메시지 누락 금지). */}
        {tab === "home"     && (
          <HomeTab companyId={companyId} session={session} branding={branding} onScanTab={() => setTab("scan")} onSessionUpdate={(s)=>{saveSession({...session,...s});setSession(p=>({...p,...s}));}} />
        )}
        {tab === "routes"   && <RoutesTab companyId={companyId} session={session} onSessionUpdate={(s) => { saveSession({...session,...s}); setSession(p=>({...p,...s})); }} />}
        {tab === "notices"  && <NoticesTab notices={notices} unreadCount={unreadCount} />}
        {tab === "scan"     && <ScanTab companyId={companyId} session={session} />}
        {tab === "inquiry"  && <InquiryTab config={inquiry} partnerName={session?.partnerName || null} />}
        {tab === "homepage" && <HomepageTab config={homepage} partnerName={session?.partnerName || null} />}
        {tab === "settings" && <SettingsTab companyId={companyId} session={session} onLogout={handleLogout} onGoHome={() => setTab("home")} onSessionUpdate={(s)=>{saveSession({...session,...s});setSession(p=>({...p,...s}));}} />}

        {/* ── 도움말 버튼 (2026-08-10) ─────────────────────────────
            "노선이 안 보여요 / 알림이 안 와요" 는 우리 신고 1·2순위인데, 물어볼 곳이
            앱 안에 없었다. 화면에 이유를 적는 것(시간창 안내 등)과 짝이 되는 통로.
            🔴 위쪽에 두지 않는다 — 상단은 공지 배너(fixed) 자리라 서로 가린다. */}
        <button
          onClick={() => setHelpOpen(true)}
          aria-label="도움말"
          style={{
            position: "absolute", right: 12, bottom: 12, width: 38, height: 38,
            borderRadius: "50%", border: "1px solid var(--color-line)",
            background: "var(--color-bg)", color: "var(--color-primary)",
            fontSize: 17, fontWeight: 800, cursor: "pointer", fontFamily: "inherit",
            boxShadow: "var(--shadow-emphasize)", zIndex: 5, lineHeight: 1,
          }}
        >
          ?
        </button>
      </div>

      {helpOpen && <HelpSheet tab={tab} onClose={() => setHelpOpen(false)} />}

      <div style={S.tabBar}>
        {visibleTabs.map(t => (
          <button key={t.id}
            onClick={() => { setTab(t.id); if (t.id === "notices") markNoticesRead(); }}
            style={{ ...S.tabBtn, color: tab === t.id ? "var(--color-primary)" : "var(--color-label-mute)" }}>
            {/* 선택 탭 = 채움 아이콘 + 브랜드 톤 알약(2026-08-05 way "감각적인 것으로").
                알약색 `--color-primary-soft` 는 거래처 브랜드색에서 자동 파생되므로
                (partnerBranding 이 primary 를 흰색과 90% 섞어 만든다) 거래처마다 톤이 맞는다.
                🔴 비선택은 라인 유지 — 전부 채우면 무엇이 선택인지 안 읽힌다. */}
            <span style={{
              position: "relative", display: "inline-flex", alignItems: "center", justifyContent: "center",
              width: 34, height: 30, borderRadius: 11,
              background: tab === t.id ? "var(--color-primary-soft)" : "transparent",
              transition: "background .15s ease",
            }}>
              <Icon name={t.icon} size={21} solid={tab === t.id} />
              {/* 안 읽음 공지 배지 — 공지 탭에만, 안 읽음 1건 이상일 때 */}
              {t.id === "notices" && unreadCount > 0 && (
                <span style={{
                  position: "absolute", top: 0, right: 0, minWidth: 16, height: 16,
                  padding: "0 4px", borderRadius: 8, background: "var(--color-destructive)",
                  color: "#fff", fontSize: 10, fontWeight: 800, lineHeight: "16px",
                  textAlign: "center", boxShadow: "0 0 0 2px var(--color-bg)"
                }}>
                  {unreadCount > 99 ? "99+" : unreadCount}
                </span>
              )}
            </span>
            <span style={{ fontSize: 10.5, fontWeight: tab === t.id ? 800 : 600, letterSpacing: "-0.02em" }}>{t.label}</span>
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
  // 계정 안내문 QR(`/p?emp=10001`)로 들어오면 사번을 미리 채운다(2026-07-27).
  // 배부받은 사람이 자기 아이디를 타이핑하지 않아도 되고 오타 문의가 사라진다.
  const [empNo, setEmpNo] = useState(() => (getParam("emp") || "").trim());
  const [pin, setPin] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [isFirst, setIsFirst] = useState(false);

  const handleSubmit = async () => {
    if (!empNo.trim() || pin.length < 4) return;
    setLoading(true); setError("");
    try {
      // 🔴 PIN 대조는 **서버**(CF `passengerLogin`)가 한다. 통과하면 승객 신원(커스텀 토큰)이
      //    생기고, 그 뒤로 탑승 CF 는 클라가 보낸 사번이 아니라 토큰의 사번을 쓴다.
      //    예전엔 여기서 명부 문서를 직접 읽어 해시를 비교했는데, 그 방식은 ⓐ 명부를 익명에게
      //    열어 둬야 하고 ⓑ 서버가 "누가 로그인했는지"를 끝내 알 수 없었다.
      //    `lastLoginAt` 기록도 서버가 겸한다.
      const { resumeToken, passenger } = await passengerLogin({ companyId, empNo: empNo.trim(), pin });
      onLogin({ ...passenger, resumeToken });
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  };

  return (
    <div style={S.fullCenter}>
      <div style={S.loginCard}>
        <div style={S.header}>
          <BusLinkLogo size={26} sub="승객 탑승 서비스" />
        </div>
        <div style={{ fontSize: 20, fontWeight: 800, color: "var(--color-label)", letterSpacing: "-0.02em", marginBottom: 4 }}>로그인</div>
        <div style={{ fontSize: 13, color: "var(--color-label-mute)", marginBottom: 18, lineHeight: 1.55 }}>
          받으신 안내문의 아이디를 입력하세요<br/>
          초기 비밀번호는 <b style={{ color: "var(--color-label)", letterSpacing: "0.08em" }}>000000</b> 입니다<br/>
          <span style={{ color: "var(--color-cautionary)", fontWeight: 600 }}>첫 로그인 후 비밀번호를 직접 정하게 됩니다</span>
        </div>
        <input style={S.input} type="text" inputMode="text" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="사번"
          value={empNo} onChange={e => setEmpNo(e.target.value)} autoFocus />
        <input style={{ ...S.input, marginTop: 10 }} type="password" inputMode="numeric"
          placeholder="PIN (4~6자리)" maxLength={6}
          value={pin} onChange={e => setPin(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleSubmit()} />
        {error && <div style={S.errorMsg}>{error}</div>}
        <button style={{ ...S.btn, marginTop: 14, opacity: (!empNo || pin.length < 4 || loading) ? 0.5 : 1, cursor: (!empNo || pin.length < 4 || loading) ? "not-allowed" : "pointer" }}
          onClick={handleSubmit} disabled={!empNo || pin.length < 4 || loading}>
          {loading ? "확인 중..." : "로그인"}
        </button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════
// 첫 로그인 비밀번호 설정 (2026-07-27)
//
// 관리자가 발급한 초기 비밀번호(안내문에 인쇄돼 있음)를 쓰는 동안에는 앱을 쓸 수 없다.
// 현재 비밀번호를 다시 묻지 않는 이유 = 방금 그 값으로 로그인해 세션에 검증된 해시가
// 이미 있기 때문(session.pinHash). 한 번 더 묻는 건 마찰만 늘린다.
// ════════════════════════════════════════════════════════
function FirstPinSetup({ companyId, session, onDone, onLogout }) {
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // 🔴 저장된 세션만 믿으면 안 된다 — `pinLocked`/`pinInitial` 은 나중에 생긴 필드라
  //   예전에 로그인한 기기의 localStorage 에는 아예 없다. 공용 계정(pinLocked)이
  //   세션에 그 값이 없다는 이유로 이 화면을 만나 비밀번호를 바꾸면 **같은 계정을 쓰는
  //   전원이 로그인 못 하게 된다**(2026-07-21 에 막았던 그 사고). 문서를 실측해
  //   잠금이거나 이미 변경된 계정이면 즉시 통과시킨다.
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    let alive = true;
    getDoc(doc(db, "companies", companyId, "passengers", session.empNo))
      .then(snap => {
        if (!alive) return;
        const p = snap.exists() ? snap.data() : null;
        if (p && (p.pinLocked || !p.pinInitial)) {
          onDone({ pinLocked: !!p.pinLocked, pinInitial: !!p.pinInitial });
          return;
        }
        setChecking(false);
      })
      .catch(() => { if (alive) setChecking(false); }); // 조회 실패 시엔 설정 화면 유지(안전측)
    return () => { alive = false; };
    // onDone 은 매 렌더 새 함수지만 이 effect 는 계정 단위 1회면 충분하다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, session.empNo]);

  const submit = async () => {
    if (newPin.length < 4) return setError("비밀번호는 4자리 이상이어야 합니다");
    if (newPin !== confirmPin) return setError("두 번 입력한 비밀번호가 다릅니다");
    if (newPin === "000000") return setError("너무 쉬운 비밀번호입니다. 다른 번호로 정해주세요");
    setLoading(true); setError("");
    try {
      // 첫 설정이라 현재 PIN 을 다시 묻지 않는다 — 서버가 `pinInitial` 로 판정한다.
      await passengerSetPin({ newPin });
      onDone({ pinInitial: false });
    } catch (e) {
      setError((e && e.message) || "저장에 실패했습니다. 잠시 후 다시 시도해주세요");
      setLoading(false);
    }
  };

  if (checking) return (
    <div style={S.fullCenter}>
      <div style={S.spinner} />
    </div>
  );

  return (
    <div style={S.fullCenter}>
      <div style={S.loginCard}>
        <div style={S.header}>
          <BusLinkLogo size={26} sub="승객 탑승 서비스" />
        </div>
        <div style={{ fontSize: 20, fontWeight: 800, color: "var(--color-label)", letterSpacing: "-0.02em", marginBottom: 4 }}>
          비밀번호를 정해주세요
        </div>
        <div style={{ fontSize: 13, color: "var(--color-label-mute)", marginBottom: 16, lineHeight: 1.55 }}>
          {session.name}님, 반갑습니다.<br/>
          안내문에 적힌 비밀번호는 다른 사람도 볼 수 있으니
          <b style={{ color: "var(--color-label)" }}> 본인만 아는 번호로 바꿔야</b> 이용할 수 있습니다.
        </div>
        <input style={S.input} type="password" inputMode="numeric" maxLength={6}
          placeholder="새 비밀번호 (숫자 4~6자리)" value={newPin} autoFocus
          onChange={e => setNewPin(e.target.value.replace(/\D/g, ""))} />
        <input style={{ ...S.input, marginTop: 10 }} type="password" inputMode="numeric" maxLength={6}
          placeholder="새 비밀번호 확인" value={confirmPin}
          onChange={e => setConfirmPin(e.target.value.replace(/\D/g, ""))}
          onKeyDown={e => e.key === "Enter" && submit()} />
        {error && <div style={S.errorMsg}>{error}</div>}
        <button style={{ ...S.btn, marginTop: 14, opacity: (newPin.length < 4 || loading) ? 0.5 : 1, cursor: (newPin.length < 4 || loading) ? "not-allowed" : "pointer" }}
          onClick={submit} disabled={newPin.length < 4 || loading}>
          {loading ? "저장 중..." : "설정하고 시작하기"}
        </button>
        <button style={{ background: "none", border: "none", color: "var(--color-label-mute)", fontSize: 12, fontFamily: "inherit", marginTop: 12, cursor: "pointer", textDecoration: "underline" }}
          onClick={onLogout}>
          다른 계정으로 로그인
        </button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════
// 홈 탭 — 내 노선 버스 위치 + ETA
// ════════════════════════════════════════════════════════
function HomeTab({ companyId, session, branding, onScanTab, onSessionUpdate }) {
  // 상단 브랜드 밴드 색 — 거래처 색에서 파생하고 글자색은 휘도로 정한다(순수 함수).
  const band = brandBand(branding);
  const [routes, setRoutes]         = useState([]);
  const [activeRouteId, setActiveRouteId] = useState(session.routeId || null);
  // 첫 노선 로드에서 한 번만 활성 노선을 홈 목록 안으로 맞춘다(2026-08-18) — 아래 주석 참조.
  const initialRouteBoundRef = useRef(false);
  const [stops, setStops]           = useState([]);
  const [myStopIdx, setMyStopIdx]   = useState(null);
  const [rawBuses, setRawBuses]     = useState([]);
  const [center, setCenter]         = useState({ lat: 37.3894, lng: 126.9522 });
  const [mapLevel, setMapLevel]     = useState(9);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [tick, setTick]             = useState(0);
  const [allRoutes, setAllRoutes]   = useState([]);    // 노선 변경 모달용 전체 노선
  const [routePicker, setRoutePicker] = useState(false); // 노선 변경 모달 표시
  const [routeQuery, setRouteQuery] = useState("");    // 노선 검색어
  const [stopInfo, setStopInfo]     = useState(null);  // 지도 정류장 클릭 정보 카드
  const [rvOk, setRvOk]             = useState(true);  // 거리뷰 커버리지(반경 내 파노라마 유무) — 없으면 사진 폴백
  const [manualTick, setManualTick] = useState(0);     // 노선 새로고침 버튼 → onSnapshot 재구독
  const [refreshing, setRefreshing] = useState(false); // 새로고침 진행 표시
  const busesRaw = useAnimatedPositions(rawBuses);

  // ── 노선 표시 시간창 (2026-08-05 회의 #2·#3) ────────────────────────────
  // 운행 시간 밖에 있는 차량은 승객 화면 노선도에 띄우지 않는다("출발도착지에 아예
  // 가지도 않았는데 노선도상에 버스가 표시되고 있다"). 창은 노선에 직접 입력한
  // displayStart~displayEnd 가 최우선, 없으면 departTime ± 회사 기본값에서 파생.
  // 🔴 관제(AdminApp)·협력사 포털에는 적용하지 않는다 — way "관제의 핵심은 차량
  //    위치가 잘 보이는 것". 가리는 건 승객이 보는 화면뿐.
  // 🔴 창이 null(출발시각·표시시간 둘 다 없음)이면 게이트 없음 = 예전 동작 그대로.
  //    설정을 안 넣은 노선의 차가 통째로 사라지면 안 된다.
  // 1초 tick(setTick) 재렌더가 있어 시각 경과가 자연히 반영된다.
  const [companyCfg, setCompanyCfg] = useState(null);
  useEffect(() => {
    if (!companyId) return;
    let alive = true;
    getDoc(doc(db, 'companies', companyId))
      .then(s => { if (alive && s.exists()) setCompanyCfg(s.data()); })
      .catch(() => {});   // 실패 = 기본값(30/30)으로 동작
    return () => { alive = false; };
  }, [companyId]);
  const routeForWindow = routes.find(r => r.id === activeRouteId) || allRoutes.find(r => r.id === activeRouteId) || null;
  const routeWindow = computeRouteWindow(routeForWindow, stops, normalizeWindowOpts(companyCfg));
  const windowOpen = isWithinRouteWindow(routeWindow, nowMinutesKST());
  const buses = windowOpen ? busesRaw : [];

  const favorites = session.favorites || [];
  const lastBusProgressRef = useRef(null); // 경로 이탈 시 직전 유효 진행거리 유지
  const progressRouteRef = useRef(null);   // 진행거리를 유지할 "한 운행"의 노선(바뀌면 리셋)
  // 정류장 탭 시 사용자가 직접 센터를 옮긴 상태 — true 면 GPS 갱신 자동 재센터를 억제
  // (탭한 정류장이 다음 GPS 틱에 버스↔내정류장 중점으로 즉시 밀려나던 결함 차단, #3).
  const userCenteredRef = useRef(false);

  // 노선 새로고침(#2) — Firestore 강제 재연결 + GPS/dispatch onSnapshot 재구독.
  // 운행 중 기사 GPS 껐다 켜진 뒤 화면에 위치가 즉시 반영 안 되는 케이스 수동 해소.
  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    await forceReconnect();
    setManualTick(t => t + 1);
    setLastUpdate(new Date());
    setTimeout(() => setRefreshing(false), 600);
  };

  // 지도 정류장 마커/라벨 터치 — 정보 카드 + 그 정류장을 중앙으로(#3, 자동 재센터 억제).
  const openStopInfo = (s, i) => {
    userCenteredRef.current = true;
    setCenter({ lat: s.lat, lng: s.lng });
    setStopInfo({ ...s, idx: i });
  };

  // 정보 카드가 새 정류장으로 열릴 때마다 거리뷰 커버리지 상태 리셋 —
  // 이전 정류장에서 파노라마 없어 폴백했던 rvOk=false 가 다음 정류장에 잔존하는 것 차단.
  useEffect(() => { setRvOk(true); }, [stopInfo?.idx, stopInfo?.name]);

  // 백그라운드 → foreground 복귀 시 onSnapshot 재구독(stale 리스너 신선화).
  // EmployeeApp(/p) 통근버스 사용자는 등하교 전후 장시간 백그라운드 상태가 흔함.
  const wakeTick = useWakeTick();
  // 통신 끊김→복구(online 전이) 시 Firestore reconnect 강제 + onSnapshot 재구독.
  // 직원앱이 노선 변경/재시작 없이도 자동 활성화되도록 보강(2026-05-28).
  const recoverTick = useOnlineRecover({ forceFirestoreReconnect: true });

  useEffect(() => {
    const t = setInterval(() => setTick(x => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // 노선 목록 (배정 + 즐겨찾기). 동일 getDocs로 전체 노선(노선 변경 모달용)도 함께 보관
  useEffect(() => {
    if (!companyId) return;
    getDocs(collection(db, 'companies', companyId, 'routes')).then(snap => {
      const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setAllRoutes(all);
      // 홈 노선 = **즐겨찾기**. 하나도 없으면 배정 노선(2026-08-18 배시현 개선요청).
      // 예전엔 `배정 ∪ 즐겨찾기` 라 **가입 때 자동으로 잡힌 노선을 뺄 방법이 없었다** —
      // 별을 눌러 고른 것만 홈에 두자는 요청. prod 실측 251명 중 즐겨찾기 보유 14명이고
      // 그중 11명은 배정 노선을 이미 즐겨찾기에 넣어 둬 화면 변화 0, 237명은 즐겨찾기가
      // 없어 기존과 동일(배정 1개).
      const shown = homeRouteList(all, { assignedRouteId: session.routeId, favorites });
      // 미배정 폴백도 본인 거래처 노선만(타 거래처 노출 차단). partnerCode 미설정 직원은 전체(하위호환).
      const myPartner = session.partnerCode || null;
      const fallback = sortRoutes(myPartner ? all.filter(r => (r.partnerCode || null) === myPartner) : all).slice(0, 3);
      setRoutes(shown.length > 0 ? shown : fallback);
      // 🔴 첫 로드에서만 활성 노선을 목록 안으로 끌어온다. 매번 하면 "노선 변경"으로 고른
      //    기준 노선이 즐겨찾기가 아닐 때 곧바로 첫 즐겨찾기로 튕겨 나간다.
      if (!initialRouteBoundRef.current) {
        initialRouteBoundRef.current = true;
        if (shown.length > 0 && !shown.some(r => r.id === activeRouteId)) setActiveRouteId(shown[0].id);
      } else if (!activeRouteId && shown.length > 0) {
        setActiveRouteId(shown[0].id);
      }
    });
  }, [companyId, session.routeId]);

  // 기준 노선(session.routeId) 변경 시 활성 노선·내 정류장 재바인딩
  useEffect(() => {
    if (session.routeId) { setActiveRouteId(session.routeId); setMyStopIdx(null); }
  }, [session.routeId]);

  // 노선 변경 확정 — 기준 노선 갱신 + localStorage 영속(다음 로그인까지 유지) + 재바인딩
  const chooseRoute = (rid) => {
    onSessionUpdate({ routeId: rid });   // saveSession으로 localStorage 자동 영속
    setActiveRouteId(rid);
    setMyStopIdx(null);
    // 노선이 바뀌면 이전 노선의 내 정류장 영속값도 해제 — 옛 노선 도착 푸시 차단.
    if (rid !== activeRouteId) persistMyStop(companyId, session?.empNo, null, null);
    setStops([]);
    setStopInfo(null);
    setRoutePicker(false);
    setRouteQuery("");
  };

  // 내 정류장 선택/해제 — myStopIdx state 갱신 + fcmTokens 영속화(도착 임박 푸시 타겟).
  // idx=null 이면 해제(routeId/stopId null). 같은 정류장을 다시 누르면 토글 해제.
  const selectMyStop = (idx) => {
    setMyStopIdx(idx);
    const stopId = (idx !== null && stops[idx]) ? stops[idx].id : null;
    persistMyStop(companyId, session?.empNo, stopId ? activeRouteId : null, stopId);
  };

  // 노선 변경 모달 검색 필터 (노선명·구분·코드·거래처)
  // 거래처 격리(2026-06-17): 직원 본인 거래처(session.partnerCode) 노선만 노출 — 타 거래처/미지정 노선 숨김.
  //   partnerCode 미설정 직원은 전체 노출(하위호환). 모달 표시 전용이라 현재 노선 해석·홈 로직 무영향.
  const myPartner = session.partnerCode || null;
  const filteredAllRoutes = allRoutes.filter(r => {
    if (myPartner && (r.partnerCode || null) !== myPartner) return false;
    const q = routeQuery.trim().toLowerCase();
    if (!q) return true;
    return [r.name, r.type, r.code, r.partnerName].some(v => (v || "").toString().toLowerCase().includes(q));
  }).sort(compareRoutes); // 관리자 지정 표시 순서(2026-07-10) — 노선 탭 목록과 동일 규칙

  // 정류장 로드 + 저장된 '내 정류장' 복원(도착 임박 푸시, 2026-05-22)
  // fcmTokens/{empNo} 에 저장된 routeId/stopId 가 현재 노선과 일치하면 myStopIdx 복원 →
  // 새로고침해도 내 정류장 유지(현 불편 동시 해결).
  useEffect(() => {
    if (!activeRouteId || !companyId) return;
    let cancelled = false;
    setStops([]);
    getDocs(query(
      collection(db, 'companies', companyId, 'routes', activeRouteId, 'stops'),
      orderBy('order', 'asc')
    )).then(async snap => {
      if (cancelled) return;
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setStops(list);
      if (list.length > 0) setCenter({ lat: list[0].lat, lng: list[0].lng });
      // 저장된 내 정류장 복원 — 저장 routeId 가 현재 노선과 같을 때만.
      if (session?.empNo) {
        try {
          const tsnap = await getDoc(doc(db, 'companies', companyId, 'fcmTokens', session.empNo));
          if (cancelled) return;
          const tdata = tsnap.exists() ? tsnap.data() : null;
          if (tdata && tdata.routeId === activeRouteId && tdata.stopId) {
            const idx = list.findIndex(s => s.id === tdata.stopId);
            if (idx >= 0) {
              setMyStopIdx(idx);
              setCenter({ lat: list[idx].lat, lng: list[idx].lng });
            }
          }
        } catch (e) {
          // 복원 실패는 비치명적 — 사용자가 다시 정류장을 고르면 됨.
          console.warn('[내 정류장 복원 실패]', e.message);
        }
      }
    });
    return () => { cancelled = true; };
  }, [activeRouteId, companyId, session?.empNo]);

  // 실시간 GPS — wakeTick 으로 백그라운드 복귀 시 재구독
  useEffect(() => {
    if (!companyId) return;
    const q = query(collection(db, 'gps'), where('companyId', '==', companyId));
    return onSnapshot(q, snap => {
      let list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (activeRouteId) list = list.filter(b => b.routeId === activeRouteId);
      setRawBuses(list);
      setLastUpdate(new Date());
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, activeRouteId, wakeTick, recoverTick, manualTick]);

  // ── 오늘 노선 도착 기록(stopArrivals 실 도착시각) ────────────────
  // 🔴 예전엔 `dispatches` 를 직접 onSnapshot 했는데 그 컬렉션 read 는 admin/기사 전용이라
  //    익명인 이 화면에서는 **언제나 거부**됐다(빈 결과로 흡수). 그 탓에 실제 도착시각·
  //    '직전 정류장 도착' 인앱 알림·'운행 종료' 표기가 조용히 죽어 있었다(2026-08-18).
  //    서버 위임 CF `getRouteStopArrivals`(정본 훅 = src/lib/useRouteStopArrivals.js).
  //    병합 규칙(같은 노선 여러 배차 → 정류장마다 가장 이른 도착)은 서버가 그대로 한다.
  const { todayDispatch } = useOneRouteStopArrivals({
    companyId,
    routeId: activeRouteId,
    active: rawBuses.length > 0, // 버스가 달릴 때만 갱신(도착 기록은 그때만 는다)
    tick: wakeTick + recoverTick + manualTick,
  });

  const mainBus   = buses[0] || null;
  const myStop    = myStopIdx !== null ? stops[myStopIdx] : null;
  const activeRoute = routes.find(r => r.id === activeRouteId) || allRoutes.find(r => r.id === activeRouteId);
  // 홈 칩 = 즐겨찾기 목록 + **지금 보고 있는 노선**. 노선 변경으로 고른 노선이 즐겨찾기가
  // 아니어도 칩에는 보여야 한다(안 그러면 화면은 그 노선인데 아무 칩도 선택돼 있지 않다).
  const homeRoutes = useMemo(() => {
    if (!activeRouteId || routes.some(r => r.id === activeRouteId)) return routes;
    const cur = allRoutes.find(r => r.id === activeRouteId);
    return cur ? [cur, ...routes] : routes;
  }, [routes, allRoutes, activeRouteId]);

  // ── 사전 경로(routePath) 우선, 없으면 stops 직선 폴백(하위호환 필수) ──
  // 노선 문서 routePath = [{lat,lng}, ...] (작업1에서 관리자가 그림). 유효 좌표 ≥2면 채택.
  const preDrawnPath = Array.isArray(activeRoute?.routePath)
    ? activeRoute.routePath.filter(p => typeof p?.lat === 'number' && typeof p?.lng === 'number')
    : [];
  const usePathProgress = preDrawnPath.length >= 2;
  const routePath = usePathProgress
    ? preDrawnPath
    : stops.map(s => ({ lat: s.lat, lng: s.lng }));
  const routeCum = usePathProgress ? buildCumulativeLengths(routePath) : null;
  const routeTotal = routeCum ? routeCum[routeCum.length - 1] : 0;

  // 버스를 경로에 투영 — 이탈(수직거리>OFF_ROUTE_M) 시 직전 유효 진행거리 유지
  const busProj = (usePathProgress && mainBus)
    ? projectToPolyline({ lat: mainBus.lat, lng: mainBus.lng }, routePath, routeCum) : null;
  // 🔴 진행거리 리셋 축은 **노선**이다 — 노선을 바꾸면 이전 노선 진행거리를 물려받으면
  //    안 된다(이 수정 전부터 있던 결함). 렌더 중 ref 갱신은 이 파일의 기존 패턴과 같다.
  if (progressRouteRef.current !== activeRouteId) {
    progressRouteRef.current = activeRouteId;
    lastBusProgressRef.current = null;
  }
  // 🔴 역행 금지 — 판정은 정본 `routeProgress.advanceProgress`(2026-08-25 채드윅).
  //    운행이 끝난 버스가 종점을 지나 되짚어 가면 progress 가 역행해 "지나온 회색/남은 파랑"
  //    분할이 되감기고, 회색이던 구간이 다시 파래진다. 근거·실측은 그 함수 주석 참조.
  const busProgress = advanceProgress(busProj, lastBusProgressRef.current, OFF_ROUTE_M);
  lastBusProgressRef.current = busProgress;
  // 내 정류장도 경로에 투영해 진행거리 산출
  const myStopProgress = (usePathProgress && myStop)
    ? projectToPolyline({ lat: myStop.lat, lng: myStop.lng }, routePath, routeCum)?.progress
    : null;

  // ── 노선 순서 기반(폴백용) — 버스→가장 가까운 정류장 인덱스 ──
  // 🔴 **거리 상한이 있어야 한다**(2026-08-06 배시현 "첫 정류장 도착 전인데 이미 지나쳤다고 나온다").
  //   경로(routePath)가 있어도 버스가 아직 그 경로에 안 올랐으면(차고지→첫 정류장 이동 중)
  //   perpDist>OFF_ROUTE_M 이라 busProgress 가 null 이 되고 **이 폴백으로 떨어진다**.
  //   그런데 예전엔 상한이 없어 **몇 km 밖에서도 가장 가까운 정류장을 "현재"로 골랐고**,
  //   그 앞 정류장이 전부 '지나침'으로 표시됐다(내 정류장 카드의 "이미 지나침"도 같은 값을 탄다).
  //   prod 실측: [서초] 등교에서 버스가 경로 2.8km 밖·서초역 3.0km 밖인데 서초역을 '현재'로 골랐다.
  //   → 정류장 반경 밖이면 **-1**(어느 정류장에도 있지 않음) 을 돌려 아무것도 지나쳤다고 하지 않는다.
  const _busStopIdx = (() => {
    if (!mainBus || stops.length === 0) return -1;
    let minDist = Infinity, idx = 0;
    stops.forEach((s, i) => {
      const d = Math.hypot(s.lat - mainBus.lat, s.lng - mainBus.lng);
      if (d < minDist) { minDist = d; idx = i; }
    });
    // Math.hypot 은 위경도 차라 m 로 다시 잰다(위도별 경도 길이 차이를 무시하지 않게).
    // 🔴 거리를 못 재면(좌표 결손·NaN) -1 — 모르는 상태를 "0번 정류장에 있다"로 지어내지 않는다.
    const meters = haversineM(mainBus, stops[idx]);
    return meters === null || meters > NEAR_STOP_M ? -1 : idx;
  })();

  // 버스와 내 정류장의 직선 거리(m) 계산 (폴백용)
  const _distToMyStop = mainBus && myStop ? (() => {
    const R = 6371000;
    const dLat = (myStop.lat - mainBus.lat) * Math.PI / 180;
    const dLng = (myStop.lng - mainBus.lng) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(mainBus.lat*Math.PI/180)*Math.cos(myStop.lat*Math.PI/180)*Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  })() : null;

  // ── 정류장 estimates(계획 + 누적지연 + GPS 가중) ───────────────
  // todayDispatch.stopArrivals = { stopId: actualMs } (서버측 도착 기록).
  // departTime/offsetMin 미설정이면 status='unplanned'로 폴백 분기.
  const stopEstimates = computeStopEstimates({
    stops,
    departTime: activeRoute?.departTime,
    actualArrivals: todayDispatch?.stopArrivals || {},
    vehiclePos: mainBus ? { lat: mainBus.lat, lng: mainBus.lng } : null,
    speed: mainBus?.speed,
    routePath: usePathProgress ? routePath : null,
  });
  const estByStopId = Object.fromEntries(stopEstimates.map(e => [e.stopId, e]));
  const myStopEst = myStop ? estByStopId[myStop.id] : null;

  // ── 운행 종료 판정(표시 전용, 2026-07-16 배시현 개선요청) ───────────
  // clearGPS 후에도 stopArrivals 잔존으로 내 정류장 카드가 "이미 지나침" 영구 표시되던 것을
  // "운행 종료"로 교체하기 위한 파생값. 기존 구독(todayDispatch/stops/rawBuses)만 사용 — 신규 구독 0.
  // rawBuses = 이 노선 gps 원본 문서(updatedAt 포함 — buses 는 rAF 보간 사본이라 원본 사용).
  // 1초 tick(setTick) 재렌더로 GPS stale 전이도 자연 반영. 판정 로직은 lib/runStatus.js(순수).
  const runEnded = computeRunEnded({
    hasTodayDispatch: !!todayDispatch,
    stopArrivals: todayDispatch?.stopArrivals,
    stops,
    gpsDocs: rawBuses,
  });
  // [DIAG-ETA 제거예정] URL ?debug=1 일 때만 노출. prod 영향 0.
  const diagEnabled = getParam("debug") === "1";
  // [/DIAG-ETA]

  // ★ 핵심 — routePath 있으면 경로 진행거리 기반, 없으면 노선 순서(기존) 폴백
  // 2026-05-21: 큰 카운트다운 안정화를 위해 분(`eta`)과 초(`etaSec`)를 함께 산출.
  //   - `eta`(분): 기존 색상 분기·텍스트 분기 호환(0~10분 임계 등 회귀-0).
  //   - `etaSec`(초): useSmoothedEta + formatPassengerEta 입력. 부드러운 카운트다운.
  // myStopEst(stopSchedule plan+delay GPS 30:70 가중)가 있으면 그것을 정본으로 우선 —
  // 한 화면에서 카드/리스트가 다른 시각을 가리키는 불일치 제거(승객 신뢰도).
  const etaStatus = (() => {
    if (!mainBus || myStopIdx === null) return { type: 'waiting' };        // 버스 없음
    // myStopEst의 estimatedAt → etaSec 보조 우선(plan+delay+GPS 30:70 안정).
    let estSec = null;
    if (myStopEst && myStopEst.estimatedAt && myStopEst.status !== 'unplanned' && myStopEst.status !== 'arrived') {
      const base = new Date();
      base.setHours(0, 0, 0, 0);
      const m = myStopEst.estimatedAt.match(/^(\d{2}):(\d{2})$/);
      if (m) {
        const arriveMs = base.getTime() + (+m[1] * 60 + +m[2]) * 60 * 1000;
        const diff = Math.round((arriveMs - Date.now()) / 1000);
        if (diff > -60 && diff < 6 * 3600) estSec = Math.max(0, diff); // 합리 범위만
      }
    }

    if (usePathProgress && busProgress !== null && myStopProgress !== null) {
      const remain = myStopProgress - busProgress;          // 내 정류장까지 남은 경로거리(m)
      if (busProgress > myStopProgress + PASSED_MARGIN_M) return { type: 'passed', etaSec: null };
      if (remain < ARRIVING_M) return { type: 'arriving', etaSec: 0 };
      // ETA = 남은 경로거리/속도 (calcETA 시그니처 재사용 — 거리 입력만 경로거리로)
      const speed = (mainBus.speed > 5 ? mainBus.speed : 30);
      const etaSecRaw = Math.max(0, (remain / 1000) / speed * 3600);
      const eta = Math.ceil(etaSecRaw / 60);
      return { type: 'approaching', eta, etaSec: estSec != null ? estSec : etaSecRaw };
    }
    // ── 폴백(routePath 없음): 기존 노선 순서 로직 그대로 ──
    if (_distToMyStop !== null && _distToMyStop < 150) return { type: 'arriving', etaSec: 0 }; // 150m 이내 = 곧 도착
    if (_busStopIdx > myStopIdx) return { type: 'passed', etaSec: null };               // 버스가 내 정류장 지남
    if (_busStopIdx < myStopIdx) {
      const eta = calcETA({ lat: mainBus.lat, lng: mainBus.lng }, myStop, mainBus.speed);
      // 폴백 etaSec — calcETA는 분 단위라 초로 환산하면 ceil 점프 일부 잔존,
      // useSmoothedEta가 흡수. 직선거리(_distToMyStop) 재사용해 비용 0.
      const speed = (mainBus.speed > 5 ? mainBus.speed : 30);
      const fallbackSec = _distToMyStop != null
        ? Math.max(0, (_distToMyStop / 1000) / speed * 3600) : null;
      return { type: 'approaching', eta, etaSec: estSec != null ? estSec : fallbackSec };  // 접근 중
    }
    return { type: 'arriving', etaSec: 0 };                                           // 동일 정류장
  })();

  // 부드러운 카운트다운(EMA + rate-limit) — 'approaching'만 적용.
  // 'arriving'/'passed'/'waiting'은 텍스트 분기이므로 EMA 무관.
  // 분 단위 점프·5km/h 임계점프·GPS 노이즈를 흡수해 "갑자기 늘어났다 줄어드는" 현상 완화.
  const smoothedEtaSec = useSmoothedEta(
    etaStatus.type === 'approaching' ? etaStatus.etaSec : null
  );
  const passengerLabel = (etaStatus.type === 'approaching')
    ? formatPassengerEta(smoothedEtaSec)
    : null;

  // 표시용 색상 — 2026-05-21: smoothedEtaSec 기반(분 단위)으로 깜빡임 흡수.
  // 임계값은 동일(≤3분=destructive·≤10분=cautionary). smoothed 없으면 etaStatus.eta 폴백.
  const colorMin = smoothedEtaSec != null ? smoothedEtaSec / 60 : etaStatus.eta;
  const etaColor = etaStatus.type === 'passed'
    ? 'var(--color-cautionary)'
    : etaStatus.type === 'arriving'
      ? 'var(--color-destructive)'
      : colorMin !== undefined && colorMin !== null && colorMin <= 3
        ? 'var(--color-destructive)'
        : colorMin !== undefined && colorMin !== null && colorMin <= 10
          ? 'var(--color-cautionary)'
          : 'var(--color-primary)';

  // 버스와 내 정류장 사이로 지도 중심 설정 — 단, 사용자가 정류장을 직접 탭해
  // 센터를 옮긴 뒤(userCenteredRef)에는 자동 재센터 억제(#3). 탭한 정류장이 다음
  // GPS 갱신(~5초)마다 중점으로 밀려나던 결함 차단. 노선 변경 시 ref 리셋(아래).
  useEffect(() => {
    if (userCenteredRef.current) return;
    if (mainBus?.lat && myStop?.lat) {
      setCenter({ lat: (mainBus.lat + myStop.lat) / 2, lng: (mainBus.lng + myStop.lng) / 2 });
    } else if (myStop?.lat) {
      setCenter({ lat: myStop.lat, lng: myStop.lng });
    } else if (mainBus?.lat) {
      setCenter({ lat: mainBus.lat, lng: mainBus.lng });
    }
  }, [mainBus?.lat, mainBus?.lng, myStop?.lat, myStop?.lng]);

  // 노선 변경 시 자동 재센터 억제 해제 — 새 노선은 기본 프레이밍(버스/내정류장)부터 시작.
  useEffect(() => { userCenteredRef.current = false; }, [activeRouteId]);

  const stripRef = useRef(null);
  const stripFocusRef = useRef(null);

  const timeSince = d => {
    if (!d) return '';
    const s = Math.floor((new Date() - d) / 1000);
    return s < 10 ? '방금' : s < 60 ? `${s}초 전` : `${Math.floor(s/60)}분 전`;
  };

  // 정류장별 경로 진행거리(routePath 모드) — 노선도 스트립 progress 정합용
  const stopProgresses = (usePathProgress && stops.length > 0)
    ? stops.map(s => projectToPolyline({ lat: s.lat, lng: s.lng }, routePath, routeCum)?.progress ?? 0)
    : null;

  // 노선도 스트립의 버스 위치 인덱스 — progress 모드면 진행거리로 통일, 아니면 기존 최근접
  const busStopIdx = (usePathProgress && busProgress !== null && stopProgresses)
    ? (() => {
        // 버스 progress가 지난 마지막 정류장 인덱스(없으면 0)
        let idx = 0;
        for (let i = 0; i < stopProgresses.length; i++) {
          if (stopProgresses[i] <= busProgress + PASSED_MARGIN_M) idx = i;
        }
        return idx;
      })()
    : _busStopIdx;

  // 노선 스트립 자동 스크롤 — 2026-08-05 회의 #4 통합의 필수 짝.
  //   요약바(4노드)는 전 구간이 한 화면에 들어와 진입 즉시 "지금 어디"가 보였는데,
  //   전 정류장을 한 줄로 합치면 정류장 10곳짜리 노선은 앞 4곳만 보이고 버스가 화면 밖에 있다.
  //   → 버스 위치(없으면 내 정류장)를 가로 스크롤 중앙으로 데려온다.
  // ⚠ 세로 스크롤·지도는 건드리지 않는다(컨테이너 scrollLeft 만 조작).
  // 🔴 이 훅은 반드시 busStopIdx 선언 **뒤**에 있어야 한다 — 의존성 배열은 렌더 중 평가되므로
  //    위로 올리면 TDZ("Cannot access ... before initialization")로 화면이 통째로 죽는다.
  useEffect(() => {
    const box = stripRef.current, node = stripFocusRef.current;
    if (!box || !node) return;
    const left = node.offsetLeft - (box.clientWidth - node.offsetWidth) / 2;
    box.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
  }, [busStopIdx, myStopIdx, activeRouteId, stops.length]);

  // 마지막 정류장 = 도착지(=회사, 탑승자 없음). 이 정류장을 내 정류장으로
  // 선택했을 때만 하단 ETA 패널 문구를 "목적지 도착" 류로 대체(표시 문자열만 분기).
  const isDestStop = stops.length >= 2 && myStopIdx === stops.length - 1;
  // 표시 색상: 도착지에서 passed(=목적지 도착 완료)는 cautionary가 부적절 → positive.
  // 그 외는 기존 etaColor 로직 그대로(비-도착지 픽셀 불변).
  const etaDisplayColor = isDestStop && etaStatus.type === 'passed'
    ? 'var(--color-positive)'
    : etaColor;

  // ── ArrivalProximityModal (2026-05-28) ──────────────────────────────────
  // 내 정류장(myStopIdx) 직전 정류장(myStopIdx-1)이 stopArrivals에 새로 등장(actualAt
  // 최근 5분 이내)하면 풀스크린 모달로 "곧 도착" 안내. 1회만(dismissed) + activeRouteId
  // 변경 시 reset. myStopIdx==0이면 직전 없음=비표시. notifyPreArrival CF FCM과 별도
  // 인-앱 보장 통로(중복 무해 — NoticeForceModal 패턴 준용·OEM 절전 누락 폴백).
  const [proximityModal, setProximityModal] = useState(null); // { stopName } | null
  const proximityDismissedRef = useRef(new Set());
  useEffect(() => {
    proximityDismissedRef.current = new Set();
    setProximityModal(null);
  }, [activeRouteId]);
  useEffect(() => {
    if (myStopIdx === null || myStopIdx <= 0 || stops.length === 0) return;
    const prevStop = stops[myStopIdx - 1];
    if (!prevStop) return;
    const sa = todayDispatch?.stopArrivals || {};
    const arrivedMs = sa[prevStop.id];
    if (arrivedMs == null) return;
    if (Date.now() - arrivedMs > 5 * 60 * 1000) return;
    if (proximityDismissedRef.current.has(prevStop.id)) return;
    setProximityModal({ stopName: prevStop.name });
  }, [myStopIdx, stops, todayDispatch?.stopArrivals]);
  const closeProximityModal = () => {
    if (proximityModal && myStopIdx > 0 && stops[myStopIdx - 1]) {
      proximityDismissedRef.current.add(stops[myStopIdx - 1].id);
    }
    setProximityModal(null);
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--color-bg-alt)' }}>

      {/* ── 상단 브랜드 밴드 (2026-08-10 리스킨) ──────────────────────────
          예전엔 흰 배경에 로고·이름·노선명·상태·버튼이 **비슷한 크기로 흩어져** 있어
          무엇을 먼저 볼지 안 읽혔다(way 고객 피드백 "조잡해 보인다").
          거래처 색으로 밴드를 깔고 그 안에 **노선명 하나만 크게** 둔다.
          🔴 로고는 흰 알약 안에 넣는다 — 거래처 로고 색을 우리가 통제할 수 없어
             (채드윅=남색 글자) 밴드 위에 그냥 얹으면 어느 고객사에선 사라진다.
          🔴 글자색은 하드코딩하지 않고 밴드 휘도로 정한다(`brandBand`) — 밝은 브랜드색
             거래처에서 흰 글씨가 안 읽히는 사고 방지. */}
      <div style={{ background: band.bg, padding: '12px 14px 13px', flexShrink: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, minHeight: 26 }}>
          {branding?.logo ? (
            <div style={{ background: '#fff', borderRadius: 'var(--radius-8)', padding: '4px 8px', display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
              <img src={branding.logo} alt="" style={{ height: Math.min(logoHeightOf(branding), 24), maxWidth: 120, objectFit: 'contain', display: 'block' }} />
            </div>
          ) : (
            <div style={{ fontSize: 13, fontWeight: 800, color: band.fg, letterSpacing: '-0.01em' }}>BusLink</div>
          )}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0, padding: '4px 10px', borderRadius: 'var(--radius-pill)', background: band.chipBg, border: `1px solid ${band.chipLine}`, fontSize: 11, fontWeight: 700, color: band.fg }}>
            <StatusDot tone={buses.length > 0 ? 'positive' : 'neutral'} size={7} pulse={buses.length > 0} />
            {buses.length > 0 ? `${buses.length}대 운행중` : '운행 없음'}
          </span>
        </div>

        {/* 이름 — 보조 정보라 작게 */}
        <div style={{ fontSize: 12, fontWeight: 600, color: band.fgMute, marginTop: 11 }}>
          {session.name}{session.dept ? ` · ${session.dept}` : ''}
        </div>
        {/* 현재 노선 — 이 화면의 주인공. 2줄까지(실측 최대 44자는 2줄에 들어간다). */}
        <div style={{ fontSize: 17, fontWeight: 800, color: band.fg, marginTop: 2, letterSpacing: '-0.02em', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', wordBreak: 'keep-all', lineHeight: 1.3 }}>
          {activeRoute ? activeRoute.name : '노선을 선택하세요'}
        </div>

        {/* 액션 — 같은 높이·같은 모서리·같은 톤으로 통일(예전엔 넷이 제각각이었다) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 11 }}>
          <button onClick={() => { setRouteQuery(''); setRoutePicker(true); }}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 32, padding: '0 13px', borderRadius: 'var(--radius-pill)', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 700, background: '#fff', color: band.bg }}>
            <Icon name="repeat" size={13} stroke={2.1} /> 노선 변경
          </button>
          {/* #2 — 노선 새로고침: GPS 껐다 켜진 뒤 위치 미반영 시 수동 재구독·재연결 */}
          <button onClick={handleRefresh} disabled={refreshing}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 32, padding: '0 13px', borderRadius: 'var(--radius-pill)', border: `1px solid ${band.chipLine}`, cursor: refreshing ? 'default' : 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 700, background: band.chipBg, color: band.fg, opacity: refreshing ? 0.6 : 1 }}>
            <span style={{ display: 'inline-flex', animation: refreshing ? 'blspin 0.8s linear infinite' : 'none' }}><Icon name="refresh" size={13} stroke={2.1} /></span>
            {refreshing ? '새로고침 중' : '새로고침'}
          </button>
          {lastUpdate && (
            <span style={{ marginLeft: 'auto', fontSize: 10.5, color: band.fgMute, flexShrink: 0 }}>{timeSince(lastUpdate)} 갱신</span>
          )}
        </div>
        {/* 노선 칩 (즐겨찾기 + 지금 보는 노선이 복수일 때 — 빠른 전환, 영속 아님) */}
        {homeRoutes.length > 1 && (
          <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginTop: 8, paddingBottom: 2 }}>
            {homeRoutes.map(r => (
              // 밴드 위에 얹히므로 토큰 색이 아니라 밴드 대비색을 쓴다(흰 배경 전제였던 값을
              // 그대로 두면 컬러 밴드 위에서 대비가 무너진다).
              <button key={r.id} onClick={() => { setActiveRouteId(r.id); setMyStopIdx(null); }}
                style={{ flexShrink: 0, padding: '5px 12px', borderRadius: 'var(--radius-pill)', cursor: 'pointer',
                  fontFamily: 'inherit', fontSize: 11, fontWeight: 700,
                  border: `1px solid ${activeRouteId === r.id ? 'transparent' : band.chipLine}`,
                  background: activeRouteId === r.id ? '#fff' : band.chipBg,
                  color: activeRouteId === r.id ? band.bg : band.fg }}>
                {r.name.length > 14 ? r.name.substring(0,14)+'…' : r.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 권한 안내 — 브랜드 밴드 **바로 아래**, 지도 위(2026-08-10).
          🔴 스크롤 밖으로 밀리면 안 되는 메시지라 지도보다 위, `flexShrink:0` 자리에 둔다.
             위치만 옮겼고 노출 조건은 그대로다(권한 없으면 도착 알림이 아예 안 간다). */}
      <PermissionGate containerStyle={{ flexShrink: 0, padding: '8px 12px 0' }} />

      {/* [DIAG-ETA 제거예정] EmployeeApp 진단 — URL ?debug=1 일 때만, 내 정류장 한정.
          prod 영향 0(URL 파라미터 없으면 미렌더). 다음 커밋에 grep "[DIAG-ETA" 통째 제거. */}
      {diagEnabled && myStopIdx !== null && stops[myStopIdx] && (() => {
        const e = estByStopId[stops[myStopIdx].id];
        if (!e) return null;
        const delayMin = e.delaySec != null ? Math.round(e.delaySec / 60) : null;
        const delayLab = delayMin == null ? "—"
          : delayMin === 0 ? "0분"
          : delayMin > 0 ? `+${delayMin}분`
          : `${delayMin}분`;
        let segProg = null;
        if (usePathProgress && busProgress !== null && myStopProgress != null && myStopIdx > 0) {
          const prev = stops[myStopIdx - 1];
          const prevProj = projectToPolyline({ lat: prev.lat, lng: prev.lng }, routePath, routeCum);
          if (prevProj && myStopProgress > prevProj.progress) {
            const ratio = (busProgress - prevProj.progress) / (myStopProgress - prevProj.progress);
            segProg = Math.max(0, Math.min(1, ratio));
          }
        }
        return (
          <div style={{
            margin: '6px 12px 0', padding: 8, borderRadius: 8,
            background: '#FFFBEA', border: '1px dashed #C99A2E',
            fontSize: 10, fontFamily: 'monospace', lineHeight: 1.5, color: '#3a2e08',
          }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>[DIAG-ETA] 내 정류장 진단</div>
            <div>[{myStopIdx}] {stops[myStopIdx].name}</div>
            <div>plan {e.plannedAt || '—'} | est {e.estimatedAt || '—'} | delay {delayLab}</div>
            <div>status {e.status} | source {e.source}</div>
            <div>busProgress={typeof busProgress === 'number' ? Math.round(busProgress) + 'm' : '—'}
              {' | '}myStopProgress={myStopProgress != null ? Math.round(myStopProgress) + 'm' : '—'}
              {segProg != null && <> | segProgress={(segProg * 100).toFixed(1)}%</>}
            </div>
            <div>speed={mainBus?.speed != null ? mainBus.speed.toFixed(1) + 'km/h' : '—'}</div>
          </div>
        );
      })()}
      {/* [/DIAG-ETA] */}

      {/* ── 지도 (상단 55%) ── */}
      {/* 지도 52% — 2026-08-11 최우석 "노선(차량위치)쪽이 한눈에 보기 힘들다".
          노선도에 시각·'내 정류장' 줄이 늘면서 라벨 아래끝이 탭바를 17px 넘어 가려졌다(실측).
          🔴 눈대중이 아니라 `headless_check_home_strip.cjs` 가 **탭바 윗변과 라벨 아래끝을 픽셀로
             비교**하므로, 이 값을 되돌리면 그 검사가 빨간불이 된다. */}
      <div style={{ flex: '0 0 52%', minHeight: 0, position: 'relative' }}>
        {/* onCreate relayout: 이 지도 컨테이너는 100dvh→flex:1→flex:1→flex:'0 0 55%' 체인.
            카카오 맵이 dvh/flex 확정 전 0px로 초기화되면 CSS와 달리 자동 복구 안 함(영구 흰화면).
            생성 직후 + 레이아웃 안정 후 relayout 1회씩 = /bus(고정 100vh)와 동등한 안정성. */}
        <Map center={center} style={{ width: '100%', height: '100%' }} level={mapLevel}
          onCreate={map => { map.relayout(); setTimeout(() => map.relayout(), 300); }}
          onZoomChanged={map => setMapLevel(map.getLevel())}>

          {/* 노선 폴리라인 */}
          {/* 노선 폴리라인 — routePath 진행 모드면 지나온(회색)/남은(파랑) 분할, 아니면 단일 파랑(폴백) */}
          {routePath.length >= 2 && usePathProgress && busProgress !== null ? (
            <>
              {(() => { const t = pathUpTo(routePath, routeCum, busProgress); return t.length >= 2 ? (
                <Polyline path={t} strokeWeight={5} strokeColor={TRAVELED_COLOR} strokeOpacity={0.7} strokeStyle="solid" />
              ) : null; })()}
              {(() => { const r = pathFrom(routePath, routeCum, busProgress); return r.length >= 2 ? (
                <Polyline path={r} strokeWeight={5} strokeColor="#0066FF" strokeOpacity={0.85} strokeStyle="solid" />
              ) : null; })()}
            </>
          ) : routePath.length >= 2 ? (
            <Polyline path={routePath} strokeWeight={5} strokeColor="#0066FF" strokeOpacity={0.75} strokeStyle="solid" />
          ) : null}

          {/* 정류장 마커 — 클릭 시 정류장 정보 카드 */}
          {stops.map((s, i) => {
            const isMyStop = myStopIdx === i;
            const isFirst  = i === 0;
            const isLast   = i === stops.length - 1;
            return (
              <MapMarker key={s.id} position={{ lat: s.lat, lng: s.lng }}
                onClick={() => openStopInfo(s, i)}
                image={{
                  src: isMyStop
                    ? 'https://t1.daumcdn.net/localimg/localimages/07/mapapidoc/markerStar.png'
                    : 'https://t1.daumcdn.net/localimg/localimages/07/mapapidoc/marker_red.png',
                  size: isMyStop ? { width: 24, height: 35 } : isFirst||isLast ? { width: 18, height: 26 } : { width: 12, height: 18 }
                }}
              />
            );
          })}

          {/* 모든 정류장 이름 레이블 — 출발/도착/내 정류장 강조, 중간 정류장 소형. 클릭 시 정보.
              계획·예상시각(offsetMin 설정 시) 추가 표시 — status별 색·접두어 차등. */}
          {stops.map((s, i) => {
            const isMyStop = myStopIdx === i;
            const isFirst  = i === 0;
            const isLast   = i === stops.length - 1;
            const emphasize = isMyStop || isFirst || isLast;
            // 시각 라벨 결정: status별 우선순위(arrived 도착 / next 예상 / upcoming 계획).
            // offsetMin 미설정(status='unplanned')이면 timeLabel=null → 이름만 표시(폴백).
            const est = estByStopId[s.id];
            let timeLabel = null, timeColor = null;
            if (est) {
              if (est.status === 'arrived' && est.estimatedAt) {
                timeLabel = `도착 ${est.estimatedAt}`;
                timeColor = emphasize ? 'rgba(255,255,255,0.92)' : 'var(--color-positive)';
              } else if (est.status === 'next' && est.estimatedAt) {
                timeLabel = `예상 ${est.estimatedAt}`;
                timeColor = emphasize ? '#fff' : 'var(--color-primary-deep)';
              } else if (est.status === 'upcoming' && est.plannedAt) {
                timeLabel = est.plannedAt;
                timeColor = emphasize ? 'rgba(255,255,255,0.92)' : 'var(--color-label-mute)';
              } else if (est.estimatedAt) {
                // 2026-05-26: offsetMin 미설정(status='unplanned')이지만 chain 전파된 예상시각 보유.
                timeLabel = `예상 ${est.estimatedAt}`;
                timeColor = emphasize ? 'rgba(255,255,255,0.92)' : 'var(--color-label-mute)';
              }
            }
            return (
              <CustomOverlayMap key={`lbl-${s.id}`} position={{ lat: s.lat, lng: s.lng }} yAnchor={isMyStop ? 3.6 : emphasize ? 3.1 : 2.5}>
                <div onClick={() => openStopInfo(s, i)}
                  style={ emphasize ? {
                    background: isMyStop ? 'var(--color-primary)' : isFirst ? 'var(--color-positive)' : 'var(--color-destructive)',
                    color: '#fff', borderRadius: 10, padding: '3px 9px',
                    fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap',
                    boxShadow: 'var(--shadow-float)', cursor: 'pointer',
                    textAlign: 'center', lineHeight: 1.25
                  } : {
                    background: 'var(--color-bg)', color: 'var(--color-label-mute)',
                    border: '1px solid var(--color-line)', borderRadius: 8,
                    padding: '1px 6px', fontSize: 9, fontWeight: 600, whiteSpace: 'nowrap',
                    maxWidth: 88, overflow: 'hidden', textOverflow: 'ellipsis',
                    boxShadow: 'var(--shadow-emphasize)', cursor: 'pointer',
                    textAlign: 'center', lineHeight: 1.25
                  }}>
                  <div>{isMyStop ? '내 ' : isFirst ? '출 ' : isLast ? '도 ' : ''}{s.name.length > 10 ? s.name.substring(0,10)+'…' : s.name}</div>
                  {/* #5 — 도착/예상시각 라벨은 선택한 내 정류장에만 표시(전 정류장 표시 클러터 제거). */}
                  {timeLabel && isMyStop && (
                    <div style={{ fontSize: emphasize ? 12 : 11, fontWeight: 700, color: timeColor, marginTop: 1 }}>
                      {timeLabel}
                    </div>
                  )}
                </div>
              </CustomOverlayMap>
            );
          })}

          {/* 버스 마커 — 펄스 ring + 강조 원형 아이콘 (시인성 강화). 외부 ring 은 absolute 펄스. */}
          {buses.map(b => b.lat && b.lng && (
            // #4 — yAnchor 0.5(중심 정렬)로 버스 아이콘을 노선 라인 위에 안착(이전 1.5=라인보다 위로 뜸).
            <CustomOverlayMap key={b.id} position={{ lat: b.lat, lng: b.lng }} yAnchor={0.5}>
              <div style={{ position: 'relative', width: 30, height: 30 }}>
                <span style={{
                  position: 'absolute', inset: 0, borderRadius: '50%',
                  background: 'var(--color-primary)', opacity: 0.5,
                  animation: 'buspulse 2s ease-out infinite', pointerEvents: 'none'
                }} />
                <div style={{
                  position: 'absolute', inset: 0,
                  background: 'var(--color-primary)', border: '3px solid #fff',
                  borderRadius: '50%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: '#fff', boxShadow: '0 0 0 4px rgba(0,102,255,.30), 0 6px 20px rgba(0,102,255,0.45)',
                  cursor: 'default'
                }}>
                  <Icon name="bus" size={17} stroke={2} />
                </div>
              </div>
            </CustomOverlayMap>
          ))}
        </Map>

        {/* 정류장 미선택 안내 */}
        {stops.length > 0 && myStopIdx === null && (
          <div style={{
            position: 'absolute', bottom: 10, left: '50%', transform: 'translateX(-50%)',
            background: 'var(--color-bg)', border: '1.5px solid var(--color-primary)',
            borderRadius: 'var(--radius-pill)', padding: '7px 16px',
            fontSize: 11, color: 'var(--color-primary)', fontWeight: 700, zIndex: 5, whiteSpace: 'nowrap',
            boxShadow: 'var(--shadow-float)'
          }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="pin" size={13} stroke={2} /> 아래 노선도에서 내 정류장을 클릭하세요</span>
          </div>
        )}
      </div>

      {/* ── 스크롤 컨테이너: 노선도 스트립 + 하단 ETA/QR 패널 (지도 아래 남은 공간·하단 패널이 tabBar 뒤로 잘리는 것 방지, 2026-07-09 #3) ── */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
      {/* ── 노선 진척 스트립(단일) — 2026-08-05 회의 #4 ──────────────────────
          예전엔 여기에 ①4노드 요약 진척바(출발/현재/다음/도착)와 ②전 정류장 노선도
          스트립이 위아래로 쌓여 있었다. 노선도처럼 생긴 게 두 줄이라 헷갈리고,
          위 요약바를 눌러도 아무 일이 없어 "탑승객이 누르고 탑승 못 하는" 일이 있었다.
          → 한 줄로 통합. **모양은 요약바 쪽**(역할 라벨·진척 색 연결선·상태줄)을 쓰고,
            **기능은 스트립 쪽**(전 정류장 표시 + 눌러서 내 정류장 지정)을 그대로 가져온다.
          🔴 정류장 전체를 그대로 두는 이유 = 4노드만 남기면 내 정류장을 고를 수가 없다
             (요약바에는 출발·현재·다음·도착 4개뿐이라 그 사이 정류장이 선택 불가). */}
      {(() => {
        const lastIdx = stops.length - 1;
        const inService = !!mainBus && busStopIdx >= 0;

        // 상태줄 — 운행 중이면 다음(없으면 도착)역으로 이동 중 + 다음역 ETA
        const nextStop = inService
          ? (busStopIdx + 1 <= lastIdx ? stops[busStopIdx + 1] : stops[lastIdx])
          : null;
        let etaText = null;
        if (nextStop) {
          const est = estByStopId[nextStop.id];
          const hhmm = est && (est.estimatedAt || est.plannedAt);
          const m = hhmm && /^(\d{1,2}):(\d{2})$/.exec(hhmm);
          if (m) {
            const base = new Date(); base.setHours(0, 0, 0, 0);
            const diff = Math.round((base.getTime() + (+m[1] * 60 + +m[2]) * 60000 - Date.now()) / 60000);
            if (diff >= 0 && diff < 60) etaText = diff === 0 ? '곧 도착' : `${diff}분`;
            else if (est.estimatedAt) etaText = `${est.estimatedAt} 예상`; // 60분 이상/과거는 시각 표시
          }
        }

        return (
          <div style={{ background: 'var(--color-bg)', borderTop: '1px solid var(--color-line)', borderBottom: '1px solid var(--color-line)', flexShrink: 0, padding: '10px 0 12px' }}>
            {stops.length === 0 ? (
              <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--color-label-alt)', padding: '4px 0' }}>
                {activeRoute ? '정류장 정보가 없습니다' : '노선을 선택해주세요'}
              </div>
            ) : (
              <>
                {/* 안내 문구(2026-08-11 최우석 요청) — "QR 태깅 화면을 못 찾겠다"에 대한 답.
                    정류장을 고르는 행동과 QR 탑승이 이어져 있다는 걸 노선도 바로 위에서 말해 준다. */}
                <div style={{ padding: '0 16px 8px', fontSize: 12.5, fontWeight: 700, color: 'var(--color-primary-deep)', wordBreak: 'keep-all', lineHeight: 1.4 }}>
                  탑승하실 정류장을 선택하시면 QR탑승 하실 수 있습니다.
                </div>
                {/* 가로 스크롤 — 정류장이 많으면 넘치므로 스크롤(스크롤바는 숨김·모바일 친화) */}
                <div data-route-strip ref={stripRef} style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', paddingBottom: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', paddingLeft: 16, paddingRight: 16, minWidth: 'max-content', gap: 0 }}>
                    {stops.map((s, i) => {
                      const isMyStop  = myStopIdx === i;
                      const isFirst   = i === 0;
                      const isLast    = i === lastIdx;
                      const isBusHere = busStopIdx === i;
                      const isReached = inService && i <= busStopIdx;

                      // 역할 라벨(요약바에서 흡수) — 한 정류장이 여러 역할이면 병합("다음·도착")
                      const roles = [];
                      if (isFirst) roles.push('출발');
                      if (inService && i === busStopIdx) roles.push('현재');
                      if (inService && i === busStopIdx + 1) roles.push('다음');
                      if (isLast) roles.push('도착');
                      const role = roles.join('·');

                      const est = estByStopId[s.id];
                      // 시각을 **전 정류장**에 표시(2026-08-11 최우석 요청 목업). 예전엔 역할·내 정류장에만
                      // 붙였는데("전 정류장에 붙이면 글자가 뒤엉킨다" — 2026-06-26 #5), 그때는 컬럼이 좁고
                      // 이름이 시각과 같은 줄 폭을 다퉜다. 지금은 컬럼을 넓히고(78→86) 줄을 분리했으며,
                      // 🔴 겹침을 픽셀로 재는 하네스(headless_check_home_strip.cjs)로 잠갔다.
                      // 🔴 **계획시각 우선**(2026-08-24 배시현). 예전엔 estimatedAt 을 먼저 썼는데,
                      //    ① 출발지는 차가 미리 와 있으면 그 도착시각(05:55)이 뜨고
                      //    ② 이후 정류장은 '지금+30초'로 눌린 값이 떠서 화면을 새로고침할 때마다
                      //       현재시각으로 바뀌었다("첫로그인시 정상시간, 내렸다 올리면 바뀜").
                      //    이 줄은 노선표 역할이라 **정해진 시각**이 맞다 — 실시간 예상은 내 정류장
                      //    카드와 노선 탭 정류장 목록이 맡는다. offsetMin 미설정 정류장만 폴백.
                      const timeLabel = est && (est.plannedAt || est.estimatedAt);

                      const nameColor = isMyStop ? 'var(--color-primary)'
                        : isFirst ? 'var(--color-positive)'
                        : isLast ? 'var(--color-destructive)'
                        : isReached ? 'var(--color-label)' : 'var(--color-label-mute)';

                      return (
                        <div key={s.id} style={{ display: 'flex', alignItems: 'center' }}>
                          {/* 자동 스크롤 기준점 = 버스 위치(운행 중) → 없으면 내 정류장 */}
                          <div ref={(inService ? isBusHere : isMyStop) ? stripFocusRef : undefined}
                            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 86, cursor: 'pointer' }}
                            onClick={() => {
                              // #3(2026-06-26) — 터치한 정류장을 지도 중앙으로. 자동 재센터 억제.
                              userCenteredRef.current = true;
                              setCenter({ lat: s.lat, lng: s.lng });
                              // 같은 정류장을 다시 누르면 해제(토글), 아니면 선택. 둘 다 fcmTokens 영속.
                              if (isMyStop) { selectMyStop(null); }
                              else { selectMyStop(i); }
                            }}>
                            {/* 역할 라벨 — 없으면 자리만 차지(노드 높이 정렬 유지) */}
                            <div style={{ height: 14, fontSize: 11, fontWeight: 800, lineHeight: '14px', whiteSpace: 'nowrap', color: isBusHere ? 'var(--color-primary)' : 'var(--color-label-mute)' }}>
                              {role}
                            </div>
                            {/* 버스 아이콘 (이 정류장 근처) */}
                            <div style={{ height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 2 }}>
                              {isBusHere && (
                                /* 버스(깜빡) 마커만 살짝 위로(-4px). 🔴 여기 transform 은 애니메이션 대상이
                                   아니므로 안전하다(요약바 링에서 났던 문제와 다름 — 2026-08-04 참조). */
                                <div style={{ position: 'relative', width: 24, height: 24, transform: 'translateY(-4px)' }}>
                                  <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'var(--color-primary)', opacity: 0.5, animation: 'buspulse 2s ease-out infinite', pointerEvents: 'none' }} />
                                  <div style={{ position: 'absolute', inset: 0, background: 'var(--color-primary)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', boxShadow: '0 0 0 4px rgba(0,102,255,.40), 0 4px 12px rgba(0,102,255,.45)' }}><Icon name="bus" size={15} stroke={2} /></div>
                                </div>
                              )}
                            </div>
                            {/* 정류장 원 */}
                            <div style={{
                              width: isMyStop ? 20 : isFirst || isLast ? 15 : 11,
                              height: isMyStop ? 20 : isFirst || isLast ? 15 : 11,
                              borderRadius: '50%', flexShrink: 0,
                              background: isMyStop ? 'var(--color-primary)' : isBusHere ? 'var(--color-primary)' : isFirst ? 'var(--color-positive)' : isLast ? 'var(--color-destructive)' : isReached ? 'var(--color-primary)' : 'var(--color-line)',
                              border: isMyStop ? '2px solid #fff' : '2px solid var(--color-bg)',
                              boxShadow: isMyStop ? '0 0 0 3px rgba(0,102,255,.30)' : 'var(--shadow-emphasize)'
                            }} />
                            {/* 정류장 이름 */}
                            <div style={{
                              // 🔴 한 줄 말줄임을 걷고 **2줄까지** 보여준다(2026-08-11 최우석
                              //    "한눈에 보기 어렵다"). prod 정류장 이름은 `구 서울행정법원 버스정류장
                              //    (서초…)` 처럼 길어 한 줄에선 거의 다 잘렸다. 2026-08-07 노선명을
                              //    2줄로 푼 것과 같은 처방이며, 글자 크기는 줄이지 않는다.
                              //    높이를 고정(2줄분)해 정류장마다 아래 줄이 어긋나지 않게 한다.
                              fontSize: 14, marginTop: 7, textAlign: 'center', width: 80,
                              color: nameColor,
                              fontWeight: isMyStop ? 900 : isFirst || isLast ? 800 : 700,
                              // `keep-all` 만 두면 띄어쓰기 없는 긴 이름(`채드윅국제학교(Chadwick)`)이
                              // 줄바꿈을 못 해 가로로 넘친다 → `overflowWrap:'anywhere'` 로 그때만 끊는다
                              // (낱말 경계 우선은 그대로 유지).
                              wordBreak: 'keep-all', overflowWrap: 'anywhere', lineHeight: 1.25, height: 35,
                              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden'
                            }}>
                              {s.name}
                            </div>
                            <div style={{ height: 15, fontSize: 11.5, lineHeight: '15px', color: 'var(--color-label-alt)', fontVariantNumeric: 'tabular-nums' }}>
                              {timeLabel || ''}
                            </div>
                            {/* 🔴 "내 정류장" 을 **모든 정류장 아래** 둔다(2026-08-11 목업). 예전엔 이미 고른
                                정류장에만 보여서 **지정할 수 있다는 것 자체가 안 보였다** — 푸시 토큰 8개 중
                                내 정류장 지정이 5명뿐이던 병목의 화면 쪽 원인이다. 선택된 곳은 진하게,
                                나머지는 흐리게 둬서 "여기를 누르면 내 정류장이 된다"가 읽히게 한다. */}
                            <div style={{
                              fontSize: 11, fontWeight: isMyStop ? 800 : 600, marginTop: 1,
                              color: isMyStop ? 'var(--color-primary)' : 'var(--color-label-alt)',
                              opacity: isMyStop ? 1 : 0.75,
                            }}>
                              내 정류장
                            </div>
                          </div>

                          {/* 연결선 (마지막 제외) — 정류장 원 높이에 맞춤.
                              🔴 -21 은 계산값이다: 예전(역할 라벨 없음) 정렬값이 -28 이었고,
                                 위에 14px 짜리 역할 라벨 줄이 생기면서 컬럼 중심이 7px 내려갔다
                                 (-28 + 14/2 = -21). 라벨 줄 높이를 바꾸면 이 값도 같이 바꿀 것. */}
                          {!isLast && (
                            <div style={{
                              width: 28, height: 3, flexShrink: 0, marginTop: -21,
                              background: inService && i < busStopIdx ? 'var(--color-primary)' : 'var(--color-line)',
                              borderRadius: 2, position: 'relative'
                            }}>
                              {/* 버스가 이 구간(i → i+1) 이동 중 — 점멸 방향 화살표(버스 2대 오인 방지, 2026-06-24) */}
                              {isBusHere && mainBus && (
                                <div style={{ position: 'absolute', top: -11, left: '50%', transform: 'translateX(-50%)', fontSize: 18, fontWeight: 900, color: 'var(--color-primary)', lineHeight: 1, animation: 'busblink 1s ease-in-out infinite', pointerEvents: 'none' }}>›</div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* 상태줄 — 요약바에 있던 것을 그대로 스트립 아래로 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 16px 0' }}>
                  {inService && nextStop ? (
                    <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 700, color: 'var(--color-label)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {nextStop.name}(으)로 이동 중{etaText ? <> · <span style={{ color: 'var(--color-primary)', fontWeight: 800 }}>{nextStop.name}까지 {etaText}</span></> : null}
                    </div>
                  ) : (
                    <div style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: 'var(--color-label-mute)' }}>
                      {/* 시간창 때문에 가린 것이면 그 이유를 화면에 드러낸다 —
                          안 그러면 "왜 버스가 안 보이지"가 문의로 돌아온다. */}
                      {!windowOpen && routeWindow
                        ? `${describeRouteWindow(routeWindow)} 에 운행 정보가 표시됩니다`
                        /* 🔴 버스는 뜨는데 아직 노선 정류장 근처가 아닌 상태(차고지→첫 정류장 이동 중).
                           예전엔 이 경우에도 최근접 정류장을 '현재'로 찍어 앞 정류장이 지나침으로
                           보였다(2026-08-06). 이제는 지나쳤다고 하지 않고 상태를 그대로 알린다. */
                        : mainBus
                          ? '첫 정류장으로 이동 중입니다'
                          : myStopIdx === null ? '정류장을 눌러 내 탑승 정류장을 정하세요' : '운행 중인 버스가 없습니다'}
                    </div>
                  )}
                  {/* 노선 진입 전에도 "지금 어디 있나"는 봐야 한다 — mainBus 만 있으면 노출 */}
                  {mainBus && (
                    <button onClick={() => { userCenteredRef.current = true; setCenter({ lat: mainBus.lat, lng: mainBus.lng }); }}
                      style={{ flexShrink: 0, background: 'var(--color-primary)', border: 'none', borderRadius: 'var(--radius-8)', padding: '6px 12px', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', boxShadow: 'var(--shadow-strong)' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="bus" size={13} stroke={2} /> 차량 위치 보기</span>
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        );
      })()}

      {/* ── 하단 ETA + QR 패널 ── */}
      <div style={{ background: 'var(--color-bg)', flexShrink: 0, padding: '12px 14px', borderTop: '1px solid var(--color-line)' }}>
        {myStop ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, color: 'var(--color-label-mute)', marginBottom: 2, fontWeight: 600 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="pin" size={13} stroke={2} /> {myStop.name}</span>
              </div>
              {runEnded ? (
                /* 운행 종료(2026-07-16) — "이미 지나침"/지연 잔존 대신 중립 회색 표기.
                   카드의 다른 요소(QR 탑승·정류장 변경 버튼)는 보존. */
                <>
                  <div style={{ fontSize: 24, fontWeight: 900, color: 'var(--color-label-mute)', lineHeight: 1.1 }}>
                    운행 종료
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--color-label-alt)', marginTop: 3, fontWeight: 600 }}>
                    오늘 운행이 종료되었습니다
                  </div>
                </>
              ) : (
              <>
              <div style={{ fontSize: 24, fontWeight: 900, color: etaDisplayColor, lineHeight: 1.1 }}>
                {etaStatus.type === 'passed'
                  ? (isDestStop ? '목적지 도착 완료' : '이미 지나침')
                  : etaStatus.type === 'arriving'
                    ? (isDestStop ? '목적지 도착' : '곧 도착!')
                    : etaStatus.type === 'approaching' && passengerLabel
                      ? (isDestStop
                          ? (passengerLabel.bucket === 'soon' ? '목적지 도착' : `목적지까지 ${passengerLabel.primary}`)
                          : passengerLabel.primary)
                      : '버스 대기 중'}
              </div>
              {/* 보조 작은 글씨 — 도착 예상 시각(HH:MM) + 데이터 소스 */}
              {etaStatus.type === 'approaching' && passengerLabel && passengerLabel.precise && passengerLabel.bucket !== 'time' && (
                <div style={{ fontSize: 11, color: 'var(--color-label-mute)', marginTop: 2, fontWeight: 600 }}>
                  {passengerLabel.precise} 예상
                  {myStopEst && (() => {
                    const src = describeEtaSource(myStopEst.source);
                    return src ? <> · <span style={{ color: 'var(--color-label-alt)' }}>{src}</span></> : null;
                  })()}
                </div>
              )}
              {/* 부가 정보 */}
              {etaStatus.type === 'passed' && !isDestStop && (
                <div style={{ fontSize: 11, color: 'var(--color-cautionary)', marginTop: 3, fontWeight: 600 }}>
                  다음 버스를 기다려주세요
                </div>
              )}
              {etaStatus.type === 'arriving' && (
                <div style={{ fontSize: 11, color: 'var(--color-destructive)', marginTop: 3, fontWeight: 700 }}>
                  {isDestStop ? '하차해 주세요' : '탑승 준비하세요!'}
                </div>
              )}
              {etaStatus.type === 'approaching' && isDestStop && (
                <div style={{ fontSize: 11, color: 'var(--color-label-mute)', marginTop: 3, fontWeight: 600 }}>
                  목적지로 이동 중
                </div>
              )}
              {mainBus && etaStatus.type === 'approaching' && (
                <div style={{ fontSize: 10, color: 'var(--color-label-mute)', marginTop: 2 }}>
                  {mainBus.vehicleNo} · {mainBus.speed ?? 0} km/h
                </div>
              )}
              {/* 계획 진입시각 · 예상 · 지연(있을 때만, 폴백/미설정이면 미노출) */}
              {myStopEst && myStopEst.plannedAt && (
                <div style={{ fontSize: 10, color: 'var(--color-label-mute)', marginTop: 3, fontWeight: 600 }}>
                  계획 {myStopEst.plannedAt}
                  {myStopEst.estimatedAt && myStopEst.estimatedAt !== myStopEst.plannedAt && (
                    <> · 예상 <span style={{ color: 'var(--color-primary-deep)', fontWeight: 700 }}>{myStopEst.estimatedAt}</span></>
                  )}
                  {(() => {
                    const lab = formatDelayLabel(myStopEst.delaySec);
                    if (!lab.label || lab.tone === 'mute') return null;
                    const color = lab.tone === 'danger' ? 'var(--color-destructive)'
                      : lab.tone === 'warn' ? 'var(--color-cautionary)'
                      : 'var(--color-positive)';
                    return <> · <span style={{ color, fontWeight: 700 }}>{lab.label}</span></>;
                  })()}
                </div>
              )}
              </>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, flexShrink: 0 }}>
              <button onClick={onScanTab}
                style={{ background: 'var(--color-primary)', border: 'none', borderRadius: 'var(--radius-12)', padding: '10px 16px', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', boxShadow: 'var(--shadow-strong)' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}><Icon name="qr" size={14} stroke={2} /> QR 탑승</span>
              </button>
              <button onClick={() => setMyStopIdx(null)}
                style={{ background: 'var(--color-bg-soft)', border: '1px solid var(--color-line)', borderRadius: 'var(--radius-8)', padding: '5px 10px', color: 'var(--color-label-mute)', fontSize: 10, cursor: 'pointer', fontFamily: 'inherit' }}>
                정류장 변경
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1, fontSize: 12, color: 'var(--color-label-mute)' }}>
              {buses.length === 0 ? '현재 운행중인 버스가 없습니다' : '노선도에서 내 탑승 정류장을 클릭하세요'}
            </div>
            <button onClick={onScanTab}
              style={{ background: 'var(--color-primary)', border: 'none', borderRadius: 'var(--radius-12)', padding: '10px 16px', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', flexShrink: 0, boxShadow: 'var(--shadow-strong)' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}><Icon name="qr" size={14} stroke={2} /> QR 탑승</span>
            </button>
          </div>
        )}
      </div>
      </div>{/* /스크롤 컨테이너 (#3) — fixed 오버레이(모달/카드)는 이 아래 형제로 유지 */}

      {/* ── 노선 변경 모달 — 선택 시 chooseRoute로 기준 노선 갱신·영속·재바인딩 ── */}
      {routePicker && (
        <div onClick={() => setRoutePicker(false)}
          style={{ position: 'fixed', inset: 0, background: 'var(--color-overlay)', zIndex: 200, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: 'var(--color-bg)', borderRadius: '20px 20px 0 0', width: '100%', maxHeight: '82dvh', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-heavy)' }}>
            <div style={{ padding: '14px 16px 12px', borderBottom: '1px solid var(--color-line)', flexShrink: 0 }}>
              <div style={{ width: 36, height: 4, background: 'var(--color-line)', borderRadius: 2, margin: '0 auto 12px' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 15, fontWeight: 800, color: 'var(--color-label)' }}>노선 변경</span>
                <button onClick={() => setRoutePicker(false)}
                  style={{ background: 'var(--color-bg-soft)', border: '1px solid var(--color-line)', borderRadius: 'var(--radius-8)', padding: '6px 12px', color: 'var(--color-label-mute)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12 }}>
                  ✕
                </button>
              </div>
              {allRoutes.filter(r => !myPartner || (r.partnerCode || null) === myPartner).length > 6 && (
                <input style={{ ...S.input, marginTop: 10 }} placeholder="노선명·구분·코드 검색"
                  value={routeQuery} onChange={e => setRouteQuery(e.target.value)} />
              )}
            </div>
            <div style={{ overflowY: 'auto', padding: '12px 16px 24px', flex: 1 }}>
              {filteredAllRoutes.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 30, color: 'var(--color-label-alt)', fontSize: 13 }}>
                  {routeQuery.trim() ? '검색 결과가 없습니다' : '등록된 노선이 없습니다'}
                </div>
              ) : filteredAllRoutes.map(r => {
                const isCur = activeRouteId === r.id;
                return (
                  <div key={r.id} onClick={() => chooseRoute(r.id)}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', marginBottom: 8, borderRadius: 'var(--radius-12)', cursor: 'pointer',
                      border: `1px solid ${isCur ? 'var(--color-primary)' : 'var(--color-line)'}`,
                      background: isCur ? 'var(--color-primary-soft)' : 'var(--color-bg)' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 10, padding: '3px 9px', borderRadius: 'var(--radius-pill)', fontWeight: 600,
                          background: r.type === '출근' ? 'var(--color-primary-soft)' : 'var(--color-atomic-orange-90)',
                          color: r.type === '출근' ? 'var(--color-primary-deep)' : '#B95300' }}>
                          {r.type || '노선'}
                        </span>
                        {/* 노선을 고르는 화면이라 이름이 잘리면 안 된다(2026-08-07) */}
                        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-label)', whiteSpace: 'normal', wordBreak: 'keep-all', lineHeight: 1.35 }}>{r.name || r.id}</span>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--color-label-mute)', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {r.departTime && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="clock" size={11} stroke={2} />{r.departTime}</span>}
                        {r.partnerName && <span>· {r.partnerName}</span>}
                        {r.shift && <span>· {r.shift}</span>}
                      </div>
                    </div>
                    {isCur && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-primary-deep)', background: 'var(--color-bg)', border: '1px solid var(--color-primary)', borderRadius: 'var(--radius-pill)', padding: '3px 9px', flexShrink: 0 }}>현재</span>}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ── 지도 정류장 클릭 정보 카드 ── */}
      {stopInfo && (
        <div onClick={() => setStopInfo(null)}
          style={{ position: 'fixed', inset: 0, background: 'var(--color-overlay)', zIndex: 200, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: 'var(--color-bg)', borderRadius: '20px 20px 0 0', width: '100%', maxHeight: '80dvh', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-heavy)' }}>
            <div style={{ padding: '14px 16px 12px', borderBottom: '1px solid var(--color-line)', flexShrink: 0 }}>
              <div style={{ width: 36, height: 4, background: 'var(--color-line)', borderRadius: 2, margin: '0 auto 12px' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: 'var(--color-label-mute)', fontWeight: 600, marginBottom: 2 }}>
                    {stopInfo.idx === 0 ? '출발 정류장' : stopInfo.idx === stops.length - 1 ? '도착 정류장' : `정류장 ${stopInfo.idx + 1}`}
                  </div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--color-label)' }}>{stopInfo.name}</div>
                </div>
                <button onClick={() => setStopInfo(null)}
                  style={{ background: 'var(--color-bg-soft)', border: '1px solid var(--color-line)', borderRadius: 'var(--radius-8)', padding: '6px 12px', color: 'var(--color-label-mute)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, flexShrink: 0 }}>
                  ✕
                </button>
              </div>
            </div>
            <div style={{ overflowY: 'auto', padding: '14px 16px 20px', flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {stopInfo.address && <div style={{ fontSize: 12, color: 'var(--color-label-mute)' }}>{stopInfo.address}</div>}
              {/* ── 카카오 거리뷰(로드뷰) 프로토타입 — 좌표만으로 실사 표시(사진 미등록 대비) ── */}
              {/* 좌표 유효 && 반경 내 파노라마 있음(rvOk)일 때만. 없으면 아래 사진/설명 폴백. */}
              {(() => {
                const rvLat = Number(stopInfo.lat);
                const rvLng = Number(stopInfo.lng);
                if (!Number.isFinite(rvLat) || !Number.isFinite(rvLng) || !rvOk) return null;
                return (
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--color-label-mute)', fontWeight: 600, marginBottom: 6 }}><Icon name="eye" size={12} stroke={2} /> 거리뷰</div>
                    <div style={{ height: 200, width: '100%', borderRadius: 'var(--radius-12)', overflow: 'hidden', border: '1px solid var(--color-line)' }}>
                      <Roadview
                        position={{ lat: rvLat, lng: rvLng, radius: 60 }}
                        onErrorGetNearestPanoId={() => setRvOk(false)}
                        onCreate={rv => { try { rv.relayout(); } catch (e) { /* 바텀시트 애니메이션 중 0px init 방어 */ } }}
                        style={{ width: '100%', height: '100%' }}
                      />
                    </div>
                  </div>
                );
              })()}
              {stopInfo.photo && (
                <img src={stopInfo.photo} alt={`${stopInfo.name} 정류장`}
                  onClick={() => setStopInfo(null)}
                  style={{ width: '100%', maxHeight: 200, objectFit: 'cover', borderRadius: 'var(--radius-12)', border: '1px solid var(--color-line)', cursor: 'pointer', display: 'block' }} />
              )}
              {stopInfo.description && (
                <div style={{ fontSize: 13, color: 'var(--color-label)', lineHeight: 1.55, wordBreak: 'keep-all', background: 'var(--color-bg-soft)', borderRadius: 'var(--radius-8)', padding: '10px 12px' }}>
                  {stopInfo.description}
                </div>
              )}
              {!stopInfo.photo && !stopInfo.description && !stopInfo.address && (
                <div style={{ fontSize: 12, color: 'var(--color-label-alt)' }}>추가 정보가 없습니다</div>
              )}
              <button onClick={() => { selectMyStop(stopInfo.idx); setCenter({ lat: stopInfo.lat, lng: stopInfo.lng }); setStopInfo(null); }}
                style={{ ...S.btn, marginTop: 4 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}><Icon name="pin" size={14} stroke={2} /> 이 정류장을 내 정류장으로 설정</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 도착 임박 모달(2026-05-28) — 내 정류장 직전 정류장 도착 시 풀스크린 안내 ── */}
      {proximityModal && (
        <div onClick={closeProximityModal}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(11,16,32,0.78)',
            zIndex: 300, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', padding: 24,
            backdropFilter: 'blur(4px)',
          }}>
          <div onClick={e => e.stopPropagation()}
            style={{
              background: 'var(--color-bg)', borderRadius: 'var(--radius-24)',
              padding: '32px 24px 24px', width: '100%', maxWidth: 360,
              boxShadow: 'var(--shadow-heavy)', textAlign: 'center',
            }}>
            <div style={{ marginBottom: 12, color: 'var(--color-line-strong, #C7CDD8)', display: 'flex', justifyContent: 'center' }}>
              <Icon name="bus" size={46} stroke={1.4} />
            </div>
            <div style={{ fontSize: 22, fontWeight: 900, color: 'var(--color-primary)', marginBottom: 8 }}>
              곧 도착합니다
            </div>
            <div style={{ fontSize: 15, color: 'var(--color-label)', lineHeight: 1.55, marginBottom: 20 }}>
              <span style={{ fontWeight: 800 }}>{proximityModal.stopName}</span>에 버스가 도착했어요.<br/>
              다음이 <span style={{ fontWeight: 800, color: 'var(--color-primary-deep)' }}>내 정류장</span>입니다.<br/>
              <span style={{ fontSize: 13, color: 'var(--color-label-mute)' }}>탑승 준비를 해주세요</span>
            </div>
            <button onClick={closeProximityModal}
              style={{
                width: '100%', background: 'var(--color-primary)', color: '#fff',
                border: 'none', borderRadius: 'var(--radius-12)', padding: '14px 16px',
                fontSize: 15, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit',
                boxShadow: 'var(--shadow-strong)',
              }}>
              확인
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RoutesTab({ companyId, session, onSessionUpdate }) {
  const [routes, setRoutes] = useState([]);
  const [gpsData, setGpsData] = useState({});
  const [filter, setFilter] = useState("전체");
  const [search, setSearch] = useState("");
  // 목록 보기 방식(2026-08-10) — 카드 ↔ 시간표. 회차가 많은 거래처(판교역 18회차,
  // 채드윅 구역별 29개)는 카드로 훑으면 "몇 시 차가 있나"가 안 읽힌다.
  // 데이터는 그대로 쓰고 정렬·밀도만 바꾼다(신규 구독 0).
  const [listMode, setListMode] = useState("cards");
  const [stopModal, setStopModal] = useState(null);     // 정류장+지도 바텀시트
  const [modalStops, setModalStops] = useState([]);
  const [modalBuses, setModalBuses] = useState([]);      // 해당 노선 실시간 버스
  const [modalView, setModalView] = useState("list"); // 바텀시트 보기: list | map | rv(거리뷰)
  const [rvOpenStopId, setRvOpenStopId] = useState(null); // 거리뷰 아코디언: 펼친 정류장(한 번에 하나)
  const [rvErrStopId, setRvErrStopId] = useState(null);   // 펼친 정류장에 파노라마 없을 때 그 id
  const [modalCenter, setModalCenter] = useState({ lat: 37.3894, lng: 126.9522 });
  const [loadingStops, setLoadingStops] = useState(false);
  const [photoView, setPhotoView] = useState(null); // 정류장 사진 라이트박스
  const favorites = session.favorites || [];

  // 백그라운드 복귀 시 onSnapshot 재구독 — 같은 routeId 모달을 열어둔 채 다른 탭/앱 다녀와도
  // 새 GPS·도착시각이 즉시 신선화되도록.
  const wakeTick = useWakeTick();

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
  }, [companyId, wakeTick]);

  // 정류장 모달 열릴 때 로드
  useEffect(() => {
    if (!stopModal || !companyId) return;
    setLoadingStops(true); setModalStops([]);
    setRvOpenStopId(null); setRvErrStopId(null); // 노선 바뀌면 거리뷰 아코디언 초기화
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
  }, [stopModal, companyId, wakeTick]);

  // 선택 노선 오늘 도착 기록 — 모달 정류장 목록 계획·예상 시간 표시용.
  // 홈 탭과 같은 이유로 서버 위임(위 주석 참조) — `dispatches` 직접 읽기는 익명에 닫혀 있다.
  const { todayDispatch: modalDispatch } = useOneRouteStopArrivals({
    companyId,
    routeId: stopModal ? stopModal.id : null,
    active: modalBuses.length > 0,
    tick: wakeTick,
  });

  // 모달 지도에 그릴 경로 — 관리자가 그린 routePath 가 있으면 그것, 없으면 정류장 직선.
  // (routePath 미설정 노선은 예전처럼 직선으로 보이는 게 맞다 = 하위호환 폴백)
  const modalPath = useMemo(() => {
    const drawn = toLatLngPath(stopModal?.routePath);
    if (drawn.length >= 2) return drawn;
    return modalStops
      .map(s => ({ lat: Number(s.lat), lng: Number(s.lng) }))
      .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  }, [stopModal, modalStops]);

  // 모달 정류장 estimates(계획 + 누적지연). 모달엔 routePath/속도 모르므로 GPS 가중은 생략.
  const modalEstimates = (stopModal && modalStops.length > 0)
    ? computeStopEstimates({
        stops: modalStops,
        departTime: stopModal.departTime,
        actualArrivals: modalDispatch?.stopArrivals || {},
        vehiclePos: null, speed: null, routePath: null,
      })
    : [];
  const modalEstByStopId = Object.fromEntries(modalEstimates.map(e => [e.stopId, e]));

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

  // 거래처 데이터 격리(2026-07-09 #1) — 직원 본인 거래처(session.partnerCode) 노선만 노출.
  //   회의 결정 "자기 거래처만 보이게"(드롭다운 필터 불필요). partnerCode 미설정 직원은
  //   전체 노출(하위호환) — 노선 변경 모달 filteredAllRoutes(2026-06-17)와 동일 규칙.
  const myPartner = session.partnerCode || null;

  // 필터 칩 — 노선 구분(type)은 관리자가 "출근/퇴근/셔틀" 중 고른다(2026-06-22 셔틀 추가).
  // 승객앱 칩에는 셔틀이 빠져 있어 셔틀 노선을 따로 골라볼 수 없었다(2026-08-05 회의 #7).
  // 🔴 셔틀 칩은 실제로 셔틀 노선이 있을 때만 노출 — 항상 띄우면 249명에게 "눌러도 0건"인
  //    칩이 상시로 보인다. 관리자가 노선 구분을 셔틀로 지정하면 자동으로 나타난다.
  const partnerScoped = routes.filter(r => !myPartner || (r.partnerCode || null) === myPartner);
  const hasShuttle = partnerScoped.some(r => r.type === "셔틀");
  const FILTER_CHIPS = ["전체", "즐겨찾기", "운행중", "출근", "퇴근", ...(hasShuttle || filter === "셔틀" ? ["셔틀"] : [])];

  const filtered = routes.filter(r => {
    if (myPartner && (r.partnerCode || null) !== myPartner) return false;
    if (filter === "즐겨찾기" && !favorites.includes(r.id)) return false;
    if (filter === "운행중" && !gpsData[r.id]) return false;
    if (filter !== "전체" && filter !== "즐겨찾기" && filter !== "운행중" && r.type !== filter) return false;
    if (search && !r.name.includes(search) && !r.code?.includes(search)) return false;
    return true;
  }).sort(compareRoutes); // 관리자가 노선 관리에서 정한 표시 순서(2026-07-10)

  // ── 시간표 보기용 그룹(2026-08-10) ────────────────────────────
  // 같은 `filtered` 를 쓰되 출발시각 순으로만 다시 세운다 — 거래처 격리·검색·칩이
  // 그대로 반영된다(카드 보기와 보이는 모수가 어긋나면 안 된다).
  // 출발시각이 없는 노선은 맨 뒤 "시각 미정"으로 — 빼 버리면 카드에는 있는데
  // 시간표에는 없는 노선이 생긴다.
  const timeGroups = (() => {
    if (listMode !== "time") return [];
    const order = ["출근", "퇴근", "셔틀"];
    // 🔴 이 파일은 `import { Map } from "react-kakao-maps-sdk"` 로 **내장 Map 이 가려져 있다**.
    //    `new Map()` 을 쓰면 런타임에 "Map is not a constructor" 로 화면이 통째로 죽는다
    //    (빌드는 통과하고 헤드리스 실로드에서만 잡혔다). 평범한 객체를 쓴다.
    const buckets = {};
    filtered.forEach(r => {
      const key = order.includes(r.type) ? r.type : (r.type || "기타");
      (buckets[key] = buckets[key] || []).push(r);
    });
    const keys = Object.keys(buckets).sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
    return keys.map(k => ({
      type: k,
      rows: buckets[k].slice().sort((a, b) => {
        const ta = a.departTime || "", tb = b.departTime || "";
        if (!ta && !tb) return compareRoutes(a, b);
        if (!ta) return 1;          // 시각 없는 노선은 맨 뒤
        if (!tb) return -1;
        return ta.localeCompare(tb) || compareRoutes(a, b);
      }),
    }));
  })();

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden", background: "var(--color-bg-alt)" }}>
      <div style={{ background: "var(--color-bg)", padding: "14px 16px", borderBottom: "1px solid var(--color-line)" }}>
        <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 10, color: "var(--color-label)", letterSpacing: "-0.02em" }}>노선 목록</div>
        {/* 선택된 거래처 안내(#1 데이터 격리) — 자기 거래처 노선만 노출됨을 명시. 미설정 직원은 미표시(전체). */}
        {myPartner && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, padding: "9px 12px", borderRadius: "var(--radius-8)", background: "var(--color-primary-soft)", border: "1px solid var(--color-primary)" }}>
            <span style={{ display: 'inline-flex', color: 'var(--color-primary-deep)' }}><Icon name="building" size={16} /></span>
            <div style={{ flex: 1, minWidth: 0 }}>
              {/* 2026-08-07 배시현 개선요청 — 학교 고객에게 "거래처"가 어색하다.
                  관리자·협력사 포탈은 이미 "협력사"라 표기가 오히려 맞춰진다. */}
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--color-primary-deep)" }}>선택된 협력사: {session.partnerName || myPartner}</div>
              <div style={{ fontSize: 10, color: "var(--color-primary-deep)", opacity: 0.75 }}>해당 협력사 노선만 표시됩니다</div>
            </div>
          </div>
        )}
        <input style={{ ...S.input, marginBottom: 10 }} placeholder="노선명·코드 검색"
          value={search} onChange={e => setSearch(e.target.value)} />
        <div style={{ display: "flex", gap: 6, overflowX: "auto" }}>
          {FILTER_CHIPS.map(f => (
            <button key={f} onClick={() => setFilter(f)}
              style={{ flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 5, height: 30, padding: "0 13px", borderRadius: "var(--radius-pill)", border: `1px solid ${filter === f ? "var(--color-primary)" : "var(--color-line)"}`, cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 600,
                background: filter === f ? "var(--color-primary)" : "var(--color-bg-soft)",
                color: filter === f ? "#fff" : "var(--color-label-mute)" }}>
              {f === "즐겨찾기" && <Icon name="star" size={12} solid={filter === f} stroke={2} />}
              {f === "운행중" && <StatusDot tone="positive" size={7} />}
              {f}
              {f === "즐겨찾기" && favorites.length > 0 ? ` ${favorites.length}` : ""}
            </button>
          ))}
        </div>

        {/* 카드 ↔ 시간표 전환 (2026-08-10) */}
        <div style={{ display: "flex", gap: 6, marginTop: 10, background: "var(--color-bg-soft)", borderRadius: "var(--radius-8)", padding: 3 }}>
          {[["cards", "카드", "grid"], ["time", "시간표", "clock"]].map(([v, label, icon]) => (
            <button key={v} onClick={() => setListMode(v)}
              style={{ flex: 1, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5, padding: "7px 4px", border: "none", borderRadius: "var(--radius-6)", cursor: "pointer", fontFamily: "inherit", fontSize: 11.5, fontWeight: 600, whiteSpace: "nowrap",
                background: listMode === v ? "var(--color-primary)" : "transparent",
                color: listMode === v ? "#fff" : "var(--color-label-mute)" }}>
              <Icon name={icon} size={13} stroke={2} />{label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px" }}>
        {filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: 40, color: "var(--color-label-alt)", fontSize: 13, whiteSpace: "pre-line" }}>
            {filter === "즐겨찾기" ? "즐겨찾기한 노선이 없습니다\n노선 카드 오른쪽 별을 눌러 추가하세요" : "해당하는 노선이 없습니다"}
          </div>
        ) : listMode === "time" ? (
          /* ── 시간표 보기 (2026-08-10) — 출발 시각 순 한 줄씩 ── */
          timeGroups.map(g => (
            <div key={g.type} style={{ marginBottom: 18 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 7 }}>
                <span style={{ fontSize: 11, padding: "3px 10px", borderRadius: "var(--radius-pill)", fontWeight: 700,
                  background: g.type === "출근" ? "var(--color-primary-soft)" : "var(--color-atomic-orange-90)",
                  color: g.type === "출근" ? "var(--color-primary-deep)" : "#B95300" }}>
                  {g.type}
                </span>
                <span style={{ fontSize: 11, color: "var(--color-label-alt)" }}>{g.rows.length}개</span>
              </div>
              <div style={{ background: "var(--color-bg)", border: "1px solid var(--color-line)", borderRadius: "var(--radius-12)", overflow: "hidden" }}>
                {g.rows.map((r, i) => (
                  <div key={r.id}
                    onClick={() => { setStopModal(r); setModalView("list"); }}
                    style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 13px", cursor: "pointer",
                      borderTop: i === 0 ? "none" : "1px solid var(--color-line)",
                      background: r.id === session.routeId ? "var(--color-primary-soft)" : "transparent" }}>
                    {/* 출발 시각 — 시간표에서 제일 먼저 읽혀야 하는 값이라 크게 */}
                    <div style={{ flexShrink: 0, width: 52, fontSize: 15, fontWeight: 800, fontVariantNumeric: "tabular-nums",
                      color: r.departTime ? (g.type === "출근" ? "var(--color-primary-deep)" : "#B95300") : "var(--color-label-alt)" }}>
                      {r.departTime || "–"}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--color-label)", wordBreak: "keep-all", lineHeight: 1.35 }}>
                        {r.name}
                      </div>
                      {gpsData[r.id] && (
                        <div style={{ fontSize: 10.5, color: "#007A29", fontWeight: 700, marginTop: 2 }}>
                          <StatusDot tone="positive" size={6} pulse /> {gpsData[r.id]}대 운행중
                        </div>
                      )}
                    </div>
                    {favorites.includes(r.id) && <span style={{ flexShrink: 0, display: "inline-flex", color: "var(--color-cautionary)" }}><Icon name="star" size={13} solid /></span>}
                    <span style={{ fontSize: 14, fontWeight: 800, color: "var(--color-label-alt)", flexShrink: 0 }}>›</span>
                  </div>
                ))}
              </div>
            </div>
          ))
        ) : filtered.map(r => (
          <div key={r.id} style={{ background: "var(--color-bg)", border: `1px solid ${favorites.includes(r.id) ? "var(--color-cautionary)" : "var(--color-line)"}`, borderRadius: "var(--radius-16)", padding: "14px 16px", marginBottom: 10, boxShadow: "var(--shadow-emphasize)" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                {/* 🔴 거래처 이름 칩을 뺐다(2026-08-10) — 이 화면은 이미 상단 배너에
                    "선택된 협력사: OOO" 를 띄우고 그 거래처 노선만 보여준다. 카드마다
                    같은 이름을 또 다는 건 중복이고, 칩이 늘어날수록 화면이 어수선해진다. */}
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 10.5, padding: "3px 9px", borderRadius: "var(--radius-pill)", background: r.type === "출근" ? "var(--color-primary-soft)" : "var(--color-atomic-orange-90)", color: r.type === "출근" ? "var(--color-primary-deep)" : "#B95300", fontWeight: 700 }}>
                    {r.type}
                  </span>
                  {r.shift && <span style={{ fontSize: 10.5, color: "var(--color-label-mute)" }}>{r.shift}</span>}
                  {r.code && <span style={{ fontSize: 10.5, color: "var(--color-label-alt)", fontFamily: "var(--font-mono)" }}>{r.code}</span>}
                  {gpsData[r.id] && (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10.5, padding: "3px 9px", borderRadius: "var(--radius-pill)", background: "#E6F7EB", color: "#007A29", fontWeight: 700 }}>
                      <StatusDot tone="positive" size={6} pulse /> {gpsData[r.id]}대 운행중
                    </span>
                  )}
                </div>
                {/* 노선명 전체 표시(2026-08-07 배시현 개선요청) — 외국인 학부모용 영문 병기로
                    이름이 길어져 한 줄 말줄임에 잘렸다. **글자 크기는 그대로 두고 줄바꿈**으로 푼다
                    (prod 실측 최대 44자 → 2줄에 들어간다. 더보기 탭이 없어도 다 보인다).
                    🔴 `wordBreak: keep-all` — 한국어를 낱말 중간에서 끊지 않는다. */}
                {/* 특이사항 꼬리표(`… - 조기출근`)를 진하게(2026-08-25 최우석 요청·캡처).
                    가르는 규칙과 그 근거는 `lib/routeKind.js splitRouteNameNote` 주석 참조 —
                    공백 있는 ` - ` 만 본다(공백 없는 `-` 로 가르면 `[H1-1]` 이 깨진다). */}
                <div style={{ fontSize: 14, fontWeight: 700, color: "var(--color-label)", marginBottom: 4, whiteSpace: "normal", wordBreak: "keep-all", lineHeight: 1.35 }}>
                  {(() => {
                    const { head, note } = splitRouteNameNote(r.name);
                    if (!note) return r.name;
                    return (<>
                      {head} - <span style={{ fontWeight: 900, color: "var(--color-primary-deep)" }}>{note}</span>
                    </>);
                  })()}
                </div>
                <div style={{ fontSize: 12, color: "var(--color-label-mute)" }}>
                  출발 {r.departTime} · 좌석 {r.seats || "–"}석
                </div>
              </div>
              {/* 즐겨찾기 버튼 */}
              <button onClick={() => toggleFavorite(r.id)} aria-label="즐겨찾기"
                style={{ background: "transparent", border: "none", cursor: "pointer", padding: 4, flexShrink: 0, display: "inline-flex",
                  color: favorites.includes(r.id) ? "var(--color-cautionary)" : "var(--color-line-strong, #C7CDD8)" }}>
                <Icon name="star" size={21} solid={favorites.includes(r.id)} stroke={1.9} />
              </button>
            </div>
            {/* 배정 노선 배지 + 정류장 보기 */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8 }}>
              {r.id === session.routeId ? (
                <div style={{ fontSize: 11, color: "var(--color-primary-deep)", background: "var(--color-primary-soft)", borderRadius: "var(--radius-6)", padding: "4px 10px", fontWeight: 600 }}>
                  ✓ 내 배정 노선
                </div>
              ) : <div />}
              <div style={{ display:"flex", gap:4 }}>
                {/* 두 버튼은 같은 높이·같은 모서리 — 예전엔 이모지 크기 때문에 서로 달라 보였다 */}
                <button onClick={(e) => { e.stopPropagation(); setStopModal(r); setModalView("list"); }}
                  style={{ display: "inline-flex", alignItems: "center", gap: 4, height: 28, fontSize: 11.5, fontWeight: 600, color: "var(--color-label-mute)", background: "var(--color-bg-soft)", border: "1px solid var(--color-line)", borderRadius: "var(--radius-8)", padding: "0 11px", cursor: "pointer", fontFamily: "inherit" }}>
                  <Icon name="pin" size={13} stroke={1.9} /> 정류장
                </button>
                <button onClick={(e) => { e.stopPropagation(); setStopModal(r); setModalView("map");
                    if (modalStops.length > 0) setModalCenter({ lat: modalStops[0].lat, lng: modalStops[0].lng });
                  }}
                  style={{ display: "inline-flex", alignItems: "center", gap: 4, height: 28, fontSize: 11.5, fontWeight: 600, color: gpsData[r.id] ? "#007A29" : "var(--color-label-mute)", background: gpsData[r.id] ? "#E6F7EB" : "var(--color-bg-soft)", border: gpsData[r.id] ? "1px solid rgba(0,191,64,.3)" : "1px solid var(--color-line)", borderRadius: "var(--radius-8)", padding: "0 11px", cursor: "pointer", fontFamily: "inherit" }}>
                  <Icon name="globe" size={13} stroke={1.9} /> {gpsData[r.id] ? `${gpsData[r.id]}대 운행중` : "지도"}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
      {/* ── 정류장 + 지도 통합 바텀시트 ── */}
      {stopModal && (
        <div style={{ position:"fixed", inset:0, background:"var(--color-overlay)", zIndex:200, display:"flex", flexDirection:"column", justifyContent:"flex-end" }}
          onClick={() => setStopModal(null)}>
          <div style={{ background:"var(--color-bg)", borderRadius:"20px 20px 0 0", width:"100%", maxHeight:"88dvh", display:"flex", flexDirection:"column", boxShadow:"var(--shadow-heavy)" }}
            onClick={e => e.stopPropagation()}>

            {/* 핸들 + 헤더 */}
            <div style={{ padding:"12px 16px 10px", borderBottom:"1px solid var(--color-line)", flexShrink:0 }}>
              <div style={{ width:36, height:4, background:"var(--color-line)", borderRadius:2, margin:"0 auto 10px" }} />
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:3, flexWrap:"wrap" }}>
                    <span style={{ fontSize:10, padding:"3px 9px", borderRadius:"var(--radius-pill)",
                      background: stopModal.type==="출근"?"var(--color-primary-soft)":"var(--color-atomic-orange-90)",
                      color: stopModal.type==="출근"?"var(--color-primary-deep)":"#B95300", fontWeight:600 }}>
                      {stopModal.type}
                    </span>
                    {stopModal.shift && <span style={{ fontSize:10, color:"var(--color-label-mute)" }}>{stopModal.shift}</span>}
                    {modalBuses.length > 0 && (
                      <span style={{ fontSize:10, padding:"3px 9px", borderRadius:"var(--radius-pill)", background:"#E6F7EB", color:"#007A29", fontWeight:600 }}>
                        <StatusDot tone="positive" size={6} pulse /> {modalBuses.length}대 운행중
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize:15, fontWeight:800, color:"var(--color-label)", whiteSpace:"normal", wordBreak:"keep-all", lineHeight:1.3 }}>{stopModal.name}</div>
                  <div style={{ fontSize:11, color:"var(--color-label-mute)" }}>출발 {stopModal.departTime}</div>
                </div>
                <button onClick={() => setStopModal(null)}
                  style={{ background:"var(--color-bg-soft)", border:"1px solid var(--color-line)", borderRadius:"var(--radius-8)", padding:"6px 12px", color:"var(--color-label-mute)", cursor:"pointer", fontFamily:"inherit", fontSize:12, flexShrink:0, marginLeft:8 }}>
                  닫기
                </button>
              </div>

              {/* 보기 모드 전환 탭 */}
              <div style={{ display:"flex", gap:6, marginTop:10, background:"var(--color-bg-soft)", borderRadius:"var(--radius-8)", padding:3 }}>
                {[["list","정류장 목록","pin"],["map","실시간 지도","globe"],["rv","거리뷰","eye"]].map(([v,label,icon])=>(
                  <button key={v} onClick={()=>setModalView(v)}
                    style={{ flex:1, display:"inline-flex", alignItems:"center", justifyContent:"center", gap:4, padding:"8px 4px", border:"none", borderRadius:"var(--radius-6)", cursor:"pointer", fontFamily:"inherit", fontSize:11, fontWeight:600, whiteSpace:"nowrap",
                      background: modalView===v ? "var(--color-primary)" : "transparent",
                      color: modalView===v ? "#fff" : "var(--color-label-mute)" }}>
                    <Icon name={icon} size={12} stroke={2} />{label}
                  </button>
                ))}
              </div>
            </div>

            {/* ── 정류장 목록 보기 ── */}
            {modalView === "list" && (
              <div style={{ overflowY:"auto", padding:"12px 16px 24px", flex:1 }}>
                {loadingStops ? (
                  <div style={{ textAlign:"center", padding:24, color:"var(--color-label-mute)", fontSize:13 }}>로딩 중...</div>
                ) : modalStops.length === 0 ? (
                  <div style={{ textAlign:"center", padding:24, color:"var(--color-label-alt)", fontSize:13 }}>등록된 정류장이 없습니다</div>
                ) : (
                  <div style={{ position:"relative" }}>
                    <div style={{ position:"absolute", left:13, top:14, bottom:14, width:2, background:"var(--color-line)", zIndex:0 }} />
                    {modalStops.map((s, i) => (
                      <div key={s.id} style={{ display:"flex", alignItems:"flex-start", gap:12, marginBottom:14, position:"relative", zIndex:1 }}>
                        <div style={{ width:26, height:26, borderRadius:"50%", flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center", fontSize:10, fontWeight:700,
                          background: i===0?"var(--color-positive)":i===modalStops.length-1?"var(--color-destructive)":"var(--color-primary)", color:"#fff", border:"3px solid var(--color-bg)" }}>
                          {i===0?"출":i===modalStops.length-1?"도":i+1}
                        </div>
                        <div style={{ flex:1, paddingTop:3, minWidth:0 }}>
                          <div style={{ fontSize:13, fontWeight: i===0||i===modalStops.length-1?700:600,
                            color: i===0?"#007A29":i===modalStops.length-1?"var(--color-destructive)":"var(--color-label)" }}>
                            {s.name}
                          </div>
                          {/* 계획·예상시각 — plannedAt 또는 chain-propagated estimatedAt 보유 정류장. */}
                          {(() => {
                            const e = modalEstByStopId[s.id];
                            if (!e || (!e.plannedAt && !e.estimatedAt)) return null;
                            const lab = formatDelayLabel(e.delaySec);
                            const labColor = lab.tone === 'danger' ? 'var(--color-destructive)'
                              : lab.tone === 'warn' ? 'var(--color-cautionary)'
                              : 'var(--color-positive)';
                            const arrived = e.status === 'arrived';
                            return (
                              <div style={{ fontSize:11, marginTop:2, fontWeight:600, color:"var(--color-label-mute)" }}>
                                {arrived ? "도착 " : e.plannedAt ? "계획 " : "예상 "}
                                <span style={{ color: arrived ? 'var(--color-positive)' : 'var(--color-primary-deep)', fontWeight:700 }}>{arrived ? e.estimatedAt : (e.plannedAt || e.estimatedAt)}</span>
                                {!arrived && e.plannedAt && e.estimatedAt && e.estimatedAt !== e.plannedAt && (
                                  <> · 예상 <span style={{ color: 'var(--color-primary-deep)', fontWeight:700 }}>{e.estimatedAt}</span></>
                                )}
                                {/* 🔴 조기도착(tone 'warn')은 이 탭에서 안 띄운다(2026-08-24 배시현).
                                    차가 정시 출발 전에 미리 와서 대기하는 건 정상 운행인데 '조기도착'
                                    으로 읽혀 탑승객이 버스를 놓친 줄 안다. 정류장 목록은 정보 전달용이라
                                    계획·예상 시각만 남긴다. 지연은 승객이 알아야 하므로 유지. */}
                                {lab.label && lab.tone !== 'mute' && lab.tone !== 'warn' && (
                                  <> · <span style={{ color: labColor, fontWeight:700 }}>{lab.label}</span></>
                                )}
                              </div>
                            );
                          })()}
                          {s.address && <div style={{ fontSize:11, color:"var(--color-label-mute)", marginTop:1 }}>{s.address}</div>}
                          {s.description && <div style={{ fontSize:11, color:"var(--color-label-mute)", marginTop:2, lineHeight:1.45, wordBreak:"keep-all" }}>{s.description}</div>}
                          {s.photo && (
                            <img src={s.photo} alt={`${s.name} 정류장`}
                              onClick={()=>setPhotoView({ src:s.photo, name:s.name, desc:s.description })}
                              style={{ marginTop:6, width:"100%", maxWidth:200, height:90, objectFit:"cover", borderRadius:"var(--radius-8)", border:"1px solid var(--color-line)", cursor:"pointer", display:"block" }}/>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── 실시간 지도 보기 ── */}
            {modalView === "map" && (
              <div style={{ flex:1, minHeight:300, position:"relative" }}>
                <Map center={modalCenter} style={{ width:"100%", height:"100%" }} level={9}
                  onCreate={map => { map.relayout(); setTimeout(() => map.relayout(), 300); }}
                  onCenterChanged={map => setModalCenter({ lat: map.getCenter().getLat(), lng: map.getCenter().getLng() })}>

                  {/* 노선 폴리라인 — 관리자가 그린 실제 경로(routePath) 우선, 없으면 정류장 직선 폴백.
                      이 화면만 routePath 를 안 보고 정류장을 곧장 이어 그려서 "실시간 지도에서
                      경로가 직선으로 나온다"는 신고가 나왔다(2026-07-27). 홈 탭·승객앱·협력사
                      포털은 이미 routePath 를 쓰고 있었다. ⚠ 직선 전용으로 되돌리지 말 것. */}
                  {modalPath.length >= 2 && (
                    <Polyline
                      path={modalPath}
                      strokeWeight={4} strokeColor="#0066FF" strokeOpacity={0.7} strokeStyle="solid"
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
                        <div style={{ background:"var(--color-positive)", color:"#fff", borderRadius:8, padding:"3px 9px", fontSize:10, fontWeight:700, whiteSpace:"nowrap", boxShadow:"var(--shadow-float)" }}>
                          출발 · {modalStops[0].name}
                        </div>
                      </CustomOverlayMap>
                      <CustomOverlayMap position={{ lat:modalStops[modalStops.length-1].lat, lng:modalStops[modalStops.length-1].lng }} yAnchor={2.8}>
                        <div style={{ background:"var(--color-destructive)", color:"#fff", borderRadius:8, padding:"3px 9px", fontSize:10, fontWeight:700, whiteSpace:"nowrap", boxShadow:"var(--shadow-float)" }}>
                          도착 · {modalStops[modalStops.length-1].name}
                        </div>
                      </CustomOverlayMap>
                    </>
                  )}

                  {/* 실시간 버스 마커 — #4 노선 라인 정렬(yAnchor 0.5) */}
                  {modalBuses.map(b => b.lat && b.lng && (
                    <CustomOverlayMap key={b.id} position={{ lat:b.lat, lng:b.lng }} yAnchor={0.5}>
                      {/* 2026-08-18 배시현 요청 "아이콘이 너무 크다" — 바텀시트 지도는 화면의 절반이라
                          예전 크기(테두리 2px·패딩 5/11·글자 11/10)면 지도를 덮었다. 정보는 그대로 두고
                          치수만 줄인다(차량이 2대 이상인 노선에서 번호가 유일한 구분자라 뺄 수 없다). */}
                      <div style={{ background:"var(--color-bg)", border:"1.5px solid var(--color-primary)", borderRadius:"var(--radius-pill)", padding:"2px 7px", display:"flex", alignItems:"center", gap:4, boxShadow:"var(--shadow-emphasize)" }}>
                        <span style={{ display:"inline-flex", color:"var(--color-primary)" }}><Icon name="bus" size={11} stroke={2} /></span>
                        <div style={{ lineHeight:1.2 }}>
                          <div style={{ fontSize:9.5, fontWeight:800, color:"var(--color-primary)" }}>{b.vehicleNo||b.vehicleId}</div>
                          <div style={{ fontSize:8.5, color:"var(--color-label-mute)" }}>{b.speed??0} km/h</div>
                        </div>
                      </div>
                    </CustomOverlayMap>
                  ))}
                </Map>

                {/* 버스 없을 때 안내 */}
                {modalBuses.length === 0 && (
                  <div style={{ position:"absolute", bottom:12, left:"50%", transform:"translateX(-50%)", background:"var(--color-bg)", border:"1px solid var(--color-line)", borderRadius:"var(--radius-pill)", padding:"7px 16px", fontSize:11, color:"var(--color-label-mute)", whiteSpace:"nowrap", boxShadow:"var(--shadow-float)" }}>
                    현재 운행 중인 버스가 없습니다
                  </div>
                )}
              </div>
            )}

            {/* ── 거리뷰 보기 (아코디언, 한 번에 하나 펼침, 2026-07-09 #2) ── */}
            {modalView === "rv" && (
              <div style={{ overflowY:"auto", padding:"12px 16px 24px", flex:1 }}>
                {loadingStops ? (
                  <div style={{ textAlign:"center", padding:24, color:"var(--color-label-mute)", fontSize:13 }}>로딩 중...</div>
                ) : modalStops.length === 0 ? (
                  <div style={{ textAlign:"center", padding:24, color:"var(--color-label-alt)", fontSize:13 }}>등록된 정류장이 없습니다</div>
                ) : (
                  modalStops.map((s, i) => {
                    const open = rvOpenStopId === s.id;
                    const rvLat = Number(s.lat), rvLng = Number(s.lng);
                    const coordOk = Number.isFinite(rvLat) && Number.isFinite(rvLng);
                    return (
                      <div key={s.id} style={{ border:"1px solid var(--color-line)", borderRadius:"var(--radius-12)", marginBottom:8, overflow:"hidden", background:"var(--color-bg)" }}>
                        <div onClick={() => { if (open) { setRvOpenStopId(null); } else { setRvOpenStopId(s.id); setRvErrStopId(null); } }}
                          style={{ display:"flex", alignItems:"center", gap:10, padding:"11px 12px", cursor:"pointer" }}>
                          <div style={{ width:26, height:26, borderRadius:"50%", flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center", fontSize:10, fontWeight:700,
                            background: i===0?"var(--color-positive)":i===modalStops.length-1?"var(--color-destructive)":"var(--color-primary)", color:"#fff", border:"3px solid var(--color-bg)" }}>
                            {i===0?"출":i===modalStops.length-1?"도":i+1}
                          </div>
                          <div style={{ flex:1, minWidth:0, fontSize:13, fontWeight: i===0||i===modalStops.length-1?700:600,
                            color: i===0?"#007A29":i===modalStops.length-1?"var(--color-destructive)":"var(--color-label)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                            {s.name}
                          </div>
                          <span style={{ fontSize:15, fontWeight:800, color:"var(--color-label-mute)", flexShrink:0, transform: open?"rotate(90deg)":"none", transition:"transform .15s" }}>›</span>
                        </div>
                        {open && (
                          <div style={{ padding:"0 12px 12px" }}>
                            {coordOk && rvErrStopId !== s.id ? (
                              <>
                                <div style={{ height:200, width:"100%", borderRadius:"var(--radius-8)", overflow:"hidden", border:"1px solid var(--color-line)" }}>
                                  <Roadview
                                    position={{ lat:rvLat, lng:rvLng, radius:60 }}
                                    onErrorGetNearestPanoId={() => setRvErrStopId(s.id)}
                                    onCreate={rv => { try { rv.relayout(); } catch (e) { /* 바텀시트 애니메이션 중 0px init 방어 */ } }}
                                    style={{ width:"100%", height:"100%" }}
                                  />
                                </div>
                                <button onClick={() => window.open("https://map.kakao.com/link/roadview/"+rvLat+","+rvLng, "_blank")}
                                  style={{ marginTop:8, width:"100%", padding:"9px", border:"1px solid var(--color-line)", borderRadius:"var(--radius-8)", background:"var(--color-bg-soft)", color:"var(--color-label)", fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:"inherit" }}>
                                  <span style={{ display:"inline-flex", alignItems:"center", justifyContent:"center", gap:6 }}><Icon name="globe" size={13} stroke={2} /> 카카오맵에서 열기</span>
                                </button>
                              </>
                            ) : (
                              <div>
                                <div style={{ fontSize:12, color:"var(--color-label-mute)", padding:"8px 0", textAlign:"center" }}>
                                  이 정류장은 거리뷰가 없습니다
                                </div>
                                {s.photo && (
                                  <img src={s.photo} alt={`${s.name} 정류장`}
                                    onClick={()=>setPhotoView({ src:s.photo, name:s.name, desc:s.description })}
                                    style={{ width:"100%", maxHeight:200, objectFit:"cover", borderRadius:"var(--radius-8)", border:"1px solid var(--color-line)", cursor:"pointer", display:"block" }}/>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 정류장 사진 라이트박스 — 위치 확인용 확대 보기 */}
      {photoView && (
        <div onClick={() => setPhotoView(null)}
          style={{ position:"fixed", inset:0, background:"rgba(11,16,32,0.82)", zIndex:300, display:"flex", alignItems:"center", justifyContent:"center", padding:18 }}>
          <div onClick={(e)=>e.stopPropagation()}
            style={{ background:"var(--color-bg)", borderRadius:"var(--radius-12)", overflow:"hidden", maxWidth:520, width:"100%", maxHeight:"88vh", display:"flex", flexDirection:"column" }}>
            <img src={photoView.src} alt={`${photoView.name} 정류장`} style={{ width:"100%", maxHeight:"60vh", objectFit:"contain", background:"#000" }}/>
            <div style={{ padding:"14px 16px" }}>
              <div style={{ fontWeight:800, fontSize:15 }}>{photoView.name}</div>
              {photoView.desc && <div style={{ fontSize:13, color:"var(--color-label-mute)", marginTop:4, lineHeight:1.5 }}>{photoView.desc}</div>}
            </div>
            <button onClick={()=>setPhotoView(null)}
              style={{ margin:"0 16px 16px", padding:"11px", border:"none", borderRadius:"var(--radius-8)", background:"var(--color-bg-soft)", color:"var(--color-label)", fontSize:14, fontWeight:700, cursor:"pointer", fontFamily:"inherit" }}>
              ✕ 닫기
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════
// 공지 탭 — 인앱 공지함 (작업A, 2026-05-22)
// ════════════════════════════════════════════════════════
// 푸시(OEM 절전으로 누락 가능)의 pull 폴백 — 도달 보장 통로.
// notices 구독·partnerCode 필터·안 읽음 계산은 부모(EmployeeApp)에서 수행, 여기선 표시만.
function NoticesTab({ notices, unreadCount }) {
  const fmtDate = (n) => {
    const ms = noticeCreatedMs(n);
    if (!ms) return "";
    const d = new Date(ms);
    return d.toLocaleString("ko-KR", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden", background: "var(--color-bg-alt)" }}>
      <div style={{ background: "var(--color-bg)", padding: "14px 16px", borderBottom: "1px solid var(--color-line)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: "var(--color-label)", letterSpacing: "-0.02em" }}>공지사항</div>
          {unreadCount > 0 && (
            <span style={{ background: "var(--color-destructive)", color: "#fff", fontSize: 11, fontWeight: 800, borderRadius: "var(--radius-pill)", padding: "2px 9px" }}>
              새 공지 {unreadCount}
            </span>
          )}
        </div>
        <div style={{ fontSize: 12, color: "var(--color-label-mute)", marginTop: 2 }}>
          버스 운행 관련 안내를 확인하세요
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px" }}>
        {notices.length === 0 ? (
          <div style={{ textAlign: "center", padding: 48, color: "var(--color-label-alt)", fontSize: 13, lineHeight: 1.7 }}>
            <div style={{ marginBottom: 10, color: "var(--color-line-strong, #C7CDD8)", display: "flex", justifyContent: "center" }}>
              <Icon name="bell" size={38} stroke={1.4} />
            </div>
            등록된 공지사항이 없습니다
          </div>
        ) : notices.map(n => {
          const emergency = n.type === "emergency";
          return (
            <div key={n.id} style={{
              background: "var(--color-bg)",
              border: `1px solid ${emergency ? "#F6C9C9" : "var(--color-line)"}`,
              borderLeft: `4px solid ${emergency ? "var(--color-destructive)" : "var(--color-primary)"}`,
              borderRadius: "var(--radius-12)", padding: "14px 16px", marginBottom: 10,
              boxShadow: "var(--shadow-emphasize)"
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
                <span style={{
                  fontSize: 10, fontWeight: 700, padding: "3px 9px", borderRadius: "var(--radius-pill)",
                  background: emergency ? "var(--color-atomic-red-90)" : "var(--color-primary-soft)",
                  color: emergency ? "#A81818" : "var(--color-primary-deep)"
                }}>
                  {emergency ? "긴급" : "공지"}
                </span>
                <span style={{ fontSize: 11, color: "var(--color-label-alt)", fontWeight: 600 }}>
                  {fmtDate(n)}
                </span>
              </div>
              <div style={{ fontSize: 15, fontWeight: 800, color: "var(--color-label)", marginBottom: 5, lineHeight: 1.4, wordBreak: "keep-all" }}>
                {n.title}
              </div>
              <div style={{ fontSize: 13, color: "var(--color-label-mute)", lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "keep-all" }}>
                {n.body}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════
// 탑승 탭 — QR 스캔
// ════════════════════════════════════════════════════════
// ─── ScanTab — 협력사 boardingMode 분기 래퍼 (2026-05-27) ─────
// partnerCode 미설정/null/'driver-qr' = 기존 카메라 스캔 UI (직원이 기사 QR 스캔)
// 'passenger-qr' = 본인 QR 발행 UI (기사가 직원 QR 스캔)
// 부모(EmployeeApp)에서 함수 호출부 변경 최소화 위해 같은 이름 유지·내부에서 분기.
function ScanTab({ companyId, session }) {
  const [boardingMode, setBoardingMode] = useState(null); // null=로딩중, 'driver-qr'|'passenger-qr'

  // mode 우선순위: routes.boardingMode > partnerCodes.boardingMode > 'driver-qr'.
  // 노선 단위 override가 우선 — 혼승 노선(여러 협력사 직원 공유) 대응.
  // session.routeId 또는 partnerCode 변경 시 재조회.
  useEffect(() => {
    let cancelled = false;
    const partnerCode = session?.partnerCode || null;
    const routeId = session?.routeId || null;
    if (!routeId && !partnerCode) {
      setBoardingMode("driver-qr"); // 둘 다 없으면 기본
      return;
    }
    (async () => {
      try {
        // (1) 노선 단위 override
        if (routeId && companyId) {
          const rSnap = await getDoc(doc(db, "companies", companyId, "routes", routeId));
          if (cancelled) return;
          if (rSnap.exists()) {
            const rm = rSnap.data().boardingMode;
            if (rm === "passenger-qr" || rm === "driver-qr") {
              setBoardingMode(rm);
              return;
            }
          }
        }
        // (2) 협력사 단위 fallback
        if (!partnerCode) { setBoardingMode("driver-qr"); return; }
        const snap = await getDoc(doc(db, "partnerCodes", partnerCode));
        if (cancelled) return;
        const mode = snap.exists() ? (snap.data().boardingMode || "driver-qr") : "driver-qr";
        setBoardingMode(mode === "passenger-qr" ? "passenger-qr" : "driver-qr");
      } catch (e) {
        if (!cancelled) {
          console.warn("[boardingMode 조회 실패]", e.message);
          setBoardingMode("driver-qr"); // 폴백 = 기본
        }
      }
    })();
    return () => { cancelled = true; };
  }, [session?.partnerCode, session?.routeId, companyId]);

  if (boardingMode === null) {
    return (
      <div style={{ display:"flex", flex:1, alignItems:"center", justifyContent:"center", background:"var(--color-bg-alt)" }}>
        <div style={S.spinner} />
      </div>
    );
  }

  if (boardingMode === "passenger-qr") {
    return <ScanTabPassengerQR companyId={companyId} session={session} />;
  }
  return <ScanTabDriverQR companyId={companyId} session={session} />;
}

// ─── 본인 QR 발행 UI (passenger-qr 모드, 2026-05-27) ──────────
// 협력사 정책으로 카메라 권한 없는 직원이 본인 폰에서 QR을 띄워 기사에게 보여줌.
// 2분 만료·자동 갱신(110초마다)·소각 시 "탑승 완료" → 5초 후 새 토큰 재발급(연속 탑승).
function ScanTabPassengerQR({ companyId, session }) {
  // tokenId state는 setTokenId 만 사용(현재 발급된 토큰 추적용 — 향후 진단 UI 확장 여지).
  // eslint-disable-next-line no-unused-vars
  const [tokenId, setTokenId] = useState(null);
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [expiresAt, setExpiresAt] = useState(null); // ms
  const [now, setNow] = useState(Date.now());
  const [step, setStep] = useState("active"); // active | success
  const [errMsg, setErrMsg] = useState("");
  const refreshTimerRef = useRef(null);
  const tickTimerRef = useRef(null);
  const tokenUnsubRef = useRef(null);

  // 토큰 발급 + QR 이미지 생성 (멱등 — 호출 전 기존 unsubscribe).
  const issueToken = useCallback(async () => {
    setErrMsg("");
    try {
      if (tokenUnsubRef.current) { tokenUnsubRef.current(); tokenUnsubRef.current = null; }
      const newTokenId = await createPassengerToken({
        companyId,
        empNo: session.empNo,
        name: session.name,
        partnerCode: session.partnerCode || null,
      });
      // QR 페이로드 = JSON (URL 아님 — 기사앱이 외부 브라우저로 튀는 사고 방지)
      const payload = JSON.stringify({
        v: 1, t: "passenger",
        tokenId: newTokenId,
        companyId,
        empNo: session.empNo,
      });
      const dataUrl = await QRCode.toDataURL(payload, {
        width: 240,
        margin: 2,
        color: { dark: "#0B1A2E", light: "#FFFFFF" },
        errorCorrectionLevel: "M",
      });
      setTokenId(newTokenId);
      setQrDataUrl(dataUrl);
      setExpiresAt(Date.now() + 2 * 60 * 1000);
      setStep("active");
      // 소각 감지 — used:true 가 되면 "탑승 완료" 화면 + 5초 후 재발급
      const tref = doc(db, "passengerTokens", newTokenId);
      const unsub = onSnapshot(tref, snap => {
        if (!snap.exists()) return;
        const d = snap.data();
        if (d.used) {
          setStep("success");
          if ("vibrate" in navigator) navigator.vibrate([100, 50, 100]);
          playTagBeep();   // 2026-08-25 미팅 — 진동만으로는 탄 줄 모른다는 신고
        }
      }, () => {});
      tokenUnsubRef.current = unsub;
    } catch (e) {
      setErrMsg("QR 발행 실패: " + (e?.message || String(e)));
    }
  }, [companyId, session?.empNo, session?.name, session?.partnerCode]);

  // 마운트 시 첫 발급 + 자동 갱신 타이머(110초마다, 만료 10초 전)
  useEffect(() => {
    issueToken();
    refreshTimerRef.current = setInterval(() => {
      // 탑승 완료 화면 표시 중에는 갱신 멈춤(소각된 토큰 재발급은 success 후 5초 효과로 처리)
      issueToken();
    }, 110 * 1000);
    return () => {
      if (refreshTimerRef.current) { clearInterval(refreshTimerRef.current); refreshTimerRef.current = null; }
      if (tokenUnsubRef.current) { tokenUnsubRef.current(); tokenUnsubRef.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, session?.empNo, session?.partnerCode]);

  // 카운트다운 tick (1초)
  useEffect(() => {
    tickTimerRef.current = setInterval(() => setNow(Date.now()), 1000);
    return () => { if (tickTimerRef.current) clearInterval(tickTimerRef.current); };
  }, []);

  // 탑승 완료 → 5초 후 자동 재발급 (연속 탑승: 환승 시나리오)
  useEffect(() => {
    if (step !== "success") return;
    const t = setTimeout(() => { issueToken(); }, 5000);
    return () => clearTimeout(t);
  }, [step, issueToken]);

  const remainSec = expiresAt ? Math.max(0, Math.ceil((expiresAt - now) / 1000)) : 0;
  const remainLabel = remainSec >= 60
    ? `${Math.floor(remainSec / 60)}분 ${remainSec % 60}초`
    : `${remainSec}초`;

  return (
    <div style={{ display:"flex", flexDirection:"column", flex:1, overflow:"hidden", background:"var(--color-bg-alt)" }}>
      <div style={{ background:"var(--color-bg)", padding:"14px 16px", borderBottom:"1px solid var(--color-line)" }}>
        <div style={{ fontSize:16, fontWeight:800, color:"var(--color-label)", letterSpacing:"-0.02em" }}>탑승 QR</div>
        <div style={{ fontSize:12, color:"var(--color-label-mute)", marginTop:2 }}>기사님께 이 QR을 보여주세요</div>
      </div>

      <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:24, gap:18, overflowY:"auto" }}>

        {step === "active" && (
          <>
            <div style={{ textAlign:"center" }}>
              <div style={{ fontSize:17, fontWeight:800, color:"var(--color-label)", marginBottom:6 }}>
                {session.name} ({session.empNo})
              </div>
              <div style={{ fontSize:13, color:"var(--color-label-mute)", lineHeight:1.6 }}>
                기사님께 아래 QR을 보여주세요
              </div>
            </div>

            <div style={{ background:"var(--color-bg)", padding:18, borderRadius:"var(--radius-16)", border:"1px solid var(--color-line)", boxShadow:"var(--shadow-emphasize)" }}>
              {qrDataUrl ? (
                <img src={qrDataUrl} alt="탑승 QR" width={240} height={240} style={{ display:"block", borderRadius:8 }} />
              ) : (
                <div style={{ width:240, height:240, display:"flex", alignItems:"center", justifyContent:"center", color:"var(--color-label-mute)" }}>
                  생성 중...
                </div>
              )}
            </div>

            <div style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 14px", borderRadius:999, background: remainSec <= 20 ? "#FFF3E0" : "var(--color-primary-soft)", border: remainSec <= 20 ? "1px solid var(--color-cautionary)" : "1px solid var(--color-primary)" }}>
              <StatusDot tone={remainSec <= 20 ? "warn" : "primary"} size={8} pulse />
              <span style={{ fontSize:13, fontWeight:700, color: remainSec <= 20 ? "var(--color-cautionary)" : "var(--color-primary-deep)" }}>
                {remainSec > 0 ? `유효시간 ${remainLabel}` : "갱신 중…"}
              </span>
            </div>

            <div style={{ fontSize:11, color:"var(--color-label-alt)", textAlign:"center", lineHeight:1.5 }}>
              QR은 2분마다 자동 갱신됩니다<br/>
              기사 폰에 가까이 대주세요
            </div>

            <button
              onClick={issueToken}
              style={{ background:"var(--color-bg)", border:"1px solid var(--color-line)", borderRadius:"var(--radius-12)", padding:"10px 20px", color:"var(--color-label-mute)", fontSize:13, fontWeight:600, cursor:"pointer", fontFamily:"inherit" }}>
              <span style={{ display:"inline-flex", alignItems:"center", justifyContent:"center", gap:6 }}><Icon name="refresh" size={13} stroke={2} /> 즉시 갱신</span>
            </button>

            {errMsg && (
              <div style={{ background:"#FCE5E5", border:"1px solid #F6C9C9", borderRadius:8, padding:"9px 12px", fontSize:12, fontWeight:600, color:"#A81818" }}>
                {errMsg}
              </div>
            )}
          </>
        )}

        {step === "success" && (
          <>
            <div style={{ width:90, height:90, borderRadius:"50%", background:"#E6F7EB", border:"2px solid var(--color-positive)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:44, color:"#007A29" }}>✓</div>
            <div style={{ fontSize:22, fontWeight:800, color:"#007A29" }}>탑승 완료!</div>
            <div style={{ fontSize:14, color:"var(--color-label)", fontWeight:700 }}>{session.name} ({session.empNo})</div>
            <div style={{ fontSize:12, color:"var(--color-label-mute)" }}>{new Date().toLocaleTimeString("ko-KR")}</div>
            <div style={{ fontSize:11, color:"var(--color-label-alt)", marginTop:4 }}>
              잠시 후 새 QR이 발행됩니다 (환승 시 사용)
            </div>
          </>
        )}

      </div>
    </div>
  );
}

// ─── 기사 QR 스캔 UI (driver-qr 모드, 기존 ScanTab 그대로) ────
function ScanTabDriverQR({ companyId, session }) {
  const [step, setStep] = useState("ready"); // ready|loading|scanning|confirm|success|error
  // jsQR npm 패키지로 직접 import — 항상 사용 가능
  const [scannedToken, setScannedToken] = useState(null);
  const [tokenData, setTokenData] = useState(null);
  const [staticQr, setStaticQr] = useState(null);          // 고정 QR 이면 {companyId, vehicleId}
  const [alreadyBoarded, setAlreadyBoarded] = useState(false); // 고정 QR 재스캔(당일 중복) 여부
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
      const raw = (rawValue || "").trim();
      let t = null, c = null, v = null;
      try {
        const u = new URL(raw);
        t = u.searchParams.get("t");
        c = u.searchParams.get("c");
        v = u.searchParams.get("v");
      } catch { /* URL 아님 → 토큰 문자열 그대로 취급 */ }

      // 차량 부착 고정 QR(`/board?c={companyId}&v={vehicleId}`, 2026-07-09) — 토큰 없음.
      // 유비칸 등 기사앱 미사용 차량용. 폰 기본 카메라(BoardingApp)와 이 인앱 스캐너 둘 다 지원.
      // 승객이 앱에서 선택한 노선(session.routeId)을 서버에 전달 — 선택 노선 배차만 매칭,
      // 다른 노선 차량이면 서버가 차단(오탑승 방지, 2026-07-16 회의 #1). 미선택 직원은 기존 동작.
      if (!t && c && v) {
        if (companyId && c !== companyId) throw new Error("다른 회사의 QR코드입니다");
        const selectedRouteId = session?.routeId || null;
        const info = await resolveStaticDispatch({ companyId: c, vehicleId: v, selectedRouteId });
        setStaticQr({ companyId: c, vehicleId: v, selectedRouteId });
        setTokenData({ routeName: info.routeName, vehicleNo: info.vehicleNo });
        setStep("confirm");
        return;
      }

      const token = t || raw;
      // Firestore 문서 ID 는 "/" 를 못 쓴다 — 탑승용이 아닌 QR(임의 URL 등)이 그대로 들어오면
      // doc() 가 "Invalid segment / Paths must not contain //" 로 죽으므로 미리 걸러 안내한다.
      if (!token || token.includes("/")) throw new Error("탑승용 QR코드가 아닙니다\n기사 폰 또는 차량에 부착된 QR을 스캔하세요");

      setStaticQr(null);
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
      if (staticQr) {
        // 본인 확인은 **로그인 토큰**이 한다(2026-08-25 P2) — 승객 입력 0, 클라가 보내는
        // 사번은 서버가 토큰 값으로 덮어쓴다.
        const res = await validateAndBoardStatic({ ...staticQr, empNo: session.empNo, name: session.name });
        setAlreadyBoarded(!!res.alreadyBoarded);
      } else {
        await validateAndBoard({ tokenId: scannedToken, empNo: session.empNo, name: session.name });
        setAlreadyBoarded(false);
      }
      if ("vibrate" in navigator) navigator.vibrate([100, 50, 100]);
      playTagBeep();   // 2026-08-25 미팅 — 진동만으로는 탄 줄 모른다는 신고
      setStep("success");
    } catch (e) { setErrMsg(e.message); setStep("error"); }
  };

  const reset = () => {
    stopStream();
    setStep("ready"); setScannedToken(null); setTokenData(null);
    setStaticQr(null); setAlreadyBoarded(false);
    setErrMsg(""); setScanStatus("");
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", flex:1, overflow:"hidden", background:"var(--color-bg-alt)" }}>
      <div style={{ background:"var(--color-bg)", padding:"14px 16px", borderBottom:"1px solid var(--color-line)" }}>
        <div style={{ fontSize:16, fontWeight:800, color:"var(--color-label)", letterSpacing:"-0.02em" }}>QR 탑승</div>
        <div style={{ fontSize:12, color:"var(--color-label-mute)", marginTop:2 }}>기사 폰 또는 차량에 부착된 QR코드를 스캔하세요</div>
      </div>

      <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:24, gap:20, overflowY:"auto" }}>

        {/* ── 준비 화면 ── */}
        {step === "ready" && (
          <>
            <div style={{ width:90, height:90, borderRadius:"50%", background:"var(--color-primary-soft)", display:"flex", alignItems:"center", justifyContent:"center", color:"var(--color-primary)" }}>
              <Icon name="camera" size={40} stroke={1.6} />
            </div>
            <div style={{ textAlign:"center" }}>
              <div style={{ fontSize:17, fontWeight:800, color:"var(--color-label)", marginBottom:6 }}>탑승 QR 스캔</div>
              <div style={{ fontSize:13, color:"var(--color-label-mute)", lineHeight:1.6 }}>
                {session.name} ({session.empNo})<br/>으로 탑승 처리됩니다
              </div>
            </div>
            <button style={{ ...S.btn, maxWidth:280 }} onClick={startScan}>
              <span style={{ display:"inline-flex", alignItems:"center", justifyContent:"center", gap:7 }}><Icon name="camera" size={17} stroke={2} /> 카메라 열기</span>
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
                <div style={{ position:"absolute", top:"18%", left:"10%", width:30, height:30, borderTop:"3px solid var(--color-primary)", borderLeft:"3px solid var(--color-primary)", borderRadius:"6px 0 0 0" }}/>
                <div style={{ position:"absolute", top:"18%", right:"10%", width:30, height:30, borderTop:"3px solid var(--color-primary)", borderRight:"3px solid var(--color-primary)", borderRadius:"0 6px 0 0" }}/>
                <div style={{ position:"absolute", bottom:"18%", left:"10%", width:30, height:30, borderBottom:"3px solid var(--color-primary)", borderLeft:"3px solid var(--color-primary)", borderRadius:"0 0 0 6px" }}/>
                <div style={{ position:"absolute", bottom:"18%", right:"10%", width:30, height:30, borderBottom:"3px solid var(--color-primary)", borderRight:"3px solid var(--color-primary)", borderRadius:"0 0 6px 0" }}/>
              </div>
            </div>
            <div style={{ textAlign:"center", marginTop:14, fontSize:13, color:"var(--color-primary)", fontWeight:600 }}>{scanStatus}</div>
            <button style={{ ...S.btnSecondary, marginTop:12, width:"100%" }} onClick={reset}>취소</button>
          </div>
        )}

        {/* ── 탑승 확인 ── */}
        {step === "confirm" && tokenData && (
          <div style={{ width:"100%", maxWidth:320 }}>
            <div style={{ background:"var(--color-bg)", borderRadius:"var(--radius-16)", padding:20, marginBottom:16, border:"1px solid rgba(0,191,64,.3)", boxShadow:"var(--shadow-emphasize)" }}>
              <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:14 }}>
                <span style={{ display:"inline-flex", color:"var(--color-positive)" }}><Icon name="check" size={20} stroke={2.4} /></span>
                <div style={{ fontSize:14, fontWeight:800, color:"#007A29" }}>QR 인식 완료</div>
                {staticQr && (
                  <span style={{ marginLeft:"auto", fontSize:10, fontWeight:700, padding:"3px 8px", borderRadius:"var(--radius-pill)", background:"var(--color-primary-soft)", color:"var(--color-primary-deep)" }}>고정 QR</span>
                )}
              </div>
              {[["노선",tokenData.routeName],["차량",tokenData.vehicleNo],["탑승자",`${session.name} (${session.empNo})`],["부서",session.dept||"–"]].map(([k,v])=>(
                <div key={k} style={{ display:"flex", justifyContent:"space-between", padding:"8px 0", borderBottom:"1px solid var(--color-line)" }}>
                  <span style={{ fontSize:12, color:"var(--color-label-mute)" }}>{k}</span>
                  <span style={{ fontSize:13, fontWeight:700, color:"var(--color-label)" }}>{v}</span>
                </div>
              ))}
            </div>
            <button style={{ ...S.btn, marginBottom:8 }} onClick={handleBoard}>탑승 확인</button>
            <button style={S.btnSecondary} onClick={reset}>취소</button>
          </div>
        )}

        {/* ── 처리 중 ── */}
        {step === "processing" && (
          <>
            <div style={S.spinner}/>
            <div style={{ fontSize:13, color:"var(--color-label-mute)" }}>탑승 처리 중...</div>
          </>
        )}

        {/* ── 탑승 완료 ── */}
        {step === "success" && (
          <>
            <div style={{ width:80, height:80, borderRadius:"50%", background:"#E6F7EB", border:"2px solid var(--color-positive)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:36, color:"#007A29" }}>✓</div>
            <div style={{ fontSize:22, fontWeight:800, color:"#007A29" }}>{alreadyBoarded ? "이미 탑승 처리됨" : "탑승 완료!"}</div>
            <div style={{ fontSize:14, color:"var(--color-label)", fontWeight:700 }}>{session.name} ({session.dept})</div>
            {alreadyBoarded
              ? <div style={{ fontSize:12, color:"var(--color-label-mute)", textAlign:"center", lineHeight:1.6 }}>오늘 이 차량 탑승은 이미 기록되어 있습니다<br/>중복 기록되지 않습니다</div>
              : <div style={{ fontSize:12, color:"var(--color-label-mute)" }}>{new Date().toLocaleTimeString("ko-KR")}</div>}
            <button style={{ ...S.btnSecondary, marginTop:8, maxWidth:280 }} onClick={reset}>확인</button>
          </>
        )}

        {/* ── 오류 ── */}
        {step === "error" && (
          <>
            <div style={{ width:72, height:72, borderRadius:"50%", background:"var(--color-atomic-red-90)", border:"2px solid var(--color-destructive)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:32, color:"var(--color-destructive)" }}>✕</div>
            <div style={{ fontSize:18, fontWeight:800, color:"var(--color-destructive)" }}>오류</div>
            <div style={{ fontSize:13, color:"var(--color-label-mute)", textAlign:"center", whiteSpace:"pre-line", lineHeight:1.6 }}>{errMsg}</div>
            <button style={{ ...S.btn, maxWidth:280 }} onClick={reset}>다시 시도</button>
          </>
        )}

      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════
// 문의 탭 — dycs CS 위젯 임베드 (2026-08-06 오전 미팅)
// ════════════════════════════════════════════════════════
// 🔴 **앱 안 임베드**(iframe)가 정본 — 새 창으로 넘기면 설치형 PWA 가 시스템 브라우저로
//    빠져나가 돌아오기가 번거롭고, 그 순간 앱은 기사 GPS·공지 수신 상태를 잃는다.
//    dycs 위젯은 X-Frame-Options/CSP frame-ancestors 를 안 보낸다(2026-08-06 실측).
// 🔴 그래도 **탈출구는 항상 둔다** — 임베드가 막히거나(회사 보안 프록시) 느릴 때
//    "새 창에서 열기"가 없으면 승객은 빈 화면만 보고 문의를 포기한다.
// ─── 홈페이지 탭 (2026-08-25 미팅) ─────────────────────────
// 🔴 **iframe 으로 감싸지 않는다** — 신촌세브란스 사이트(Google Sites)가 `X-Frame-Options: DENY`
//    를 주므로 임베드하면 빈 화면이 된다(실측). 그래서 "여는 버튼" 화면이다.
// 탭을 누르자마자 자동으로 새 창을 열지 않는 이유 = 돌아왔을 때 아무것도 없는 탭이 남고,
//    팝업 차단에 걸리면 사용자는 아무 일도 안 일어난 것으로 본다. 누를 것을 눈에 보이게 둔다.
function HomepageTab({ config, partnerName }) {
  const url = config && config.enabled ? config.url : null;
  if (!url) return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: 24 }}>
      <Icon name="globe" size={34} />
      <div style={{ fontSize: 14, fontWeight: 700, color: "var(--color-label)" }}>홈페이지가 준비 중입니다</div>
      <div style={{ fontSize: 12, color: "var(--color-label-mute)", textAlign: "center", lineHeight: 1.6 }}>
        담당자에게 문의하세요
      </div>
    </div>
  );

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, padding: "24px 22px", background: "var(--color-bg-alt)" }}>
      <div style={{
        width: 62, height: 62, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
        background: "var(--color-primary-soft)", color: "var(--color-primary)",
      }}>
        <Icon name="globe" size={30} stroke={1.6} />
      </div>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: "var(--color-label)", letterSpacing: "-0.02em" }}>
          {partnerName || "홈페이지"}
        </div>
        <div style={{ fontSize: 12.5, color: "var(--color-label-mute)", marginTop: 6, lineHeight: 1.6, wordBreak: "keep-all" }}>
          공지·문의·연락처를 홈페이지에서 확인하실 수 있습니다.
        </div>
      </div>
      <a href={url} target="_blank" rel="noopener noreferrer"
        style={{
          marginTop: 2, display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
          width: "100%", maxWidth: 300, padding: "14px 18px", borderRadius: "var(--radius-12)",
          background: "var(--color-primary)", color: "#fff", fontSize: 15, fontWeight: 800,
          textDecoration: "none", boxShadow: "var(--shadow-emphasize)",
        }}>
        홈페이지 열기
      </a>
      <div style={{ fontSize: 11, color: "var(--color-label-alt)", textAlign: "center", wordBreak: "break-all", lineHeight: 1.5 }}>
        {homepageDisplayHost(url)}
      </div>
    </div>
  );
}

function InquiryTab({ config, partnerName }) {
  const url = useMemo(() => buildInquiryUrl(config), [config]);
  const [loaded, setLoaded] = useState(false);
  const [slow, setSlow] = useState(false);

  // 6초 안에 안 뜨면 탈출구를 눈에 띄게 승격(진입 게이트엔 상한과 탈출구).
  useEffect(() => {
    if (loaded) return;
    const t = setTimeout(() => setSlow(true), 6000);
    return () => clearTimeout(t);
  }, [loaded]);

  // 설정이 없는데 탭이 보이는 경우는 없지만(부모가 enabled 로 게이팅), 방어적으로 안내.
  if (!url) return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: 24 }}>
      <Icon name="chat" size={34} />
      <div style={{ fontSize: 14, fontWeight: 700, color: "var(--color-label)" }}>문의 접수가 준비 중입니다</div>
      <div style={{ fontSize: 12, color: "var(--color-label-mute)", textAlign: "center", lineHeight: 1.6 }}>
        담당자에게 문의하세요
      </div>
    </div>
  );

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 8, flexShrink: 0,
        padding: "8px 12px", borderBottom: "1px solid var(--color-line)", background: "var(--color-bg)",
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: "var(--color-label)" }}>문의 · 분실물 접수</div>
          {partnerName && (
            <div style={{ fontSize: 11, color: "var(--color-label-mute)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {partnerName}
            </div>
          )}
        </div>
        <a href={url} target="_blank" rel="noopener noreferrer"
          style={{
            flexShrink: 0, fontSize: 11, fontWeight: 700, textDecoration: "none",
            padding: "6px 11px", borderRadius: 999,
            border: `1px solid ${slow && !loaded ? "var(--color-primary)" : "var(--color-line)"}`,
            background: slow && !loaded ? "var(--color-primary-soft)" : "transparent",
            color: slow && !loaded ? "var(--color-primary-deep)" : "var(--color-label-mute)",
          }}>
          새 창에서 열기
        </a>
      </div>

      <div style={{ flex: 1, minHeight: 0, position: "relative", background: "var(--color-bg-alt)" }}>
        {!loaded && (
          <div style={{
            position: "absolute", inset: 0, display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center", gap: 12,
          }}>
            <div style={S.spinner} />
            <div style={{ fontSize: 12, color: "var(--color-label-mute)" }}>
              {slow ? "연결이 느립니다 — 위 '새 창에서 열기'를 눌러보세요" : "문의 화면을 불러오는 중..."}
            </div>
          </div>
        )}
        <iframe
          src={url}
          title="문의 접수"
          onLoad={() => setLoaded(true)}
          style={{ width: "100%", height: "100%", border: "none", display: "block", background: "transparent" }}
        />
      </div>
    </div>
  );
}

// ─── 태깅 소리 설정 (2026-08-25 미팅) ──────────────────────
// 기본 ON. 거래처가 '강제'를 켜 두면 개인이 끌 수 없고 그 이유를 화면에 적는다
// (끄는 버튼이 눌리지도 않는데 이유가 없으면 고장으로 읽힌다).
function TagSoundCard() {
  const forced = isTagSoundForced();
  const [on, setOn] = useState(() => isTagSoundOn());
  const toggle = () => {
    if (forced) return;
    const next = !on;
    setTagSoundOn(next);
    setOn(next);
    if (next) playTagBeep();   // 켠 순간 들려준다 — 안 들리면 기기 무음 상태라는 뜻
  };
  return (
    <div style={{ background: "var(--color-bg)", borderRadius: "var(--radius-16)", padding: "16px 18px", border: "1px solid var(--color-line)", boxShadow: "var(--shadow-emphasize)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 14, fontWeight: 700, color: "var(--color-label)", marginBottom: 4 }}>
        <Icon name="bell" size={16} stroke={1.9} /> 태깅 소리
      </div>
      <div style={{ fontSize: 11.5, color: "var(--color-label-alt)", lineHeight: 1.5, marginBottom: 12 }}>
        탑승이 기록되면 짧은 확인음이 납니다(진동은 소리와 무관하게 항상 울립니다).
      </div>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
        padding: "11px 12px", borderRadius: "var(--radius-12)",
        background: on ? "#E6F7EB" : "var(--color-bg-soft)",
        border: `1px solid ${on ? "#A7E2BB" : "var(--color-line)"}`,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: on ? "#007A29" : "var(--color-label-mute)" }}>
            {on ? "확인음 켜짐" : "확인음 꺼짐"}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--color-label-mute)", marginTop: 2, lineHeight: 1.45, wordBreak: "keep-all" }}>
            {forced
              ? "회사 정책으로 항상 켜져 있습니다"
              : "휴대폰이 무음이면 소리가 나지 않습니다"}
          </div>
        </div>
        <button onClick={toggle} disabled={forced}
          style={{
            flexShrink: 0, borderRadius: "var(--radius-8)", padding: "8px 12px", fontSize: 12, fontWeight: 700,
            fontFamily: "inherit", cursor: forced ? "not-allowed" : "pointer", opacity: forced ? 0.45 : 1,
            background: on ? "var(--color-bg)" : "var(--color-primary)",
            color: on ? "var(--color-label-mute)" : "#fff",
            border: on ? "1px solid var(--color-line)" : "none",
          }}>
          {forced ? "고정" : (on ? "끄기" : "켜기")}
        </button>
      </div>
    </div>
  );
}

function SettingsTab({ companyId, session, onLogout, onGoHome, onSessionUpdate }) {
  const [showPinChange, setShowPinChange] = useState(session.pinInitial || false);
  const [oldPin, setOldPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState(session.pinInitial ? { type:"warn", text:"초기 PIN(000000)을 사용 중입니다. 변경해주세요." } : null);

  // ── PIN 변경 잠금(2026-07-21) ──
  // 여러 명이 함께 쓰는 공용/통합 계정(예: 학교 통합관제 ID)은 한 사람이 PIN 을 바꾸면
  // 나머지 전원이 로그인 못 한다. 협력사 포털에서 `passengers/{empNo}.pinLocked` 를 켜면
  // 이 화면의 PIN 변경 항목을 감춘다. 필드 부재 = false = 기존 동작 그대로(회귀 0).
  //
  // 세션(localStorage)에는 이 필드가 없는 기기가 이미 많으므로 저장된 값에 기대지 않고
  // 설정 탭 진입 시 승객 문서를 1회 실측한다(로그인 이후 관리자가 잠가도 즉시 반영).
  const [pinLocked, setPinLocked] = useState(!!session.pinLocked);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const snap = await getDoc(doc(db, "companies", companyId, "passengers", session.empNo));
        if (!alive || !snap.exists()) return;
        const locked = !!snap.data().pinLocked;
        setPinLocked(locked);
        if (locked) {
          setShowPinChange(false);
          setMsg(prev => (prev && prev.type === "warn" ? null : prev));   // 초기PIN 변경 독촉 제거
        }
        if (locked !== !!session.pinLocked) onSessionUpdate({ pinLocked: locked });
      } catch (e) {
        console.warn("[설정] PIN 잠금 조회 실패(무시):", e.message);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, session.empNo]);

  // ── 배정 노선 이름(2026-08-11) ──
  // 세션에는 `routeId` 밖에 없어 이 카드가 문서 ID(`yRhXBbOI…`)를 그대로 노출하고 있었다.
  // 승객(학생·학부모)이 보는 화면이므로 이름으로 바꾼다. 조회 1회·실패하면 표시만 "–".
  // 🔴 실패해도 ID 로 폴백하지 말 것 — 사람이 읽을 수 없는 값이라 없느니만 못하다.
  const [routeName, setRouteName] = useState("");
  useEffect(() => {
    let alive = true;
    if (!session.routeId) { setRouteName(""); return; }
    (async () => {
      try {
        const snap = await getDoc(doc(db, "companies", companyId, "routes", session.routeId));
        if (!alive || !snap.exists()) return;
        setRouteName(snap.data().name || snap.data().code || "");
      } catch (e) {
        console.warn("[설정] 배정 노선 조회 실패(무시):", e.message);
      }
    })();
    return () => { alive = false; };
  }, [companyId, session.routeId]);

  // 배터리 절전 안내 카드(작업B) — 안드로이드만, 삼성/일반 분기. iOS·데스크톱은 null.
  const batteryPlatform = detectBatteryGuidePlatform();
  // 앱 설치 가이드 재노출(작업C) — 설정에서 언제든 설치 진입 가능(3일 스누즈 무관).
  const [showInstallGuide, setShowInstallGuide] = useState(false);

  // ── 🔔 알림 진단 카드 (2026-05-21) ──
  // 운영 진단·복구 인프라 — "공지가 안 와요" 호소 시 사용자가 본인 권한·토큰 자가 점검·재발급.
  // 토큰 invalid → 자동 삭제 → fcmTokens 0건 자연흐름의 사용자측 회복 통로.
  const [permState, setPermState] = useState(() => (typeof Notification !== "undefined" ? Notification.permission : "default"));
  const [tokenDoc, setTokenDoc] = useState(null); // { token, updatedAt } | null | undefined(로딩)
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagResult, setDiagResult] = useState(null); // { ok, text }

  const loadTokenDoc = useCallback(async () => {
    if (!session?.empNo || !companyId) return;
    try {
      const snap = await getDoc(doc(db, "companies", companyId, "fcmTokens", session.empNo));
      setTokenDoc(snap.exists() ? snap.data() : null);
    } catch (e) {
      console.warn("[알림 진단] 토큰 조회 실패:", e.message);
      setTokenDoc(null);
    }
  }, [companyId, session?.empNo]);

  useEffect(() => { loadTokenDoc(); }, [loadTokenDoc]);

  // ── 🔔 도착 임박 알림 상태 (2026-08-10) ──────────────────────────
  // '내 정류장'을 지정한 사람에게만 도착 임박 푸시가 간다(CF notifyPreArrival 이
  // fcmTokens 의 routeId+stopId 로 대상을 찾는다). 그런데 그 지정은 홈 지도에서만
  // 할 수 있어서 **지정한 사람이 극소수**였고, 트리거를 고쳐도 도달 인원이 거기서 묶였다.
  // → 설정 탭에서 상태를 보여주고 지정 경로를 열어 준다.
  //
  // 🔴 읽기를 늘리지 않는다 — 알림 진단이 이미 읽은 `tokenDoc`(fcmTokens 문서)에
  //    routeId/stopId 가 들어 있다. 정류장 **이름**만 지정돼 있을 때 1회 더 읽는다.
  const myStopId = tokenDoc?.stopId || null;
  const myStopRouteId = tokenDoc?.routeId || null;
  const [myStopName, setMyStopName] = useState(null);
  useEffect(() => {
    let alive = true;
    if (!myStopId || !myStopRouteId || !companyId) { setMyStopName(null); return; }
    getDoc(doc(db, "companies", companyId, "routes", myStopRouteId, "stops", myStopId))
      .then(s => { if (alive) setMyStopName(s.exists() ? (s.data().name || null) : null); })
      .catch(() => { if (alive) setMyStopName(null); });   // 실패해도 '켜짐'은 그대로 알린다
    return () => { alive = false; };
  }, [companyId, myStopRouteId, myStopId]);

  const [clearingStop, setClearingStop] = useState(false);
  const handleClearMyStop = async () => {
    setClearingStop(true);
    await persistMyStop(companyId, session.empNo, null, null);
    await loadTokenDoc();
    setClearingStop(false);
  };

  const handleReissue = async () => {
    setDiagLoading(true); setDiagResult(null);
    try {
      const r = await initNotifications({
        companyId, empNo: session.empNo, partnerCode: session.partnerCode || null,
      });
      // 권한 거부
      if (typeof Notification !== "undefined") setPermState(Notification.permission);
      if (r?.granted === false) {
        setDiagResult({ ok:false, text:"알림 권한이 거부되었습니다. 브라우저 주소창 자물쇠 아이콘 → 알림 → 허용으로 변경 후 다시 시도해주세요." });
      } else if (!r?.token) {
        setDiagResult({ ok:false, text:"토큰 발급에 실패했습니다" + (r?.error ? ": " + r.error : "") });
      } else {
        setDiagResult({ ok:true, text:"재발급 완료 — 이제 공지 푸시가 정상 수신됩니다" });
      }
      await loadTokenDoc();
    } catch (e) {
      setDiagResult({ ok:false, text:"오류: " + (e?.message || String(e)) });
    }
    setDiagLoading(false);
  };

  const fmtTime = (ts) => {
    if (!ts) return "–";
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleString("ko-KR", { month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" });
  };
  const tokenTail = tokenDoc?.token ? `...${tokenDoc.token.slice(-4)}` : null;
  const permPill = permState === "granted"
    ? { bg:"#E6F7EB", fg:"#007A29", border:"#A7E2BB", text:"허용됨" }
    : permState === "denied"
      ? { bg:"#FCE5E5", fg:"#A81818", border:"#F6C9C9", text:"거부됨" }
      : { bg:"var(--color-bg-soft)", fg:"var(--color-label-mute)", border:"var(--color-line)", text:"미선택" };

  const handlePinChange = async () => {
    // 잠긴 공용 계정은 UI 자체가 안 보이지만, 상태 경합 대비 최종 가드.
    if (pinLocked) return setMsg({ type:"error", text:"공용으로 사용하는 계정이라 PIN을 변경할 수 없습니다" });
    if (newPin.length < 4) return setMsg({ type:"error", text:"PIN은 4자리 이상이어야 합니다" });
    if (newPin !== confirmPin) return setMsg({ type:"error", text:"새 PIN이 일치하지 않습니다" });
    setLoading(true); setMsg(null);
    try {
      // 현재 PIN 대조도 서버가 한다 — 세션에 `pinHash` 를 들고 다니지 않는다(2026-08-25 P2).
      await passengerSetPin({ currentPin: oldPin, newPin });
      onSessionUpdate({ pinInitial: false });
      setMsg({ type:"success", text:"PIN이 변경되었습니다" });
      setShowPinChange(false);
      setOldPin(""); setNewPin(""); setConfirmPin("");
    } catch (e) {
      setMsg({ type:"error", text: e.message });
    }
    setLoading(false);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, overflowY: "auto", background: "var(--color-bg-alt)" }}>
      <div style={{ background: "var(--color-bg)", padding: "14px 16px", borderBottom: "1px solid var(--color-line)" }}>
        <div style={{ fontSize: 16, fontWeight: 800, color: "var(--color-label)", letterSpacing: "-0.02em" }}>설정</div>
      </div>

      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        {/* 내 정보 */}
        <div style={{ background: "var(--color-bg)", borderRadius: "var(--radius-16)", padding: "16px 18px", border: "1px solid var(--color-line)", boxShadow: "var(--shadow-emphasize)" }}>
          <div style={{ fontSize: 11, color: "var(--color-label-mute)", marginBottom: 10, fontWeight: 700, letterSpacing: "0.05em" }}>내 정보</div>
          {[["이름", session.name], ["사번", session.empNo], ["부서", session.dept || "–"], ["배정 노선", routeName || "–"]].map(([k,v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "7px 0", borderBottom: "1px solid var(--color-line)" }}>
              <span style={{ fontSize: 13, color: "var(--color-label-mute)", flexShrink: 0 }}>{k}</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: "var(--color-label)", textAlign: "right", wordBreak: "keep-all", overflowWrap: "anywhere" }}>{v}</span>
            </div>
          ))}
        </div>

        {/* PIN 변경 */}
        {msg && (
          <div style={{ background: msg.type==="error"?"var(--color-atomic-red-90)":msg.type==="warn"?"var(--color-atomic-orange-90)":"#E6F7EB", border: `1px solid ${msg.type==="error"?"rgba(229,34,34,.25)":msg.type==="warn"?"rgba(255,122,0,.25)":"rgba(0,191,64,.3)"}`, borderRadius: "var(--radius-8)", padding: "10px 14px", fontSize: 13, fontWeight: 600, color: msg.type==="error"?"#A81818":msg.type==="warn"?"#B95300":"#007A29" }}>
            {msg.text}
          </div>
        )}

        {/* 🔔 알림 설정 카드 (2026-08-10) — 도착 임박 알림 on/off 상태를 드러낸다.
            🔴 여기에 "동작하지 않는 토글"을 두지 말 것. 이 스위치가 실제로 하는 일은
               fcmTokens 의 routeId/stopId 를 쓰고 지우는 것이고, 그게 곧 CF 의 발송 대상이다.
               발송에 영향을 못 주는 토글을 만들면 켜 둔 사람이 알림을 못 받고도 켰다고 믿는다. */}
        <div style={{ background: "var(--color-bg)", borderRadius: "var(--radius-16)", padding: "16px 18px", border: "1px solid var(--color-line)", boxShadow: "var(--shadow-emphasize)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 14, fontWeight: 700, color: "var(--color-label)", marginBottom: 4 }}>
            <Icon name="bell" size={16} stroke={1.9} /> 알림 설정
          </div>
          <div style={{ fontSize: 11.5, color: "var(--color-label-alt)", lineHeight: 1.5, marginBottom: 12 }}>
            버스가 내 정류장에 가까워지면 알려드립니다(2정거장·1정거장 전).
          </div>

          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
            padding: "11px 12px", borderRadius: "var(--radius-12)",
            background: myStopId ? "#E6F7EB" : "var(--color-bg-soft)",
            border: `1px solid ${myStopId ? "#A7E2BB" : "var(--color-line)"}`,
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: myStopId ? "#007A29" : "var(--color-label-mute)" }}>
                {myStopId ? "도착 임박 알림 켜짐" : "도착 임박 알림 꺼짐"}
              </div>
              <div style={{ fontSize: 11.5, color: "var(--color-label-mute)", marginTop: 2, lineHeight: 1.45, wordBreak: "keep-all" }}>
                {myStopId
                  ? (myStopName ? `내 정류장 · ${myStopName}` : "내 정류장이 지정되어 있습니다")
                  : "내 정류장을 지정해야 알림이 갑니다"}
              </div>
            </div>
            {myStopId ? (
              <button onClick={handleClearMyStop} disabled={clearingStop}
                style={{ flexShrink: 0, background: "var(--color-bg)", border: "1px solid var(--color-line)", borderRadius: "var(--radius-8)", padding: "7px 12px", color: "var(--color-label-mute)", fontSize: 12, fontWeight: 600, cursor: clearingStop ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
                {clearingStop ? "해제 중..." : "해제"}
              </button>
            ) : (
              <button onClick={() => onGoHome && onGoHome()}
                style={{ flexShrink: 0, background: "var(--color-primary)", border: "none", borderRadius: "var(--radius-8)", padding: "8px 12px", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                지정하러 가기
              </button>
            )}
          </div>

          {!myStopId && (
            <div style={{ marginTop: 9, fontSize: 11, color: "var(--color-label-alt)", lineHeight: 1.55, wordBreak: "keep-all" }}>
              홈 화면 지도에서 내가 타는 정류장을 누른 뒤 <b>“이 정류장을 내 정류장으로 설정”</b>을 누르시면 됩니다.
            </div>
          )}
        </div>

        {/* 🔊 태깅 소리 카드 (2026-08-25 미팅 — 신촌세브란스 요청) */}
        <TagSoundCard />

        {/* 🔔 알림 진단 카드 (2026-05-21) — 권한·토큰 자가 점검·재발급 */}
        <div style={{ background: "var(--color-bg)", borderRadius: "var(--radius-16)", padding: "16px 18px", border: "1px solid var(--color-line)", boxShadow: "var(--shadow-emphasize)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 14, fontWeight: 700, color: "var(--color-label)", marginBottom: 12 }}>
            <Icon name="speed" size={16} stroke={1.9} /> 알림 진단
          </div>

          {/* 권한 상태 */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--color-line)" }}>
            <span style={{ fontSize: 13, color: "var(--color-label-mute)" }}>권한 상태</span>
            <span style={{ background: permPill.bg, color: permPill.fg, border: `1px solid ${permPill.border}`, borderRadius: 8, padding: "3px 10px", fontSize: 12, fontWeight: 700 }}>
              {permPill.text}
            </span>
          </div>

          {/* 등록된 토큰 */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--color-line)", gap: 8 }}>
            <span style={{ fontSize: 13, color: "var(--color-label-mute)", flexShrink: 0 }}>등록된 토큰</span>
            <span style={{ fontSize: 12, color: tokenTail ? "var(--color-label)" : "var(--color-destructive)", fontWeight: 600, textAlign: "right", lineHeight: 1.45 }}>
              {tokenTail ? (
                <>
                  발급됨 <span style={{ color: "var(--color-label-mute)", fontWeight: 500 }}>({tokenTail})</span>
                  <div style={{ fontSize: 11, color: "var(--color-label-alt)", fontWeight: 500 }}>갱신: {fmtTime(tokenDoc?.updatedAt)}</div>
                </>
              ) : "미발급"}
            </span>
          </div>

          {/* 재발급 결과 */}
          {diagResult && (
            <div style={{ marginTop: 10, background: diagResult.ok ? "#E6F7EB" : "#FCE5E5", border: `1px solid ${diagResult.ok ? "#A7E2BB" : "#F6C9C9"}`, borderRadius: 8, padding: "9px 12px", fontSize: 12, fontWeight: 600, color: diagResult.ok ? "#007A29" : "#A81818", lineHeight: 1.5 }}>
              {diagResult.ok ? "" : "⚠ "}{diagResult.text}
            </div>
          )}

          {/* 재발급 버튼 */}
          <button onClick={handleReissue} disabled={diagLoading}
            style={{ marginTop: 12, width: "100%", background: "var(--color-primary)", border: "none", borderRadius: "var(--radius-12)", padding: "12px", color: "#fff", fontSize: 14, fontWeight: 700, cursor: diagLoading ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: diagLoading ? 0.6 : 1, boxShadow: "var(--shadow-strong)" }}>
            <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7 }}>
              <Icon name="refresh" size={15} stroke={2} />{diagLoading ? "재발급 중..." : "알림 재발급"}
            </span>
          </button>

          <div style={{ marginTop: 8, fontSize: 11, color: "var(--color-label-alt)", lineHeight: 1.5 }}>
            ※ 공지 푸시가 안 오면 위 버튼을 누르세요. 권한이 "거부됨"이면 브라우저 주소창의<br/>
            자물쇠 아이콘 → 알림 → <b>허용</b>으로 변경 후 다시 시도해주세요.
          </div>
        </div>

        {/* 🔋 배터리 절전 예외 안내 카드 (작업B, 2026-05-22) — 안드로이드만 노출 */}
        {/* OEM 절전(특히 삼성 딥슬립)이 SW를 잠재워 공지 푸시를 누락시킬 수 있음. */}
        {/* PWA는 시스템 설정을 못 열므로 텍스트 안내만. One UI 버전차 감안해 너무 구체적이지 않게. */}
        {batteryPlatform && (
          <div style={{ background: "var(--color-bg)", borderRadius: "var(--radius-16)", padding: "16px 18px", border: "1px solid var(--color-line)", boxShadow: "var(--shadow-emphasize)" }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--color-label)", marginBottom: 6 }}>
              공지 푸시가 자꾸 안 온다면
            </div>
            <div style={{ fontSize: 12, color: "var(--color-label-mute)", lineHeight: 1.6, marginBottom: 10 }}>
              휴대폰 절전 기능이 BusLink를 잠재우면 공지 알림이 늦거나 누락될 수 있습니다.
              아래처럼 <b style={{ color: "var(--color-label)" }}>BusLink를 절전 예외</b>로 설정해 주세요.
            </div>
            <div style={{ background: "var(--color-bg-soft)", borderRadius: "var(--radius-8)", padding: "12px 14px" }}>
              {batteryPlatform === "samsung" ? (
                <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: "var(--color-label)", lineHeight: 1.7 }}>
                  <li><b>설정</b> → <b>배터리</b> (또는 배터리 및 디바이스 케어 → 배터리)</li>
                  <li><b>백그라운드 사용 제한</b> → <b>사용 안 함 앱</b> 목록에서 BusLink 제거</li>
                  <li>앱별 설정에서 BusLink를 <b>제한 없음</b>으로 변경</li>
                </ol>
              ) : (
                <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: "var(--color-label)", lineHeight: 1.7 }}>
                  <li><b>설정</b> → <b>배터리</b> → 앱 절전 관리 / 배터리 사용량</li>
                  <li>BusLink를 찾아 <b>제한 없음</b> 또는 <b>최적화 안 함</b>으로 변경</li>
                </ol>
              )}
            </div>
            <div style={{ marginTop: 8, fontSize: 11, color: "var(--color-label-alt)", lineHeight: 1.5 }}>
              ※ 휴대폰 기종·소프트웨어 버전에 따라 메뉴 이름이 조금씩 다를 수 있습니다.
            </div>
          </div>
        )}

        {/* 📲 앱 설치하기 (작업C, 2026-05-22) — 3일 스누즈와 무관한 상시 설치 진입점 */}
        <div style={{ background: "var(--color-bg)", borderRadius: "var(--radius-16)", overflow: "hidden", border: "1px solid var(--color-line)", boxShadow: "var(--shadow-emphasize)" }}>
          <button onClick={() => setShowInstallGuide(p => !p)}
            style={{ width: "100%", padding: "14px 18px", background: "transparent", border: "none", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", fontFamily: "inherit", color: "var(--color-label)" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 14, fontWeight: 700 }}>
              <Icon name="download" size={16} stroke={1.9} /> 앱 설치하기
            </span>
            <span style={{ fontSize: 12, color: "var(--color-label-mute)" }}>{showInstallGuide ? "▲" : "▼"}</span>
          </button>
          {showInstallGuide && (
            <div style={{ borderTop: "1px solid var(--color-line)" }}>
              <div style={{ padding: "12px 18px 4px", fontSize: 12, color: "var(--color-label-mute)", lineHeight: 1.6 }}>
                홈 화면에 BusLink를 추가하면 앱처럼 빠르게 실행되고 공지 푸시도 더 잘 도착합니다.
              </div>
              <InstallGuide inline />
            </div>
          )}
        </div>

        {/* PIN 변경 — 공용 계정(pinLocked)은 항목 자체를 감추고 안내만 표시(2026-07-21) */}
        {pinLocked ? (
          <div style={{ background: "var(--color-bg)", borderRadius: "var(--radius-16)", padding: "14px 18px", border: "1px solid var(--color-line)", boxShadow: "var(--shadow-emphasize)" }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--color-label)", marginBottom: 6 }}>PIN 변경 제한</div>
            <div style={{ fontSize: 12, color: "var(--color-label-mute)", lineHeight: 1.6 }}>
              여러 분이 함께 사용하는 계정이라 PIN을 변경할 수 없습니다. PIN 재설정이 필요하면 담당자에게 문의해주세요.
            </div>
          </div>
        ) : (
        <div style={{ background: "var(--color-bg)", borderRadius: "var(--radius-16)", overflow: "hidden", border: "1px solid var(--color-line)", boxShadow: "var(--shadow-emphasize)" }}>
          <button onClick={() => setShowPinChange(p => !p)}
            style={{ width: "100%", padding: "14px 18px", background: "transparent", border: "none", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", fontFamily: "inherit", color: "var(--color-label)" }}>
            <span style={{ fontSize: 14, fontWeight: 700 }}>PIN 변경</span>
            <span style={{ fontSize: 12, color: "var(--color-label-mute)" }}>{showPinChange ? "▲" : "▼"}</span>
          </button>
          {showPinChange && (
            <div style={{ padding: "0 18px 18px", display: "flex", flexDirection: "column", gap: 8, borderTop: "1px solid var(--color-line)" }}>
              <input style={{ ...S.input, marginTop: 12 }} type="password" inputMode="numeric"
                placeholder="현재 PIN" maxLength={6} value={oldPin} onChange={e => setOldPin(e.target.value)} />
              <input style={S.input} type="password" inputMode="numeric"
                placeholder="새 PIN (4~6자리)" maxLength={6} value={newPin} onChange={e => setNewPin(e.target.value)} />
              <input style={S.input} type="password" inputMode="numeric"
                placeholder="새 PIN 확인" maxLength={6} value={confirmPin} onChange={e => setConfirmPin(e.target.value)} />
              <button style={{ ...S.btn, opacity: loading ? 0.6 : 1, cursor: loading ? "not-allowed" : "pointer" }} onClick={handlePinChange} disabled={loading}>
                {loading ? "변경 중..." : "PIN 변경"}
              </button>
            </div>
          )}
        </div>
        )}

        {/* 로그아웃 */}
        <button style={{ background: "var(--color-bg)", border: "1px solid #F6C9C9", borderRadius: "var(--radius-12)", padding: "14px", color: "var(--color-destructive)", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", boxShadow: "var(--shadow-emphasize)" }}
          onClick={() => { if (window.confirm("로그아웃하시겠습니까?")) onLogout(); }}>
          로그아웃
        </button>

        <div style={{ fontSize: 11, color: "var(--color-label-alt)", textAlign: "center" }}>BusLink v1.0 · buslink-prod.web.app</div>
      </div>
    </div>
  );
}

// ─── 스타일 (라이트 — tokens.css 변수 기반, 리디자인 6단계) ──────────
const S = {
  appWrap: { display: "flex", flexDirection: "column", height: "100dvh", maxHeight: "100dvh", background: "var(--color-bg-alt)", fontFamily: "var(--font-base)", color: "var(--color-label)", overflow: "hidden" },
  // position:relative = 도움말 버튼(?)의 배치 기준. 이 상자는 스크롤하지 않으므로
  // (안쪽 탭이 각자 스크롤한다) 절대배치 자식이 탭바 바로 위에 고정된다.
  // 🔴 탭바 높이를 px 로 빼서 fixed 로 두지 말 것 — 기기·안전영역마다 어긋난다.
  content: { flex: 1, display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden", position: "relative" },
  tabBar: { display: "flex", background: "var(--color-bg)", borderTop: "1px solid var(--color-line)", flexShrink: 0, paddingBottom: "env(safe-area-inset-bottom, 0px)", boxShadow: "0 -1px 12px rgba(11,16,32,0.05)" },
  tabBtn: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "8px 0", background: "transparent", border: "none", cursor: "pointer", fontFamily: "inherit", transition: "color .15s" },
  fullCenter: { minHeight: "100vh", background: "var(--color-bg-alt)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-base)", padding: 20 },
  loginCard: { background: "var(--color-bg)", borderRadius: "var(--radius-24)", padding: "32px 28px", width: "100%", maxWidth: 380, display: "flex", flexDirection: "column", gap: 0, boxShadow: "var(--shadow-heavy)", border: "1px solid var(--color-line)" },
  header: { display: "flex", alignItems: "center", gap: 12, marginBottom: 24 },
  input: { background: "var(--color-bg)", border: "1px solid var(--color-line)", borderRadius: "var(--radius-12)", padding: "13px 14px", color: "var(--color-label)", fontSize: 15, outline: "none", fontFamily: "inherit", width: "100%", boxSizing: "border-box" },
  btn: { background: "var(--color-primary)", border: "none", borderRadius: "var(--radius-12)", padding: "15px", color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", width: "100%", boxShadow: "var(--shadow-strong)" },
  btnSecondary: { background: "var(--color-bg-soft)", border: "1px solid var(--color-line)", borderRadius: "var(--radius-12)", padding: "13px", color: "var(--color-label-mute)", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", width: "100%" },
  errorMsg: { background: "var(--color-atomic-red-90)", border: "1px solid rgba(229,34,34,.25)", borderRadius: "var(--radius-8)", padding: "10px 14px", fontSize: 13, color: "#A81818", whiteSpace: "pre-line", marginTop: 8 },
  spinner: { width: 36, height: 36, borderRadius: "50%", border: "3px solid var(--color-line)", borderTopColor: "var(--color-primary)", animation: "spin 0.8s linear infinite" },
};

const style = document.createElement("style");
style.textContent = "@keyframes spin{to{transform:rotate(360deg)}} @keyframes slideDown{from{transform:translateY(-100%)}to{transform:translateY(0)}}";
document.head.appendChild(style);
