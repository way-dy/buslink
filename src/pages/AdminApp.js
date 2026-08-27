import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import QRCode from "qrcode";
import { Map, MapMarker, Polyline, CustomOverlayMap, Circle } from "react-kakao-maps-sdk";
import { db, auth } from "../firebase";
import { signOut } from "firebase/auth";
import { getFunctions, httpsCallable } from "firebase/functions";
import {
  collection, onSnapshot, query, where,
  doc, addDoc, updateDoc, deleteDoc, getDoc, getDocs, orderBy
} from "firebase/firestore";
import { useAnimatedPositions } from "../lib/useAnimatedPositions";
import { compareRoutes, seatUsage } from "../lib/routeOrder";
// 배차 일정 수정 후 남는 펼침 배차 정리(2026-08-12) — 순수 판정, 서버 shouldExpand 미러
import {
  PRUNE_LOOKAHEAD_DAYS, todayKST, upcomingDates, selectPrunableDispatches, selectUpdatableDispatches,
} from "../lib/dispatchSchedule";
import { sendGPS } from "../lib/gps";
import { toLatLngPath } from "../lib/routeProgress";
// 운행 이력 GPS 궤적 분해(2026-08-18) — 연속 구간/신호 공백/표본 간격 실측
import { trackSegments, formatDuration, TRACK_GAP_SEC } from "../lib/gpsTrack";
import { forceReconnect } from "../lib/forceReconnect";
import { pendingSleepChecks, sleepCheckSummary, formatWaited, sleepCheckAudit, sleepAuditLabel, sleepCheckRoutes, sleepCheckRows, sleepCheckedAtLabel, sleepCheckPlaceLabel, sleepCheckViaLabel, sleepCheckedAt } from "../lib/sleepingCheck";
import { classifyRunSignals, STALE_SIGNAL_MIN } from "../lib/runSignals";
import { forceEndRun } from "../lib/forceEndRun";
import { createPartnerCode, getBoardingUrl } from "../lib/partner";
// 정적(고정) QR — 차량별 인쇄용 URL 생성(2026-07-08 RQ#3)
import { getStaticBoardingUrl, getSleepCheckUrl } from "../lib/boarding";
import { formatNfcUid } from "../lib/nfc";
import { sendNotice } from "../lib/notifications";
import { compressImageFile } from "../lib/image";
// 개선 요청 게시판(2026-07-13) — 순수 data-access + 상수 + 인앱 안읽음(클라 전용)
import {
  improvementQuery, createRequest, updateRequestStatus, addRequestComment, deleteRequest,
  IMPROVEMENT_STATUSES, IMPROVEMENT_STATUS_LABELS, IMPROVEMENT_STATUS_TONE,
} from "../lib/improvementRequests";
import { loadSeenMap, markSeen, isUnread } from "../lib/improvementSeen";
// 개선 요청 본문 리치 텍스트(인라인 이미지 data URI) — 정화·유틸 + 경량 에디터
import { sanitizeContentHtml, looksLikeHtml, htmlToPlainText, htmlByteSize, contentHasImage } from "../lib/richText";
import RichTextEditor from "../components/RichTextEditor";
import { planTimeForStop, offsetMinFromPlanTime, computeStopEstimates, formatDelayLabel } from "../lib/stopSchedule";
import { aggregateBoardingsByStop } from "../lib/stopMapping";
// 리디자인 3단계 — 실시간 관제(MapTab) 라이트 리스킨 전용. 타 탭 미사용.
import { BusLinkLogo, Pill, StatusDot, Icon } from "../components/ui";
// 협력사 필터 공통 컴포넌트 — 다수 탭에서 재사용
import { PartnerFilter } from "../components/PartnerFilter";
// Phase B(2026-06-08) admin별 협력사 권한 게이팅 헬퍼(순수)
import { resolveAllowed, isAllAccess, partnerCodeAllowed, SEAT_MODES, SEAT_MODE_LABELS, seatReservationMode, canEnableSeatReservation } from "../lib/partnerAccess";
// 포탈 설정 모달(협력사 브랜딩 검증·미리보기) — 2026-07-16 회의 #3·#5
import { isValidHexColor, mixHex, THEME_PRESETS, resolveTheme, readableOn } from "../lib/partnerBranding";
// 문의 게시판(2026-08-06 미팅) — 거래처별 dycs CS 위젯 매핑.
import { resolveInquiryConfig, isValidTenantId, buildInquiryPreviewUrl } from "../lib/inquiry";
import { isValidHomepageUrl, resolveHomepageConfig } from "../lib/homepage";
import { resolveTagSoundConfig } from "../lib/tagSound";
import { normalizeWindowOpts, WINDOW_PRE_MIN_DEFAULT, WINDOW_POST_MIN_DEFAULT } from "../lib/routeWindow";
// 탭 단위 에러 경계 — 자식 throw 시 흰 화면 방지 + 에러 메시지 가시화
import { ErrorBoundary } from "../components/ErrorBoundary";
// 관제도 PWA 설치 자동 안내(2026-05-27) — PC Chrome 에서 "앱 설치" 버튼 노출.
import InstallPrompt from "../components/InstallPrompt";
import { applyAppManifest } from "../lib/pwaManifest";

// ⚠ 탭 추가는 **배열 끝에만**. 아래 렌더 분기가 `tab === 0..N` 하드코딩이라 중간 삽입 시
//   전 탭이 밀려 다른 화면이 뜬다(개선 요청 딥링크 `?imp=` 포함). 2026-07-22 부정승차 추가.
const TABS = ["대시보드", "실시간 관제", "배차 관리", "배차 일정", "노선 관리", "기사 관리", "차량 관리", "시뮬레이터", "운행 이력", "탑승 통계", "협력사 관리", "공지 발송", "개선 요청", "부정승차", "빈 차 확인"];
const TAB_ICONS = ["grid", "pin", "flag", "calendar", "route", "user", "bus", "play", "clock", "chart", "globe", "bell", "sparkle", "eye"];
// "개선 요청"(인덱스 12) = 모든 admin/superadmin 노출(회사관리처럼 superadmin 한정 아님).
// SUPER_TAB_INDEX 는 TABS.length 로 동적 계산 → 회사 관리 탭은 자동으로 13 으로 밀림.

// SaaS Phase 1.2 (2026-05-28) — 슈퍼관리자 전용 추가 탭(인덱스 12).
// 일반 admin 에는 노출하지 않으므로 TABS/TAB_ICONS 원본 배열은 절대 불변.
const SUPER_TAB_LABEL = "회사 관리";
const SUPER_TAB_ICON = "globe";
const SUPER_TAB_INDEX = TABS.length;   // 12
const IMPROVE_TAB_INDEX = TABS.indexOf("개선 요청");   // 12

// 구글챗 알림 딥링크(2026-07-21) — 알림 카드의 "이 요청 열기" 버튼이
// `https://admin.buslink.co.kr/?imp=<요청id>` 로 들어온다. 진입 시 개선 요청 탭을
// 자동 선택하고 그 요청 상세를 연 뒤 주소창 파라미터를 지운다(새로고침 시 재오픈 방지).
// 파라미터가 없으면 기존 동작 100%(탭 0 대시보드) — 회귀 0.
function readImproveDeepLinkId() {
  try {
    return (new URLSearchParams(window.location.search).get("imp") || "").trim() || null;
  } catch { return null; }
}
function clearImproveDeepLinkParam() {
  try {
    const u = new URL(window.location.href);
    if (!u.searchParams.has("imp")) return;
    u.searchParams.delete("imp");
    window.history.replaceState({}, "", u.pathname + u.search + u.hash);
  } catch { /* 주소창 정리는 부가 기능 — 실패해도 무시 */ }
}
const functions = getFunctions(undefined, "us-central1");
const getToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());

// "YYYY-MM-DD" → 그 날짜 로컬 시작시각(00:00:00) millis.
// 과거 배차 조회 시 computeStopEstimates 의 계획시각 앵커(now 의 날짜)를 조회 날짜에
// 맞추기 위함 — 안 맞추면 계획(오늘 날짜)−실측(과거 날짜) 절대차가 며칠짜리 "조기도착
// 수천분" 으로 표시된다. 시작시각(자정)을 쓰는 이유 = 미통과 정류장의 과거금지 클램프
// (est ≥ now)가 그 날 계획/체인값을 밀어올리지 않게 함(자정 기준이라 그날 내내 미래).
// 형식 불량 시 오늘(Date.now) 폴백.
const parseDateStartMs = (dateStr) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || "");
  if (!m) return Date.now();
  return new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0, 0).getTime();
};

function useVehicles(companyId) {
  const [vehicles, setVehicles] = useState([]);
  useEffect(() => {
    if (!companyId) return;
    return onSnapshot(collection(db, "companies", companyId, "vehicles"), snap => {
      setVehicles(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });
  }, [companyId]);
  return vehicles;
}

function useDrivers(companyId) {
  const [drivers, setDrivers] = useState([]);
  useEffect(() => {
    if (!companyId) return;
    return onSnapshot(collection(db, "companies", companyId, "drivers"), snap => {
      setDrivers(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });
  }, [companyId]);
  return drivers;
}

function timeSince(ts) {
  if (!ts) return "–";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 10) return "방금";
  if (sec < 60) return `${sec}초 전`;
  if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
  return `${Math.floor(sec / 3600)}시간 전`;
}

// gps 문서 신선도 — updatedAt(serverTimestamp, gps.js:77) 이 ~60초 이내면 fresh.
// null/pending(쓰기 직후 serverTimestamp 미해결) = 0=방금=fresh 취급.
const GPS_FRESH_MS = 60000;
function gpsAgeMs(updatedAt) {
  if (!updatedAt) return 0;
  if (updatedAt.toMillis) return Date.now() - updatedAt.toMillis();
  const d = updatedAt.toDate ? updatedAt.toDate() : new Date(updatedAt);
  const ms = d.getTime();
  return isNaN(ms) ? 0 : Date.now() - ms;
}
function isGpsFresh(updatedAt) {
  return gpsAgeMs(updatedAt) < GPS_FRESH_MS;
}
// 지도 마커의 "신호 지연" 표시 임계(2026-08-18). 목록의 isGpsFresh(60초)와 일부러 다르다 —
// 단말(유비칸) 차량은 서버 폴러가 1분 주기라 60초 잣대로는 마커가 매 분 회색↔파랑으로 깜빡인다.
const MARKER_STALE_MS = 5 * 60 * 1000;

// ═══════════════════════════════════════════════════════
export default function AdminApp({ user, companyId, role, allowedPartnerCodes }) {
  // 구글챗 알림 딥링크(?imp=<요청id>) — 있으면 개선 요청 탭으로 바로 진입.
  const [improveDeepLinkId, setImproveDeepLinkId] = useState(readImproveDeepLinkId);
  const [tab, setTab] = useState(() => (readImproveDeepLinkId() ? IMPROVE_TAB_INDEX : 0));
  // 대시보드 '거래처별 노선관리' → 노선 관리 탭으로 이동하며 그 거래처로 필터 고정(2026-06-15).
  const [routesFocusPartner, setRoutesFocusPartner] = useState(null);
  // Phase B(2026-06-08): 로그인 admin 의 협력사 권한 범위 정규화.
  // superadmin·미설정 admin·["*"] = ["*"](무제한, 기존 동작 100% — 회귀 0).
  // 8지점 PartnerFilter + 각 탭 데이터 필터에 prop 으로 전달.
  const rawAllowed = resolveAllowed(role, allowedPartnerCodes);
  const allAccess = isAllAccess(rawAllowed);
  // 2026-06-15: "각자가 생성한 거래처(createdBy===내 uid)는 권한과 무관하게 항상 본다"(사용자 결정).
  // 대시보드·협력사관리만 allowed∪createdBy 였고 배차관리 등 나머지 게이팅 지점은 allowed 만 봐서
  // 본인이 등록한 거래처 배차/노선이 안 보이던 누락 → 최상위에서 한 번 합쳐 전 탭에 동일 적용.
  const [createdPartnerCodes, setCreatedPartnerCodes] = useState([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const isMobile = useIsMobile();

  // SaaS Phase 1.2 (2026-05-28) — 슈퍼관리자 분기.
  // selectedCompanyId: 일반 admin = companyId prop 고정. 슈퍼관리자만 회사 전환 가능.
  // 모든 11탭이 이 state 를 prop 으로 받아 자동 re-subscribe.
  const isSuperAdmin = role === "superadmin";
  const [selectedCompanyId, setSelectedCompanyId] = useState(companyId);
  // companyId prop 변경(예: 재로그인) 시 동기화 — 일반 admin 도 안전.
  useEffect(() => { setSelectedCompanyId(companyId); }, [companyId]);

  const activeCompanyId = selectedCompanyId || companyId;
  const vehicles = useVehicles(activeCompanyId);
  const drivers = useDrivers(activeCompanyId);

  // 슈퍼관리자 전용: 회사 목록(헤더 드롭다운 + 회사 관리 탭 공유).
  // listCompanies onCall 호출 — 일반 admin 은 호출 자체 안 함(권한 거부 + 비용 절약).
  const [companies, setCompanies] = useState([]);
  const [companiesLoading, setCompaniesLoading] = useState(false);
  const reloadCompanies = useCallback(async () => {
    if (!isSuperAdmin) return;
    setCompaniesLoading(true);
    try {
      const callable = httpsCallable(functions, "listCompanies");
      const res = await callable({});
      setCompanies(res.data?.companies || []);
    } catch (e) {
      console.error("[회사목록] 로드 실패:", e.message);
    } finally {
      setCompaniesLoading(false);
    }
  }, [isSuperAdmin]);
  useEffect(() => { reloadCompanies(); }, [reloadCompanies]);

  // 🔴 PC 폭으로 돌아오면 드로어 상태를 반드시 접는다(2026-08-26) — 안 접으면 모바일에서
  //    열어둔 채 회전·리사이즈했을 때 사이드바는 고정 열로 뜨는데 **딤만 남아 화면이 잠긴다**.
  useEffect(() => { if (!isMobile) setMenuOpen(false); }, [isMobile]);

  // ESC 로 드로어 닫기 — 딤 탭과 같은 출구를 키보드에도 준다.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e) => { if (e.key === "Escape") setMenuOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  // 관제 PWA 매니페스트·아이콘 적용(2026-05-27) — manifest.json 은 이미 admin 아이콘이지만
  // 직원/기사 앱과 패턴 일관성 위해 동적 호출(idempotent — 이미 같은 href 면 no-op).
  useEffect(() => {
    applyAppManifest({
      manifestHref: "/manifest.json",
      appleTouchHref: "/icons/admin-1024.png",
      title: "BusLink 관제",
    });
  }, []);

  // 본인이 생성한 거래처(createdBy===uid) 코드 구독 — 무제한 admin 은 불필요(전부 보임).
  useEffect(() => {
    if (allAccess || !activeCompanyId || !user?.uid) { setCreatedPartnerCodes([]); return; }
    const q = query(collection(db, "partnerCodes"), where("companyId", "==", activeCompanyId), where("createdBy", "==", user.uid));
    return onSnapshot(q,
      snap => setCreatedPartnerCodes(snap.docs.map(d => d.data().code || d.id)),
      err => console.warn("[createdBy 거래처] 구독 오류:", err.message));
  }, [allAccess, activeCompanyId, user?.uid]);

  // 유효 접근 범위 = allowed ∪ 본인 생성 거래처. 무제한이면 그대로 ["*"].
  // 이 값을 모든 탭에 allowed 로 내려 8지점 게이팅이 본인 생성분을 자동 포함.
  const allowed = allAccess ? rawAllowed : Array.from(new Set([...rawAllowed, ...createdPartnerCodes]));

  return (
    <div style={S.wrap}>
      {/* PWA 설치 안내(설치형 앱 전환) — PC Chrome 에서 "앱 설치" 버튼, 모바일은 안내 바텀시트 */}
      <InstallPrompt />
      {/* ── 사이드바 — PC 는 고정 열, 모바일은 오프캔버스 드로어(2026-08-26 way, YDYOPS 참조) ──
          🔴 종전 모바일 메뉴는 `position:absolute` 로 본문 위를 덮는 2열 드롭다운이었고,
             **닫을 방법이 항목 선택뿐**이라 열어놓고 화면을 볼 수가 없었다("메뉴가 가린다").
             YDYOPS `shared/Sidebar.tsx` 와 같은 형태로 바꾼다 — 화면 밖에 대기하다 밀려 들어오고,
             뒤의 딤을 누르면 닫힌다. PC 는 지금 그대로(flexShrink:0 고정 열).
          ⚠ `position:fixed` 는 조상의 overflow:hidden 에 안 잘린다(S.wrap 에 transform 이 없어
            fixed 의 컨테이닝 블록이 뷰포트다). 조상에 transform 을 넣으면 이 전제가 깨진다. */}
      {isMobile && menuOpen && (
        <div style={S.navBackdrop} onClick={() => setMenuOpen(false)} aria-hidden="true" />
      )}
      {(
        <div style={isMobile
          ? { ...S.sidebarDrawer, transform: menuOpen ? "translateX(0)" : "translateX(-100%)" }
          : S.sidebar}>
          <div style={S.logo}>
            <BusLinkLogo size={22} sub="관리자" />
          </div>
          <div style={S.sideSection}>메뉴</div>
          {/* 메뉴 리스트만 스크롤(2026-08-11) — 탭이 14개(+슈퍼관리자 15개)라 창 높이가 낮으면
              아래 항목이 잘린 채 접근 불가였다. 로고·회사ID·로그아웃은 고정 유지. */}
          <nav data-nav-scroll style={S.nav}>
            {TABS.map((t, i) => (
              <div key={i} data-nav-item onClick={() => { setTab(i); setMenuOpen(false); }}
                style={{ ...S.navItem, ...(tab === i ? S.navActive : {}) }}>
                {tab === i && <span style={S.navAccent} />}
                <span style={S.navIcon}><Icon name={TAB_ICONS[i]} size={17} stroke={tab === i ? 2 : 1.7} /></span>
                {t}
              </div>
            ))}
            {/* SaaS Phase 1.2 — 슈퍼관리자 전용 탭. 일반 admin 비표시. */}
            {isSuperAdmin && (
              <div data-nav-item onClick={() => { setTab(SUPER_TAB_INDEX); setMenuOpen(false); }}
                style={{ ...S.navItem, ...(tab === SUPER_TAB_INDEX ? S.navActive : {}) }}>
                {tab === SUPER_TAB_INDEX && <span style={S.navAccent} />}
                <span style={S.navIcon}><Icon name={SUPER_TAB_ICON} size={17} stroke={tab === SUPER_TAB_INDEX ? 2 : 1.7} /></span>
                {SUPER_TAB_LABEL}
              </div>
            )}
          </nav>
          <div style={S.sideFoot}>
            <StatusDot tone="positive" size={7} />
            {isSuperAdmin ? (
              <select
                value={activeCompanyId || ""}
                onChange={(e) => setSelectedCompanyId(e.target.value)}
                style={{ background:"transparent", border:"1px solid var(--color-line)", borderRadius:6, padding:"3px 6px", fontSize:11, color:"var(--color-label)" }}
                title="회사 전환(슈퍼관리자 전용)"
              >
                {companies.length === 0 && <option value={companyId}>{companyId}</option>}
                {companies.map(c => (
                  <option key={c.id} value={c.id} disabled={!c.active}>
                    {c.name || c.id}{c.active ? "" : " (비활성)"}
                  </option>
                ))}
              </select>
            ) : (
              <span>{companyId}</span>
            )}
          </div>
          <button data-logout style={S.logoutBtn} onClick={() => signOut(auth)}>로그아웃</button>
        </div>
      )}

      {/* ── 콘텐츠 영역 ── */}
      <div style={S.content}>
        {/* 모바일 상단 헤더 */}
        {isMobile && (
          <div style={{ background:"var(--color-bg)", borderBottom:"1px solid var(--color-line)", padding:"10px 14px", display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0, zIndex:50 }}>
            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
              <button onClick={() => setMenuOpen(p => !p)}
                style={{ background:"var(--color-bg-soft)", border:"1px solid var(--color-line)", borderRadius:8, padding:"5px 9px", color:"var(--color-label)", fontSize:18, cursor:"pointer", lineHeight:1 }}>
                ☰
              </button>
              <span style={{ display:"flex", alignItems:"center", gap:7, fontSize:14, fontWeight:700, color:"var(--color-primary-deep)" }}>
                <Icon name={TAB_ICONS[tab]} size={16} /> {TABS[tab]}
              </span>
            </div>
            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
              {isSuperAdmin ? (
                <select
                  value={activeCompanyId || ""}
                  onChange={(e) => setSelectedCompanyId(e.target.value)}
                  style={{ background:"var(--color-bg-soft)", border:"1px solid var(--color-line)", borderRadius:6, padding:"3px 5px", fontSize:11, color:"var(--color-label)", maxWidth:120 }}
                  title="회사 전환"
                >
                  {companies.length === 0 && <option value={companyId}>{companyId}</option>}
                  {companies.map(c => (
                    <option key={c.id} value={c.id} disabled={!c.active}>
                      {c.name || c.id}
                    </option>
                  ))}
                </select>
              ) : (
                <span style={{ fontSize:11, color:"var(--color-label-alt)" }}>{companyId}</span>
              )}
              <button style={{ ...S.logoutBtn, padding:"5px 10px", fontSize:11 }} onClick={() => signOut(auth)}>로그아웃</button>
            </div>
          </div>
        )}

        {/* 🔴 종전 여기 있던 2열 드롭다운 메뉴는 걷어냈다(2026-08-26) — 본문 위를 덮는데
            닫는 방법이 항목 선택뿐이었다. 이제 메뉴는 위쪽 오프캔버스 드로어 하나뿐이고
            PC·모바일이 **같은 목록**을 쓴다(탭이 늘 때 한 곳만 고치면 된다). */}

        {tab === 0 && <ErrorBoundary label="대시보드"><DashboardTab companyId={activeCompanyId} drivers={drivers} vehicles={vehicles} onNav={setTab} onManageRoutes={(pc) => { setRoutesFocusPartner(pc); setTab(4); }} allowed={allowed} currentUserUid={user?.uid} /></ErrorBoundary>}
        {tab === 1 && <ErrorBoundary label="실시간 관제"><MapTab companyId={activeCompanyId} allowed={allowed} drivers={drivers} /></ErrorBoundary>}
        {tab === 2 && <ErrorBoundary label="배차 관리"><DispatchTab companyId={activeCompanyId} vehicles={vehicles} drivers={drivers} allowed={allowed} currentUserUid={user?.uid} /></ErrorBoundary>}
        {tab === 3 && <ErrorBoundary label="배차 일정"><DispatchScheduleTab companyId={activeCompanyId} vehicles={vehicles} drivers={drivers} allowed={allowed} currentUserUid={user?.uid} /></ErrorBoundary>}
        {tab === 4 && <ErrorBoundary label="노선 관리"><RoutesTab companyId={activeCompanyId} allowed={allowed} currentUserUid={user?.uid} focusPartnerCode={routesFocusPartner} onFocusConsumed={() => setRoutesFocusPartner(null)} /></ErrorBoundary>}
        {tab === 5 && <ErrorBoundary label="기사 관리"><DriverTab companyId={activeCompanyId} vehicles={vehicles} allowed={allowed} currentUserUid={user?.uid} /></ErrorBoundary>}
        {tab === 6 && <ErrorBoundary label="차량 관리"><VehicleTab companyId={activeCompanyId} vehicles={vehicles} allowed={allowed} currentUserUid={user?.uid} /></ErrorBoundary>}
        {tab === 7 && <ErrorBoundary label="시뮬레이터"><SimulatorTab companyId={activeCompanyId} vehicles={vehicles} drivers={drivers} /></ErrorBoundary>}
        {tab === 8 && <ErrorBoundary label="운행 이력"><HistoryTab companyId={activeCompanyId} vehicles={vehicles} allowed={allowed} /></ErrorBoundary>}
        {tab === 9 && <ErrorBoundary label="탑승 통계"><BoardingStatsTab companyId={activeCompanyId} allowed={allowed} /></ErrorBoundary>}
        {tab === 10 && <ErrorBoundary label="협력사 관리"><PartnerTab companyId={activeCompanyId} allowed={allowed} currentUserUid={user?.uid} /></ErrorBoundary>}
        {tab === 11 && <ErrorBoundary label="공지 발송"><NoticeTab companyId={activeCompanyId} allowed={allowed} /></ErrorBoundary>}
        {tab === IMPROVE_TAB_INDEX && <ErrorBoundary label="개선 요청"><ImprovementTab companyId={activeCompanyId} user={user} role={role} companies={companies} deepLinkId={improveDeepLinkId} onDeepLinkConsumed={() => setImproveDeepLinkId(null)} /></ErrorBoundary>}
        {tab === 13 && <ErrorBoundary label="부정승차"><NfcRejectTab companyId={activeCompanyId} /></ErrorBoundary>}
        {tab === 14 && <ErrorBoundary label="빈 차 확인"><SleepCheckTab companyId={activeCompanyId} allowed={allowed} /></ErrorBoundary>}
        {/* SaaS Phase 1.2 — 슈퍼관리자 전용 회사 관리 탭(인덱스=TABS.length). 일반 admin 비표시. */}
        {isSuperAdmin && tab === SUPER_TAB_INDEX && (
          <ErrorBoundary label="회사 관리">
            <SuperCompanyTab
              companies={companies}
              loading={companiesLoading}
              selectedCompanyId={activeCompanyId}
              onSelectCompany={setSelectedCompanyId}
              onReload={reloadCompanies}
              currentUserCompanyId={companyId}
              currentUserUid={user?.uid}
            />
          </ErrorBoundary>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// 탭0: 대시보드
// ═══════════════════════════════════════════════════════
function DashboardTab({ companyId, drivers, vehicles, onNav, onManageRoutes, allowed, currentUserUid }) {
  const [dispatches, setDispatches] = useState([]);
  const [gpsVehicles, setGpsVehicles] = useState([]);
  const [boardings, setBoardings] = useState([]);
  const [routes, setRoutes] = useState([]);
  const [partnerCodes, setPartnerCodes] = useState([]); // 거래처 현황·코드 열람용
  const [copiedCode, setCopiedCode] = useState(null);
  const [showAddPartner, setShowAddPartner] = useState(false); // 거래처 신규 등록 모달
  const [newPartnerName, setNewPartnerName] = useState("");
  const [addingPartner, setAddingPartner] = useState(false);
  const [portalCopied, setPortalCopied] = useState(false);
  const [partnerCode, setPartnerCode] = useState("전체"); // 협력사 필터

  useEffect(() => {
    if (!companyId) return;
    const ref = collection(db, "companies", companyId, "dispatches", getToday(), "list");
    return onSnapshot(ref, snap => setDispatches(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
  }, [companyId]);

  useEffect(() => {
    if (!companyId) return;
    const q = query(collection(db, "gps"), where("companyId", "==", companyId));
    return onSnapshot(q, snap => setGpsVehicles(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
  }, [companyId]);

  useEffect(() => {
    if (!companyId) return;
    const ref = collection(db, "companies", companyId, "boardings", getToday(), "list");
    return onSnapshot(ref, snap => setBoardings(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
  }, [companyId]);

  useEffect(() => {
    if (!companyId) return;
    return onSnapshot(collection(db, "companies", companyId, "routes"),
      snap => setRoutes(snap.docs.map(d => ({ id:d.id, ...d.data() }))));
  }, [companyId]);

  useEffect(() => {
    if (!companyId) return;
    return onSnapshot(query(collection(db, "partnerCodes"), where("companyId", "==", companyId)),
      snap => setPartnerCodes(snap.docs.map(d => ({ id:d.id, ...d.data() }))));
  }, [companyId]);

  // 협력사 필터 적용: routeId → partnerCode 매핑
  const routeOf = (id) => routes.find(r => r.id === id);
  // Phase B: "전체"여도 제한 admin 은 자기 allowed 협력사로 한정(isAllAccess 면 기존대로 전체).
  const matchPartner = (rId) => {
    const pc = routeOf(rId)?.partnerCode;
    if (partnerCode !== "전체") return pc === partnerCode;
    return isAllAccess(allowed) || partnerCodeAllowed(allowed, pc);
  };
  const filteredDispatches = dispatches.filter(d => matchPartner(d.routeId));
  const filteredGps = gpsVehicles.filter(v => matchPartner(v.routeId));
  const filteredBoardings = boardings.filter(b => matchPartner(b.routeId));

  // 기사 createdBy 격리(2026-06-17): 제한 admin 은 본인 생성 기사만(전체권한/슈퍼관리자는 전체). DriverTab(2712) 과 동일 정책을 대시보드에도 적용.
  const visibleDrivers = isAllAccess(allowed) ? drivers : drivers.filter(d => d.createdBy && currentUserUid && d.createdBy === currentUserUid);
  const driving = visibleDrivers.filter(d => d.status === "운행중").length;
  const waiting = visibleDrivers.filter(d => d.status !== "운행중").length;

  // GPS 미수신 기사(2026-06-23): status="운행중" 인데 그 차량의 gps 문서가 없거나 stale(>60초).
  // 신선 GPS 수신중인 vehicleId 집합(좌표 유효 + isGpsFresh). gpsVehicles 전체로 산출(visibleDrivers 와 vehicleId 교차).
  const liveVehIds = new Set(gpsVehicles.filter(g => g.lat && g.lng && isGpsFresh(g.updatedAt)).map(g => g.vehicleId));
  const noGpsDrivers = visibleDrivers.filter(d => d.status === "운행중" && !liveVehIds.has(d.vehicleId));

  const stats = [
    { label: "오늘 배차 노선", value: filteredDispatches.length, sub: partnerCode === "전체" ? "금일 등록 기준" : "선택 협력사 기준", color: "var(--color-primary)" },
    { label: "운행중 차량", value: filteredGps.length, sub: `기사 운행중 ${driving}명${noGpsDrivers.length > 0 ? ` · GPS 미수신 ${noGpsDrivers.length}` : ""}`, color: "var(--color-positive)" },
    { label: "오늘 탑승 인원", value: filteredBoardings.length, sub: "QR 탑승 기준", color: "var(--color-positive)" },
    { label: "전체 기사", value: visibleDrivers.length, sub: `대기 ${waiting}명`, color: "var(--color-primary-deep)" },
  ];

  const driverName = (id) => drivers.find(d => d.id === id)?.name ?? id;

  // ── 거래처(협력사) 관리 현황 — 거래처 중심 실시간 요약 + 코드 열람 ──
  // 가시 범위 = 무제한이면 전체 / 제한 admin 은 담당(allowed) + 본인 생성(createdBy) 거래처.
  const visiblePartners = isAllAccess(allowed)
    ? partnerCodes
    : partnerCodes.filter(p => allowed.includes(p.code || p.id) || (currentUserUid && p.createdBy === currentUserUid));
  const partnerStats = [...visiblePartners]
    .sort((a, b) => (a.partnerName || a.code || "").localeCompare(b.partnerName || b.code || ""))
    .map(p => {
      const code = p.code || p.id;
      const pRoutes = routes.filter(r => r.partnerCode === code);
      const routeIdSet = new Set(pRoutes.map(r => r.id));
      return {
        code,
        name: p.partnerName || code,
        active: p.active !== false,
        routeCount: pRoutes.length,
        dispatchCount: dispatches.filter(d => routeIdSet.has(d.routeId)).length,
        runningCount: gpsVehicles.filter(v => routeIdSet.has(v.routeId)).length,
        boardingCount: boardings.filter(b => b.partnerCode === code).length,
      };
    });
  const copyPartnerCode = (code) => {
    navigator.clipboard.writeText(code);
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 1500);
  };
  // 협력사 포털 URL — 발급한 업체코드와 함께 협력사에 전달(협력사 관리 탭의 동일 URL).
  const portalUrl = `${window.location.origin}/partner`;
  const copyPortalUrl = () => {
    navigator.clipboard.writeText(portalUrl);
    setPortalCopied(true);
    setTimeout(() => setPortalCopied(false), 1500);
  };
  // 거래처(협력사) 신규 등록 — 발급자(createdBy) 본인 계정에서 바로 열람·관리됨.
  const handleAddPartner = async () => {
    if (!newPartnerName.trim()) { alert("거래처(업체명)를 입력하세요"); return; }
    setAddingPartner(true);
    try {
      const { createPartnerCode } = await import("../lib/partner");
      const code = await createPartnerCode({ companyId, partnerName: newPartnerName.trim(), createdBy: currentUserUid || null });
      setShowAddPartner(false); setNewPartnerName("");
      alert(`거래처 등록 완료\n업체코드: ${code}\n협력사 포털: ${portalUrl}\n\n협력사에 위 코드와 포털 URL을 전달하세요. (대시보드·협력사 관리에서 바로 보입니다)`);
    } catch (e) { alert("오류: " + (e?.message || String(e))); }
    setAddingPartner(false);
  };

  return (
    <div style={S.panel}>
      <div style={S.panelHeader}>
        <div>
          <span style={{ fontSize:16, fontWeight:700, color:"var(--color-label)" }}>🏠 대시보드</span>
          <div style={{ fontSize:12, color:"var(--color-label-mute)", marginTop:2 }}>
            {new Date().toLocaleDateString("ko-KR", { year:"numeric", month:"long", day:"numeric", weekday:"short" })}
          </div>
        </div>
        <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
          <span style={{ fontSize:11, color:"var(--color-label-alt)" }}>거래처:</span>
          <PartnerFilter companyId={companyId} value={partnerCode} onChange={setPartnerCode} allowedCodes={allowed} />
          <button style={S.addBtn} onClick={() => onNav(1)}>🗺 실시간 관제 →</button>
        </div>
      </div>

      <div style={{ padding:"20px 24px", overflowY:"auto", flex:1 }}>
        {/* 통계 카드 */}
        <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:12, marginBottom:20 }}>
          {stats.map(s => (
            <div key={s.label} style={{ background:"var(--color-bg)", border:"1px solid var(--color-line)", borderRadius:12, padding:"18px 20px", boxShadow:"var(--shadow-emphasize)" }}>
              <div style={{ fontSize:12, color:"var(--color-label-mute)", marginBottom:8 }}>{s.label}</div>
              <div style={{ fontSize:30, fontWeight:800, fontFamily:"var(--font-brand)", letterSpacing:"-0.02em", color:s.color }}>{s.value}</div>
              <div style={{ fontSize:11, color:"var(--color-label-alt)", marginTop:4 }}>{s.sub}</div>
            </div>
          ))}
        </div>

        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>
          {/* 오늘 배차 현황 */}
          <div style={{ background:"var(--color-bg)", border:"1px solid var(--color-line)", borderRadius:12, overflow:"hidden", boxShadow:"var(--shadow-emphasize)" }}>
            <div style={{ padding:"14px 18px", borderBottom:"1px solid var(--color-line)", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <span style={{ fontWeight:700, color:"var(--color-label)" }}>오늘 배차 현황</span>
              <button style={S.editBtn} onClick={() => onNav(2)}>배차 관리</button>
            </div>
            {filteredDispatches.length === 0 ? (
              <div style={S.empty}>{dispatches.length === 0 ? "오늘 배차 내역이 없습니다" : "선택 협력사 배차 없음"}</div>
            ) : (
              <table style={S.table}>
                <thead>
                  <tr><th style={S.th}>출발</th><th style={S.th}>노선명</th><th style={S.th}>기사</th></tr>
                </thead>
                <tbody>
                  {[...filteredDispatches].sort((a,b) => a.departTime > b.departTime ? 1 : -1).map(d => (
                    <tr key={d.id} style={S.tr}>
                      <td style={S.td}><span style={S.timeBadge}>{d.departTime}</span></td>
                      <td style={{ ...S.td, color:"var(--color-primary)", fontWeight:600, fontSize:12, maxWidth:140, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{d.routeName}</td>
                      <td style={S.td}>{driverName(d.driverId)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* 기사 현황 */}
          <div style={{ background:"var(--color-bg)", border:"1px solid var(--color-line)", borderRadius:12, overflow:"hidden", boxShadow:"var(--shadow-emphasize)" }}>
            <div style={{ padding:"14px 18px", borderBottom:"1px solid var(--color-line)", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <span style={{ fontWeight:700, color:"var(--color-label)" }}>기사 현황</span>
              <button style={S.editBtn} onClick={() => onNav(5)}>기사 관리</button>
            </div>
            {visibleDrivers.length === 0 ? (
              <div style={S.empty}>등록된 기사가 없습니다</div>
            ) : (
              <table style={S.table}>
                <thead>
                  <tr><th style={S.th}>이름</th><th style={S.th}>차량</th><th style={S.th}>상태</th></tr>
                </thead>
                <tbody>
                  {visibleDrivers.slice(0, 8).map(d => {
                    const noGps = d.status === "운행중" && !liveVehIds.has(d.vehicleId);
                    return (
                    <tr key={d.id} style={S.tr}>
                      <td style={{ ...S.td, fontWeight:600 }}>{d.name}</td>
                      <td style={{ ...S.td, color:"var(--color-label-mute)", fontSize:12 }}>{d.vehicleNo || "–"}</td>
                      <td style={S.td}>
                        {noGps ? (
                          <span style={{ ...S.statusBadge, background:"#FFF4E5", color:"#B26A00" }} title="운행중인데 GPS 위치 신호가 들어오지 않습니다">
                            ⚠ GPS 미수신
                          </span>
                        ) : (
                          <span style={{ ...S.statusBadge, background:d.status==="운행중"?"#E6F7EB":"var(--color-bg-soft)", color:d.status==="운행중"?"#007A29":"var(--color-label-mute)" }}>
                            ●{d.status ?? "대기"}
                          </span>
                        )}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* 거래처(협력사) 관리 현황 — 거래처 중심 실시간 요약 + 업체코드 열람(2026-06-15) */}
        <div style={{ marginTop:16, background:"var(--color-bg)", border:"1px solid var(--color-line)", borderRadius:12, overflow:"hidden", boxShadow:"var(--shadow-emphasize)" }}>
          <div style={{ padding:"14px 18px", borderBottom:"1px solid var(--color-line)", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <span style={{ fontWeight:700, color:"var(--color-label)" }}>🤝 거래처 관리 현황</span>
            <div style={{ display:"flex", gap:8 }}>
              <button style={S.addBtn} onClick={() => setShowAddPartner(true)}>+ 거래처 등록</button>
              <button style={S.editBtn} onClick={() => onNav(10)}>협력사 관리</button>
            </div>
          </div>
          <div style={{ padding:"8px 18px", borderBottom:"1px solid var(--color-line)", background:"var(--color-bg-soft)", display:"flex", alignItems:"center", gap:8, flexWrap:"wrap", fontSize:12 }}>
            <span style={{ color:"var(--color-label-mute)", fontWeight:600 }}>🔗 협력사 포털</span>
            <span style={{ fontFamily:"monospace", color:"var(--color-primary-deep)", wordBreak:"break-all" }}>{portalUrl}</span>
            <button onClick={copyPortalUrl} style={{ ...S.editBtn, marginRight:0, fontSize:11, padding:"3px 8px" }}>
              {portalCopied ? "✓ 복사됨" : "복사"}
            </button>
            <span style={{ color:"var(--color-label-mute)" }}>· 발급한 업체코드와 함께 협력사에 전달하세요</span>
          </div>
          {partnerStats.length === 0 ? (
            <div style={S.empty}>{partnerCodes.length === 0 ? "등록된 거래처가 없습니다" : "담당/생성한 거래처가 없습니다"}</div>
          ) : (
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>거래처</th><th style={S.th}>노선</th><th style={S.th}>오늘 배차</th>
                  <th style={S.th}>운행중</th><th style={S.th}>오늘 탑승</th><th style={S.th}>업체코드</th><th style={S.th}>노선 관리</th>
                </tr>
              </thead>
              <tbody>
                {partnerStats.map(p => (
                  <tr key={p.code} style={S.tr}>
                    <td style={{ ...S.td, fontWeight:600 }}>
                      {p.name}{!p.active && <span style={{ fontSize:10, color:"var(--color-label-mute)", marginLeft:4 }}>· 비활성</span>}
                    </td>
                    <td style={S.td}>{p.routeCount}</td>
                    <td style={S.td}>{p.dispatchCount}</td>
                    <td style={{ ...S.td, color: p.runningCount > 0 ? "var(--color-positive)" : "var(--color-label-mute)", fontWeight: p.runningCount > 0 ? 700 : 400 }}>{p.runningCount}</td>
                    <td style={S.td}>{p.boardingCount}</td>
                    <td style={S.td}>
                      <button onClick={() => copyPartnerCode(p.code)} title="업체코드 복사"
                        style={{ ...S.editBtn, marginRight:0, fontSize:11, fontFamily:"monospace" }}>
                        {copiedCode === p.code ? "✓ 복사됨" : `${p.code} 📋`}
                      </button>
                    </td>
                    <td style={S.td}>
                      <button onClick={() => onManageRoutes && onManageRoutes(p.code)} title="이 거래처의 노선 관리로 이동"
                        style={{ ...S.editBtn, marginRight:0, fontSize:11 }}>🚌 노선 관리</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* ⚠ 운행중인데 GPS 미수신 경고 카드(2026-06-23) — 0명이면 미표시 */}
        {noGpsDrivers.length > 0 && (
          <div style={{ background:"#FFF4E5", border:"1px solid #F0C36D", borderRadius:12, padding:"14px 18px", marginTop:16, boxShadow:"var(--shadow-emphasize)" }}>
            <div style={{ fontWeight:700, marginBottom:10, color:"#B26A00" }}>⚠ 운행중인데 GPS 미수신 ({noGpsDrivers.length}대)</div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:10 }}>
              {noGpsDrivers.map(d => (
                <div key={d.id} style={{ background:"#FFFBF4", border:"1px solid #F0C36D", borderRadius:8, padding:"8px 14px", fontSize:12 }}>
                  <span style={{ fontWeight:700, color:"var(--color-label)" }}>{d.name}</span>
                  <span style={{ color:"var(--color-label-mute)", marginLeft:8 }}>{d.vehicleNo || "차량 미지정"}</span>
                  <span style={{ color:"#B26A00", marginLeft:8 }}>위치 신호 없음</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* GPS 수신 현황 */}
        {filteredGps.length > 0 && (
          <div style={{ background:"var(--color-bg)", border:"1px solid var(--color-line)", borderRadius:12, padding:"14px 18px", marginTop:16, boxShadow:"var(--shadow-emphasize)" }}>
            <div style={{ fontWeight:700, marginBottom:12, color:"var(--color-label)" }}>📡 실시간 GPS 수신 차량 ({filteredGps.length}대){partnerCode !== "전체" && <span style={{ fontSize:12, color:"var(--color-label-mute)", marginLeft:8, fontWeight:500 }}>(선택 협력사)</span>}</div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:10 }}>
              {filteredGps.map(v => (
                <div key={v.id} style={{ background:"var(--color-bg-alt)", border:"1px solid var(--color-line)", borderRadius:8, padding:"8px 14px", fontSize:12 }}>
                  <span style={{ color:"var(--color-positive)", marginRight:6 }}>●</span>
                  <span style={{ fontWeight:700, color:"var(--color-label)" }}>{v.vehicleNo || v.vehicleId}</span>
                  <span style={{ color:"var(--color-label-mute)", marginLeft:8 }}>{v.driverName}</span>
                  <span style={{ color:"var(--color-cautionary)", marginLeft:8 }}>{timeSince(v.updatedAt)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {showAddPartner && (
          <div style={S.overlay}>
            <form style={S.modal} onSubmit={(e) => { e.preventDefault(); handleAddPartner(); }}>
              <div style={S.modalTitle}>+ 거래처(협력사) 신규 등록</div>
              <div style={{ fontSize:11, color:"var(--color-label-mute)", marginBottom:8 }}>
                업체코드가 발급되고, 발급한 본인 계정에서 바로 열람·관리됩니다. 협력사에 코드를 전달하세요.
              </div>
              <label style={S.label}>거래처(업체) 이름</label>
              <input style={S.input} autoFocus placeholder="예: 한화판교R&D센터" value={newPartnerName}
                onChange={(e) => setNewPartnerName(e.target.value)} />
              <div style={{ display:"flex", gap:8, marginTop:12 }}>
                <button type="button" style={{ ...S.editBtn, flex:1, padding:"9px 0", fontSize:13 }}
                  disabled={addingPartner} onClick={() => { setShowAddPartner(false); setNewPartnerName(""); }}>취소</button>
                <button type="submit" style={{ ...S.addBtn, flex:2, padding:"9px 0" }} disabled={addingPartner}>
                  {addingPartner ? "발급 중..." : "발급"}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// 탭1: 실시간 관제
// ═══════════════════════════════════════════════════════
// 모바일 판정 한 곳(2026-08-26). 🔴 셸(사이드바 드로어)과 MapTab 오버레이가 **같은 기준**을
// 써야 한다 — 어긋나면 사이드바는 드로어인데 지도 레일은 PC 배치인 중간 상태가 생긴다.
const MOBILE_MAX_W = 768;
function useIsMobile() {
  const [mobile, setMobile] = useState(() => window.innerWidth < MOBILE_MAX_W);
  useEffect(() => {
    const h = () => setMobile(window.innerWidth < MOBILE_MAX_W);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  return mobile;
}

function MapTab({ companyId, allowed, drivers }) {
  const isMobile = useIsMobile();
  const [rawVehicles, setRawVehicles] = useState([]);
  const [selected, setSelected] = useState(null);
  const [center, setCenter] = useState({ lat: 37.3894, lng: 126.9522 });
  // 최초 1회만 첫 차량으로 자동 센터(이후 스냅샷마다 list[0] 로 되돌아가 사용자 패닝·선택이
  // 풀리던 결함 차단, 2026-06-23). 선택 차량 추적은 아래 별도 effect.
  const didInitCenter = useRef(false);
  const [tick, setTick] = useState(0);
  const [refreshTick, setRefreshTick] = useState(0); // 노선 새로고침 버튼 → gps 재구독
  const [refreshing, setRefreshing] = useState(false);
  // 운행 강제 종료(2026-07-28) — 확인 카드 대상 id · 처리 중 id · 처리 완료 id 맵.
  // 확인은 인라인 카드로(모달 배경 클릭에 조용히 닫히는 UX 금지 — 2026-07-14 회귀 가드와 같은 원칙).
  const [forceConfirm, setForceConfirm] = useState(null);
  const [forceBusy, setForceBusy] = useState(null);
  const [forceDone, setForceDone] = useState({});
  const vehiclesAll = useAnimatedPositions(rawVehicles);
  // 거래처(협력사) 필터(2026-08-20 광연 요청) — 배차 관리 등 타 탭과 같은 드롭다운을 관제에도.
  // 🔴 gps/dispatch 문서엔 partnerCode 가 없다 → 판정은 **노선의 partnerCode**(routePartnerOf) 하나로만 한다.
  //    (제한 admin 게이팅 allowMapRow 과 같은 축 — 두 축이 어긋나면 "권한은 있는데 안 보임"이 생긴다)
  const [partnerCode, setPartnerCode] = useState("전체");
  // 거래처를 고르면 그 차량들이 화면에 담기게 카메라를 옮긴다(2026-08-20 way 요청).
  const mapObjRef = useRef(null);
  const camPartnerRef = useRef("전체");

  // 노선 새로고침(#2) — 기사 GPS 껐다 켜진 뒤 관제 화면에 위치 미반영 시 수동 재연결·재구독.
  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    await forceReconnect();
    setRefreshTick(t => t + 1);
    setTimeout(() => setRefreshing(false), 600);
  };

  // 노선도 뷰 (2026-05-26 추가): 지도/노선도 토글 + 일자별 배차 타임라인
  const [viewMode, setViewMode] = useState("map"); // "map" | "route"
  const [routes, setRoutes] = useState([]);
  const [routeStops, setRouteStops] = useState({}); // {routeId: [stops]}
  const [todayDispatches, setTodayDispatches] = useState([]);
  const today = getToday();
  // 일자별 조회 (2026-05-26): 노선도 뷰는 과거 날짜도 조회 가능. dispatches 컬렉션엔 stopArrivals 보존됨.
  // 지도 뷰는 라이브 GPS 전용 → 과거 날짜 선택 시 자동으로 노선도 뷰로 전환·배너 안내.
  const [selectedDate, setSelectedDate] = useState(today);
  const isPastDate = selectedDate !== today;

  useEffect(() => { const t = setInterval(() => setTick(x => x+1), 1000); return () => clearInterval(t); }, []);

  useEffect(() => {
    if (!companyId) return;
    const q = query(collection(db, "gps"), where("companyId", "==", companyId));
    return onSnapshot(q, (snap) => {
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setRawVehicles(list);
      // 최초 진입 시 1회만 첫 차량으로 센터 — 이후 스냅샷마다 되돌아가지 않음(패닝·선택 보존).
      if (!didInitCenter.current && list.length > 0 && list[0].lat && list[0].lng) {
        setCenter({ lat: list[0].lat, lng: list[0].lng });
        didInitCenter.current = true;
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, refreshTick]);

  // 선택 차량 추적(2026-06-23) — 차량 클릭 시 그 차량 위치로 센터, 이동 시 GPS 갱신마다 따라감.
  // 선택 해제("전체 보기") 시 자유 패닝(자동 센터 없음 → 사용자가 본 위치 유지).
  useEffect(() => {
    if (!selected) return;
    const v = rawVehicles.find(x => x.id === selected.id);
    if (v && v.lat && v.lng) setCenter({ lat: v.lat, lng: v.lng });
  }, [selected, rawVehicles]);

  // 노선도 뷰용 — 노선/오늘 배차 구독(항상 로드, 토글 시 즉시 표시).
  useEffect(() => {
    if (!companyId) return;
    return onSnapshot(collection(db, "companies", companyId, "routes"),
      snap => setRoutes(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
  }, [companyId]);

  useEffect(() => {
    if (!companyId || !selectedDate) return;
    return onSnapshot(collection(db, "companies", companyId, "dispatches", selectedDate, "list"),
      snap => setTodayDispatches(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
  }, [companyId, selectedDate]);

  // 과거 날짜 선택 시 자동으로 노선도 뷰로 전환(지도 뷰는 실시간 GPS 전용).
  useEffect(() => {
    if (isPastDate && viewMode === "map") setViewMode("route");
  }, [isPastDate, viewMode]);

  // 노선도 뷰 활성 시: 오늘 배차된 노선의 stops 만 lazy 구독(N+1이지만 노선 수 ~10대로 OK).
  useEffect(() => {
    if (viewMode !== "route" || !companyId) return;
    const routeIds = Array.from(new Set(todayDispatches.map(d => d.routeId).filter(Boolean)));
    if (routeIds.length === 0) return;
    const unsubs = routeIds.map(rid => onSnapshot(
      query(collection(db, "companies", companyId, "routes", rid, "stops"), orderBy("order", "asc")),
      snap => setRouteStops(prev => ({ ...prev, [rid]: snap.docs.map(d => ({ id: d.id, ...d.data() })) }))
    ));
    return () => unsubs.forEach(u => u());
  }, [viewMode, companyId, todayDispatches]);

  // Phase B(2026-06-08): 제한 admin 은 자기 allowed 협력사 노선의 차량/배차만.
  // isAllAccess 면 기존 동작 그대로(회귀 0). gps/dispatch 의 routeId → routes.partnerCode 매핑.
  const routePartnerOf = (rid) => routes.find(r => r.id === rid)?.partnerCode;
  const allowMapRow = (rid) => isAllAccess(allowed) || partnerCodeAllowed(allowed, routePartnerOf(rid));
  // 거래처 필터. "전체" = 그대로(회귀 0). 특정 거래처 선택 시 **노선을 모르는 신호는 제외** —
  // 소속을 못 밝히는 차량을 남겨 두면 그 거래처 화면이 아니게 된다.
  const partnerOk = (rid) => partnerCode === "전체" || (!!rid && routePartnerOf(rid) === partnerCode);
  const vehicles = vehiclesAll.filter(v => allowMapRow(v.routeId) && partnerOk(v.routeId));
  const visibleDispatches = todayDispatches.filter(d => allowMapRow(d.routeId) && partnerOk(d.routeId));

  // ── 거래처 선택 → 그 차량 밀집지역으로 카메라 이동(2026-08-20 way 요청) ──────────────
  // 🔴 스냅샷마다 다시 맞추지 말 것 — "매 갱신마다 강제 재센터"는 2026-06-23 에 고친 결함이다
  //    (사용자 패닝·선택이 5초마다 풀린다). 그래서 **선택이 바뀐 순간에만 한 번** 잡고,
  //    그때 좌표가 아직 없으면 들어오는 첫 렌더에서 한 번 잡은 뒤 ref 로 잠근다.
  // 🔴 여백은 컨테이너보다 클 수 없다 — 좌 레일과 상단바가 지도를 **덮고** 있어 그만큼 비켜
  //    줘야 하지만, 좁은 화면에서 그대로 빼면 담을 공간이 0 이 되어 카카오가 최대 축소로 튄다
  //    (callcenter 2026-08-20 같은 결함). 축의 45% 상한 + 네 변 모두 명시.
  const fitToVehicles = (m, pts) => {
    if (!m || !window.kakao?.maps || pts.length === 0) return;
    const el = typeof m.getNode === "function" ? m.getNode() : null;
    const W = el?.clientWidth || 0, H = el?.clientHeight || 0;
    const first = new window.kakao.maps.LatLng(pts[0].lat, pts[0].lng);
    if (W < 120 || H < 120) { m.setCenter(first); return; }   // 아직 레이아웃 전 — 한 점으로만
    const cap = (v, axis) => Math.max(20, Math.min(v, Math.round(axis * 0.45)));
    const rail = Math.min(280, W * 0.32) + 24;                // 좌 레일이 덮는 폭
    const b = new window.kakao.maps.LatLngBounds();
    pts.forEach(p => b.extend(new window.kakao.maps.LatLng(p.lat, p.lng)));
    m.setBounds(b, cap(76, H), cap(40, W), cap(40, H), cap(rail, W));
    // 한 대뿐이거나 모여 있으면 과하게 확대돼 주변이 안 보인다 — 최소 축척을 둔다.
    if (m.getLevel() < 4) m.setLevel(4);
  };
  useEffect(() => {
    if (viewMode !== "map") return;
    if (partnerCode === camPartnerRef.current) return;   // 같은 선택이면 카메라 고정
    const pts = vehicles.filter(v => v.lat && v.lng);
    if (pts.length === 0) return;                        // 좌표 들어오면 그때 잡는다
    camPartnerRef.current = partnerCode;
    fitToVehicles(mapObjRef.current, pts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partnerCode, vehicles, viewMode]);


  // 운행중(좌표 유효) 차량만 카운트 — 실데이터 기반(가짜 KPI 미도입)
  const liveCount = vehicles.filter(v => v.lat && v.lng).length;

  // GPS 미수신(운행중) 기사(2026-06-23): status="운행중" 인데 신선 GPS 없는 기사.
  // 신선 vehicleId 집합 = rawVehicles(라이브 gps 문서) 중 좌표 유효 + isGpsFresh.
  // 제한 admin 게이팅: isAllAccess 아니면 오늘 보이는 배차(visibleDispatches) 의 driverId 집합에 든 기사만(타 협력사 기사 노출 차단).
  const liveSet = new Set(rawVehicles.filter(v => v.lat && v.lng && isGpsFresh(v.updatedAt)).map(v => v.vehicleId));
  const visibleDriverIds = isAllAccess(allowed) ? null : new Set(visibleDispatches.map(d => d.driverId).filter(Boolean));
  // 기사 문서엔 partnerCode 가 없다 → 거래처 필터는 **오늘 그 거래처 배차에 잡힌 기사**로만 좁힌다.
  // (배차가 없는 기사는 소속을 알 수 없으니 특정 거래처 화면에서 뺀다 — 차량 필터와 같은 원칙)
  const partnerDriverIds = partnerCode === "전체" ? null : new Set(visibleDispatches.map(d => d.driverId).filter(Boolean));
  const noGpsRunning = (drivers || []).filter(d =>
    d.status === "운행중" && !liveSet.has(d.vehicleId) &&
    (isAllAccess(allowed) || visibleDriverIds.has(d.id)) &&
    (!partnerDriverIds || partnerDriverIds.has(d.id))
  );

  // ── 잔존 운행 신호 정리(2026-07-28 개선요청 cv4XzFYLUdUfzqBEuDQw) ─────────────
  // 기사가 "운행 종료"를 못 누른 채 남은 gps 문서는 스스로 사라지지 않고, 직원·승객앱
  // 노선 탭이 그 문서 **존재만** 세어 "운행중"을 계속 표시한다(신고 증상). 그중엔 배정
  // 기사가 아예 없는 고아 신호도 있어(기사 삭제·차량 재배정) 로그아웃으로는 못 지운다.
  // 판정은 순수 모듈(lib/runSignals.js), 여기선 표시·게이팅만.
  // (1초 tick 재렌더에 편승 — 신규 타이머 0)
  const { staleSignals } = classifyRunSignals({ gpsDocs: rawVehicles, drivers: drivers || [], now: Date.now() });
  // 제한 admin 게이팅 = 지도 차량과 동일 기준(allowMapRow). 노선을 알 수 없는 신호는
  // 전체권한 admin 에게만(타 협력사 신호를 임의로 지우는 일 차단).
  // 거래처 필터도 같은 축(노선 partnerCode). 노선 미상 신호는 "전체"에서만 보인다.
  const visibleStaleSignals = staleSignals.filter(s =>
    (isAllAccess(allowed) ? true : (s.routeId ? allowMapRow(s.routeId) : false)) &&
    (partnerCode === "전체" ? true : (s.routeId ? partnerOk(s.routeId) : false))
  );

  // 🔴 노선도 뷰의 routeStops 는 `viewMode === "route"` 일 때만 채워진다 — 지도 뷰에서는
  //    비어 있어 빈 차 확인 판정이 **조용히 0건**이 된다(신호 없음 통과와 같은 클래스).
  //    그래서 종점 판정에 필요한 stops 만 뷰와 무관하게 1회씩 받아 둔다(getDocs·노선당 1회).
  const [sleepStops, setSleepStops] = useState({});
  useEffect(() => {
    if (!companyId) return;
    const ids = Array.from(new Set(todayDispatches.map(d => d.routeId).filter(Boolean)))
      .filter(rid => !sleepStops[rid]);
    if (ids.length === 0) return;
    let alive = true;
    Promise.all(ids.map(async rid => {
      try {
        const snap = await getDocs(query(collection(db, "companies", companyId, "routes", rid, "stops"), orderBy("order", "asc")));
        return [rid, snap.docs.map(d => ({ id: d.id, ...d.data() }))];
      } catch (_) { return [rid, []]; }
    })).then(pairs => {
      if (!alive) return;
      setSleepStops(prev => { const next = { ...prev }; pairs.forEach(([rid, st]) => { next[rid] = st; }); return next; });
    });
    return () => { alive = false; };
  }, [companyId, todayDispatches, sleepStops]);
  const stopsForSleep = useMemo(() => ({ ...sleepStops, ...routeStops }), [sleepStops, routeStops]);
  // ── 빈 차 확인(슬리핑 차일드) 미확인 목록(2026-08-18 건의 Eg8ZbQTMmPR6AAYo4fp0) ──
  // 🔴 "미확인" 은 시계가 아니라 **종점 도착**이 있어야 성립한다(운행 전 배차를 빨갛게
  //    쌓으면 그 목록은 곧 아무도 안 본다). 판정은 순수 모듈 lib/sleepingCheck.js.
  //    routeStops 는 노선도 뷰가 이미 로드해 둔 것을 그대로 쓴다(신규 구독 0).
  const sleepPending = pendingSleepChecks(visibleDispatches, stopsForSleep, Date.now());
  const sleepSummary = sleepCheckSummary(visibleDispatches, stopsForSleep, Date.now());
  // 🔴 확인은 됐지만 미심쩍은 건(먼 곳·도착 직후 즉시) — QR 은 사진으로 복제되므로
  //    막는 대신 드러낸다(2026-08-18 way 지적). NFC 확인은 여기 안 걸린다.
  const sleepSuspicious = visibleDispatches
    .map(d => ({ d, a: sleepCheckAudit(d) }))
    .filter(x => x.a.suspicious);

  const handleForceEnd = async (sig) => {
    setForceBusy(sig.id);
    try {
      await forceEndRun({ companyId, vehicleId: sig.vehicleId, driverId: sig.ownerDriverId || undefined });
      setForceDone(d => ({ ...d, [sig.id]: true }));
      setForceConfirm(null);
    } catch (e) {
      alert(`정리하지 못했습니다: ${e.message}`);
    } finally {
      setForceBusy(null);
    }
  };
  // 운행중 표시만 남은 기사(GPS 문서 없음) 되돌리기 — 위 경고 카드에서 호출.
  const handleForceEndDriver = async (d) => {
    setForceBusy(d.id);
    try {
      await forceEndRun({ companyId, vehicleId: d.vehicleId, driverId: d.id });
      setForceDone(x => ({ ...x, [d.id]: true }));
      setForceConfirm(null);
    } catch (e) {
      alert(`정리하지 못했습니다: ${e.message}`);
    } finally {
      setForceBusy(null);
    }
  };

  return (
    <div style={MS.wrap}>
      {/* 지도 뷰 — 노선도 모드에선 숨김(컴포넌트 마운트 유지로 카카오 SDK 재로딩 회피) */}
      <div style={{ position:"absolute", inset:0, visibility: viewMode === "map" ? "visible" : "hidden" }}>
        <Map center={center} style={MS.map} level={7} onCreate={m => { mapObjRef.current = m; }}>
          {/* 선택 차량 있으면 그 차량만 표시(클릭 후 그 차량만 보기), 없으면 전체(2026-06-23) */}
          {/* 차량 마커 — 기본 핀 대신 버스 아이콘 + 간략 정보 칩(2026-08-18 way 요청).
              승객앱(EmployeeApp) 버스 마커와 같은 시각 언어(원형 primary + 흰 테두리 + buspulse).
              🔴 신호 지연 판정은 MARKER_STALE_MS(5분) — 관제 목록의 isGpsFresh(60초)를 쓰면
              단말 차량이 1분 주기 폴링이라 마커 색이 매 분 깜빡인다. */}
          {(selected ? vehicles.filter(v => v.id === selected.id) : vehicles).map(v => v.lat && v.lng && (() => {
            const on = selected?.id === v.id;
            const stale = gpsAgeMs(v.updatedAt) >= MARKER_STALE_MS;
            const tone = stale ? "var(--color-label-alt)" : "var(--color-primary)";
            return (
              <CustomOverlayMap key={v.id} position={{ lat:v.lat, lng:v.lng }} yAnchor={0.5}
                zIndex={on ? 40 : 20} clickable>
                <div onClick={() => { setSelected(v); setCenter({ lat:v.lat, lng:v.lng }); }}
                  style={{ position:"relative", width:34, height:34, cursor:"pointer" }}>
                  {!stale && (
                    <span style={{ position:"absolute", inset:0, borderRadius:"50%", background:tone,
                      opacity:0.45, animation:"buspulse 2s ease-out infinite", pointerEvents:"none" }} />
                  )}
                  <div style={{ position:"absolute", inset:0, background:tone, border:"3px solid #fff",
                    borderRadius:"50%", display:"flex", alignItems:"center", justifyContent:"center", color:"#fff",
                    boxShadow: on ? "0 0 0 5px rgba(0,102,255,.28), var(--shadow-float)" : "var(--shadow-float)" }}>
                    <Icon name="bus" size={18} stroke={2} />
                  </div>
                  {/* 간략 정보 — 차량번호 + 속도(선택 시 노선명 한 줄 추가) */}
                  <div style={{ position:"absolute", top:39, left:"50%", transform:"translateX(-50%)",
                    display:"flex", flexDirection:"column", alignItems:"center", gap:2, pointerEvents:"none" }}>
                    <div style={{ display:"flex", alignItems:"center", gap:5, whiteSpace:"nowrap",
                      padding:"2px 7px", borderRadius:7, fontSize:10.5, lineHeight:1.3,
                      background: on ? tone : "rgba(255,255,255,0.95)",
                      color: on ? "#fff" : "var(--color-label)",
                      border: `1px solid ${on ? tone : "var(--color-line)"}`,
                      boxShadow:"var(--shadow-emphasize)" }}>
                      <span style={{ fontWeight:700 }}>{v.vehicleNo || v.id}</span>
                      <span style={{ fontWeight:600, opacity:0.75, fontFamily:"var(--font-mono)" }}>
                        {stale ? timeSince(v.updatedAt) : `${v.speed ?? 0}km/h`}
                      </span>
                    </div>
                    {on && (v.routeName || v.driverName) && (
                      <div style={{ maxWidth:170, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
                        padding:"1px 6px", borderRadius:6, fontSize:9.5, fontWeight:600,
                        background:"rgba(255,255,255,0.95)", color:"var(--color-label-mute)",
                        border:"1px solid var(--color-line)", boxShadow:"var(--shadow-emphasize)" }}>
                        {v.routeName || v.routeId || "노선 미지정"}
                        {v.driverName ? ` · ${v.driverName}` : ""}
                      </div>
                    )}
                  </div>
                </div>
              </CustomOverlayMap>
            );
          })())}
        </Map>
      </div>

      {/* 부유 글래스 탑바 — 로고+회사+ 지도/노선도 토글 */}
      <div style={isMobile ? { ...MS.topbar, ...MS.topbarMobile } : MS.topbar}>
        {/* 🔴 로고·회사명·화면이름은 모바일에서 뺀다(2026-08-26) — 상단 헤더가 이미 탭 이름을
            보여줘 중복이고, 그 폭을 실제 컨트롤(뷰 토글·날짜·거래처·새로고침)에 넘겨야
            글자가 눌려 세로로 쌓이지 않는다. */}
        {!isMobile && <BusLinkLogo size={20} />}
        {!isMobile && <div style={MS.topDivider} />}
        {!isMobile && <span style={MS.topCo}>동영관광 <span style={{ color:"var(--color-label-alt)" }}>· {companyId}</span></span>}
        {!isMobile && <span style={MS.topTab}><Icon name="pin" size={15}/> 실시간 관제</span>}
        {/* 뷰 토글 */}
        <div style={MS.viewToggle}>
          <button onClick={() => !isPastDate && setViewMode("map")}
            disabled={isPastDate}
            title={isPastDate ? "지도 뷰는 실시간(오늘) 전용" : ""}
            style={{ ...MS.viewBtn, ...(viewMode === "map" ? MS.viewBtnOn : {}),
              opacity: isPastDate ? 0.4 : 1, cursor: isPastDate ? "not-allowed" : "pointer" }}>
            🗺 지도
          </button>
          <button onClick={() => setViewMode("route")}
            style={{ ...MS.viewBtn, ...(viewMode === "route" ? MS.viewBtnOn : {}) }}>
            📊 노선도
          </button>
        </div>
        {/* 날짜 픽커 — 노선도 뷰에서 과거 날짜 조회 가능 */}
        <input type="date" value={selectedDate} max={today}
          onChange={e => { if (e.target.value) setSelectedDate(e.target.value); }}
          style={MS.dateInput}
          title="조회 날짜 (과거 데이터는 노선도 뷰만 가능)"/>
        {/* 거래처 필터 — 배차 관리 등과 같은 컴포넌트·같은 라벨(2026-08-20 광연 요청).
            선택 변경 시 선택 차량 해제: 필터에서 빠진 차량의 상세 패널이 남아 있으면
            "안 보이는 차량을 보고 있는" 상태가 된다. */}
        <div style={MS.topPartner}>
          <span style={{ fontSize:11, fontWeight:600, color:"var(--color-label-alt)", flexShrink:0 }}>거래처</span>
          <PartnerFilter companyId={companyId} value={partnerCode}
            onChange={(c) => { setPartnerCode(c); setSelected(null); }}
            allowedCodes={allowed}
            style={{ background:"var(--color-bg-soft)", padding:"5px 9px", fontWeight:600, minWidth:104, maxWidth:150 }} />
        </div>
        {isPastDate ? (
          <span style={MS.pastBadge}>📅 과거 데이터</span>
        ) : (
          <span style={MS.topNow}>
            <StatusDot tone="positive" size={6} pulse /> 실시간 GPS 수신
          </span>
        )}
        {/* #2 — 노선 새로고침: 기사 GPS 껐다 켜진 뒤 위치 미반영 시 수동 재연결·재구독 */}
        {!isPastDate && (
          <button onClick={handleRefresh} disabled={refreshing}
            title="GPS 위치를 즉시 다시 불러옵니다"
            style={{ display:"inline-flex", alignItems:"center", gap:4, padding:"4px 10px", borderRadius:8, border:"1px solid var(--color-line)", background:"var(--color-bg-soft)", color:"var(--color-label-mute)", cursor: refreshing ? "default":"pointer", fontFamily:"inherit", fontSize:12, fontWeight:700, opacity: refreshing ? 0.6:1 }}>
            <span style={{ display:"inline-block", animation: refreshing ? "blspin 0.8s linear infinite":"none" }}>↻</span>
            {refreshing ? "새로고침 중" : "새로고침"}
          </button>
        )}
      </div>

      {/* 좌 레일 — 운행 차량 목록(실 onSnapshot 데이터만) — 지도 모드만 */}
      {viewMode === "map" && (
      <div style={isMobile ? MS.railSheet : MS.leftRail}>
        <div style={MS.railHead}>
          <span style={MS.railTitle}>운행 중인 차량</span>
          {selected ? (
            <button onClick={() => setSelected(null)}
              style={{ fontSize:11, fontWeight:700, color:"var(--color-primary-deep)", background:"var(--color-bg-soft)", border:"1px solid var(--color-line)", borderRadius:6, padding:"3px 8px", cursor:"pointer", fontFamily:"inherit" }}
              title="선택 해제 — 전체 차량 보기">✕ 전체 보기</button>
          ) : (
            <Pill tone={liveCount > 0 ? "positive" : "neutral"} dot>{liveCount}대</Pill>
          )}
        </div>
        <div style={MS.railBody}>
          {vehicles.length === 0 ? (
            /* 필터 때문에 빈 것인지 실제로 없는 것인지 화면에서 구분되게 한다 */
            <div style={MS.empty}>
              운행 중인 차량 없음
              {partnerCode !== "전체" && <div style={{ fontSize:11, marginTop:6 }}>거래처 필터가 걸려 있습니다</div>}
            </div>
          ) : vehicles.map(v => {
            const on = selected?.id === v.id;
            return (
              <div key={v.id}
                onClick={() => { setSelected(v); if (v.lat && v.lng) setCenter({ lat:v.lat, lng:v.lng }); }}
                style={{ ...MS.vCard, ...(on ? MS.vCardOn : {}) }}>
                <div style={{ ...MS.vBar, background: on ? "var(--color-primary)" : "transparent" }} />
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={MS.vTop}>
                    <StatusDot tone="positive" size={7} />
                    <span style={{ ...MS.vName, color: on ? "var(--color-primary-deep)" : "var(--color-label)" }}>
                      {v.vehicleNo || v.id}
                    </span>
                  </div>
                  <div style={MS.vSub}>{v.routeName || v.routeId || "노선 미지정"}</div>
                  <div style={MS.vMeta}>기사 {v.driverName || v.driverId || "–"}</div>
                </div>
                <div style={{ textAlign:"right", flexShrink:0 }}>
                  <div style={MS.vSpeed}>{v.speed ?? 0}<span style={MS.vUnit}>km/h</span></div>
                  <div style={MS.vAgo}>{timeSince(v.updatedAt)}</div>
                </div>
              </div>
            );
          })}
        </div>
        {/* ⚠ GPS 미수신(운행중) — 좌표 없어 지도 마커 못 찍음 → 레일 경고로 표기(2026-06-23) */}
        {noGpsRunning.length > 0 && (
          <div style={{ borderTop:"1px solid var(--color-line)", padding:"10px 12px", background:"#FFF4E5" }}>
            <div style={{ fontSize:12, fontWeight:700, color:"#B26A00", marginBottom:8 }}>⚠ GPS 미수신 (운행중) {noGpsRunning.length}</div>
            {noGpsRunning.map(d => (
              <div key={d.id} style={{ fontSize:11, color:"var(--color-label)", padding:"3px 0" }}>
                <div>
                  <span style={{ fontWeight:700 }}>{d.name}</span>
                  <span style={{ color:"var(--color-label-mute)", marginLeft:6 }}>{d.vehicleNo || "차량 미지정"}</span>
                  <span style={{ color:"#B26A00", marginLeft:6 }}>신호 없음</span>
                </div>
                {/* 운행이 이미 끝났는데 상태만 "운행중" 으로 남은 기사를 관리자가 되돌린다
                    (기사가 운행 종료를 못 누른 채 앱 종료·폰 꺼짐 등). 2026-07-28 */}
                {forceDone[d.id] ? (
                  <div style={{ fontSize:10, color:"var(--color-positive)", marginTop:2 }}>✓ 대기 상태로 되돌렸습니다</div>
                ) : forceConfirm === d.id ? (
                  <div style={{ marginTop:4, padding:"6px 8px", background:"#fff", border:"1px solid #F0C68A", borderRadius:6 }}>
                    <div style={{ fontSize:10, color:"var(--color-label)", lineHeight:1.5 }}>
                      <b>{d.name}</b> 기사를 <b>대기</b> 상태로 되돌립니다.
                      {d.startedAt && <><br />운행 시작 기록: {String(d.startedAt).slice(0, 10)}</>}
                      <br />운행 중인 기사라면 실행하지 마세요.
                    </div>
                    <div style={{ display:"flex", gap:6, marginTop:6 }}>
                      <button disabled={forceBusy === d.id} onClick={() => handleForceEndDriver(d)}
                        style={{ flex:1, fontSize:10, fontWeight:700, padding:"5px 0", borderRadius:5, border:"none", background:"var(--color-destructive)", color:"#fff", cursor: forceBusy === d.id ? "default":"pointer", fontFamily:"inherit", opacity: forceBusy === d.id ? .6:1 }}>
                        {forceBusy === d.id ? "처리 중…" : "운행 강제 종료"}
                      </button>
                      <button onClick={() => setForceConfirm(null)}
                        style={{ flex:1, fontSize:10, fontWeight:700, padding:"5px 0", borderRadius:5, border:"1px solid var(--color-line)", background:"#fff", color:"var(--color-label-mute)", cursor:"pointer", fontFamily:"inherit" }}>
                        취소
                      </button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => setForceConfirm(d.id)}
                    style={{ marginTop:2, fontSize:10, fontWeight:700, color:"#B26A00", background:"transparent", border:"1px solid #E8B87A", borderRadius:5, padding:"2px 6px", cursor:"pointer", fontFamily:"inherit" }}>
                    운행 강제 종료
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* 🛏 빈 차 확인(슬리핑 차일드, 2026-08-18 건의) — 종점 도착 뒤 10분이 지나도록
            뒷좌석 QR/태그 확인이 없는 운행. 확인은 기사가 **차 뒤까지 가야** 찍힌다. */}
        {(sleepPending.length > 0 || sleepSummary.total > 0) && (
          <div style={{ borderTop:"1px solid var(--color-line)", padding:"10px 12px", background:"var(--color-bg-soft)" }}>
            <div style={{ fontSize:12, fontWeight:700, color:"var(--color-label)", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
              <span>🛏 빈 차 확인</span>
              <span style={{ fontSize:11, fontWeight:600, color: sleepPending.length ? "var(--color-destructive)" : "var(--color-positive)" }}>
                {sleepPending.length ? `미확인 ${sleepPending.length}건` : `완료 ${sleepSummary.done}건`}
              </span>
            </div>
            {sleepSuspicious.length > 0 && (
              <div style={{ marginTop:8, padding:"8px 10px", background:"var(--color-bg)", border:"1px solid var(--color-cautionary)", borderRadius:8 }}>
                <div style={{ fontSize:11, fontWeight:800, color:"var(--color-cautionary)" }}>확인 방식 점검 {sleepSuspicious.length}건</div>
                {sleepSuspicious.slice(0, 4).map(({ d, a }) => (
                  <div key={d.id} style={{ fontSize:11, color:"var(--color-label-mute)", marginTop:3 }}>
                    {d.vehicleNo || d.vehicleId} · {sleepAuditLabel(a.reasons)}
                  </div>
                ))}
              </div>
            )}
            {sleepPending.length === 0 ? (
              <div style={{ fontSize:11, color:"var(--color-label-mute)", marginTop:6 }}>
                {sleepSummary.waiting > 0 ? `확인 대기 ${sleepSummary.waiting}건 · ` : ""}운행 종료분 모두 확인되었습니다
              </div>
            ) : sleepPending.map(d => (
              <div key={d.id} style={{ marginTop:8, padding:"8px 10px", background:"var(--color-bg)", border:"1px solid var(--color-destructive)", borderRadius:8 }}>
                <div style={{ fontSize:12, fontWeight:700, color:"var(--color-label)" }}>
                  {d.vehicleNo || d.vehicleId || "차량"} · {d.routeName || d.routeId}
                </div>
                <div style={{ fontSize:11, color:"var(--color-label-mute)", marginTop:2 }}>
                  {d.driverName ? `${d.driverName} · ` : ""}종점 도착 뒤 {formatWaited(d.waitedMs)} 확인 없음
                </div>
              </div>
            ))}
          </div>
        )}
        {/* 🧹 잔존 운행 신호(2026-07-28 개선요청) — 기사가 "운행 종료"를 못 누른 채 남은
            gps 문서. 직원·승객앱 노선 탭이 이 문서 존재만 세어 "운행중"을 계속 표시한다.
            지울지는 마지막 신호 경과시간을 보고 운영자가 판단(자동 삭제 안 함). */}
        {visibleStaleSignals.length > 0 && (
          <div style={{ borderTop:"1px solid var(--color-line)", padding:"10px 12px", background:"var(--color-bg-soft)" }}>
            <div style={{ fontSize:12, fontWeight:700, color:"var(--color-label)", marginBottom:2 }}>
              🧹 잔존 운행 신호 {visibleStaleSignals.length}
            </div>
            <div style={{ fontSize:10, color:"var(--color-label-mute)", marginBottom:8, lineHeight:1.5 }}>
              마지막 신호가 {STALE_SIGNAL_MIN}분 넘게 끊긴 차량입니다. 승객·직원 화면에는 아직 <b>운행중</b>으로 보입니다.
            </div>
            {visibleStaleSignals.map(s => (
              <div key={s.id} style={{ padding:"6px 0", borderTop:"1px solid var(--color-line)" }}>
                <div style={{ fontSize:11, color:"var(--color-label)" }}>
                  <span style={{ fontWeight:700 }}>{s.routeName || "노선 미지정"}</span>
                  <span style={{ color:"var(--color-label-mute)", marginLeft:6 }}>{s.vehicleNo || s.vehicleId}</span>
                </div>
                <div style={{ fontSize:10, color:"var(--color-label-mute)", marginTop:2, display:"flex", flexWrap:"wrap", gap:6, alignItems:"center" }}>
                  <span>기사 {s.driverName || "–"}</span>
                  <span style={{ color:"var(--color-destructive)", fontWeight:700 }}>마지막 신호 {s.ageLabel}</span>
                  <span style={{ border:"1px solid var(--color-line)", borderRadius:4, padding:"0 4px", background:"#fff" }}>
                    {s.source === "device" ? "🛰 단말" : "📱 모바일"}
                  </span>
                  {s.orphan && (
                    <span style={{ border:"1px solid #E8B87A", color:"#B26A00", borderRadius:4, padding:"0 4px", background:"#FFF4E5" }}>
                      배정 기사 없음
                    </span>
                  )}
                </div>
                {forceDone[s.id] ? (
                  <div style={{ fontSize:10, color:"var(--color-positive)", marginTop:4 }}>✓ 정리했습니다</div>
                ) : forceConfirm === s.id ? (
                  <div style={{ marginTop:5, padding:"7px 8px", background:"#fff", border:"1px solid var(--color-line)", borderRadius:6 }}>
                    <div style={{ fontSize:10, color:"var(--color-label)", lineHeight:1.55 }}>
                      이 신호를 지우면 승객·직원 화면에서 <b>운행중</b> 표시가 사라집니다.
                      <br />마지막 신호: <b>{s.ageLabel}</b>
                      {s.ownerDriverId && <><br />{s.ownerDriverName} 기사도 <b>대기</b> 상태로 되돌립니다.</>}
                      {s.source === "device" && (
                        <><br /><span style={{ color:"#B26A00" }}>단말(GPS 기기) 차량입니다 — 운행 시간대에는 잠시 뒤 신호가 다시 올라옵니다.</span></>
                      )}
                      <br /><span style={{ color:"var(--color-label-mute)" }}>지금 운행 중인 차량이면 실행하지 마세요.</span>
                    </div>
                    <div style={{ display:"flex", gap:6, marginTop:6 }}>
                      <button disabled={forceBusy === s.id} onClick={() => handleForceEnd(s)}
                        style={{ flex:1, fontSize:10, fontWeight:700, padding:"5px 0", borderRadius:5, border:"none", background:"var(--color-destructive)", color:"#fff", cursor: forceBusy === s.id ? "default":"pointer", fontFamily:"inherit", opacity: forceBusy === s.id ? .6:1 }}>
                        {forceBusy === s.id ? "처리 중…" : "운행 강제 종료"}
                      </button>
                      <button onClick={() => setForceConfirm(null)}
                        style={{ flex:1, fontSize:10, fontWeight:700, padding:"5px 0", borderRadius:5, border:"1px solid var(--color-line)", background:"#fff", color:"var(--color-label-mute)", cursor:"pointer", fontFamily:"inherit" }}>
                        취소
                      </button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => setForceConfirm(s.id)}
                    style={{ marginTop:4, fontSize:10, fontWeight:700, color:"var(--color-primary-deep)", background:"#fff", border:"1px solid var(--color-line)", borderRadius:5, padding:"3px 8px", cursor:"pointer", fontFamily:"inherit" }}>
                    운행 강제 종료
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      )}

      {/* 노선도 뷰 — 오늘 배차된 각 노선의 정류장 타임라인 + 지연/조기 라벨 */}
      {viewMode === "route" && (
        <RouteTimelineView
          companyId={companyId}
          routes={routes}
          routeStops={routeStops}
          dispatches={visibleDispatches}
          vehicles={isPastDate ? [] : vehicles}
          tick={tick}
          selectedDate={selectedDate}
          isPastDate={isPastDate}
        />
      )}

      {/* 우 상세 — 선택 차량(실데이터 stats·기사). 가짜 ETA/탑승인원/정류장 타임라인 제외 */}
      {viewMode === "map" && selected && (
        <div style={MS.detail}>
          <div style={MS.detailHead}>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <Pill tone="positive" dot>운행 중</Pill>
                <span style={MS.detailAgo}>{timeSince(selected.updatedAt)} 수신</span>
              </div>
              <div style={MS.detailNo}>{selected.vehicleNo || selected.id}</div>
              <div style={MS.detailRoute}>{selected.routeName || selected.routeId || "노선 미지정"}</div>
            </div>
            <button onClick={() => setSelected(null)} style={MS.closeBtn} title="닫기">
              <Icon name="close" size={16}/>
            </button>
          </div>
          <div style={MS.statGrid}>
            <div style={MS.stat}>
              <div style={MS.statLabel}>현재 속도</div>
              <div style={MS.statVal}>{selected.speed ?? 0}<span style={MS.statUnit}>km/h</span></div>
            </div>
            <div style={MS.stat}>
              <div style={MS.statLabel}>GPS 정확도</div>
              <div style={MS.statVal}>±{selected.accuracy ?? "–"}<span style={MS.statUnit}>m</span></div>
            </div>
          </div>
          <div style={MS.driverRow}>
            <div style={MS.driverAv}>{(selected.driverName || "기")[0]}</div>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={MS.driverName}>{selected.driverName || selected.driverId || "기사 미지정"} 기사</div>
              <div style={MS.driverSub}>차량 {selected.vehicleNo || selected.id}</div>
            </div>
          </div>
          <div style={MS.coordBox}>
            <div style={MS.coordItem}>
              <span style={MS.coordLbl}>위도</span>
              <span style={MS.coordVal}>{selected.lat?.toFixed?.(6) ?? "–"}</span>
            </div>
            <div style={MS.coordItem}>
              <span style={MS.coordLbl}>경도</span>
              <span style={MS.coordVal}>{selected.lng?.toFixed?.(6) ?? "–"}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 노선도 뷰 (실시간 관제 보조 뷰, 2026-05-26) ──────────────────────
// 오늘 배차된 각 노선의 정류장 타임라인 + 계획·실측/예상·지연/조기 표시.
// computeStopEstimates 재사용(승객앱/기사앱과 동일 알고리즘) — 같은 분/지연 정합.
// 데이터 결합: dispatch + 해당 routeId의 stops + dispatch.vehicleId의 라이브 GPS.
function RouteTimelineView({ companyId, routes, routeStops, dispatches, vehicles, tick, selectedDate, isPastDate }) {
  if (dispatches.length === 0) {
    return (
      <div style={MS.routeWrap}>
        <div style={MS.routeEmpty}>
          {isPastDate ? `${selectedDate} 배차 내역이 없습니다.` : "오늘 배차된 노선이 없습니다."}<br/>
          <span style={{ fontSize:12, color:"var(--color-label-alt)" }}>
            {isPastDate ? "다른 날짜를 선택하거나 배차 관리에서 확인하세요." : "배차 관리 탭에서 오늘 배차를 등록하세요."}
          </span>
        </div>
      </div>
    );
  }
  // departTime 오름차순(이른 시간 먼저). 같은 시간이면 routeName.
  const sorted = [...dispatches].sort((a, b) => {
    const ta = a.departTime || "99:99", tb = b.departTime || "99:99";
    return ta.localeCompare(tb) || (a.routeName || "").localeCompare(b.routeName || "");
  });
  return (
    <div style={MS.routeWrap}>
      <div style={MS.routeGrid}>
        {sorted.map(d => (
          <RouteTimelineCard key={d.id}
            companyId={companyId}
            dispatch={d}
            route={routes.find(r => r.id === d.routeId)}
            stops={routeStops[d.routeId] || []}
            vehicle={vehicles.find(v => v.vehicleId === d.vehicleId)}
            selectedDate={selectedDate}
            isPastDate={isPastDate}
            tick={tick}
          />
        ))}
      </div>
    </div>
  );
}

function RouteTimelineCard({ dispatch, route, stops, vehicle, selectedDate, isPastDate }) {
  // stops가 아직 로딩 중이면 스켈레톤 노출.
  const loading = stops.length === 0;
  // 운행 기준 시각 — 오늘은 실시간(Date.now), 과거 조회는 그 날짜 시작시각(자정).
  //   plannedMs 는 이 시각의 "날짜"에 앵커링되므로(computeStopEstimates→hhmmToTodayMillis),
  //   조회 날짜와 같은 날에 맞춰야 지연(delaySec)이 그 날 시간대 기준으로 정확하다.
  const nowMs = isPastDate ? parseDateStartMs(selectedDate) : Date.now();
  // 운행 날짜 창(로컬 자정~자정) — 이 창 밖의 stopArrivals 는 "다른 날 기록"이라
  //   같은 배차의 유효 도착으로 취급하지 않는다. 근인 = 다른 날짜에서 복제되었거나
  //   과거 회차가 잔존한 stopArrivals(actualAt 이 며칠 전)를 오늘/조회일 도착으로
  //   오인해 "조기도착 수천분"(계획−실측 절대차가 며칠) 으로 표시되던 결함 원천 차단.
  const dayStartMs = (() => { const d = new Date(nowMs); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000;
  // 계획·실측/예상 산출. dispatch.stopArrivals = { [stopId]: { actualAt: serverTimestamp, ... } } → millis.
  const actualArrivals = {};
  const sa = dispatch.stopArrivals || {};
  for (const k in sa) {
    const a = sa[k];
    const ms = a?.actualAt?.toMillis ? a.actualAt.toMillis()
      : (typeof a?.actualAt === "number" ? a.actualAt : null);
    // 운행 날짜 창 안의 도착만 유효(다른 날 기록은 무시 — 위 주석 참조).
    if (ms != null && ms >= dayStartMs && ms < dayEndMs) actualArrivals[k] = ms;
  }
  const estimates = computeStopEstimates({
    stops,
    departTime: dispatch.departTime || route?.departTime || "",
    actualArrivals,
    vehiclePos: vehicle && typeof vehicle.lat === "number" ? { lat: vehicle.lat, lng: vehicle.lng } : null,
    speed: vehicle?.speed,
    routePath: Array.isArray(route?.routePath) ? route.routePath : null,
    now: nowMs,
  });
  const estByStopId = Object.fromEntries(estimates.map(e => [e.stopId, e]));

  // 운행 상태: arrived 1개라도 있고 모두 arrived 아니면 운행중 / 모두 arrived면 완료 / 그 외 대기
  const arrivedCount = estimates.filter(e => e.status === "arrived").length;
  const totalPlanned = estimates.filter(e => e.plannedAt).length;
  const allArrived = arrivedCount === stops.length && stops.length > 0;
  const running = arrivedCount > 0 && !allArrived;
  const statusTone = allArrived ? "positive" : running ? "primary" : "neutral";
  const statusLabel = allArrived ? "운행 완료" : running ? "운행 중" : "대기 중";

  // 가장 최근 도착 정류장 idx — 버스 위치 표시 기준.
  let lastArrivedIdx = -1;
  stops.forEach((s, i) => { if (actualArrivals[s.id] != null) lastArrivedIdx = i; });

  return (
    <div style={MS.routeCard}>
      {/* 카드 헤더 */}
      <div style={MS.routeCardHead}>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
            <span style={MS.routeName}>{dispatch.routeName || route?.name || "노선 미지정"}</span>
            <Pill tone={statusTone} dot>{statusLabel}</Pill>
          </div>
          <div style={MS.routeMeta}>
            <span>출발 <b style={{ color:"var(--color-label)" }}>{dispatch.departTime || "–"}</b></span>
            <span style={MS.dot}>·</span>
            <span>{dispatch.driverName || "기사 미지정"}</span>
            <span style={MS.dot}>·</span>
            <span>{dispatch.vehicleNo || "차량 미지정"}</span>
            {vehicle && typeof vehicle.speed === "number" && (
              <>
                <span style={MS.dot}>·</span>
                <span style={{ fontFamily:"var(--font-mono)", fontWeight:700, color:"var(--color-primary)" }}>
                  {Math.round(vehicle.speed)} km/h
                </span>
              </>
            )}
          </div>
          {totalPlanned > 0 && stops.length > 0 && (
            <div style={MS.routeProgress}>
              <span style={{ color:"var(--color-label-mute)" }}>진행</span>
              <span style={{ fontWeight:700, color:"var(--color-label)" }}>
                {arrivedCount} / {stops.length}
              </span>
              <div style={MS.progressBar}>
                <div style={{ ...MS.progressFill,
                  width: `${stops.length > 0 ? (arrivedCount / stops.length) * 100 : 0}%` }} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 정류장 타임라인 */}
      <div style={MS.timelineWrap}>
        {loading ? (
          <div style={MS.routeEmpty}>정류장 로딩 중...</div>
        ) : stops.length === 0 ? (
          <div style={MS.routeEmpty}>등록된 정류장이 없습니다</div>
        ) : (
          <div style={{ position:"relative" }}>
            {/* 세로 연결선 */}
            <div style={MS.timelineSpine} />
            {stops.map((s, i) => {
              const e = estByStopId[s.id];
              const arrived = e?.status === "arrived";
              const isNext = e?.status === "next";
              const lab = e ? formatDelayLabel(e.delaySec) : { tone:"mute", label:"" };
              const labColor = lab.tone === "danger" ? "var(--color-destructive)"
                : lab.tone === "warn" ? "var(--color-cautionary)"
                : "var(--color-positive)";
              const labBg = lab.tone === "danger" ? "#FCE5E5"
                : lab.tone === "warn" ? "#FFF1E0"
                : "#E6F7EB";
              // 버스 마커 — 가장 최근 도착 정류장 직후에 표시(다음 정류장 위가 아닌 사이).
              const showBus = i === lastArrivedIdx && lastArrivedIdx >= 0 && !allArrived;
              return (
                <div key={s.id}>
                  <div style={MS.timelineRow}>
                    <div style={{
                      ...MS.timelineDot,
                      background: arrived ? "var(--color-positive)"
                        : isNext ? "var(--color-primary)"
                        : "#fff",
                      borderColor: arrived ? "var(--color-positive)"
                        : isNext ? "var(--color-primary)"
                        : "var(--color-atomic-coolNeutral-85)",
                    }}>
                      {arrived && <span style={{ color:"#fff", fontSize:10, fontWeight:800 }}>✓</span>}
                    </div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={MS.stopName}>{i+1}. {s.name}</div>
                      {(e?.plannedAt || e?.estimatedAt) && (
                        <div style={MS.stopTimeRow}>
                          {e.plannedAt && (
                            <>
                              <span style={MS.stopTimeLbl}>계획</span>
                              <span style={MS.stopTimeVal}>{e.plannedAt}</span>
                            </>
                          )}
                          {e.estimatedAt && e.estimatedAt !== e.plannedAt && (
                            <>
                              {e.plannedAt && <span style={MS.dotSm}>·</span>}
                              <span style={MS.stopTimeLbl}>
                                {arrived ? "도착" : "예상"}
                              </span>
                              <span style={{
                                ...MS.stopTimeVal,
                                color: arrived ? "var(--color-positive)" : "var(--color-primary-deep)",
                              }}>{e.estimatedAt}</span>
                            </>
                          )}
                          {lab.label && lab.tone !== "mute" && (
                            <span style={{
                              fontSize:11, fontWeight:800,
                              padding:"2px 9px", borderRadius:999,
                              background: labBg, color: labColor,
                              border: `1px solid ${labColor}`,
                            }}>{lab.label}</span>
                          )}
                        </div>
                      )}
                      {!e?.plannedAt && !e?.estimatedAt && (
                        <div style={{ fontSize:11, color:"var(--color-label-alt)", marginTop:3 }}>
                          {s.address || "정류장 진입시각 미설정"}
                        </div>
                      )}
                    </div>
                  </div>
                  {/* 버스 위치 마커 — 도착한 마지막 정류장 직후에 표시 */}
                  {showBus && (
                    <div style={MS.busRow}>
                      <div style={MS.busDot}>🚌</div>
                      <div style={{ fontSize:11, color:"var(--color-primary)", fontWeight:700 }}>
                        현재 위치 {vehicle && typeof vehicle.speed === "number" && (
                          <span style={{ color:"var(--color-label-mute)", fontWeight:500, marginLeft:4 }}>
                            ({Math.round(vehicle.speed)} km/h)
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// MapTab 전용 라이트 스타일(리디자인 3단계). 공유 S 객체 무손상 → 타 9탭 격리.
const MS = {
  wrap:{ position:"relative", height:"100%", minHeight:0, overflow:"hidden", background:"var(--color-bg-soft)", fontFamily:"var(--font-base)" },
  map:{ position:"absolute", inset:0, width:"100%", height:"100%" },
  topbar:{ position:"absolute", top:12, left:12, right:12, height:52, display:"flex", alignItems:"center", gap:14, padding:"0 18px", background:"rgba(255,255,255,0.92)", backdropFilter:"blur(20px)", WebkitBackdropFilter:"blur(20px)", border:"1px solid var(--color-line)", borderRadius:14, boxShadow:"var(--shadow-float)", zIndex:20 },
  topDivider:{ width:1, height:20, background:"var(--color-line)" },
  topCo:{ fontSize:13, fontWeight:600, color:"var(--color-label-mute)" },
  topTab:{ marginLeft:24, display:"flex", alignItems:"center", gap:6, fontSize:13, fontWeight:700, color:"var(--color-primary)", background:"var(--color-primary-soft)", padding:"7px 12px", borderRadius:8 },
  topNow:{ marginLeft:"auto", display:"flex", alignItems:"center", gap:7, fontSize:12, fontWeight:600, color:"var(--color-label-mute)" },
  leftRail:{ position:"absolute", top:76, left:12, bottom:12, width:"min(280px,32vw)", minWidth:200, display:"flex", flexDirection:"column", background:"var(--color-bg)", borderRadius:16, boxShadow:"var(--shadow-float)", zIndex:10, overflow:"hidden" },
  // ── 모바일 전용(2026-08-26 way "왼쪽 메뉴가 가리지 않게 · 세로글씨 안 나오게") ──
  // 🔴 탑바가 세로글씨의 근인이었다: 컨트롤 9개를 **고정 height:52 · 줄바꿈 없음** 한 줄에
  //    밀어 넣어, 폭이 모자라면 각 항목이 min-content 까지 찌부러지고 한글은 글자당 한 줄로
  //    쌓인다(영문은 단어 단위라 덜 티가 나서 PC 에서 안 보였다). 높이를 풀고 줄바꿈을 켠다.
  topbarMobile:{ top:8, left:8, right:8, height:"auto", flexWrap:"wrap", gap:8, rowGap:8, padding:"10px 12px", borderRadius:12 },
  // 🔴 차량 목록을 왼쪽에 두면 좁은 화면에서 지도를 절반 넘게 가린다 — `minWidth:200` 이
  //    `32vw` 를 이겨 360px 기기에서 200px(=56%)를 먹었다. 모바일은 **하단 시트**로 내린다.
  //    (지도 앱들의 관례이기도 하다. 세로로 40% 를 쓰면 지도 상단이 온전히 남는다.)
  railSheet:{ position:"absolute", left:8, right:8, bottom:8, top:"auto", width:"auto", minWidth:0, maxHeight:"40%", display:"flex", flexDirection:"column", background:"var(--color-bg)", borderRadius:16, boxShadow:"var(--shadow-float)", zIndex:10, overflow:"hidden" },
  railHead:{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"16px 16px 12px", borderBottom:"1px solid var(--color-bg-soft)", flexShrink:0 },
  railTitle:{ fontSize:15, fontWeight:700, color:"var(--color-label)" },
  railBody:{ flex:1, overflowY:"auto", padding:"8px" },
  empty:{ color:"var(--color-label-alt)", fontSize:13, textAlign:"center", padding:"32px 16px" },
  vCard:{ display:"flex", gap:10, padding:"11px 10px", borderRadius:10, marginTop:2, cursor:"pointer", transition:"background .12s" },
  vCardOn:{ background:"var(--color-primary-soft)" },
  vBar:{ width:4, alignSelf:"stretch", borderRadius:4, flexShrink:0 },
  vTop:{ display:"flex", alignItems:"center", gap:7, marginBottom:3 },
  vName:{ fontSize:13.5, fontWeight:700 },
  vSub:{ fontSize:11.5, color:"var(--color-label-mute)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" },
  vMeta:{ fontSize:11, color:"var(--color-label-alt)", marginTop:1 },
  vSpeed:{ fontSize:14, fontWeight:800, color:"var(--color-label)", fontFamily:"var(--font-mono)" },
  vUnit:{ fontSize:10, fontWeight:600, color:"var(--color-label-alt)", marginLeft:2 },
  vAgo:{ fontSize:10, color:"var(--color-label-alt)", marginTop:2 },
  detail:{ position:"absolute", top:76, right:12, bottom:12, width:320, display:"flex", flexDirection:"column", background:"var(--color-bg)", borderRadius:16, boxShadow:"var(--shadow-float)", zIndex:10, overflow:"hidden" },
  detailHead:{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:10, padding:"18px 18px 14px", borderBottom:"1px solid var(--color-bg-soft)" },
  detailAgo:{ fontSize:11, color:"var(--color-label-mute)" },
  detailNo:{ fontFamily:"var(--font-brand)", fontSize:26, fontWeight:800, letterSpacing:"-0.02em", marginTop:8, color:"var(--color-label)" },
  detailRoute:{ fontSize:13, color:"var(--color-label-mute)", marginTop:2 },
  closeBtn:{ width:32, height:32, flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center", border:"none", background:"var(--color-bg-alt)", borderRadius:8, color:"var(--color-label-mute)", cursor:"pointer", fontFamily:"inherit" },
  statGrid:{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, padding:"16px 18px", borderBottom:"1px solid var(--color-bg-soft)" },
  stat:{},
  statLabel:{ fontSize:11, fontWeight:600, color:"var(--color-label-mute)" },
  statVal:{ fontFamily:"var(--font-brand)", fontSize:22, fontWeight:800, letterSpacing:"-0.02em", marginTop:3, color:"var(--color-label)" },
  statUnit:{ fontSize:11, fontWeight:600, color:"var(--color-label-mute)", marginLeft:3 },
  driverRow:{ display:"flex", alignItems:"center", gap:12, padding:"16px 18px", borderBottom:"1px solid var(--color-bg-soft)" },
  driverAv:{ width:40, height:40, borderRadius:"50%", flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center", background:"var(--color-primary-soft)", color:"var(--color-primary-deep)", fontWeight:700, fontSize:15 },
  driverName:{ fontSize:14, fontWeight:700, color:"var(--color-label)" },
  driverSub:{ fontSize:12, color:"var(--color-label-mute)", marginTop:1 },
  coordBox:{ padding:"16px 18px", display:"flex", flexDirection:"column", gap:8 },
  coordItem:{ display:"flex", alignItems:"center", justifyContent:"space-between" },
  coordLbl:{ fontSize:12, color:"var(--color-label-mute)", fontWeight:600 },
  coordVal:{ fontSize:13, color:"var(--color-label)", fontFamily:"var(--font-mono)" },
  // ─── 노선도 뷰 (2026-05-26) ─────────────────────────────
  viewToggle:{ marginLeft:12, display:"flex", gap:2, padding:3, background:"var(--color-bg-soft)", border:"1px solid var(--color-line)", borderRadius:8 },
  viewBtn:{ padding:"5px 11px", fontSize:12, fontWeight:700, fontFamily:"inherit", border:"none", background:"transparent", color:"var(--color-label-mute)", borderRadius:6, cursor:"pointer", transition:"all .12s" },
  viewBtnOn:{ background:"var(--color-bg)", color:"var(--color-primary)", boxShadow:"0 1px 3px rgba(0,0,0,.08)" },
  dateInput:{ marginLeft:8, padding:"5px 9px", fontSize:12, fontWeight:600, fontFamily:"inherit", color:"var(--color-label)", background:"var(--color-bg-soft)", border:"1px solid var(--color-line)", borderRadius:8, outline:"none", cursor:"pointer" },
  topPartner:{ marginLeft:8, display:"flex", alignItems:"center", gap:6, minWidth:0 },
  pastBadge:{ marginLeft:"auto", display:"inline-flex", alignItems:"center", gap:6, fontSize:12, fontWeight:700, color:"var(--color-cautionary)", background:"#FFF1E0", border:"1px solid #FFE0C2", padding:"5px 11px", borderRadius:999 },
  routeWrap:{ position:"absolute", top:76, left:12, right:12, bottom:12, overflowY:"auto", zIndex:5, padding:"4px 4px 12px", background:"var(--color-bg-soft)", borderRadius:14 },
  routeGrid:{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(360px, 1fr))", gap:14 },
  routeEmpty:{ textAlign:"center", padding:"48px 16px", color:"var(--color-label-mute)", fontSize:14, lineHeight:1.6 },
  routeCard:{ background:"var(--color-bg)", border:"1px solid var(--color-line)", borderRadius:14, boxShadow:"var(--shadow-soft)", display:"flex", flexDirection:"column", overflow:"hidden" },
  routeCardHead:{ padding:"14px 16px 12px", borderBottom:"1px solid var(--color-bg-soft)", background:"var(--color-bg)" },
  routeName:{ fontSize:15, fontWeight:800, fontFamily:"var(--font-brand)", letterSpacing:"-0.01em", color:"var(--color-label)" },
  routeMeta:{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap", fontSize:12, color:"var(--color-label-mute)", marginTop:6 },
  dot:{ color:"var(--color-line)" },
  dotSm:{ color:"var(--color-line)", fontSize:11 },
  routeProgress:{ display:"flex", alignItems:"center", gap:8, marginTop:8, fontSize:12 },
  progressBar:{ flex:1, height:6, borderRadius:3, background:"var(--color-bg-soft)", overflow:"hidden" },
  progressFill:{ height:"100%", background:"linear-gradient(90deg, var(--color-primary) 0%, var(--color-positive) 100%)", borderRadius:3, transition:"width .3s ease" },
  timelineWrap:{ padding:"12px 16px 16px", maxHeight:"60vh", overflowY:"auto" },
  timelineSpine:{ position:"absolute", left:9, top:8, bottom:8, width:2, background:"var(--color-line)", borderRadius:2 },
  timelineRow:{ display:"flex", alignItems:"flex-start", gap:12, padding:"7px 0", position:"relative", zIndex:1 },
  timelineDot:{ width:20, height:20, borderRadius:"50%", border:"2.5px solid", flexShrink:0, marginTop:2, display:"flex", alignItems:"center", justifyContent:"center", background:"#fff" },
  stopName:{ fontSize:13, fontWeight:700, color:"var(--color-label)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" },
  stopTimeRow:{ display:"flex", alignItems:"center", gap:5, flexWrap:"wrap", marginTop:4, fontSize:12 },
  stopTimeLbl:{ color:"var(--color-label-mute)", fontWeight:600 },
  stopTimeVal:{ fontWeight:800, color:"var(--color-label)", fontFamily:"var(--font-brand)" },
  busRow:{ display:"flex", alignItems:"center", gap:12, padding:"4px 0 4px 2px", position:"relative", zIndex:2 },
  busDot:{ width:20, height:20, borderRadius:"50%", background:"var(--color-primary)", border:"2.5px solid #fff", flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, boxShadow:"0 2px 8px rgba(0,102,255,.35)" },
};

// ═══════════════════════════════════════════════════════
// 탭2: 배차 관리
// ═══════════════════════════════════════════════════════
// 검색형 선택 — 기사/차량/노선이 수백 건일 때 스크롤 대신 타이핑 검색(2026-06-15).
// options: [{ value, label }]. onChange(value) 직접 전달(기존 native select 핸들러 시그니처 호환).
function SearchableSelect({ value, onChange, options, placeholder = "선택", disabled }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef(null);
  const selected = options.find(o => o.value === value);
  const ql = q.trim().toLowerCase();
  const filtered = ql ? options.filter(o => (o.label || "").toLowerCase().includes(ql)) : options;
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const pick = (v) => { onChange(v); setOpen(false); setQ(""); };
  return (
    <div ref={ref} style={{ position:"relative" }}>
      <button type="button" disabled={disabled} onClick={() => { setOpen(o => !o); setQ(""); }}
        style={{ ...S.input, textAlign:"left", display:"flex", justifyContent:"space-between", alignItems:"center",
          cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.6 : 1 }}>
        <span style={{ color: selected ? "var(--color-label)" : "var(--color-label-mute)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
          {selected ? selected.label : placeholder}
        </span>
        <span style={{ color:"var(--color-label-mute)", marginLeft:8, flexShrink:0 }}>▾</span>
      </button>
      {open && (
        <div style={{ position:"absolute", zIndex:60, top:"calc(100% + 4px)", left:0, right:0,
          background:"var(--color-bg)", border:"1px solid var(--color-line)", borderRadius:8,
          boxShadow:"var(--shadow-emphasize)", maxHeight:260, overflowY:"auto" }}>
          <div style={{ padding:8, position:"sticky", top:0, background:"var(--color-bg)", borderBottom:"1px solid var(--color-line-soft)" }}>
            <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="🔍 이름·번호 검색"
              style={{ ...S.input, margin:0, fontSize:13, padding:"7px 10px" }} />
          </div>
          <button type="button" onClick={() => pick("")}
            style={{ display:"block", width:"100%", textAlign:"left", padding:"8px 12px", background:"none",
              border:"none", cursor:"pointer", fontSize:13, color:"var(--color-label-mute)", fontFamily:"inherit" }}>
            {placeholder}
          </button>
          {filtered.length === 0 ? (
            <div style={{ padding:"10px 12px", fontSize:12, color:"var(--color-label-mute)" }}>검색 결과 없음</div>
          ) : filtered.map(o => (
            <button type="button" key={o.value} onClick={() => pick(o.value)}
              style={{ display:"block", width:"100%", textAlign:"left", padding:"8px 12px",
                background: o.value === value ? "var(--color-primary-soft)" : "none", border:"none", cursor:"pointer",
                fontSize:13, fontFamily:"inherit", color: o.value === value ? "var(--color-primary-deep)" : "var(--color-label)",
                overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function DispatchTab({ companyId, vehicles, drivers, allowed, currentUserUid }) {
  const [date, setDate] = useState(getToday());
  const [dispatches, setDispatches] = useState([]);
  const [routes, setRoutes] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [editOriginalDate, setEditOriginalDate] = useState(null); // ★ 수정 시 원본 날짜 추적
  const [form, setForm] = useState({ driverId:"", routeId:"", routeName:"", vehicleNo:"", vehicleId:"", departTime:"" });
  const [loading, setLoading] = useState(false);
  const [partnerCode, setPartnerCode] = useState("전체"); // 협력사 필터

  useEffect(() => {
    if (!companyId || !date) return; // ★ date 빈값 방지
    const ref = collection(db, "companies", companyId, "dispatches", date, "list");
    return onSnapshot(ref, snap => setDispatches(snap.docs.map(d => ({ id:d.id, ...d.data() }))));
  }, [date, companyId]);

  useEffect(() => {
    if (!companyId) return;
    return onSnapshot(collection(db, "companies", companyId, "routes"), snap => {
      setRoutes(snap.docs.map(d => ({ id:d.id, ...d.data() })));
    });
  }, [companyId]);

  const openAdd = () => { setEditItem(null); setEditOriginalDate(null); setForm({ driverId:"", routeId:"", routeName:"", vehicleNo:"", vehicleId:"", departTime:"" }); setShowForm(true); };
  const openEdit = (item) => {
    setEditItem(item);
    setEditOriginalDate(date); // ★ 현재 보고 있는 날짜가 원본
    setForm({ driverId:item.driverId, routeId:item.routeId??"", routeName:item.routeName, vehicleNo:item.vehicleNo, vehicleId:item.vehicleId??"", departTime:item.departTime });
    setShowForm(true);
  };

  const handleDriverSelect = (driverId) => {
    if (!driverId) { setForm({...form, driverId:""}); return; }
    const drv = drivers.find(d => d.id === driverId);
    if (drv?.vehicleId) {
      const v = vehicles.find(x => x.id === drv.vehicleId);
      setForm({...form, driverId, vehicleId:drv.vehicleId, vehicleNo:v?.plateNo||drv.vehicleNo||""});
    } else { setForm({...form, driverId}); }
  };

  const handleRouteSelect = (routeId) => {
    if (!routeId) { setForm({...form, routeId:"", routeName:"", departTime:""}); return; }
    const r = routes.find(x => x.id === routeId);
    setForm({...form, routeId, routeName:r?.name||"", departTime:r?.departTime||""});
  };

  const handleVehicleSelect = (vehicleId) => {
    if (!vehicleId) { setForm({...form, vehicleId:"", vehicleNo:""}); return; }
    const v = vehicles.find(x => x.id === vehicleId);
    setForm({...form, vehicleId, vehicleNo:v?.plateNo||""});
  };

  const handleSave = async () => {
    if (!form.driverId || !form.routeName || !form.departTime) return alert("필수 항목을 입력해주세요");
    if (!companyId || !date) return; // ★ 가드
    setLoading(true);
    try {
      if (editItem && editOriginalDate) {
        // ★ 수정: 원본 날짜 기준으로 업데이트 (날짜 이동 후 수정 시 엉뚱한 날짜에 잘못된 문서 생성 방지)
        // 펼침 배차를 손으로 고쳤으면 표시를 남긴다(2026-08-20) — 나중에 일정을 저장할 때
        // 그날 수정분을 일정 값으로 되씌우지 않기 위한 유일한 단서다(@lib/dispatchSchedule.js).
        const patch = { ...form, date: editOriginalDate };
        if (editItem.source === "schedule") patch.manualOverride = true;
        await updateDoc(doc(db, "companies", companyId, "dispatches", editOriginalDate, "list", editItem.id), patch);
      } else {
        // 신규: 현재 선택된 날짜에 추가
        const ref = collection(db, "companies", companyId, "dispatches", date, "list");
        await addDoc(ref, { ...form, date, createdBy: currentUserUid || null });
      }
    } catch (e) {
      alert("저장 오류: " + e.message);
    }
    setShowForm(false); setLoading(false);
  };

  const handleDelete = async (id) => {
    if (!window.confirm("삭제하시겠습니까?")) return;
    await deleteDoc(doc(db, "companies", companyId, "dispatches", date, "list", id));
  };

  // ★ 배차 복사 — 현재 날짜 배차를 다른 날짜로 복사
  // ⚠ `...data` 스프레드 금지(2026-07-22) — 복사본은 **계획 정보만** 물려받고 운행 실행 상태는 버린다.
  //    옛 스프레드는 `stopArrivals`(실 도착기록)·`preArrivalNotified`(도착 임박 푸시 멱등 마커)까지
  //    미래 날짜 배차에 복제해 ① recordStopArrival 멱등 가드가 그 날 실제 도착 기록을 skip
  //    ② notifyPreArrival 이 "이미 발송함"으로 보고 도착 임박 푸시를 건너뜀 — 둘 다 silent.
  //    `scheduleId`/`source:"schedule"` 도 제외: 수동 복사본은 수동 배차다(펼침 산출물로 위장하면
  //    운영자가 "일정에서 나온 배차"로 오인). 노선 복사(handleCopy)와 동일한 명시 필드 화이트리스트 규칙.
  const handleCopyDispatches = async () => {
    // createdBy 격리: 제한 admin 은 본인이 볼 수 있는 배차만 복사(타 담당자 배차 오귀속 차단). createdBy 는 원 담당자 보존.
    const source = dispatches.filter(canSeeDispatch);
    if (source.length === 0) return alert("복사할 배차가 없습니다");
    const targetDate = prompt("복사할 대상 날짜를 입력하세요 (예: 2026-03-24)", "");
    if (!targetDate || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) return;
    if (targetDate === date) return alert("같은 날짜로는 복사할 수 없습니다");
    if (!window.confirm(`${date} 배차 ${source.length}건을 ${targetDate}로 복사하시겠습니까?`)) return;
    setLoading(true);
    try {
      const ref = collection(db, "companies", companyId, "dispatches", targetDate, "list");
      for (const d of source) {
        const data = {
          routeId: d.routeId ?? "",
          routeName: d.routeName ?? "",
          driverId: d.driverId ?? "",
          vehicleId: d.vehicleId ?? "",
          vehicleNo: d.vehicleNo ?? "",
          departTime: d.departTime ?? "",
          createdBy: d.createdBy ?? null,
          date: targetDate,
        };
        if (d.driverName) data.driverName = d.driverName; // CF 펼침분만 보유(표시용 라벨)
        await addDoc(ref, data);
      }
      alert(`${source.length}건 복사 완료`);
    } catch (e) { alert("복사 오류: " + e.message); }
    setLoading(false);
  };

  const driverName = (id) => drivers.find(d => d.id === id)?.name ?? id;
  // routeId → route(partnerCode/partnerName) 매핑
  const routeOf = (id) => routes.find(r => r.id === id);
  const canSeeAll = isAllAccess(allowed);
  // createdBy 격리(2026-06-17): 제한 admin 은 본인 소유 배차만 — ① 노선 partnerCode 가 allowed(담당·본인생성 거래처) ②
  //   노선 createdBy===uid(거래처 미지정 자기 노선) ③ 배차 createdBy===uid(routeId 없는 수기 배차 포함). 전체권한/슈퍼관리자는 전부.
  const canSeeDispatch = (d) => {
    if (canSeeAll) return true;
    const r = routeOf(d.routeId);
    return partnerCodeAllowed(allowed, r?.partnerCode)
      || (!!currentUserUid && r?.createdBy === currentUserUid)
      || (!!currentUserUid && d.createdBy === currentUserUid);
  };
  // createdBy 격리 + 협력사 필터(드롭다운) 동시 적용
  const filteredDispatches = dispatches.filter(d => {
    if (!canSeeDispatch(d)) return false;
    if (partnerCode !== "전체") return routeOf(d.routeId)?.partnerCode === partnerCode;
    return true;
  });
  // 배차 폼 드롭다운: 제한 admin 은 본인 것만(전체권한/슈퍼관리자는 전체 유지 — 기존 가드 보존). select 값 해석(handleX) 은 전체 배열 유지.
  const visibleDrivers = canSeeAll ? drivers : drivers.filter(d => !!currentUserUid && d.createdBy === currentUserUid);
  const visibleVehicles = canSeeAll ? vehicles : vehicles.filter(v => !!currentUserUid && v.createdBy === currentUserUid);
  const visibleRoutes = canSeeAll ? routes : routes.filter(r => (!!currentUserUid && r.createdBy === currentUserUid) || partnerCodeAllowed(allowed, r?.partnerCode));

  return (
    <div style={S.panel}>
      <div style={S.panelHeader}>
        <span style={{ fontSize:16, fontWeight:700 }}>배차 관리</span>
        <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
          <span style={{ fontSize:11, color:"var(--color-label-alt)" }}>거래처:</span>
          <PartnerFilter companyId={companyId} value={partnerCode} onChange={setPartnerCode} allowedCodes={allowed} />
          <input type="date" value={date} onChange={e => { if (e.target.value) setDate(e.target.value); }} style={S.dateInput} />
          <button style={S.addBtn} onClick={openAdd}>+ 배차 등록</button>
          {dispatches.length > 0 && (
            <button style={{...S.editBtn, fontSize:12, padding:"6px 10px"}} onClick={handleCopyDispatches} disabled={loading}>📋 복사</button>
          )}
        </div>
      </div>
      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead><tr>{["출발시간","협력사","노선명","차량번호","기사"].map(h=><th key={h} style={S.th}>{h}</th>)}<th style={S.th}>관리</th></tr></thead>
          <tbody>
            {filteredDispatches.length === 0 ? <tr><td colSpan={6} style={{...S.td,textAlign:"center",color:"var(--color-label-alt)"}}>{dispatches.length === 0 ? "배차 내역이 없습니다" : "이 협력사에 해당하는 배차가 없습니다"}</td></tr>
            : [...filteredDispatches].sort((a,b)=>a.departTime>b.departTime?1:-1).map(d=>{
              const r = routeOf(d.routeId);
              return (
              <tr key={d.id} style={S.tr}>
                <td style={S.td}><span style={S.timeBadge}>{d.departTime}</span></td>
                <td style={{...S.td,fontSize:12}}>
                  {r?.partnerName ? (
                    <span style={{ background:"var(--color-bg-soft)", color:"var(--color-label-mute)", borderRadius:6, padding:"2px 7px", fontSize:11, fontWeight:600, whiteSpace:"nowrap" }}>{r.partnerName}</span>
                  ) : <span style={{ color:"var(--color-label-alt)" }}>–</span>}
                </td>
                <td style={{...S.td,color:"var(--color-primary)",fontWeight:600}}>{d.routeName}</td>
                <td style={S.td}>{d.vehicleNo}</td>
                <td style={S.td}>{driverName(d.driverId)}</td>
                <td style={S.td}>
                  <button style={S.editBtn} onClick={()=>openEdit(d)}>수정</button>
                  <button style={S.delBtn} onClick={()=>handleDelete(d.id)}>삭제</button>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {showForm && (
        <div style={S.overlay}><div style={S.modal}>
          <div style={S.modalTitle}>{editItem?"배차 수정":"배차 등록"}</div>
          <label style={S.label}>기사 *</label>
          <SearchableSelect value={form.driverId} onChange={handleDriverSelect}
            options={visibleDrivers.map(d => ({ value:d.id, label:`${d.name} (${d.empNo ?? d.id})` }))}
            placeholder="기사 선택 (검색)" />
          <label style={S.label}>노선 선택 *</label>
          <SearchableSelect value={form.routeId} onChange={handleRouteSelect}
            options={visibleRoutes.map(r => ({ value:r.id, label:`[${r.shift}] ${r.name} (${r.departTime})` }))}
            placeholder="노선 선택 (노선 관리에서 먼저 등록)" />
          {!form.routeId && (
            <>
              <label style={S.label}>노선명 직접 입력 (노선 미등록 시)</label>
              <input style={S.input} placeholder="예) [주간조] 대전↔삼성" value={form.routeName} onChange={e=>setForm({...form,routeName:e.target.value})} />
            </>
          )}
          <label style={S.label}>차량 선택</label>
          <SearchableSelect value={form.vehicleId} onChange={handleVehicleSelect}
            options={visibleVehicles.map(v => ({ value:v.id, label:`${v.plateNo} (${v.model || v.id})` }))}
            placeholder="차량 선택 (검색)" />
          <label style={S.label}>출발시간 *</label>
          <input style={S.input} type="time" value={form.departTime} onChange={e=>setForm({...form,departTime:e.target.value})} />
          <div style={{display:"flex",gap:8,marginTop:8}}>
            <button style={{...S.addBtn,flex:1}} onClick={handleSave} disabled={loading}>{loading?"저장 중...":"저장"}</button>
            <button style={{...S.closeBtn,flex:1}} onClick={()=>setShowForm(false)}>취소</button>
          </div>
        </div></div>
      )}
    </div>
  );
}

// 탭3: 배차 일정 (반복 패턴 정본 — Cloud Function 이 매일 새벽 dispatches 로 펼침)
// ═══════════════════════════════════════════════════════
const WEEKDAY_LABELS = ["일","월","화","수","목","금","토"];
const blankScheduleForm = () => ({
  name:"", routeId:"", routeName:"", driverId:"", driverName:"",
  vehicleId:"", vehicleNo:"", departTime:"",
  startDate: new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul'}).format(new Date()),
  endDate:"", endOpen:true,
  weekdays:[1,2,3,4,5],
  excludeDates:[], excludeInput:"",
  excludeHolidays:true, active:true,
});

function DispatchScheduleTab({ companyId, vehicles, drivers, allowed, currentUserUid }) {
  const [schedules, setSchedules] = useState([]);
  const [routes, setRoutes] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(blankScheduleForm());
  const [loading, setLoading] = useState(false);
  const [partnerCode, setPartnerCode] = useState("전체"); // 협력사 필터

  useEffect(() => {
    if (!companyId) return;
    return onSnapshot(collection(db, "companies", companyId, "dispatchSchedules"), snap => {
      setSchedules(snap.docs.map(d => ({ id:d.id, ...d.data() })));
    });
  }, [companyId]);

  useEffect(() => {
    if (!companyId) return;
    return onSnapshot(collection(db, "companies", companyId, "routes"), snap => {
      setRoutes(snap.docs.map(d => ({ id:d.id, ...d.data() })));
    });
  }, [companyId]);

  const openAdd = () => { setEditId(null); setForm(blankScheduleForm()); setShowForm(true); };
  const openEdit = (s) => {
    setEditId(s.id);
    setForm({
      name: s.name || "",
      routeId: s.routeId || "", routeName: s.routeName || "",
      driverId: s.driverId || "", driverName: s.driverName || "",
      vehicleId: s.vehicleId || "", vehicleNo: s.vehicleNo || "",
      departTime: s.departTime || "",
      startDate: s.startDate || "",
      endDate: s.endDate || "",
      endOpen: !s.endDate,
      weekdays: Array.isArray(s.weekdays) ? [...s.weekdays].sort((a,b)=>a-b) : [1,2,3,4,5],
      excludeDates: Array.isArray(s.excludeDates) ? [...s.excludeDates].sort() : [],
      excludeInput: "",
      excludeHolidays: s.excludeHolidays !== false,
      active: s.active !== false,
    });
    setShowForm(true);
  };

  const handleRouteSelect = (routeId) => {
    if (!routeId) { setForm(f => ({...f, routeId:"", routeName:"", departTime:""})); return; }
    const r = routes.find(x => x.id === routeId);
    setForm(f => ({...f, routeId, routeName:r?.name||"", departTime:f.departTime || r?.departTime || ""}));
  };
  const handleDriverSelect = (driverId) => {
    if (!driverId) { setForm(f => ({...f, driverId:"", driverName:""})); return; }
    const d = drivers.find(x => x.id === driverId);
    setForm(f => {
      const next = {...f, driverId, driverName: d?.name || ""};
      // 기사에 차량 매핑 있으면 prefill (운영자가 수정 가능)
      if (d?.vehicleId && !f.vehicleId) {
        const v = vehicles.find(x => x.id === d.vehicleId);
        next.vehicleId = d.vehicleId;
        next.vehicleNo = v?.plateNo || d.vehicleNo || "";
      }
      return next;
    });
  };
  const handleVehicleSelect = (vehicleId) => {
    if (!vehicleId) { setForm(f => ({...f, vehicleId:"", vehicleNo:""})); return; }
    const v = vehicles.find(x => x.id === vehicleId);
    setForm(f => ({...f, vehicleId, vehicleNo: v?.plateNo || ""}));
  };

  const toggleWeekday = (dow) => {
    setForm(f => {
      const has = f.weekdays.includes(dow);
      const next = has ? f.weekdays.filter(x => x !== dow) : [...f.weekdays, dow];
      return {...f, weekdays: next.sort((a,b)=>a-b)};
    });
  };
  const setWeekdaysPreset = (preset) => {
    setForm(f => ({...f, weekdays: preset.slice().sort((a,b)=>a-b)}));
  };

  const addExcludeDate = () => {
    const v = (form.excludeInput || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return alert("YYYY-MM-DD 형식으로 입력해주세요");
    if (form.excludeDates.includes(v)) { setForm(f => ({...f, excludeInput:""})); return; }
    setForm(f => ({...f, excludeDates:[...f.excludeDates, v].sort(), excludeInput:""}));
  };
  const removeExcludeDate = (v) => {
    setForm(f => ({...f, excludeDates: f.excludeDates.filter(x => x !== v)}));
  };

  // ── 일정 변경 후 남는 펼침 배차 정리 ──────────────────────────────
  // CF `expandDispatchSchedules` 는 만들기만 하고 지우지 않는다(일별 수동 수정 보존이 목적).
  // 그래서 시작일을 미래로 밀거나 요일을 줄이거나 비활성으로 바꾸면 **이미 만들어진 배차가 남아**
  // 그날 아침 단말 차량 위치가 승객앱에 뜬다(2026-08-12 신고). 변경 직후 그 잔여분을 세어
  // 운영자에게 확인받고 지운다. 🔴 과거 배차·수동 배차·운행 흔적 있는 배차는 대상에서 뺀다.
  // 일정 값이 바뀐 뒤에도 여전히 대상인 날짜의 배차를 일정에 맞춘다. 운행 흔적이 있거나
  // 그날만 손으로 고쳐 둔 배차는 대상에서 빠진다(판정은 순수 모듈).
  const syncScheduleDispatches = async (scheduleId, nextSchedule, dispatchesByDay, today) => {
    const { updatable, keptManual, keptWithTrace } = selectUpdatableDispatches({
      scheduleId, schedule: nextSchedule, dispatchesByDay, today,
    });
    if (updatable.length === 0) return;
    const FIELD_LABEL = { driverId:"기사", driverName:"기사", routeId:"노선", routeName:"노선", vehicleId:"차량", vehicleNo:"차량", departTime:"출발시각" };
    // 같은 대상의 id/이름 쌍(vehicleId+vehicleNo 등)은 한 줄로 — 운영자에겐 "차량" 하나다.
    const summarize = (changes) => {
      const seen = new Set();
      return changes.filter(c => {
        const k = FIELD_LABEL[c.field] || c.field;
        if (seen.has(k)) return false;
        if (c.field === "vehicleId" || c.field === "driverId" || c.field === "routeId") return false;
        seen.add(k); return true;
      }).map(c => `${FIELD_LABEL[c.field] || c.field} ${c.from || "–"}→${c.to || "–"}`).join(", ");
    };
    const preview = updatable.slice(0, 8).map(u => `· ${u.day} ${u.departTime} ${u.routeName} (${summarize(u.changes)})`).join("\n");
    const more = updatable.length > 8 ? `\n… 외 ${updatable.length - 8}건` : "";
    const keptNote = [
      keptManual.length > 0 ? `그날만 따로 고쳐 두신 ${keptManual.length}건` : "",
      keptWithTrace.length > 0 ? `이미 운행 기록이 있는 ${keptWithTrace.length}건` : "",
    ].filter(Boolean).join(" · ");
    if (!window.confirm(
      `이미 만들어진 앞으로의 배차 ${updatable.length}건이 바뀐 내용과 다릅니다.\n같이 바꿀까요?\n\n${preview}${more}` +
      (keptNote ? `\n\n※ ${keptNote}은 그대로 둡니다.` : "") +
      `\n\n바꾸지 않으면 그날 배차는 예전 내용 그대로 나옵니다.`
    )) return;
    let done = 0;
    for (const u of updatable) {
      try {
        await updateDoc(doc(db, "companies", companyId, "dispatches", u.day, "list", u.id), u.patch);
        done++;
      } catch (e) { /* 개별 실패는 아래 합계로 알린다 */ }
    }
    alert(done === updatable.length
      ? `배차 ${done}건을 바꿨습니다.`
      : `배차 ${done}/${updatable.length}건을 바꿨습니다. 남은 건은 배차 관리 탭에서 확인해주세요.`);
  };

  const pruneScheduleDispatches = async (scheduleId, nextSchedule) => {
    const today = todayKST();
    const days = upcomingDates(today, PRUNE_LOOKAHEAD_DAYS);
    const dispatchesByDay = {};
    for (const day of days) {
      const snap = await getDocs(query(
        collection(db, "companies", companyId, "dispatches", day, "list"),
        where("scheduleId", "==", scheduleId)
      ));
      dispatchesByDay[day] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }
    // ① 값이 어긋난 배차 맞추기(2026-08-20 개선요청 mXPK2Y19LvONbgJTMgar).
    //    CF 는 exists() 면 skip 하므로 일정을 고쳐도 **이미 펼쳐진 날짜는 옛 값**이다. 정리(②)만
    //    있고 이게 없으면 운영자가 그날 배차를 손으로 고쳐도 다음 날짜에 옛 값이 또 나온다.
    await syncScheduleDispatches(scheduleId, nextSchedule, dispatchesByDay, today);

    // ② 조건에서 빠진 날짜의 배차 정리
    const { prunable, keptWithTrace } = selectPrunableDispatches({
      scheduleId, schedule: nextSchedule, dispatchesByDay, today,
    });
    if (prunable.length === 0) {
      if (keptWithTrace.length > 0) {
        alert(`바뀐 조건과 맞지 않는 배차 ${keptWithTrace.length}건이 있지만 이미 운행 기록이 남아 있어 그대로 두었습니다.\n필요하면 배차 관리 탭에서 직접 삭제하세요.`);
      }
      return;
    }
    const preview = prunable.slice(0, 8).map(p => `· ${p.day} ${p.departTime} ${p.routeName}`).join("\n");
    const more = prunable.length > 8 ? `\n… 외 ${prunable.length - 8}건` : "";
    const traceNote = keptWithTrace.length > 0
      ? `\n\n※ 운행 기록이 남은 ${keptWithTrace.length}건은 삭제하지 않습니다.` : "";
    if (!window.confirm(
      `이 일정으로 이미 만들어진 배차 ${prunable.length}건이 바뀐 조건과 맞지 않습니다.\n함께 삭제할까요?\n\n${preview}${more}${traceNote}\n\n삭제하지 않으면 그날 관제 화면과 승객앱에 계속 운행중으로 표시됩니다.`
    )) return;
    let done = 0;
    for (const p of prunable) {
      try {
        await deleteDoc(doc(db, "companies", companyId, "dispatches", p.day, "list", p.id));
        done++;
      } catch (e) { /* 개별 실패는 아래 합계로 알린다 */ }
    }
    alert(done === prunable.length
      ? `배차 ${done}건을 삭제했습니다.`
      : `배차 ${done}/${prunable.length}건을 삭제했습니다. 남은 건은 배차 관리 탭에서 확인해주세요.`);
  };

  const handleSave = async () => {
    if (!form.name?.trim()) return alert("일정 이름을 입력해주세요");
    if (!form.routeId && !form.routeName?.trim()) return alert("노선을 선택해주세요");
    if (!form.driverId) return alert("기사를 선택해주세요");
    if (!form.departTime) return alert("출발 시각을 입력해주세요");
    if (!form.startDate) return alert("시작일을 입력해주세요");
    if (form.weekdays.length === 0) return alert("운행 요일을 1개 이상 선택해주세요");
    if (!form.endOpen && form.endDate && form.endDate < form.startDate) return alert("종료일은 시작일 이후여야 합니다");

    setLoading(true);
    const payload = {
      name: form.name.trim(),
      routeId: form.routeId,
      routeName: form.routeName,
      driverId: form.driverId,
      driverName: form.driverName,
      vehicleId: form.vehicleId,
      vehicleNo: form.vehicleNo,
      departTime: form.departTime,
      startDate: form.startDate,
      endDate: form.endOpen ? null : (form.endDate || null),
      weekdays: form.weekdays,
      excludeDates: form.excludeDates,
      excludeHolidays: !!form.excludeHolidays,
      active: !!form.active,
      updatedAt: new Date().toISOString(),
    };
    try {
      if (editId) {
        await updateDoc(doc(db, "companies", companyId, "dispatchSchedules", editId), payload);
        setShowForm(false);
        // 바뀐 조건과 안 맞는 기존 배차 정리(확인 후 삭제). 저장 자체는 이미 끝났으므로
        // 여기서 나는 오류가 저장을 되돌리지 않게 분리해 잡는다.
        try { await pruneScheduleDispatches(editId, payload); }
        catch (e) { alert("이미 만들어진 배차를 확인하지 못했습니다: " + e.message); }
      } else {
        await addDoc(collection(db, "companies", companyId, "dispatchSchedules"), {
          ...payload, createdAt: new Date().toISOString(), createdBy: currentUserUid || null,
        });
        setShowForm(false);
      }
    } catch (e) {
      alert("저장 오류: " + e.message);
    }
    setLoading(false);
  };

  const handleDelete = async (s) => {
    if (!window.confirm(`일정 "${s.name}"을(를) 삭제하시겠습니까?\n\n※ 이미 생성된 배차가 있으면 함께 삭제할지 다음 단계에서 확인합니다.`)) return;
    try {
      await deleteDoc(doc(db, "companies", companyId, "dispatchSchedules", s.id));
      try { await pruneScheduleDispatches(s.id, null); }
      catch (e) { alert("이미 만들어진 배차를 확인하지 못했습니다: " + e.message); }
    } catch (e) {
      alert("삭제 오류: " + e.message);
    }
  };

  const handleToggleActive = async (s) => {
    try {
      const next = { ...s, active: !s.active };
      await updateDoc(doc(db, "companies", companyId, "dispatchSchedules", s.id), {
        active: next.active, updatedAt: new Date().toISOString(),
      });
      // 비활성으로 바꾸면 이미 만들어진 배차가 그대로 남아 계속 운행중으로 표시된다.
      if (!next.active) {
        try { await pruneScheduleDispatches(s.id, next); }
        catch (e) { alert("이미 만들어진 배차를 확인하지 못했습니다: " + e.message); }
      }
    } catch (e) {
      alert("토글 오류: " + e.message);
    }
  };

  const handleExpandNow = async () => {
    if (!window.confirm("지금 즉시 향후 7일치 배차를 펼치시겠습니까?\n\n이미 펼쳐진 배차는 건너뜁니다.")) return;
    setLoading(true);
    try {
      const callable = httpsCallable(functions, "expandDispatchSchedulesNow");
      const res = await callable({ companyId });
      const r = res.data || {};
      alert(`펼침 완료\n· 일정 ${r.schedules || 0}건 검토\n· 신규 생성 ${r.created || 0}건\n· 이미 존재 ${r.skipped || 0}건`);
    } catch (e) {
      alert("펼침 오류: " + (e.message || e.code));
    }
    setLoading(false);
  };

  const weekdaysLabel = (arr) => {
    if (!Array.isArray(arr) || arr.length === 0) return "–";
    const sorted = [...arr].sort((a,b)=>a-b);
    if (sorted.length === 5 && sorted.every((v,i) => v === i+1)) return "평일";
    if (sorted.length === 2 && sorted[0] === 0 && sorted[1] === 6) return "주말";
    if (sorted.length === 7) return "매일";
    return sorted.map(d => WEEKDAY_LABELS[d]).join(",");
  };
  const periodLabel = (s) => `${s.startDate || "–"} ~ ${s.endDate || "무기한"}`;

  const routeOf = (id) => routes.find(r => r.id === id);
  const canSeeAll = isAllAccess(allowed);
  // createdBy 격리(2026-06-17): 배차 관리(DispatchTab)와 동일 — 노선 partnerCode∈allowed 또는 노선 createdBy===uid 또는 일정 createdBy===uid.
  const canSeeSchedule = (s) => {
    if (canSeeAll) return true;
    const r = routeOf(s.routeId);
    return partnerCodeAllowed(allowed, r?.partnerCode)
      || (!!currentUserUid && r?.createdBy === currentUserUid)
      || (!!currentUserUid && s.createdBy === currentUserUid);
  };
  const filteredSchedules = schedules.filter(s => {
    if (!canSeeSchedule(s)) return false;
    if (partnerCode !== "전체") return routeOf(s.routeId)?.partnerCode === partnerCode;
    return true;
  });
  // 폼 드롭다운: 제한 admin 은 본인 것만(전체권한/슈퍼관리자 전체 유지). 선택값 해석(handleX) 은 전체 배열 유지.
  const visibleDrivers = canSeeAll ? drivers : drivers.filter(d => !!currentUserUid && d.createdBy === currentUserUid);
  const visibleVehicles = canSeeAll ? vehicles : vehicles.filter(v => !!currentUserUid && v.createdBy === currentUserUid);
  const visibleRoutes = canSeeAll ? routes : routes.filter(r => (!!currentUserUid && r.createdBy === currentUserUid) || partnerCodeAllowed(allowed, r?.partnerCode));

  return (
    <div style={S.panel}>
      <div style={S.panelHeader}>
        <span style={{ fontSize:16, fontWeight:700 }}>배차 일정 (반복 패턴)</span>
        <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
          <span style={{ fontSize:11, color:"var(--color-label-alt)" }}>거래처:</span>
          <PartnerFilter companyId={companyId} value={partnerCode} onChange={setPartnerCode} allowedCodes={allowed} />
          <span style={{ fontSize:11, color:"var(--color-label-alt)" }}>매일 새벽 00:30 자동 펼침 · 향후 7일치</span>
          <button style={{...S.editBtn, fontSize:12, padding:"6px 10px"}} onClick={handleExpandNow} disabled={loading}>지금 펼치기</button>
          <button style={S.addBtn} onClick={openAdd}>+ 일정 등록</button>
        </div>
      </div>
      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead><tr>{["이름","협력사","노선","기사","차량","출발","요일","기간","제외","상태"].map(h=><th key={h} style={S.th}>{h}</th>)}<th style={S.th}>관리</th></tr></thead>
          <tbody>
            {filteredSchedules.length === 0 ? <tr><td colSpan={11} style={{...S.td,textAlign:"center",color:"var(--color-label-alt)"}}>{schedules.length === 0 ? "등록된 배차 일정이 없습니다 — \"+ 일정 등록\"으로 시작하세요" : "이 협력사에 해당하는 일정이 없습니다"}</td></tr>
            : [...filteredSchedules].sort((a,b)=>(a.name||"").localeCompare(b.name||"")).map(s => {
              const r = routeOf(s.routeId);
              return (
              <tr key={s.id} style={S.tr}>
                <td style={{...S.td, fontWeight:600}}>{s.name || "(이름 없음)"}</td>
                <td style={{...S.td, fontSize:12}}>
                  {r?.partnerName ? (
                    <span style={{ background:"var(--color-bg-soft)", color:"var(--color-label-mute)", borderRadius:6, padding:"2px 7px", fontSize:11, fontWeight:600, whiteSpace:"nowrap" }}>{r.partnerName}</span>
                  ) : <span style={{ color:"var(--color-label-alt)" }}>–</span>}
                </td>
                <td style={{...S.td, color:"var(--color-primary)", fontWeight:600}}>{s.routeName || "–"}</td>
                <td style={S.td}>{s.driverName || "–"}</td>
                <td style={S.td}>{s.vehicleNo || "–"}</td>
                <td style={S.td}><span style={S.timeBadge}>{s.departTime || "–"}</span></td>
                <td style={S.td}>{weekdaysLabel(s.weekdays)}</td>
                <td style={{...S.td, fontSize:11, color:"var(--color-label-mute)"}}>{periodLabel(s)}</td>
                <td style={{...S.td, fontSize:11, color:"var(--color-label-mute)"}}>
                  {s.excludeHolidays !== false ? "공휴일✓" : "공휴일✗"} · 휴무 {Array.isArray(s.excludeDates) ? s.excludeDates.length : 0}일
                </td>
                <td style={S.td}>
                  <button
                    style={{
                      ...S.editBtn,
                      background: s.active !== false ? "#E6F7EB" : "var(--color-bg-soft)",
                      borderColor: s.active !== false ? "#B7E6C7" : "var(--color-line)",
                      color: s.active !== false ? "#007A29" : "var(--color-label-mute)",
                    }}
                    onClick={()=>handleToggleActive(s)}>
                    {s.active !== false ? "활성" : "정지"}
                  </button>
                </td>
                <td style={S.td}>
                  <button style={S.editBtn} onClick={()=>openEdit(s)}>수정</button>
                  <button style={S.delBtn} onClick={()=>handleDelete(s)}>삭제</button>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {showForm && (
        <div style={S.overlay}><div style={S.modal}>
          <div style={S.modalTitle}>{editId?"배차 일정 수정":"배차 일정 등록"}</div>

          <label style={S.label}>일정 이름 *</label>
          <input style={S.input} placeholder="예) 과천라인 평일 출근" value={form.name}
                 onChange={e=>setForm({...form, name:e.target.value})} />

          <label style={S.label}>노선 *</label>
          <select style={S.input} value={form.routeId} onChange={e=>handleRouteSelect(e.target.value)}>
            <option value="">노선 선택</option>
            {visibleRoutes.map(r => <option key={r.id} value={r.id}>[{r.shift}] {r.name} ({r.departTime})</option>)}
          </select>

          <label style={S.label}>기사 *</label>
          <SearchableSelect value={form.driverId} onChange={handleDriverSelect}
            options={visibleDrivers.map(d => ({ value:d.id, label:`${d.name} (${d.empNo ?? d.id})` }))}
            placeholder="기사 선택 (검색)" />

          <label style={S.label}>차량 (선택)</label>
          <SearchableSelect value={form.vehicleId} onChange={handleVehicleSelect}
            options={visibleVehicles.map(v => ({ value:v.id, label:`${v.plateNo} (${v.model || v.id})` }))}
            placeholder="차량 선택 (검색)" />

          <label style={S.label}>출발 시각 *</label>
          <input style={S.input} type="time" value={form.departTime}
                 onChange={e=>setForm({...form, departTime:e.target.value})} />

          <div style={{display:"flex", gap:8}}>
            <div style={{flex:1}}>
              <label style={S.label}>시작일 *</label>
              <input style={S.input} type="date" value={form.startDate}
                     onChange={e=>setForm({...form, startDate:e.target.value})} />
            </div>
            <div style={{flex:1}}>
              <label style={S.label}>종료일</label>
              <input style={S.input} type="date" value={form.endDate} disabled={form.endOpen}
                     onChange={e=>setForm({...form, endDate:e.target.value})} />
              <label style={{display:"flex", alignItems:"center", gap:6, marginTop:6, fontSize:12, color:"var(--color-label-mute)"}}>
                <input type="checkbox" checked={form.endOpen}
                       onChange={e=>setForm({...form, endOpen:e.target.checked, endDate: e.target.checked ? "" : form.endDate})} />
                무기한
              </label>
            </div>
          </div>

          <label style={S.label}>운행 요일 *</label>
          <div style={{display:"flex", gap:6, flexWrap:"wrap"}}>
            {WEEKDAY_LABELS.map((label, dow) => (
              <button key={dow} type="button"
                style={{
                  ...S.editBtn,
                  padding:"6px 12px", fontSize:12,
                  background: form.weekdays.includes(dow) ? "var(--color-primary)" : "var(--color-bg-soft)",
                  color: form.weekdays.includes(dow) ? "#fff" : "var(--color-label-mute)",
                  borderColor: form.weekdays.includes(dow) ? "var(--color-primary)" : "var(--color-line)",
                  fontWeight:700,
                }}
                onClick={()=>toggleWeekday(dow)}>
                {label}
              </button>
            ))}
          </div>
          <div style={{display:"flex", gap:6, marginTop:6}}>
            <button type="button" style={{...S.editBtn, fontSize:11}} onClick={()=>setWeekdaysPreset([1,2,3,4,5])}>평일만</button>
            <button type="button" style={{...S.editBtn, fontSize:11}} onClick={()=>setWeekdaysPreset([0,6])}>주말만</button>
            <button type="button" style={{...S.editBtn, fontSize:11}} onClick={()=>setWeekdaysPreset([0,1,2,3,4,5,6])}>매일</button>
          </div>

          <label style={S.label}>휴무일 (회사별 — 운행 안 함)</label>
          <div style={{display:"flex", gap:6}}>
            <input style={{...S.input, flex:1}} type="date" value={form.excludeInput}
                   onChange={e=>setForm({...form, excludeInput:e.target.value})} />
            <button type="button" style={S.addBtn} onClick={addExcludeDate}>추가</button>
          </div>
          {form.excludeDates.length > 0 && (
            <div style={{display:"flex", flexWrap:"wrap", gap:6, marginTop:6}}>
              {form.excludeDates.map(d => (
                <span key={d} style={{
                  display:"inline-flex", alignItems:"center", gap:6,
                  background:"var(--color-bg-soft)", border:"1px solid var(--color-line)",
                  borderRadius:14, padding:"3px 10px", fontSize:11, color:"var(--color-label-mute)",
                }}>
                  {d}
                  <button type="button" onClick={()=>removeExcludeDate(d)}
                    style={{background:"none", border:"none", color:"var(--color-destructive)", cursor:"pointer", fontSize:14, lineHeight:1, padding:0}}>×</button>
                </span>
              ))}
            </div>
          )}

          <label style={{display:"flex", alignItems:"center", gap:8, marginTop:10, fontSize:13, color:"var(--color-label)"}}>
            <input type="checkbox" checked={form.excludeHolidays}
                   onChange={e=>setForm({...form, excludeHolidays:e.target.checked})} />
            한국 공휴일 자동 제외 (2026~2028 정적 — 매년 갱신 필요)
          </label>

          <label style={{display:"flex", alignItems:"center", gap:8, marginTop:4, fontSize:13, color:"var(--color-label)"}}>
            <input type="checkbox" checked={form.active}
                   onChange={e=>setForm({...form, active:e.target.checked})} />
            활성 (펼침 대상)
          </label>

          <div style={{display:"flex", gap:8, marginTop:12}}>
            <button style={{...S.addBtn, flex:1}} onClick={handleSave} disabled={loading}>{loading?"저장 중...":"저장"}</button>
            <button style={{...S.closeBtn, flex:1}} onClick={()=>setShowForm(false)} disabled={loading}>취소</button>
          </div>
          {editId && (
            <div style={{fontSize:11, color:"var(--color-label-alt)", marginTop:4, lineHeight:1.5}}>
              ※ 변경사항은 다음 새벽 펼침부터 반영. 이미 펼쳐진 미래 배차는 그대로 유지(필요시 배차 관리에서 개별 수정).
            </div>
          )}
        </div></div>
      )}
    </div>
  );
}

// 탭4: 노선 관리
// ═══════════════════════════════════════════════════════
function RoutesTab({ companyId, allowed, currentUserUid, focusPartnerCode, onFocusConsumed }) {
  const [routes, setRoutes] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [filter, setFilter] = useState("전체");
  const [search, setSearch] = useState("");
  const [form, setForm] = useState({ name:"", code:"", type:"출근", shift:"주간조", seats:"45", departTime:"", memo:"", partnerCode:"", partnerName:"", boardingMode:"", order:"", displayStart:"", displayEnd:"", sleepCheckEnabled:false });
  // 회사 기본 표시 범위(2026-08-05) — companies/{cid}.gpsWindowPreMin / gpsWindowPostMin.
  // 미설정이면 30/30(routeWindow.js 기본값과 같은 수). 노선 '표시 시간'이 있으면 그쪽이 우선.
  const [winPre, setWinPre] = useState(WINDOW_PRE_MIN_DEFAULT);
  const [winPost, setWinPost] = useState(WINDOW_POST_MIN_DEFAULT);
  const [winSaving, setWinSaving] = useState(false);
  useEffect(() => {
    if (!companyId) return;
    return onSnapshot(doc(db, "companies", companyId), snap => {
      const o = normalizeWindowOpts(snap.data());
      setWinPre(o.preMin); setWinPost(o.postMin);
    });
  }, [companyId]);
  const saveWindowDefaults = async () => {
    const clamp = (v, d) => { const n = Number(v); return isFinite(n) && n >= 0 && n <= 240 ? Math.round(n) : d; };
    setWinSaving(true);
    try {
      await updateDoc(doc(db, "companies", companyId), {
        gpsWindowPreMin: clamp(winPre, WINDOW_PRE_MIN_DEFAULT),
        gpsWindowPostMin: clamp(winPost, WINDOW_POST_MIN_DEFAULT),
      });
    } catch (e) { alert("저장 실패: " + (e?.message || e)); }
    setWinSaving(false);
  };
  const [loading, setLoading] = useState(false);
  const [reordering, setReordering] = useState(false); // 노선 순서 ▲▼ 저장 중
  const [partners, setPartners] = useState([]); // 협력사 목록
  const [partnerFilter, setPartnerFilter] = useState("전체"); // 거래처 필터
  // 대시보드 '거래처별 노선관리' 진입 시 해당 거래처로 필터 고정 후 신호 소비(1회, 2026-06-15).
  useEffect(() => {
    if (focusPartnerCode) {
      setPartnerFilter(focusPartnerCode);
      onFocusConsumed && onFocusConsumed();
    }
  }, [focusPartnerCode, onFocusConsumed]);
  // 정류장 관리
  const [stopsRoute, setStopsRoute] = useState(null); // 정류장 관리 중인 노선
  const [stops, setStops] = useState([]);
  const [showStopForm, setShowStopForm] = useState(false);
  const [editStop, setEditStop] = useState(null);
  const [stopForm, setStopForm] = useState({ name:"", address:"", lat:"", lng:"", photo:"", description:"", plannedTime:"" });
  const [stopLoading, setStopLoading] = useState(false);
  const [photoProcessing, setPhotoProcessing] = useState(false); // 사진 압축 중
  const [showMapPicker, setShowMapPicker] = useState(false);   // 지도 좌표 선택 모달
  const [pickerCenter, setPickerCenter] = useState({ lat: 37.3894, lng: 126.9522 });
  const [pickerPin, setPickerPin] = useState(null);            // 선택된 핀
  // 주소/장소 검색 (기획 갭 #14 B방식 — 카카오 Geocoder→Places 폴백). RoutesTab 지역 한정.
  const [addrQuery, setAddrQuery] = useState("");              // 검색어(주소 입력과 분리)
  const [addrResults, setAddrResults] = useState([]);          // 검색 결과 드롭다운(최대 5)
  const [addrSearching, setAddrSearching] = useState(false);   // 검색 중 표시
  const [addrMsg, setAddrMsg] = useState("");                  // 검색 불가/실패 안내
  // 노선 경로 그리기(수동 폴리라인 편집) — 정류장 관리와 같은 진입 레벨
  const [pathRoute, setPathRoute] = useState(null);            // 경로 그리는 중인 노선
  const [pathPoints, setPathPoints] = useState([]);            // routePath 정점 [{lat,lng}]
  const [pathStops, setPathStops] = useState([]);              // 해당 노선 정류장(자동연결 시드용)
  const [pathLoading, setPathLoading] = useState(false);       // 저장 중
  const [pathCenter, setPathCenter] = useState({ lat: 37.3894, lng: 126.9522 });
  const [selectedIdx, setSelectedIdx] = useState(null);        // 선택된 정점 인덱스(없으면 null)
  const [prependMode, setPrependMode] = useState(false);       // true=지도클릭 시 출발점 앞에 추가

  useEffect(() => {
    if (!companyId) return;
    return onSnapshot(collection(db, "companies", companyId, "routes"), snap => {
      setRoutes(snap.docs.map(d => ({ id:d.id, ...d.data() })));
    });
  }, [companyId]);

  // 정원 대비 등록 인원(2026-07-30) — 노선에 좌석수는 원래 있었는데 몇 명이 배정됐는지
  // 볼 화면이 없어 정원 초과를 사전에 못 잡았다. 승객 목록 1회 로드로 집계(실시간 불필요).
  const [seatPassengers, setSeatPassengers] = useState([]);
  useEffect(() => {
    if (!companyId) return;
    getDocs(collection(db, "companies", companyId, "passengers"))
      .then(snap => setSeatPassengers(snap.docs.map(d => ({ routeId: d.data().routeId, active: d.data().active }))))
      .catch(() => setSeatPassengers([]));
  }, [companyId]);
  const usage = seatUsage(routes, seatPassengers);

  // 협력사 목록 로드
  useEffect(() => {
    if (!companyId) return;
    return onSnapshot(
      query(collection(db, "partnerCodes"), where("companyId", "==", companyId), where("active", "==", true)),
      snap => setPartners(snap.docs.map(d => ({ id:d.id, ...d.data() })))
    );
  }, [companyId]);

  // 선택된 노선의 정류장 실시간 구독
  useEffect(() => {
    if (!stopsRoute || !companyId) return;
    return onSnapshot(
      query(collection(db, "companies", companyId, "routes", stopsRoute.id, "stops"), orderBy("order", "asc")),
      snap => setStops(snap.docs.map(d => ({ id:d.id, ...d.data() })))
    );
  }, [stopsRoute, companyId]);

  const openAdd = () => { setEditItem(null); setForm({ name:"", code:"", type:"출근", shift:"주간조", seats:"45", departTime:"", memo:"", partnerCode:"", partnerName:"", boardingMode:"", order:"", displayStart:"", displayEnd:"", sleepCheckEnabled:false }); setShowForm(true); };
  const openEdit = (item) => {
    setEditItem(item);
    setForm({ name:item.name||"", code:item.code||"", type:item.type||"출근", shift:item.shift||"주간조", seats:item.seats?.toString()||"", departTime:item.departTime||"", memo:item.memo||"", partnerCode:item.partnerCode||"", partnerName:item.partnerName||"", boardingMode:item.boardingMode||"", order: typeof item.order === "number" ? String(item.order) : "", displayStart:item.displayStart||"", displayEnd:item.displayEnd||"", sleepCheckEnabled: !!item.sleepCheckEnabled });
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.name || !form.departTime) return alert("노선명과 출발시간은 필수입니다");
    setLoading(true);
    // boardingMode: ""(미설정=협력사 정책 fallback) | "driver-qr"(노선 강제 기사발행) | "passenger-qr"(노선 강제 직원발행).
    // 2026-05-27 — 혼승 노선 대응을 위한 노선 단위 override.
    // order: 승객·직원앱 노선 목록 표시 순서(작을수록 위). 빈값=null(미설정 → 목록 맨 뒤).
    const rawOrder = (form.order ?? "").toString().trim();
    const orderVal = rawOrder === "" ? null : parseInt(rawOrder, 10);
    if (rawOrder !== "" && !Number.isFinite(orderVal)) { setLoading(false); return alert("표시 순서는 숫자로 입력해주세요"); }
    // 표시 시간(2026-08-05) — 둘 다 넣어야 명시 창으로 인정. 한쪽만 넣으면 판정이 애매해지므로 거부.
    const ds = (form.displayStart || "").trim(), de = (form.displayEnd || "").trim();
    if ((ds && !de) || (!ds && de)) { setLoading(false); return alert("표시 시간은 시작·종료를 모두 입력하거나 둘 다 비워주세요"); }
    const data = { name:form.name.trim(), code:form.code.trim(), type:form.type, shift:form.shift, seats:form.seats?parseInt(form.seats):null, departTime:form.departTime, memo:form.memo.trim(), partnerCode:form.partnerCode, partnerName:form.partnerName, boardingMode:form.boardingMode||"", order:orderVal, displayStart:ds||null, displayEnd:de||null, sleepCheckEnabled: !!form.sleepCheckEnabled, updatedAt:new Date().toISOString() };
    try {
      if (editItem) {
        await updateDoc(doc(db, "companies", companyId, "routes", editItem.id), data);
      } else {
        data.createdAt = new Date().toISOString();
        data.createdBy = currentUserUid || null; // 제한 admin 이 거래처 미지정 노선 등록해도 본인은 항상 열람(2026-06-16).
        await addDoc(collection(db, "companies", companyId, "routes"), data);
      }
      setShowForm(false);
      // 저장한 노선이 활성 필터(거래처/구분/검색)에 가려 "안 보인다" 혼란 방지 — 필터 초기화(2026-06-15).
      setFilter("전체"); setPartnerFilter("전체"); setSearch("");
    } catch (e) { alert("저장 오류: " + e.message); }
    setLoading(false);
  };

  const handleDelete = async (item) => {
    if (!window.confirm(`"${item.name}" 노선을 삭제하시겠습니까?`)) return;
    await deleteDoc(doc(db, "companies", companyId, "routes", item.id));
  };

  // 노선 복사 — 노선 문서 + 정류장 전체를 새 노선으로 복제(정류장 재입력 수고 경감, 2026-06-16).
  // 순수 클라이언트(Firestore SDK 직접 write). companies/** write = 해당 회사 admin 룰로 허용됨.
  const handleCopy = async (item) => {
    if (!window.confirm(`"${item.name}" 노선을 정류장 정보까지 복사하시겠습니까?`)) return;
    setLoading(true);
    try {
      // ① 노선 문서 복제 — item.id 등 문서 메타 제외, 명시 필드만 나열.
      const data = {
        name: `${item.name} (복사본)`,
        code: item.code || "",
        type: item.type || "출근",
        shift: item.shift || "주간조",
        seats: item.seats ?? null,
        departTime: item.departTime || "",
        memo: item.memo || "",
        order: null, // 복사본은 목록 맨 뒤로 — 원본 order 를 그대로 물려받으면 값이 중복돼 ▲▼ 순서변경(값 교환)이 무효화됨(2026-07-21). 맨 뒤에서 원하는 위치로 이동.
        partnerCode: item.partnerCode || "",
        partnerName: item.partnerName || "",
        boardingMode: item.boardingMode || "",
        displayStart: item.displayStart || null, // 표시 시간은 계획 정보 → 복사본도 물려받는다(2026-08-05)
        displayEnd: item.displayEnd || null,
        routePath: Array.isArray(item.routePath) ? item.routePath : [], // 수동 경로 폴리라인 보존(plain number 배열)
        createdBy: currentUserUid || null, // 복사본도 본인 소유로(제한 admin 열람 보장)
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const newRef = await addDoc(collection(db, "companies", companyId, "routes"), data);
      // ② 정류장 전체 복제 — order 보존, id 제외. 직렬 await 루프.
      const stopsSnap = await getDocs(query(collection(db, "companies", companyId, "routes", item.id, "stops"), orderBy("order", "asc")));
      let copied = 0;
      for (const s of stopsSnap.docs) {
        const sd = s.data();
        await addDoc(collection(db, "companies", companyId, "routes", newRef.id, "stops"), {
          name: sd.name,
          address: sd.address,
          lat: sd.lat,
          lng: sd.lng,
          order: sd.order,
          photo: sd.photo || "",
          description: sd.description || "",
          offsetMin: sd.offsetMin ?? null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        copied++;
      }
      // 새 노선이 활성 필터(거래처/구분/검색)에 가려 "안 보인다" 혼란 방지 — 필터 초기화(handleSave 패턴).
      setFilter("전체"); setPartnerFilter("전체"); setSearch("");
      alert(`"${item.name}" 노선이 정류장 ${copied}개와 함께 복사되었습니다.`);
    } catch (e) { alert("복사 오류: " + e.message); }
    setLoading(false);
  };

  // ─── 정류장 CRUD ────────────────────────────────────
  const resetAddrSearch = () => { setAddrQuery(""); setAddrResults([]); setAddrSearching(false); setAddrMsg(""); };
  const openStopAdd = () => {
    setEditStop(null);
    // 첫 정류장(stops 비어있음)이면 plannedTime을 노선 출발시각으로 prefill — 0분.
    const initialPlanned = (stops.length === 0 && stopsRoute?.departTime) ? stopsRoute.departTime : "";
    setStopForm({ name:"", address:"", lat:"", lng:"", photo:"", description:"", plannedTime: initialPlanned });
    setPickerPin(null);
    resetAddrSearch();
    // 기존 정류장이 있으면 첫 번째 정류장 위치로 중심 설정
    if (stops.length > 0) setPickerCenter({ lat: stops[0].lat, lng: stops[0].lng });
    setShowStopForm(true);
  };
  const openStopEdit = (s) => {
    setEditStop(s);
    setStopForm({ name:s.name||"", address:s.address||"", lat:s.lat?.toString()||"", lng:s.lng?.toString()||"", photo:s.photo||"", description:s.description||"", plannedTime: (typeof s.offsetMin === "number") ? (planTimeForStop(stopsRoute?.departTime, s.offsetMin) || "") : "" });
    resetAddrSearch();
    if (s.lat && s.lng) {
      setPickerCenter({ lat: s.lat, lng: s.lng });
      setPickerPin({ lat: s.lat, lng: s.lng });
    }
    setShowStopForm(true);
  };

  // ─── 주소/장소 검색 (카카오 services) ──────────────────
  // Geocoder.addressSearch(주소) 우선 → 결과 없으면 Places.keywordSearch(지명/상호) 폴백.
  // callcenter geocodeAddress 패턴 참고하되 buslink 독립 구현(다중 결과 드롭다운).
  // ⚠ 카카오 키는 현재 callcenter와 임시 공유 — Geocoder/Places 일일 한도 공유(issues.md).
  const handleAddrSearch = () => {
    const q = addrQuery.trim();
    if (!q) { setAddrMsg("검색어를 입력하세요"); setAddrResults([]); return; }
    // SDK/services 미로드 가드 — 폼은 죽지 않고 수동 경로 그대로 동작
    const svc = window.kakao?.maps?.services;
    if (!svc || !svc.Geocoder || !svc.Places || !svc.Status) {
      setAddrResults([]);
      setAddrMsg("주소 검색 불가 — 지도에서 위치 선택 또는 좌표 직접 입력을 이용하세요");
      return;
    }
    setAddrSearching(true);
    setAddrMsg("");
    setAddrResults([]);
    // 워치독: 카카오 services 콜백이 끝내 안 오는 경우(도메인 미등록·한도초과·네트워크)
    // "검색 중"에서 영구 정지하지 않도록 8초 후 수동 경로 안내로 강제 종료.
    let settled = false;
    const watchdog = setTimeout(() => {
      if (settled) return;
      settled = true;
      setAddrSearching(false);
      setAddrResults([]);
      setAddrMsg("주소 검색이 응답하지 않습니다 — 지도에서 위치 선택 또는 좌표 직접 입력을 이용하세요");
    }, 8000);
    const finish = (list, msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      setAddrSearching(false);
      setAddrResults(list);
      setAddrMsg(msg || (list.length ? "" : "검색 결과가 없습니다 — 지도에서 위치 선택 또는 좌표 직접 입력"));
    };
    try {
      new svc.Geocoder().addressSearch(q, (result, status) => {
        if (status === svc.Status.OK && result && result.length) {
          finish(result.slice(0, 5).map(r => ({
            name: r.address_name,
            address: r.road_address?.address_name || r.address_name,
            lat: parseFloat(r.y), lng: parseFloat(r.x),
          })));
          return;
        }
        // 주소가 아니면 지명/상호로 재검색
        new svc.Places().keywordSearch(q, (pres, pstatus) => {
          if (pstatus === svc.Status.OK && pres && pres.length) {
            finish(pres.slice(0, 5).map(p => ({
              name: p.place_name,
              address: p.road_address_name || p.address_name || "",
              lat: parseFloat(p.y), lng: parseFloat(p.x),
            })));
          } else if (pstatus === svc.Status.ZERO_RESULT && status === svc.Status.ZERO_RESULT) {
            finish([], "검색 결과가 없습니다 — 지도에서 위치 선택 또는 좌표 직접 입력");
          } else {
            // ERROR(한도초과 등) — 우아한 실패, 수동 경로 안내
            finish([], "주소 검색 불가 — 지도에서 위치 선택 또는 좌표 직접 입력을 이용하세요");
          }
        });
      });
    } catch (e) {
      finish([], "주소 검색 불가 — 지도에서 위치 선택 또는 좌표 직접 입력을 이용하세요");
    }
  };

  // 검색 결과 선택 → 주소/좌표 채움 + picker 동기(기존 좌표입력·picker 동작과 일관)
  const pickAddrResult = (r) => {
    const latS = r.lat.toFixed(6), lngS = r.lng.toFixed(6);
    setStopForm(f => ({
      ...f,
      address: r.address || r.name || f.address,
      lat: latS, lng: lngS,
      // name이 비어있을 때만 결과명 프리필(채워져 있으면 덮어쓰지 않음)
      name: f.name?.trim() ? f.name : (r.name || f.name),
    }));
    setPickerPin({ lat: r.lat, lng: r.lng });
    setPickerCenter({ lat: r.lat, lng: r.lng });
    setShowMapPicker(true);   // 검색 결과 → 지도 바로 열어 핀 드래그로 미세조정
    setAddrResults([]);
    setAddrMsg("");
  };

  // 정류장 사진 첨부 — 클라에서 리사이즈·압축 후 data URI를 폼에 보관(Firestore 직저장).
  const handleStopPhoto = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";              // 같은 파일 재선택 허용
    if (!file) return;
    setPhotoProcessing(true);
    try {
      const { dataUri } = await compressImageFile(file);
      setStopForm(f => ({ ...f, photo: dataUri }));
    } catch (err) {
      alert(err.message || "사진 처리에 실패했습니다");
    }
    setPhotoProcessing(false);
  };

  // 정류장 폼 열림 동안 클립보드 이미지 붙여넣기(Ctrl+V) 지원 — 이미지 클립보드일 때만 가로챔(텍스트 붙여넣기 무영향)
  useEffect(() => {
    if (!showStopForm) return;
    const onPaste = async (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      let file = null;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf("image") === 0) { file = items[i].getAsFile(); break; }
      }
      if (!file) return;
      e.preventDefault();
      setPhotoProcessing(true);
      try {
        const { dataUri } = await compressImageFile(file);
        setStopForm(f => ({ ...f, photo: dataUri }));
      } catch (err) {
        alert(err.message || "사진 처리에 실패했습니다");
      }
      setPhotoProcessing(false);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [showStopForm]);

  const handleStopSave = async () => {
    if (!stopForm.name || !stopForm.lat || !stopForm.lng) return alert("정류장명, 위도, 경도는 필수입니다");
    const lat = parseFloat(stopForm.lat), lng = parseFloat(stopForm.lng);
    if (isNaN(lat) || isNaN(lng)) return alert("위도/경도는 숫자로 입력해주세요");
    setStopLoading(true);
    // plannedTime("HH:MM") → 노선 departTime 기준 offsetMin(분, ≥0) 변환 저장.
    // 빈값=null(미설정, 폴백). 노선 departTime 없거나 형식 오류·노선 출발보다 빠르면 거부.
    const rawTime = (stopForm.plannedTime ?? "").toString().trim();
    let offsetMin = null;
    if (rawTime !== "") {
      if (!stopsRoute?.departTime) { setStopLoading(false); return alert("노선 출발시각이 먼저 설정되어야 정류장 진입시각을 계산할 수 있습니다"); }
      const off = offsetMinFromPlanTime(stopsRoute.departTime, rawTime);
      if (off == null) {
        setStopLoading(false);
        return alert(`정류장 진입시각은 노선 출발시각(${stopsRoute.departTime}) 이후여야 합니다.\n\n첫 정류장이라면 노선 출발시각과 같은 시각(${stopsRoute.departTime})을 입력하세요. 노선 출발시각 자체를 바꾸려면 노선 관리에서 수정해 주세요(모든 정류장 절대시각이 자동 따라옵니다).`);
      }
      offsetMin = off;
    }
    const data = { name:stopForm.name.trim(), address:stopForm.address.trim(), lat, lng, photo:stopForm.photo||"", description:(stopForm.description||"").trim(), offsetMin, updatedAt:new Date().toISOString() };
    const col = collection(db, "companies", companyId, "routes", stopsRoute.id, "stops");
    try {
      if (editStop) {
        await updateDoc(doc(db, "companies", companyId, "routes", stopsRoute.id, "stops", editStop.id), data);
      } else {
        data.order = stops.length + 1;
        data.createdAt = new Date().toISOString();
        await addDoc(col, data);
      }
      setShowStopForm(false);
    } catch (e) { alert("저장 오류: " + e.message); }
    setStopLoading(false);
  };

  const handleStopDelete = async (s) => {
    if (!window.confirm(`"${s.name}" 정류장을 삭제하시겠습니까?`)) return;
    await deleteDoc(doc(db, "companies", companyId, "routes", stopsRoute.id, "stops", s.id));
  };

  const moveStop = async (idx, dir) => {
    const newStops = [...stops];
    const target = idx + dir;
    if (target < 0 || target >= newStops.length) return;
    // swap order values
    await updateDoc(doc(db, "companies", companyId, "routes", stopsRoute.id, "stops", newStops[idx].id), { order: newStops[target].order });
    await updateDoc(doc(db, "companies", companyId, "routes", stopsRoute.id, "stops", newStops[target].id), { order: newStops[idx].order });
  };

  // ── 정류장 진입시각 인라인 저장(2026-06-09) — 목록 행에서 HH:MM 직접 입력 → offsetMin 만
  //    갱신(폼 왕복 없이 전체 정류장을 보며 위→아래로 입력). 빈값=진입시각 해제. 노선
  //    departTime 기준 변환·출발시각 이전이면 거부(saveStop 검증과 동일 규칙). 사진/설명/
  //    좌표 등 다른 필드는 건드리지 않음(부분 update). 저장은 onSnapshot 으로 목록 자동 갱신.
  const saveStopTime = async (s, hhmm) => {
    if (!stopsRoute?.id) return;
    try {
      if (!hhmm) {
        await updateDoc(doc(db, "companies", companyId, "routes", stopsRoute.id, "stops", s.id), { offsetMin: null, updatedAt: new Date().toISOString() });
        return;
      }
      if (!stopsRoute?.departTime) return alert("노선 출발시각이 먼저 설정되어야 진입시각을 계산할 수 있습니다(노선 관리에서 출발시각 입력).");
      const off = offsetMinFromPlanTime(stopsRoute.departTime, hhmm);
      if (off == null) return alert(`진입시각은 노선 출발시각(${stopsRoute.departTime}) 이후여야 합니다.\n첫 정류장은 출발시각(${stopsRoute.departTime})과 동일하게 입력하세요.`);
      await updateDoc(doc(db, "companies", companyId, "routes", stopsRoute.id, "stops", s.id), { offsetMin: off, updatedAt: new Date().toISOString() });
    } catch (e) { alert("진입시각 저장 실패: " + (e?.message || e)); }
  };

  // ─── 노선 경로 그리기 (수동 폴리라인) ────────────────────
  // 정류장 관리와 같은 진입 레벨. 카카오 <Map> 위에서 수동 편집:
  //   지도 클릭=정점 추가 / 마커 드래그=이동 / 마커 클릭=삭제 /
  //   되돌리기 / 전체 지우기 / 정류장 순서대로 자동 연결(stops 좌표 시드).
  // ⚠ 자동 도로 라우팅(Kakao Mobility) 미사용 — 순수 수동 드로잉(키 한도 공유 이슈).
  const openPathDraw = async (route) => {
    setPathRoute(route);
    // 기존 routePath 로드(plain number 배열, GeoPoint 아님)
    const init = Array.isArray(route.routePath)
      ? route.routePath.filter(p => typeof p?.lat === "number" && typeof p?.lng === "number")
      : [];
    setPathPoints(init);
    // 해당 노선 정류장 로드 — 자동 연결 시드 + 지도 참고 마커 + 초기 중심
    let sList = [];
    try {
      const snap = await getDocs(query(
        collection(db, "companies", companyId, "routes", route.id, "stops"),
        orderBy("order", "asc")
      ));
      sList = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
      console.warn("[BusLink] 경로용 정류장 로드 실패:", e.message);
    }
    setPathStops(sList);
    const seed = init[0] || (sList[0] && { lat: sList[0].lat, lng: sList[0].lng });
    if (seed) setPathCenter({ lat: seed.lat, lng: seed.lng });
  };
  const closePathDraw = () => { setPathRoute(null); setPathPoints([]); setPathStops([]); setSelectedIdx(null); setPrependMode(false); };
  const pathAddPoint = (lat, lng) => setPathPoints(p => [...p, { lat, lng }]);
  const pathMovePoint = (idx, lat, lng) =>
    setPathPoints(p => p.map((pt, i) => i === idx ? { lat, lng } : pt));
  const pathDeletePoint = (idx) => setPathPoints(p => p.filter((_, i) => i !== idx));
  const pathUndo = () => setPathPoints(p => p.slice(0, -1));
  const pathClear = () => { setPathPoints([]); setSelectedIdx(null); setPrependMode(false); };
  // 신규: idx 위치에 삽입(0=맨앞, length=끝), 선택 기반 삭제, 출발점 앞 추가
  const pathInsertPoint = (idx, lat, lng) =>
    setPathPoints(p => [...p.slice(0, idx), { lat, lng }, ...p.slice(idx)]);
  const pathPrependPoint = (lat, lng) => pathInsertPoint(0, lat, lng);
  const pathDeleteSelected = () => {
    if (selectedIdx == null) return;
    pathDeletePoint(selectedIdx);
    setSelectedIdx(null);
  };
  // 정류장 순서대로 자동 연결 — stops 좌표를 초기 시드(이후 수동 보정 전제)
  const pathSeedFromStops = () => {
    const seed = pathStops
      .filter(s => typeof s.lat === "number" && typeof s.lng === "number")
      .map(s => ({ lat: s.lat, lng: s.lng }));
    if (seed.length === 0) { alert("좌표가 있는 정류장이 없습니다"); return; }
    if (pathPoints.length > 0 &&
        !window.confirm("현재 경로를 정류장 순서 연결로 대체하시겠습니까?")) return;
    setPathPoints(seed);
  };
  const handlePathSave = async () => {
    if (!pathRoute) return;
    setPathLoading(true);
    try {
      // stops와 동일하게 plain number 배열로 저장(GeoPoint 아님). 빈 배열=미설정 취급.
      const routePath = pathPoints.map(p => ({
        lat: parseFloat(p.lat.toFixed(6)), lng: parseFloat(p.lng.toFixed(6)),
      }));
      await updateDoc(doc(db, "companies", companyId, "routes", pathRoute.id), {
        routePath, updatedAt: new Date().toISOString(),
      });
      closePathDraw();
    } catch (e) { alert("경로 저장 오류: " + e.message); }
    setPathLoading(false);
  };

  // Phase B: 제한 admin 은 allowed 협력사 노선만(전체 선택 시에도). isAllAccess 면 기존대로.
  const filtered = routes.filter(r => {
    if (filter !== "전체" && r.type !== filter) return false;
    if (partnerFilter !== "전체") {
      if (r.partnerCode !== partnerFilter) return false;
    } else if (!isAllAccess(allowed) && !partnerCodeAllowed(allowed, r.partnerCode)
               && !(currentUserUid && r.createdBy === currentUserUid)) {
      // 제한 admin: allowed 협력사 노선 OR 본인 생성(createdBy) 노선만(거래처 미지정 자기 노선도 노출, 2026-06-16).
      return false;
    }
    if (search && !r.name.includes(search) && !r.code?.includes(search)) return false;
    return true;
  }).sort(compareRoutes); // 표시 순서(order) — 승객·직원앱 노선 목록과 동일 규칙(2026-07-10)

  // ── 노선 표시 순서 ▲▼ (2026-07-10) — 정류장 moveStop 과 같은 패턴(인접 두 행의 order 값 교환).
  //   레거시 노선은 order 가 없으므로, 첫 이동 시 현재 정렬 순서대로 회사 전체 노선에 0..n-1 을
  //   한 번 백필한 뒤 교환한다(백필 없이 교환하면 둘 다 undefined 라 순서가 안 바뀜).
  //   필터/검색으로 일부만 보이는 상태에서도 "보이는 두 행"의 값만 맞바꾸므로 그 부분순서는 정확.
  const moveRoute = async (idx, dir) => {
    const target = idx + dir;
    if (target < 0 || target >= filtered.length || reordering) return;
    setReordering(true);
    try {
      let list = filtered;
      // 백필/정규화 — 회사 전체 노선에 0..n-1 order 부여.
      //   트리거: ① order 미설정(레거시) 노선이 있거나 ② order 값이 중복일 때.
      //   중복(노선 복사 시 원본 order 를 그대로 물려받아 같은 값 두 개)이면 아래 값 교환이
      //   "같은 값끼리 맞바꿈"이라 무효 → 복사 후 순서 변경이 안 되던 원인(2026-07-21).
      //   정규화하면 현재 표시 순서 그대로 distinct 값이 부여돼 교환이 정상 동작한다.
      const numericOrders = routes.map(r => r.order).filter(o => typeof o === "number");
      const needsSeed = routes.some(r => typeof r.order !== "number")
        || new Set(numericOrders).size !== numericOrders.length;
      if (needsSeed) {
        const seeded = [...routes].sort(compareRoutes);
        await Promise.all(seeded.map((r, i) =>
          typeof r.order === "number" && r.order === i
            ? Promise.resolve()
            : updateDoc(doc(db, "companies", companyId, "routes", r.id), { order: i })
        ));
        // 🔴 `new Map()` 금지 — 이 파일은 상단에서 카카오 SDK 의 `Map` 을 import 해
        //    내장 Map 이 가려진다(같은 파일 3781·5119행에 경고가 이미 있는데 이 줄만 남아 있었다).
        //    던지면 아래 swap 이 실행되지 않아 **첫 ▲▼ 가 먹지 않는다**(2026-08-10 발견).
        const orderById = new window.Map(seeded.map((r, i) => [r.id, i]));
        list = filtered.map(r => ({ ...r, order: orderById.get(r.id) }));
      }
      const a = list[idx], b = list[target];
      await Promise.all([
        updateDoc(doc(db, "companies", companyId, "routes", a.id), { order: b.order }),
        updateDoc(doc(db, "companies", companyId, "routes", b.id), { order: a.order }),
      ]);
    } catch (e) { alert("순서 변경 오류: " + e.message); }
    setReordering(false);
  };

  // 거래처 드롭다운 옵션도 제한(allowed 협력사만).
  const visiblePartners = isAllAccess(allowed)
    ? partners
    : partners.filter(p => allowed.includes(p.code));

  const shifts = ["주간조","야간조","오전조","오후조","등교","하교"];

  return (
    <div style={{ ...S.panel, position:"relative" }}>
      <div style={S.panelHeader}>
        <span style={{ fontSize:16, fontWeight:700 }}>📍 노선 관리</span>
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          <span style={{ fontSize:12, color:"var(--color-label-mute)" }}>총 {routes.length}개</span>
          <button style={S.addBtn} onClick={openAdd}>+ 노선 추가</button>
        </div>
      </div>

      {/* 기본 표시 범위(2026-08-05 회의 #2) — 노선에 '표시 시간'을 직접 넣지 않은 노선에
          적용되는 회사 기본값. 승객·직원앱에서 이 범위 밖 차량은 안 보인다(관제는 항상 보임). */}
      <div style={{ padding:"10px 16px", display:"flex", flexWrap:"wrap", gap:8, alignItems:"center", borderBottom:"1px solid var(--color-line)", background:"var(--color-bg-soft)" }}>
        <span style={{ fontSize:12, fontWeight:700, color:"var(--color-label)" }}>🕒 기본 표시 범위</span>
        <span style={{ fontSize:12, color:"var(--color-label-mute)" }}>출발</span>
        <input type="number" min="0" max="240" value={winPre} onChange={e=>setWinPre(e.target.value)}
          style={{ ...S.input, width:66, padding:"5px 8px", margin:0, fontSize:12 }} />
        <span style={{ fontSize:12, color:"var(--color-label-mute)" }}>분 전 ~ 도착</span>
        <input type="number" min="0" max="240" value={winPost} onChange={e=>setWinPost(e.target.value)}
          style={{ ...S.input, width:66, padding:"5px 8px", margin:0, fontSize:12 }} />
        <span style={{ fontSize:12, color:"var(--color-label-mute)" }}>분 후</span>
        <button style={{ ...S.editBtn, marginRight:0, fontSize:11 }} disabled={winSaving} onClick={saveWindowDefaults}>
          {winSaving ? "저장 중…" : "저장"}
        </button>
        <span style={{ fontSize:11, color:"var(--color-label-mute)", flexBasis:"100%", lineHeight:1.5 }}>
          승객·직원앱에 차량이 보이는 시간대입니다. 노선별로 다르게 하려면 노선 수정의 <b>표시 시간</b>에 직접 넣으세요.
          관리자 실시간 관제에는 시간과 무관하게 항상 보입니다.
        </span>
      </div>

      <div style={{ padding:"10px 16px", display:"flex", flexWrap:"wrap", gap:6, alignItems:"center", borderBottom:"1px solid var(--color-line)" }}>
        {/* 출근/퇴근 필터 */}
        {["전체","출근","퇴근"].map(f=>(
          <button key={f} onClick={()=>setFilter(f)}
            style={{ ...S.editBtn, background:filter===f?"var(--color-primary-soft)":"var(--color-bg-soft)", color:filter===f?"var(--color-primary-deep)":"var(--color-label-mute)", border:filter===f?"1px solid var(--color-primary)":"1px solid var(--color-line)" }}>
            {f}
          </button>
        ))}
        {/* 거래처 필터 */}
        <span style={{ fontSize:11, color:"var(--color-label-alt)", marginLeft:4 }}>거래처:</span>
        <select value={partnerFilter} onChange={e=>setPartnerFilter(e.target.value)}
          style={{ ...S.input, padding:"5px 10px", fontSize:12, width:"auto", minWidth:100, maxWidth:160 }}>
          <option value="전체">{isAllAccess(allowed) ? "전체" : "내 협력사 전체"}</option>
          {visiblePartners.map(p => <option key={p.code} value={p.code}>{p.partnerName}</option>)}
        </select>
        <input style={{ ...S.dateInput, marginLeft:"auto" }} placeholder="노선명·코드 검색"
          value={search} onChange={e=>setSearch(e.target.value)} />
      </div>

      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>{["순서","구분","거래처","근무조","코드","노선명","좌석수","출발시간","정류장"].map(h=><th key={h} style={S.th}>{h}</th>)}<th style={S.th}>관리</th></tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={10} style={{...S.td,textAlign:"center",color:"var(--color-label-alt)"}}>
                {routes.length===0?"등록된 노선이 없습니다":"검색 결과가 없습니다"}
              </td></tr>
            ) : filtered.map((r,i)=>(
              <tr key={r.id} style={S.tr}>
                {/* 표시 순서 — 승객·직원앱 노선 목록에 이 순서 그대로 반영(2026-07-10) */}
                <td style={S.td}>
                  <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                    <div style={{ display:"flex", flexDirection:"column", gap:2 }}>
                      <button title="위로" disabled={i===0||reordering} onClick={()=>moveRoute(i,-1)}
                        style={{...S.editBtn, padding:"1px 5px", lineHeight:1.2, opacity:(i===0||reordering)?0.35:1, cursor:(i===0||reordering)?"default":"pointer"}}>▲</button>
                      <button title="아래로" disabled={i===filtered.length-1||reordering} onClick={()=>moveRoute(i,1)}
                        style={{...S.editBtn, padding:"1px 5px", lineHeight:1.2, opacity:(i===filtered.length-1||reordering)?0.35:1, cursor:(i===filtered.length-1||reordering)?"default":"pointer"}}>▼</button>
                    </div>
                    <span style={{ fontSize:12, fontWeight:700, color:"var(--color-label-mute)", fontFamily:"var(--font-mono)" }}>{i+1}</span>
                  </div>
                </td>
                <td style={S.td}><span style={{...S.statusBadge, background:r.type==="출근"?"var(--color-primary-soft)":"#FFF1E0", color:r.type==="출근"?"var(--color-primary-deep)":"#B95300"}}>{r.type}</span></td>
                <td style={{...S.td,fontSize:12}}><span style={{ background:"var(--color-bg-soft)", color:"var(--color-label-mute)", borderRadius:6, padding:"2px 7px", fontSize:11, fontWeight:600, whiteSpace:"nowrap" }}>{r.partnerName||"–"}</span></td>
                <td style={{...S.td,color:"var(--color-label-mute)",fontSize:12}}>{r.shift||"–"}</td>
                <td style={{...S.td,color:"var(--color-label-mute)",fontSize:12,fontFamily:"monospace"}}>{r.code||"–"}</td>
                <td style={{...S.td,fontWeight:600,maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.name}</td>
                {/* 정원 대비 등록 인원(2026-07-30) — 초과면 붉게. 정원 미설정 노선은 인원만. */}
                <td style={S.td}>
                  {(() => {
                    const u = usage[r.id];
                    if (!u) return r.seats ? `${r.seats}석` : "–";
                    if (!u.seats) return <span style={{ color:"var(--color-label-mute)" }}>{u.registered}명 · 정원 미설정</span>;
                    return (
                      <span style={{ fontWeight: 700, color: u.over ? "var(--color-destructive)" : u.ratio >= 0.9 ? "var(--color-cautionary)" : "var(--color-label)" }}>
                        {u.registered} / {u.seats}석{u.over ? " 초과" : ""}
                      </span>
                    );
                  })()}
                </td>
                <td style={S.td}><span style={S.timeBadge}>{r.departTime}</span></td>
                <td style={S.td}>
                  <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                    <button onClick={()=>setStopsRoute(r)}
                      style={{...S.editBtn, background:stopsRoute?.id===r.id?"var(--color-primary-soft)":"var(--color-bg-soft)", color:stopsRoute?.id===r.id?"var(--color-primary-deep)":"var(--color-label-mute)", border:stopsRoute?.id===r.id?"1px solid var(--color-primary)":"1px solid var(--color-line)"}}>
                      정류장 관리
                    </button>
                    <button onClick={()=>openPathDraw(r)}
                      style={{...S.editBtn, background:pathRoute?.id===r.id?"var(--color-primary-soft)":"var(--color-bg-soft)", color:pathRoute?.id===r.id?"var(--color-primary-deep)":"var(--color-label-mute)", border:pathRoute?.id===r.id?"1px solid var(--color-primary)":"1px solid var(--color-line)"}}>
                      🛣 경로 그리기{Array.isArray(r.routePath)&&r.routePath.length>=2?` (${r.routePath.length})`:""}
                    </button>
                  </div>
                </td>
                <td style={S.td}>
                  <button style={S.editBtn} onClick={()=>openEdit(r)}>수정</button>
                  <button style={{...S.editBtn, color:"var(--color-primary-deep)"}} onClick={()=>handleCopy(r)}>📋 복사</button>
                  <button style={S.delBtn} onClick={()=>handleDelete(r)}>삭제</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ─── 정류장 관리 패널 ─── */}
      {stopsRoute && (
        <div style={{ position:"absolute", top:0, right:0, width:"min(380px,100%)", height:"100%", background:"var(--color-bg)", borderLeft:"1px solid var(--color-line)", display:"flex", flexDirection:"column", zIndex:20 }}>
          <div style={{ padding:"14px 16px", borderBottom:"1px solid var(--color-line)", display:"flex", alignItems:"center", justifyContent:"space-between", background:"var(--color-bg-alt)", flexShrink:0 }}>
            <div>
              <div style={{ fontWeight:700, fontSize:14, color:"var(--color-primary)" }}>📍 정류장 관리</div>
              <div style={{ fontSize:11, color:"var(--color-label-mute)", marginTop:2, maxWidth:280, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{stopsRoute.name}</div>
            </div>
            <div style={{ display:"flex", gap:8 }}>
              <button style={S.addBtn} onClick={openStopAdd}>+ 추가</button>
              <button style={S.editBtn} onClick={()=>setStopsRoute(null)}>✕</button>
            </div>
          </div>

          {/* 패널 본문 — 목록 + 추가/수정 폼을 한 스크롤 영역으로(내용 길어도 저장 버튼까지 스크롤) */}
          <div style={{ flex:1, overflowY:"auto", minHeight:0 }}>
          {/* 정류장 목록 */}
          <div style={{ padding:"8px 12px" }}>
            {stops.length > 0 && (
              <div style={{ fontSize:11, color:"var(--color-label-mute)", background:"var(--color-primary-soft)", border:"1px solid var(--color-line)", borderRadius:8, padding:"7px 10px", marginBottom:8, lineHeight:1.5 }}>
                💡 각 정류장의 <b>🕒 진입</b> 칸에 계획 시각을 바로 입력하면 즉시 저장됩니다(아래 폼 왕복 불필요). 첫 정류장은 노선 출발시각({stopsRoute?.departTime || "—"})과 동일하게.
              </div>
            )}
            {stops.length === 0 ? (
              <div style={{ color:"var(--color-label-alt)", textAlign:"center", padding:30, fontSize:13 }}>
                정류장이 없습니다<br/>
                <span style={{ fontSize:11, color:"var(--color-label-assistive)" }}>+ 추가 버튼으로 정류장을 등록하세요</span>
              </div>
            ) : stops.map((s, i) => (
              <div key={s.id} style={{ background:"var(--color-bg-alt)", border:"1px solid var(--color-line)", borderRadius:10, padding:"10px 12px", marginBottom:8 }}>
                <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                  <div style={{ width:24, height:24, borderRadius:"50%", background:"var(--color-primary-soft)", border:"1px solid var(--color-primary)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:700, color:"var(--color-primary-deep)", flexShrink:0 }}>
                    {s.order || i+1}
                  </div>
                  {s.photo && (
                    <img src={s.photo} alt="" style={{ width:40, height:40, objectFit:"cover", borderRadius:6, border:"1px solid var(--color-line)", flexShrink:0 }}/>
                  )}
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:13, fontWeight:600, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{s.name}</div>
                    {s.address && <div style={{ fontSize:11, color:"var(--color-label-mute)", marginTop:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{s.address}</div>}
                    {s.description && <div style={{ fontSize:10, color:"var(--color-label-mute)", marginTop:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>📝 {s.description}</div>}
                    {/* 계획 진입시각 — 목록 인라인 편집(2026-06-09): 폼 왕복 없이 전체 보며 위→아래 입력. 입력 즉시 저장. */}
                    <div style={{ display:"flex", alignItems:"center", gap:6, marginTop:3, flexWrap:"wrap" }}>
                      <span style={{ fontSize:10, color:"var(--color-label-mute)", flexShrink:0 }}>🕒 진입</span>
                      <input
                        type="time"
                        value={planTimeForStop(stopsRoute?.departTime, s.offsetMin) || ""}
                        onChange={e => saveStopTime(s, e.target.value)}
                        title="정류장 진입(계획) 시각 — 입력 즉시 저장"
                        style={{ fontSize:11, padding:"2px 6px", border:"1px solid var(--color-line)", borderRadius:6, fontFamily:"inherit", background:"var(--color-bg)", color:"var(--color-label)" }}
                      />
                      {typeof s.offsetMin === "number"
                        ? <span style={{ fontSize:10, color:"var(--color-primary-deep)", fontWeight:600, flexShrink:0 }}>+{s.offsetMin}분</span>
                        : <span style={{ fontSize:10, color:"var(--color-label-assistive)", flexShrink:0 }}>미설정</span>}
                    </div>
                    <div style={{ fontSize:10, color:"var(--color-label-alt)", marginTop:1 }}>{s.lat?.toFixed(5)}, {s.lng?.toFixed(5)}</div>
                  </div>
                  <div style={{ display:"flex", flexDirection:"column", gap:4, flexShrink:0 }}>
                    <div style={{ display:"flex", gap:4 }}>
                      <button onClick={()=>moveStop(i,-1)} disabled={i===0} style={{...S.editBtn, padding:"3px 7px", opacity:i===0?0.3:1}}>↑</button>
                      <button onClick={()=>moveStop(i,1)} disabled={i===stops.length-1} style={{...S.editBtn, padding:"3px 7px", opacity:i===stops.length-1?0.3:1}}>↓</button>
                    </div>
                    <div style={{ display:"flex", gap:4 }}>
                      <button style={S.editBtn} onClick={()=>openStopEdit(s)}>수정</button>
                      <button style={S.delBtn} onClick={()=>handleStopDelete(s)}>삭제</button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* 정류장 추가/수정 폼 */}
          {showStopForm && (
            <div style={{ padding:"14px 16px", borderTop:"1px solid var(--color-line)", background:"var(--color-bg-alt)" }}>
              <div style={{ fontSize:13, fontWeight:700, marginBottom:10, color:"var(--color-primary)" }}>{editStop?"정류장 수정":"정류장 추가"}</div>
              <label style={S.label}>정류장명 *</label>
              <input style={{...S.input, marginBottom:6}} placeholder="예) 서대전역 5번출구" value={stopForm.name} onChange={e=>setStopForm({...stopForm,name:e.target.value})}/>
              <label style={S.label}>주소·장소 검색</label>
              <div style={{ display:"flex", gap:6, marginBottom:6 }}>
                <input style={{...S.input, flex:1}} placeholder="예) 대전 서구 둔산동 / 서대전역"
                  value={addrQuery}
                  onChange={e=>setAddrQuery(e.target.value)}
                  onKeyDown={e=>{ if(e.key==="Enter"){ e.preventDefault(); handleAddrSearch(); } }}/>
                <button style={{...S.addBtn, opacity:addrSearching?0.6:1}} onClick={handleAddrSearch} disabled={addrSearching}>
                  {addrSearching ? "검색 중" : "검색"}
                </button>
              </div>
              {addrMsg && (
                <div style={{ fontSize:11, color:"var(--color-label-alt)", marginBottom:6, lineHeight:1.5 }}>{addrMsg}</div>
              )}
              {addrResults.length > 0 && (
                <div style={{ border:"1px solid var(--color-line)", borderRadius:8, marginBottom:6, overflow:"hidden", background:"var(--color-bg)" }}>
                  {addrResults.map((r, i) => (
                    <button key={i} onClick={()=>pickAddrResult(r)}
                      style={{ display:"block", width:"100%", textAlign:"left", border:"none", background:"transparent", borderBottom: i<addrResults.length-1?"1px solid var(--color-line)":"none", padding:"8px 10px", cursor:"pointer", fontFamily:"inherit" }}>
                      <div style={{ fontSize:12, fontWeight:600, color:"var(--color-label)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.name}</div>
                      {r.address && r.address!==r.name && (
                        <div style={{ fontSize:10, color:"var(--color-label-mute)", marginTop:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.address}</div>
                      )}
                      <div style={{ fontSize:10, color:"var(--color-label-assistive)", marginTop:1 }}>{r.lat.toFixed(5)}, {r.lng.toFixed(5)}</div>
                    </button>
                  ))}
                </div>
              )}
              <label style={S.label}>주소 (선택)</label>
              <input style={{...S.input, marginBottom:8}} placeholder="예) 대전 서구 둔산동 (검색 또는 직접 입력)" value={stopForm.address} onChange={e=>setStopForm({...stopForm,address:e.target.value})}/>

              {/* 정류장 사진 (선택) — 승객이 위치 사진으로 정류장 확인. Firestore에 압축 data URI 저장 */}
              <label style={S.label}>정류장 사진 (선택)</label>
              {stopForm.photo ? (
                <div style={{ position:"relative", marginBottom:8 }}>
                  <img src={stopForm.photo} alt="정류장 사진 미리보기"
                    style={{ width:"100%", maxHeight:160, objectFit:"cover", borderRadius:8, border:"1px solid var(--color-line)", display:"block" }}/>
                  <button onClick={()=>setStopForm(f=>({...f,photo:""}))} title="사진 삭제"
                    style={{ position:"absolute", top:6, right:6, width:26, height:26, borderRadius:"50%", border:"none", background:"rgba(11,16,32,0.62)", color:"#fff", fontSize:14, fontWeight:700, cursor:"pointer", lineHeight:1, fontFamily:"inherit" }}>✕</button>
                </div>
              ) : (
                <label style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:6, width:"100%", padding:"12px", background:"var(--color-bg-soft)", border:"1px dashed var(--color-line)", borderRadius:8, color:"var(--color-label-mute)", fontSize:13, fontWeight:600, cursor: photoProcessing?"default":"pointer", marginBottom:8, opacity: photoProcessing?0.6:1 }}>
                  {photoProcessing ? "사진 처리 중..." : "📷 사진 첨부 (자동 압축)"}
                  <input type="file" accept="image/*" onChange={handleStopPhoto} disabled={photoProcessing} style={{ display:"none" }}/>
                </label>
              )}
              <div style={{ fontSize:11, color:"var(--color-label-alt)", marginTop:-4, marginBottom:8 }}>
                💡 이미지를 복사한 뒤 <b>Ctrl+V</b>로 붙여넣어도 됩니다 (스크린샷·캡처 가능)
              </div>

              {/* 정류장 설명 (선택) — 승객 안내용 위치 설명 */}
              <label style={S.label}>정류장 설명 (선택)</label>
              <textarea style={{...S.input, marginBottom:8, minHeight:60, resize:"vertical", lineHeight:1.5}}
                placeholder="예) 정문 앞 버스 표지판 옆, 횡단보도 건너편"
                value={stopForm.description}
                onChange={e=>setStopForm({...stopForm,description:e.target.value})}/>

              {/* 정류장 진입시각 (선택) — HH:MM 직접 입력. 저장 시 노선 departTime 기준
                  offsetMin(분)으로 변환. 노선 출발시각 변경 시 정류장 절대시각이 자동 따라옴.
                  미설정 시 직선거리 기반 ETA로 폴백. */}
              <label style={S.label}>정류장 진입시각 (선택)</label>
              <input
                style={{...S.input, marginBottom:4}}
                type="time"
                placeholder="HH:MM"
                value={stopForm.plannedTime}
                onChange={e=>setStopForm({...stopForm, plannedTime: e.target.value})}
              />
              <div style={{ fontSize:11, color:"var(--color-label-alt)", marginBottom:8, lineHeight:1.45 }}>
                {(() => {
                  if (!stopForm.plannedTime) return "미설정 시 직선거리 기반 ETA로 폴백";
                  if (!stopsRoute?.departTime) return "⚠ 노선 출발시각이 설정되어야 합니다";
                  const off = offsetMinFromPlanTime(stopsRoute.departTime, stopForm.plannedTime);
                  if (off == null) return "형식 오류";
                  return `→ 노선 출발 ${stopsRoute.departTime} 기준 +${off}분 후`;
                })()}
              </div>

              {/* 지도 클릭 좌표 선택 버튼 */}
              <button onClick={() => setShowMapPicker(true)}
                style={{ width:"100%", padding:"10px", background: pickerPin ? "#E6F7EB" : "var(--color-bg-soft)", border: pickerPin ? "1px solid #00BF40" : "1px solid var(--color-line)", borderRadius:8, color: pickerPin ? "#007A29" : "var(--color-label-mute)", fontSize:13, fontWeight:600, cursor:"pointer", fontFamily:"inherit", marginBottom:6 }}>
                {pickerPin
                  ? `📍 ${parseFloat(stopForm.lat).toFixed(5)}, ${parseFloat(stopForm.lng).toFixed(5)}`
                  : "🗺 지도에서 위치 선택"}
              </button>

              {/* 좌표 직접 입력 (접기/펼치기) */}
              <details style={{ marginBottom:8 }}>
                <summary style={{ fontSize:11, color:"var(--color-label-alt)", cursor:"pointer", userSelect:"none" }}>좌표 직접 입력</summary>
                <div style={{ display:"flex", gap:6, marginTop:6 }}>
                  <div style={{ flex:1 }}>
                    <label style={S.label}>위도</label>
                    <input style={S.input} placeholder="36.3504" value={stopForm.lat}
                      onChange={e => { setStopForm({...stopForm,lat:e.target.value}); const v=parseFloat(e.target.value); if(!isNaN(v)) setPickerPin(p=>p?{...p,lat:v}:{lat:v,lng:parseFloat(stopForm.lng)||126.9}); }}/>
                  </div>
                  <div style={{ flex:1 }}>
                    <label style={S.label}>경도</label>
                    <input style={S.input} placeholder="127.3845" value={stopForm.lng}
                      onChange={e => { setStopForm({...stopForm,lng:e.target.value}); const v=parseFloat(e.target.value); if(!isNaN(v)) setPickerPin(p=>p?{...p,lng:v}:{lat:parseFloat(stopForm.lat)||37.3,lng:v}); }}/>
                  </div>
                </div>
              </details>

              <div style={{ display:"flex", gap:8 }}>
                <button style={{...S.addBtn, flex:1, opacity:stopLoading?0.6:1}} onClick={handleStopSave} disabled={stopLoading}>{stopLoading?"저장 중...":"저장"}</button>
                <button style={{...S.editBtn, flex:1}} onClick={()=>{setShowStopForm(false);setPickerPin(null);}}>취소</button>
              </div>
            </div>
          )}
          </div>
        </div>
      )}

      {/* ── 지도 좌표 선택 모달 ── */}
      {showMapPicker && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.7)", zIndex:200, display:"flex", flexDirection:"column" }}>
          {/* 모달 헤더 */}
          <div style={{ background:"var(--color-bg)", padding:"12px 16px", display:"flex", justifyContent:"space-between", alignItems:"center", flexShrink:0 }}>
            <div>
              <div style={{ fontSize:14, fontWeight:700 }}>📍 위치 선택</div>
              <div style={{ fontSize:11, color:"var(--color-label-mute)", marginTop:2 }}>
                {pickerPin ? `선택됨: ${pickerPin.lat.toFixed(5)}, ${pickerPin.lng.toFixed(5)} · 핀을 끌거나 지도를 클릭해 미세조정` : "지도를 클릭하거나 핀을 끌어 정류장 위치를 선택하세요"}
              </div>
            </div>
            <div style={{ display:"flex", gap:8 }}>
              <button
                onClick={() => {
                  if (pickerPin) {
                    setStopForm(f => ({...f, lat: pickerPin.lat.toFixed(6), lng: pickerPin.lng.toFixed(6)}));
                    setPickerCenter(pickerPin);
                  }
                  setShowMapPicker(false);
                }}
                disabled={!pickerPin}
                style={{ background: pickerPin ? "var(--color-primary)" : "var(--color-bg-soft)", border: pickerPin ? "none" : "1px solid var(--color-line)", borderRadius:8, padding:"8px 16px", color: pickerPin ? "#fff" : "var(--color-label-alt)", fontSize:13, fontWeight:700, cursor: pickerPin ? "pointer" : "default", fontFamily:"inherit", opacity: pickerPin ? 1 : 0.6 }}>
                이 위치로 선택
              </button>
              <button onClick={() => setShowMapPicker(false)}
                style={{ background:"var(--color-bg-soft)", border:"1px solid var(--color-line)", borderRadius:8, padding:"8px 14px", color:"var(--color-label-mute)", fontSize:13, cursor:"pointer", fontFamily:"inherit" }}>
                취소
              </button>
            </div>
          </div>

          {/* 카카오 지도 */}
          <div style={{ flex:1, minHeight:0 }}>
            <Map
              center={pickerCenter}
              style={{ width:"100%", height:"100%" }}
              level={4}
              onClick={(_, e) => {
                const lat = e.latLng.getLat();
                const lng = e.latLng.getLng();
                setPickerPin({ lat, lng });
                setPickerCenter({ lat, lng });
              }}
            >
              {pickerPin && (
                <>
                  <MapMarker position={pickerPin}
                    draggable={true}
                    onDragEnd={(marker) => {
                      const p = marker.getPosition();
                      const np = { lat: p.getLat(), lng: p.getLng() };
                      setPickerPin(np); setPickerCenter(np);
                    }}
                    image={{ src:"https://t1.daumcdn.net/localimg/localimages/07/mapapidoc/markerStar.png", size:{ width:24, height:35 } }}
                  />
                  <CustomOverlayMap position={pickerPin} yAnchor={2.2}>
                    <div style={{ background:"var(--color-bg)", border:"1px solid var(--color-primary)", borderRadius:8, padding:"4px 10px", fontSize:11, color:"var(--color-primary)", fontWeight:600, whiteSpace:"nowrap", boxShadow:"var(--shadow-float)" }}>
                      {stopForm.name || "새 정류장"}<br/>
                      <span style={{ color:"var(--color-label-alt)", fontWeight:400 }}>{pickerPin.lat.toFixed(5)}, {pickerPin.lng.toFixed(5)}</span>
                    </div>
                  </CustomOverlayMap>
                </>
              )}
              {/* 기존 정류장 마커 (참고용) */}
              {stops.map((s, i) => s.lat && s.lng && (
                <MapMarker key={s.id} position={{ lat:s.lat, lng:s.lng }}
                  image={{ src:"https://t1.daumcdn.net/localimg/localimages/07/mapapidoc/marker_red.png", size:{ width:16, height:24 } }}
                  onClick={() => setPickerCenter({ lat:s.lat, lng:s.lng })}
                />
              ))}
            </Map>
          </div>

          {/* 하단 안내 */}
          <div style={{ background:"var(--color-bg)", padding:"10px 16px", borderTop:"1px solid var(--color-line)", flexShrink:0 }}>
            <div style={{ fontSize:12, color:"var(--color-label-mute)", textAlign:"center" }}>
              지도를 클릭하면 핀이 찍힙니다 · 빨간 마커는 기존 정류장 위치입니다
            </div>
          </div>
        </div>
      )}

      {/* ── 노선 경로 그리기 모달 (수동 폴리라인) ── */}
      {pathRoute && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.7)", zIndex:200, display:"flex", flexDirection:"column" }}>
          {/* 헤더 */}
          <div style={{ background:"var(--color-bg)", padding:"12px 16px", display:"flex", justifyContent:"space-between", alignItems:"center", flexShrink:0, gap:12 }}>
            <div style={{ minWidth:0 }}>
              <div style={{ fontSize:14, fontWeight:700 }}>🛣 경로 그리기</div>
              <div style={{ fontSize:11, color:"var(--color-label-mute)", marginTop:2, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:"60vw" }}>
                {pathRoute.name} · 정점 {pathPoints.length}개{selectedIdx!=null ? ` · 선택 #${selectedIdx+1}` : ""}
              </div>
            </div>
            <div style={{ display:"flex", gap:8, flexShrink:0 }}>
              <button onClick={handlePathSave} disabled={pathLoading}
                style={{ background:"var(--color-primary)", border:"none", borderRadius:8, padding:"8px 16px", color:"#fff", fontSize:13, fontWeight:700, cursor:pathLoading?"default":"pointer", fontFamily:"inherit", opacity:pathLoading?0.6:1 }}>
                {pathLoading ? "저장 중..." : "경로 저장"}
              </button>
              <button onClick={closePathDraw}
                style={{ background:"var(--color-bg-soft)", border:"1px solid var(--color-line)", borderRadius:8, padding:"8px 14px", color:"var(--color-label-mute)", fontSize:13, cursor:"pointer", fontFamily:"inherit" }}>
                취소
              </button>
            </div>
          </div>

          {/* 편집 도구 */}
          <div style={{ background:"var(--color-bg)", padding:"8px 16px", borderTop:"1px solid var(--color-line)", display:"flex", flexWrap:"wrap", gap:6, alignItems:"center", flexShrink:0 }}>
            <button onClick={pathUndo} disabled={pathPoints.length===0}
              style={{...S.editBtn, opacity:pathPoints.length===0?0.4:1}}>↶ 되돌리기</button>
            <button onClick={pathClear} disabled={pathPoints.length===0}
              style={{...S.editBtn, opacity:pathPoints.length===0?0.4:1}}>전체 지우기</button>
            <button onClick={pathSeedFromStops} style={S.editBtn}>📍 정류장 순서대로 자동 연결</button>
            <button onClick={pathDeleteSelected} disabled={selectedIdx==null}
              style={{...S.editBtn, opacity:selectedIdx==null?0.4:1}}>
              🗑 선택점 삭제{selectedIdx!=null ? ` (#${selectedIdx+1})` : ""}
            </button>
            <button onClick={()=>setPrependMode(m=>!m)}
              style={{...S.editBtn, background:prependMode?"var(--color-primary)":undefined, color:prependMode?"#fff":undefined, borderColor:prependMode?"var(--color-primary)":undefined}}>
              {prependMode ? "✓ 앞에 추가 모드" : "↟ 앞에 추가"}
            </button>
            <span style={{ fontSize:11, color:"var(--color-label-alt)", marginLeft:"auto" }}>
              {prependMode
                ? "지도 클릭=출발점 앞에 추가 · ⊕=중간 삽입 · 핀 드래그=이동 · 핀 클릭=선택"
                : "지도 클릭=뒤에 추가 · ⊕=중간 삽입 · 핀 드래그=이동 · 핀 클릭=선택"}
            </span>
          </div>

          {/* 지도 */}
          <div style={{ flex:1, minHeight:0 }}>
            <Map
              center={pathCenter}
              style={{ width:"100%", height:"100%" }}
              level={6}
              onClick={(_, e) => {
                // 자동 도로 라우팅 미사용 — 클릭 좌표를 정점으로 추가
                // 첫 점은 항상 append, 이후엔 prependMode면 앞에 추가
                const lat = e.latLng.getLat(), lng = e.latLng.getLng();
                if (pathPoints.length === 0 || !prependMode) pathAddPoint(lat, lng);
                else pathPrependPoint(lat, lng);
              }}
            >
              {/* 진행 중 경로 미리보기 */}
              {pathPoints.length >= 2 && (
                <Polyline path={pathPoints} strokeWeight={5} strokeColor="#0066FF" strokeOpacity={0.85} strokeStyle="solid" />
              )}
              {/* 세그먼트 중점 ⊕ — 클릭=중간 삽입(작은 마커, 정점보다 시각적 우선순위 낮음) */}
              {pathPoints.length >= 2 && pathPoints.slice(0,-1).map((p, i) => {
                const mid = { lat:(p.lat + pathPoints[i+1].lat)/2, lng:(p.lng + pathPoints[i+1].lng)/2 };
                return (
                  <MapMarker key={`mid-${i}`} position={mid}
                    image={{
                      src: "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6" fill="#fff" stroke="#0066FF" stroke-width="1.5"/><path d="M7 3v8M3 7h8" stroke="#0066FF" stroke-width="1.5" stroke-linecap="round"/></svg>'),
                      size: { width: 14, height: 14 }
                    }}
                    onClick={() => { pathInsertPoint(i+1, mid.lat, mid.lng); setSelectedIdx(i+1); }}
                  />
                );
              })}
              {/* 정점 마커 — 출발(초록)/도착(빨강)/중간(파랑), 선택 시 검정 외곽선. 클릭=선택, 드래그=이동 */}
              {pathPoints.map((pt, i) => {
                const isStart = i === 0;
                const isEnd = i === pathPoints.length-1 && pathPoints.length > 1;
                const color = isStart ? "#00BF40" : isEnd ? "#FF4D6A" : "#0066FF";
                const w = (isStart || isEnd) ? 22 : 18;
                const h = (isStart || isEnd) ? 32 : 26;
                const stroke = i === selectedIdx ? ' stroke="#171719" stroke-width="3"' : "";
                const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'" viewBox="0 0 22 32"><path d="M11 0C5 0 0 5 0 11c0 8 11 21 11 21s11-13 11-21C22 5 17 0 11 0z" fill="'+color+'"'+stroke+'/><circle cx="11" cy="11" r="4" fill="#fff"/></svg>';
                return (
                  <MapMarker key={`pp-${i}`} position={pt}
                    draggable={true}
                    onDragEnd={(marker) => {
                      const p = marker.getPosition();
                      pathMovePoint(i, p.getLat(), p.getLng());
                      setSelectedIdx(i);
                    }}
                    onClick={() => setSelectedIdx(i)}
                    image={{ src: "data:image/svg+xml;utf8," + encodeURIComponent(svg), size: { width: w, height: h } }}
                  />
                );
              })}
              {/* 정점 번호/역할 라벨 — 출발/도착은 한국어, 중간은 #N */}
              {pathPoints.map((pt, i) => {
                const isStart = i === 0;
                const isEnd = i === pathPoints.length-1 && pathPoints.length > 1;
                const label = isStart ? "출발" : isEnd ? "도착" : `#${i+1}`;
                return (
                  <CustomOverlayMap key={`lbl-${i}`} position={pt} yAnchor={2.6}>
                    <div style={{ fontSize:10, padding:"2px 6px", borderRadius:999, background:"#fff", border:"1px solid var(--color-line)", boxShadow:"0 1px 3px rgba(0,0,0,.15)", color:"var(--color-label)", whiteSpace:"nowrap", fontFamily:"inherit" }}>
                      {label}
                    </div>
                  </CustomOverlayMap>
                );
              })}
              {/* 정류장 참고 마커(빨강) — 경로 그릴 때 위치 가이드 */}
              {pathStops.map(s => s.lat && s.lng && (
                <MapMarker key={`ps-${s.id}`} position={{ lat:s.lat, lng:s.lng }}
                  image={{ src:"https://t1.daumcdn.net/localimg/localimages/07/mapapidoc/marker_red.png", size:{ width:14, height:20 } }}
                  onClick={() => setPathCenter({ lat:s.lat, lng:s.lng })}
                />
              ))}
            </Map>
          </div>

          {/* 하단 안내 */}
          <div style={{ background:"var(--color-bg)", padding:"10px 16px", borderTop:"1px solid var(--color-line)", flexShrink:0 }}>
            <div style={{ fontSize:12, color:"var(--color-label-mute)", textAlign:"center" }}>
              빨간 마커는 정류장 위치(참고용)입니다 · 경로는 도로를 따라 직접 그려주세요 (자동 도로 연결 없음)
            </div>
          </div>
        </div>
      )}

      {/* 노선 추가/수정 모달 */}
      {showForm && (
        <div style={S.overlay}><div style={S.modal}>
          <div style={S.modalTitle}>{editItem?"노선 수정":"노선 추가"}</div>
          <label style={S.label}>거래처 *</label>
          <select style={{...S.input, marginBottom:4}} value={form.partnerCode}
            onChange={e => {
              const p = partners.find(x=>x.code===e.target.value);
              setForm({...form, partnerCode:e.target.value, partnerName:p?.partnerName||""});
            }}>
            <option value="">거래처 선택 (필수)</option>
            {partners.map(p=><option key={p.code} value={p.code}>{p.partnerName}</option>)}
          </select>
          <div style={{ display:"flex", gap:8, marginBottom:4 }}>
            {["출근","퇴근","셔틀"].map(t=>(
              <button key={t} onClick={()=>setForm({...form,type:t})}
                style={{...S.editBtn,flex:1,padding:"9px",background:form.type===t?"var(--color-primary)":"var(--color-bg-soft)",color:form.type===t?"#fff":"var(--color-label-mute)",border:form.type===t?"none":"1px solid var(--color-line)",cursor:"pointer",fontFamily:"inherit"}}>
                {t}
              </button>
            ))}
          </div>
          <label style={S.label}>근무조</label>
          <select style={S.input} value={form.shift} onChange={e=>setForm({...form,shift:e.target.value})}>
            {shifts.map(s=><option key={s} value={s}>{s}</option>)}
          </select>
          <label style={S.label}>노선명 *</label>
          <input style={S.input} placeholder="예) [주간조] 대전↔삼성 천안캠퍼스" value={form.name} onChange={e=>setForm({...form,name:e.target.value})} />
          <label style={S.label}>노선 코드</label>
          <input style={S.input} placeholder="예) 662" value={form.code} onChange={e=>setForm({...form,code:e.target.value})} />
          <label style={S.label}>출발시간 *</label>
          <input style={S.input} type="time" value={form.departTime} onChange={e=>setForm({...form,departTime:e.target.value})} />
          <label style={S.label}>좌석수</label>
          <input style={S.input} type="number" placeholder="45" value={form.seats} onChange={e=>setForm({...form,seats:e.target.value})} />
          {/* 표시 순서 — 승객·직원앱 노선 목록 정렬 기준. 비워두면 목록 맨 뒤(출발시간순). 2026-07-10 */}
          <label style={S.label}>표시 순서</label>
          <input style={S.input} type="number" placeholder="비워두면 맨 뒤 (작을수록 위)" value={form.order} onChange={e=>setForm({...form,order:e.target.value})} />
          <div style={{ fontSize:11, color:"var(--color-label-mute)", marginTop:-6, marginBottom:8 }}>
            승객·직원앱 노선 목록에 보이는 순서입니다. 목록에서 ▲▼ 버튼으로도 바꿀 수 있습니다.
          </div>
          {/* 표시 시간 — 승객·직원앱에서 이 노선 차량을 보여줄 시간대(2026-08-05 회의 #2·#3).
              비우면 출발시간 ± 회사 기본값에서 자동 계산. 하루 여러 번 도는 노선(온세미 등)은
              여기에 직접 넣으면 그 시간 내내 차량이 보인다. */}
          <label style={S.label}>표시 시간</label>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <input style={{...S.input, flex:1}} type="time" value={form.displayStart} onChange={e=>setForm({...form,displayStart:e.target.value})} />
            <span style={{ fontSize:13, color:"var(--color-label-mute)" }}>~</span>
            <input style={{...S.input, flex:1}} type="time" value={form.displayEnd} onChange={e=>setForm({...form,displayEnd:e.target.value})} />
          </div>
          <div style={{ fontSize:11, color:"var(--color-label-mute)", marginTop:-2, marginBottom:8, lineHeight:1.5 }}>
            승객·직원앱에 이 노선 차량이 보이는 시간대입니다. <b>비워두면 출발시간 기준으로 자동</b>
            (회사 관리 &gt; 기본 표시 범위). 하루에 여러 번 도는 노선은 직접 넣어주세요.
            <br />관리자 실시간 관제에는 시간과 무관하게 항상 보입니다.
          </div>
          {/* 탑승 QR 방향(노선 단위 override) — 혼승 노선 대응. 미설정 시 협력사 정책 따름. 2026-05-27 */}
          <label style={S.label}>탑승 QR 방향 (노선 override)</label>
          <select style={S.input} value={form.boardingMode}
            onChange={e=>setForm({...form, boardingMode:e.target.value})}>
            <option value="">협력사 정책 따름 (기본)</option>
            <option value="driver-qr">기사 발행 → 승객 스캔 (강제)</option>
            <option value="passenger-qr">승객 발행 → 기사 스캔 (강제)</option>
          </select>
          <div style={{ fontSize:11, color:"var(--color-label-mute)", marginTop:-2, marginBottom:6, lineHeight:1.4 }}>
            여러 협력사 승객이 같이 타는 혼승 노선은 "강제"로 한쪽을 명시하세요.
          </div>
          {/* 🛏 빈 차 확인 대상(2026-08-25 미팅) — way "슬리핑 차일드 운용하는 노선 선택이
              있어야 되겠네. 그러면 그 노선만 떠서 그 노선만 보면 되잖아."
              🔴 등교처럼 마지막 운행이 아닌 노선까지 켜면 미확인 목록이 매일 쌓이고
                 그 목록은 곧 아무도 안 본다(배시현 지적). 하교·방과후에만 켠다. */}
          <label style={{ ...S.label, display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input type="checkbox" checked={!!form.sleepCheckEnabled}
              onChange={e => setForm({ ...form, sleepCheckEnabled: e.target.checked })}
              style={{ width: 16, height: 16, cursor: "pointer" }} />
            🛏 빈 차 확인 대상 노선
          </label>
          <div style={{ fontSize:11, color:"var(--color-label-mute)", marginTop:-2, marginBottom:6, lineHeight:1.4 }}>
            켜면 <b>빈 차 확인</b> 탭 현황에 이 노선이 올라옵니다. <b>마지막 운행(하교·방과후)</b>에만 켜세요 —
            등교처럼 뒤에 운행이 더 있는 노선은 확인할 필요가 없습니다.
          </div>
          <label style={S.label}>메모</label>
          <input style={S.input} placeholder="비고 사항" value={form.memo} onChange={e=>setForm({...form,memo:e.target.value})} />
          <div style={{display:"flex",gap:8,marginTop:8}}>
            <button style={{...S.addBtn,flex:1,opacity:loading?0.6:1}} onClick={handleSave} disabled={loading}>{loading?"저장 중...":"저장"}</button>
            <button style={{...S.closeBtn,flex:1}} onClick={()=>setShowForm(false)}>취소</button>
          </div>
        </div></div>
      )}
    </div>
  );
}

// 탭4: 기사 관리
// 탭4: 기사 관리
// ═══════════════════════════════════════════════════════
function DriverTab({ companyId, vehicles, allowed, currentUserUid }) {
  const [drivers, setDrivers] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [form, setForm] = useState({ name:"", empNo:"", vehicleId:"", vehicleNo:"", phone:"", pin:"" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // 기사 격리: 전체권한/슈퍼관리자는 전체, 그 외엔 본인 등록(createdBy===uid) 기사만(2026-06-16).
  const canSeeAll = isAllAccess(allowed);
  const visibleDrivers = canSeeAll ? drivers : drivers.filter(d => d.createdBy && d.createdBy === currentUserUid);
  // 폼 배정차량 드롭다운도 동일 격리(본인 차량만 배정).
  const visibleVehicles = canSeeAll ? vehicles : vehicles.filter(v => v.createdBy && v.createdBy === currentUserUid);

  useEffect(() => {
    if (!companyId) return;
    return onSnapshot(collection(db, "companies", companyId, "drivers"), snap => {
      setDrivers(snap.docs.map(d => ({ id:d.id, ...d.data() })));
    });
  }, [companyId]);

  const handleVehicleSelect = (vehicleId) => {
    if (!vehicleId) { setForm({...form,vehicleId:"",vehicleNo:""}); return; }
    const v = vehicles.find(x=>x.id===vehicleId);
    setForm({...form,vehicleId,vehicleNo:v?.plateNo||""});
  };

  const openAdd = () => { setEditItem(null); setForm({name:"",empNo:"",vehicleId:"",vehicleNo:"",phone:"",pin:""}); setError(""); setShowForm(true); };
  const openEdit = (d) => { setEditItem(d); setForm({name:d.name||"",empNo:d.empNo||d.id,vehicleId:d.vehicleId||"",vehicleNo:d.vehicleNo||"",phone:d.phone||"",pin:""}); setError(""); setShowForm(true); };

  const handleSave = async () => {
    if (!form.name || !form.empNo) return setError("이름, 사번은 필수입니다");
    if (!editItem && (!form.pin || form.pin.length < 6)) return setError("신규 등록 시 PIN은 최소 6자리 필수입니다");
    if (editItem && form.pin && form.pin.length < 6) return setError("비밀번호는 최소 6자리여야 합니다");
    setLoading(true); setError("");
    try {
      if (editItem) {
        await updateDoc(doc(db, "companies", companyId, "drivers", editItem.id), {
          name:form.name, empNo:form.empNo, vehicleId:form.vehicleId, vehicleNo:form.vehicleNo, phone:form.phone, updatedAt:new Date().toISOString(),
        });
        if (form.pin) {
          try {
            if (editItem.uid) {
              await (httpsCallable(functions,"updateDriverPassword"))({uid:editItem.uid,newPassword:form.pin});
              alert("비밀번호가 변경되었습니다.");
            } else {
              await (httpsCallable(functions,"createDriverAuth"))({companyId,driverId:editItem.id,empNo:form.empNo,name:form.name,pin:form.pin});
              alert("로그인 계정이 생성되었습니다.\n사번: "+form.empNo);
            }
          } catch (fnErr) { alert("비밀번호 변경 오류: "+fnErr.message); }
        }
      } else {
        try {
          await (httpsCallable(functions,"createDriver"))({companyId,...form});
        } catch {
          await addDoc(collection(db,"companies",companyId,"drivers"),{name:form.name,empNo:form.empNo,vehicleId:form.vehicleId,vehicleNo:form.vehicleNo,phone:form.phone,status:"대기",createdAt:new Date().toISOString(),createdBy:currentUserUid||null});
        }
      }
      setShowForm(false);
    } catch (e) { setError(e.message||"저장 중 오류가 발생했습니다"); }
    setLoading(false);
  };

  const handleDelete = async (driver) => {
    if (!window.confirm(`${driver.name} 기사를 삭제하시겠습니까?`)) return;
    try {
      try { await (httpsCallable(functions,"deleteDriver"))({companyId,driverId:driver.id,uid:driver.uid}); }
      catch (cfErr) {
        console.warn("deleteDriver CF 실패, 직접 삭제 폴백:", cfErr?.message);
        await deleteDoc(doc(db,"companies",companyId,"drivers",driver.id));
      }
      alert(`${driver.name} 기사가 삭제되었습니다.`);
    } catch (e) { alert("삭제 중 오류: "+e.message); }
  };

  return (
    <div style={S.panel}>
      <div style={S.panelHeader}>
        <span style={{fontSize:16,fontWeight:700}}>기사 관리</span>
        <button style={S.addBtn} onClick={openAdd}>+ 기사 등록</button>
      </div>
      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead><tr>{["사번","이름","차량번호","연락처","상태"].map(h=><th key={h} style={S.th}>{h}</th>)}<th style={S.th}>관리</th></tr></thead>
          <tbody>
            {visibleDrivers.length===0?<tr><td colSpan={6} style={{...S.td,textAlign:"center",color:"var(--color-label-alt)"}}>등록된 기사가 없습니다</td></tr>
            :visibleDrivers.map(d=>(
              <tr key={d.id} style={S.tr}>
                <td style={S.td}>{d.empNo??d.id}</td>
                <td style={{...S.td,fontWeight:600}}>{d.name}</td>
                <td style={S.td}>{d.vehicleNo||"–"}</td>
                <td style={S.td}>{d.phone||"–"}</td>
                <td style={S.td}><span style={{...S.statusBadge,background:d.status==="운행중"?"#E6F7EB":"var(--color-bg-soft)",color:d.status==="운행중"?"#007A29":"var(--color-label-mute)"}}>{d.status??"대기"}</span></td>
                <td style={S.td}>
                  <button style={S.editBtn} onClick={()=>openEdit(d)}>수정</button>
                  <button style={S.delBtn} onClick={()=>handleDelete(d)}>삭제</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {showForm&&(
        <div style={S.overlay}><div style={S.modal}>
          <div style={S.modalTitle}>{editItem?"기사 정보 수정":"기사 등록"}</div>
          <label style={S.label}>이름 *</label>
          <input style={S.input} placeholder="홍길동" value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/>
          <label style={S.label}>사번 {editItem?"":"*"}</label>
          <input style={{...S.input,...(editItem?{opacity:0.6}:{})}} placeholder="예: 10001" value={form.empNo} onChange={e=>setForm({...form,empNo:e.target.value})} readOnly={!!editItem} autoComplete="off" name="driver-empno-noauto"/>
          {!editItem && <div style={{fontSize:11,color:"var(--color-label-mute)",margin:"-2px 0 2px",lineHeight:1.45}}>기사앱 <b>로그인 ID</b>입니다(숫자·영문, 회사 사번 사용 권장). 기사는 <b>사번 + PIN</b>으로 기사앱에 로그인합니다.</div>}
          <label style={S.label}>{editItem?"비밀번호 변경 (변경 시에만 입력)":"PIN * (최소 6자리)"}</label>
          <input style={S.input} placeholder={editItem?"변경하지 않으려면 비워두세요":"예: 000000"} type="password" value={form.pin} onChange={e=>setForm({...form,pin:e.target.value})} autoComplete="new-password" name="driver-pin-noauto"/>
          {!editItem && <div style={{fontSize:11,color:"var(--color-label-mute)",margin:"-2px 0 2px",lineHeight:1.45}}>기사앱 <b>로그인 비밀번호</b>입니다(숫자 6자리 이상). 기사가 첫 로그인 후 변경하도록 안내하세요.</div>}
          <label style={S.label}>배정 차량</label>
          <SearchableSelect value={form.vehicleId} onChange={handleVehicleSelect}
            options={visibleVehicles.map(v => ({ value:v.id, label:`${v.plateNo} (${v.model || v.type || v.id})` }))}
            placeholder="차량 선택 (검색·선택사항)" />
          <label style={S.label}>연락처</label>
          <input style={S.input} placeholder="010-0000-0000" value={form.phone} onChange={e=>setForm({...form,phone:e.target.value})}/>
          {error&&<p style={{color:"var(--color-destructive)",fontSize:13,margin:0}}>{error}</p>}
          <div style={{display:"flex",gap:8,marginTop:8}}>
            <button style={{...S.addBtn,flex:1,opacity:loading?0.6:1}} onClick={handleSave} disabled={loading}>{loading?"저장 중...":"저장"}</button>
            <button style={{...S.closeBtn,flex:1}} onClick={()=>setShowForm(false)}>취소</button>
          </div>
        </div></div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// 탭5: 차량 관리
// ═══════════════════════════════════════════════════════
function VehicleTab({ companyId, vehicles, allowed, currentUserUid }) {
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState(null);
  // gpsSource: "mobile"(📱 기사앱 startGPS·기본) | "device"(🛰️ GPS 단말·busin 서버 폴링).
  // carId: device 일 때 busin 차량ID(pollDeviceVehicleGps 가 위치 조회에 사용).
  const [form, setForm] = useState({ plateNo:"", model:"", type:"", seats:"", year:"", memo:"", gpsSource:"mobile", carId:"" });
  const [loading, setLoading] = useState(false);
  // "번호로 carId 조회" 상태(resolveBusinCarId 호출 결과 표시).
  const [carIdLoading, setCarIdLoading] = useState(false);
  const [carIdMsg, setCarIdMsg] = useState("");
  // 고정(정적) QR 생성/인쇄 모달 상태(2026-07-08 RQ#3). 모든 차량에 제공(관리자가 필요 차량 인쇄).
  const [qrVehicle, setQrVehicle] = useState(null);
  const [qrDataUrl, setQrDataUrl] = useState("");
  // 슬리핑 차일드 확인용 뒷좌석 QR(2026-08-18) — 탑승 QR 과 **다른 경로**(/sleep)여야 한다.
  // 같은 QR 로 두면 승객이 찍었을 때 탑승이 적재된다.
  const [sleepQrDataUrl, setSleepQrDataUrl] = useState("");

  useEffect(() => {
    if (!qrVehicle) { setQrDataUrl(""); return; }
    let alive = true;
    const url = getStaticBoardingUrl({ companyId, vehicleId: qrVehicle.id });
    QRCode.toDataURL(url, { width: 280, margin: 1 })
      .then(d => { if (alive) setQrDataUrl(d); })
      .catch(() => { if (alive) setQrDataUrl(""); });
    QRCode.toDataURL(getSleepCheckUrl({ companyId, vehicleId: qrVehicle.id }), { width: 280, margin: 1 })
      .then(d => { if (alive) setSleepQrDataUrl(d); })
      .catch(() => { if (alive) setSleepQrDataUrl(""); });
    return () => { alive = false; };
  }, [qrVehicle, companyId]);

  // 새 창에 인쇄용 최소 HTML(차량번호 + QR + URL) → 로드 시 자동 인쇄. 팝업 차단 시 안내.
  // kind="board"=탑승용(차량 입구) · kind="sleep"=빈 차 확인용(맨 뒷좌석).
  const printQr = (kind = "board") => {
    const isSleep = kind === "sleep";
    const img = isSleep ? sleepQrDataUrl : qrDataUrl;
    if (!img || !qrVehicle) return;
    const w = window.open("", "_blank");
    if (!w) { alert("팝업이 차단되었습니다. 브라우저 팝업 차단을 해제한 뒤 다시 시도하세요."); return; }
    const plate = qrVehicle.plateNo || qrVehicle.id;
    const url = isSleep
      ? getSleepCheckUrl({ companyId, vehicleId: qrVehicle.id })
      : getStaticBoardingUrl({ companyId, vehicleId: qrVehicle.id });
    const title = isSleep ? "빈 차 확인 QR" : "탑승 QR";
    const sub = isSleep ? "맨 뒷좌석에 부착 · 운행 종료 후 스캔" : "차량에 부착 · 탑승 시 스캔";
    w.document.write(
      '<!doctype html><html><head><meta charset="utf-8"><title>' + plate + ' ' + title + '</title></head>'
      + '<body onload="window.print()" style="margin:0;font-family:sans-serif;text-align:center;padding:40px">'
      + '<h1 style="font-size:30px;margin:0 0 8px">' + plate + '</h1>'
      + '<div style="font-size:20px;font-weight:700;margin-bottom:6px">' + title + '</div>'
      + '<div style="font-size:15px;color:#555;margin-bottom:28px">' + sub + '</div>'
      + '<img src="' + img + '" style="width:340px;height:340px"/>'
      + '<div style="font-size:12px;color:#888;margin-top:18px;word-break:break-all">' + url + '</div>'
      + '</body></html>'
    );
    w.document.close();
  };

  // 차량 격리: 전체권한/슈퍼관리자는 전체, 그 외엔 본인 등록(createdBy===uid) 차량만(2026-06-16).
  const canSeeAll = isAllAccess(allowed);
  const visibleVehicles = canSeeAll ? vehicles : vehicles.filter(v => v.createdBy && v.createdBy === currentUserUid);

  const openAdd = () => { setEditItem(null); setForm({plateNo:"",model:"",type:"대형",seats:"45",year:"",memo:"",gpsSource:"mobile",carId:""}); setCarIdMsg(""); setShowForm(true); };
  const openEdit = (item) => { setEditItem(item); setForm({plateNo:item.plateNo||"",model:item.model||"",type:item.type||"대형",seats:item.seats?.toString()||"",year:item.year||"",memo:item.memo||"",gpsSource:item.gpsSource||"mobile",carId:item.carId||""}); setCarIdMsg(item.carId?`저장된 carId: ${item.carId}`:""); setShowForm(true); };

  // busin 편성에서 차량번호로 carId 조회(device 방식 차량용).
  const resolveCarId = async () => {
    const vno = form.plateNo.trim();
    if (!vno) { alert("차량번호를 먼저 입력하세요"); return; }
    setCarIdLoading(true); setCarIdMsg("조회 중…");
    try {
      const res = await httpsCallable(functions,"resolveBusinCarId")({ vehicleNo: vno });
      const { carId, name } = res.data || {};
      if (carId) {
        setForm(f => ({...f, carId}));
        setCarIdMsg(`✓ carId ${carId}${name?` (기사 ${name})`:""}`);
      } else {
        setCarIdMsg("⚠ busin 편성에 이 차량번호 없음 — 번호 확인");
      }
    } catch (e) {
      setCarIdMsg("조회 실패: "+(e.message||String(e)));
    }
    setCarIdLoading(false);
  };

  const handleSave = async () => {
    if (!form.plateNo) return alert("차량번호는 필수입니다");
    const isDevice = form.gpsSource === "device";
    if (isDevice && !form.carId.trim() &&
        !window.confirm("GPS 단말 방식인데 carId 가 없습니다. carId 없이 저장하면 서버 위치 추적이 안 됩니다(나중에 '번호로 carId 조회'로 채울 수 있음).\n계속 저장할까요?")) {
      return;
    }
    setLoading(true);
    try {
      const data = {plateNo:form.plateNo.trim(),model:form.model.trim(),type:form.type,seats:form.seats?parseInt(form.seats):null,year:form.year.trim(),memo:form.memo.trim(),
        gpsSource:isDevice?"device":"mobile",
        carId:isDevice?form.carId.trim():"",
        updatedAt:new Date().toISOString()};
      if (editItem) {
        await updateDoc(doc(db,"companies",companyId,"vehicles",editItem.id),data);
      } else {
        data.createdAt = new Date().toISOString();
        data.createdBy = currentUserUid || null;
        // 자동 ID(addDoc) — 배열 길이 기반 `vehicle_NNN` 은 삭제 후 재등록·다중 admin 동시
        // 등록 시 같은 ID 재생성→기존 차량 덮어쓰기(데이터 손실). 기존 vehicle_NNN 차량은
        // ID 유지(배차/gps 가 vehicleId 값 참조) — 신규만 자동 ID라 무영향(2026-06-22).
        await addDoc(collection(db,"companies",companyId,"vehicles"),data);
      }
      setShowForm(false);
    } catch (e) { alert("저장 중 오류: "+e.message); }
    setLoading(false);
  };

  const handleDelete = async (item) => {
    if (!window.confirm(`${item.plateNo} 차량을 삭제하시겠습니까?`)) return;
    await deleteDoc(doc(db,"companies",companyId,"vehicles",item.id));
  };

  return (
    <div style={S.panel}>
      <div style={S.panelHeader}>
        <span style={{fontSize:16,fontWeight:700}}>차량 관리</span>
        <div style={{display:"flex",gap:12,alignItems:"center"}}>
          <span style={{fontSize:13,color:"var(--color-label-mute)"}}>총 {visibleVehicles.length}대</span>
          <button style={S.addBtn} onClick={openAdd}>+ 차량 등록</button>
        </div>
      </div>
      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead><tr>{["차량ID","차량번호","위치방식","차종","모델명","좌석수","연식","비고"].map(h=><th key={h} style={S.th}>{h}</th>)}<th style={S.th}>관리</th></tr></thead>
          <tbody>
            {visibleVehicles.length===0?<tr><td colSpan={9} style={{...S.td,textAlign:"center",color:"var(--color-label-alt)"}}>등록된 차량이 없습니다</td></tr>
            :visibleVehicles.map(v=>(
              <tr key={v.id} style={S.tr}>
                <td style={{...S.td,color:"var(--color-label-mute)",fontSize:12}}>{v.id}</td>
                <td style={{...S.td,fontWeight:600}}>{v.plateNo}</td>
                <td style={S.td}>{v.gpsSource==="device"
                  ? <span style={{...S.statusBadge,background:"var(--color-primary-soft)",color:"var(--color-primary-deep)"}}>🛰️ 단말{v.carId?` (${v.carId})`:""}</span>
                  : <span style={{...S.statusBadge,background:"var(--color-bg-alt)",color:"var(--color-label-mute)"}}>📱 모바일</span>}</td>
                <td style={S.td}><span style={{...S.statusBadge,background:v.type==="대형"?"var(--color-primary-soft)":v.type==="중형"?"#FFF1E0":"#E6F7EB",color:v.type==="대형"?"var(--color-primary-deep)":v.type==="중형"?"#B95300":"#007A29"}}>{v.type||"–"}</span></td>
                <td style={S.td}>{v.model||"–"}</td>
                <td style={S.td}>{v.seats?`${v.seats}석`:"–"}</td>
                <td style={S.td}>{v.year||"–"}</td>
                <td style={{...S.td,fontSize:12,color:"var(--color-label-mute)"}}>{v.memo||"–"}</td>
                <td style={S.td}>
                  <button style={S.editBtn} onClick={()=>openEdit(v)}>수정</button>
                  <button style={S.editBtn} onClick={()=>setQrVehicle(v)}>🖨 QR</button>
                  <button style={S.delBtn} onClick={()=>handleDelete(v)}>삭제</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {showForm&&(
        <div style={S.overlay}><div style={S.modal}>
          <div style={S.modalTitle}>{editItem?"차량 수정":"차량 등록"}</div>
          <label style={S.label}>차량번호 *</label>
          <input style={S.input} placeholder="34가 1234" value={form.plateNo} onChange={e=>setForm({...form,plateNo:e.target.value})}/>
          <label style={S.label}>위치 신호 방식</label>
          <div style={{display:"flex",gap:8}}>
            {[["mobile","📱 모바일 앱"],["device","🛰️ GPS 단말"]].map(([val,lbl])=>(
              <button key={val} type="button"
                onClick={()=>setForm(f=>({...f,gpsSource:val}))}
                style={{flex:1,padding:"9px 8px",borderRadius:8,fontSize:13,fontWeight:600,cursor:"pointer",
                  border:form.gpsSource===val?"1.5px solid var(--color-primary)":"1px solid var(--color-border)",
                  background:form.gpsSource===val?"var(--color-primary-soft)":"var(--color-bg)",
                  color:form.gpsSource===val?"var(--color-primary-deep)":"var(--color-label-mute)"}}>
                {lbl}
              </button>
            ))}
          </div>
          {form.gpsSource==="device"&&(
            <div style={{marginTop:8,padding:12,borderRadius:8,background:"var(--color-bg-alt)"}}>
              <div style={{fontSize:12,color:"var(--color-label-mute)",marginBottom:6}}>
                GPS 단말은 서버가 busin 편성의 carId 로 위치를 조회해 자동 추적합니다. 차량번호로 carId 를 조회하세요.
              </div>
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                <input style={{...S.input,flex:1,margin:0}} placeholder="carId (예: 4660)" value={form.carId} onChange={e=>setForm({...form,carId:e.target.value})}/>
                <button type="button" style={{...S.editBtn,whiteSpace:"nowrap",opacity:carIdLoading?0.6:1}} onClick={resolveCarId} disabled={carIdLoading}>
                  {carIdLoading?"조회 중…":"번호로 carId 조회"}
                </button>
              </div>
              {carIdMsg&&<div style={{fontSize:12,marginTop:6,color:carIdMsg.startsWith("⚠")||carIdMsg.startsWith("조회 실패")?"var(--color-destructive)":"var(--color-positive)"}}>{carIdMsg}</div>}
            </div>
          )}
          <label style={S.label}>차종</label>
          <select style={S.input} value={form.type} onChange={e=>setForm({...form,type:e.target.value})}>
            {["대형","중형","소형","우등","전세"].map(t=><option key={t} value={t}>{t}</option>)}
          </select>
          <label style={S.label}>모델명</label>
          <input style={S.input} placeholder="현대 유니버스" value={form.model} onChange={e=>setForm({...form,model:e.target.value})}/>
          <label style={S.label}>좌석수</label>
          <input style={S.input} type="number" placeholder="45" value={form.seats} onChange={e=>setForm({...form,seats:e.target.value})}/>
          <label style={S.label}>연식</label>
          <input style={S.input} placeholder="2024" value={form.year} onChange={e=>setForm({...form,year:e.target.value})}/>
          <label style={S.label}>비고</label>
          <input style={S.input} placeholder="메모" value={form.memo} onChange={e=>setForm({...form,memo:e.target.value})}/>
          <div style={{display:"flex",gap:8,marginTop:8}}>
            <button style={{...S.addBtn,flex:1,opacity:loading?0.6:1}} onClick={handleSave} disabled={loading}>{loading?"저장 중...":"저장"}</button>
            <button style={{...S.closeBtn,flex:1}} onClick={()=>setShowForm(false)}>취소</button>
          </div>
        </div></div>
      )}
      {qrVehicle&&(
        <div style={S.overlay}><div style={S.modal}>
          <div style={S.modalTitle}>고정 QR — {qrVehicle.plateNo||qrVehicle.id}</div>
          <div style={{fontSize:12,color:"var(--color-label-mute)",marginBottom:12,lineHeight:1.6}}>
            차량에 부착하는 고정 QR입니다. 직원이 스캔하면 그날 이 차량 배차 노선으로 탑승 기록됩니다(만료 없음·재사용). 오늘 배차가 있어야 탑승됩니다.
          </div>
          <div style={{display:"flex",justifyContent:"center",padding:"8px 0"}}>
            {qrDataUrl
              ? <img src={qrDataUrl} alt="고정 QR" style={{width:240,height:240}}/>
              : <div style={{width:240,height:240,display:"flex",alignItems:"center",justifyContent:"center",color:"var(--color-label-mute)"}}>QR 생성 중…</div>}
          </div>
          <div style={{fontSize:11,color:"var(--color-label-mute)",wordBreak:"break-all",textAlign:"center",marginTop:8}}>
            {getStaticBoardingUrl({companyId,vehicleId:qrVehicle.id})}
          </div>
          <div style={{display:"flex",gap:8,marginTop:16}}>
            <button style={{...S.addBtn,flex:1,opacity:qrDataUrl?1:0.6}} onClick={()=>printQr("board")} disabled={!qrDataUrl}>🖨 탑승 QR 인쇄</button>
            <button style={{...S.closeBtn,flex:1}} onClick={()=>setQrVehicle(null)}>닫기</button>
          </div>
          {/* 슬리핑 차일드 — 맨 뒷좌석 확인 QR(2026-08-18 건의). 탑승 QR 과 경로가 다르다. */}
          <div style={{marginTop:18,paddingTop:16,borderTop:"1px solid var(--color-line)"}}>
            <div style={{fontSize:13,fontWeight:800,color:"var(--color-label)"}}>빈 차 확인 QR (맨 뒷좌석)</div>
            <div style={{fontSize:12,color:"var(--color-label-mute)",margin:"6px 0 10px",lineHeight:1.6}}>
              운행이 끝나면 기사가 맨 뒷좌석까지 가서 이 QR을 스캔합니다. 확인 여부는 실시간 관제에서 보입니다.
            </div>
            <div style={{display:"flex",justifyContent:"center"}}>
              {sleepQrDataUrl
                ? <img src={sleepQrDataUrl} alt="빈 차 확인 QR" style={{width:180,height:180}}/>
                : <div style={{width:180,height:180,display:"flex",alignItems:"center",justifyContent:"center",color:"var(--color-label-mute)"}}>QR 생성 중…</div>}
            </div>
            <button style={{...S.addBtn,width:"100%",marginTop:12,opacity:sleepQrDataUrl?1:0.6}}
              onClick={()=>printQr("sleep")} disabled={!sleepQrDataUrl}>🖨 빈 차 확인 QR 인쇄</button>
          </div>
        </div></div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// 탭6: GPS 시뮬레이터
// ═══════════════════════════════════════════════════════
function SimulatorTab({ companyId, vehicles, drivers }) {
  const isMobile = useIsMobile();
  const [driverId, setDriverId] = useState("");
  const [vehicleId, setVehicleId] = useState("");
  const [routeName, setRouteName] = useState("테스트노선");
  const [useMyLocation, setUseMyLocation] = useState(true);
  const [lat, setLat] = useState("37.3894");
  const [lng, setLng] = useState("126.9522");
  const [interval, setIntervalSec] = useState(5);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState([]);
  const timerRef = useRef(null);
  const [center, setCenter] = useState({ lat:37.3894, lng:126.9522 });
  const [markerPos, setMarkerPos] = useState(null);

  const driver = drivers.find(d=>d.id===driverId);
  const vehicle = vehicles.find(v=>v.id===vehicleId);

  const addLog = (msg) => { const now = new Date().toLocaleTimeString("ko-KR"); setLog(prev=>[`[${now}] ${msg}`,...prev].slice(0,20)); };

  const doSend = useCallback(async () => {
    if (!vehicleId) { addLog("❌ 차량을 선택해주세요"); return; }
    try {
      let curLat = parseFloat(lat), curLng = parseFloat(lng);
      if (useMyLocation) {
        const pos = await new Promise((res,rej) => navigator.geolocation.getCurrentPosition(res,rej,{enableHighAccuracy:true,timeout:5000}));
        curLat = pos.coords.latitude; curLng = pos.coords.longitude;
        setLat(curLat.toFixed(6)); setLng(curLng.toFixed(6));
      }
      setMarkerPos({lat:curLat,lng:curLng}); setCenter({lat:curLat,lng:curLng});
      await sendGPS({ companyId, vehicleId, vehicleNo:vehicle?.plateNo||vehicleId, driverId:driverId||"simulator", driverName:driver?.name||"시뮬레이터", routeId:"", routeName, lat:curLat, lng:curLng, speed:0, accuracy:10 });
      addLog(`✅ 전송 완료 (${curLat.toFixed(5)}, ${curLng.toFixed(5)})`);
    } catch (e) { addLog(`❌ 오류: ${e.message}`); }
  }, [vehicleId, driverId, lat, lng, useMyLocation, routeName, vehicle, driver, companyId]);

  const handleStart = () => { setRunning(true); doSend(); timerRef.current=setInterval(doSend,interval*1000); addLog(`🟢 시뮬레이터 시작 (${interval}초 간격)`); };
  const handleStop = () => { clearInterval(timerRef.current); setRunning(false); addLog("🔴 시뮬레이터 종료"); };
  useEffect(()=>()=>clearInterval(timerRef.current),[]);

  return (
    <div style={{display:"flex",flexDirection:isMobile?"column":"row",height:"100%",minHeight:0,minWidth:0}}>
      <div style={{...S.mapSidebar,padding:"0 0 16px",...(isMobile?S.mapSidebarMobile:{})}}>
        <div style={S.panelHeader}>
          <span style={{fontWeight:700,color:"var(--color-label)"}}>🧪 GPS 시뮬레이터</span>
          <span style={{fontSize:11,fontWeight:600,color:running?"var(--color-positive)":"var(--color-label-mute)"}}>{running?"● 송출 중":"○ 정지"}</span>
        </div>
        <div style={{padding:"16px 16px 0",display:"flex",flexDirection:"column",gap:10}}>
          <div><label style={S.label}>기사 선택</label>
            <select style={S.input} value={driverId} onChange={e=>{setDriverId(e.target.value);const drv=drivers.find(d=>d.id===e.target.value);if(drv?.vehicleId)setVehicleId(drv.vehicleId);}}>
              <option value="">기사 선택 (선택사항)</option>
              {drivers.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div><label style={S.label}>차량 *</label>
            <select style={S.input} value={vehicleId} onChange={e=>setVehicleId(e.target.value)}>
              <option value="">차량 선택</option>
              {vehicles.map(v=><option key={v.id} value={v.id}>{v.plateNo}</option>)}
            </select>
          </div>
          <div><label style={S.label}>노선명</label><input style={S.input} value={routeName} onChange={e=>setRouteName(e.target.value)}/></div>
          <div style={{background:"var(--color-bg-alt)",borderRadius:8,padding:12}}>
            <label style={{...S.label,display:"flex",alignItems:"center",gap:8,cursor:"pointer"}}>
              <input type="checkbox" checked={useMyLocation} onChange={e=>setUseMyLocation(e.target.checked)}/>내 현재 위치 사용
            </label>
            {!useMyLocation&&(
              <div style={{marginTop:8,display:"flex",gap:8}}>
                <input style={{...S.input,flex:1}} placeholder="위도" value={lat} onChange={e=>setLat(e.target.value)}/>
                <input style={{...S.input,flex:1}} placeholder="경도" value={lng} onChange={e=>setLng(e.target.value)}/>
              </div>
            )}
          </div>
          <div><label style={S.label}>전송 간격 (초)</label>
            <select style={S.input} value={interval} onChange={e=>setIntervalSec(Number(e.target.value))} disabled={running}>
              {[3,5,10,30].map(s=><option key={s} value={s}>{s}초</option>)}
            </select>
          </div>
          {!running
            ?<button style={{...S.addBtn,padding:"10px"}} onClick={handleStart}>🟢 시뮬레이터 시작</button>
            :<button style={{...S.addBtn,background:"var(--color-destructive)",padding:"10px"}} onClick={handleStop}>🔴 시뮬레이터 종료</button>
          }
          <button style={{...S.editBtn,padding:"8px",fontSize:13}} onClick={doSend} disabled={running}>📡 1회 수동 전송</button>
        </div>
        <div style={{margin:"12px 16px 0",background:"var(--color-bg-alt)",borderRadius:8,padding:10,fontSize:11,color:"var(--color-label-mute)",maxHeight:200,overflowY:"auto"}}>
          {log.length===0?<span style={{color:"var(--color-label-alt)"}}>로그 없음</span>:log.map((l,i)=><div key={i}>{l}</div>)}
        </div>
      </div>
      <div style={{flex:1,position:"relative"}}>
        <Map center={center} style={{width:"100%",height:"100%"}} level={5}>
          {markerPos&&<MapMarker position={markerPos}/>}
        </Map>
        {markerPos&&(
          <div style={{...S.infoBox,top:16,right:16}}>
            <div style={S.infoTitle}>📍 시뮬레이터 위치</div>
            <div style={S.infoRow}>위도: {markerPos.lat.toFixed(6)}</div>
            <div style={S.infoRow}>경도: {markerPos.lng.toFixed(6)}</div>
            <div style={S.infoRow}>차량: {vehicle?.plateNo||vehicleId||"–"}</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// 탭7: 운행 이력
// ═══════════════════════════════════════════════════════
function HistoryTab({ companyId, vehicles, allowed }) {
  const isMobile = useIsMobile();
  const [date, setDate] = useState(getToday());
  const [vehicleId, setVehicleId] = useState("");
  const [points, setPoints] = useState([]);
  const [loading, setLoading] = useState(false);
  const [center, setCenter] = useState({ lat:37.3894, lng:126.9522 });
  const [selected, setSelected] = useState(null);
  const [partnerCode, setPartnerCode] = useState("전체"); // 협력사 필터
  // 차량 → 협력사 매핑(routes + dispatchSchedules 의 vehicleId 기반)
  const [routes, setRoutes] = useState([]);
  const [schedules, setSchedules] = useState([]);
  // 노선별 배차 그룹 뷰 (2026-05-26 추가):
  // 기존 차량 단일 선택 → 오늘 배차를 노선별로 그룹화한 리스트에서 선택 → 해당 배차의 GPS 이력 자동 로드.
  const [dispatches, setDispatches] = useState([]);
  const [selectedDispatchId, setSelectedDispatchId] = useState(null);
  // 정류장 시각화 검증 도구(2026-05-29): 선택된 배차의 routeId 기반 stops를 로드해
  // 카카오맵에 정류장 마커 + 100m 반경 원(도착 감지 임계)을 함께 표시. GPS 경로가
  // 어느 정류장 반경에 진입했는지 시각적으로 검증해 정류장 도착 감지 실패 원인을 한눈에 파악.
  const [stopsByRoute, setStopsByRoute] = useState({}); // routeId → stops[]
  const [showStopMarkers, setShowStopMarkers] = useState(true);
  const [showStopRadius, setShowStopRadius] = useState(true);
  // 도착 감지 반경(회사 설정 companies/{cid}.stopArriveRadiusM, 미설정=100m). 관리자가 조정 →
  // 모바일 gps.js·서버 폴러가 이 값으로 정류장 도착 판정. 아래 반경 원 시각화도 이 값 사용.
  const [arriveRadius, setArriveRadius] = useState(100); // 저장된 값(원·감지)
  const [radiusInput, setRadiusInput] = useState(100);   // 슬라이더 로컬 입력값
  const [radiusSaving, setRadiusSaving] = useState(false);
  const vehicle = vehicles.find(v=>v.id===vehicleId);

  // 회사 도착 감지 반경 구독 — 저장 즉시 반영.
  useEffect(() => {
    if (!companyId) return;
    return onSnapshot(doc(db, "companies", companyId), snap => {
      const v = snap.data()?.stopArriveRadiusM;
      const r = (typeof v === "number" && isFinite(v) && v > 0) ? v : 100;
      setArriveRadius(r); setRadiusInput(r);
    });
  }, [companyId]);

  const saveArriveRadius = async () => {
    const r = Math.max(50, Math.min(300, Math.round(radiusInput || 100)));
    setRadiusSaving(true);
    try {
      await updateDoc(doc(db, "companies", companyId), { stopArriveRadiusM: r });
    } catch (e) {
      alert("반경 저장 실패: " + (e?.message || e));
    }
    setRadiusSaving(false);
  };

  useEffect(() => {
    if (!companyId) return;
    return onSnapshot(collection(db, "companies", companyId, "routes"),
      snap => setRoutes(snap.docs.map(d => ({ id:d.id, ...d.data() }))));
  }, [companyId]);
  useEffect(() => {
    if (!companyId) return;
    return onSnapshot(collection(db, "companies", companyId, "dispatchSchedules"),
      snap => setSchedules(snap.docs.map(d => ({ id:d.id, ...d.data() }))));
  }, [companyId]);
  useEffect(() => {
    if (!companyId || !date) return;
    return onSnapshot(collection(db, "companies", companyId, "dispatches", date, "list"),
      snap => setDispatches(snap.docs.map(d => ({ id:d.id, ...d.data() }))));
  }, [companyId, date]);

  // 정류장 시각화 — 카드 보조 표시(통과 N/M)에 모든 dispatch 의 routeId stops 필요.
  // 운영 데이터상 한 날짜의 distinct routeId 수는 보통 ≤ 20 → onSnapshot 대신 getDocs 1회.
  // BoardingStatsTab 의 stopsByRoute 패턴 그대로 차용(routes 변경 빈도 낮음).
  useEffect(() => {
    if (!companyId || dispatches.length === 0) return;
    const routeIds = Array.from(new window.Set(dispatches.map(d => d.routeId).filter(Boolean)));
    const toLoad = routeIds.filter(rid => !stopsByRoute[rid]);
    if (toLoad.length === 0) return;
    Promise.all(toLoad.map(async rid => {
      try {
        const snap = await getDocs(query(
          collection(db, "companies", companyId, "routes", rid, "stops"),
          orderBy("order", "asc")
        ));
        return [rid, snap.docs.map(d => ({ id: d.id, ...d.data() }))];
      } catch (_) {
        return [rid, []];
      }
    })).then(pairs => {
      setStopsByRoute(prev => {
        const next = { ...prev };
        pairs.forEach(([rid, stops]) => { next[rid] = stops; });
        return next;
      });
    });
  }, [companyId, dispatches, stopsByRoute]);

  // vehicleId → partnerCode 추정: 그 차량에 등록된 schedule 의 routeId → routes.partnerCode
  // (schedule 없으면 routes 의 vehicleId 매칭은 routes 에 vehicleId 필드 없음 — schedule 기반으로 한정)
  const vehiclePartnerOf = (vid) => {
    const sched = schedules.find(s => s.vehicleId === vid);
    if (!sched) return null;
    return routes.find(r => r.id === sched.routeId)?.partnerCode || null;
  };
  // Phase B: "전체"여도 제한 admin 은 allowed 협력사로 한정.
  const filteredVehicles = vehicles.filter(v => {
    const pc = vehiclePartnerOf(v.id);
    if (partnerCode !== "전체") return pc === partnerCode;
    return isAllAccess(allowed) || partnerCodeAllowed(allowed, pc);
  });

  // 협력사 필터 적용된 배차 → 노선별 그룹
  const filteredDispatches = dispatches.filter(d => {
    const pc = routes.find(r => r.id === d.routeId)?.partnerCode;
    if (partnerCode !== "전체") return pc === partnerCode;
    return isAllAccess(allowed) || partnerCodeAllowed(allowed, pc);
  });
  // ⚠ 카카오 SDK `Map` import가 native Map 클래스를 shadow → `new Map()` 빌드 시 forwardRef 객체로 변환되어 비-생성자 TypeError.
  //   `window.Map` 으로 native 명시(memory: `Map` shadow 패턴, NoticeTab L3098과 동일 가드).
  const dispatchGroups = (() => {
    const map = new window.Map();
    filteredDispatches.forEach(d => {
      const key = d.routeId || "_unassigned";
      if (!map.has(key)) {
        const r = routes.find(x => x.id === d.routeId);
        map.set(key, {
          routeId: d.routeId, routeName: d.routeName || r?.name || "노선 미지정", items: [],
        });
      }
      map.get(key).items.push(d);
    });
    // 그룹별 내부 시간순, 그룹은 가장 이른 출발시간 순으로 정렬
    const groups = [...map.values()];
    groups.forEach(g => g.items.sort((a, b) => (a.departTime || "99:99").localeCompare(b.departTime || "99:99")));
    groups.sort((a, b) => {
      const ta = a.items[0]?.departTime || "99:99", tb = b.items[0]?.departTime || "99:99";
      return ta.localeCompare(tb);
    });
    return groups;
  })();

  // 배차의 시간 범위(start/end millis) 산출 — gpsHistory는 vehicleId/date 단위로 누적되므로
  // 한 차량이 하루에 여러 배차 운행 시 모든 배차가 동일 포인트로 보이는 결함 차단용.
  // start = departTime 5분 전(차량 워밍업 여유), end = (a)도착기록 있으면 마지막 actualAt+10분 (b)없으면
  // 같은 차량의 다음 배차 출발 5분 전 (c)그것도 없으면 start+3시간(보수적 기본).
  const dispatchTimeRange = (d, allDispatches) => {
    const baseDate = new Date(date + "T00:00:00");
    const baseMs = baseDate.getTime();
    const parseHM = (hhmm) => {
      const m = (hhmm || "").match(/^(\d{1,2}):(\d{2})$/);
      if (!m) return null;
      return (+m[1]) * 60 * 60 * 1000 + (+m[2]) * 60 * 1000;
    };
    const departOff = parseHM(d.departTime);
    if (departOff == null) return null;
    const start = baseMs + departOff - 5 * 60 * 1000;
    // 도착 기록 있으면 마지막 actualAt 기준
    const sa = d.stopArrivals || {};
    let lastActualMs = null;
    Object.values(sa).forEach(a => {
      const ms = a?.actualAt?.toMillis ? a.actualAt.toMillis()
        : (typeof a?.actualAt === "number" ? a.actualAt : null);
      if (ms != null && (lastActualMs == null || ms > lastActualMs)) lastActualMs = ms;
    });
    if (lastActualMs != null) {
      return { start, end: lastActualMs + 10 * 60 * 1000 };
    }
    // 같은 차량의 다음 배차 찾기(현 배차 이후 출발 시간 중 최저)
    const sameVehicleLater = allDispatches
      .filter(x => x.vehicleId === d.vehicleId && x.id !== d.id)
      .map(x => parseHM(x.departTime))
      .filter(off => off != null && off > departOff)
      .sort((a, b) => a - b);
    if (sameVehicleLater.length > 0) {
      return { start, end: baseMs + sameVehicleLater[0] - 5 * 60 * 1000 };
    }
    return { start, end: start + 3 * 60 * 60 * 1000 };
  };

  // 배차 클릭 시: vehicleId 자동 설정 + 이력 자동 로드 + 배차 시간 범위로 필터.
  const handleSelectDispatch = (d) => {
    setSelectedDispatchId(d.id);
    if (d.vehicleId) {
      setVehicleId(d.vehicleId);
      const range = dispatchTimeRange(d, dispatches);
      loadHistory(d.vehicleId, range);
    }
  };
  const loadHistory = async (vid, range) => {
    if (!vid) return;
    setLoading(true); setPoints([]); setSelected(null);
    try {
      const ref = collection(db,"gpsHistory",companyId,vid,date,"points");
      const snap = await getDocs(query(ref,orderBy("ts","asc")));
      let list = snap.docs.map((d)=>({id:d.id,...d.data(),ts:d.data().ts}));
      // 배차 시간 범위가 주어지면 필터(차량 단위 GPS를 배차 단위로 좁힘).
      if (range) {
        list = list.filter(p => {
          const ms = p.ts?.toMillis ? p.ts.toMillis()
            : (typeof p.ts === "number" ? p.ts : (p.ts ? new Date(p.ts).getTime() : null));
          return ms != null && ms >= range.start && ms <= range.end;
        });
      }
      list = list.map((p, i) => ({ ...p, idx: i + 1 }));
      setPoints(list);
      if (list.length>0) setCenter({lat:list[0].lat,lng:list[0].lng});
    } catch (e) { alert("조회 오류: "+e.message); }
    setLoading(false);
  };

  // 배차 요약 정보 — 도착 완료 정류장 수 / 총 정류장 수 / 누적 지연(분).
  // totalStops 는 stopsByRoute 캐시 로드 후에만 값 있음(미로드 시 null → "—" 표시).
  const dispatchSummary = (d) => {
    const sa = d.stopArrivals || {};
    const arrivedCount = Object.keys(sa).length;
    const stops = d.routeId ? stopsByRoute[d.routeId] : null;
    const totalStops = stops ? stops.length : null;
    // 마지막 도착 정류장의 delaySec를 누적지연 대표값으로 사용.
    let lastDelaySec = null;
    Object.values(sa).forEach(a => {
      if (a && typeof a.delaySec === "number") lastDelaySec = a.delaySec;
    });
    return { arrivedCount, totalStops, delayMin: lastDelaySec != null ? Math.round(lastDelaySec / 60) : null };
  };

  const handleLoad = async () => {
    if (!vehicleId) return alert("차량을 선택해주세요");
    setLoading(true); setPoints([]); setSelected(null);
    try {
      const ref = collection(db,"gpsHistory",companyId,vehicleId,date,"points");
      const snap = await getDocs(query(ref,orderBy("ts","asc")));
      const list = snap.docs.map((d,i)=>({idx:i+1,id:d.id,...d.data(),ts:d.data().ts}));
      setPoints(list);
      if (list.length>0) setCenter({lat:list[0].lat,lng:list[0].lng});
    } catch (e) { alert("조회 오류: "+e.message); }
    setLoading(false);
  };

  // GPS 궤적 밀도·공백 — "경로가 직선으로 나온다" 신고(2026-08-18)의 답을 화면에 적기 위한 실측값.
  // 이 화면의 파랑 선은 도로 경로가 아니라 **GPS 수신점을 순서대로 이은 선**이다. 단말(유비칸)
  // 차량은 좌표를 1~2분에 한 번 보내므로 점 사이가 수백 m~수 km 이고, 그 사이는 직선이 된다.
  // 곡선이 아닌 게 결함이 아니라는 것과, 진짜 결함(신호 공백)을 화면에서 가르는 게 목적.
  const track = trackSegments(points);
  // 등록 노선 경로(관리자가 그린 routePath) — GPS 궤적과 대조용 밑선(2026-08-18).
  // 이 화면만 사전 경로를 안 그리고 있었다(승객앱·직원앱·협력사 포털은 이미 그린다).
  // 미설정 노선은 빈 배열 → 안 그린다(정류장 직선으로 지어내지 않는다).
  const drawnRoute = toLatLngPath(
    routes.find(r => r.id === (selectedDispatchId ? dispatches.find(x => x.id === selectedDispatchId)?.routeId : null))?.routePath
  );
  const formatTs = (ts) => { if (!ts) return "–"; const d=ts.toDate?ts.toDate():new Date(ts); return d.toLocaleTimeString("ko-KR",{hour:"2-digit",minute:"2-digit",second:"2-digit"}); };

  return (
    <div style={{display:"flex",flexDirection:isMobile?"column":"row",height:"100%",minHeight:0,minWidth:0}}>
      <div style={{...S.mapSidebar,...(isMobile?S.mapSidebarMobile:{})}}>
        <div style={S.panelHeader}>
          <span style={{fontWeight:700}}>📅 운행 이력</span>
          {points.length>0&&<span style={{fontSize:12,fontWeight:600,color:"var(--color-positive)"}}>{points.length}개 포인트</span>}
        </div>
        <div style={{padding:"14px 16px 10px",display:"flex",flexDirection:"column",gap:10,borderBottom:"1px solid var(--color-line-soft)"}}>
          <div><label style={S.label}>날짜</label><input type="date" style={S.dateInput} value={date} onChange={e=>{ if(e.target.value) { setDate(e.target.value); setSelectedDispatchId(null); setPoints([]); }}}/></div>
          <div><label style={S.label}>거래처</label>
            <PartnerFilter companyId={companyId} value={partnerCode} onChange={setPartnerCode} compact={false} allowedCodes={allowed} />
          </div>
          {/* 직접 차량 선택 (보조 — 노선별 배차가 없는 날·이전 데이터 조회용) */}
          <details style={{ background:"var(--color-bg-alt)", borderRadius:8, padding:"8px 10px" }}>
            <summary style={{ cursor:"pointer", fontSize:11, fontWeight:700, color:"var(--color-label-mute)" }}>차량 직접 선택 (보조)</summary>
            <div style={{ marginTop:8, display:"flex", gap:6 }}>
              <select style={{...S.input,flex:1,fontSize:12,padding:"7px 9px"}} value={vehicleId} onChange={e=>setVehicleId(e.target.value)}>
                <option value="">차량 선택</option>
                {filteredVehicles.map(v=><option key={v.id} value={v.id}>{v.plateNo}</option>)}
              </select>
              <button style={{...S.addBtn,padding:"6px 10px",fontSize:12}} onClick={handleLoad} disabled={loading||!vehicleId}>{loading?"…":"조회"}</button>
            </div>
          </details>
        </div>
        {/* 노선별 배차 그룹 */}
        <div style={{flex:1,overflowY:"auto",padding:"10px 12px"}}>
          <div style={{ fontSize:11, fontWeight:700, color:"var(--color-label-mute)", padding:"4px 2px 10px", textTransform:"uppercase", letterSpacing:0.04 }}>
            노선별 배차 · {filteredDispatches.length}건
          </div>
          {dispatchGroups.length === 0 ? (
            <div style={{ ...S.empty, padding:"24px 12px" }}>해당 날짜에 배차된 노선이 없습니다</div>
          ) : dispatchGroups.map(group => (
            <div key={group.routeId || "_unassigned"} style={{ marginBottom:14 }}>
              <div style={{ fontSize:13, fontWeight:800, color:"var(--color-label)", marginBottom:6, display:"flex", alignItems:"center", gap:6 }}>
                <span style={{ width:3, height:14, background:"var(--color-primary)", borderRadius:2 }}/>
                {group.routeName}
                <span style={{ fontSize:11, fontWeight:600, color:"var(--color-label-mute)", marginLeft:"auto" }}>{group.items.length}건</span>
              </div>
              <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
                {group.items.map(d => {
                  const summ = dispatchSummary(d);
                  const isSelected = selectedDispatchId === d.id;
                  const delayTone = summ.delayMin == null ? null
                    : summ.delayMin >= 2 ? "danger" : summ.delayMin <= -2 ? "warn" : "ok";
                  const delayColor = delayTone === "danger" ? "var(--color-destructive)"
                    : delayTone === "warn" ? "var(--color-cautionary)" : "var(--color-positive)";
                  return (
                    <div key={d.id} onClick={() => handleSelectDispatch(d)}
                      style={{
                        padding:"9px 11px", borderRadius:8, cursor:"pointer",
                        background: isSelected ? "var(--color-primary-soft)" : "var(--color-bg-alt)",
                        border: `1px solid ${isSelected ? "var(--color-primary)" : "var(--color-line)"}`,
                        transition:"all .12s",
                      }}>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", gap:8 }}>
                        <span style={{ fontSize:13, fontWeight:800, color: isSelected ? "var(--color-primary-deep)" : "var(--color-label)", fontFamily:"var(--font-mono)" }}>
                          {d.departTime || "––:––"}
                        </span>
                        <span style={{ fontSize:11, color:"var(--color-label-mute)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                          {d.driverName || "기사 미지정"}
                        </span>
                      </div>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:4, fontSize:11 }}>
                        <span style={{ color:"var(--color-label-mute)" }}>
                          {d.vehicleNo || "차량 미지정"}
                          {/* 통과 카운트 — stops 캐시 로드 후에만 분수 표시, 미로드시 "—" */}
                          <span style={{ marginLeft:8, color:"var(--color-positive)", fontWeight:700 }}>
                            ✅ {summ.arrivedCount}/{summ.totalStops != null ? summ.totalStops : "—"} 통과
                          </span>
                        </span>
                        {summ.delayMin != null && (
                          <span style={{ color: delayColor, fontWeight:700, fontSize:11 }}>
                            {summ.delayMin >= 2 ? `+${summ.delayMin}분` : summ.delayMin <= -2 ? `${summ.delayMin}분` : "정시"}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {/* GPS 포인트 리스트 — 배차 선택 후 로드된 경우 */}
          {points.length>0 && (
            <div style={{ marginTop:14, paddingTop:10, borderTop:"1px solid var(--color-line)" }}>
              <div style={{fontSize:11,color:"var(--color-label-mute)",padding:"0 2px 4px",fontWeight:700,textTransform:"uppercase",letterSpacing:0.04}}>
                📍 GPS 포인트 · {points.length}개 ({vehicle?.plateNo || "–"})
              </div>
              {/* 표본 간격 요약 — "경로가 직선으로 나온다"의 답(2026-08-18).
                  지도의 파랑 선은 도로가 아니라 수신점을 이은 선이고, 점 사이 간격이 곧 직선의 길이다. */}
              <div style={{ fontSize:10, color:"var(--color-label-alt)", padding:"0 2px 8px", lineHeight:1.6 }}>
                좌표 갱신 간격 중앙 <b style={{color:"var(--color-label-mute)"}}>{formatDuration(track.stats.medianMoveGapSec)}</b>
                {" · "}점 사이 중앙 <b style={{color:"var(--color-label-mute)"}}>{track.stats.medianStepM ?? "–"}m</b>
                {track.stats.maxStepM != null && <> (최대 {track.stats.maxStepM}m)</>}
                {track.stats.duplicates > 0 && <> · 같은 좌표 재기록 {track.stats.duplicates}개</>}
                {track.gaps.length > 0 && (
                  <> · <span style={{color:"#B26A00",fontWeight:700}}>신호 공백 {track.gaps.length}회
                    (최대 {formatDuration(track.stats.maxGapSec)})</span></>
                )}
                <br/>지도의 파랑 선은 도로 경로가 아니라 <b>수신점을 순서대로 이은 선</b>입니다 —
                단말이 좌표를 보내는 간격만큼 점 사이가 벌어지고 그 사이는 직선이 됩니다.
              </div>
              {selectedDispatchId && (() => {
                const d = dispatches.find(x => x.id === selectedDispatchId);
                if (!d) return null;
                const r = dispatchTimeRange(d, dispatches);
                if (!r) return null;
                const fmt = (ms) => { const dt = new Date(ms); return `${String(dt.getHours()).padStart(2,"0")}:${String(dt.getMinutes()).padStart(2,"0")}`; };
                return (
                  <div style={{ fontSize:10, color:"var(--color-label-alt)", padding:"0 2px 8px" }}>
                    배차 시간대 {fmt(r.start)}~{fmt(r.end)} 범위 필터 적용
                  </div>
                );
              })()}
              {points.map(p=>(
                <div key={p.id} onClick={()=>{setSelected(p);setCenter({lat:p.lat,lng:p.lng});}}
                  style={{padding:"7px 10px",borderRadius:8,marginBottom:4,cursor:"pointer",background:selected?.id===p.id?"var(--color-primary-soft)":"var(--color-bg-alt)",border:`1px solid ${selected?.id===p.id?"var(--color-primary)":"var(--color-line)"}`}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <span style={{fontSize:11,fontWeight:700,color:"var(--color-primary)"}}>#{p.idx}</span>
                    <span style={{fontSize:11,color:"var(--color-label-mute)"}}>{formatTs(p.ts)}</span>
                  </div>
                  <div style={{fontSize:11,color:"var(--color-label-mute)",marginTop:2}}>{p.speed??0} km/h</div>
                </div>
              ))}
            </div>
          )}
          {!loading && points.length===0 && selectedDispatchId && (
            <div style={{ ...S.empty, padding:"16px 12px", marginTop:10 }}>선택한 배차에 GPS 이력이 없습니다</div>
          )}
        </div>
      </div>
      <div style={{flex:1,position:"relative"}}>
        {/* 선택된 배차의 stops + 통과 여부 — 카카오맵 정류장 시각화 검증 도구 */}
        {(() => {
          const selDispatch = selectedDispatchId ? dispatches.find(x => x.id === selectedDispatchId) : null;
          const selStops = selDispatch?.routeId ? (stopsByRoute[selDispatch.routeId] || []) : [];
          const arrivals = selDispatch?.stopArrivals || {};
          // 2026-05-29 fix: Firestore stops 의 lat/lng 가 number 아닌 string·GeoPoint 일 수 있음.
          // typeof === "number" 엄격 필터로 모두 제외돼 정류장 표시 0개 결함. coerce + GeoPoint 지원.
          const toLatLng = (s) => {
            let lat, lng;
            if (s.lat != null && s.lng != null) {
              lat = typeof s.lat === "number" ? s.lat : Number(s.lat);
              lng = typeof s.lng === "number" ? s.lng : Number(s.lng);
            } else if (s.latitude != null && s.longitude != null) {
              lat = Number(s.latitude); lng = Number(s.longitude);
            } else if (s.location && typeof s.location.latitude === "number") {
              lat = s.location.latitude; lng = s.location.longitude;
            }
            return { lat, lng };
          };
          const validStops = selStops
            .map(s => ({ ...s, ...toLatLng(s) }))
            .filter(s => isFinite(s.lat) && isFinite(s.lng));
          return (
            <Map center={center} style={{width:"100%",height:"100%"}} level={7}>
              {/* ① 등록 경로 — 회색 밑선(도로를 따라간다). GPS 궤적과 겹쳐 보며 이탈을 판단. */}
              {drawnRoute.length>=2&&<Polyline path={drawnRoute} strokeWeight={7} strokeColor="#8A94A6" strokeOpacity={0.45} strokeStyle="solid"/>}
              {/* ② GPS 실측 궤적 — 연속 수신 구간만 실선. 3분 넘게 끊긴 구간은 아래 점선으로. */}
              {track.runs.map((seg,i)=>(
                <Polyline key={`trk-${i}`} path={seg} strokeWeight={4} strokeColor="#0066FF" strokeOpacity={0.85} strokeStyle="solid"/>
              ))}
              {/* ③ 신호 공백 — 이은 선 자체가 추정이므로 점선(실측이 없는 구간을 실선으로 그리지 말 것) */}
              {track.gaps.map((g,i)=>(
                <Polyline key={`gap-${i}`} path={[g.from,g.to]} strokeWeight={3} strokeColor="#E8A33D" strokeOpacity={0.9} strokeStyle="shortdash"/>
              ))}
              {/* ④ 수신점 — 선이 어디서 어디로 이어졌는지(=왜 직선인지)를 눈으로 확인. 250점 초과면
                     오버레이가 과해져 생략(그때는 좌측 요약의 간격 수치로 판단). */}
              {points.length<=250 && points.map(p=>(
                <CustomOverlayMap key={`fix-${p.id}`} position={{lat:p.lat,lng:p.lng}} yAnchor={0.5}>
                  <div title={`#${p.idx} ${formatTs(p.ts)}`} style={{ width:6, height:6, borderRadius:"50%",
                    background:"#fff", border:"1.5px solid #0066FF", boxShadow:"0 0 0 1px rgba(255,255,255,.9)" }} />
                </CustomOverlayMap>
              ))}
              {points.length>0&&<MapMarker position={{lat:points[0].lat,lng:points[0].lng}} title="출발"/>}
              {points.length>1&&<MapMarker position={{lat:points[points.length-1].lat,lng:points[points.length-1].lng}} title="도착"/>}
              {selected&&<MapMarker position={{lat:selected.lat,lng:selected.lng}}/>}
              {/* 정류장 100m 반경 원 — 통과 정류장은 파랑 강조, 미통과는 회색 */}
              {showStopRadius && validStops.map(stop => {
                const passed = !!arrivals[stop.id];
                return (
                  <Circle
                    key={`circle-${stop.id}`}
                    center={{lat:stop.lat,lng:stop.lng}}
                    radius={arriveRadius}
                    strokeWeight={1}
                    strokeColor={passed ? "#0066FF" : "#666666"}
                    strokeOpacity={0.6}
                    strokeStyle="solid"
                    fillColor={passed ? "#0066FF" : "#aaaaaa"}
                    fillOpacity={passed ? 0.18 : 0.12}
                  />
                );
              })}
              {/* 정류장 위치 마커 + 이름 라벨(통과=녹/미통과=회색 tone) */}
              {showStopMarkers && validStops.map(stop => {
                const passed = !!arrivals[stop.id];
                return (
                  <CustomOverlayMap key={`label-${stop.id}`} position={{lat:stop.lat,lng:stop.lng}} yAnchor={1.4}>
                    <div style={{
                      padding:"3px 8px",
                      background: passed ? "var(--color-positive)" : "var(--color-bg)",
                      color: passed ? "#fff" : "var(--color-label-mute)",
                      border: `1px solid ${passed ? "var(--color-positive)" : "var(--color-line)"}`,
                      borderRadius:10,
                      fontSize:11,
                      fontWeight:700,
                      whiteSpace:"nowrap",
                      maxWidth:140,
                      overflow:"hidden",
                      textOverflow:"ellipsis",
                      boxShadow:"var(--shadow-soft)",
                      pointerEvents:"none",
                    }}>
                      {stop.name || "정류장"}
                    </div>
                  </CustomOverlayMap>
                );
              })}
            </Map>
          );
        })()}
        {/* 토글 컨트롤 바 — 좌측 상단 */}
        {selectedDispatchId && (
          <div style={{
            position:"absolute", top:12, left:12, zIndex:5,
            background:"rgba(255,255,255,0.95)", backdropFilter:"blur(8px)", WebkitBackdropFilter:"blur(8px)",
            border:"1px solid var(--color-line)", borderRadius:10, padding:"8px 12px",
            boxShadow:"var(--shadow-soft)", display:"flex", gap:14, fontSize:12,
          }}>
            <label style={{display:"flex",alignItems:"center",gap:5,cursor:"pointer",color:"var(--color-label)"}}>
              <input type="checkbox" checked={showStopRadius} onChange={e=>setShowStopRadius(e.target.checked)} />
              <span>🎯 정류장 반경 {arriveRadius}m</span>
            </label>
            <label style={{display:"flex",alignItems:"center",gap:5,cursor:"pointer",color:"var(--color-label)"}}>
              <input type="checkbox" checked={showStopMarkers} onChange={e=>setShowStopMarkers(e.target.checked)} />
              <span>📍 정류장 마커</span>
            </label>
            {/* 도착 감지 반경 조정(회사 전체 공통) — 슬라이더 + 저장. 저장 시 모바일·서버 감지에 반영. */}
            <div style={{display:"flex",alignItems:"center",gap:7,borderLeft:"1px solid var(--color-line)",paddingLeft:12}}>
              <span style={{color:"var(--color-label)",fontWeight:600,whiteSpace:"nowrap"}}>감지 반경</span>
              <input type="range" min={50} max={300} step={10} value={radiusInput}
                onChange={e=>setRadiusInput(Number(e.target.value))}
                style={{width:96,accentColor:"var(--color-primary)"}} />
              <span style={{fontFamily:"var(--font-mono)",fontWeight:700,color:"var(--color-primary)",minWidth:44,textAlign:"right"}}>{radiusInput}m</span>
              <button onClick={saveArriveRadius}
                disabled={radiusSaving || radiusInput===arriveRadius}
                style={{
                  padding:"3px 10px",borderRadius:8,border:"1px solid var(--color-primary)",
                  background: (radiusSaving||radiusInput===arriveRadius) ? "var(--color-bg)" : "var(--color-primary)",
                  color: (radiusSaving||radiusInput===arriveRadius) ? "var(--color-label-mute)" : "#fff",
                  fontWeight:700,fontSize:12,
                  cursor:(radiusSaving||radiusInput===arriveRadius)?"default":"pointer",whiteSpace:"nowrap",
                }}>
                {radiusSaving ? "저장 중…" : radiusInput===arriveRadius ? "저장됨" : "저장"}
              </button>
            </div>
          </div>
        )}
        {/* 범례 — 좌측 하단. 선(등록 경로/GPS 실측/신호 공백)과 정류장 표시를 함께 설명(2026-08-18).
            🔴 선 종류를 설명하지 않으면 회색 밑선을 "잘못 그려진 경로"로 읽는다. */}
        {selectedDispatchId && (points.length > 0 || showStopRadius || showStopMarkers) && (
          <div style={{
            position:"absolute", left:12, bottom:12, zIndex:5,
            background:"rgba(255,255,255,0.92)", backdropFilter:"blur(8px)", WebkitBackdropFilter:"blur(8px)",
            border:"1px solid var(--color-line)", borderRadius:8, padding:"7px 10px",
            boxShadow:"var(--shadow-soft)", fontSize:11, color:"var(--color-label-mute)",
            display:"flex", gap:10, alignItems:"center", flexWrap:"wrap", maxWidth:"min(560px, 70%)",
          }}>
            {points.length > 0 && (
              <>
                <span style={{display:"inline-flex",alignItems:"center",gap:4}}>
                  <span style={{width:16,height:3,borderRadius:2,background:"#0066FF"}}/>GPS 실측
                </span>
                {track.gaps.length > 0 && (
                  <span style={{display:"inline-flex",alignItems:"center",gap:4}} title={`${TRACK_GAP_SEC}초 넘게 수신이 끊긴 구간 — 이은 선은 추정입니다`}>
                    <span style={{width:16,height:0,borderTop:"3px dashed #E8A33D"}}/>신호 공백
                  </span>
                )}
                <span style={{display:"inline-flex",alignItems:"center",gap:4}}>
                  <span style={{width:16,height:5,borderRadius:3,background:"#8A94A6",opacity:0.55}}/>
                  {drawnRoute.length >= 2 ? "등록 경로" : "등록 경로 없음"}
                </span>
              </>
            )}
            {(showStopRadius || showStopMarkers) && (
              <>
                <span style={{display:"inline-flex",alignItems:"center",gap:4}}>
                  <span style={{width:9,height:9,borderRadius:"50%",background:"var(--color-positive)"}}/>통과
                </span>
                <span style={{display:"inline-flex",alignItems:"center",gap:4}}>
                  <span style={{width:9,height:9,borderRadius:"50%",background:"#aaaaaa"}}/>미통과
                </span>
                <span style={{color:"var(--color-label-alt)"}}>· 반경 {arriveRadius}m</span>
              </>
            )}
          </div>
        )}
        {selected&&(
          <div style={S.infoBox}>
            <div style={S.infoTitle}>📌 포인트 #{selected.idx}</div>
            <div style={S.infoRow}>시각: {formatTs(selected.ts)}</div>
            <div style={S.infoRow}>위도: {selected.lat.toFixed(6)}</div>
            <div style={S.infoRow}>경도: {selected.lng.toFixed(6)}</div>
            <div style={S.infoRow}>속도: {selected.speed??0} km/h</div>
            <button onClick={()=>setSelected(null)} style={S.closeBtn}>닫기</button>
          </div>
        )}
        {points.length===0&&!loading&&(
          <div style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",background:"rgba(255,255,255,0.92)",backdropFilter:"blur(8px)",WebkitBackdropFilter:"blur(8px)",border:"1px solid var(--color-line)",borderRadius:12,padding:"20px 32px",textAlign:"center",color:"var(--color-label-mute)",fontSize:14,boxShadow:"var(--shadow-float)",lineHeight:1.6}}>
            왼쪽 사이드바에서<br/>노선·배차를 선택하면<br/>GPS 이력이 표시됩니다
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// 탭9: 탑승 통계 (QR 탑승 누적, 2026-05-26)
// ═══════════════════════════════════════════════════════
// boardings/{date}/list/{boardingId} 컬렉션 = QR 탑승 1건. partnerCode 필드는 신규 boarding부터
// 자동 채움(lib/boarding.js 2026-05-26). 기존 데이터는 partnerCode=undefined → "미지정" 표시.
function BoardingStatsTab({ companyId, allowed }) {
  const [date, setDate] = useState(getToday());
  const [partnerCode, setPartnerCode] = useState("전체");
  const [boardings, setBoardings] = useState([]);
  const [partners, setPartners] = useState([]); // partnerCode → partnerName 매핑용
  const [search, setSearch] = useState("");
  // 정류장별 GPS 매핑용 — boardings에 등장한 routeId의 stops를 lazy 로드.
  const [stopsByRoute, setStopsByRoute] = useState({});

  // 선택 날짜 탑승 기록 실시간 구독
  useEffect(() => {
    if (!companyId || !date) return;
    return onSnapshot(
      query(collection(db, "companies", companyId, "boardings", date, "list"), orderBy("boardedAt", "asc")),
      snap => setBoardings(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    );
  }, [companyId, date]);

  // 협력사 메타(이름 매핑)
  useEffect(() => {
    if (!companyId) return;
    return onSnapshot(
      query(collection(db, "partnerCodes"), where("companyId", "==", companyId)),
      snap => setPartners(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    );
  }, [companyId]);
  const partnerNameOf = (code) => partners.find(p => p.code === code)?.partnerName || code;

  // 정류장 매핑용: boardings에 등장한 routeIds에 대한 stops 로드(아직 캐시 안 됐으면 가져옴).
  // routes는 변경 빈도 낮아 onSnapshot 대신 getDocs로 1회 fetch만(불필요한 리스너 절약).
  useEffect(() => {
    if (!companyId || boardings.length === 0) return;
    const routeIds = Array.from(new window.Set(boardings.map(b => b.routeId).filter(Boolean)));
    const toLoad = routeIds.filter(rid => !stopsByRoute[rid]);
    if (toLoad.length === 0) return;
    Promise.all(toLoad.map(async rid => {
      try {
        const snap = await getDocs(query(
          collection(db, "companies", companyId, "routes", rid, "stops"),
          orderBy("order", "asc")
        ));
        return [rid, snap.docs.map(d => ({ id: d.id, ...d.data() }))];
      } catch (_) {
        return [rid, []];
      }
    })).then(pairs => {
      setStopsByRoute(prev => {
        const next = { ...prev };
        pairs.forEach(([rid, stops]) => { next[rid] = stops; });
        return next;
      });
    });
  }, [companyId, boardings, stopsByRoute]);

  // 협력사 필터 + 검색 적용된 탑승 리스트
  // Phase B: 제한 admin 은 자기 allowed 협력사 탑승만(전체·미지정 선택 시에도).
  const filtered = boardings.filter(b => {
    const bp = b.partnerCode || null;
    if (!isAllAccess(allowed) && !partnerCodeAllowed(allowed, bp)) return false;
    if (partnerCode !== "전체") {
      if (partnerCode === "_unassigned") {
        if (bp != null) return false;
      } else if (bp !== partnerCode) return false;
    }
    if (search) {
      const s = search.toLowerCase();
      const hay = [b.empNo, b.name, b.routeName, b.vehicleNo, b.stopName, b.driverId].join(" ").toLowerCase();
      if (!hay.includes(s)) return false;
    }
    return true;
  });

  // 집계: 협력사·노선·차량·정류장·시간대
  const byPartner = (() => {
    const m = new window.Map();
    boardings.forEach(b => {
      // Phase B: 제한 admin 은 자기 allowed 협력사 분포만 집계.
      if (!isAllAccess(allowed) && !partnerCodeAllowed(allowed, b.partnerCode || null)) return;
      const k = b.partnerCode || "_unassigned";
      m.set(k, (m.get(k) || 0) + 1);
    });
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  })();
  const byRoute = (() => {
    const m = new window.Map();
    filtered.forEach(b => {
      const k = b.routeId || "_unknown";
      const cur = m.get(k) || { name: b.routeName || "노선 미지정", count: 0 };
      cur.count++;
      m.set(k, cur);
    });
    return [...m.values()].sort((a, b) => b.count - a.count);
  })();
  const byVehicle = (() => {
    const m = new window.Map();
    filtered.forEach(b => {
      const k = b.vehicleId || "_unknown";
      const cur = m.get(k) || { no: b.vehicleNo || "차량 미지정", count: 0 };
      cur.count++;
      m.set(k, cur);
    });
    return [...m.values()].sort((a, b) => b.count - a.count);
  })();
  const byHour = (() => {
    const buckets = Array.from({ length: 24 }, () => 0);
    filtered.forEach(b => {
      const ms = b.boardedAt?.toMillis ? b.boardedAt.toMillis() : null;
      if (ms != null) buckets[new Date(ms).getHours()]++;
    });
    return buckets;
  })();
  const peakHourCount = Math.max(...byHour, 1);

  const fmtTime = (ts) => {
    if (!ts) return "–";
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };

  return (
    <div style={S.panel}>
      <div style={S.panelHeader}>
        <span style={{ fontSize: 16, fontWeight: 700 }}>📊 탑승 통계</span>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input type="date" value={date} max={getToday()} onChange={e => { if (e.target.value) setDate(e.target.value); }}
            style={S.dateInput} />
          <PartnerFilter companyId={companyId} value={partnerCode} onChange={setPartnerCode} allowedCodes={allowed} />
        </div>
      </div>
      <div style={S.tableWrap}>
        <div style={{ padding: "16px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
          {/* 종합 카드 */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            <div style={statCard}>
              <div style={statLabel}>총 탑승</div>
              <div style={{ ...statValue, color: "var(--color-primary)" }}>{filtered.length}<span style={statUnit}>건</span></div>
              <div style={statSub}>{date}</div>
            </div>
            <div style={statCard}>
              <div style={statLabel}>고유 승객</div>
              <div style={{ ...statValue, color: "var(--color-positive)" }}>{new window.Set(filtered.map(b => b.empNo)).size}<span style={statUnit}>명</span></div>
              <div style={statSub}>중복 제외</div>
            </div>
            <div style={statCard}>
              <div style={statLabel}>운행 노선</div>
              <div style={{ ...statValue, color: "var(--color-cautionary)" }}>{byRoute.length}<span style={statUnit}>개</span></div>
              <div style={statSub}>탑승 기록 기준</div>
            </div>
            <div style={statCard}>
              <div style={statLabel}>운행 차량</div>
              <div style={{ ...statValue, color: "var(--color-violet)" }}>{byVehicle.length}<span style={statUnit}>대</span></div>
              <div style={statSub}>탑승 기록 기준</div>
            </div>
          </div>

          {/* 협력사별 분포 */}
          {byPartner.length > 0 && (
            <div style={panelBox}>
              <div style={panelHead}>🤝 협력사별 탑승 분포</div>
              <div style={{ padding: 14, display: "flex", flexWrap: "wrap", gap: 8 }}>
                {byPartner.map(([code, count]) => (
                  <div key={code} style={{
                    display: "flex", alignItems: "center", gap: 8, padding: "6px 12px",
                    background: code === "_unassigned" ? "var(--color-bg-soft)" : "var(--color-primary-soft)",
                    border: `1px solid ${code === "_unassigned" ? "var(--color-line)" : "rgba(0,102,255,.18)"}`,
                    borderRadius: 999, fontSize: 12, fontWeight: 600,
                  }}>
                    <span style={{ color: code === "_unassigned" ? "var(--color-label-mute)" : "var(--color-primary-deep)" }}>
                      {code === "_unassigned" ? "미지정" : partnerNameOf(code)}
                    </span>
                    <span style={{ fontWeight: 800, color: "var(--color-label)" }}>{count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 정류장별 GPS 매핑 집계 */}
          <div style={panelBox}>
            <div style={panelHead}>📍 정류장별 탑승 <span style={{ fontSize: 11, fontWeight: 600, color: "var(--color-label-mute)", marginLeft: 6 }}>(GPS 매핑·반경 300m)</span></div>
            {(() => {
              const { mapped, unmapped, noGps } = aggregateBoardingsByStop(filtered, stopsByRoute, 300);
              if (mapped.length === 0 && unmapped === 0 && noGps === 0) {
                return <div style={{ ...S.empty, padding: 24 }}>매핑 가능한 데이터 없음</div>;
              }
              return (
                <>
                  {mapped.length === 0 ? (
                    <div style={{ ...S.empty, padding: 24 }}>모든 탑승이 정류장 반경 밖이거나 GPS 좌표가 없습니다</div>
                  ) : (
                    <table style={S.table}>
                      <thead>
                        <tr>{["노선", "정류장", "탑승", "근접 거리"].map(h => (
                          <th key={h} style={S.th}>{h}</th>
                        ))}</tr>
                      </thead>
                      <tbody>
                        {mapped.map((m, i) => (
                          <tr key={i} style={S.tr}>
                            <td style={{ ...S.td, color: "var(--color-label-mute)" }}>{m.routeName}</td>
                            <td style={{ ...S.td, fontWeight: 700 }}>{m.stopName}</td>
                            <td style={{ ...S.td, textAlign: "right", fontWeight: 800, color: "var(--color-primary)" }}>{m.count}건</td>
                            <td style={{ ...S.td, fontSize: 11, color: "var(--color-label-mute)", textAlign: "right", fontFamily: "var(--font-mono)" }}>
                              {m.minDist != null ? `${Math.round(m.minDist)}m` : "–"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {(unmapped > 0 || noGps > 0) && (
                    <div style={{ padding: "8px 16px", fontSize: 11, color: "var(--color-label-alt)", borderTop: "1px solid var(--color-line-soft)", background: "var(--color-bg-soft)" }}>
                      ⓘ {noGps > 0 && <span>GPS 좌표 없음 {noGps}건</span>}
                      {noGps > 0 && unmapped > 0 && <span> · </span>}
                      {unmapped > 0 && <span>임계 초과(300m 이상) {unmapped}건</span>}
                      {noGps > 0 && <span style={{ marginLeft: 8 }}> · 기존 데이터(2026-05-26 이전)는 GPS 좌표 미포함</span>}
                    </div>
                  )}
                </>
              );
            })()}
          </div>

          {/* 노선별 / 차량별 2단 */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
            <div style={panelBox}>
              <div style={panelHead}>🛣 노선별 탑승</div>
              {byRoute.length === 0 ? <div style={{ ...S.empty, padding: 24 }}>데이터 없음</div> : (
                <table style={S.table}>
                  <tbody>
                    {byRoute.map((r, i) => (
                      <tr key={i} style={S.tr}>
                        <td style={{ ...S.td, fontWeight: 600 }}>{r.name}</td>
                        <td style={{ ...S.td, textAlign: "right", fontWeight: 800, color: "var(--color-primary)" }}>{r.count}건</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div style={panelBox}>
              <div style={panelHead}>🚌 차량별 탑승</div>
              {byVehicle.length === 0 ? <div style={{ ...S.empty, padding: 24 }}>데이터 없음</div> : (
                <table style={S.table}>
                  <tbody>
                    {byVehicle.map((v, i) => (
                      <tr key={i} style={S.tr}>
                        <td style={{ ...S.td, fontWeight: 600, fontFamily: "var(--font-mono)" }}>{v.no}</td>
                        <td style={{ ...S.td, textAlign: "right", fontWeight: 800, color: "var(--color-primary)" }}>{v.count}건</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* 시간대별 분포 */}
          <div style={panelBox}>
            <div style={panelHead}>⏰ 시간대별 탑승 분포</div>
            <div style={{ padding: "14px 16px", display: "flex", alignItems: "flex-end", gap: 4, height: 120 }}>
              {byHour.map((c, h) => (
                <div key={h} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                  <div style={{ fontSize: 10, color: "var(--color-label-mute)", fontWeight: 600, opacity: c > 0 ? 1 : 0.4 }}>{c || ""}</div>
                  <div style={{
                    width: "100%", height: `${(c / peakHourCount) * 80}px`,
                    background: c > 0 ? "var(--color-primary)" : "var(--color-bg-soft)",
                    borderRadius: "3px 3px 0 0", minHeight: 2,
                  }} />
                  <div style={{ fontSize: 10, color: "var(--color-label-alt)", fontWeight: 600 }}>{h}</div>
                </div>
              ))}
            </div>
          </div>

          {/* 상세 리스트 */}
          <div style={panelBox}>
            <div style={{ ...panelHead, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span>📋 상세 탑승 기록 · {filtered.length}건</span>
              <input style={{ ...S.input, width: 220, padding: "6px 10px", fontSize: 12 }}
                placeholder="🔍 사번·이름·노선·정류장 검색" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            {filtered.length === 0 ? (
              <div style={{ ...S.empty, padding: 32 }}>탑승 기록이 없습니다</div>
            ) : (
              <div style={{ maxHeight: 480, overflowY: "auto" }}>
                <table style={S.table}>
                  <thead>
                    <tr>
                      {["시각", "사번", "이름", "협력사", "노선", "차량", "정류장"].map(h => (
                        <th key={h} style={{ ...S.th, position: "sticky", top: 0 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(b => (
                      <tr key={b.id} style={S.tr}>
                        <td style={{ ...S.td, fontFamily: "var(--font-mono)", fontSize: 12 }}>{fmtTime(b.boardedAt)}</td>
                        <td style={{ ...S.td, fontFamily: "var(--font-mono)", fontSize: 12 }}>{b.empNo}</td>
                        <td style={{ ...S.td, fontWeight: 700 }}>{b.name || "–"}</td>
                        <td style={{ ...S.td, color: "var(--color-label-mute)" }}>
                          {b.partnerCode ? partnerNameOf(b.partnerCode) : <span style={{ color: "var(--color-label-alt)" }}>미지정</span>}
                        </td>
                        <td style={{ ...S.td }}>{b.routeName || "–"}</td>
                        <td style={{ ...S.td, fontFamily: "var(--font-mono)", fontSize: 12 }}>{b.vehicleNo || "–"}</td>
                        <td style={{ ...S.td, fontSize: 12 }}>{b.stopName || "–"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// BoardingStatsTab 전용 보조 스타일
const statCard = { background: "var(--color-bg)", border: "1px solid var(--color-line)", borderRadius: 12, padding: "14px 16px", boxShadow: "0 1px 2px rgba(0,0,0,.03)" };
const statLabel = { fontSize: 11, fontWeight: 700, color: "var(--color-label-mute)", textTransform: "uppercase", letterSpacing: 0.04 };
const statValue = { fontSize: 28, fontWeight: 800, marginTop: 4, fontFamily: "var(--font-brand)", letterSpacing: "-0.02em" };
const statUnit = { fontSize: 13, fontWeight: 600, color: "var(--color-label-mute)", marginLeft: 4 };
const statSub = { fontSize: 11, color: "var(--color-label-alt)", marginTop: 2 };
const panelBox = { background: "var(--color-bg)", border: "1px solid var(--color-line)", borderRadius: 12, overflow: "hidden", boxShadow: "0 1px 2px rgba(0,0,0,.03)" };
const panelHead = { padding: "12px 16px", fontWeight: 700, fontSize: 13, color: "var(--color-label)", borderBottom: "1px solid var(--color-bg-soft)", background: "var(--color-bg-alt)" };

// ═══════════════════════════════════════════════════════
// 탭10: 협력사 관리
// ═══════════════════════════════════════════════════════
function PartnerTab({ companyId, allowed, currentUserUid }) {
  const [codes, setCodes] = useState([]);
  const [routes, setRoutes] = useState([]);
  const [showForm, setShowForm] = useState(false);
  // 발급 모달 — 신규 발급 시 boardingMode 도 함께 결정 (2026-05-27 역방향 QR)
  const [form, setForm] = useState({ partnerName: "", memo: "", boardingMode: "driver-qr" });
  const [loading, setLoading] = useState(false);
  const [copiedCode, setCopiedCode] = useState(null);
  const [passengers, setPassengers] = useState([]);
  const [selectedCode, setSelectedCode] = useState(null);
  // 모드 편집 모달 — 기존 협력사의 boardingMode 변경 (2026-05-27)
  const [modeEditTarget, setModeEditTarget] = useState(null); // partnerCodes doc | null
  const [modeEditValue, setModeEditValue] = useState("driver-qr");
  const [modeEditLoading, setModeEditLoading] = useState(false);
  // 포탈 설정 모달 — 관제(운행 현황) 노출 + 브랜딩(컬러·로고) (2026-07-16 회의 #3·#5)
  const [portalEditTarget, setPortalEditTarget] = useState(null); // partnerCodes doc | null
  const [pOps, setPOps] = useState(true);
  const [pSeat, setPSeat] = useState(SEAT_MODES.OFF);   // 좌석예약 모드(2026-07-30)
  // 문의 게시판(2026-08-06 미팅) — 승객앱 하단 '문의' 탭 + dycs 거래처 매핑.
  const [pInqOn, setPInqOn] = useState(false);
  const [pInqTenant, setPInqTenant] = useState("");
  const [pInqToken, setPInqToken] = useState("");
  // 2026-08-25 미팅 — 홈페이지 연결 + 태깅 소리 강제
  const [pHomeOn, setPHomeOn] = useState(false);
  const [pHomeUrl, setPHomeUrl] = useState("");
  const [pSoundForced, setPSoundForced] = useState(false);
  // 2026-08-27 거래처 테마 — "" = 프리셋 미사용(아래 메인 컬러 경로가 그대로 돈다)
  const [pTheme, setPTheme] = useState("");
  const [pColor, setPColor] = useState("");        // "" = 기본 테마
  const [pLogo, setPLogo] = useState(null);         // data URI | null
  const [pLogoHeight, setPLogoHeight] = useState(28);
  const [pLoading, setPLoading] = useState(false);

  useEffect(() => {
    if (!companyId) return;
    return onSnapshot(
      query(collection(db, "partnerCodes"), where("companyId", "==", companyId)),
      snap => setCodes(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    );
  }, [companyId]);

  useEffect(() => {
    if (!companyId) return;
    return onSnapshot(collection(db, "companies", companyId, "routes"), snap => {
      setRoutes(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });
  }, [companyId]);

  useEffect(() => {
    if (!selectedCode || !companyId) return;
    return onSnapshot(
      query(collection(db, "companies", companyId, "passengers"), where("partnerCode", "==", selectedCode)),
      snap => setPassengers(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    );
  }, [selectedCode, companyId]);

  const handleCreate = async () => {
    if (!form.partnerName.trim()) return alert("업체명을 입력해주세요");
    setLoading(true);
    try {
      const { createPartnerCode: create } = await import("../lib/partner");
      const code = await create({ companyId, partnerName: form.partnerName.trim(), memo: form.memo.trim(), createdBy: currentUserUid || null });
      // boardingMode 'passenger-qr' 인 경우만 추가 setDoc merge (기본값=null=driver-qr 동치, 노이즈 회피).
      if (form.boardingMode === "passenger-qr") {
        await updateDoc(doc(db, "partnerCodes", code), { boardingMode: "passenger-qr" });
      }
      setShowForm(false);
      setForm({ partnerName: "", memo: "", boardingMode: "driver-qr" });
      alert(`업체코드 발급 완료:\n${code}\n\n협력사에 전달해주세요.`);
    } catch (e) { alert("오류: " + e.message); }
    setLoading(false);
  };

  // 모드 편집 모달 열기 (2026-05-27)
  const openModeEdit = (code) => {
    setModeEditTarget(code);
    setModeEditValue(code.boardingMode === "passenger-qr" ? "passenger-qr" : "driver-qr");
  };

  // 모드 저장 — partnerCodes.{code}.boardingMode update
  const handleModeSave = async () => {
    if (!modeEditTarget) return;
    setModeEditLoading(true);
    try {
      await updateDoc(doc(db, "partnerCodes", modeEditTarget.id), {
        boardingMode: modeEditValue,
      });
      setModeEditTarget(null);
      alert(`'${modeEditTarget.partnerName}' 협력사의 탑승 QR 방향이 변경되었습니다.\n\n해당 협력사 승객들은 다음 로그인부터 새 모드가 적용됩니다.`);
    } catch (e) {
      alert("오류: " + (e?.message || String(e)));
    }
    setModeEditLoading(false);
  };

  // 포탈 설정 모달 열기/저장 (2026-07-16 회의 #3·#5)
  const openPortalEdit = (code) => {
    setPortalEditTarget(code);
    setPOps(code.opsControlEnabled !== false); // 부재=true(현행 유지)
    setPSeat(seatReservationMode(code));       // 부재·모르는 값=off(신규 기능이라 회귀 0)
    // 프리셋은 **아는 이름일 때만** 폼에 싣는다 — 모르는 값이면 앱도 기본으로 떨어지므로
    // 화면과 실제 동작을 맞춰야 한다(모르는 값을 그대로 보여주면 "켜져 있다"고 오해한다).
    const th = (code.theme && typeof code.theme === "object") ? code.theme : {};
    setPTheme(THEME_PRESETS[th.preset] ? th.preset : "");
    const b = code.branding || {};
    setPColor(isValidHexColor(b.primaryColor) ? b.primaryColor : "");
    setPLogo(b.logo || null);
    setPLogoHeight(Number(b.logoHeight) >= 20 && Number(b.logoHeight) <= 56 ? Number(b.logoHeight) : 28);
    // 문의 설정은 **원문 그대로** 폼에 싣는다(정규화한 값만 보여주면 잘못 입력된 tenantId 를
    // 관리자가 볼 수 없어 고칠 수가 없다). 유효성은 저장 시 판정.
    const inq = (code.inquiry && typeof code.inquiry === "object") ? code.inquiry : {};
    setPInqOn(inq.enabled === true);
    setPInqTenant(typeof inq.tenantId === "string" ? inq.tenantId : "");
    setPInqToken(typeof inq.token === "string" ? inq.token : "");
    // 문의와 같은 이유로 **원문 그대로** 싣는다(정규화한 값만 보이면 잘못 넣은 주소를 못 고친다).
    const hp = (code.homepage && typeof code.homepage === "object") ? code.homepage : {};
    setPHomeOn(hp.enabled === true);
    setPHomeUrl(typeof hp.url === "string" ? hp.url : "");
    setPSoundForced(resolveTagSoundConfig(code).forced);
  };

  // 로고 파일 — 투명 PNG 보존 위해 재압축 없이 data URI 로 그대로 저장(200KB 제한·Firestore 1MB doc 여유).
  const handleLogoFile = (file) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return alert("PNG/JPG/WebP 이미지만 가능합니다");
    if (file.size > 200 * 1024) return alert("로고는 200KB 이하 파일만 가능합니다\n(이미지 크기를 줄여 다시 시도하세요)");
    const reader = new FileReader();
    reader.onload = () => setPLogo(String(reader.result));
    reader.readAsDataURL(file);
  };

  const handlePortalSave = async () => {
    if (!portalEditTarget) return;
    if (pColor && !isValidHexColor(pColor)) return alert("메인 컬러는 #RRGGBB 형식으로 입력하세요 (예: #D80027)");
    // 정원 없는 노선이 있으면 예약을 켤 수 없다(켜면 예약 무제한이 조용히 성립한다).
    if (pSeat !== SEAT_MODES.OFF) {
      const chk = canEnableSeatReservation(routes, portalEditTarget.id);
      if (!chk.ok) return alert(chk.total === 0
        ? "이 협력사에 지정된 노선이 없어 좌석예약을 켤 수 없습니다."
        : `좌석수가 없는 노선이 있어 좌석예약을 켤 수 없습니다.

${chk.missing.slice(0,8).join(", ")}

노선 관리에서 좌석수를 입력한 뒤 다시 시도하세요.`);
    }
    // 🔴 거래처 ID 없이 문의를 켜면 승객에게 빈 위젯이 열린다 — 저장 단계에서 막는다.
    const inqTenant = pInqTenant.trim();
    if (pInqOn && !isValidTenantId(inqTenant)) {
      return alert("문의 게시판을 켜려면 dycs 거래처 ID를 입력해야 합니다.\n\n영문·숫자·- _ 만 사용합니다 (예: snu, hanwha).\ndycs 상담원 콘솔 → 설정 → 거래처 관리에서 확인하세요.");
    }
    // 🔴 주소 없이 홈페이지를 켜면 승객에게 죽은 버튼이 열린다 — 저장 단계에서 막는다.
    const homeUrl = pHomeUrl.trim();
    if (pHomeOn && !isValidHomepageUrl(homeUrl)) {
      return alert("홈페이지 탭을 켜려면 주소를 입력해야 합니다.\n\nhttp:// 또는 https:// 로 시작하는 전체 주소를 넣으세요.");
    }
    // 홈페이지 탭은 문의 탭 자리를 **대체**한다(2026-08-25 way 결정). 문의 유입이 끊기므로 확인받는다.
    if (pHomeOn && pInqOn && !window.confirm(
      "홈페이지 탭은 '문의' 탭을 대체합니다.\n\n이 거래처 승객은 앱에서 문의를 접수할 수 없게 되고,\n고객CS시스템(dycs)으로 들어오던 문의가 끊깁니다.\n\n그대로 저장할까요?"
    )) return;
    setPLoading(true);
    try {
      await updateDoc(doc(db, "partnerCodes", portalEditTarget.id), {
        opsControlEnabled: pOps,
        seatReservation: pSeat,
        inquiry: {
          enabled: pInqOn,
          tenantId: inqTenant || null,
          token: pInqToken.trim() || null,
        },
        homepage: {
          enabled: pHomeOn,
          url: homeUrl || null,
        },
        tagSound: {
          forced: pSoundForced,
        },
        // 🔴 프리셋을 끄는 것은 필드 삭제가 아니라 **빈 객체**다 — `resolveTheme` 이 null 을
        //    돌려주면 앱은 아래 `branding.primaryColor` 경로로 내려간다(그 색이 그대로 살아난다).
        //    필드를 지우면 되돌릴 흔적이 없다(`set_partner_app_options.cjs --theme-off` 와 같은 규칙).
        theme: pTheme ? { preset: pTheme } : {},
        // 🔴 프리셋을 써도 `branding` 은 **지우지 않는다** — 프리셋을 껐을 때 예전 색으로
        //    정확히 돌아가야 하고, 로고는 프리셋과 무관하게 계속 쓰인다.
        branding: {
          primaryColor: pColor || null,
          logo: pLogo || null,
          logoHeight: pLogoHeight,
        },
      });
      setPortalEditTarget(null);
      alert(`'${portalEditTarget.partnerName}' 포탈 설정이 저장되었습니다.\n\n협력사 포탈은 즉시, 승객 앱은 다음 접속부터 반영됩니다.`);
    } catch (e) {
      alert("오류: " + (e?.message || String(e)));
    }
    setPLoading(false);
  };

  const handleDeactivate = async (code) => {
    if (!window.confirm(`${code.partnerName} 업체코드를 비활성화하시겠습니까?`)) return;
    await updateDoc(doc(db, "partnerCodes", code.id), { active: false });
  };

  const handleActivate = async (code) => {
    if (!window.confirm(`${code.partnerName} 업체코드를 다시 활성화하시겠습니까?`)) return;
    await updateDoc(doc(db, "partnerCodes", code.id), { active: true });
  };

  const handleDelete = async (code) => {
    if (code.active) {
      alert("활성 상태의 협력사는 삭제할 수 없습니다.\n먼저 '비활성화' 후 다시 시도해주세요.");
      return;
    }
    try {
      const snap = await getDocs(
        query(collection(db, "companies", companyId, "passengers"), where("partnerCode", "==", code.code))
      );
      const total = snap.size;
      const activeCount = snap.docs.filter(d => d.data().active).length;
      const warn = total > 0
        ? `\n\n⚠ 이 협력사 소속 승객 ${total}명(재직 ${activeCount}명)이 등록되어 있습니다.\n협력사 삭제 시 승객 데이터는 남지만 협력사 연결이 끊깁니다.`
        : "";
      if (!window.confirm(`${code.partnerName} (${code.code}) 협력사를 영구 삭제하시겠습니까?${warn}\n\n이 작업은 되돌릴 수 없습니다.`)) return;
      await deleteDoc(doc(db, "partnerCodes", code.id));
      if (selectedCode === code.id) setSelectedCode(null);
      alert(`${code.partnerName} 협력사가 삭제되었습니다.`);
    } catch (e) {
      alert("삭제 중 오류: " + e.message);
    }
  };

  const copyCode = (code) => {
    navigator.clipboard.writeText(code);
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  const copyUrl = () => {
    const url = `${window.location.origin}/partner`;
    navigator.clipboard.writeText(url);
    alert("협력사 포털 URL이 복사되었습니다:\n" + url);
  };

  // Phase B(2026-06-08): 제한 admin 은 자기 allowed 협력사만 목록 표시.
  // 2026-06-15: 본인이 발급한 협력사(createdBy===uid)는 권한 부여 전에도 항상 열람·관리 가능
  //   — users self-update 가 rules 상 superadmin 전용이라 자동 권한추가가 안 되던 한계 우회.
  //   클라 게이팅 모델 일관(Phase B 와 동일·rules 무변경). createdBy 부재 레거시 코드는 종전대로 allowed 로만.
  const visibleCodes = isAllAccess(allowed)
    ? codes
    : codes.filter(c => allowed.includes(c.code || c.id) || (currentUserUid && c.createdBy === currentUserUid));

  const formatDate = (ts) => {
    if (!ts) return "–";
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleDateString("ko-KR", { year: "numeric", month: "short", day: "numeric" });
  };

  return (
    <div style={{ ...S.panel, position: "relative" }}>
      <div style={S.panelHeader}>
        <span style={{ fontSize: 16, fontWeight: 700 }}>🤝 협력사 관리</span>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={S.editBtn} onClick={copyUrl}>🔗 포털 URL 복사</button>
          <button style={S.addBtn} onClick={() => setShowForm(true)}>+ 업체코드 발급</button>
        </div>
      </div>

      <div style={{ display: "flex", height: "100%", minHeight: 0, overflow: "hidden" }}>
        {/* 업체코드 목록 */}
        <div style={{ flex: 1, overflowY: "auto", padding: "0 24px 24px" }}>
          <table style={S.table}>
            <thead>
              <tr>
                {["업체명", "업체코드", "상태", "유효기간", "업로드", "마지막 업로드", "관리"].map(h => (
                  <th key={h} style={S.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleCodes.length === 0 ? (
                <tr><td colSpan={7} style={{ ...S.td, textAlign: "center", color: "var(--color-label-alt)" }}>{codes.length === 0 ? "발급된 업체코드가 없습니다" : "담당 협력사가 없습니다 (슈퍼관리자/팀장이 권한 부여 필요)"}</td></tr>
              ) : [...visibleCodes].sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0)).map(c => (
                <tr key={c.id} style={{ ...S.tr, background: selectedCode === c.id ? "var(--color-primary-soft)" : "var(--color-bg)" }}
                  onClick={() => setSelectedCode(selectedCode === c.id ? null : c.id)}>
                  <td style={{ ...S.td, fontWeight: 600 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span>{c.partnerName}</span>
                      {/* boardingMode 배지 — passenger-qr 만 표시(driver-qr=기본·노이즈 회피). 2026-05-27 */}
                      {c.boardingMode === "passenger-qr" && (
                        <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 999, background: "#FFF1E0", color: "#B95300", border: "1px solid #FFE0C2", fontWeight: 700 }}>
                          승객발행 QR
                        </span>
                      )}
                      {/* 문의 게시판 배지 — 켠 거래처만(부재=꺼짐=기본이라 노이즈 회피). 2026-08-06 */}
                      {resolveInquiryConfig(c).enabled && (
                        <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 999, background: "#E9F0FF", color: "#1B4FD6", border: "1px solid #C9DAFF", fontWeight: 700 }}>
                          💬 문의 {resolveInquiryConfig(c).tenantId}
                        </span>
                      )}
                      {/* 홈페이지 연결 배지 — 켠 거래처만. 이게 켜져 있으면 문의 탭은 없다(대체). 2026-08-25 */}
                      {resolveHomepageConfig(c).enabled && (
                        <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 999, background: "#FFF3DC", color: "#8A5200", border: "1px solid #FFDFA8", fontWeight: 700 }}>
                          🌐 홈페이지
                        </span>
                      )}
                    </div>
                  </td>
                  <td style={{ ...S.td }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <code style={{ fontSize: 11, color: "var(--color-primary)", background: "var(--color-bg-alt)", padding: "2px 8px", borderRadius: 4 }}>
                        {c.code}
                      </code>
                      <button onClick={(e) => { e.stopPropagation(); copyCode(c.code); }}
                        style={{ ...S.editBtn, padding: "2px 8px", fontSize: 11 }}>
                        {copiedCode === c.code ? "✓" : "복사"}
                      </button>
                    </div>
                  </td>
                  <td style={S.td}>
                    <span style={{ ...S.statusBadge, background: c.active ? "#E6F7EB" : "#FCE5E5", color: c.active ? "#007A29" : "#A81818" }}>
                      ● {c.active ? "활성" : "비활성"}
                    </span>
                  </td>
                  <td style={{ ...S.td, fontSize: 12, color: "var(--color-label-mute)" }}>{formatDate(c.expiresAt)}</td>
                  <td style={{ ...S.td, color: "var(--color-primary)", fontWeight: 600 }}>{c.uploadCount || 0}회</td>
                  <td style={{ ...S.td, fontSize: 12, color: "var(--color-label-mute)" }}>{formatDate(c.lastUploadAt)}</td>
                  <td style={S.td} onClick={e => e.stopPropagation()}>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <button style={{ ...S.editBtn, padding: "4px 10px", fontSize: 11 }} onClick={() => openModeEdit(c)}>
                        QR 방향
                      </button>
                      <button style={{ ...S.editBtn, padding: "4px 10px", fontSize: 11 }} onClick={() => openPortalEdit(c)}>
                        ⚙️ 포탈 설정
                      </button>
                      {c.active ? (
                        <button style={S.delBtn} onClick={() => handleDeactivate(c)}>비활성화</button>
                      ) : (
                        <>
                          <button style={S.actBtn} onClick={() => handleActivate(c)}>활성화</button>
                          <button style={S.delBtn} onClick={() => handleDelete(c)}>삭제</button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* 선택된 업체 직원 목록 */}
          {selectedCode && (
            <div style={{ marginTop: 20, background: "var(--color-bg-alt)", borderRadius: 12, overflow: "hidden" }}>
              <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--color-line)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontWeight: 700, color: "var(--color-primary)" }}>
                  {codes.find(c => c.id === selectedCode)?.partnerName} 승객 목록
                </span>
                <div style={{ display: "flex", gap: 10 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--color-positive)" }}>재직 {passengers.filter(p => p.active).length}명</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--color-cautionary)" }}>퇴사 {passengers.filter(p => !p.active).length}명</span>
                </div>
              </div>
              <div style={{ maxHeight: 300, overflowY: "auto" }}>
                <table style={S.table}>
                  <thead>
                    <tr>{["사번", "이름", "부서", "노선", "상태"].map(h => <th key={h} style={S.th}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {passengers.length === 0
                      ? <tr><td colSpan={5} style={{ ...S.td, textAlign: "center", color: "var(--color-label-alt)" }}>등록된 승객이 없습니다</td></tr>
                      : passengers.map(p => (
                        <tr key={p.id} style={S.tr}>
                          <td style={{ ...S.td, fontFamily: "monospace", fontSize: 12 }}>{p.empNo}</td>
                          <td style={{ ...S.td, fontWeight: 600 }}>{p.name}</td>
                          <td style={{ ...S.td, color: "var(--color-label-mute)", fontSize: 12 }}>{p.dept || "–"}</td>
                          <td style={{ ...S.td, color: "var(--color-label-mute)", fontSize: 12 }}>{p.routeCode || "–"}</td>
                          <td style={S.td}>
                            <span style={{ ...S.statusBadge, background: p.active ? "#E6F7EB" : "#FCE5E5", color: p.active ? "#007A29" : "#A81818" }}>
                              {p.active ? "재직" : "퇴사"}
                            </span>
                          </td>
                        </tr>
                      ))
                    }
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      {showForm && (
        <div style={S.overlay}><div style={S.modal}>
          <div style={S.modalTitle}>🤝 업체코드 발급</div>
          <label style={S.label}>업체명 *</label>
          <input style={S.input} placeholder="예) 삼성전자, 현대자동차" value={form.partnerName}
            onChange={e => setForm({ ...form, partnerName: e.target.value })} />
          <label style={S.label}>메모 (선택)</label>
          <input style={S.input} placeholder="예) 삼성 천안캠퍼스 노선 전용"
            value={form.memo} onChange={e => setForm({ ...form, memo: e.target.value })} />
          {/* 탑승 QR 방향 — 사내 보안상 직원 폰 카메라 권한이 없는 협력사용. 2026-05-27 */}
          <label style={S.label}>탑승 QR 방향</label>
          <select style={S.input} value={form.boardingMode}
            onChange={e => setForm({ ...form, boardingMode: e.target.value })}>
            <option value="driver-qr">기사 발행 → 승객 스캔 (기본)</option>
            <option value="passenger-qr">승객 발행 → 기사 스캔 (승객 카메라 없을 때)</option>
          </select>
          <div style={{ background: "#FFF1E0", border: "1px solid #FFE0C2", borderRadius: 8, padding: "10px 14px", fontSize: 12, fontWeight: 500, color: "#B95300" }}>
            ⓘ 유효기간 1년 · 발급 후 협력사 담당자에게 코드를 전달하세요
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button style={{ ...S.addBtn, flex: 1, opacity: loading ? 0.6 : 1 }} onClick={handleCreate} disabled={loading}>
              {loading ? "발급 중..." : "발급하기"}
            </button>
            <button style={{ ...S.closeBtn, flex: 1 }} onClick={() => setShowForm(false)}>취소</button>
          </div>
        </div></div>
      )}

      {/* ── 탑승 QR 방향 편집 모달 (2026-05-27) ── */}
      {modeEditTarget && (
        <div style={S.overlay}><div style={S.modal}>
          <div style={S.modalTitle}>📷 탑승 QR 방향 변경</div>
          <div style={{ background: "var(--color-bg-alt)", borderRadius: 8, padding: "10px 14px", marginBottom: 4 }}>
            <div style={{ fontSize: 12, color: "var(--color-label-mute)", marginBottom: 4 }}>대상 협력사</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--color-label)" }}>{modeEditTarget.partnerName}</div>
            <div style={{ fontSize: 11, color: "var(--color-label-alt)", fontFamily: "monospace", marginTop: 2 }}>{modeEditTarget.code}</div>
          </div>
          <label style={S.label}>QR 방향</label>
          <select style={S.input} value={modeEditValue} onChange={e => setModeEditValue(e.target.value)}>
            <option value="driver-qr">기사 발행 → 승객 스캔 (기본)</option>
            <option value="passenger-qr">승객 발행 → 기사 스캔 (승객 카메라 없을 때)</option>
          </select>
          <div style={{ background: "#E8F1FF", border: "1px solid #C2DCFF", borderRadius: 8, padding: "10px 14px", fontSize: 12, color: "#003A99", lineHeight: 1.55 }}>
            ⓘ 변경 후, 이 협력사 소속 승객·기사는 <b>다음 로그인부터</b> 새 모드가 적용됩니다.
            노선당 한쪽 방향만 동작 — 같은 노선에서 양방향 동시 허용되지 않습니다.
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button style={{ ...S.addBtn, flex: 1, opacity: modeEditLoading ? 0.6 : 1 }} onClick={handleModeSave} disabled={modeEditLoading}>
              {modeEditLoading ? "저장 중..." : "저장"}
            </button>
            <button style={{ ...S.closeBtn, flex: 1 }} onClick={() => setModeEditTarget(null)}>취소</button>
          </div>
        </div></div>
      )}

      {/* ── 포탈 설정 모달 — 관제 노출 + 브랜딩 (2026-07-16 회의 #3·#5) ── */}
      {portalEditTarget && (
        <div style={S.overlay}><div style={{ ...S.modal, maxHeight: "88vh", overflowY: "auto" }}>
          <div style={S.modalTitle}>⚙️ 포탈 설정 — {portalEditTarget.partnerName}</div>

          <label style={S.label}>차량 운행 현황(관제) 노출</label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--color-label)", cursor: "pointer", marginBottom: 4 }}>
            <input type="checkbox" checked={pOps} onChange={e => setPOps(e.target.checked)} />
            협력사 포탈에 실시간 지도·노선도 표시
          </label>
          <div style={{ background: "#E8F1FF", border: "1px solid #C2DCFF", borderRadius: 8, padding: "8px 12px", fontSize: 11, color: "#003A99", lineHeight: 1.5 }}>
            ⓘ 끄면 이 협력사 포탈에서 실시간 버스 위치·노선도 섹션이 숨겨집니다(노선 카드·탑승 현황·공지는 유지).
          </div>

          {/* ── 좌석예약 (2026-07-30) — 고객사가 셋 중 고른다. 부재=사용 안 함 ── */}
          <label style={{ ...S.label, marginTop: 12 }}>좌석예약</label>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {[SEAT_MODES.OFF, SEAT_MODES.OPTIONAL, SEAT_MODES.REQUIRED].map(m => (
              <label key={m} style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, color: "var(--color-label)", cursor: "pointer" }}>
                <input type="radio" name="seatMode" checked={pSeat === m} onChange={() => setPSeat(m)} style={{ marginTop: 2 }} />
                <span>{SEAT_MODE_LABELS[m]}</span>
              </label>
            ))}
          </div>
          {/* 🔴 정원이 없으면 예약이 성립하지 않는다 — 켜기 전에 막고 어느 노선인지 알려준다 */}
          {pSeat !== SEAT_MODES.OFF && (() => {
            const chk = canEnableSeatReservation(routes, portalEditTarget.id);
            if (chk.ok) return (
              <div style={{ marginTop: 6, fontSize: 11, color: "#007A29" }}>
                이 협력사 노선 {chk.total}개 모두 좌석수가 설정되어 있습니다.
              </div>
            );
            return (
              <div style={{ marginTop: 6, background: "#FDECEC", border: "1px solid #F5C6C6", borderRadius: 8, padding: "8px 12px", fontSize: 11, color: "#A81818", lineHeight: 1.6 }}>
                {chk.total === 0
                  ? "이 협력사에 지정된 노선이 없어 좌석예약을 켤 수 없습니다."
                  : <>좌석수가 없는 노선이 있어 켤 수 없습니다 — <b>{chk.missing.slice(0, 5).join(", ")}</b>
                      {chk.missing.length > 5 && ` 외 ${chk.missing.length - 5}개`}
                      <br />노선 관리에서 좌석수를 입력한 뒤 다시 시도하세요.</>}
              </div>
            );
          })()}

          {/* ── 문의 게시판 (2026-08-06 미팅) — 승객앱 하단 '문의' 탭 ── */}
          <label style={{ ...S.label, marginTop: 12 }}>문의 게시판 (고객문의·분실물)</label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--color-label)", cursor: "pointer", marginBottom: 6 }}>
            <input type="checkbox" checked={pInqOn} onChange={e => setPInqOn(e.target.checked)} />
            승객 앱 하단에 '문의' 탭 표시
          </label>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
            <input style={{ ...S.input, flex: "1 1 180px", marginBottom: 0 }} placeholder="dycs 거래처 ID (예: snu)"
              value={pInqTenant} onChange={e => setPInqTenant(e.target.value.trim())} />
            <input style={{ ...S.input, flex: "1 1 180px", marginBottom: 0 }} placeholder="임베드 토큰 (선택 — 미설정 거래처는 비움)"
              value={pInqToken} onChange={e => setPInqToken(e.target.value.trim())} />
            {/* 저장 전에 실제 위젯을 열어 거래처 ID 가 맞는지 눈으로 확인하는 통로.
                (이름 자동 매칭을 안 하는 대신, 잘못 넣으면 바로 드러나게 한다.) */}
            <button style={{ ...S.editBtn, padding: "8px 12px", fontSize: 11, opacity: isValidTenantId(pInqTenant) ? 1 : 0.45 }}
              disabled={!isValidTenantId(pInqTenant)}
              onClick={() => { const u = buildInquiryPreviewUrl(pInqTenant, pInqToken); if (u) window.open(u, "_blank", "noopener"); }}>
              열어보기
            </button>
          </div>
          <div style={{ marginTop: 6, background: "#E8F1FF", border: "1px solid #C2DCFF", borderRadius: 8, padding: "8px 12px", fontSize: 11, color: "#003A99", lineHeight: 1.6 }}>
            ⓘ 켜면 승객 앱(설정 왼쪽)에 '문의' 탭이 생기고, 눌렀을 때 고객문의·분실물 접수 화면이 앱 안에서 열립니다.<br />
            거래처 ID 는 <b>고객CS시스템(dycs)의 거래처 ID</b> 입니다 — 버스링크 업체코드와 다르며, 자동으로 이어지지 않습니다.
            잘못 넣으면 다른 거래처로 문의가 접수되니 <b>열어보기</b>로 확인한 뒤 저장하세요.
          </div>

          {/* ── 홈페이지 연결 (2026-08-25 미팅) — 승객앱 하단 '홈페이지' 탭 ── */}
          <label style={{ ...S.label, marginTop: 12 }}>홈페이지 연결</label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--color-label)", cursor: "pointer", marginBottom: 6 }}>
            <input type="checkbox" checked={pHomeOn} onChange={e => setPHomeOn(e.target.checked)} />
            승객 앱 하단에 '홈페이지' 탭 표시 <b>(문의 탭 대체)</b>
          </label>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
            <input style={{ ...S.input, flex: "1 1 300px", marginBottom: 0 }} placeholder="https://... (전체 주소)"
              value={pHomeUrl} onChange={e => setPHomeUrl(e.target.value.trim())} />
            <button style={{ ...S.editBtn, padding: "8px 12px", fontSize: 11, opacity: isValidHomepageUrl(pHomeUrl) ? 1 : 0.45 }}
              disabled={!isValidHomepageUrl(pHomeUrl)}
              onClick={() => window.open(pHomeUrl.trim(), "_blank", "noopener")}>
              열어보기
            </button>
          </div>
          <div style={{ marginTop: 6, background: "#FFF6E5", border: "1px solid #FFE0A3", borderRadius: 8, padding: "8px 12px", fontSize: 11, color: "#7A4B00", lineHeight: 1.6 }}>
            ⓘ 켜면 '문의' 탭 <b>대신</b> '홈페이지' 탭이 생기고, 눌러서 여는 버튼이 나옵니다(새 창).<br />
            🔴 홈페이지는 <b>앱 안에 끼워 넣을 수 없습니다</b> — 대부분의 사이트(구글 사이트 포함)가 외부 임베드를 막습니다.<br />
            🔴 켜는 순간 이 거래처의 <b>앱 내 문의 접수가 사라집니다</b>. 문의·전화는 홈페이지에서 받으세요.
          </div>

          {/* ── QR 태깅 소리 (2026-08-25 미팅) ── */}
          <label style={{ ...S.label, marginTop: 12 }}>QR 태깅 소리</label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--color-label)", cursor: "pointer" }}>
            <input type="checkbox" checked={pSoundForced} onChange={e => setPSoundForced(e.target.checked)} />
            항상 소리 나게 (승객이 끌 수 없음)
          </label>
          <div style={{ marginTop: 6, background: "#E8F1FF", border: "1px solid #C2DCFF", borderRadius: 8, padding: "8px 12px", fontSize: 11, color: "#003A99", lineHeight: 1.6 }}>
            ⓘ 확인음은 <b>기본으로 켜져 있고</b> 승객이 설정에서 끌 수 있습니다. 이 항목을 켜면 끄지 못합니다.<br />
            ⚠ 휴대폰이 <b>무음 모드</b>이거나 미디어 볼륨이 0이면 소리는 나지 않습니다(웹이 넘을 수 없는 벽입니다). 진동은 항상 울립니다.
          </div>

          {/* ── 테마 프리셋 (2026-08-27 카카오 톤 요청) ──────────────────────
              🔴 색을 하나씩 고르게 하지 않는 이유 = 밴드·포인트·버튼 세 색이 서로 맞물려야
                 하고 한 칸만 어긋나면 오히려 조잡해 보인다. 자유 색(아래 메인 컬러)은
                 하위호환으로 남겨 두되, 프리셋을 고르면 그쪽이 이긴다. */}
          <label style={{ ...S.label, marginTop: 12 }}>테마 프리셋</label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {[{ id: "", name: "기본", desc: "아래 메인 컬러를 씁니다" },
              ...Object.keys(THEME_PRESETS).map(k => ({ id: k, name: k === "kakao" ? "카카오 톤" : k, desc: "곤색 + 노랑 포인트" }))
            ].map(opt => {
              const on = pTheme === opt.id;
              const pv = opt.id ? resolveTheme({ theme: { preset: opt.id } }) : null;
              return (
                <button key={opt.id || "default"} onClick={() => setPTheme(opt.id)}
                  style={{
                    flex: "1 1 150px", textAlign: "left", cursor: "pointer", fontFamily: "inherit",
                    border: `2px solid ${on ? "var(--color-primary)" : "var(--color-line)"}`,
                    background: on ? "var(--color-primary-soft)" : "var(--color-bg)",
                    borderRadius: 10, padding: "9px 12px",
                  }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {/* 색 견본 3개 = 밴드·포인트·버튼. 기본은 현재 primary 하나. */}
                    {(pv ? [pv.band, pv.accent, pv.primary] : ["var(--color-primary-deep)", "var(--color-primary)", "var(--color-primary)"])
                      .map((c, i) => (
                        <span key={i} style={{ width: 14, height: 14, borderRadius: 4, background: c, border: "1px solid rgba(0,0,0,.12)", flexShrink: 0 }} />
                      ))}
                    <span style={{ fontSize: 12.5, fontWeight: 800, color: "var(--color-label)" }}>{opt.name}</span>
                  </div>
                  <div style={{ fontSize: 10.5, color: "var(--color-label-mute)", marginTop: 3 }}>{opt.desc}</div>
                </button>
              );
            })}
          </div>
          {pTheme && (
            <div style={{ marginTop: 6, background: "#FFF8E1", border: "1px solid #FFE08A", borderRadius: 8, padding: "8px 12px", fontSize: 11, color: "#7A5D00", lineHeight: 1.6 }}>
              ⓘ 프리셋을 쓰는 동안 <b>아래 메인 컬러는 적용되지 않습니다</b>(값은 그대로 보관되어 프리셋을 끄면 되돌아갑니다).<br />
              로고는 프리셋과 무관하게 계속 쓰입니다.
            </div>
          )}

          <label style={{ ...S.label, marginTop: 12 }}>
            메인 컬러 (선택 — 비우면 기본 테마){pTheme && <span style={{ color: "var(--color-label-alt)", fontWeight: 500 }}> · 프리셋 사용 중이라 지금은 미적용</span>}
          </label>
          <div style={{ display: "flex", alignItems: "center", gap: 8, opacity: pTheme ? 0.5 : 1 }}>
            <input type="color" value={isValidHexColor(pColor) ? pColor : "#0066FF"}
              onChange={e => setPColor(e.target.value)}
              style={{ width: 42, height: 34, padding: 2, border: "1px solid var(--color-line)", borderRadius: 6, background: "var(--color-bg)", cursor: "pointer" }} />
            <input style={{ ...S.input, flex: 1, marginBottom: 0 }} placeholder="#0066FF" value={pColor}
              onChange={e => setPColor(e.target.value.trim())} />
            {pColor && (
              <button style={{ ...S.editBtn, padding: "6px 10px", fontSize: 11 }} onClick={() => setPColor("")}>기본으로</button>
            )}
          </div>

          <label style={{ ...S.label, marginTop: 12 }}>로고 (선택 — PNG/JPG/WebP, 200KB 이하)</label>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <input type="file" accept="image/png,image/jpeg,image/webp"
              onChange={e => { handleLogoFile(e.target.files?.[0]); e.target.value = ""; }}
              style={{ fontSize: 12 }} />
            {pLogo && (
              <button style={{ ...S.delBtn, padding: "4px 10px", fontSize: 11 }} onClick={() => setPLogo(null)}>로고 제거</button>
            )}
          </div>
          {pLogo && (
            <>
              <label style={{ ...S.label, marginTop: 10 }}>로고 크기 — {pLogoHeight}px</label>
              <input type="range" min={20} max={56} step={2} value={pLogoHeight}
                onChange={e => setPLogoHeight(Number(e.target.value))} style={{ width: "100%" }} />
            </>
          )}

          {/* 미리보기 — 승객 앱 상단 밴드 근사.
              🔴 밴드 글자색은 하드코딩하지 않고 휘도로 정한다(`readableOn`) — 승객 앱과 같은
                 규칙이어야 한다. 밝은 색을 밴드로 고른 거래처에서 흰 글씨는 안 읽힌다. */}
          <label style={{ ...S.label, marginTop: 12 }}>미리보기</label>
          {(() => {
            const pv = pTheme ? resolveTheme({ theme: { preset: pTheme } }) : null;
            const bandBg = pv ? pv.band
              : (isValidHexColor(pColor) ? mixHex(pColor, "#000000", 0.25) : "#003DCC");
            const bandFg = readableOn(bandBg);
            const chipBg = pv ? pv.accentSoft
              : (isValidHexColor(pColor) ? mixHex(pColor, "#ffffff", 0.9) : "var(--color-primary-soft)");
            const btnBg = pv ? pv.primary : (isValidHexColor(pColor) ? pColor : "var(--color-primary)");
            return (
              // 🔴 `flexShrink:0` 필수 — `S.modal` 은 `display:flex` + `maxHeight:88dvh` 다.
              //    flex 항목의 자동 최소높이(`min-height:auto`)는 **`overflow` 가 visible 이 아니면
              //    0 이 된다**(스펙). 밴드 모서리를 둥글리려고 넣은 `overflow:hidden` 때문에
              //    모달이 넘치는 순간 이 상자만 높이 2px(테두리)로 눌려 미리보기가 통째로 사라졌다.
              <div style={{ border: "1px solid var(--color-line)", borderRadius: 10, overflow: "hidden", background: "#fff", flexShrink: 0 }}>
                <div style={{ background: bandBg, padding: "10px 14px" }}>
                  {pLogo && (
                    <span style={{ display: "inline-block", background: "#fff", borderRadius: 999, padding: "3px 8px", marginBottom: 6 }}>
                      <img src={pLogo} alt="" style={{ height: Math.min(pLogoHeight, 24), maxWidth: 120, objectFit: "contain", display: "block" }} />
                    </span>
                  )}
                  <div style={{ fontSize: 11, color: bandFg, opacity: 0.75 }}>홍길동 · 운영팀</div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: bandFg, marginTop: 2 }}>[기흥] 출근</div>
                </div>
                <div style={{ padding: "10px 14px", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ padding: "4px 11px", borderRadius: 999, fontSize: 11, fontWeight: 700, background: chipBg, color: "var(--color-primary-deep)" }}>
                    출근
                  </span>
                  <span style={{ padding: "6px 14px", borderRadius: 9, fontSize: 11.5, fontWeight: 800, background: btnBg, color: "#fff" }}>
                    QR 탑승하기
                  </span>
                </div>
              </div>
            );
          })()}

          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button style={{ ...S.addBtn, flex: 1, opacity: pLoading ? 0.6 : 1 }} onClick={handlePortalSave} disabled={pLoading}>
              {pLoading ? "저장 중..." : "저장"}
            </button>
            <button style={{ ...S.closeBtn, flex: 1 }} onClick={() => setPortalEditTarget(null)}>취소</button>
          </div>
        </div></div>
      )}
    </div>
  );
}


// ═══════════════════════════════════════════════════════
// 탭9: 공지 발송
// ═══════════════════════════════════════════════════════
function NoticeTab({ companyId, allowed }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [type, setType] = useState("normal"); // normal | emergency
  const [partnerCode, setPartnerCode] = useState("전체"); // 협력사 선택 ("전체" | partnerCode)
  const [loading, setLoading] = useState(false);
  const [notices, setNotices] = useState([]);
  const [partners, setPartners] = useState([]); // 진단/배지용 partnerName 매핑
  const [tokens, setTokens] = useState([]); // 전체 fcmTokens (회사 내)
  const [result, setResult] = useState(null);
  const [activeQueueId, setActiveQueueId] = useState(null); // 발송 직후 fcmQueue 결과 구독
  const [queueDoc, setQueueDoc] = useState(null);
  // 진단 패널 silent-fail 방지: onSnapshot 권한 거부/네트워크 오류 등을 가시화.
  // notices·partnerCodes·fcmTokens 3개 구독 오류 모두 같은 state에 누적(나중 발생 오류로 덮어쓰기).
  const [snapshotError, setSnapshotError] = useState(null);
  // 발송 이력 정리(2026-07-31 배시현 개선요청) — 목록 검색·상태 필터·더보기·삭제 확인.
  const [histQuery, setHistQuery] = useState("");
  const [histFilter, setHistFilter] = useState("표시중"); // 표시중 | 숨김 | 전체
  const [histLimit, setHistLimit] = useState(10);
  const [confirmDelete, setConfirmDelete] = useState(null); // 영구삭제 2단 확인 대상 id

  // 발송 이력 구독
  useEffect(() => {
    if (!companyId) return;
    return onSnapshot(
      query(
        collection(db, "companies", companyId, "notices"),
        orderBy("createdAt", "desc")
      ),
      snap => setNotices(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      err => {
        console.warn("[NoticeTab] notices 구독 오류:", err.message);
        setSnapshotError({ src: "notices", msg: err.message });
      }
    );
  }, [companyId]);

  // 협력사 목록 구독(배지용)
  useEffect(() => {
    if (!companyId) return;
    return onSnapshot(
      query(collection(db, "partnerCodes"), where("companyId", "==", companyId)),
      snap => setPartners(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      err => {
        console.warn("[NoticeTab] partnerCodes 구독 오류:", err.message);
        setSnapshotError({ src: "partnerCodes", msg: err.message });
      }
    );
  }, [companyId]);

  // fcmTokens 전체 구독(진단·대상자 수 표시)
  useEffect(() => {
    if (!companyId) return;
    return onSnapshot(
      collection(db, "companies", companyId, "fcmTokens"),
      snap => setTokens(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      err => {
        console.warn("[NoticeTab] fcmTokens 구독 오류:", err.message);
        setSnapshotError({ src: "fcmTokens", msg: err.message });
      }
    );
  }, [companyId]);

  // 발송 후 fcmQueue 결과 실시간 구독
  useEffect(() => {
    if (!activeQueueId) { setQueueDoc(null); return; }
    return onSnapshot(
      doc(db, "fcmQueue", activeQueueId),
      snap => setQueueDoc(snap.exists() ? { id: snap.id, ...snap.data() } : null),
      err => console.warn("[NoticeTab] queue 구독 오류:", err.message)
    );
  }, [activeQueueId]);

  // Phase B: 제한 admin 은 자기 allowed 협력사로만 발송 가능.
  // "전체"(=CF 가 회사 전체로 해석)는 제한 admin 에겐 차단 — 특정 협력사 선택 강제.
  const noticeRestricted = !isAllAccess(allowed);

  // 대상자 수 계산
  // 협력사 선택 시: where partnerCode == X
  // 전체 선택 시(무제한 admin): 모든 토큰(partnerCode null/누락 포함 — CF 와 일관)
  const targetCount = partnerCode === "전체"
    ? (noticeRestricted
        ? tokens.filter(t => partnerCodeAllowed(allowed, t.partnerCode || null)).length
        : tokens.length)
    : tokens.filter(t => t.partnerCode === partnerCode).length;

  // 협력사별 토큰 분포(진단)
  // ⚠ 카카오 SDK `Map` 컴포넌트 import(파일 상단)가 native `Map` 클래스를 shadow함.
  //    `new Map()` → minified `new ee()`(ee=forwardRef 객체, 비-생성자) → TypeError
  //    → NoticeTab render throw → ErrorBoundary 격리(진단 패널 사망).
  //    `window.Map` 으로 native 클래스 명시 참조 — 카카오 import 시그니처 보존.
  //    (globalThis는 CRA ESLint env에서 no-undef → 빌드 차단. window가 호환성·검증 안전.)
  const tokensByPartner = (() => {
    const map = new window.Map();
    let nullCount = 0;
    for (const t of tokens) {
      const c = t.partnerCode || null;
      // Phase B: 제한 admin 은 자기 allowed 협력사 분포만(미지정 토큰도 비노출).
      if (noticeRestricted && !partnerCodeAllowed(allowed, c)) continue;
      if (c === null) nullCount++;
      else map.set(c, (map.get(c) || 0) + 1);
    }
    return { map, nullCount };
  })();

  // partnerCode → partnerName 매핑
  const partnerNameOf = (code) => partners.find(p => (p.code || p.id) === code)?.partnerName || code;

  const handleSend = async () => {
    if (!title.trim() || !body.trim()) return alert("제목과 내용을 입력해주세요");
    // Phase B: 제한 admin 이 "전체"(회사 전체) 발송 시도 차단 — 특정 협력사 선택 강제.
    // (sendNotice 는 단일 partnerCode 만 지원 → CF 변경 없이 권한 누수 차단.)
    if (noticeRestricted && partnerCode === "전체")
      return alert("담당 협력사를 선택해 발송해주세요.\n회사 전체 발송 권한이 없습니다.");
    if (targetCount === 0 && !window.confirm("발송할 토큰이 0건입니다. 그래도 발송하시겠습니까?\n(공지는 기록되지만 푸시는 전송되지 않습니다)")) return;
    setLoading(true); setResult(null); setActiveQueueId(null); setQueueDoc(null);
    try {
      const { queueId } = await sendNotice({
        companyId, title, body, type,
        partnerCode: partnerCode === "전체" ? null : partnerCode,
      });
      setActiveQueueId(queueId); // 실시간 결과 구독 시작
      setResult({ ok: true, msg: "공지가 발송되었습니다 — 발송 결과는 아래 카드에 실시간 표시됩니다" });
      setTitle(""); setBody("");
    } catch (e) {
      setResult({ ok: false, msg: "발송 실패: " + e.message });
    }
    setLoading(false);
  };

  const handleDeactivate = async (id) => {
    await updateDoc(doc(db, "companies", companyId, "notices", id), { active: false });
  };

  // 숨긴 공지를 다시 앱에 노출. "숨기기 = 되돌릴 수 있다" 를 실제로 성립시키는 짝
  // (되돌리기가 없으면 숨기기는 사실상 삭제이고, 잘못 숨긴 공지를 복구할 방법이 없다).
  const handleReactivate = async (id) => {
    await updateDoc(doc(db, "companies", companyId, "notices", id), { active: true });
  };

  // 영구 삭제 — 문서 자체를 지운다(되돌릴 수 없음). 2단 확인을 거친 뒤에만 호출.
  // rules 는 이미 `allow delete: if isAdmin(companyId)` 라 백엔드 변경 없음.
  const handleDelete = async (id) => {
    await deleteDoc(doc(db, "companies", companyId, "notices", id));
    setConfirmDelete(null);
  };

  const fmt = (ts) => {
    if (!ts) return "–";
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleString("ko-KR", { month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" });
  };

  // 발송 결과 카드(queueDoc 상태별)
  const renderQueueResult = () => {
    if (!queueDoc) return null;
    const s = queueDoc.status;
    if (s === "pending") {
      return (
        <div style={{ background:"#FFF7E0", border:"1px solid #F6E0A0", borderRadius:8, padding:"10px 14px", fontSize:13, color:"#8A6500", fontWeight:600 }}>
          ⏳ 발송 처리 중...
        </div>
      );
    }
    if (s === "sent") {
      const ok = queueDoc.successCount ?? 0;
      const fail = queueDoc.failureCount ?? 0;
      const tot = queueDoc.totalTokens ?? (ok + fail);
      return (
        <div style={{ background:"#E6F7EB", border:"1px solid #A7E2BB", borderRadius:8, padding:"10px 14px", fontSize:13, color:"#007A29", fontWeight:600 }}>
          ✅ 발송 완료 — 총 {tot}건 중 성공 {ok}건 / 실패 {fail}건
          {fail > 0 && (
            <div style={{ fontSize:11, color:"#A86500", marginTop:4, fontWeight:500, lineHeight:1.55 }}>
              ※ 실패 토큰은 자동 정리됩니다(만료/무효 토큰).<br/>
              📌 해당 승객이 EmployeeApp(<code>/p</code>) 재로그인 + 설정 → 🔔 알림 진단 → 재발급 필요
            </div>
          )}
        </div>
      );
    }
    if (s === "no_tokens") {
      return (
        <div style={{ background:"#FFF7E0", border:"1px solid #F6E0A0", borderRadius:8, padding:"10px 14px", fontSize:13, color:"#8A6500", fontWeight:600 }}>
          ⚠ 발송 대상 토큰이 없습니다 — 승객이 EmployeeApp 에서 알림 권한을 허용해야 합니다
          <div style={{ fontSize:11, color:"#8A6500", marginTop:6, fontWeight:500, lineHeight:1.55 }}>
            📌 원인: 해당 협력사 승객이 EmployeeApp(<code>/p</code>) → <b>설정</b> 탭 → <b>🔔 알림 진단</b>에서<br/>
            권한 허용 + 토큰 재발급 필요(이전 토큰이 만료되어 자동 삭제되었을 수 있음)
          </div>
        </div>
      );
    }
    if (s === "error") {
      return (
        <div style={{ background:"#FCE5E5", border:"1px solid #F6C9C9", borderRadius:8, padding:"10px 14px", fontSize:13, color:"#A81818", fontWeight:600 }}>
          ❌ 발송 오류: {queueDoc.error || "알 수 없는 오류"}
        </div>
      );
    }
    return null;
  };

  return (
    <div style={S.panel}>
      <div style={S.panelHeader}>
        <span style={{ fontSize:16, fontWeight:700 }}>📢 공지 발송</span>
        <span style={{ fontSize:12, color:"var(--color-label-mute)" }}>인앱 배너 + FCM 푸시 (협력사 단위)</span>
      </div>

      <div style={{ padding:"16px 20px", display:"flex", flexDirection:"column", gap:12, overflowY:"auto" }}>
        {/* ── 진단 패널 silent-fail 경보 ─────────────── */}
        {/* onSnapshot error 콜백이 잡은 권한/네트워크 오류 가시화 — 향후 진짜 silent fail 즉시 진단 */}
        {snapshotError && (
          <div style={{ background:"#FCE5E5", border:"1px solid #F6C9C9", borderRadius:8, padding:"10px 14px", fontSize:13, color:"#A81818", fontWeight:600 }}>
            ⚠ {snapshotError.src} 구독 실패: {snapshotError.msg}
            <div style={{ fontSize:11, color:"#A81818", marginTop:4, fontWeight:500 }}>
              Firestore 권한·네트워크 확인 필요. 진단 패널이 실제 데이터를 못 읽는 상태입니다.
            </div>
          </div>
        )}

        {/* ── 진단 패널 — 알림 수신 가능 분포 ─────────────── */}
        <div style={{ background:"var(--color-bg)", border:"1px solid var(--color-line)", borderRadius:10, padding:"12px 14px", boxShadow:"var(--shadow-emphasize)" }}>
          <div style={{ fontSize:12, fontWeight:700, color:"var(--color-label-mute)", marginBottom:8 }}>📊 알림 수신 가능 승객 분포 (fcmTokens)</div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:8, alignItems:"center" }}>
            <span style={{ background:"var(--color-primary-soft)", color:"var(--color-primary-deep)", borderRadius:8, padding:"4px 10px", fontSize:12, fontWeight:700 }}>
              전체 {tokens.length}건
            </span>
            {partners.filter(p => p.active !== false).map(p => {
              const code = p.code || p.id;
              const n = tokensByPartner.map.get(code) || 0;
              const danger = n === 0;
              return (
                <span key={p.id} style={{ background: danger ? "#FCE5E5" : "var(--color-bg-soft)", color: danger ? "#A81818" : "var(--color-label-mute)", border: `1px solid ${danger ? "#F6C9C9" : "var(--color-line)"}`, borderRadius:8, padding:"4px 10px", fontSize:11, fontWeight:600 }}>
                  {danger && "● "}{p.partnerName}: {n}건{danger && " (수신자 없음)"}
                </span>
              );
            })}
            {tokensByPartner.nullCount > 0 && (
              <span style={{ background:"var(--color-bg-soft)", color:"var(--color-label-alt)", border:"1px solid var(--color-line)", borderRadius:8, padding:"4px 10px", fontSize:11, fontWeight:600 }}>
                협력사 미지정: {tokensByPartner.nullCount}건
              </span>
            )}
          </div>
          {tokens.length === 0 && (
            <div style={{ marginTop:8, fontSize:11, color:"#A86500", lineHeight:1.55 }}>
              ※ 등록된 FCM 토큰이 0건입니다. 승객이 EmployeeApp 에서 알림 권한을 허용해야 합니다.<br/>
              📌 토큰이 invalid 상태였다면 발송 시 자동 삭제되어 0건이 됩니다 — 승객 본인이<br/>
              <code>/p</code> → <b>설정</b> → <b>🔔 알림 진단</b> → <b>재발급</b> 버튼으로 갱신 가능
            </div>
          )}
        </div>

        {/* 공지 유형 */}
        <div style={{ display:"flex", gap:8 }}>
          {[["normal","📋 일반 공지","var(--color-primary-soft)","var(--color-primary-deep)","var(--color-primary)"],["emergency","🚨 긴급 공지","#FCE5E5","#A81818","var(--color-destructive)"]].map(([v,label,softBg,deepFg,line])=>(
            <button key={v} onClick={()=>setType(v)}
              style={{ flex:1, padding:"10px", borderRadius:10, cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:700,
                background: type===v ? softBg : "var(--color-bg-soft)",
                color: type===v ? deepFg : "var(--color-label-mute)",
                border: type===v ? `1px solid ${line}` : "1px solid var(--color-line)" }}>
              {label}
            </button>
          ))}
        </div>

        {/* 긴급 안내 */}
        {type === "emergency" && (
          <div style={{ background:"#FCE5E5", border:"1px solid #F6C9C9", borderRadius:8, padding:"10px 14px", fontSize:12, fontWeight:500, color:"#A81818" }}>
            🚨 긴급 공지는 홈 화면 최상단에 빨간 배너로 표시되며, FCM 푸시 알림이 즉시 발송됩니다
          </div>
        )}

        {/* 협력사 선택 */}
        <div>
          <label style={S.label}>발송 대상 협력사</label>
          <PartnerFilter
            companyId={companyId}
            value={partnerCode}
            onChange={setPartnerCode}
            allLabel="전체 협력사 (회사 전체)"
            compact={false}
            allowedCodes={allowed}
          />
          <div style={{ marginTop:6, fontSize:12, color: targetCount === 0 ? "#A81818" : "var(--color-primary-deep)", fontWeight:600 }}>
            📡 이 발송으로 알림을 받을 승객: <span style={{ fontSize:14, fontWeight:800 }}>{targetCount}명</span>
            {partnerCode !== "전체" && <span style={{ color:"var(--color-label-mute)", fontWeight:500 }}> ({partnerNameOf(partnerCode)})</span>}
          </div>
          {targetCount === 0 && (
            <div style={{ marginTop:6, background:"#FFF7E0", border:"1px solid #F6E0A0", borderRadius:8, padding:"8px 12px", fontSize:11, color:"#8A6500", fontWeight:600 }}>
              ⚠ 발송할 토큰이 없습니다 — 해당 협력사 승객이 EmployeeApp 에서 알림 권한을 허용해야 합니다
            </div>
          )}
        </div>

        {/* 제목 */}
        <div>
          <label style={S.label}>제목 *</label>
          <input style={S.input} placeholder="예) 오늘 통근버스 15분 지연 안내"
            value={title} onChange={e=>setTitle(e.target.value)} />
        </div>

        {/* 내용 */}
        <div>
          <label style={S.label}>내용 *</label>
          <textarea style={{ ...S.input, height:100, resize:"vertical", lineHeight:1.6 }}
            placeholder="공지 내용을 입력하세요"
            value={body} onChange={e=>setBody(e.target.value)} />
        </div>

        {/* 결과 메시지 */}
        {result && (
          <div style={{ background: result.ok?"#E6F7EB":"#FCE5E5", border:`1px solid ${result.ok?"#A7E2BB":"#F6C9C9"}`, borderRadius:8, padding:"10px 14px", fontSize:13, fontWeight:500, color: result.ok?"#007A29":"#A81818", whiteSpace:"pre-line" }}>
            {result.msg}
          </div>
        )}

        {/* 발송 결과 카드 (fcmQueue 실시간 구독) */}
        {renderQueueResult()}

        <button style={{ ...S.addBtn, padding:"13px", fontSize:15, opacity:loading?0.6:1, width:"100%" }}
          onClick={handleSend} disabled={loading}>
          {loading ? "발송 중..." : "📢 공지 발송"}
        </button>

        {/* 발송 이력 */}
        <div style={{ marginTop:8 }}>
          {(() => {
          // Phase B: 타 협력사 공지는 계속 비노출. 단 **"전체" 발송 공지는 제한 admin 에게도 보인다**
          //   — 그 공지는 자기 거래처 승객 앱에도 뜨는데 목록에서 빠지면 "무엇이 나가 있는지"조차
          //   알 수 없다(2026-07-31 way 결정: 읽기만 허용). 손대는 건 canManage 로 따로 막는다.
          const listed = noticeRestricted
            ? notices.filter(n => !n.partnerCode || partnerCodeAllowed(allowed, n.partnerCode))
            : notices;
          // 🔴 "전체" 공지는 제한 admin 에게 읽기 전용 — 한 거래처 담당이 회사 전체 공지를 지우면
          //   다른 거래처 승객의 공지까지 사라진다.
          const canManage = (n) => !noticeRestricted || partnerCodeAllowed(allowed, n.partnerCode || null);
          // 🔴 "앱에 보이는가" 의 정의는 소비측 쿼리와 **글자 그대로 같아야** 한다 —
          //   EmployeeApp·PartnerApp 은 `where("active","==",true)` 라 필드가 아예 없는 레거시
          //   문서도 앱에선 안 보인다. `!== false` 로 느슨하게 세면 관리 화면만 "표시 중"이라
          //   말하는 유령 건수가 생긴다.
          const isShown = (n) => n.active === true;
          const q = histQuery.trim().toLowerCase();
          const matched = listed.filter(n => {
            if (histFilter === "표시중" && !isShown(n)) return false;
            if (histFilter === "숨김" && isShown(n)) return false;
            if (!q) return true;
            return `${n.title || ""} ${n.body || ""}`.toLowerCase().includes(q);
          });
          const shownCount = listed.filter(isShown).length;
          return (
          <>
          <div style={{ display:"flex", alignItems:"baseline", gap:8, marginBottom:8, flexWrap:"wrap" }}>
            <div style={{ fontSize:13, fontWeight:700 }}>발송 이력</div>
            <div style={{ fontSize:11, color:"var(--color-label-alt)" }}>
              전체 {listed.length}건 · 앱에 표시 중 {shownCount}건
            </div>
          </div>
          <input value={histQuery} onChange={e=>{ setHistQuery(e.target.value); setHistLimit(10); }}
            placeholder="제목·내용 검색"
            style={{ ...S.input, marginBottom:8 }} />
          <div style={{ display:"flex", gap:6, marginBottom:10, flexWrap:"wrap" }}>
            {["표시중","숨김","전체"].map(f => (
              <button key={f} onClick={()=>{ setHistFilter(f); setHistLimit(10); }}
                style={{ fontSize:11, fontWeight:700, padding:"5px 12px", borderRadius:14, cursor:"pointer", fontFamily:"inherit",
                  border:`1px solid ${histFilter===f?"var(--color-primary)":"var(--color-line)"}`,
                  background: histFilter===f?"var(--color-primary-soft)":"transparent",
                  color: histFilter===f?"var(--color-primary-deep)":"var(--color-label-mute)" }}>
                {f}
              </button>
            ))}
          </div>
          {matched.length === 0 ? (
            <div style={{ color:"var(--color-label-alt)", fontSize:13, textAlign:"center", padding:"16px 0" }}>
              {listed.length === 0 ? "발송된 공지가 없습니다" : "조건에 맞는 공지가 없습니다"}
            </div>
          ) : <>{matched.slice(0, histLimit).map(n => (
            <div key={n.id} style={{ background:"var(--color-bg)", borderRadius:10, padding:"12px 14px", marginBottom:8, border:`1px solid ${n.type==="emergency"?"#F6C9C9":"var(--color-line)"}`, boxShadow:"var(--shadow-emphasize)", opacity: isShown(n)?1:0.5 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:8 }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:4, flexWrap:"wrap" }}>
                    <span style={{ fontSize:10, padding:"2px 8px", borderRadius:8, fontWeight:700,
                      background: n.type==="emergency"?"#FCE5E5":"var(--color-primary-soft)",
                      color: n.type==="emergency"?"#A81818":"var(--color-primary-deep)" }}>
                      {n.type==="emergency"?"🚨 긴급":"📋 일반"}
                    </span>
                    {n.partnerCode && (
                      <span style={{ fontSize:10, padding:"2px 8px", borderRadius:8, fontWeight:700, background:"var(--color-bg-soft)", color:"var(--color-label-mute)", border:"1px solid var(--color-line)" }}>
                        🤝 {partnerNameOf(n.partnerCode)}
                      </span>
                    )}
                    {!n.partnerCode && (
                      <span style={{ fontSize:10, padding:"2px 8px", borderRadius:8, fontWeight:600, background:"transparent", color:"var(--color-label-alt)" }}>
                        전체
                      </span>
                    )}
                    {!isShown(n) && <span style={{ fontSize:10, color:"var(--color-label-alt)" }}>숨김</span>}
                    <span style={{ fontSize:11, color:"var(--color-label-alt)", marginLeft:"auto" }}>{fmt(n.createdAt)}</span>
                  </div>
                  <div style={{ fontSize:13, fontWeight:700, marginBottom:2, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{n.title}</div>
                  <div style={{ fontSize:12, color:"var(--color-label-mute)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{n.body}</div>
                </div>
                <div style={{ display:"flex", flexDirection:"column", gap:4, flexShrink:0, alignItems:"flex-end" }}>
                  {!canManage(n) ? (
                    <span style={{ fontSize:10, color:"var(--color-label-alt)", whiteSpace:"nowrap" }}>회사 전체 공지</span>
                  ) : confirmDelete === n.id ? (
                    <>
                      <button onClick={()=>handleDelete(n.id)}
                        style={{ background:"var(--color-destructive)", border:"none", borderRadius:6, padding:"4px 8px", color:"#fff", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"inherit", whiteSpace:"nowrap" }}>
                        정말 삭제
                      </button>
                      <button onClick={()=>setConfirmDelete(null)}
                        style={{ background:"transparent", border:"1px solid var(--color-line)", borderRadius:6, padding:"4px 8px", color:"var(--color-label-mute)", fontSize:11, cursor:"pointer", fontFamily:"inherit", whiteSpace:"nowrap" }}>
                        취소
                      </button>
                    </>
                  ) : (
                    <>
                      {isShown(n) ? (
                        <button onClick={()=>handleDeactivate(n.id)}
                          style={{ background:"transparent", border:"1px solid var(--color-line)", borderRadius:6, padding:"4px 8px", color:"var(--color-label-mute)", fontSize:11, cursor:"pointer", fontFamily:"inherit", whiteSpace:"nowrap" }}>
                          숨기기
                        </button>
                      ) : (
                        <button onClick={()=>handleReactivate(n.id)}
                          style={{ background:"transparent", border:"1px solid var(--color-primary)", borderRadius:6, padding:"4px 8px", color:"var(--color-primary-deep)", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"inherit", whiteSpace:"nowrap" }}>
                          되돌리기
                        </button>
                      )}
                      <button onClick={()=>setConfirmDelete(n.id)}
                        style={{ background:"transparent", border:"1px solid var(--color-line)", borderRadius:6, padding:"4px 8px", color:"var(--color-destructive)", fontSize:11, cursor:"pointer", fontFamily:"inherit", whiteSpace:"nowrap" }}>
                        삭제
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
          {matched.length > histLimit && (
            <button onClick={()=>setHistLimit(l => l + 20)}
              style={{ width:"100%", background:"transparent", border:"1px solid var(--color-line)", borderRadius:8, padding:"9px", color:"var(--color-label-mute)", fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:"inherit" }}>
              더 보기 (남은 {matched.length - histLimit}건)
            </button>
          )}
          </>}
          </>
          );
          })()}
        </div>
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════
// 스타일
// ═══════════════════════════════════════════════════════
// 리디자인 4단계 — 공유 S 객체를 tokens.css 변수 기반 라이트로 일괄 전환.
// 키 이름·구조 100% 보존(전 9탭+전역 셸 동시 전파). MS(MapTab)와 동일 토큰 체계로 정합.
// 다크 하드코딩(#0B1A2E/#112240/#1E3A5F/#00C2FF 등) 전면 제거.
// ═══════════════════════════════════════════════════════
// 탭12: 개선 요청 게시판 (2026-07-13)
// 회사 admin=자기 회사 요청 등록/열람, superadmin=전 회사 답변·상태변경.
// improvement_requests onSnapshot 실시간 구독 + 구글챗 알림(CF)·인앱 안읽음(클라).
// ═══════════════════════════════════════════════════════
function improveToneStyle(tone) {
  switch (tone) {
    case "info": return { background: "var(--color-primary-soft)", color: "var(--color-primary-deep)" };
    case "warning": return { background: "#FFF3E0", color: "#B26A00" };
    case "positive": return { background: "#E6F7EB", color: "#007A29" };
    case "destructive": return { background: "#FCE5E5", color: "var(--color-destructive)" };
    default: return { background: "var(--color-bg-soft)", color: "var(--color-label-mute)" };
  }
}
function improveFmtTs(ts) {
  if (!ts) return "";
  let d;
  if (ts.toDate) d = ts.toDate();
  else if (ts.seconds) d = new Date(ts.seconds * 1000);
  else d = new Date(ts);
  if (!d || isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Seoul" }).format(d);
}
function ImproveStatusBadge({ status }) {
  const label = IMPROVEMENT_STATUS_LABELS[status] || status;
  const tone = IMPROVEMENT_STATUS_TONE[status] || "neutral";
  return <span style={{ ...S.statusBadge, ...improveToneStyle(tone) }}>{label}</span>;
}

function ImprovementTab({ companyId, user, role, companies, deepLinkId, onDeepLinkConsumed }) {
  const isSuperAdmin = role === "superadmin";
  const myUid = user?.uid;
  const [list, setList] = useState([]);
  const [listLoaded, setListLoaded] = useState(false);   // 첫 스냅샷 도착 여부(딥링크 판정용)
  const [deepLinkMiss, setDeepLinkMiss] = useState(false);
  const deepLinkDoneRef = useRef(false);
  const [statusFilter, setStatusFilter] = useState("all");
  const [mineOnly, setMineOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [seenMap, setSeenMap] = useState(() => loadSeenMap());
  const [detailId, setDetailId] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0); // 새로고침 버튼 → 재연결·재구독 (MapTab #2 패턴 미러)
  const [refreshing, setRefreshing] = useState(false);

  // 새로고침(2026-07-16) — 오프라인 전이·장시간 대기 후 onSnapshot 리스너가 stale 해져
  // 새 요청/댓글이 안 보일 때 수동 재연결·재구독. 목록 state 는 유지(silent 재조회).
  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    await forceReconnect();
    setRefreshTick(t => t + 1);
    setTimeout(() => setRefreshing(false), 600);
  };

  // 실시간 구독. superadmin=전 회사(orderBy만), admin=자기 회사(where+orderBy).
  useEffect(() => {
    if (!companyId && !isSuperAdmin) return;
    const unsub = onSnapshot(
      improvementQuery({ companyId, isSuperAdmin }),
      snap => { setList(snap.docs.map(d => ({ id: d.id, ...d.data() }))); setListLoaded(true); },
      err => { console.warn("[개선요청] 구독 오류:", err.message); setListLoaded(true); }
    );
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, isSuperAdmin, refreshTick]);

  // 구글챗 알림 딥링크 소비(1회) — 목록 첫 스냅샷 도착 후 해당 요청 상세 자동 오픈.
  // 목록에 없으면(타 회사 요청·삭제됨) 안내 배너만. 소비 후 주소창 ?imp= 제거.
  useEffect(() => {
    if (!deepLinkId || deepLinkDoneRef.current || !listLoaded) return;
    deepLinkDoneRef.current = true;
    const found = list.find(r => r.id === deepLinkId);
    if (found) {
      setDetailId(found.id);
      setSeenMap(prev => markSeen(found.id, prev));
    } else {
      setDeepLinkMiss(true);
    }
    clearImproveDeepLinkParam();
    if (onDeepLinkConsumed) onDeepLinkConsumed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkId, listLoaded, list]);

  // 회사명 라벨(superadmin) — companies 목록에서 매핑.
  const companyNameById = {};
  (companies || []).forEach(c => { companyNameById[c.id] = c.name || c.id; });
  const companyLabel = (cid) => companyNameById[cid] || cid;

  // 검색 + 내 요청만 필터(상태 제외) → 상태 칩 카운트 기준.
  const base = list.filter(r => {
    if (mineOnly && r.requesterUid !== myUid) return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      const hay = `${r.title || ""} ${r.content || ""} ${r.requesterName || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const counts = { all: base.length };
  IMPROVEMENT_STATUSES.forEach(s => { counts[s] = base.filter(r => r.status === s).length; });
  const filtered = statusFilter === "all" ? base : base.filter(r => r.status === statusFilter);

  const detail = detailId ? list.find(r => r.id === detailId) : null;
  const openDetail = (r) => { setDetailId(r.id); setSeenMap(markSeen(r.id, seenMap)); };

  const chip = (key, label, n) => (
    <button key={key} onClick={() => setStatusFilter(key)}
      style={{
        border: "1px solid var(--color-line)", borderRadius: 20, padding: "5px 12px",
        fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
        background: statusFilter === key ? "var(--color-primary)" : "var(--color-bg)",
        color: statusFilter === key ? "#fff" : "var(--color-label-mute)",
      }}>
      {label} {n}
    </button>
  );

  return (
    <div style={S.panel}>
      <div style={S.panelHeader}>
        <div style={{ fontSize: 15, fontWeight: 800, color: "var(--color-label)" }}>개선 요청</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* 새로고침(2026-07-16) — stale 리스너 수동 재연결·재구독 (MapTab #2 버튼 미러) */}
          <button onClick={handleRefresh} disabled={refreshing}
            title="개선 요청 목록을 즉시 다시 불러옵니다"
            style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "6px 12px", borderRadius: 8, border: "1px solid var(--color-line)", background: "var(--color-bg-soft)", color: "var(--color-label-mute)", cursor: refreshing ? "default" : "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 700, opacity: refreshing ? 0.6 : 1 }}>
            <span style={{ display: "inline-block", animation: refreshing ? "blspin 0.8s linear infinite" : "none" }}>↻</span>
            {refreshing ? "새로고침 중" : "새로고침"}
          </button>
          <button style={S.addBtn} onClick={() => setCreateOpen(true)}>+ 요청 등록</button>
        </div>
      </div>

      {/* 필터 바 */}
      <div style={{ padding: "12px 20px", display: "flex", flexDirection: "column", gap: 10, borderBottom: "1px solid var(--color-line)", background: "var(--color-bg)", flexShrink: 0 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {chip("all", "전체", counts.all)}
          {IMPROVEMENT_STATUSES.map(s => chip(s, IMPROVEMENT_STATUS_LABELS[s], counts[s]))}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="제목·내용·요청자 검색"
            style={{ ...S.input, width: 220, padding: "8px 12px", fontSize: 13 }} />
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--color-label-mute)", cursor: "pointer" }}>
            <input type="checkbox" checked={mineOnly} onChange={e => setMineOnly(e.target.checked)} />
            내 요청만
          </label>
        </div>
      </div>

      {/* 목록 */}
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 20px 40px" }}>
        {deepLinkMiss && (
          <div style={{ background: "#FFF1E0", border: "1px solid #FFE0C2", borderRadius: 10, padding: "10px 14px", marginBottom: 10, fontSize: 12, fontWeight: 600, color: "#B95300" }}>
            알림에서 연 요청을 찾지 못했습니다. 다른 회사의 요청이거나 삭제된 요청일 수 있습니다.
          </div>
        )}
        {filtered.length === 0 && <div style={S.empty}>표시할 개선 요청이 없습니다.</div>}
        {filtered.map(r => {
          const unread = isUnread(r, myUid, seenMap);
          const shots = Array.isArray(r.screenshots) ? r.screenshots.length : 0;
          return (
            <div key={r.id} onClick={() => openDetail(r)}
              style={{ background: "var(--color-bg)", border: "1px solid var(--color-line)", borderRadius: 12, padding: "12px 14px", marginBottom: 8, cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: "var(--color-label)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title || "(제목 없음)"}</span>
                  {unread && <span style={{ background: "var(--color-destructive)", color: "#fff", fontSize: 10, fontWeight: 700, borderRadius: 10, padding: "1px 6px" }}>NEW</span>}
                </div>
                <div style={{ fontSize: 12, color: "var(--color-label-mute)", display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <span>{r.requesterName || "-"}</span>
                  <span>· {improveFmtTs(r.createdAt)}</span>
                  {shots > 0 && <span>· 📎 {shots}</span>}
                  {isSuperAdmin && <span>· {companyLabel(r.companyId)}</span>}
                </div>
              </div>
              <ImproveStatusBadge status={r.status} />
            </div>
          );
        })}
      </div>

      {createOpen && (
        <ImprovementCreateModal
          companyId={companyId} user={user}
          onClose={() => setCreateOpen(false)}
        />
      )}
      {detail && (
        <ImprovementDetailModal
          req={detail} user={user} isSuperAdmin={isSuperAdmin}
          companyLabel={isSuperAdmin ? companyLabel(detail.companyId) : null}
          onClose={() => setDetailId(null)}
        />
      )}
    </div>
  );
}

function ImprovementCreateModal({ companyId, user, onClose }) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [shots, setShots] = useState([]);   // { dataUrl, name, bytes }
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);

  const MAX_SHOTS = 3;
  const PER_LIMIT = 300 * 1024;
  const TOTAL_LIMIT = 900 * 1024;

  // 파일 목록 → 압축·개수/용량 판정 후 첨부에 누적(파일선택·붙여넣기 공용).
  const addImageFiles = async (files) => {
    setErr("");
    // 한 번에 여러 장 처리 시 stale state 대신 로컬 누적으로 개수·총량 판정.
    const accepted = [...shots];
    let msg = "";
    for (const file of files) {
      if (accepted.length >= MAX_SHOTS) { msg = `이미지는 최대 ${MAX_SHOTS}장까지 첨부할 수 있습니다`; break; }
      try {
        const { dataUri, bytes } = await compressImageFile(file);
        if (bytes > PER_LIMIT) { msg = "이미지 1장이 너무 큽니다(300KB 초과) — 더 작은 이미지를 사용하세요"; continue; }
        const totalNow = accepted.reduce((s, x) => s + x.bytes, 0);
        if (totalNow + bytes > TOTAL_LIMIT) { msg = "첨부 이미지 총 용량이 큽니다(900KB 초과)"; continue; }
        accepted.push({ dataUrl: dataUri, name: file.name || "image", bytes });
      } catch (ex) {
        msg = ex.message || "이미지 처리 실패";
      }
    }
    setShots(accepted);
    if (msg) setErr(msg);
  };

  const onPick = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";   // 같은 파일 재선택 허용
    await addImageFiles(files);
  };

  const submit = async () => {
    setErr("");
    if (!title.trim()) { setErr("제목을 입력하세요"); return; }
    // 본문은 리치 HTML — 저장 직전 정화(재sanitize) 후 유효성·총량 판정.
    const clean = sanitizeContentHtml(content);
    if (!htmlToPlainText(clean).trim() && !contentHasImage(clean)) { setErr("내용을 입력하세요"); return; }
    // 제출 총량 캡(1MB doc 한도 - history/기타 여유). 인라인 이미지 + 별도 첨부 합산.
    const shotsBytes = shots.reduce((s, x) => s + (x.bytes || 0), 0);
    if (htmlByteSize(clean) + shotsBytes > 800 * 1024) {
      setErr("이미지가 많아 저장할 수 없습니다. 개수를 줄이거나 크기를 낮춰주세요");
      return;
    }
    setSaving(true);
    try {
      await createRequest({
        companyId,
        title: title.trim(),
        content: clean,
        requesterUid: user?.uid,
        requesterName: user?.displayName || user?.email || "관리자",
        requesterEmail: user?.email || "",
        screenshots: shots.map(s => ({ dataUrl: s.dataUrl, name: s.name })),
      });
      onClose();
    } catch (ex) {
      setErr(ex.message || "등록 실패");
      setSaving(false);
    }
  };

  return (
    <div style={S.overlay}>{/* 배경 클릭 닫힘 제거 — 작성 중 내용 소실 방지(2026-07-14 점검). 닫기는 취소 버튼으로만 */}
      <div style={S.modal} onClick={e => e.stopPropagation()}>
        <div style={S.modalTitle}>개선 요청 등록</div>
        <div style={S.label}>제목</div>
        <input style={S.input} value={title} onChange={e => setTitle(e.target.value)} maxLength={100} placeholder="개선하고 싶은 내용을 한 줄로" />
        <div style={S.label}>내용</div>
        <RichTextEditor
          value={content}
          onChange={setContent}
          onImageError={setErr}
          placeholder="자세한 설명 · 스크린샷은 본문에 Ctrl+V 로 인라인 삽입됩니다"
        />
        <div style={S.label}>이미지 첨부 (최대 3장 · 각 300KB · 본문에 Ctrl+V 붙여넣기 가능)</div>
        {shots.length > 0 && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {shots.map((s, i) => (
              <div key={i} style={{ position: "relative" }}>
                <img src={s.dataUrl} alt={s.name} style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 8, border: "1px solid var(--color-line)" }} />
                <button onClick={() => setShots(prev => prev.filter((_, j) => j !== i))}
                  style={{ position: "absolute", top: -6, right: -6, background: "var(--color-destructive)", color: "#fff", border: "none", borderRadius: "50%", width: 20, height: 20, cursor: "pointer", fontSize: 12, lineHeight: 1 }}>×</button>
              </div>
            ))}
          </div>
        )}
        {shots.length < 3 && (
          <label style={{ ...S.editBtn, display: "inline-block", padding: "8px 12px", cursor: "pointer", width: "fit-content" }}>
            + 이미지 선택
            <input type="file" accept="image/*" multiple onChange={onPick} style={{ display: "none" }} />
          </label>
        )}
        {err && <div style={{ background: "#FCE5E5", border: "1px solid #F6C9C9", color: "var(--color-destructive)", padding: "8px 12px", borderRadius: 8, fontSize: 12 }}>{err}</div>}
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button style={{ ...S.closeBtn, flex: 1 }} onClick={onClose} disabled={saving}>취소</button>
          <button style={{ ...S.addBtn, flex: 1, opacity: saving ? 0.6 : 1 }} onClick={submit} disabled={saving}>{saving ? "등록 중..." : "등록"}</button>
        </div>
      </div>
    </div>
  );
}

function ImprovementDetailModal({ req, user, isSuperAdmin, companyLabel, onClose }) {
  const [comment, setComment] = useState("");
  const [resultNote, setResultNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const myUid = user?.uid;
  const myName = user?.displayName || user?.email || "관리자";
  const hist = Array.isArray(req.history) ? req.history : [];
  const shots = Array.isArray(req.screenshots) ? req.screenshots : [];

  const doComment = async () => {
    if (!comment.trim()) return;
    setBusy(true); setErr("");
    try {
      await addRequestComment({ id: req.id, comment: comment.trim(), byUid: myUid, byName: myName });
      setComment("");
    } catch (ex) { setErr(ex.message || "댓글 등록 실패"); }
    setBusy(false);
  };

  const doStatus = async (status) => {
    setBusy(true); setErr("");
    try {
      await updateRequestStatus({ id: req.id, status, byUid: myUid, byName: myName, resultNote: status === "done" ? resultNote : undefined });
    } catch (ex) { setErr(ex.message || "상태 변경 실패"); }
    setBusy(false);
  };

  const doDelete = async () => {
    if (!window.confirm("이 개선 요청을 삭제할까요? 되돌릴 수 없습니다.")) return;
    setBusy(true); setErr("");
    try {
      await deleteRequest(req.id);
      onClose();
    } catch (ex) { setErr(ex.message || "삭제 실패"); setBusy(false); }
  };

  return (
    <div style={S.overlay}>{/* 배경 클릭 닫힘 제거 — 작성 중 댓글/메모 소실 방지(2026-07-14 점검). 닫기는 닫기 버튼으로만 */}
      <div style={{ ...S.modal, maxWidth: 560 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <div style={{ ...S.modalTitle, marginBottom: 0, flex: 1 }}>{req.title || "(제목 없음)"}</div>
          <ImproveStatusBadge status={req.status} />
        </div>
        <div style={{ fontSize: 12, color: "var(--color-label-mute)", display: "flex", gap: 8, flexWrap: "wrap" }}>
          <span>{req.requesterName || "-"}</span>
          <span>· {improveFmtTs(req.createdAt)}</span>
          {companyLabel && <span>· {companyLabel}</span>}
        </div>

        {/* 리치 HTML(인라인 이미지)이면 표시 직전 재sanitize 후 렌더, 레거시 평문은 pre-wrap 폴백 */}
        {looksLikeHtml(req.content) ? (
          <div className="imp-content"
            style={{ color: "var(--color-label)", background: "var(--color-bg-soft)", border: "1px solid var(--color-line)", borderRadius: 10, padding: "12px 14px", marginTop: 8 }}
            dangerouslySetInnerHTML={{ __html: sanitizeContentHtml(req.content) }} />
        ) : (
          <div style={{ whiteSpace: "pre-wrap", fontSize: 13, color: "var(--color-label)", background: "var(--color-bg-soft)", border: "1px solid var(--color-line)", borderRadius: 10, padding: "12px 14px", marginTop: 8 }}>
            {req.content || "(내용 없음)"}
          </div>
        )}

        {shots.length > 0 && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
            {shots.map((s, i) => (
              <a key={i} href={s.dataUrl} target="_blank" rel="noreferrer">
                <img src={s.dataUrl} alt={s.name || "attachment"} style={{ maxWidth: 120, maxHeight: 120, borderRadius: 8, border: "1px solid var(--color-line)", objectFit: "cover" }} />
              </a>
            ))}
          </div>
        )}

        {req.resultNote && (
          <div style={{ marginTop: 8, fontSize: 13, color: "#007A29", background: "#E6F7EB", border: "1px solid #B7E6C7", borderRadius: 10, padding: "10px 12px" }}>
            <b>처리 결과</b> · {req.resultNote}
          </div>
        )}

        {/* 처리 이력 타임라인 */}
        <div style={{ ...S.label, marginTop: 12 }}>처리 이력</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {hist.map((h, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12, padding: "6px 0", borderBottom: i < hist.length - 1 ? "1px solid var(--color-line-soft)" : "none" }}>
              <span style={{ color: "var(--color-label-alt)", whiteSpace: "nowrap", minWidth: 78 }}>{improveFmtTs(h.at)}</span>
              <span style={{ flex: 1, color: "var(--color-label)" }}>
                {h.statusTo && <ImproveStatusBadge status={h.statusTo} />}{" "}
                <b>{h.byName || "-"}</b>
                {h.comment ? <div style={{ color: "var(--color-label-mute)", marginTop: 2, whiteSpace: "pre-wrap" }}>{h.comment}</div> : null}
              </span>
            </div>
          ))}
        </div>

        {/* 댓글 입력(누구나) */}
        <div style={{ ...S.label, marginTop: 12 }}>댓글</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input style={{ ...S.input, flex: 1 }} value={comment} onChange={e => setComment(e.target.value)} placeholder="댓글을 남기세요" onKeyDown={e => { if (e.key === "Enter") doComment(); }} />
          <button style={S.addBtn} onClick={doComment} disabled={busy || !comment.trim()}>등록</button>
        </div>

        {/* 상태 전이(superadmin 한정) */}
        {isSuperAdmin && (
          <div style={{ marginTop: 12, borderTop: "1px solid var(--color-line)", paddingTop: 12 }}>
            <div style={S.label}>상태 변경 (개발자 전용)</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {IMPROVEMENT_STATUSES.filter(s => s !== req.status).map(s => (
                <button key={s} onClick={() => doStatus(s)} disabled={busy}
                  style={{ ...S.editBtn, ...improveToneStyle(IMPROVEMENT_STATUS_TONE[s]) }}>
                  → {IMPROVEMENT_STATUS_LABELS[s]}
                </button>
              ))}
            </div>
            {req.status !== "done" && (
              <div style={{ marginTop: 8 }}>
                <div style={S.label}>완료 처리 시 결과 메모(선택)</div>
                <input style={S.input} value={resultNote} onChange={e => setResultNote(e.target.value)} placeholder="완료(→완료) 버튼과 함께 기록됩니다" />
              </div>
            )}
          </div>
        )}

        {err && <div style={{ background: "#FCE5E5", border: "1px solid #F6C9C9", color: "var(--color-destructive)", padding: "8px 12px", borderRadius: 8, fontSize: 12, marginTop: 8 }}>{err}</div>}

        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button style={{ ...S.delBtn, padding: "8px 14px" }} onClick={doDelete} disabled={busy}>삭제</button>
          <div style={{ flex: 1 }} />
          <button style={S.closeBtn} onClick={onClose}>닫기</button>
        </div>
      </div>
    </div>
  );
}

const S = {
  wrap:{display:"flex",height:"100dvh",background:"var(--color-bg-soft)",fontFamily:"var(--font-base)",color:"var(--color-label)",position:"relative",overflow:"hidden",fontSize:13},
  sidebar:{width:236,flexShrink:0,background:"var(--color-bg)",borderRight:"1px solid var(--color-line)",display:"flex",flexDirection:"column",minHeight:0,padding:"18px 14px"},
  // 모바일 오프캔버스 드로어(2026-08-26 · YDYOPS `shared/Sidebar.tsx` 와 같은 형태).
  // 🔴 화면 밖(translateX(-100%))에 **항상 마운트된 채로** 대기한다 — 조건부 언마운트로 만들면
  //    열 때마다 transition 시작 프레임이 없어 슥 들어오지 않고 툭 튀어나온다.
  // ⚠ position:fixed 라 조상의 overflow:hidden 에 안 잘린다. 단 조상에 transform·filter·
  //   will-change 가 생기면 그게 컨테이닝 블록이 되어 이 전제가 깨진다(S.wrap 에 넣지 말 것).
  sidebarDrawer:{position:"fixed",top:0,bottom:0,left:0,width:"min(80vw,264px)",zIndex:60,background:"var(--color-bg)",borderRight:"1px solid var(--color-line)",display:"flex",flexDirection:"column",minHeight:0,padding:"18px 14px",transition:"transform .2s ease",boxShadow:"var(--shadow-strong)"},
  // 드로어 뒤 딤 — **누르면 닫힌다**. 종전 드롭다운에 이게 없어서 "메뉴가 가린다" 가 됐다.
  navBackdrop:{position:"fixed",inset:0,background:"var(--color-overlay)",zIndex:55},
  logo:{display:"flex",alignItems:"baseline",gap:8,flexShrink:0,padding:"4px 8px 16px",marginBottom:10,borderBottom:"1px solid var(--color-line)"},
  logoText:{fontSize:20,fontWeight:800,fontFamily:"var(--font-brand)",letterSpacing:"-0.03em",color:"var(--color-primary)"},
  logoSub:{fontSize:12,color:"var(--color-label-mute)"},
  sideSection:{fontSize:11,fontWeight:700,letterSpacing:"0.04em",color:"var(--color-label-alt)",flexShrink:0,padding:"6px 12px 8px"},
  // flex:1+minHeight:0 = 남는 높이를 전부 차지하고 넘치면 자기 안에서 스크롤.
  // 🔴 minHeight:0 을 빼면 flex 기본 min-content 때문에 스크롤이 안 생기고 다시 잘린다.
  nav:{display:"flex",flexDirection:"column",gap:2,flex:1,minHeight:0,overflowY:"auto",overflowX:"hidden"},
  // whiteSpace:nowrap = 메뉴 이름은 절대 줄바꿈하지 않는다(2026-08-26) — 드로어가 80vw 라
  // 좁은 기기에서 "실시간 관제" 가 두 줄, 더 좁으면 글자당 한 줄로 쌓일 수 있다.
  navItem:{display:"flex",alignItems:"center",gap:11,flexShrink:0,padding:"10px 12px",borderRadius:10,cursor:"pointer",fontSize:13,fontWeight:500,color:"var(--color-label-mute)",position:"relative",transition:"background .15s,color .15s",userSelect:"none",whiteSpace:"nowrap"},
  navActive:{background:"var(--color-primary-soft)",color:"var(--color-primary-deep)",fontWeight:700},
  navAccent:{position:"absolute",left:3,top:"50%",transform:"translateY(-50%)",width:3,height:18,borderRadius:3,background:"var(--color-primary)"},
  navIcon:{flexShrink:0,display:"flex",opacity:.92},
  sideFoot:{display:"flex",alignItems:"center",gap:7,flexShrink:0,padding:"10px 12px 8px",marginTop:8,borderTop:"1px solid var(--color-line)",fontSize:11,color:"var(--color-label-alt)"},
  logoutBtn:{display:"flex",alignItems:"center",justifyContent:"center",gap:7,width:"100%",flexShrink:0,border:"1px solid var(--color-line)",borderRadius:10,padding:"10px 12px",color:"var(--color-label-mute)",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit"},
  // 🔴 minWidth:0 이 **세로글씨의 근인**이었다(2026-08-26). flex 아이템의 기본값은
  //    min-width:auto = "내용보다 좁아지지 않는다" 라, 좁은 화면에서 이 열이 안 줄고
  //    안쪽 요소들이 대신 찌부러지면서 한글이 글자당 한 줄로 쌓였다.
  //    minHeight:0(세로 스크롤용)과 짝이다 — 가로에도 같은 함정이 있다. 빼지 말 것.
  content:{flex:1,minWidth:0,display:"flex",flexDirection:"column",minHeight:0,overflow:"hidden"},
  mapSidebar:{width:"min(280px,38vw)",minWidth:180,background:"var(--color-bg)",borderRight:"1px solid var(--color-line)",display:"flex",flexDirection:"column",overflowY:"auto"},
  // 🔴 운행 이력·시뮬레이터는 옆으로 나란히 두면 모바일에서 둘 다 못 쓴다(2026-08-26) —
  //    `minWidth:180` 이 `38vw` 를 이겨 360px 기기에서 180px 를 먹고 지도에 180px 만 남았다.
  //    모바일은 **위아래로 쌓는다**(부모 flexDirection:column). 여기선 폭 제약을 전부 풀고
  //    높이를 46% 로 묶는다 — 안 묶으면 목록이 길 때 지도가 화면 밖으로 밀린다.
  mapSidebarMobile:{width:"auto",minWidth:0,maxHeight:"46%",flexShrink:0,borderRight:"none",borderBottom:"1px solid var(--color-line)"},
  panelHeader:{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8,padding:"14px 20px",borderBottom:"1px solid var(--color-line)",background:"var(--color-bg)",flexShrink:0},
  vehicleCard:{margin:"8px 12px 0",background:"var(--color-bg-alt)",border:"1px solid var(--color-line)",borderRadius:10,padding:"12px 14px",cursor:"pointer"},
  vehicleTop:{display:"flex",alignItems:"center",gap:8,marginBottom:6},
  dot:{width:8,height:8,borderRadius:"50%",background:"var(--color-positive)",flexShrink:0},
  vehicleName:{fontSize:13,fontWeight:700,color:"var(--color-label)"},
  vehicleInfo:{fontSize:12,color:"var(--color-label-mute)",marginTop:2},
  infoBox:{position:"absolute",top:20,right:20,background:"var(--color-bg)",border:"1px solid var(--color-line)",borderRadius:12,padding:20,minWidth:220,zIndex:10,boxShadow:"var(--shadow-float)"},
  infoTitle:{fontSize:14,fontWeight:700,marginBottom:12,color:"var(--color-primary)"},
  infoRow:{fontSize:13,color:"var(--color-label-mute)",marginBottom:6},
  closeBtn:{marginTop:8,width:"100%",padding:"8px",background:"var(--color-bg-soft)",border:"1px solid var(--color-line)",borderRadius:8,color:"var(--color-label-mute)",cursor:"pointer",fontFamily:"inherit",fontSize:13},
  panel:{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",background:"var(--color-bg-soft)"},
  empty:{color:"var(--color-label-alt)",fontSize:13,textAlign:"center",padding:20},
  tableWrap:{flex:1,overflowY:"auto",overflowX:"auto",padding:"0 0 24px",WebkitOverflowScrolling:"touch"},
  table:{width:"100%",minWidth:520,borderCollapse:"collapse"},
  th:{textAlign:"left",padding:"10px 12px",fontSize:11,color:"var(--color-label-mute)",fontWeight:600,borderBottom:"1px solid var(--color-line)",whiteSpace:"nowrap",background:"var(--color-bg-alt)"},
  td:{padding:"10px 12px",fontSize:13,borderBottom:"1px solid var(--color-line-soft)",whiteSpace:"nowrap"},
  tr:{background:"var(--color-bg)"},
  timeBadge:{background:"var(--color-primary-soft)",color:"var(--color-primary-deep)",padding:"3px 10px",borderRadius:20,fontSize:13,fontWeight:700},
  statusBadge:{padding:"3px 10px",borderRadius:20,fontSize:12,fontWeight:600},
  addBtn:{background:"var(--color-primary)",border:"none",borderRadius:8,padding:"8px 14px",color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap",flexShrink:0},
  editBtn:{background:"var(--color-bg-soft)",border:"1px solid var(--color-line)",borderRadius:6,padding:"4px 9px",color:"var(--color-label-mute)",fontSize:11,fontWeight:600,cursor:"pointer",marginRight:4,fontFamily:"inherit",whiteSpace:"nowrap"},
  delBtn:{background:"#FCE5E5",border:"1px solid #F6C9C9",borderRadius:6,padding:"4px 9px",color:"var(--color-destructive)",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap"},
  actBtn:{background:"#E6F7EB",border:"1px solid #B7E6C7",borderRadius:6,padding:"4px 9px",color:"#007A29",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap"},
  dateInput:{background:"var(--color-bg)",border:"1px solid var(--color-line)",borderRadius:8,padding:"7px 12px",color:"var(--color-label)",fontSize:13,outline:"none",fontFamily:"inherit"},
  overlay:{position:"fixed",inset:0,background:"var(--color-overlay)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:100},
  modal:{background:"var(--color-bg)",border:"1px solid var(--color-line)",borderRadius:16,padding:"22px 20px",width:"calc(100% - 32px)",maxWidth:420,display:"flex",flexDirection:"column",gap:8,maxHeight:"88dvh",overflowY:"auto",margin:"0 auto",boxShadow:"var(--shadow-strong)"},
  modalTitle:{fontSize:17,fontWeight:800,fontFamily:"var(--font-brand)",letterSpacing:"-0.02em",marginBottom:8,color:"var(--color-label)"},
  label:{fontSize:12,fontWeight:600,color:"var(--color-label-mute)",marginTop:4},
  input:{background:"var(--color-bg)",border:"1px solid var(--color-line)",borderRadius:8,padding:"10px 14px",color:"var(--color-label)",fontSize:14,outline:"none",fontFamily:"inherit",width:"100%",boxSizing:"border-box"},
};

// ═══════════════════════════════════════════════════════
// 부정승차(NFC 미등록 카드) 현황 — 2026-07-22
//
// 기사앱 NFC 태깅에서 passengers 에 매칭되는 nfcUid 가 없던 건. CF boardNfc 가
// `companies/{cid}/nfcRejects/{date}/list` 에 적재한다(boardings 와 분리 — 탑승
// 통계·정류장 매핑 집계 오염 방지). 레거시 버스인3 의 "부정승차현황"에 대응.
//
// rules: read=isAdmin(companyId), write=false(CF Admin SDK 전용) → 조회만.
// ═══════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════
// 빈 차 확인(슬리핑 차일드) 현황 — 2026-08-25 미팅
//   배시현 "언제 찍었고 어디 찍었고 요런 내역 좀 제가 볼 수 있고" · way "당연히 있어야지.
//   관리자 화면에 넣어 줄게 슬리핑 차일드 현황."
//
// 🔴 관제 좌측 레일에는 **미확인 목록과 완료 '건수'** 만 있었다 — 확인된 건이 언제·어디서
//    찍혔는지는 어디서도 볼 수 없었다. 데이터(`dispatch.sleepingCheck`)는 2026-08-18 부터
//    이미 쌓이고 있었으므로 여기서는 **화면만** 만든다(스키마 변경 0).
// 🔴 대상 노선을 안 정했으면 **마지막 운행 성격 노선으로 폴백**한다 — 지정 전에 빈 화면을
//    보여주면 "기능이 없다"로 읽힌다(opt-in + 시드 0건 함정). 판정은 lib/sleepingCheck.js.
// ════════════════════════════════════════════════════════════════════════════
function SleepCheckTab({ companyId, allowed }) {
  const todayStr = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
  const [date, setDate] = useState(todayStr);
  const [routes, setRoutes] = useState([]);
  const [dispatches, setDispatches] = useState([]);
  const [stopsByRoute, setStopsByRoute] = useState({});
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  // 경과 시간(“종점 도착 뒤 12분 확인 없음”)이 멈춰 보이지 않게 1분마다 다시 그린다.
  useEffect(() => { const t = setInterval(() => setTick(n => n + 1), 60000); return () => clearInterval(t); }, []);

  useEffect(() => {
    if (!companyId) return;
    const unsub = onSnapshot(collection(db, "companies", companyId, "routes"),
      (snap) => setRoutes(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      () => setRoutes([]));
    return () => unsub();
  }, [companyId]);

  useEffect(() => {
    if (!companyId || !date) return;
    setLoading(true);
    const unsub = onSnapshot(collection(db, "companies", companyId, "dispatches", date, "list"),
      (snap) => { setDispatches(snap.docs.map(d => ({ id: d.id, ...d.data() }))); setLoading(false); },
      () => { setDispatches([]); setLoading(false); });
    return () => unsub();
  }, [companyId, date]);

  // 대상 노선(지정 → 없으면 폴백). 협력사 권한 범위도 함께 적용.
  const { routes: targetRoutes, pinned } = useMemo(() => {
    const scoped = routes.filter(r => !allowed || allowed.includes("*") || allowed.includes(r.partnerCode));
    return sleepCheckRoutes(scoped);
  }, [routes, allowed]);
  const targetIds = useMemo(() => new Set(targetRoutes.map(r => r.id)), [targetRoutes]);

  // 종점 판정에 stops 가 필요하다 — 대상 노선 것만 1회씩(노선당 getDocs 1회).
  useEffect(() => {
    if (!companyId) return;
    const ids = dispatches.map(d => d.routeId).filter(rid => rid && targetIds.has(rid) && !stopsByRoute[rid]);
    const uniq = Array.from(new Set(ids));
    if (uniq.length === 0) return;
    let alive = true;
    Promise.all(uniq.map(async rid => {
      try {
        const snap = await getDocs(query(collection(db, "companies", companyId, "routes", rid, "stops"), orderBy("order", "asc")));
        return [rid, snap.docs.map(d => ({ id: d.id, ...d.data() }))];
      } catch (_) { return [rid, []]; }
    })).then(pairs => {
      if (!alive) return;
      setStopsByRoute(prev => { const next = { ...prev }; pairs.forEach(([rid, st]) => { next[rid] = st; }); return next; });
    });
    return () => { alive = false; };
  }, [companyId, dispatches, targetIds, stopsByRoute]);

  const isToday = date === todayStr();
  // 🔴 과거 날짜를 볼 때 '지금'으로 재면 경과시간이 `종점 뒤 21시간째` 처럼 무한히 늘어난다
  //    (2026-07-20 `조기도착 수천분` 과 같은 계열 — 날짜 뷰는 그 날짜에 시계를 맞춰야 한다).
  const anchorNow = useMemo(() => isToday ? Date.now() : new Date(`${date}T23:59:59+09:00`).getTime(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [date, isToday, tick]);
  // 🔴 대상 노선 **밖에서 찍힌 확인도 반드시 보여준다**. prod 실측(2026-08-25): 그날 확인 6건이
  //    전부 **등교** 노선이었다 — 대상을 하교로만 좁히면 기사가 실제로 찍은 기록이 화면에서
  //    사라지고 "찍었는데 안 보인다"가 된다. 기록은 숨기지 않는다.
  const scoped = useMemo(
    () => dispatches.filter(d => targetIds.has(d.routeId) || sleepCheckedAt(d)),
    [dispatches, targetIds]);
  const rows = useMemo(() => sleepCheckRows(scoped, stopsByRoute, anchorNow),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scoped, stopsByRoute, anchorNow]);
  const counts = useMemo(() => {
    const c = { checked: 0, late: 0, waiting: 0, running: 0 };
    rows.forEach(r => { c[r.state] = (c[r.state] || 0) + 1; });
    return c;
  }, [rows]);

  const STATE = {
    checked: { label: "확인 완료", bg: "#E6F7EB", fg: "#007A29" },
    late:    { label: "미확인",    bg: "#FDECEC", fg: "var(--color-destructive)" },
    waiting: { label: "확인 대기", bg: "#FFF4E5", fg: "#B95300" },
    running: { label: "운행 전·중", bg: "var(--color-bg-soft)", fg: "var(--color-label-mute)" },
  };

  return (
    // 🔴 이 탭만 스크롤러가 없었다(2026-08-26 게시판 h7M7X60g). 바깥 `S.content` 가
    //    `overflow:hidden` 이라 **탭이 자기 스크롤러를 갖는 게 이 화면의 규약**인데
    //    (`S.panel` + 본문 `flex:1/overflowY:auto` — 부정승차·개선요청 탭이 그 형태),
    //    여기만 맨 `<div>` 라 화면 높이를 넘는 행은 아예 닿을 수가 없었다.
    //    대상 노선 29개 중 화면에 들어오는 13행만 보이던 게 그 때문이다.
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12, flexShrink: 0 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>🛏 빈 차 확인 현황</h2>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ ...S.input, width: "auto", padding: "8px 12px", fontSize: 13 }} />
        <button style={S.editBtn} onClick={() => setDate(todayStr())}>오늘</button>
        <span style={{ fontSize: 12, color: "var(--color-label-mute)" }}>
          확인 {counts.checked} · 미확인 {counts.late} · 대기 {counts.waiting} · 운행 전·중 {counts.running}
        </span>
      </div>

      {/* 대상 노선 안내 — 아직 안 정했으면 지금 보이는 게 추천이라는 걸 분명히 한다. */}
      <div style={{ padding: "10px 12px", marginBottom: 12, borderRadius: 8, fontSize: 12, lineHeight: 1.6, flexShrink: 0,
        background: pinned ? "var(--color-bg-soft)" : "#FFF4E5", color: pinned ? "var(--color-label-mute)" : "#8A4B00",
        border: `1px solid ${pinned ? "var(--color-line)" : "#F0C79A"}` }}>
        {pinned ? (
          <>대상 노선 <b>{targetRoutes.length}개</b>가 지정되어 있습니다. 바꾸시려면 <b>노선 관리</b>에서 노선을 열어 <b>빈 차 확인 대상</b>을 켜고 끄시면 됩니다.</>
        ) : (
          <>아직 <b>대상 노선을 정하지 않으셨습니다</b>. 지금은 마지막 운행으로 보이는 노선 <b>{targetRoutes.length}개</b>를 임시로 보여드립니다.
          <br/><b>노선 관리</b>에서 노선을 열어 <b>빈 차 확인 대상</b>을 켜시면 그 노선만 여기에 나옵니다.</>
        )}
      </div>

      {loading ? (
        <div style={{ padding: 24, textAlign: "center", color: "var(--color-label-mute)" }}>불러오는 중...</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: 24, textAlign: "center", color: "var(--color-label-alt)" }}>
          이 날짜에 대상 노선 배차가 없습니다.
        </div>
      ) : (
        // 세로도 스크롤한다 — 이 컨테이너가 이 탭의 유일한 스크롤러다.
        // ⚠ 열 머리글은 이 표에서만 sticky 로 붙인다(`S.th` 는 전 탭 공용이라 손대지 않는다).
        //   29행을 내리는 동안 "확인 시각"이 어느 열인지 사라지면 스크롤을 넣은 뜻이 없다.
        <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
          <table style={S.table}>
            <thead><tr>
              {["상태", "노선", "차량", "기사", "확인 시각", "확인 위치", "방식", "점검"].map(h => (
                // ⚠ 색은 `S.th` 그대로 둔다(다른 표와 달라 보이면 안 된다). borderCollapse:collapse 표는
                //   sticky 로 띄우면 아래 테두리가 같이 안 따라와 행이 머리글에 붙어 보인다 → inset 그림자로 그린다.
                <th key={h} style={{ ...S.th, position: "sticky", top: 0, zIndex: 1, boxShadow: "inset 0 -1px 0 var(--color-line)" }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {rows.map(({ d, state, checkedAtMs, waitedMs, audit }) => {
                const st = STATE[state] || STATE.running;
                const place = sleepCheckPlaceLabel(d);
                const via = sleepCheckViaLabel(d);
                return (
                  <tr key={d.id}>
                    <td style={S.td}>
                      <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: "var(--radius-pill)", background: st.bg, color: st.fg, whiteSpace: "nowrap" }}>
                        {st.label}
                      </span>
                      {waitedMs != null && isToday && (
                        <div style={{ fontSize: 10.5, color: "var(--color-label-mute)", marginTop: 3 }}>
                          종점 뒤 {formatWaited(waitedMs)}
                        </div>
                      )}
                    </td>
                    <td style={S.td}>
                      {d.routeName || d.routeId || "-"}
                      {!targetIds.has(d.routeId) && (
                        <span title="대상 노선은 아니지만 확인 기록이 있어 함께 보여드립니다"
                          style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 700, padding: "2px 7px", borderRadius: "var(--radius-pill)", background: "var(--color-bg-soft)", color: "var(--color-label-mute)" }}>대상 외</span>
                      )}
                    </td>
                    <td style={S.td}>{d.vehicleNo || d.vehicleId || "-"}</td>
                    <td style={S.td}>{d.driverName || "-"}</td>
                    <td style={{ ...S.td, fontVariantNumeric: "tabular-nums", fontWeight: checkedAtMs ? 700 : 400 }}>
                      {sleepCheckedAtLabel(d) || "-"}
                    </td>
                    <td style={{ ...S.td, color: place.tone === "warn" ? "var(--color-destructive)" : place.tone === "mute" ? "var(--color-label-mute)" : "var(--color-label)" }}>
                      {place.text || "-"}
                    </td>
                    <td style={S.td}>
                      {via ? (
                        <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: "var(--radius-pill)",
                          background: via === "NFC" ? "#E8F0FE" : "var(--color-bg-soft)",
                          color: via === "NFC" ? "var(--color-primary-deep)" : "var(--color-label-mute)" }}>{via}</span>
                      ) : "-"}
                    </td>
                    <td style={{ ...S.td, color: "var(--color-cautionary)", fontSize: 11 }}>
                      {audit && audit.suspicious ? sleepAuditLabel(audit.reasons) : ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: 14, fontSize: 11.5, color: "var(--color-label-mute)", lineHeight: 1.7 }}>
        🔴 <b>인쇄한 QR 은 사진으로 복제됩니다</b> — 뒷좌석까지 가지 않아도 찍힐 수 있어, 아이들이 타는 노선에는 NFC 태그를 권합니다.
        <br/>확인 위치는 주소가 아니라 <b>기준점(차량 또는 종점)에서의 거리</b>입니다. 멀리서 찍혔거나 도착 직후 즉시 찍힌 건은 <b>점검</b> 칸에 표시됩니다.
      </div>
    </div>
  );
}

function NfcRejectTab({ companyId }) {
  const todayStr = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
  const [date, setDate] = useState(todayStr);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [copiedUid, setCopiedUid] = useState(null);

  useEffect(() => {
    if (!companyId || !date) return;
    setLoading(true);
    const q = query(
      collection(db, "companies", companyId, "nfcRejects", date, "list"),
      orderBy("taggedAt", "desc")
    );
    const unsub = onSnapshot(q,
      (snap) => { setRows(snap.docs.map(d => ({ id: d.id, ...d.data() }))); setLoading(false); },
      () => { setRows([]); setLoading(false); } // 인덱스/권한 오류 시 빈 목록(화면 크래시 금지)
    );
    return () => unsub();
  }, [companyId, date]);

  // 같은 카드가 여러 번 찍힌 경우를 카드 단위로 묶어 보여준다(운영자는 "누구 카드인지
  // 모를 카드가 몇 장 돌아다니는가"를 먼저 알아야 한다 — 태깅 건수가 아니라 카드 수).
  const byUid = (() => {
    const m = new window.Map(); // ⚠ 카카오 SDK `Map` import shadow 회피(파일 관례)
    rows.forEach(r => {
      const k = r.nfcUid || "-";
      if (!m.has(k)) m.set(k, { uid: k, count: 0, routes: new Set(), vehicles: new Set(), lastAt: null });
      const e = m.get(k);
      e.count++;
      if (r.routeName) e.routes.add(r.routeName);
      if (r.vehicleNo) e.vehicles.add(r.vehicleNo);
      const ms = r.taggedAt?.toMillis ? r.taggedAt.toMillis() : null;
      if (ms && (!e.lastAt || ms > e.lastAt)) e.lastAt = ms;
    });
    return [...m.values()].sort((a, b) => b.count - a.count);
  })();

  const fmtTime = (ts) => {
    const ms = ts?.toMillis ? ts.toMillis() : (typeof ts === "number" ? ts : null);
    if (!ms) return "-";
    return new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(new Date(ms));
  };

  return (
    <div style={S.panel}>
      <div style={S.panelHeader}>
        <span style={{ fontSize: 16, fontWeight: 700 }}>부정승차 (NFC 미등록 카드)</span>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input type="date" value={date} onChange={e => { if (e.target.value) setDate(e.target.value); }} style={S.dateInput} />
        </div>
      </div>

      <div style={S.statGrid}>
        <div>
          <div style={{ fontSize: 11, color: "var(--color-label-mute)" }}>태깅 건수</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: "var(--color-destructive)" }}>{rows.length}</div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: "var(--color-label-mute)" }}>미등록 카드 수</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: "var(--color-label)" }}>{byUid.length}</div>
        </div>
      </div>

      <div style={S.tableWrap}>
        <div style={{ padding: "10px 14px 4px", fontSize: 12, fontWeight: 700, color: "var(--color-label-mute)" }}>카드별 요약</div>
        <table style={S.table}>
          <thead><tr>{["카드번호", "태깅 횟수", "노선", "차량", "마지막 태깅"].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
          <tbody>
            {loading ? <tr><td colSpan={5} style={{ ...S.td, textAlign: "center", color: "var(--color-label-alt)" }}>불러오는 중…</td></tr>
              : byUid.length === 0 ? <tr><td colSpan={5} style={{ ...S.td, textAlign: "center", color: "var(--color-label-alt)" }}>이 날짜에 미등록 카드 태깅이 없습니다</td></tr>
                : byUid.map(e => (
                  <tr key={e.uid} style={S.tr}>
                    <td style={{ ...S.td, fontFamily: "monospace", fontWeight: 700 }}>
                      {formatNfcUid(e.uid)}
                      {/* 등록으로 이어지는 고리 — 관리자가 이 번호를 협력사 포털 승객 정보에
                          붙여넣으면 다음 태깅부터 정상 처리된다(카드 UID 확보 경로). */}
                      <button style={{ ...S.editBtn, marginLeft: 8 }}
                        onClick={() => {
                          navigator.clipboard?.writeText(e.uid)
                            .then(() => setCopiedUid(e.uid))
                            .catch(() => {});
                        }}>
                        {copiedUid === e.uid ? "✓ 복사됨" : "복사"}
                      </button>
                    </td>
                    <td style={S.td}><span style={{ ...S.statusBadge, background: "#FCE5E5", color: "var(--color-destructive)" }}>{e.count}회</span></td>
                    <td style={S.td}>{[...e.routes].join(", ") || "-"}</td>
                    <td style={S.td}>{[...e.vehicles].join(", ") || "-"}</td>
                    <td style={S.td}>{fmtTime(e.lastAt)}</td>
                  </tr>
                ))}
          </tbody>
        </table>

        {rows.length > 0 && (
          <>
            <div style={{ padding: "18px 14px 4px", fontSize: 12, fontWeight: 700, color: "var(--color-label-mute)" }}>태깅 기록</div>
            <table style={S.table}>
              <thead><tr>{["시각", "카드번호", "노선", "차량"].map(h => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} style={S.tr}>
                    <td style={S.td}>{fmtTime(r.taggedAt)}</td>
                    <td style={{ ...S.td, fontFamily: "monospace" }}>{formatNfcUid(r.nfcUid)}</td>
                    <td style={S.td}>{r.routeName || "-"}</td>
                    <td style={S.td}>{r.vehicleNo || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        <div style={{ padding: "14px", fontSize: 11, color: "var(--color-label-alt)", lineHeight: 1.7 }}>
          미등록 카드는 <b>탑승 인원에 포함되지 않습니다</b>. 실제 이용자라면 협력사 포털의
          승객 정보에서 <b>NFC 카드번호</b>를 등록하면 다음 태깅부터 정상 처리됩니다.
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// SaaS Phase 1.2 (2026-05-28) — 슈퍼관리자 회사 관리 탭
// listCompanies / createCompany / toggleCompanyActive onCall 사용.
// 회사 카드 + 신규 회사 등록 모달 + 활성 토글 + 전환 버튼.
// ═══════════════════════════════════════════════════════
// ETA 자동 진단 조회 카드(슈퍼관리자 전용, 2026-05-29)
// CF fetchEtaDiagnostic 호출 → JSON 텍스트 노출 → 복사로 채팅 붙여넣어 부모 분석.
// 부모(개발자)가 prod Firestore 직접 접근(gcloud/ADC) 없이 진단 데이터를 회수하는 임시 채널.
function EtaDiagnosticCard() {
  // 기본 날짜 = 오늘(KST). en-CA = YYYY-MM-DD.
  const todayKst = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
  const [date, setDate] = useState(todayKst);
  const [runIds, setRunIds] = useState([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [pointsJson, setPointsJson] = useState("");
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [loadingPoints, setLoadingPoints] = useState(false);
  const [errMsg, setErrMsg] = useState("");
  const [copyMsg, setCopyMsg] = useState("");

  const fetchRuns = async () => {
    setErrMsg(""); setCopyMsg("");
    setLoadingRuns(true);
    setRunIds([]); setSelectedRunId(""); setPointsJson("");
    try {
      const callable = httpsCallable(functions, "fetchEtaDiagnostic");
      const res = await callable({ date });
      const ids = Array.isArray(res.data?.runIds) ? res.data.runIds : [];
      setRunIds(ids);
      if (ids.length === 0) {
        setErrMsg(`${date} 에 진단 데이터가 없습니다.`);
      }
    } catch (err) {
      setErrMsg(err.message || "조회 실패");
    } finally {
      setLoadingRuns(false);
    }
  };

  const fetchPoints = async () => {
    setErrMsg(""); setCopyMsg(""); setPointsJson("");
    if (!selectedRunId) { setErrMsg("run을 선택하세요"); return; }
    setLoadingPoints(true);
    try {
      const callable = httpsCallable(functions, "fetchEtaDiagnostic");
      const res = await callable({ date, runId: selectedRunId });
      // 전체 응답 JSON(date/runId/count/points) 을 그대로 textarea 에 노출.
      setPointsJson(JSON.stringify(res.data, null, 2));
    } catch (err) {
      setErrMsg(err.message || "조회 실패");
    } finally {
      setLoadingPoints(false);
    }
  };

  const copyAll = async () => {
    setCopyMsg("");
    if (!pointsJson) { setErrMsg("복사할 내용이 없습니다"); return; }
    try {
      await navigator.clipboard.writeText(pointsJson);
      setCopyMsg("복사 완료");
      setTimeout(() => setCopyMsg(""), 2000);
    } catch (e) {
      setErrMsg("복사 실패: " + (e?.message || e));
    }
  };

  return (
    <div style={{
      background: "var(--color-bg)",
      border: "1px solid var(--color-line)",
      borderRadius: 12,
      padding: "14px 16px",
      margin: "16px 20px 0 20px",
      display: "flex",
      flexDirection: "column",
      gap: 10,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--color-label)" }}>🔍 ETA 진단 조회</div>
          <div style={{ fontSize: 11, color: "var(--color-label-mute)", marginTop: 2 }}>
            etaDiagnostics 컬렉션에서 진단 데이터를 회수해 텍스트로 노출 → 복사해 개발자에게 전달
          </div>
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <label style={{ fontSize: 12, color: "var(--color-label-mute)", fontWeight: 600 }}>날짜</label>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
          style={{ ...S.input, width: 160, padding: "8px 12px" }} />
        <button onClick={fetchRuns} disabled={loadingRuns}
          style={{ ...S.addBtn, opacity: loadingRuns ? 0.6 : 1 }}>
          {loadingRuns ? "조회 중..." : "Runs 목록 조회"}
        </button>
      </div>

      {runIds.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <label style={{ fontSize: 12, color: "var(--color-label-mute)", fontWeight: 600 }}>Run</label>
          <select value={selectedRunId} onChange={(e) => setSelectedRunId(e.target.value)}
            style={{ ...S.input, minWidth: 280, padding: "8px 12px" }}>
            <option value="">— 선택 ({runIds.length}개) —</option>
            {runIds.map(id => <option key={id} value={id}>{id}</option>)}
          </select>
          <button onClick={fetchPoints} disabled={loadingPoints || !selectedRunId}
            style={{ ...S.addBtn, opacity: (loadingPoints || !selectedRunId) ? 0.6 : 1 }}>
            {loadingPoints ? "조회 중..." : "Points 조회"}
          </button>
        </div>
      )}

      {errMsg && (
        <div style={{ background: "#FCE5E5", border: "1px solid #F6C9C9", color: "var(--color-destructive)", padding: "8px 12px", borderRadius: 8, fontSize: 12 }}>
          {errMsg}
        </div>
      )}

      {pointsJson && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={copyAll} style={{ ...S.addBtn, background: "var(--color-positive)" }}>
              📋 전체 복사
            </button>
            {copyMsg && <span style={{ fontSize: 12, color: "var(--color-positive)", fontWeight: 600 }}>{copyMsg}</span>}
          </div>
          <textarea readOnly value={pointsJson}
            style={{
              width: "100%",
              height: 400,
              boxSizing: "border-box",
              padding: 10,
              border: "1px solid var(--color-line)",
              borderRadius: 8,
              fontFamily: "Consolas, 'Courier New', monospace",
              fontSize: 11,
              lineHeight: 1.4,
              color: "var(--color-label)",
              background: "var(--color-bg-soft)",
              whiteSpace: "pre",
              overflow: "auto",
              outline: "none",
              resize: "vertical",
            }} />
        </>
      )}
    </div>
  );
}

function SuperCompanyTab({ companies, loading, selectedCompanyId, onSelectCompany, onReload, currentUserCompanyId, currentUserUid }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState({
    companyId: "", companyName: "",
    adminEmpNo: "", adminEmail: "", adminPassword: "", adminName: "",
  });
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState("");

  // 운영 메뉴 모달(편집 / 비밀번호 초기화 / 영구 삭제) — 단일 state 로 분기.
  // 각 모달의 입력값은 모달 내부 컴포넌트 state 가 보유. 여기서는 어떤 회사 대상인지만 추적.
  // opsModal: { kind: "edit"|"reset"|"delete", company: {id,name,...} } | null
  const [opsModal, setOpsModal] = useState(null);

  const openOps = (kind, company) => setOpsModal({ kind, company });
  const closeOps = () => setOpsModal(null);

  const handleOpsDone = async () => {
    closeOps();
    await onReload();
  };

  // ── Phase A (2026-05-29) 관리자 관리 — 카드별 펼침 + lazy 로드 + 캐시 ──
  // expandedCompanyId: 펼친 회사 1건만(다중 펼침 회피 — 스크롤 컨텍스트 단순화).
  // adminsByCompany: { [companyId]: { admins: [...], partnerCodes: [...], loading, error } }
  // partnerCodes 도 같이 lazy 로드 — 권한 변경/추가 모달의 다중 체크박스용.
  const [expandedCompanyId, setExpandedCompanyId] = useState(null);
  const [adminsByCompany, setAdminsByCompany] = useState({});
  // adminModal: { kind: "add"|"editPerms"|"deleteAdmin", company, admin? } | null
  const [adminModal, setAdminModal] = useState(null);

  const loadAdminsAndPartnerCodes = useCallback(async (cid) => {
    setAdminsByCompany(prev => ({ ...prev, [cid]: { ...(prev[cid] || {}), loading: true, error: "" } }));
    try {
      const callAdmins = httpsCallable(functions, "listCompanyAdmins");
      // partnerCodes 는 클라 권한으로 직접 read 가능(rules read 공개) — onCall 신설 회피.
      const [adminsRes, codesSnap] = await Promise.all([
        callAdmins({ companyId: cid }),
        getDocs(query(collection(db, "partnerCodes"), where("companyId", "==", cid))),
      ]);
      const partnerCodes = codesSnap.docs.map(d => {
        const v = d.data() || {};
        return {
          code: d.id,
          partnerName: v.partnerName || "",
          active: v.active !== false,
        };
      });
      // 이름순 정렬.
      partnerCodes.sort((a, b) => (a.partnerName || a.code).localeCompare(b.partnerName || b.code));
      setAdminsByCompany(prev => ({
        ...prev,
        [cid]: { admins: adminsRes.data?.admins || [], partnerCodes, loading: false, error: "" },
      }));
    } catch (e) {
      setAdminsByCompany(prev => ({
        ...prev,
        [cid]: { ...(prev[cid] || {}), loading: false, error: e.message || "관리자 목록 로드 실패" },
      }));
    }
  }, []);

  const toggleExpand = async (cid) => {
    if (expandedCompanyId === cid) {
      setExpandedCompanyId(null);
      return;
    }
    setExpandedCompanyId(cid);
    // 캐시 없으면 lazy 로드. 있으면 즉시 표시(다시 펼침 시 재요청 회피).
    if (!adminsByCompany[cid]) {
      await loadAdminsAndPartnerCodes(cid);
    }
  };

  // 자기 소속 회사의 관리자 목록을 진입 시 1회 자동 펼침 + 선로드 —
  // "매번 목록 클릭해서 활성화 + 로드 대기"하던 불편 제거(2026-06-15). ref 가드로 단 1회.
  const autoExpandedRef = useRef(false);
  useEffect(() => {
    if (autoExpandedRef.current) return;
    if (!currentUserCompanyId) return;
    if (!companies.some(c => c.id === currentUserCompanyId)) return;
    autoExpandedRef.current = true;
    setExpandedCompanyId(currentUserCompanyId);
    if (!adminsByCompany[currentUserCompanyId]) {
      loadAdminsAndPartnerCodes(currentUserCompanyId);
    }
  }, [companies, currentUserCompanyId, adminsByCompany, loadAdminsAndPartnerCodes]);

  const reloadAdminsFor = async (cid) => {
    // 권한 변경/추가/삭제 후 호출 — 강제 재로드.
    await loadAdminsAndPartnerCodes(cid);
  };

  const openAdminModal = (kind, company, admin) => setAdminModal({ kind, company, admin });
  const closeAdminModal = () => setAdminModal(null);

  const handleAdminModalDone = async () => {
    const cid = adminModal?.company?.id;
    closeAdminModal();
    if (cid) await reloadAdminsFor(cid);
  };

  const reset = () => {
    setForm({ companyId: "", companyName: "", adminEmpNo: "", adminEmail: "", adminPassword: "", adminName: "" });
    setErrMsg("");
  };

  const submit = async (e) => {
    e.preventDefault();
    setErrMsg("");
    if (!/^[a-z0-9]{3,20}$/.test(form.companyId)) {
      setErrMsg("companyId는 소문자·숫자 3~20자입니다 (예: sws001)");
      return;
    }
    if (!form.companyName || !form.adminEmpNo || !form.adminEmail || !form.adminPassword || !form.adminName) {
      setErrMsg("모든 필드를 입력하세요");
      return;
    }
    if (form.adminPassword.length < 6) {
      setErrMsg("비밀번호는 최소 6자리여야 합니다");
      return;
    }
    setBusy(true);
    try {
      const callable = httpsCallable(functions, "createCompany");
      const res = await callable(form);
      alert(`회사 생성 완료\n• ${form.companyName} (${form.companyId})\n• 관리자 UID: ${res.data?.uid || "?"}\n\n관리자는 ${form.adminEmail} / 비밀번호로 / 경로에서 로그인할 수 있습니다.`);
      setModalOpen(false);
      reset();
      await onReload();
    } catch (err) {
      setErrMsg(err.message || "회사 생성 실패");
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (cid, active) => {
    if (!window.confirm(`${cid} 회사를 ${active ? "비활성" : "활성"} 처리하시겠어요?`)) return;
    try {
      const callable = httpsCallable(functions, "toggleCompanyActive");
      await callable({ companyId: cid, active: !active });
      await onReload();
    } catch (err) {
      alert(`토글 실패: ${err.message}`);
    }
  };

  return (
    <div style={S.panel}>
      <div style={S.panelHeader}>
        <div>
          <span style={{ fontSize:16, fontWeight:700, color:"var(--color-label)" }}>🌐 회사 관리 (슈퍼관리자)</span>
          <div style={{ fontSize:12, color:"var(--color-label-mute)", marginTop:2 }}>
            SaaS 멀티테넌트 — 신규 회사 온보딩 + 활성/비활성 토글
          </div>
        </div>
        <button style={S.addBtn} onClick={() => { reset(); setModalOpen(true); }}>+ 신규 회사 등록</button>
      </div>

      {/* ETA 자동 진단 조회(임시 채널) — 슈퍼관리자만 도달, 추가 가드 불필요. */}
      <EtaDiagnosticCard />

      <div style={{ padding:"16px 20px", overflowY:"auto" }}>
        {loading && <div style={{ padding:"30px 0", textAlign:"center", color:"var(--color-label-mute)" }}>회사 목록 로딩 중...</div>}
        {!loading && companies.length === 0 && (
          <div style={{ padding:"30px 0", textAlign:"center", color:"var(--color-label-mute)" }}>
            등록된 회사가 없습니다. 신규 회사를 등록하세요.
          </div>
        )}

        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(260px, 1fr))", gap:12 }}>
          {companies.map(c => {
            const isSelected = c.id === selectedCompanyId;
            return (
              <div key={c.id} style={{
                background: isSelected ? "var(--color-primary-soft)" : "var(--color-bg)",
                border: `1px solid ${isSelected ? "var(--color-primary)" : "var(--color-line)"}`,
                borderRadius: 12, padding:"14px 16px", display:"flex", flexDirection:"column", gap:8,
              }}>
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                  <div>
                    <div style={{ fontSize:15, fontWeight:700, color:"var(--color-label)" }}>{c.name || c.id}</div>
                    <div style={{ fontSize:11, color:"var(--color-label-mute)", marginTop:2 }}>{c.id}</div>
                  </div>
                  <span style={{
                    fontSize:11, fontWeight:700, padding:"3px 8px", borderRadius:20,
                    background: c.active ? "#E6F7EB" : "#FCE5E5",
                    color: c.active ? "#007A29" : "var(--color-destructive)",
                  }}>
                    {c.active ? "활성" : "비활성"}
                  </span>
                </div>
                {c.createdAt && (
                  <div style={{ fontSize:11, color:"var(--color-label-alt)" }}>
                    생성: {new Date(c.createdAt).toLocaleString("ko-KR")}
                  </div>
                )}
                <div style={{ display:"flex", gap:6, marginTop:4 }}>
                  <button
                    disabled={!c.active || isSelected}
                    onClick={() => onSelectCompany(c.id)}
                    style={{
                      flex:1, padding:"6px 0", borderRadius:6, fontSize:12, fontWeight:600, fontFamily:"inherit",
                      background: isSelected ? "var(--color-bg-alt)" : "var(--color-primary)",
                      color: isSelected ? "var(--color-label-mute)" : "#fff",
                      border:"none", cursor: (!c.active || isSelected) ? "default" : "pointer",
                      opacity: (!c.active || isSelected) ? 0.6 : 1,
                    }}
                  >
                    {isSelected ? "현재 회사" : "전환"}
                  </button>
                  <button
                    onClick={() => toggle(c.id, c.active)}
                    style={{ ...S.editBtn, marginRight:0 }}
                  >
                    {c.active ? "비활성화" : "활성화"}
                  </button>
                </div>
                {/* 운영 메뉴(편집·비번 초기화·영구 삭제) — 자기 회사는 영구 삭제만 비활성 */}
                <div style={{ display:"flex", gap:6, marginTop:2 }}>
                  <button
                    onClick={() => openOps("edit", c)}
                    style={{ ...S.editBtn, marginRight:0, flex:1, fontSize:11 }}
                    title="회사명·관리자 정보 편집"
                  >
                    ✏️ 편집
                  </button>
                  <button
                    onClick={() => openOps("reset", c)}
                    style={{ ...S.editBtn, marginRight:0, flex:1, fontSize:11 }}
                    title="관리자 비밀번호 초기화"
                  >
                    🔑 비번
                  </button>
                  <button
                    onClick={() => openOps("delete", c)}
                    disabled={c.id === currentUserCompanyId}
                    title={c.id === currentUserCompanyId ? "자기 소속 회사는 삭제할 수 없습니다" : "회사·모든 데이터 영구 삭제"}
                    style={{
                      ...S.editBtn, marginRight:0, flex:1, fontSize:11,
                      color: c.id === currentUserCompanyId ? "var(--color-label-mute)" : "var(--color-destructive)",
                      borderColor: c.id === currentUserCompanyId ? "var(--color-line)" : "var(--color-destructive)",
                      cursor: c.id === currentUserCompanyId ? "not-allowed" : "pointer",
                      opacity: c.id === currentUserCompanyId ? 0.5 : 1,
                    }}
                  >
                    🗑 삭제
                  </button>
                </div>
                {/* Phase A (2026-05-29) 관리자 목록 펼침 토글 — 같은 회사 안 여러 담당자 admin 관리. */}
                <button
                  onClick={() => toggleExpand(c.id)}
                  style={{
                    ...S.editBtn, marginRight:0, marginTop:2, fontSize:11, fontWeight:600,
                    background:"var(--color-bg-soft)",
                  }}
                  title="이 회사의 담당자 관리자 목록"
                >
                  {expandedCompanyId === c.id ? "▴" : "▾"} 👥 관리자 목록
                </button>
                {expandedCompanyId === c.id && (
                  <AdminListSection
                    company={c}
                    cache={adminsByCompany[c.id]}
                    currentUserUid={currentUserUid}
                    onAdd={() => openAdminModal("add", c)}
                    onEditProfile={(adminRow) => openAdminModal("editProfile", c, adminRow)}
                    onEditPerms={(adminRow) => openAdminModal("editPerms", c, adminRow)}
                    onDeleteAdmin={(adminRow) => openAdminModal("deleteAdmin", c, adminRow)}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {modalOpen && (
        <div style={S.overlay}>
          <form style={S.modal} onSubmit={submit}>
            <div style={S.modalTitle}>신규 회사 등록</div>
            <div style={{ fontSize:11, color:"var(--color-label-mute)", marginBottom:6 }}>
              회사 도큐먼트 + 관리자 Auth 계정 + users 도큐먼트 3건이 동시 생성됩니다.
            </div>

            <label style={S.label}>회사 ID (소문자·숫자 3~20자)</label>
            <input style={S.input} placeholder="예: sws001" value={form.companyId}
              onChange={(e) => setForm({ ...form, companyId: e.target.value.toLowerCase().trim() })} />

            <label style={S.label}>회사 이름</label>
            <input style={S.input} placeholder="예: 스위스관광" value={form.companyName}
              onChange={(e) => setForm({ ...form, companyName: e.target.value })} />

            <div style={{ height:1, background:"var(--color-line-soft)", margin:"8px 0" }} />
            <div style={{ fontSize:12, fontWeight:700, color:"var(--color-label)" }}>관리자 계정</div>

            <label style={S.label}>관리자 이름</label>
            <input style={S.input} placeholder="홍길동" value={form.adminName}
              onChange={(e) => setForm({ ...form, adminName: e.target.value })} />

            <label style={S.label}>관리자 사번</label>
            <input style={S.input} placeholder="예: admin01" value={form.adminEmpNo}
              onChange={(e) => setForm({ ...form, adminEmpNo: e.target.value.trim() })} />

            <label style={S.label}>관리자 이메일 (로그인 ID)</label>
            <input style={S.input} type="email" placeholder="admin@sws.com" value={form.adminEmail}
              onChange={(e) => setForm({ ...form, adminEmail: e.target.value.trim() })} />

            <label style={S.label}>관리자 비밀번호 (6자 이상)</label>
            <input style={S.input} type="password" placeholder="••••••••" value={form.adminPassword}
              onChange={(e) => setForm({ ...form, adminPassword: e.target.value })} />

            {errMsg && (
              <div style={{ background:"#FCE5E5", border:"1px solid #F6C9C9", color:"var(--color-destructive)", padding:"8px 12px", borderRadius:8, fontSize:12, marginTop:6 }}>
                {errMsg}
              </div>
            )}

            <div style={{ display:"flex", gap:8, marginTop:12 }}>
              <button type="button" style={{ ...S.editBtn, flex:1, padding:"9px 0", fontSize:13 }}
                disabled={busy} onClick={() => setModalOpen(false)}>취소</button>
              <button type="submit" style={{ ...S.addBtn, flex:2, padding:"9px 0" }} disabled={busy}>
                {busy ? "생성 중..." : "회사 생성"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* 운영 메뉴 모달 — 편집/비번초기화/영구삭제 단일 dispatcher */}
      {opsModal && opsModal.kind === "edit" && (
        <EditCompanyModal company={opsModal.company} onClose={closeOps} onDone={handleOpsDone} />
      )}
      {opsModal && opsModal.kind === "reset" && (
        <ResetPasswordModal company={opsModal.company} onClose={closeOps} onDone={handleOpsDone} />
      )}
      {opsModal && opsModal.kind === "delete" && (
        <DeleteCompanyModal
          company={opsModal.company}
          isSelf={opsModal.company.id === currentUserCompanyId}
          onClose={closeOps}
          onDone={handleOpsDone}
        />
      )}

      {/* Phase A (2026-05-29) 관리자 관리 모달 — 추가/권한변경/삭제 단일 dispatcher */}
      {adminModal && adminModal.kind === "add" && (
        <AddAdminModal
          company={adminModal.company}
          partnerCodes={(adminsByCompany[adminModal.company.id] || {}).partnerCodes || []}
          onClose={closeAdminModal}
          onDone={handleAdminModalDone}
        />
      )}
      {adminModal && adminModal.kind === "editProfile" && (
        <EditAdminProfileModal
          company={adminModal.company}
          admin={adminModal.admin}
          onClose={closeAdminModal}
          onDone={handleAdminModalDone}
        />
      )}
      {adminModal && adminModal.kind === "editPerms" && (
        <EditAdminPermissionsModal
          company={adminModal.company}
          admin={adminModal.admin}
          partnerCodes={(adminsByCompany[adminModal.company.id] || {}).partnerCodes || []}
          onClose={closeAdminModal}
          onDone={handleAdminModalDone}
        />
      )}
      {adminModal && adminModal.kind === "deleteAdmin" && (
        <DeleteAdminModal
          company={adminModal.company}
          admin={adminModal.admin}
          onClose={closeAdminModal}
          onDone={handleAdminModalDone}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// Phase A (2026-05-29) — 한 회사 카드 안에 펼쳐지는 관리자 목록.
// 로딩/에러/빈 상태 + 행별 권한 배지 + 권한변경/삭제 버튼 + "+ 관리자 추가".
// 자기 자신 행은 권한변경/삭제 비활성(이중 안전망, CF 도 거부).
// ─────────────────────────────────────────────────────────
function AdminListSection({ company, cache, currentUserUid, onAdd, onEditProfile, onEditPerms, onDeleteAdmin }) {
  const state = cache || { loading: true };
  const admins = state.admins || [];
  return (
    <div style={{
      marginTop:6, padding:"10px 12px",
      background:"var(--color-bg-soft)",
      border:"1px solid var(--color-line-soft)",
      borderRadius:8,
      display:"flex", flexDirection:"column", gap:8,
    }}>
      {state.loading && (
        <div style={{ fontSize:12, color:"var(--color-label-mute)", textAlign:"center", padding:"6px 0" }}>
          관리자 목록 로딩 중...
        </div>
      )}
      {state.error && (
        <div style={{
          background:"#FCE5E5", border:"1px solid #F6C9C9", color:"var(--color-destructive)",
          padding:"6px 10px", borderRadius:6, fontSize:11,
        }}>
          {state.error}
        </div>
      )}
      {!state.loading && !state.error && admins.length === 0 && (
        <div style={{ fontSize:12, color:"var(--color-label-mute)", textAlign:"center", padding:"6px 0" }}>
          등록된 관리자가 없습니다.
        </div>
      )}
      {!state.loading && admins.map(a => {
        const isSelf = a.uid === currentUserUid;
        const isAll = Array.isArray(a.allowedPartnerCodes) && a.allowedPartnerCodes[0] === "*";
        const badge = isAll
          ? { label: "전체 권한", bg: "#E6F7EB", color: "#007A29" }
          : { label: `담당 협력사 ${a.allowedPartnerCodes.length}개`, bg: "var(--color-primary-soft)", color: "var(--color-primary-deep)" };
        // 게시판형 세로 카드 — 이름이 한 줄을 온전히 차지해 짤리지 않음(2026-06-15).
        return (
          <div key={a.uid} style={{
            padding:"12px 14px", background:"var(--color-bg)",
            border:"1px solid var(--color-line)", borderRadius:8,
            display:"flex", flexDirection:"column", gap:8,
          }}>
            {/* 상단: 이름(크게) + 권한 배지 */}
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8 }}>
              <div style={{ fontSize:15, fontWeight:700, color:"var(--color-label)" }}>
                {a.name || "(이름 없음)"}
                {isSelf && <span style={{ marginLeft:6, fontSize:11, fontWeight:600, color:"var(--color-primary)" }}>(나)</span>}
              </div>
              <span style={{
                fontSize:11, fontWeight:700, padding:"3px 10px", borderRadius:20,
                background: badge.bg, color: badge.color, flexShrink:0, whiteSpace:"nowrap",
              }}>{badge.label}</span>
            </div>
            {/* 중단: 이메일 · 사번 */}
            <div style={{ fontSize:12, color:"var(--color-label-mute)", wordBreak:"break-all" }}>
              {a.email || "(이메일 없음)"} <span style={{ color:"var(--color-line)" }}>·</span> 사번 {a.empNo || "-"}
            </div>
            {/* 하단: 관리 버튼(전체 라벨) */}
            <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
              <button onClick={() => onEditProfile(a)} title="이름·이메일·비밀번호 수정"
                style={{ ...S.editBtn, marginRight:0, fontSize:12, padding:"6px 12px" }}>✏️ 정보수정</button>
              <button onClick={() => onEditPerms(a)} disabled={isSelf}
                title={isSelf ? "자기 자신의 권한은 변경할 수 없습니다" : "협력사 권한 변경"}
                style={{ ...S.editBtn, marginRight:0, fontSize:12, padding:"6px 12px",
                  opacity: isSelf ? 0.4 : 1, cursor: isSelf ? "not-allowed" : "pointer" }}>🛡 권한 변경</button>
              <button onClick={() => onDeleteAdmin(a)} disabled={isSelf}
                title={isSelf ? "자기 자신은 삭제할 수 없습니다" : "관리자 삭제"}
                style={{ ...S.editBtn, marginRight:0, fontSize:12, padding:"6px 12px",
                  color: isSelf ? "var(--color-label-mute)" : "var(--color-destructive)",
                  borderColor: isSelf ? "var(--color-line)" : "var(--color-destructive)",
                  opacity: isSelf ? 0.4 : 1, cursor: isSelf ? "not-allowed" : "pointer" }}>🗑 삭제</button>
            </div>
          </div>
        );
      })}
      {!state.loading && !state.error && (
        <button
          onClick={onAdd}
          style={{
            ...S.editBtn, marginRight:0, marginTop:2, fontSize:11, fontWeight:700,
            background:"var(--color-primary)", color:"#fff",
            border:"1px solid var(--color-primary)",
          }}
        >+ 관리자 추가</button>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// Phase A (2026-05-29) — 협력사 권한 체크박스 그룹(공용 UI 헬퍼).
// "전체 권한(*)" 별도 체크박스 + 그 외 협력사 다중 체크박스(전체 권한 ON 시 disabled).
// value: string[] ("*" 포함이면 ["*"], 그 외엔 코드들).
// ─────────────────────────────────────────────────────────
function PartnerPermissionPicker({ partnerCodes, value, onChange }) {
  const isAll = value.length > 0 && value[0] === "*";
  const codeSet = new Set(isAll ? [] : value);

  const toggleAll = () => {
    if (isAll) onChange([]);   // 전체 해제 → 빈 배열(개별 선택 시작)
    else onChange(["*"]);
  };
  const toggleCode = (code) => {
    if (isAll) return;
    const next = new Set(codeSet);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    onChange(Array.from(next));
  };

  return (
    <div style={{
      border:"1px solid var(--color-line)", borderRadius:8,
      background:"var(--color-bg-soft)",
      padding:"10px 12px", display:"flex", flexDirection:"column", gap:6,
      maxHeight:200, overflowY:"auto",
    }}>
      <label style={{ display:"flex", alignItems:"center", gap:8, fontSize:12, fontWeight:700, color:"var(--color-label)", cursor:"pointer" }}>
        <input type="checkbox" checked={isAll} onChange={toggleAll} />
        ⭐ 전체 권한 (*) — 본부/회사 전체 협력사 관리
      </label>
      <div style={{ height:1, background:"var(--color-line-soft)" }} />
      {partnerCodes.length === 0 && (
        <div style={{ fontSize:11, color:"var(--color-label-mute)", padding:"4px 0", textAlign:"center" }}>
          이 회사에 등록된 협력사가 없습니다. 발급 후 권한을 부여하세요.
        </div>
      )}
      {partnerCodes.map(p => (
        <label key={p.code} style={{
          display:"flex", alignItems:"center", gap:8, fontSize:12,
          color: isAll ? "var(--color-label-mute)" : "var(--color-label)",
          cursor: isAll ? "not-allowed" : "pointer",
          opacity: isAll ? 0.5 : 1,
        }}>
          <input
            type="checkbox"
            checked={codeSet.has(p.code)}
            disabled={isAll}
            onChange={() => toggleCode(p.code)}
          />
          <span style={{ flex:1, minWidth:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
            {p.partnerName || "(이름 없음)"}{!p.active && <span style={{ color:"var(--color-label-mute)", marginLeft:4 }}>· 비활성</span>}
          </span>
          <span style={{ fontSize:10, color:"var(--color-label-mute)", fontFamily:"monospace", flexShrink:0 }}>
            {p.code}
          </span>
        </label>
      ))}
      {/* 전체 해제 + 0개 선택 = 아무 협력사도 못 보는 상태 안내(저장은 유효하나 의도 확인). */}
      {!isAll && codeSet.size === 0 && partnerCodes.length > 0 && (
        <div style={{ fontSize:11, color:"var(--color-destructive)", padding:"2px 0", lineHeight:1.45 }}>
          ⚠ 선택한 협력사가 없습니다. 이대로 저장하면 이 관리자는 <b>아무 협력사도 볼 수 없습니다</b>. 담당 협력사를 선택하세요.
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// Phase A (2026-05-29) — 신규 관리자 추가 모달.
// empNo / email / name / password(2회) + allowedPartnerCodes(PartnerPermissionPicker).
// ─────────────────────────────────────────────────────────
function AddAdminModal({ company, partnerCodes, onClose, onDone }) {
  const [empNo, setEmpNo] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [pwd, setPwd] = useState("");
  const [pwd2, setPwd2] = useState("");
  const [allowed, setAllowed] = useState([]);   // 기본=전체 해제(담당 거래처 직접 선택 — 영업담당자 id별 관리 모델). 전체 관리자는 ⭐전체 권한 체크.
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState("");
  const [okMsg, setOkMsg] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setErrMsg(""); setOkMsg("");
    if (!/^[A-Za-z0-9]{1,30}$/.test(empNo.trim())) { setErrMsg("사번은 1~30자 영숫자입니다"); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setErrMsg("이메일 형식이 올바르지 않습니다"); return; }
    if (!name.trim() || name.trim().length > 30) { setErrMsg("이름은 1~30자입니다"); return; }
    if (pwd.length < 6) { setErrMsg("비밀번호는 최소 6자리여야 합니다"); return; }
    if (pwd !== pwd2) { setErrMsg("비밀번호와 확인이 일치하지 않습니다"); return; }

    setBusy(true);
    try {
      const callable = httpsCallable(functions, "createCompanyAdmin");
      const res = await callable({
        companyId: company.id,
        empNo: empNo.trim(),
        email: email.trim(),
        name: name.trim(),
        password: pwd,
        allowedPartnerCodes: allowed,
      });
      setOkMsg(`관리자 추가 완료\n• ${name.trim()} (${res.data?.email || email.trim()})\n• UID: ${res.data?.uid || "?"}`);
      setTimeout(() => { onDone(); }, 1000);
    } catch (err) {
      setErrMsg(err.message || "관리자 추가 실패");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={S.overlay}>
      <form style={S.modal} onSubmit={submit}>
        <div style={S.modalTitle}>👥 관리자 추가 — {company.name || company.id}</div>
        <div style={{ fontSize:11, color:"var(--color-label-mute)", marginBottom:6 }}>
          이 회사를 관리할 담당자 계정을 신규 생성합니다.
        </div>

        <label style={S.label}>이름 (1~30자)</label>
        <input style={S.input} placeholder="홍길동" value={name}
          onChange={(e) => setName(e.target.value)} />

        <label style={S.label}>사번 (1~30자 영숫자)</label>
        <input style={S.input} placeholder="예: wschoi" value={empNo}
          onChange={(e) => setEmpNo(e.target.value.trim())} />

        <label style={S.label}>이메일 (로그인 ID)</label>
        <input style={S.input} type="email" placeholder="manager@example.com" value={email}
          onChange={(e) => setEmail(e.target.value.trim())} />

        <label style={S.label}>비밀번호 (6자 이상)</label>
        <input style={S.input} type="password" placeholder="••••••••" value={pwd}
          onChange={(e) => setPwd(e.target.value)} />

        <label style={S.label}>비밀번호 확인</label>
        <input style={S.input} type="password" placeholder="••••••••" value={pwd2}
          onChange={(e) => setPwd2(e.target.value)} />

        <label style={{ ...S.label, marginTop:8 }}>관리 권한 (협력사 범위)</label>
        <PartnerPermissionPicker partnerCodes={partnerCodes} value={allowed} onChange={setAllowed} />

        {errMsg && (
          <div style={{ background:"#FCE5E5", border:"1px solid #F6C9C9", color:"var(--color-destructive)", padding:"8px 12px", borderRadius:8, fontSize:12, marginTop:6, whiteSpace:"pre-wrap" }}>
            {errMsg}
          </div>
        )}
        {okMsg && (
          <div style={{ background:"#E6F7EB", border:"1px solid #B7E5C5", color:"#007A29", padding:"8px 12px", borderRadius:8, fontSize:12, marginTop:6, whiteSpace:"pre-wrap" }}>
            {okMsg}
          </div>
        )}

        <div style={{ display:"flex", gap:8, marginTop:12 }}>
          <button type="button" style={{ ...S.editBtn, flex:1, padding:"9px 0", fontSize:13 }}
            disabled={busy} onClick={onClose}>취소</button>
          <button type="submit" style={{ ...S.addBtn, flex:2, padding:"9px 0" }} disabled={busy}>
            {busy ? "추가 중..." : "관리자 추가"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// Phase A (2026-05-29) — 기존 관리자의 협력사 권한 변경 모달.
// allowedPartnerCodes 만 변경(다른 필드 보호).
// ─────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────
// (2026-06-08) — 관리자 로그인 정보(이름/이메일/비밀번호) 수정 모달.
// 특정 uid 대상(updateCompanyAdminProfile CF) — 변경된 필드만 전송.
// 배경 클릭으로 닫히지 않음(입력 중 실수 방지·다른 모달과 일관). 취소/적용 버튼만.
// ─────────────────────────────────────────────────────────
function EditAdminProfileModal({ company, admin, onClose, onDone }) {
  const [name, setName] = useState(admin?.name || "");
  const [email, setEmail] = useState(admin?.email || "");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState("");
  const [okMsg, setOkMsg] = useState("");

  const origName = admin?.name || "";
  const origEmail = admin?.email || "";

  const submit = async (e) => {
    e.preventDefault();
    setErrMsg(""); setOkMsg("");

    // 변경된 필드만 추출(빈 비밀번호 = 변경 안 함).
    const payload = { uid: admin.uid };
    const nameTrim = name.trim();
    const emailTrim = email.trim();
    if (nameTrim !== origName) {
      if (!nameTrim || nameTrim.length > 30) { setErrMsg("이름은 1~30자여야 합니다"); return; }
      payload.name = nameTrim;
    }
    if (emailTrim !== origEmail) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTrim)) { setErrMsg("이메일 형식이 올바르지 않습니다"); return; }
      payload.email = emailTrim;
    }
    if (password) {
      if (password.length < 6) { setErrMsg("비밀번호는 최소 6자리여야 합니다"); return; }
      if (password !== passwordConfirm) { setErrMsg("비밀번호 확인이 일치하지 않습니다"); return; }
      payload.password = password;
    }

    if (Object.keys(payload).length <= 1) {
      setErrMsg("변경된 내용이 없습니다");
      return;
    }

    setBusy(true);
    try {
      const callable = httpsCallable(functions, "updateCompanyAdminProfile");
      await callable(payload);
      const parts = [];
      if (payload.name) parts.push(`이름: ${payload.name}`);
      if (payload.email) parts.push(`이메일: ${payload.email}`);
      if (payload.password) parts.push("비밀번호 변경됨");
      setOkMsg(`정보 수정 완료\n• ${parts.join("\n• ")}`);
      setTimeout(() => { onDone(); }, 1000);
    } catch (err) {
      setErrMsg(err.message || "정보 수정 실패");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={S.overlay}>
      <form style={S.modal} onSubmit={submit}>
        <div style={S.modalTitle}>✏️ 정보 수정 — {admin.name || admin.email}</div>
        <div style={{ fontSize:11, color:"var(--color-label-mute)", marginBottom:6 }}>
          소속: {company.name || company.id} · 사번: {admin.empNo || "?"}
        </div>

        <label style={S.label}>이름</label>
        <input style={S.input} placeholder="홍길동" value={name}
          onChange={(e) => setName(e.target.value)} />

        <label style={S.label}>이메일 (로그인 ID)</label>
        <input style={S.input} type="email" placeholder="admin@company.com" value={email}
          onChange={(e) => setEmail(e.target.value)} />
        <div style={{ fontSize:11, color:"var(--color-cautionary, #B8860B)", marginTop:2 }}>
          ⚠ 이메일을 바꾸면 이 관리자의 로그인 ID가 변경됩니다.
        </div>

        <div style={{ height:1, background:"var(--color-line-soft)", margin:"10px 0 4px" }} />
        <label style={S.label}>새 비밀번호 (변경 시에만 입력, 6자 이상)</label>
        <input style={S.input} type="password" placeholder="비워두면 변경 안 함" value={password}
          onChange={(e) => setPassword(e.target.value)} />

        <label style={S.label}>새 비밀번호 확인</label>
        <input style={S.input} type="password" placeholder="••••••••" value={passwordConfirm}
          onChange={(e) => setPasswordConfirm(e.target.value)} />

        {errMsg && (
          <div style={{ background:"#FCE5E5", border:"1px solid #F6C9C9", color:"var(--color-destructive)", padding:"8px 12px", borderRadius:8, fontSize:12, marginTop:6 }}>
            {errMsg}
          </div>
        )}
        {okMsg && (
          <div style={{ background:"#E6F7EB", border:"1px solid #B7E5C5", color:"#007A29", padding:"8px 12px", borderRadius:8, fontSize:12, marginTop:6, whiteSpace:"pre-wrap" }}>
            {okMsg}
          </div>
        )}

        <div style={{ display:"flex", gap:8, marginTop:12 }}>
          <button type="button" style={{ ...S.editBtn, flex:1, padding:"9px 0", fontSize:13 }}
            disabled={busy} onClick={onClose}>취소</button>
          <button type="submit" style={{ ...S.addBtn, flex:2, padding:"9px 0" }} disabled={busy}>
            {busy ? "적용 중..." : "변경 적용"}
          </button>
        </div>
      </form>
    </div>
  );
}

function EditAdminPermissionsModal({ company, admin, partnerCodes, onClose, onDone }) {
  const [allowed, setAllowed] = useState(
    // 빈 배열([])은 "전체 해제" 유효 상태 → 그대로(전체로 둔갑 금지). 부재만 ["*"] 폴백.
    // ⚠ length>0 검사 복원 금지 — 전체 해제가 재오픈 시 전체로 되돌아가는 회귀(2026-06-15).
    Array.isArray(admin?.allowedPartnerCodes)
      ? admin.allowedPartnerCodes
      : ["*"]
  );
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState("");
  const [okMsg, setOkMsg] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setErrMsg(""); setOkMsg("");
    setBusy(true);
    try {
      const callable = httpsCallable(functions, "updateCompanyAdminPermissions");
      await callable({ uid: admin.uid, allowedPartnerCodes: allowed });
      const isAll = allowed[0] === "*";
      setOkMsg(`권한 변경 완료\n• ${admin.name || admin.email}\n• ${isAll ? "전체 권한" : `협력사 ${allowed.length}개`}`);
      setTimeout(() => { onDone(); }, 800);
    } catch (err) {
      setErrMsg(err.message || "권한 변경 실패");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={S.overlay}>
      <form style={S.modal} onSubmit={submit}>
        <div style={S.modalTitle}>🛡 권한 변경 — {admin.name || admin.email}</div>
        <div style={{ fontSize:11, color:"var(--color-label-mute)", marginBottom:6 }}>
          소속: {company.name || company.id} · 이메일: {admin.email || "?"}
        </div>

        <label style={S.label}>관리 가능한 협력사 범위</label>
        <PartnerPermissionPicker partnerCodes={partnerCodes} value={allowed} onChange={setAllowed} />

        {errMsg && (
          <div style={{ background:"#FCE5E5", border:"1px solid #F6C9C9", color:"var(--color-destructive)", padding:"8px 12px", borderRadius:8, fontSize:12, marginTop:6 }}>
            {errMsg}
          </div>
        )}
        {okMsg && (
          <div style={{ background:"#E6F7EB", border:"1px solid #B7E5C5", color:"#007A29", padding:"8px 12px", borderRadius:8, fontSize:12, marginTop:6, whiteSpace:"pre-wrap" }}>
            {okMsg}
          </div>
        )}

        <div style={{ display:"flex", gap:8, marginTop:12 }}>
          <button type="button" style={{ ...S.editBtn, flex:1, padding:"9px 0", fontSize:13 }}
            disabled={busy} onClick={onClose}>취소</button>
          <button type="submit" style={{ ...S.addBtn, flex:2, padding:"9px 0" }} disabled={busy}>
            {busy ? "변경 중..." : "권한 저장"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// Phase A (2026-05-29) — 관리자 삭제 모달(confirm + Auth + users 삭제).
// 자기 자신은 카드에서 비활성, 여기서도 이중 가드.
// ─────────────────────────────────────────────────────────
function DeleteAdminModal({ company, admin, onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState("");
  const [okMsg, setOkMsg] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setErrMsg(""); setOkMsg("");
    setBusy(true);
    try {
      const callable = httpsCallable(functions, "deleteCompanyAdmin");
      await callable({ uid: admin.uid });
      setOkMsg(`관리자 삭제 완료\n• ${admin.name || admin.email}`);
      setTimeout(() => { onDone(); }, 1000);
    } catch (err) {
      setErrMsg(err.message || "관리자 삭제 실패");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={S.overlay}>
      <form style={{ ...S.modal, borderTop:"4px solid var(--color-destructive)" }} onSubmit={submit}>
        <div style={{ ...S.modalTitle, color:"var(--color-destructive)" }}>🗑 관리자 삭제 — {admin.name || admin.email}</div>
        <div style={{
          background:"#FCE5E5", border:"1px solid #F6C9C9", color:"#B00020",
          padding:"10px 12px", borderRadius:8, fontSize:12, marginBottom:8, lineHeight:1.5,
        }}>
          ⚠️ <b>이 작업은 되돌릴 수 없습니다.</b><br/>
          이 관리자의 Firebase Auth 계정 + users 도큐먼트가 영구 삭제됩니다.<br/>
          소속: {company.name || company.id} · 이메일: {admin.email || "?"}
        </div>

        {errMsg && (
          <div style={{ background:"#FCE5E5", border:"1px solid #F6C9C9", color:"var(--color-destructive)", padding:"8px 12px", borderRadius:8, fontSize:12, marginTop:6 }}>
            {errMsg}
          </div>
        )}
        {okMsg && (
          <div style={{ background:"#E6F7EB", border:"1px solid #B7E5C5", color:"#007A29", padding:"8px 12px", borderRadius:8, fontSize:12, marginTop:6, whiteSpace:"pre-wrap" }}>
            {okMsg}
          </div>
        )}

        <div style={{ display:"flex", gap:8, marginTop:12 }}>
          <button type="button" style={{ ...S.editBtn, flex:1, padding:"9px 0", fontSize:13 }}
            disabled={busy} onClick={onClose}>취소</button>
          <button
            type="submit"
            disabled={busy}
            style={{
              flex:2, padding:"9px 0", borderRadius:6, fontSize:13, fontWeight:700, fontFamily:"inherit",
              border:"none",
              background: busy ? "var(--color-bg-alt)" : "var(--color-destructive)",
              color: busy ? "var(--color-label-mute)" : "#fff",
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            {busy ? "삭제 중..." : "삭제 확인"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// 회사 편집 모달 — 회사명·관리자 이름·이메일·비밀번호(선택) 변경.
// 비어둔 필드는 변경하지 않음. 비밀번호도 동시 변경 가능(선택).
// updateCompanyInfo / updateCompanyAdminInfo / resetCompanyAdminPassword 3개 onCall 을
// 변경된 필드에 대해서만 순차 호출.
// ─────────────────────────────────────────────────────────
function EditCompanyModal({ company, onClose, onDone }) {
  const [companyName, setCompanyName] = useState(company.name || "");
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState("");
  const [okMsg, setOkMsg] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setErrMsg("");
    setOkMsg("");
    const nameChanged = companyName.trim() && companyName.trim() !== (company.name || "").trim();
    const adminNameTrim = adminName.trim();
    const adminEmailTrim = adminEmail.trim();
    const passwordChanged = adminPassword.length > 0;

    if (!nameChanged && !adminNameTrim && !adminEmailTrim && !passwordChanged) {
      setErrMsg("변경할 필드를 1개 이상 입력하세요");
      return;
    }
    if (passwordChanged && adminPassword.length < 6) {
      setErrMsg("비밀번호는 최소 6자리여야 합니다");
      return;
    }
    if (adminEmailTrim && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmailTrim)) {
      setErrMsg("이메일 형식이 올바르지 않습니다");
      return;
    }

    setBusy(true);
    const log = [];
    try {
      if (nameChanged) {
        const callable = httpsCallable(functions, "updateCompanyInfo");
        await callable({ companyId: company.id, name: companyName.trim() });
        log.push(`회사명 → ${companyName.trim()}`);
      }
      if (adminNameTrim || adminEmailTrim) {
        const callable = httpsCallable(functions, "updateCompanyAdminInfo");
        const payload = { companyId: company.id };
        if (adminNameTrim) payload.displayName = adminNameTrim;
        if (adminEmailTrim) payload.email = adminEmailTrim;
        await callable(payload);
        if (adminNameTrim) log.push(`관리자 이름 → ${adminNameTrim}`);
        if (adminEmailTrim) log.push(`관리자 이메일 → ${adminEmailTrim}`);
      }
      if (passwordChanged) {
        const callable = httpsCallable(functions, "resetCompanyAdminPassword");
        await callable({ companyId: company.id, newPassword: adminPassword });
        log.push("관리자 비밀번호 변경");
      }
      setOkMsg(`완료:\n• ${log.join("\n• ")}`);
      // 0.8초 후 자동 닫기 + 새로고침.
      setTimeout(() => { onDone(); }, 800);
    } catch (err) {
      setErrMsg(err.message || "편집 실패");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={S.overlay}>
      <form style={S.modal} onSubmit={submit}>
        <div style={S.modalTitle}>✏️ 회사 편집 — {company.name || company.id}</div>
        <div style={{ fontSize:11, color:"var(--color-label-mute)", marginBottom:6 }}>
          변경할 필드만 입력. 비어두면 그대로 유지.
        </div>

        <label style={S.label}>회사 이름</label>
        <input style={S.input} value={companyName}
          onChange={(e) => setCompanyName(e.target.value)} />

        <div style={{ height:1, background:"var(--color-line-soft)", margin:"8px 0" }} />
        <div style={{ fontSize:12, fontWeight:700, color:"var(--color-label)" }}>관리자 계정 (선택)</div>

        <label style={S.label}>관리자 이름 (변경 시 입력)</label>
        <input style={S.input} placeholder="비워두면 변경 안 함" value={adminName}
          onChange={(e) => setAdminName(e.target.value)} />

        <label style={S.label}>관리자 이메일 (변경 시 입력)</label>
        <input style={S.input} type="email" placeholder="비워두면 변경 안 함" value={adminEmail}
          onChange={(e) => setAdminEmail(e.target.value)} />

        <label style={S.label}>관리자 새 비밀번호 (변경 시 입력, 6자 이상)</label>
        <input style={S.input} type="password" placeholder="비워두면 변경 안 함" value={adminPassword}
          onChange={(e) => setAdminPassword(e.target.value)} />

        {errMsg && (
          <div style={{ background:"#FCE5E5", border:"1px solid #F6C9C9", color:"var(--color-destructive)", padding:"8px 12px", borderRadius:8, fontSize:12, marginTop:6, whiteSpace:"pre-wrap" }}>
            {errMsg}
          </div>
        )}
        {okMsg && (
          <div style={{ background:"#E6F7EB", border:"1px solid #B7E5C5", color:"#007A29", padding:"8px 12px", borderRadius:8, fontSize:12, marginTop:6, whiteSpace:"pre-wrap" }}>
            {okMsg}
          </div>
        )}

        <div style={{ display:"flex", gap:8, marginTop:12 }}>
          <button type="button" style={{ ...S.editBtn, flex:1, padding:"9px 0", fontSize:13 }}
            disabled={busy} onClick={onClose}>취소</button>
          <button type="submit" style={{ ...S.addBtn, flex:2, padding:"9px 0" }} disabled={busy}>
            {busy ? "변경 중..." : "변경 적용"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// 관리자 비밀번호 초기화 모달 — 새 비밀번호 + 확인 일치 + 6자 이상.
// 빠르게 비밀번호만 바꾸고 싶을 때(편집 모달과 별도).
// ─────────────────────────────────────────────────────────
function ResetPasswordModal({ company, onClose, onDone }) {
  const [pwd, setPwd] = useState("");
  const [pwd2, setPwd2] = useState("");
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState("");
  const [okMsg, setOkMsg] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setErrMsg(""); setOkMsg("");
    if (pwd.length < 6) { setErrMsg("비밀번호는 최소 6자리여야 합니다"); return; }
    if (pwd !== pwd2) { setErrMsg("새 비밀번호와 확인이 일치하지 않습니다"); return; }
    setBusy(true);
    try {
      const callable = httpsCallable(functions, "resetCompanyAdminPassword");
      const res = await callable({ companyId: company.id, newPassword: pwd });
      setOkMsg(`완료\n• 관리자 이메일: ${res.data?.email || "(이메일 정보 없음)"}\n• 새 비밀번호 적용됨`);
      setTimeout(() => { onDone(); }, 1200);
    } catch (err) {
      setErrMsg(err.message || "비밀번호 초기화 실패");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={S.overlay}>
      <form style={S.modal} onSubmit={submit}>
        <div style={S.modalTitle}>🔑 관리자 비밀번호 초기화 — {company.name || company.id}</div>
        <div style={{ fontSize:11, color:"var(--color-label-mute)", marginBottom:6 }}>
          회사 관리자(역할=admin)의 Firebase Auth 비밀번호를 즉시 변경합니다.
        </div>

        <label style={S.label}>새 비밀번호 (6자 이상)</label>
        <input style={S.input} type="password" placeholder="••••••••" value={pwd}
          onChange={(e) => setPwd(e.target.value)} />

        <label style={S.label}>새 비밀번호 확인</label>
        <input style={S.input} type="password" placeholder="••••••••" value={pwd2}
          onChange={(e) => setPwd2(e.target.value)} />

        {errMsg && (
          <div style={{ background:"#FCE5E5", border:"1px solid #F6C9C9", color:"var(--color-destructive)", padding:"8px 12px", borderRadius:8, fontSize:12, marginTop:6 }}>
            {errMsg}
          </div>
        )}
        {okMsg && (
          <div style={{ background:"#E6F7EB", border:"1px solid #B7E5C5", color:"#007A29", padding:"8px 12px", borderRadius:8, fontSize:12, marginTop:6, whiteSpace:"pre-wrap" }}>
            {okMsg}
          </div>
        )}

        <div style={{ display:"flex", gap:8, marginTop:12 }}>
          <button type="button" style={{ ...S.editBtn, flex:1, padding:"9px 0", fontSize:13 }}
            disabled={busy} onClick={onClose}>취소</button>
          <button type="submit" style={{ ...S.addBtn, flex:2, padding:"9px 0" }} disabled={busy}>
            {busy ? "변경 중..." : "비밀번호 초기화"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// 회사 영구 삭제 모달 — 빨간 강조 + companyId 재입력 일치 + 자기 회사 차단.
// 카드 버튼에서 isSelf 면 처음부터 비활성이지만, 이중 안전망으로 모달에서도 가드.
// ─────────────────────────────────────────────────────────
function DeleteCompanyModal({ company, isSelf, onClose, onDone }) {
  const [confirmId, setConfirmId] = useState("");
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState("");
  const [okMsg, setOkMsg] = useState("");

  const idMatched = confirmId.trim() === company.id;

  const submit = async (e) => {
    e.preventDefault();
    setErrMsg(""); setOkMsg("");
    if (isSelf) {
      setErrMsg("자기 소속 회사는 삭제할 수 없습니다");
      return;
    }
    if (!idMatched) {
      setErrMsg("회사 ID 가 일치하지 않습니다");
      return;
    }
    setBusy(true);
    try {
      const callable = httpsCallable(functions, "deleteCompany");
      const res = await callable({ companyId: company.id, confirmCompanyId: confirmId.trim() });
      const counts = res.data?.deletedCount || {};
      const summary = Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(", ");
      setOkMsg(`영구 삭제 완료\n• ${company.name || company.id}\n• 삭제 카운트: ${summary || "(상세 없음)"}`);
      setTimeout(() => { onDone(); }, 1500);
    } catch (err) {
      setErrMsg(err.message || "영구 삭제 실패");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={S.overlay}>
      <form style={{ ...S.modal, borderTop:"4px solid var(--color-destructive)" }} onSubmit={submit}>
        <div style={{ ...S.modalTitle, color:"var(--color-destructive)" }}>🗑 회사 영구 삭제 — {company.name || company.id}</div>
        <div style={{
          background:"#FCE5E5", border:"1px solid #F6C9C9", color:"#B00020",
          padding:"10px 12px", borderRadius:8, fontSize:12, marginBottom:8, lineHeight:1.5,
        }}>
          ⚠️ <b>이 작업은 되돌릴 수 없습니다.</b><br/>
          회사·노선·기사·직원·차량·운행 이력·탑승 기록·공지·관리자 계정 등<br/>
          모든 데이터가 영구 삭제됩니다.
        </div>

        {isSelf ? (
          <div style={{ background:"var(--color-bg-soft)", border:"1px solid var(--color-line)", padding:"10px 12px", borderRadius:8, fontSize:12, color:"var(--color-label)" }}>
            자기 소속 회사는 삭제할 수 없습니다. (lockout 방지)
          </div>
        ) : (
          <>
            <label style={S.label}>확인 — 회사 ID 를 다시 입력하세요 (<code>{company.id}</code>)</label>
            <input
              style={{ ...S.input, fontFamily:"monospace" }}
              placeholder={company.id}
              value={confirmId}
              onChange={(e) => setConfirmId(e.target.value)}
              autoFocus
            />

            {errMsg && (
              <div style={{ background:"#FCE5E5", border:"1px solid #F6C9C9", color:"var(--color-destructive)", padding:"8px 12px", borderRadius:8, fontSize:12, marginTop:6 }}>
                {errMsg}
              </div>
            )}
            {okMsg && (
              <div style={{ background:"#E6F7EB", border:"1px solid #B7E5C5", color:"#007A29", padding:"8px 12px", borderRadius:8, fontSize:12, marginTop:6, whiteSpace:"pre-wrap" }}>
                {okMsg}
              </div>
            )}
          </>
        )}

        <div style={{ display:"flex", gap:8, marginTop:12 }}>
          <button type="button" style={{ ...S.editBtn, flex:1, padding:"9px 0", fontSize:13 }}
            disabled={busy} onClick={onClose}>취소</button>
          <button
            type="submit"
            disabled={busy || isSelf || !idMatched}
            style={{
              flex:2, padding:"9px 0", borderRadius:6, fontSize:13, fontWeight:700, fontFamily:"inherit",
              border:"none",
              background: (busy || isSelf || !idMatched) ? "var(--color-bg-alt)" : "var(--color-destructive)",
              color: (busy || isSelf || !idMatched) ? "var(--color-label-mute)" : "#fff",
              cursor: (busy || isSelf || !idMatched) ? "not-allowed" : "pointer",
            }}
          >
            {busy ? "삭제 중..." : "영구 삭제"}
          </button>
        </div>
      </form>
    </div>
  );
}
