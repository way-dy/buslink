import { useState, useEffect, useRef, useCallback } from "react";
import jsQR from "jsqr";
import { initNotifications, listenForegroundMessages } from "../lib/notifications";
import { Map, MapMarker, Polyline, CustomOverlayMap } from "react-kakao-maps-sdk";
import { db, auth } from "../firebase";
import { signInAnonymously } from "firebase/auth";
import {
  doc, getDoc, getDocs, collection, onSnapshot,
  query, where, orderBy, updateDoc, setDoc, serverTimestamp
} from "firebase/firestore";
import { useAnimatedPositions } from "../lib/useAnimatedPositions";
import { calcETA } from "../lib/gps";
import { buildCumulativeLengths, projectToPolyline, pathUpTo, pathFrom } from "../lib/routeProgress";
import { computeStopEstimates, formatDelayLabel, formatPassengerEta, describeEtaSource } from "../lib/stopSchedule";
import { useSmoothedEta } from "../lib/useSmoothedEta";
import { useWakeTick } from "../lib/useWakeTick";
import { useOnlineRecover } from "../lib/useOnlineRecover";

import { validateAndBoard, createPassengerToken } from "../lib/boarding";
import { hashPin } from "../lib/partner";
import QRCode from "qrcode";
import { BusLinkLogo, StatusDot } from "../components/ui";
import InstallPrompt, { InstallGuide } from "../components/InstallPrompt";
import { applyAppManifest } from "../lib/pwaManifest";
import PermissionGate from "../components/PermissionGate";
import { resolveCompanyIdForAnon } from "../lib/companyResolver";
import { useExitConfirm } from "../lib/useExitConfirm";

// ── 경로 진행 판정 임계값 (작업2, 2026-05-18) ──
// 버스 투영 수직거리가 이 값 초과면 경로 이탈로 보고 진행거리 갱신·지나온경로 그리기에서 제외
// (직전 유효 progress 유지) — 우회/잡신호로 진행이 튀는 것 방지(고객 신뢰도 보호).
const OFF_ROUTE_M = 70;
// 버스 progress가 내 정류장 progress + 이 마진을 넘으면 '지나감'(passed) 확정.
const PASSED_MARGIN_M = 40;
// 남은 경로거리가 이 값 미만이면 '곧 도착'(arriving).
const ARRIVING_M = 150;
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
          <span style={{ fontSize: 18 }}>{isEmergency ? "🚨" : "📢"}</span>
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
            onClick={canClose ? onClose : undefined}
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
const TABS = [
  { id: "home",     icon: "🏠", label: "홈" },
  { id: "routes",   icon: "🗺", label: "노선" },
  { id: "notices",  icon: "📢", label: "공지" },
  { id: "scan",     icon: "📷", label: "탑승" },
  { id: "settings", icon: "⚙️", label: "설정" },
];

// ════════════════════════════════════════════════════════
export default function EmployeeApp() {
  // Phase 1.1 (2026-05-28): URL param > hostname 매핑 > dy001.
  // EmployeeApp 의 localStorage `buslink_employee` 는 세션(empNo/name/dept/routeId)
  // 저장용이라 companyId 분리 키는 없음(과거 단일테넌트 전제) — URL+hostname 만 활용.
  const companyId = resolveCompanyIdForAnon({ urlParam: getParam("c") });
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState(null);   // { empNo, name, dept, routeId, pinHash }
  const [tab, setTab] = useState("home");
  const [activeNotice, setActiveNotice] = useState(null); // 공지 배너
  const [notices, setNotices] = useState([]);             // 공지함 목록(필터 후, 최신순)
  const [noticeReadAt, setNoticeReadAt] = useState(0);    // 마지막 공지함 진입 시각(ms)

  // 백그라운드 → foreground 복귀 시 공지 onSnapshot 재구독(stale 리스너 신선화).
  // 통근버스 사용자는 등하교 전후 장시간 백그라운드 상태가 흔함(issues.md useWakeTick 패턴).
  const wakeTick = useWakeTick();

  // 뒤로가기 종료 확인(마운트 시 1회 발판 push, 인증/로딩 분기와 무관).
  useExitConfirm();

  // 익명 인증
  useEffect(() => {
    signInAnonymously(auth).finally(() => setReady(true));
  }, []);

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
      title: "BusLink 직원",
    });
  }, []);

  // 저장된 세션 복원
  useEffect(() => {
    if (!ready) return;
    const s = loadSession();
    if (s?.companyId === companyId) setSession(s);
  }, [ready, companyId]);

  const handleLogin = (s) => {
    const data = { ...s, companyId };
    saveSession(data);
    setSession(data);
  };

  const handleLogout = () => {
    clearSession();
    setSession(null);
    setTab("home");
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
    if (!session?.empNo) return;
    const latest = notices.reduce((m, n) => Math.max(m, noticeCreatedMs(n)), 0);
    const now = Math.max(Date.now(), latest + 1);
    saveNoticeReadAt(session.empNo, now);
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

  if (!ready) return (
    <div style={S.fullCenter}>
      <div style={S.spinner} />
    </div>
  );

  if (!session) return <LoginScreen companyId={companyId} onLogin={handleLogin} />;

  return (
    <div style={S.appWrap}>
      <InstallPrompt />
      {/* ── 강제 공지 모달 — 안 읽음 공지 1건을 풀스크린으로 노출(푸시 누락 대비 도달성 보장 통로) ── */}
      {forceNotice && <NoticeForceModal notice={forceNotice} onClose={markNoticesRead} />}
      {/* ── 공지 배너 — 본문 영역 탭 시 공지함으로 이동(읽음 처리) ── */}
      {activeNotice && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, zIndex: 999,
          background: activeNotice.type === "emergency" ? "var(--color-destructive)" : "var(--color-primary)",
          padding: "10px 14px",
          display: "flex", alignItems: "flex-start", gap: 10,
          boxShadow: "var(--shadow-strong)",
        }}>
          <div onClick={() => { setTab("notices"); markNoticesRead(); }}
            style={{ flex: 1, minWidth: 0, cursor: "pointer" }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: "#fff", marginBottom: 2 }}>
              {activeNotice.type === "emergency" ? "🚨 긴급 공지" : "📢 공지"} · {activeNotice.title}
            </div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,.88)", lineHeight: 1.4 }}>
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
      <div style={{ ...S.content, marginTop: activeNotice ? 60 : 0 }}>
        {tab === "home"     && (
          <>
            <PermissionGate containerStyle={{ flexShrink: 0, padding: "8px 12px 0" }} />
            <HomeTab companyId={companyId} session={session} onScanTab={() => setTab("scan")} onSessionUpdate={(s)=>{saveSession({...session,...s});setSession(p=>({...p,...s}));}} />
          </>
        )}
        {tab === "routes"   && <RoutesTab companyId={companyId} session={session} onSessionUpdate={(s) => { saveSession({...session,...s}); setSession(p=>({...p,...s})); }} />}
        {tab === "notices"  && <NoticesTab notices={notices} unreadCount={unreadCount} />}
        {tab === "scan"     && <ScanTab companyId={companyId} session={session} />}
        {tab === "settings" && <SettingsTab companyId={companyId} session={session} onLogout={handleLogout} onSessionUpdate={(s)=>{saveSession({...session,...s});setSession(p=>({...p,...s}));}} />}
      </div>

      <div style={S.tabBar}>
        {TABS.map(t => (
          <button key={t.id}
            onClick={() => { setTab(t.id); if (t.id === "notices") markNoticesRead(); }}
            style={{ ...S.tabBtn, color: tab === t.id ? "var(--color-primary)" : "var(--color-label-mute)" }}>
            <span style={{ position: "relative", fontSize: 20, display: "inline-flex" }}>
              {t.icon}
              {/* 안 읽음 공지 배지 — 공지 탭에만, 안 읽음 1건 이상일 때 */}
              {t.id === "notices" && unreadCount > 0 && (
                <span style={{
                  position: "absolute", top: -4, right: -8, minWidth: 16, height: 16,
                  padding: "0 4px", borderRadius: 8, background: "var(--color-destructive)",
                  color: "#fff", fontSize: 10, fontWeight: 800, lineHeight: "16px",
                  textAlign: "center", boxShadow: "0 0 0 2px var(--color-bg)"
                }}>
                  {unreadCount > 99 ? "99+" : unreadCount}
                </span>
              )}
            </span>
            <span style={{ fontSize: 10, fontWeight: tab === t.id ? 700 : 500 }}>{t.label}</span>
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
  const [empNo, setEmpNo] = useState("");
  const [pin, setPin] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [isFirst, setIsFirst] = useState(false);

  const handleSubmit = async () => {
    if (!empNo.trim() || pin.length < 4) return;
    setLoading(true); setError("");
    try {
      const ref = doc(db, "companies", companyId, "passengers", empNo.trim());
      const snap = await getDoc(ref);
      if (!snap.exists()) throw new Error("등록되지 않은 사번입니다\n담당자에게 문의하세요");
      const p = snap.data();
      if (!p.active) throw new Error("비활성화된 계정입니다");
      const hashed = await hashPin(pin);
      if (p.pinHash !== hashed) throw new Error("PIN이 올바르지 않습니다");
      onLogin({ empNo: p.empNo, name: p.name, dept: p.dept, routeId: p.routeId, partnerCode: p.partnerCode || null, partnerName: p.partnerName || null, pinHash: hashed, pinInitial: p.pinInitial, favorites: p.favorites || [] });
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  };

  return (
    <div style={S.fullCenter}>
      <div style={S.loginCard}>
        <div style={S.header}>
          <BusLinkLogo size={26} sub="직원 탑승 서비스" />
        </div>
        <div style={{ fontSize: 20, fontWeight: 800, color: "var(--color-label)", letterSpacing: "-0.02em", marginBottom: 4 }}>로그인</div>
        <div style={{ fontSize: 13, color: "var(--color-label-mute)", marginBottom: 18, lineHeight: 1.55 }}>
          사번과 PIN을 입력하세요<br/>
          <span style={{ color: "var(--color-cautionary)", fontWeight: 600 }}>초기 PIN: 000000 (첫 로그인 후 변경 필요)</span>
        </div>
        <input style={S.input} type="tel" inputMode="numeric" placeholder="사번"
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
// 홈 탭 — 내 노선 버스 위치 + ETA
// ════════════════════════════════════════════════════════
function HomeTab({ companyId, session, onScanTab, onSessionUpdate }) {
  const [routes, setRoutes]         = useState([]);
  const [activeRouteId, setActiveRouteId] = useState(session.routeId || null);
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
  const buses = useAnimatedPositions(rawBuses);
  const favorites = session.favorites || [];
  const lastBusProgressRef = useRef(null); // 경로 이탈 시 직전 유효 진행거리 유지

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
      const shown = all.filter(r => r.id === session.routeId || favorites.includes(r.id));
      // 미배정 폴백도 본인 거래처 노선만(타 거래처 노출 차단). partnerCode 미설정 직원은 전체(하위호환).
      const myPartner = session.partnerCode || null;
      const fallback = (myPartner ? all.filter(r => (r.partnerCode || null) === myPartner) : all).slice(0, 3);
      setRoutes(shown.length > 0 ? shown : fallback);
      if (!activeRouteId && shown.length > 0) setActiveRouteId(shown[0].id);
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
  });

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
  }, [companyId, activeRouteId, wakeTick, recoverTick]);

  // ── 오늘 노선 dispatch 구독(stopArrivals 실 도착시각 수신) ────────
  // 활성 노선의 오늘 dispatch 1건(여러개면 첫 건) — driver 측이 도착 감지 시
  // stopArrivals.{stopId} = { actualAt, plannedAt, delaySec } 업데이트.
  // 미설정 노선/dispatch 없음=빈객체→ 폴백 동작(stopSchedule.js 가 처리).
  const [todayDispatch, setTodayDispatch] = useState(null);
  useEffect(() => {
    if (!companyId || !activeRouteId) { setTodayDispatch(null); return; }
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
    const q = query(
      collection(db, 'companies', companyId, 'dispatches', today, 'list'),
      where('routeId', '==', activeRouteId)
    );
    return onSnapshot(q, snap => {
      if (snap.empty) { setTodayDispatch(null); return; }
      // 같은 노선 dispatch 여러건이어도 stopArrivals 병합 — '먼저 도착한' 차량 우선.
      const merged = {};
      snap.docs.forEach(d => {
        const sa = d.data().stopArrivals || {};
        Object.entries(sa).forEach(([sid, v]) => {
          const at = v?.actualAt?.toMillis ? v.actualAt.toMillis() : (typeof v?.actualAt === 'number' ? v.actualAt : null);
          if (at == null) return;
          if (merged[sid] == null || at < merged[sid]) merged[sid] = at;
        });
      });
      setTodayDispatch({ stopArrivals: merged });
    }, () => setTodayDispatch(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, activeRouteId, wakeTick, recoverTick]);

  const mainBus   = buses[0] || null;
  const myStop    = myStopIdx !== null ? stops[myStopIdx] : null;
  const activeRoute = routes.find(r => r.id === activeRouteId) || allRoutes.find(r => r.id === activeRouteId);

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
  let busProgress = null;
  if (busProj) {
    if (busProj.perpDist <= OFF_ROUTE_M) {
      busProgress = busProj.progress;
      lastBusProgressRef.current = busProgress;
    } else {
      busProgress = lastBusProgressRef.current; // 이탈 좌표 제외 — 직전 유효값 유지
    }
  }
  // 내 정류장도 경로에 투영해 진행거리 산출
  const myStopProgress = (usePathProgress && myStop)
    ? projectToPolyline({ lat: myStop.lat, lng: myStop.lng }, routePath, routeCum)?.progress
    : null;

  // ── 노선 순서 기반(폴백용) — 버스→가장 가까운 정류장 인덱스 ──
  const _busStopIdx = (() => {
    if (!mainBus || stops.length === 0) return -1;
    let minDist = Infinity, idx = 0;
    stops.forEach((s, i) => {
      const d = Math.hypot(s.lat - mainBus.lat, s.lng - mainBus.lng);
      if (d < minDist) { minDist = d; idx = i; }
    });
    return idx;
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

  // 버스와 내 정류장 사이로 지도 중심 설정
  useEffect(() => {
    if (mainBus?.lat && myStop?.lat) {
      setCenter({ lat: (mainBus.lat + myStop.lat) / 2, lng: (mainBus.lng + myStop.lng) / 2 });
    } else if (myStop?.lat) {
      setCenter({ lat: myStop.lat, lng: myStop.lng });
    } else if (mainBus?.lat) {
      setCenter({ lat: mainBus.lat, lng: mainBus.lng });
    }
  }, [mainBus?.lat, mainBus?.lng, myStop?.lat, myStop?.lng]);

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

      {/* ── 상단 헤더 ── */}
      <div style={{ background: 'var(--color-bg)', padding: '10px 14px', flexShrink: 0, borderBottom: '1px solid var(--color-line)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-label)' }}>
            {session.name}
            <span style={{ fontSize: 12, color: 'var(--color-label-mute)', fontWeight: 500, marginLeft: 6 }}>{session.dept}</span>
          </div>
          <div style={{ fontSize: 10, color: 'var(--color-label-alt)', textAlign: 'right' }}>
            {lastUpdate && <>{timeSince(lastUpdate)} 갱신<br/></>}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 2, color: buses.length > 0 ? 'var(--color-positive)' : 'var(--color-label-mute)', fontWeight: 600 }}>
              <StatusDot tone={buses.length > 0 ? 'positive' : 'neutral'} size={7} pulse={buses.length > 0} />
              {buses.length > 0 ? `${buses.length}대 운행중` : '운행 없음'}
            </span>
          </div>
        </div>
        {/* 현재 노선 + 노선 변경 진입점 (기준 노선 갱신) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <div style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 700, color: 'var(--color-label)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {activeRoute ? activeRoute.name : '노선을 선택하세요'}
          </div>
          <button onClick={() => { setRouteQuery(''); setRoutePicker(true); }}
            style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 13px', borderRadius: 'var(--radius-pill)', border: '1px solid var(--color-primary)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, fontWeight: 700, background: 'var(--color-primary-soft)', color: 'var(--color-primary-deep)' }}>
            🔄 노선 변경
          </button>
        </div>
        {/* 노선 칩 (배정+즐겨찾기 복수일 때 — 빠른 전환, 영속 아님) */}
        {routes.length > 1 && (
          <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginTop: 8, paddingBottom: 2 }}>
            {routes.map(r => (
              <button key={r.id} onClick={() => { setActiveRouteId(r.id); setMyStopIdx(null); }}
                style={{ flexShrink: 0, padding: '4px 12px', borderRadius: 'var(--radius-pill)', border: `1px solid ${activeRouteId === r.id ? 'var(--color-primary)' : 'var(--color-line)'}`, cursor: 'pointer',
                  fontFamily: 'inherit', fontSize: 11, fontWeight: 600,
                  background: activeRouteId === r.id ? 'var(--color-primary)' : 'var(--color-bg-soft)',
                  color: activeRouteId === r.id ? '#fff' : 'var(--color-label-mute)' }}>
                {r.name.length > 14 ? r.name.substring(0,14)+'…' : r.name}
              </button>
            ))}
          </div>
        )}
      </div>

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
      <div style={{ flex: '0 0 55%', minHeight: 0, position: 'relative' }}>
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
                onClick={() => setStopInfo({ ...s, idx: i })}
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
                <div onClick={() => setStopInfo({ ...s, idx: i })}
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
                  <div>{isMyStop ? '📍 ' : isFirst ? '출 ' : isLast ? '도 ' : ''}{s.name.length > 10 ? s.name.substring(0,10)+'…' : s.name}</div>
                  {timeLabel && (
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
            <CustomOverlayMap key={b.id} position={{ lat: b.lat, lng: b.lng }} yAnchor={1.5}>
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
                  fontSize: 16, boxShadow: '0 0 0 4px rgba(0,102,255,.30), 0 6px 20px rgba(0,102,255,0.45)',
                  cursor: 'default'
                }}>
                  🚌
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
            📍 아래 노선도에서 내 정류장을 클릭하세요
          </div>
        )}
      </div>

      {/* ── 노선도 스트립 (중간) ── */}
      <div style={{ background: 'var(--color-bg)', borderTop: '1px solid var(--color-line)', borderBottom: '1px solid var(--color-line)', flexShrink: 0, padding: '10px 0' }}>
        {stops.length === 0 ? (
          <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--color-label-alt)', padding: '4px 0' }}>
            {activeRoute ? '정류장 정보가 없습니다' : '노선을 선택해주세요'}
          </div>
        ) : (
          /* 가로 스크롤 — 폰트 키움으로 가로 공간 부족 가능, 스크롤바 숨김(모바일 친화) */
          <div data-route-strip style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', paddingBottom: 4 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', paddingLeft: 16, paddingRight: 16, minWidth: 'max-content', gap: 0 }}>
              {stops.map((s, i) => {
                const isMyStop  = myStopIdx === i;
                const isFirst   = i === 0;
                const isLast    = i === stops.length - 1;
                const isBusHere = busStopIdx === i;
                const isPassed  = myStopIdx !== null && i < myStopIdx && busStopIdx >= 0 && i <= busStopIdx;
                // 버스가 이 정류장과 다음 정류장 사이에 있는지 (노선도에 버스 아이콘 표시)
                const showBusBetween = busStopIdx === i && !isBusHere;

                return (
                  <div key={s.id} style={{ display: 'flex', alignItems: 'center' }}>
                    {/* 정류장 노드 — 폰트/점 크기 키움(모바일 시인성) */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 78 }}
                      onClick={() => {
                        // 같은 정류장을 다시 누르면 해제(토글), 아니면 선택. 둘 다 fcmTokens 영속.
                        if (isMyStop) { selectMyStop(null); }
                        else { selectMyStop(i); setCenter({ lat: s.lat, lng: s.lng }); }
                      }}>
                      {/* 버스 아이콘 (이 정류장 근처) — 펄스 ring + 키운 크기 */}
                      <div style={{ height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 2 }}>
                        {isBusHere && (
                          <div style={{ position: 'relative', width: 24, height: 24 }}>
                            <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'var(--color-primary)', opacity: 0.5, animation: 'buspulse 2s ease-out infinite', pointerEvents: 'none' }} />
                            <div style={{ position: 'absolute', inset: 0, background: 'var(--color-primary)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, color: '#fff', boxShadow: '0 0 0 4px rgba(0,102,255,.40), 0 4px 12px rgba(0,102,255,.45)' }}>🚌</div>
                          </div>
                        )}
                      </div>
                      {/* 정류장 원 — 시인성 키움(10→11, 14→15, 18→20) */}
                      <div style={{
                        width: isMyStop ? 20 : isFirst||isLast ? 15 : 11,
                        height: isMyStop ? 20 : isFirst||isLast ? 15 : 11,
                        borderRadius: '50%', flexShrink: 0,
                        background: isMyStop ? 'var(--color-primary)' : isBusHere ? 'var(--color-primary)' : isFirst ? 'var(--color-positive)' : isLast ? 'var(--color-destructive)' : 'var(--color-primary)',
                        border: isMyStop ? '2px solid #fff' : '2px solid var(--color-bg)',
                        boxShadow: isMyStop ? '0 0 0 3px rgba(0,102,255,.30)' : 'var(--shadow-emphasize)',
                        cursor: 'pointer'
                      }} />
                      {/* 정류장 이름 — 13px·700 으로 키움. 길이 길면 한 줄 ellipsis */}
                      <div style={{
                        fontSize: 13, marginTop: 6, textAlign: 'center', width: 72,
                        color: isMyStop ? 'var(--color-primary)' : isFirst ? 'var(--color-positive)' : isLast ? 'var(--color-destructive)' : 'var(--color-label)',
                        fontWeight: isMyStop ? 900 : isFirst||isLast ? 800 : 700,
                        wordBreak: 'keep-all', lineHeight: 1.25,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                      }}>
                        {s.name}
                      </div>
                      {isMyStop && <div style={{ color: 'var(--color-primary)', fontSize: 10, fontWeight: 800, marginTop: 1 }}>내 정류장</div>}
                    </div>

                    {/* 연결선 (마지막 제외) — 정류장 원 위치(상단 28px[버스슬롯]+상단여백) 맞춤 */}
                    {!isLast && (
                      <div style={{
                        width: 28, height: 3, flexShrink: 0, marginTop: -28,
                        background: busStopIdx >= 0 && i < busStopIdx ? 'var(--color-primary)' : 'var(--color-line)',
                        borderRadius: 2, position: 'relative'
                      }}>
                        {/* 버스가 이 구간(i → i+1) 이동 중 — 키움 + 펄스 */}
                        {busStopIdx === i && mainBus && (
                          <div style={{ position: 'absolute', top: -10, left: '40%', width: 20, height: 20 }}>
                            <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'var(--color-primary)', opacity: 0.5, animation: 'buspulse 2s ease-out infinite', pointerEvents: 'none' }} />
                            <div style={{ position: 'absolute', inset: 0, background: 'var(--color-primary)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: '#fff', boxShadow: '0 0 0 3px rgba(0,102,255,.40)' }}>🚌</div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ── 하단 ETA + QR 패널 ── */}
      <div style={{ background: 'var(--color-bg)', flexShrink: 0, padding: '12px 14px', borderTop: '1px solid var(--color-line)' }}>
        {myStop ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, color: 'var(--color-label-mute)', marginBottom: 2, fontWeight: 600 }}>
                📍 {myStop.name}
              </div>
              <div style={{ fontSize: 24, fontWeight: 900, color: etaDisplayColor, lineHeight: 1.1 }}>
                {etaStatus.type === 'passed'
                  ? (isDestStop ? '목적지 도착 완료' : '이미 지나침')
                  : etaStatus.type === 'arriving'
                    ? (isDestStop ? '🏁 목적지 도착' : '🚌 곧 도착!')
                    : etaStatus.type === 'approaching' && passengerLabel
                      ? (isDestStop
                          ? (passengerLabel.bucket === 'soon' ? '🏁 목적지 도착' : `목적지까지 ${passengerLabel.primary}`)
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
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, flexShrink: 0 }}>
              <button onClick={onScanTab}
                style={{ background: 'var(--color-primary)', border: 'none', borderRadius: 'var(--radius-12)', padding: '10px 16px', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', boxShadow: 'var(--shadow-strong)' }}>
                📱 QR 탑승
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
              📱 QR 탑승
            </button>
          </div>
        )}
      </div>

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
                <input style={{ ...S.input, marginTop: 10 }} placeholder="🔍 노선명·구분·코드 검색"
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
                        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-label)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name || r.id}</span>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--color-label-mute)', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {r.departTime && <span>🕒 {r.departTime}</span>}
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
                📍 이 정류장을 내 정류장으로 설정
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
            <div style={{ fontSize: 48, marginBottom: 12 }}>🚌</div>
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
  const [stopModal, setStopModal] = useState(null);     // 정류장+지도 바텀시트
  const [modalStops, setModalStops] = useState([]);
  const [modalBuses, setModalBuses] = useState([]);      // 해당 노선 실시간 버스
  const [modalMapView, setModalMapView] = useState(false); // 바텀시트 내 지도 토글
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

  // 선택 노선 오늘 dispatch stopArrivals 구독 — 모달 정류장 목록 계획·예상 시간 표시용.
  const [modalDispatch, setModalDispatch] = useState(null);
  useEffect(() => {
    if (!stopModal || !companyId) { setModalDispatch(null); return; }
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
    const q = query(
      collection(db, "companies", companyId, "dispatches", today, "list"),
      where("routeId", "==", stopModal.id)
    );
    return onSnapshot(q, snap => {
      if (snap.empty) { setModalDispatch(null); return; }
      const merged = {};
      snap.docs.forEach(d => {
        const sa = d.data().stopArrivals || {};
        Object.entries(sa).forEach(([sid, v]) => {
          const at = v?.actualAt?.toMillis ? v.actualAt.toMillis() : (typeof v?.actualAt === 'number' ? v.actualAt : null);
          if (at == null) return;
          if (merged[sid] == null || at < merged[sid]) merged[sid] = at;
        });
      });
      setModalDispatch({ stopArrivals: merged });
    }, () => setModalDispatch(null));
  }, [stopModal, companyId, wakeTick]);

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

  const filtered = routes.filter(r => {
    if (filter === "즐겨찾기" && !favorites.includes(r.id)) return false;
    if (filter === "운행중" && !gpsData[r.id]) return false;
    if (filter !== "전체" && filter !== "즐겨찾기" && filter !== "운행중" && r.type !== filter) return false;
    if (search && !r.name.includes(search) && !r.code?.includes(search)) return false;
    return true;
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden", background: "var(--color-bg-alt)" }}>
      <div style={{ background: "var(--color-bg)", padding: "14px 16px", borderBottom: "1px solid var(--color-line)" }}>
        <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 10, color: "var(--color-label)", letterSpacing: "-0.02em" }}>노선 목록</div>
        <input style={{ ...S.input, marginBottom: 10 }} placeholder="🔍 노선명·코드 검색"
          value={search} onChange={e => setSearch(e.target.value)} />
        <div style={{ display: "flex", gap: 6, overflowX: "auto" }}>
          {["전체", "즐겨찾기", "운행중", "출근", "퇴근"].map(f => (
            <button key={f} onClick={() => setFilter(f)}
              style={{ flexShrink: 0, padding: "5px 13px", borderRadius: "var(--radius-pill)", border: `1px solid ${filter === f ? "var(--color-primary)" : "var(--color-line)"}`, cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 600,
                background: filter === f ? "var(--color-primary)" : "var(--color-bg-soft)",
                color: filter === f ? "#fff" : "var(--color-label-mute)" }}>
              {f === "즐겨찾기" ? `⭐ ${f}` : f === "운행중" ? `🟢 ${f}` : f}
              {f === "즐겨찾기" && favorites.length > 0 ? ` ${favorites.length}` : ""}
            </button>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px" }}>
        {filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: 40, color: "var(--color-label-alt)", fontSize: 13, whiteSpace: "pre-line" }}>
            {filter === "즐겨찾기" ? "즐겨찾기한 노선이 없습니다\n노선 옆 ⭐를 눌러 추가하세요" : "해당하는 노선이 없습니다"}
          </div>
        ) : filtered.map(r => (
          <div key={r.id} style={{ background: "var(--color-bg)", border: `1px solid ${favorites.includes(r.id) ? "var(--color-cautionary)" : "var(--color-line)"}`, borderRadius: "var(--radius-16)", padding: "14px 16px", marginBottom: 10, boxShadow: "var(--shadow-emphasize)" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <span style={{ fontSize: 10, padding: "3px 9px", borderRadius: "var(--radius-pill)", background: r.type === "출근" ? "var(--color-primary-soft)" : "var(--color-atomic-orange-90)", color: r.type === "출근" ? "var(--color-primary-deep)" : "#B95300", fontWeight: 600 }}>
                    {r.type}
                  </span>
                  {r.shift && <span style={{ fontSize: 10, color: "var(--color-label-mute)" }}>{r.shift}</span>}
                  {r.code && <span style={{ fontSize: 10, color: "var(--color-label-mute)", fontFamily: "var(--font-mono)" }}>{r.code}</span>}
                  {gpsData[r.id] && (
                    <span style={{ fontSize: 10, padding: "3px 9px", borderRadius: "var(--radius-pill)", background: "#E6F7EB", color: "#007A29", fontWeight: 600 }}>
                      🟢 {gpsData[r.id]}대 운행중
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "var(--color-label)", marginBottom: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.name}
                </div>
                <div style={{ fontSize: 12, color: "var(--color-label-mute)" }}>
                  출발 {r.departTime} · 좌석 {r.seats || "–"}석
                </div>
              </div>
              {/* 즐겨찾기 버튼 */}
              <button onClick={() => toggleFavorite(r.id)}
                style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 22, padding: 4, flexShrink: 0 }}>
                {favorites.includes(r.id) ? "⭐" : "☆"}
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
                <button onClick={(e) => { e.stopPropagation(); setStopModal(r); setModalMapView(false); }}
                  style={{ fontSize: 11, color: "var(--color-label-mute)", background: "var(--color-bg-soft)", border: "1px solid var(--color-line)", borderRadius: "var(--radius-6)", padding: "4px 10px", cursor: "pointer", fontFamily: "inherit" }}>
                  📍 정류장
                </button>
                <button onClick={(e) => { e.stopPropagation(); setStopModal(r); setModalMapView(true);
                    if (modalStops.length > 0) setModalCenter({ lat: modalStops[0].lat, lng: modalStops[0].lng });
                  }}
                  style={{ fontSize: 11, color: gpsData[r.id] ? "#007A29" : "var(--color-label-mute)", background: gpsData[r.id] ? "#E6F7EB" : "var(--color-bg-soft)", border: gpsData[r.id] ? "1px solid rgba(0,191,64,.3)" : "1px solid var(--color-line)", borderRadius: "var(--radius-6)", padding: "4px 10px", cursor: "pointer", fontFamily: "inherit" }}>
                  🗺 {gpsData[r.id] ? `${gpsData[r.id]}대 운행중` : "지도"}
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
                        🚌 {modalBuses.length}대 운행중
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize:15, fontWeight:800, color:"var(--color-label)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{stopModal.name}</div>
                  <div style={{ fontSize:11, color:"var(--color-label-mute)" }}>출발 {stopModal.departTime}</div>
                </div>
                <button onClick={() => setStopModal(null)}
                  style={{ background:"var(--color-bg-soft)", border:"1px solid var(--color-line)", borderRadius:"var(--radius-8)", padding:"6px 12px", color:"var(--color-label-mute)", cursor:"pointer", fontFamily:"inherit", fontSize:12, flexShrink:0, marginLeft:8 }}>
                  닫기
                </button>
              </div>

              {/* 보기 모드 전환 탭 */}
              <div style={{ display:"flex", gap:6, marginTop:10, background:"var(--color-bg-soft)", borderRadius:"var(--radius-8)", padding:3 }}>
                {[["list","📋 정류장 목록"],["map","🗺 실시간 지도"]].map(([v,label])=>(
                  <button key={v} onClick={()=>setModalMapView(v==="map")}
                    style={{ flex:1, padding:"8px", border:"none", borderRadius:"var(--radius-6)", cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight:600,
                      background: (modalMapView ? v==="map" : v==="list") ? "var(--color-primary)" : "transparent",
                      color: (modalMapView ? v==="map" : v==="list") ? "#fff" : "var(--color-label-mute)" }}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* ── 정류장 목록 보기 ── */}
            {!modalMapView && (
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
                                {lab.label && lab.tone !== 'mute' && (
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
            {modalMapView && (
              <div style={{ flex:1, minHeight:300, position:"relative" }}>
                <Map center={modalCenter} style={{ width:"100%", height:"100%" }} level={9}
                  onCreate={map => { map.relayout(); setTimeout(() => map.relayout(), 300); }}
                  onCenterChanged={map => setModalCenter({ lat: map.getCenter().getLat(), lng: map.getCenter().getLng() })}>

                  {/* 노선 폴리라인 */}
                  {modalStops.length >= 2 && (
                    <Polyline
                      path={modalStops.map(s=>({ lat:s.lat, lng:s.lng }))}
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

                  {/* 실시간 버스 마커 */}
                  {modalBuses.map(b => b.lat && b.lng && (
                    <CustomOverlayMap key={b.id} position={{ lat:b.lat, lng:b.lng }} yAnchor={1.7}>
                      <div style={{ background:"var(--color-bg)", border:"2px solid var(--color-primary)", borderRadius:"var(--radius-pill)", padding:"5px 11px", display:"flex", alignItems:"center", gap:5, boxShadow:"var(--shadow-float)" }}>
                        <span style={{ fontSize:14 }}>🚌</span>
                        <div>
                          <div style={{ fontSize:11, fontWeight:800, color:"var(--color-primary)" }}>{b.vehicleNo||b.vehicleId}</div>
                          <div style={{ fontSize:10, color:"var(--color-label-mute)" }}>{b.speed??0} km/h</div>
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
            <div style={{ fontSize: 36, marginBottom: 8 }}>📭</div>
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
                  {emergency ? "🚨 긴급" : "📢 공지"}
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
              🔄 즉시 갱신
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
      let token = rawValue.trim();
      try { token = new URL(rawValue).searchParams.get("t") || token; } catch {}
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
      await validateAndBoard({ tokenId: scannedToken, empNo: session.empNo, name: session.name });
      if ("vibrate" in navigator) navigator.vibrate([100, 50, 100]);
      setStep("success");
    } catch (e) { setErrMsg(e.message); setStep("error"); }
  };

  const reset = () => {
    stopStream();
    setStep("ready"); setScannedToken(null); setTokenData(null);
    setErrMsg(""); setScanStatus("");
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", flex:1, overflow:"hidden", background:"var(--color-bg-alt)" }}>
      <div style={{ background:"var(--color-bg)", padding:"14px 16px", borderBottom:"1px solid var(--color-line)" }}>
        <div style={{ fontSize:16, fontWeight:800, color:"var(--color-label)", letterSpacing:"-0.02em" }}>QR 탑승</div>
        <div style={{ fontSize:12, color:"var(--color-label-mute)", marginTop:2 }}>기사 폰의 QR코드를 스캔하세요</div>
      </div>

      <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:24, gap:20, overflowY:"auto" }}>

        {/* ── 준비 화면 ── */}
        {step === "ready" && (
          <>
            <div style={{ width:90, height:90, borderRadius:"50%", background:"var(--color-primary-soft)", border:"2px solid var(--color-primary)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:40 }}>📷</div>
            <div style={{ textAlign:"center" }}>
              <div style={{ fontSize:17, fontWeight:800, color:"var(--color-label)", marginBottom:6 }}>탑승 QR 스캔</div>
              <div style={{ fontSize:13, color:"var(--color-label-mute)", lineHeight:1.6 }}>
                {session.name} ({session.empNo})<br/>으로 탑승 처리됩니다
              </div>
            </div>
            <button style={{ ...S.btn, maxWidth:280 }} onClick={startScan}>
              📷 카메라 열기
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
                <span style={{ fontSize:22 }}>✅</span>
                <div style={{ fontSize:14, fontWeight:800, color:"#007A29" }}>QR 인식 완료</div>
              </div>
              {[["노선",tokenData.routeName],["차량",tokenData.vehicleNo],["탑승자",`${session.name} (${session.empNo})`],["부서",session.dept||"–"]].map(([k,v])=>(
                <div key={k} style={{ display:"flex", justifyContent:"space-between", padding:"8px 0", borderBottom:"1px solid var(--color-line)" }}>
                  <span style={{ fontSize:12, color:"var(--color-label-mute)" }}>{k}</span>
                  <span style={{ fontSize:13, fontWeight:700, color:"var(--color-label)" }}>{v}</span>
                </div>
              ))}
            </div>
            <button style={{ ...S.btn, marginBottom:8 }} onClick={handleBoard}>✅ 탑승 확인</button>
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
            <div style={{ fontSize:22, fontWeight:800, color:"#007A29" }}>탑승 완료!</div>
            <div style={{ fontSize:14, color:"var(--color-label)", fontWeight:700 }}>{session.name} ({session.dept})</div>
            <div style={{ fontSize:12, color:"var(--color-label-mute)" }}>{new Date().toLocaleTimeString("ko-KR")}</div>
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

function SettingsTab({ companyId, session, onLogout, onSessionUpdate }) {
  const [showPinChange, setShowPinChange] = useState(session.pinInitial || false);
  const [oldPin, setOldPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState(session.pinInitial ? { type:"warn", text:"초기 PIN(000000)을 사용 중입니다. 변경해주세요." } : null);

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
    if (newPin.length < 4) return setMsg({ type:"error", text:"PIN은 4자리 이상이어야 합니다" });
    if (newPin !== confirmPin) return setMsg({ type:"error", text:"새 PIN이 일치하지 않습니다" });
    setLoading(true); setMsg(null);
    try {
      const oldHash = await hashPin(oldPin);
      if (oldHash !== session.pinHash) throw new Error("현재 PIN이 올바르지 않습니다");
      const newHash = await hashPin(newPin);
      await updateDoc(doc(db, "companies", companyId, "passengers", session.empNo), {
        pinHash: newHash, pinInitial: false,
      });
      onSessionUpdate({ pinHash: newHash, pinInitial: false });
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
          {[["이름", session.name], ["사번", session.empNo], ["부서", session.dept || "–"], ["배정 노선", session.routeId || "–"]].map(([k,v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid var(--color-line)" }}>
              <span style={{ fontSize: 13, color: "var(--color-label-mute)" }}>{k}</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: "var(--color-label)" }}>{v}</span>
            </div>
          ))}
        </div>

        {/* PIN 변경 */}
        {msg && (
          <div style={{ background: msg.type==="error"?"var(--color-atomic-red-90)":msg.type==="warn"?"var(--color-atomic-orange-90)":"#E6F7EB", border: `1px solid ${msg.type==="error"?"rgba(229,34,34,.25)":msg.type==="warn"?"rgba(255,122,0,.25)":"rgba(0,191,64,.3)"}`, borderRadius: "var(--radius-8)", padding: "10px 14px", fontSize: 13, fontWeight: 600, color: msg.type==="error"?"#A81818":msg.type==="warn"?"#B95300":"#007A29" }}>
            {msg.text}
          </div>
        )}

        {/* 🔔 알림 진단 카드 (2026-05-21) — 권한·토큰 자가 점검·재발급 */}
        <div style={{ background: "var(--color-bg)", borderRadius: "var(--radius-16)", padding: "16px 18px", border: "1px solid var(--color-line)", boxShadow: "var(--shadow-emphasize)" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--color-label)", marginBottom: 12 }}>🔔 알림 진단</div>

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
              {diagResult.ok ? "✅ " : "⚠ "}{diagResult.text}
            </div>
          )}

          {/* 재발급 버튼 */}
          <button onClick={handleReissue} disabled={diagLoading}
            style={{ marginTop: 12, width: "100%", background: "var(--color-primary)", border: "none", borderRadius: "var(--radius-12)", padding: "12px", color: "#fff", fontSize: 14, fontWeight: 700, cursor: diagLoading ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: diagLoading ? 0.6 : 1, boxShadow: "var(--shadow-strong)" }}>
            {diagLoading ? "재발급 중..." : "🔄 알림 재발급"}
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
              🔋 공지 푸시가 자꾸 안 온다면
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
            <span style={{ fontSize: 14, fontWeight: 700 }}>📲 앱 설치하기</span>
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

        <div style={{ background: "var(--color-bg)", borderRadius: "var(--radius-16)", overflow: "hidden", border: "1px solid var(--color-line)", boxShadow: "var(--shadow-emphasize)" }}>
          <button onClick={() => setShowPinChange(p => !p)}
            style={{ width: "100%", padding: "14px 18px", background: "transparent", border: "none", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", fontFamily: "inherit", color: "var(--color-label)" }}>
            <span style={{ fontSize: 14, fontWeight: 700 }}>🔐 PIN 변경</span>
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
  content: { flex: 1, display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" },
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
