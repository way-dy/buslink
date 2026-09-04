import { useState, useEffect, useMemo, useRef } from "react";
import {
  validatePartnerCode, parseEmployeeExcel,
  importEmployees, downloadSampleExcel, reissuePins
} from "../lib/partner";
import { partnerRouteOptions, partnerOpsRoutes } from "../lib/partnerAccess";
import { seatUsage, sortRoutes } from "../lib/routeOrder";
import QRCode from "qrcode";
import { buildAccountCardsHtml, buildPassengerLoginUrl, openPrintWindow } from "../lib/accountCards";
import { normalizeNfcUid, isValidNfcUid, formatNfcUid, isWebNfcSupported, createTagCooldown } from "../lib/nfc";
import { registerNfcCard } from "../lib/boarding";
import { db, auth } from "../firebase";
import { signInAnonymously } from "firebase/auth";
import { collection, getDocs, doc, setDoc, getDoc, updateDoc, deleteDoc, onSnapshot, query, where, orderBy, serverTimestamp, limit, getCountFromServer } from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import { BusLinkLogo, Pill, Icon } from "../components/ui";
import InstallPrompt from "../components/InstallPrompt";
import { applyAppManifest } from "../lib/pwaManifest";
import { aggregateBoardingsByStop, groupMappedByRoute } from "../lib/stopMapping";
// Phase 1.3 (2026-05-28): mainTab="ops" 운영 포털 — 실시간 버스 위치 지도.
// 카카오 SDK import — react-kakao-maps-sdk의 `Map`이 native `Map` 클래스를 shadow하므로
// 이 파일 내에서 `new Map()` 쓸 일 있으면 반드시 `new window.Map()`(issues.md `[패턴]`).
import { Map as KakaoMap, MapMarker, Polyline, CustomOverlayMap } from "react-kakao-maps-sdk";
import { useAnimatedPositions } from "../lib/useAnimatedPositions";
// gps 문서 경과 시간 — 정본은 src/lib/runStatus.js(AdminApp·직원앱과 같은 판정).
import { gpsAgeMs } from "../lib/runStatus";
// 오늘 도착 기록(노선도 통과 ✓) — 배차 읽기가 익명에 닫혀 있어 CF 위임으로 받는다.
import { useRouteStopArrivals } from "../lib/useRouteStopArrivals";
// 노선 구분(등교·하교·방과후) 필터 정본 — shift 만으론 방과후를 못 가른다(routeKind 주석).
import { availableRouteKinds, filterRoutesByKind, routeKind } from "../lib/routeKind";
import { useWakeTick } from "../lib/useWakeTick";
import { useOnlineRecover } from "../lib/useOnlineRecover";
// 거래처 브랜딩(2026-07-16 회의 #5) — 메인 컬러 CSS 변수 덮어쓰기(포탈 진입 시 적용·이탈 시 복원).
import { applyPartnerBranding, clearPartnerBranding } from "../lib/partnerBranding";
// 인증 유지(2026-09-02 way) — 업체코드만 남기고 복원 때 서버에 다시 묻는다.
import { savePartnerSession, loadPartnerSession, clearPartnerSession } from "../lib/partnerSession";
// 뒤로가기 = 앱 안의 이전 화면, 나갈 때만 확인 모달(2026-09-02 way).
import { useBackNav } from "../lib/useBackNav";
// 포털 인증(2026-09-04 P3-b) — 🔴 `authRequired` 를 켠 거래처만 비밀번호를 묻는다.
//    부재·falsy 면 아래 경로가 **지금과 글자 그대로 같다**(업체코드만으로 진입).
import { partnerLogin, partnerResume, partnerLogout, partnerSetPassword } from "../lib/partnerAuth";
import { isPartnerAuthRequired, checkNewPartnerPassword } from "../lib/partnerAuthPolicy";

// 버스 마커 "신호 지연" 임계 — 관리자 실시간 관제 MARKER_STALE_MS 와 같은 값(5분).
// 🔴 60초(GPS 신선도)로 낮추지 말 것: 단말 차량은 서버 폴러가 1분 주기라 매 분 깜빡인다.
const MARKER_STALE_MS = 5 * 60 * 1000;

const STEPS = { CODE:"code", MAIN:"main", DONE:"done", MANAGE:"manage" };
const REG_MODES = { FILE:"file", SINGLE:"single", MULTI:"multi", NFC:"nfc" };

// Phase 1.4 (2026-05-29) — 협력사 공지 발송 onCall(`sendPartnerNotice`) 호출용.
// region="us-central1" 명시(AdminApp 패턴 일관, functions/index.js 리전 고정).
const functions = getFunctions(undefined, "us-central1");

// ── 계정 안내문 인쇄(2026-07-27) ─────────────────────────
// credentials(평문 PIN 포함·발급 직후에만 존재)로 개인별 QR 을 만들어 A4 인쇄창을 연다.
// QR = 사번이 프리필된 승객앱 링크 → 배부받은 사람이 ID 를 타이핑할 필요가 없다.
// QR 생성이 실패해도(용량·환경) 카드 자체는 ID/PIN 으로 쓸 수 있게 계속 진행한다.
async function printAccountCards({ credentials, partnerName, routes, partnerCode }) {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const cards = [];
  for (const c of credentials) {
    // 🔴  를 함께 실어야 안내문 QR 로 들어온 첫 화면부터 그 거래처 톤으로 열린다.
    const loginUrl = buildPassengerLoginUrl({ origin, empNo: c.empNo, partnerCode });
    let qrDataUrl = "";
    try {
      qrDataUrl = await QRCode.toDataURL(loginUrl, { width: 240, margin: 0 });
    } catch (e) { /* QR 없이도 카드는 유효 */ }
    const r = (routes || []).find(x => x.code === c.routeCode || x.id === c.routeCode);
    cards.push({ ...c, routeName: r ? r.name : (c.routeCode || ""), loginUrl, qrDataUrl });
  }
  return openPrintWindow(buildAccountCardsHtml({ partnerName, cards }));
}

// 공지 발송 제한 상수(CF 와 동일 — UI 카운터·placeholder 용도. CF가 실제 게이트).
const PARTNER_NOTICE_LIMIT_PER_HOUR = 5;
const PARTNER_NOTICE_TITLE_MAX = 50;
const PARTNER_NOTICE_BODY_MAX = 500;

// ── 메인 탭 정본(2026-09-02) ──────────────────────────────
// 🔴 모바일 탭바와 PC 사이드바가 **같은 배열**을 그린다 — 두 벌로 두면 탭이 늘 때 한쪽만 는다.
//    (AdminApp 이 2026-08-26 에 드롭다운/사이드바 목록을 하나로 합친 것과 같은 이유.)
const MAIN_TABS = [
  { key:"register", label:"승객 등록", emoji:"📋", icon:"plus",  desc:"엑셀·개별·카드로 승객을 등록합니다" },
  { key:"manage",   label:"승객 관리", emoji:"👥", icon:"user",  desc:"등록된 승객을 찾아 수정·재발급합니다" },
  { key:"stats",    label:"탑승 통계", emoji:"📊", icon:"chart", desc:"기간별 탑승 실적을 조회합니다" },
  { key:"ops",      label:"운영 포털", emoji:"🚌", icon:"bus",   desc:"자사 노선의 실시간 운행 현황입니다" },
];
const tabMeta = (key) => MAIN_TABS.find(t => t.key === key) || MAIN_TABS[0];

// ── PC 판정(2026-09-02 way "PC에서는 화면이 가로로 채워져서 어드민처럼") ──
// 🔴 AdminApp 의 `MOBILE_MAX_W=768` 보다 높게 잡는다(1024) — 이 포털은 표·지도·폼이 한 화면에
//    같이 서므로 태블릿 세로(768~1023)에서는 지금의 카드 레이아웃이 더 낫다.
//    그 아래 폭은 **기존 모바일 반응형 그대로**(way "현재 버전은 모바일 반응형으로 잘 두고").
const WIDE_MIN_W = 1024;
function useIsWide() {
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.innerWidth >= WIDE_MIN_W);
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const h = () => setWide(window.innerWidth >= WIDE_MIN_W);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  return wide;
}

// 탭별 본문 최대 폭 — 폼은 넓히면 오히려 읽기 어렵고, 표·지도는 넓을수록 좋다.
const TAB_MAX_W = { register: 960, manage: 1320, stats: 1440, ops: 1440 };

// ── 확인 모달(나가기·인증 해제 공용) ─────────────────────
// 🔴 `window.confirm` 을 안 쓴다(2026-09-02 way "모달 팝업으로 알려주고 확인 과정") — 안드로이드
//    크롬의 기본 confirm 은 주소창 위에 붙어 앱이 아니라 브라우저가 묻는 것처럼 보인다.
// 🔴 배경(딤) 클릭으로 닫지 않는다 — 이 파일의 다른 모달들과 같은 규칙(실수로 닫히면 안 된다).
function ConfirmDialog({ title, body, confirmLabel, cancelLabel, tone = "primary", onConfirm, onCancel }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div style={S.overlay} role="dialog" aria-modal="true">
      <div style={{ ...S.modal, maxWidth:360, gap:12 }}>
        <div style={S.modalTitle}>{title}</div>
        <div style={{ fontSize:13, color:"var(--color-label-mute)", lineHeight:1.6, whiteSpace:"pre-line" }}>{body}</div>
        <div style={{ display:"flex", gap:8, marginTop:4 }}>
          <button style={{ ...S.btnSecondary, flex:1 }} onClick={onCancel} autoFocus>{cancelLabel}</button>
          <button style={{ ...S.btn, flex:1,
            background: tone === "danger" ? "var(--color-destructive)" : "var(--color-primary)",
            boxShadow: tone === "danger" ? "0 2px 8px rgba(229,34,34,.22)" : S.btn.boxShadow }}
            onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

// ── 첫 로그인 비밀번호 변경(강제) ───────────────────────
// 승객 `FirstPinSetup`(2026-07-27)과 **같은 패턴**: 발급받은 초기 비밀번호로는 업무를 못 하고,
// 본인 비밀번호를 정해야 통과한다. 🔴 «건너뛰기» 를 만들지 않는다 — 만들면 초기 비밀번호가
//    영영 살아 있고, 그 값은 발급 화면을 본 사람 전부가 아는 값이다.
// 🔴 «로그인은 되었다» 를 먼저 말한다 — 2026-09-01 승객 사고에서 배운 것. 같은 화면이 반복
//    되면 사용자는 «로그인이 안 된다» 로 읽고 비밀번호를 계속 다시 넣는다(무한 루프처럼 보인다).
function PartnerPasswordSetup({ partnerName, code, onDone, onLogout }) {
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    setErr("");
    // 판정은 정본 한 곳(`partnerAuthPolicy`) — 서버 `checkNewPartnerPassword` 와 같은 규칙이다.
    const chk = checkNewPartnerPassword(pw1, { currentCode: code });
    if (!chk.ok) { setErr(chk.message); return; }
    if (pw1 !== pw2) { setErr("두 번 입력한 비밀번호가 다릅니다"); return; }
    setBusy(true);
    try { await partnerSetPassword({ newPassword: pw1 }); onDone(); }
    catch (e) { setErr(e?.message || String(e)); }
    setBusy(false);
  };

  return (
    <div style={S.wrap}>
      <div style={{ ...S.card, maxWidth:420 }}>
        <div style={S.header}><BusLinkLogo size={26} sub="협력사 포털" /></div>
        <div style={S.title}>비밀번호를 새로 정해주세요</div>
        <div style={S.desc}>
          <b>{partnerName}</b> 로그인은 정상적으로 되었습니다.<br />
          발급받은 초기 비밀번호는 이번 한 번만 쓸 수 있습니다 — 본인만 아는 비밀번호를 정하면 바로 이용하실 수 있습니다.
        </div>
        <input style={S.input} type="password" placeholder="새 비밀번호" autoComplete="new-password"
          value={pw1} onChange={e => setPw1(e.target.value)} autoFocus />
        <input style={S.input} type="password" placeholder="새 비밀번호 확인" autoComplete="new-password"
          value={pw2} onChange={e => setPw2(e.target.value)}
          onKeyDown={e => e.key === "Enter" && submit()} />
        {err && <div style={S.errorMsg}>{err}</div>}
        <button style={{ ...S.btn, marginTop:4, opacity: pw1 && pw2 ? 1 : 0.5 }}
          onClick={submit} disabled={busy || !pw1 || !pw2}>
          {busy ? "저장 중..." : "설정하고 시작하기"}
        </button>
        {/* 잘못 들어온 사람에게 나갈 길은 남긴다(승객앱 «다른 계정으로 로그인» 과 같은 자리). */}
        <button style={S.btnSecondary} onClick={onLogout}>다른 업체코드로 로그인</button>
        <div style={S.notice}>비밀번호는 8자 이상이어야 하며, 업체코드와 같은 값은 쓸 수 없습니다</div>
      </div>
    </div>
  );
}

// 익명 인증 1회(2026-05-26) — `companies/**` read 규칙이 `isAuth()` 라 노선·명부를 읽으려면
// 반드시 먼저 끝나 있어야 한다.
// 🔴 프라미스를 memo 해서 **읽는 쪽이 기다릴 수 있게** 한다(2026-09-02). 예전에는 마운트
//    시 fire-and-forget 이었고, 사람이 업체코드를 타이핑하는 시간이 우연히 그 지연을 덮고
//    있었다 — 세션 복원은 타이핑이 없으므로 그 우연이 사라져 `Missing or insufficient
//    permissions` 로 조용히 실패했다(실측). 인증 직후 경로도 같은 프라미스를 기다린다.
let anonAuthPromise = null;
function ensureAnonAuth() {
  if (!anonAuthPromise) {
    anonAuthPromise = signInAnonymously(auth).catch(e => {
      console.warn("[PartnerApp] 익명 인증 실패:", e?.message);
      anonAuthPromise = null;   // 다음 시도에서 다시 해 볼 수 있게 비운다
      return null;
    });
  }
  return anonAuthPromise;
}

// 노선 목록 로드 — 인증 직후와 세션 복원이 **같은 함수**를 쓴다(정렬 규칙이 갈리지 않게).
// 🔴 관리자 노선 관리의 ▲▼ 순서(`routes.order`)를 여기서 한 번만 적용한다(2026-08-26 게시판
//    DqF7nony). 이 배열이 노선 드롭다운·승객 관리·탑승 통계·운영 포털 노선도의 공통 원본이라
//    여기서 정렬해 두면 아래 화면들은 입력 순서를 그대로 물려받는다.
async function fetchPartnerRoutes(companyId) {
  await ensureAnonAuth();
  const snap = await getDocs(collection(db, "companies", companyId, "routes"));
  return sortRoutes(snap.docs.map(d => ({ id: d.id, ...d.data() })));
}

export default function PartnerApp() {
  const [step, setStep] = useState(STEPS.CODE);
  const [code, setCode] = useState("");
  const [codeData, setCodeData] = useState(null);
  const [routes, setRoutes] = useState([]);
  const [regMode, setRegMode] = useState(REG_MODES.FILE);
  // mainTab 4종(2026-05-28 Phase 1.3): register|manage|stats|ops. 기본 "register" 유지(회귀 0).
  const [mainTab, setMainTab] = useState("register");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  // PC 는 관리자 콘솔과 같은 형태(고정 사이드바 + 가로 채움), 그 아래 폭은 기존 카드 그대로.
  const wide = useIsWide();
  // 저장된 업체코드가 있으면 **첫 화면부터** 복원 중임을 알린다(빈 코드 입력칸을 먼저 보여주면
  // 담당자가 코드를 다시 치기 시작한다).
  const [restoring, setRestoring] = useState(() => !!loadPartnerSession());
  const [exitAsk, setExitAsk] = useState(false);      // 나가기 확인 모달
  const [logoutAsk, setLogoutAsk] = useState(false);  // 인증 해제 확인 모달
  // 코드는 아직 이 기기에 있는데 못 들어간 상태(통신 실패 등) — 다시 시도 통로를 준다.
  const [restoreFailed, setRestoreFailed] = useState(false);

  // ── 포털 인증(2026-09-04 P3-b) ─────────────────────────
  // 🔴 `authRequired` 가 꺼진(=부재) 거래처에서는 이 셋이 **전부 비어 있고**, 아래 경로들이
  //    예전과 똑같이 돈다. 켠 거래처에서만 비밀번호 화면·승계표·변경 강제가 생긴다.
  const [password, setPassword] = useState("");
  const [authPending, setAuthPending] = useState(null);   // { code, data } — 비밀번호 대기 중
  const [resumeToken, setResumeToken] = useState(null);   // 🔴 화면에 찍거나 URL 에 싣지 말 것
  const [mustSetPassword, setMustSetPassword] = useState(false);

  // ── 앱 안의 뒤로가기(2026-09-02) ────────────────────────
  // 화면 = {step, mainTab, regMode, result} 한 벌. 이동할 때 지금 화면을 스택에 얹고,
  // 뒤로가기가 오면 하나 꺼내 되돌린다. 스택이 비면 그때만 "나가시겠습니까".
  const viewStack = useRef([]);
  const viewRef = useRef(null);
  viewRef.current = { step, mainTab, regMode, result };

  const nav = useBackNav({
    onPop: () => {
      const prev = viewStack.current.pop();
      if (!prev) return false;   // 더 되돌릴 앱 화면이 없다 → 나가기 확인
      setStep(prev.step); setMainTab(prev.mainTab); setRegMode(prev.regMode); setResult(prev.result);
      return true;
    },
    onExitAsk: () => setExitAsk(true),
  });

  // 앱 안에서 한 화면 진입. 🔴 **인증 화면 → 메인은 이 함수를 쓰지 않는다** — 인증은 유지되므로
  //    뒤로가기로 업체코드 입력 화면에 돌아가는 것은 이제 말이 안 된다(메인이 뿌리 화면이다).
  const goto = (patch) => {
    viewStack.current.push(viewRef.current);
    nav.pushView();
    if ("step" in patch) setStep(patch.step);
    if ("mainTab" in patch) setMainTab(patch.mainTab);
    if ("regMode" in patch) setRegMode(patch.regMode);
    if ("result" in patch) setResult(patch.result);
  };

  // ── 인증 통과 후 공통 진입 ──────────────────────────────
  // 🔴 코드-only 경로와 비밀번호 경로가 **같은 함수**를 쓴다 — 두 벌로 두면 한쪽만 고쳐져
  //    «비밀번호를 켠 거래처에서만 노선이 안 뜬다» 같은 결함이 생긴다.
  const enterPortal = async (trimmed, data, rt) => {
    setCodeData(data);
    setRoutes(await fetchPartnerRoutes(data.companyId));
    setResumeToken(rt || null);
    // 코드-only 거래처는 예전과 똑같이 **코드만** 남긴다(승계표 인자 없음).
    savePartnerSession(trimmed, rt ? { resumeToken: rt } : undefined);
    viewStack.current = [];   // 메인이 뿌리 화면 — 여기서 뒤로가면 나가기 확인이다
    setAuthPending(null); setPassword(""); setError("");
    setStep(STEPS.MAIN);
  };

  // ── 저장된 인증 복원(2026-09-02 way "로그인 계속 유지") ──
  // 🔴 저장해 둔 권한을 그대로 믿지 않고 `validatePartnerCode` 로 **서버에 다시 묻는다** —
  //    관리자가 코드를 비활성화·만료시키면 다음 진입에서 바로 막혀야 한다.
  useEffect(() => {
    const saved = loadPartnerSession();
    if (!saved) return undefined;
    let alive = true;
    (async () => {
      try {
        const data = await validatePartnerCode(saved.code);
        if (!alive) return;
        // 🔴 켠 거래처는 승계표(resumeToken)로 되살린다 — 없으면 비밀번호를 다시 묻는다.
        //    승계가 실패해도 **업체코드는 지우지 않는다**(2026-09-02 에 없앤 재타이핑이 돌아온다).
        if (isPartnerAuthRequired(data)) {
          if (saved.resumeToken) {
            try {
              const res = await partnerResume({ companyId: data.companyId, resumeToken: saved.resumeToken });
              if (!alive) return;
              setCode(saved.code);
              await enterPortal(saved.code, data, res.resumeToken);
              if (res.passwordInitial) setMustSetPassword(true);
              return;
            } catch (re) {
              savePartnerSession(saved.code);   // 죽은 승계표만 버린다(코드는 남긴다)
            }
          }
          if (!alive) return;
          setCode(saved.code);
          setAuthPending({ code: saved.code, data });
          return;
        }
        const rs = await fetchPartnerRoutes(data.companyId);
        if (!alive) return;
        setCode(saved.code); setCodeData(data); setRoutes(rs); setStep(STEPS.MAIN);
      } catch (e) {
        // 🔴 **코드가 죽은 경우에만** 저장분을 지운다. 통신 실패로 지워 버리면 담당자는
        //    멀쩡한 20자짜리 코드를 다시 타이핑해야 한다 — 이번에 없애려던 그 불편이다.
        const dead = /유효하지 않은|비활성화된|만료된/.test(e?.message || "");
        if (dead) clearPartnerSession();
        if (alive) {
          setRestoreFailed(!dead);
          setError(dead
            ? `저장된 업체코드를 더는 쓸 수 없습니다\n${e.message}`
            : `저장된 업체코드로 들어가지 못했습니다\n${e.message}`);
        }
      } finally {
        if (alive) setRestoring(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  // SheetJS 로드
  useEffect(() => {
    if (!window.XLSX) {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
      document.head.appendChild(s);
    }
  }, []);

  // 익명 인증 (2026-05-26): boardings/passengers/fcmTokens 등의 rules `isAuth()` 통과용.
  // 기존 EmployeeApp·PassengerApp 패턴과 동일. 백그라운드 진행 — UI 게이팅하지 않음(코드 입력은 partnerCodes public read).
  useEffect(() => { ensureAnonAuth(); }, []);

  // 협력사앱 전용 PWA 아이콘/제목(2026-06) — 설치 시 'BusLink 협력사' + partner 아이콘.
  useEffect(() => {
    applyAppManifest({ manifestHref: "/manifest-partner.json", appleTouchHref: "/icons/passenger-1024.png", title: "BusLink 협력사" });
  }, []);

  const handleCodeSubmit = async () => {
    if (!code.trim()) return;
    setLoading(true); setError("");
    try {
      const trimmed = code.trim();
      const data = await validatePartnerCode(trimmed);
      // 🔴 켠 거래처만 여기서 멈추고 비밀번호를 묻는다. 꺼진 거래처는 곧장 enterPortal —
      //    예전 코드와 같은 순서·같은 부작용이다(코드만 저장·viewStack 비움·MAIN).
      if (isPartnerAuthRequired(data)) {
        setAuthPending({ code: trimmed, data });
        setPassword("");
        setLoading(false);
        return;
      }
      await enterPortal(trimmed, data, null);
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  // 비밀번호 로그인 — 켠 거래처 전용.
  const handlePasswordSubmit = async () => {
    if (!authPending || !password) return;
    setLoading(true); setError("");
    try {
      // 🔴 익명 로그인을 **먼저 끝낸다** — 늦게 착지하면 방금 받은 포털 커스텀 토큰을 덮는다
      //    (2026-09-02 «사람이 타이핑하는 시간이 비동기 선행조건을 덮고 있었다» 와 같은 축).
      await ensureAnonAuth();
      const res = await partnerLogin({
        companyId: authPending.data.companyId, code: authPending.code, password,
      });
      await enterPortal(authPending.code, authPending.data, res.resumeToken);
      if (res.passwordInitial) setMustSetPassword(true);
    } catch (e) { setError(e?.message || String(e)); }
    setLoading(false);
  };

  const handleDone = (res) => goto({ step: STEPS.DONE, result: res });
  // 🔴 "추가 등록하기" 는 **업체코드 인증을 유지**한 채 등록 화면으로만 돌아간다(2026-08-26 게시판
  //    HesnB7nD). 종전에는 step 을 CODE 로 되돌리며 code·codeData 까지 비워, 방금 인증한 담당자가
  //    한 명 더 넣을 때마다 업체코드를 다시 치고 노선까지 다시 받아야 했다.
  //    🔴 물리 뒤로가기와 **같은 길**로 되돌린다(`nav.back()`) — 여기서 따로 state 를 되돌리면
  //      history 항목이 하나 남아 그 다음 뒤로가기가 아무 일도 안 하는 것처럼 보인다.
  //    ⚠ 스택에 얹힌 직전 화면은 `result:null` 이라 평문 비밀번호는 그대로 사라진다
  //      ("이 화면을 벗어나면 다시 볼 수 없습니다" 안내와 한 몸이다). regMode 도 그대로 물려받는다.
  const registerMore = () => { setError(""); nav.back(); };

  // 인증 해제 — 공용 PC 대비. 저장된 코드를 지우고 첫 화면으로 되돌린다.
  const handleLogout = () => {
    // 🔴 서버 승계표까지 끊는다(공용 PC 대비 — 기기 localStorage 만 지우면 그 값이 복사돼
    //    있을 때 계속 살아 있다). best-effort: 실패해도 화면 로그아웃은 진행한다.
    if (resumeToken && codeData?.companyId) {
      partnerLogout({ companyId: codeData.companyId, resumeToken });
    }
    clearPartnerSession();
    viewStack.current = [];
    setLogoutAsk(false);
    setCode(""); setCodeData(null); setRoutes([]); setResult(null); setError("");
    setResumeToken(null); setMustSetPassword(false); setAuthPending(null); setPassword("");
    setMainTab("register"); setRegMode(REG_MODES.FILE);
    setStep(STEPS.CODE);
  };

  // ════════════════════════════════════════════════════════
  // 화면 조각 — 모바일 카드와 PC 셸이 **같은 조각**을 그린다.
  // 🔴 두 벌로 복사하지 말 것: 한쪽만 고쳐지면 "PC 에서만 안 되는" 결함이 생긴다.
  // ════════════════════════════════════════════════════════
  const tabBody = codeData && (
    <>
      {/* ── 승객 등록 탭 ── */}
      {mainTab === "register" && (
        <>
          <div style={S.subTabBar}>
            {[[REG_MODES.FILE,"📂 파일 업로드"],[REG_MODES.SINGLE,"👤 개별 등록"],[REG_MODES.MULTI,"👥 다중 등록"],[REG_MODES.NFC,"📇 카드 등록"]].map(([mode,label])=>(
              <button key={mode} onClick={()=>{ if (regMode !== mode) goto({ regMode: mode }); }}
                style={{ ...S.subTabBtn,
                  background: regMode===mode ? "var(--color-bg)" : "transparent",
                  color: regMode===mode ? "var(--color-primary)" : "var(--color-label-mute)",
                  boxShadow: regMode===mode ? "0 1px 3px rgba(0,0,0,.08)" : "none",
                  fontWeight: regMode===mode ? 700 : 500 }}>
                {label}
              </button>
            ))}
          </div>
          {regMode===REG_MODES.FILE && <FileUploadMode codeData={codeData} code={code} routes={routes} onDone={handleDone}/>}
          {regMode===REG_MODES.SINGLE && <SingleRegMode codeData={codeData} code={code} routes={routes} onDone={handleDone}/>}
          {regMode===REG_MODES.MULTI && <MultiRegMode codeData={codeData} code={code} routes={routes} onDone={handleDone}/>}
          {regMode===REG_MODES.NFC && <NfcRegMode codeData={codeData} code={code}/>}
        </>
      )}

      {/* ── 승객 관리 탭 ── */}
      {mainTab === "manage" && <EmployeeManageMode codeData={codeData} code={code} routes={routes} wide={wide} />}

      {/* ── 탑승 통계 탭 ── */}
      {mainTab === "stats" && <BoardingStatsMode codeData={codeData} code={code} routes={routes} wide={wide} />}

      {/* ── 운영 포털 탭(Phase 1.3) ── */}
      {mainTab === "ops" && <OperationsMode codeData={codeData} code={code} routes={routes} wide={wide} />}
    </>
  );

  const doneBody = result && (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:14, width:"100%", maxWidth:520, margin:"0 auto" }}>
      <div style={{ width:76, height:76, borderRadius:"50%", background:"#E6F7EB", border:"2px solid var(--color-positive)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:34, color:"var(--color-positive)", fontWeight:800 }}>✓</div>
      <div style={{ fontSize:20, fontWeight:800, color:"#007A29", fontFamily:"var(--font-brand)", letterSpacing:"-0.01em" }}>등록 완료!</div>
      <div style={S.resultBox}>
        {[
          ["신규 등록", result.added, "var(--color-primary)"],
          ["정보 업데이트", result.updated, "var(--color-cautionary)"],
          ["비활성화 (퇴사)", result.deactivated, "var(--color-destructive)"],
        ].map(([label, val, color]) => (
          <div key={label} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"9px 0", borderBottom:"1px solid var(--color-line-soft)" }}>
            <span style={{ fontSize:13, color:"var(--color-label-mute)" }}>{label}</span>
            <span style={{ fontSize:15, fontWeight:800, color }}>{val}명</span>
          </div>
        ))}
        {result.errors?.length > 0 && (
          <div style={{ marginTop:10, fontSize:12, color:"var(--color-destructive)", fontWeight:600 }}>오류 {result.errors.length}건 스킵됨</div>
        )}
      </div>
      {/* 초기 PIN 개인별 발급(2026-07-27) — 평문은 저장하지 않으므로 이 화면을
          벗어나면 다시 볼 수 없다. 배부물 인쇄를 여기서 유도한다. */}
      {result.credentials?.length > 0 ? (
        <>
          <div style={{ background:"#FFF8ED", border:"1px solid #FFD9A8", borderRadius:10, padding:"12px 14px", width:"100%" }}>
            <div style={{ fontSize:13, fontWeight:800, color:"#8A5200", marginBottom:5 }}>
              ⚠️ 지금 안내문을 인쇄하세요
            </div>
            <div style={{ fontSize:12, color:"#8A5200", lineHeight:1.6 }}>
              승객마다 서로 다른 비밀번호가 발급되었습니다. 보안을 위해 비밀번호는 저장하지 않으므로,
              <b> 이 화면을 벗어나면 다시 볼 수 없습니다.</b> 나중에 필요하면 “승객 관리”에서 재발급하면 됩니다.
            </div>
          </div>
          <button style={S.btn} onClick={async () => {
            const ok = await printAccountCards({ credentials: result.credentials, partnerName: codeData?.partnerName, routes, partnerCode: code });
            if (!ok) alert("팝업이 차단되었습니다. 브라우저 팝업 차단을 해제한 뒤 다시 시도하세요.");
          }}>
            📄 계정 안내문 인쇄 ({result.credentials.length}명)
          </button>
        </>
      ) : (
        <div style={{ fontSize:12, color:"var(--color-label-mute)", textAlign:"center", lineHeight:1.5 }}>
          신규 등록된 승객이 없어 발급된 비밀번호가 없습니다
        </div>
      )}
      <button style={S.btnSecondary} onClick={registerMore}>추가 등록하기</button>
    </div>
  );

  // 확인 모달 — 어느 레이아웃에서든 같은 자리에 뜬다(fixed 오버레이).
  const dialogs = (
    <>
      {exitAsk && (
        <ConfirmDialog
          title="포털을 나가시겠습니까?"
          body={"지금 나가면 들어오기 전 페이지로 돌아갑니다.\n인증은 이 기기에 유지되므로 다시 들어올 때 업체코드를 또 입력하지 않아도 됩니다."}
          confirmLabel="나가기" cancelLabel="머무르기"
          onConfirm={() => { setExitAsk(false); nav.confirmExit(); }}
          onCancel={() => { setExitAsk(false); nav.cancelExit(); }}
        />
      )}
      {logoutAsk && (
        <ConfirmDialog
          title="인증을 해제할까요?"
          body={"이 기기에 저장된 업체코드를 지웁니다.\n다음에 들어올 때 업체코드를 다시 입력해야 합니다."}
          confirmLabel="인증 해제" cancelLabel="취소" tone="danger"
          onConfirm={handleLogout}
          onCancel={() => setLogoutAsk(false)}
        />
      )}
    </>
  );

  // ── 저장된 인증 복원 중 ──
  if (restoring) {
    return (
      <div style={S.wrap}>
        <div style={{ ...S.card, maxWidth:360, alignItems:"center", textAlign:"center" }}>
          <BusLinkLogo size={26} sub="협력사 포털" />
          <div style={{ fontSize:13, color:"var(--color-label-mute)", marginTop:6 }}>저장된 업체코드로 들어가는 중...</div>
        </div>
      </div>
    );
  }

  // ── 첫 로그인 비밀번호 변경 강제 ──
  // 🔴 통과 전에는 포털 어느 화면도 열지 않는다(승객 FirstPinSetup 과 같은 계약).
  if (mustSetPassword && codeData) {
    return (
      <>
        <PartnerPasswordSetup
          partnerName={codeData.partnerName} code={code}
          onDone={() => setMustSetPassword(false)}
          onLogout={handleLogout}
        />
        {/* 🔴 확인 모달을 여기서도 그린다 — 이 화면에서 뒤로가기를 누르면 나가기 확인이
            떠야 한다. 안 그리면 «뒤로가기가 아무 일도 안 하는» 상태가 된다. */}
        {dialogs}
      </>
    );
  }

  // ════════════════════════════════════════════════════════
  // PC 레이아웃(≥1024px) — 관리자 콘솔과 같은 셸(고정 사이드바 + 가로 채움).
  // 2026-09-02 way: "PC에서는 화면이 가로로 채워져서 우리 어드민 페이지처럼 관리했으면".
  // 인증 화면은 PC 에서도 가운데 카드다(관리자 로그인 화면과 같은 형태).
  // ════════════════════════════════════════════════════════
  if (wide && step !== STEPS.CODE && codeData) {
    return (
      <div style={S.shell}>
        <InstallPrompt />
        {/* ── 사이드바 ── */}
        <div style={S.sideCol}>
          <div style={S.sideLogo}>
            <BusLinkLogo size={22} sub="협력사 포털" />
          </div>
          <div style={S.sidePartner}>
            <div style={{ fontSize:10, color:"var(--color-label-mute)", fontWeight:700 }}>인증된 업체</div>
            <div style={{ fontSize:14, fontWeight:800, color:"var(--color-primary-deep)", fontFamily:"var(--font-brand)", letterSpacing:"-0.01em", marginTop:2, wordBreak:"keep-all" }}>{codeData.partnerName}</div>
            <div style={{ fontSize:10, color:"var(--color-label-alt)", marginTop:2 }}>{codeData.companyId} 소속</div>
          </div>
          <div style={S.sideSection}>메뉴</div>
          <nav style={S.sideNav}>
            {MAIN_TABS.map(item => {
              const on = step === STEPS.MAIN && mainTab === item.key;
              return (
                <div key={item.key} onClick={() => { if (!on) goto({ step: STEPS.MAIN, mainTab: item.key }); }}
                  style={{ ...S.navItem, ...(on ? S.navActive : {}) }}>
                  {on && <span style={S.navAccent} />}
                  <span style={S.navIcon}><Icon name={item.icon} size={17} stroke={on ? 2 : 1.7} /></span>
                  {item.label}
                </div>
              );
            })}
          </nav>
          <button style={S.logoutBtn} onClick={() => setLogoutAsk(true)}>인증 해제</button>
        </div>

        {/* ── 콘텐츠 ── */}
        <div style={S.contentCol}>
          <div style={S.topbar}>
            <div style={{ minWidth:0 }}>
              <div style={{ fontSize:16, fontWeight:800, fontFamily:"var(--font-brand)", letterSpacing:"-0.02em", color:"var(--color-label)" }}>
                {step === STEPS.DONE ? "등록 완료" : tabMeta(mainTab).label}
              </div>
              <div style={{ fontSize:12, color:"var(--color-label-mute)", marginTop:2 }}>
                {step === STEPS.DONE ? "발급된 계정 안내문을 인쇄하세요" : tabMeta(mainTab).desc}
              </div>
            </div>
            <div style={{ display:"flex", alignItems:"center", gap:10, flexShrink:0 }}>
              <Pill tone="positive" dot>인증됨</Pill>
              <span style={{ fontSize:12, color:"var(--color-label-alt)" }}>{codeData.partnerName}</span>
            </div>
          </div>
          <div style={S.main}>
            <div style={{ width:"100%", maxWidth: step === STEPS.DONE ? 560 : (TAB_MAX_W[mainTab] || 1200), margin:"0 auto", display:"flex", flexDirection:"column", gap:14 }}>
              {step === STEPS.MAIN && tabBody}
              {step === STEPS.DONE && doneBody}
            </div>
          </div>
        </div>
        {dialogs}
      </div>
    );
  }

  // ════════════════════════════════════════════════════════
  // 모바일·태블릿(<1024px) — 기존 카드 레이아웃 그대로.
  // ════════════════════════════════════════════════════════
  return (
    <div style={S.wrap}>
      <InstallPrompt />
      <div style={{ ...S.card, maxWidth:
        step === STEPS.MAIN && mainTab === "ops" ? 760 :
        regMode === REG_MODES.MULTI && step === STEPS.MAIN ? 720 :
        480 }}>
        {/* 헤더 */}
        <div style={S.header}>
          <BusLinkLogo size={26} sub="협력사 포털" />
          {step !== STEPS.CODE && codeData && (
            <button style={{ ...S.smallBtn, marginLeft:"auto" }} onClick={() => setLogoutAsk(true)}>인증 해제</button>
          )}
        </div>

        {/* Step 진행 표시 */}
        {step !== STEPS.DONE && (
          <div style={S.stepRow}>
            {[["업체코드 인증", STEPS.CODE], ["승객 등록", STEPS.MAIN]].map(([label, s], i) => {
              const done = step === STEPS.MAIN && s === STEPS.CODE;
              const active = step === s;
              return (
                <div key={s} style={{ display:"flex", alignItems:"center", gap:6, flex: i < 1 ? 1 : "none" }}>
                  <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:4 }}>
                    <div style={{ width:30, height:30, borderRadius:"50%", display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:700,
                      background: done ? "var(--color-positive)" : active ? "var(--color-primary)" : "var(--color-bg-soft)",
                      color: done||active ? "#fff" : "var(--color-label-mute)",
                      border: done||active ? "none" : "1px solid var(--color-line)" }}>
                      {done ? "✓" : i+1}
                    </div>
                    <div style={{ fontSize:11, fontWeight:600, color: active ? "var(--color-primary)" : done ? "var(--color-positive)" : "var(--color-label-mute)", whiteSpace:"nowrap" }}>{label}</div>
                  </div>
                  {i < 1 && <div style={{ flex:1, height:2, background: done ? "var(--color-positive)" : "var(--color-line)", marginBottom:16, borderRadius:2 }}/>}
                </div>
              );
            })}
          </div>
        )}

        {/* ─── STEP 1: 업체코드 ─── */}
        {step === STEPS.CODE && (
          <>
            {/* 🔴 authPending 은 `authRequired` 를 켠 거래처에서만 채워진다 — 꺼진 곳은
                이 분기에 들어오지 않고 아래 업체코드 화면이 예전 그대로 뜬다. */}
            {authPending ? (
              <>
                <div style={S.title}>비밀번호를 입력해주세요</div>
                <div style={S.desc}>
                  <b>{authPending.data.partnerName}</b> 담당자 비밀번호를 입력하세요.<br />
                  운영사에서 받은 초기 비밀번호를 넣으면 새 비밀번호를 정하는 화면으로 넘어갑니다.
                </div>
                <input style={S.input} type="password" placeholder="비밀번호" autoComplete="current-password"
                  value={password} onChange={e => setPassword(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && handlePasswordSubmit()} autoFocus />
                {error && <div style={S.errorMsg}>{error}</div>}
                <button style={{ ...S.btn, marginTop:4, opacity: password ? 1 : 0.5 }}
                  onClick={handlePasswordSubmit} disabled={loading || !password}>
                  {loading ? "확인 중..." : "로그인"}
                </button>
                <button style={S.btnSecondary}
                  onClick={() => { setAuthPending(null); setPassword(""); setError(""); }}>
                  다른 업체코드 입력
                </button>
              </>
            ) : (
              <>
                <div style={S.title}>업체코드를 입력해주세요</div>
                <div style={S.desc}>버스 운영사로부터 발급받은 업체코드를 입력하세요</div>
                <input style={S.input} placeholder="예) DY001-SAMSUNG-2026-A3F9"
                  value={code} onChange={e => setCode(e.target.value.toUpperCase())}
                  onKeyDown={e => e.key === "Enter" && handleCodeSubmit()} autoFocus />
                {error && <div style={S.errorMsg}>{error}</div>}
                <button style={{ ...S.btn, marginTop:4, opacity: code.trim()?1:0.5 }}
                  onClick={handleCodeSubmit} disabled={loading||!code.trim()}>
                  {loading?"확인 중...":"인증하기"}
                </button>
              </>
            )}
            {/* 저장된 코드는 그대로 있는데 통신 문제로 못 들어간 경우 — 다시 치게 하지 않는다. */}
            {restoreFailed && (
              <button style={S.btnSecondary} onClick={() => window.location.reload()}>
                저장된 업체코드로 다시 시도
              </button>
            )}
            <div style={S.notice}>업체코드가 없으시면 통근버스 운영사 담당자에게 문의하세요</div>
          </>
        )}

        {/* ─── STEP 2: 승객 등록 / 관리 탭 ─── */}
        {step === STEPS.MAIN && codeData && (
          <>
            <div style={S.partnerInfo}>
              <div style={{ fontSize:11, color:"var(--color-label-mute)", fontWeight:600 }}>인증된 업체</div>
              <div style={{ fontSize:16, fontWeight:800, color:"var(--color-primary-deep)", fontFamily:"var(--font-brand)", letterSpacing:"-0.01em", marginTop:2 }}>{codeData.partnerName}</div>
              <div style={{ fontSize:11, color:"var(--color-label-alt)", marginTop:2 }}>{codeData.companyId} 소속</div>
            </div>

            {/* 메인 탭 선택 — 2026-05-28 Phase 1.3 운영 포털 탭 추가 (4번째) */}
            <div style={S.tabBar}>
              {MAIN_TABS.map(item=>(
                <button key={item.key} onClick={()=>{ if (mainTab !== item.key) goto({ mainTab: item.key }); }}
                  style={{ ...S.tabBtn,
                    background: mainTab===item.key ? "var(--color-primary)" : "transparent",
                    color: mainTab===item.key ? "#fff" : "var(--color-label-mute)",
                    boxShadow: mainTab===item.key ? "0 2px 6px rgba(0,102,255,.25)" : "none" }}>
                  {item.emoji} {item.label}
                </button>
              ))}
            </div>

            {tabBody}
          </>
        )}

        {/* ─── 완료 ─── */}
        {step === STEPS.DONE && doneBody}
      </div>
      {dialogs}
    </div>
  );
}

// ════════════════════════════════════════════════════════
// 파일 업로드 모드
// ════════════════════════════════════════════════════════
function FileUploadMode({ codeData, code, routes, onDone }) {
  const [file, setFile] = useState(null);
  const [parsed, setParsed] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [previewing, setPreviewing] = useState(false);
  // 진행률(2026-08-28) — 명부가 16,000명대가 되면서 "등록 중..." 한 줄로는 멈춘 것처럼 보인다.
  const [progress, setProgress] = useState(null);   // { phase:'scan'|'write', done, total }

  const handleFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f); setError(""); setParsed(null);
    setLoading(true);
    try {
      const result = await parseEmployeeExcel(f);
      setParsed(result);
      if (result.employees.length > 0) setPreviewing(true);
    } catch(e) { setError(e.message); }
    setLoading(false);
  };

  const handleImport = async () => {
    if (!parsed) return;
    setLoading(true); setProgress(null);
    try {
      const res = await importEmployees({
        companyId:codeData.companyId, partnerCode:code, partnerName:codeData.partnerName,
        employees:parsed.employees, routes,
        onProgress: (p) => setProgress(p),
      });
      onDone(res);
    } catch(e) { setError(e.message); }
    setProgress(null);
    setLoading(false);
  };

  // 진행 문구 — 인원이 많을 때만 숫자를 보여준다(적을 땐 순식간이라 깜빡임만 된다).
  const progressText = !loading ? null
    : progress && progress.total > 500
      ? (progress.phase === "scan"
          ? `기존 명부 확인 중... ${progress.done}/${progress.total}`
          : `등록 중... ${progress.done.toLocaleString()} / ${progress.total.toLocaleString()}명`)
      : "등록 중...";

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
      {!previewing ? (
        <>
          <button onClick={downloadSampleExcel} style={S.btnSecondary}>📥 엑셀 양식 다운로드</button>
          <div style={S.excelGuide}>
            <div style={{ fontWeight:700, marginBottom:10, color:"#B95300", fontSize:13 }}>📋 양식 작성 안내</div>
            {[["사번","필수 · 숫자 또는 문자"],["이름","필수"],["부서","선택 · 통계 사용"],["노선코드","선택 · 예) 662"],["재직여부","Y / N"],["NFC카드번호","선택 · 비우면 기존 등록 유지"],["초기PIN","선택 · 비우면 000000"]].map(([k,v])=>(
              <div key={k} style={{ display:"flex", gap:10, fontSize:12, marginBottom:4 }}>
                <span style={{ color:"var(--color-primary)", fontWeight:700, minWidth:60 }}>{k}</span>
                <span style={{ color:"var(--color-label-mute)" }}>{v}</span>
              </div>
            ))}
          </div>
          <label style={S.fileLabel}>
            <input type="file" accept=".xlsx,.xls,.csv" onChange={handleFile} style={{ display:"none" }} />
            {file ? (
              <><div style={{ color:"var(--color-primary)", fontWeight:700, fontSize:14 }}>📎 {file.name}</div><div style={{ fontSize:11, color:"var(--color-label-mute)", marginTop:6 }}>클릭하여 다시 선택</div></>
            ) : (
              <><div style={{ fontSize:28, marginBottom:8 }}>📂</div><div style={{ fontWeight:700, color:"var(--color-label)" }}>클릭하여 파일 선택</div><div style={{ fontSize:11, color:"var(--color-label-mute)", marginTop:6 }}>.xlsx .xls .csv 지원</div></>
            )}
          </label>
          {loading && <div style={{ color:"var(--color-label-mute)", fontSize:13, textAlign:"center" }}>파일 분석 중...</div>}
        </>
      ) : parsed && (
        <>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
            {[["총 인원",parsed.total,"var(--color-primary)"],["재직자",parsed.employees.filter(e=>e.active).length,"var(--color-positive)"],["퇴사",parsed.employees.filter(e=>!e.active).length,"var(--color-destructive)"]].map(([l,v,c])=>(
              <div key={l} style={S.statCard}>
                <div style={{ fontSize:22, fontWeight:800, color:c, fontFamily:"var(--font-brand)" }}>{v}</div>
                <div style={{ fontSize:11, color:"var(--color-label-mute)", marginTop:2, fontWeight:600 }}>{l}</div>
              </div>
            ))}
          </div>
          {parsed.errors.length > 0 && (
            <div style={S.warnBox}>
              <div style={{ fontSize:12, color:"var(--color-destructive)", fontWeight:700, marginBottom:4 }}>⚠️ 확인 필요 {parsed.errors.length}건</div>
              {parsed.errors.slice(0,6).map((e,i)=><div key={i} style={{ fontSize:11, color:"#A81818" }}>{e}</div>)}
              {parsed.errors.length > 6 && (
                <div style={{ fontSize:11, color:"#A81818" }}>… 외 {parsed.errors.length - 6}건</div>
              )}
              {/* 중복 사번이 있으면 실제 등록 인원이 줄어든다 — 숫자로 미리 알린다 */}
              {typeof parsed.uniqueCount === "number" && parsed.uniqueCount < parsed.total && (
                <div style={{ fontSize:11, color:"#A81818", fontWeight:700, marginTop:4 }}>
                  사번이 겹쳐서 {parsed.total}명 중 실제로는 {parsed.uniqueCount}명만 등록됩니다
                </div>
              )}
            </div>
          )}
          <div style={S.previewTableWrap}>
            <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
              <thead><tr>{["사번","이름","부서","노선","재직"].map(h=><th key={h} style={S.previewTh}>{h}</th>)}</tr></thead>
              <tbody>
                {parsed.employees.slice(0,8).map((e,i)=>(
                  <tr key={i}>
                    <td style={{ ...S.previewTd, color:"var(--color-label)" }}>{e.empNo}</td>
                    <td style={{ ...S.previewTd, fontWeight:700 }}>{e.name}</td>
                    <td style={{ ...S.previewTd, color:"var(--color-label-mute)" }}>{e.dept||"–"}</td>
                    <td style={{ ...S.previewTd, color:"var(--color-label-mute)" }}>{e.routeCode||"–"}</td>
                    <td style={S.previewTd}>
                      <Pill tone={e.active?"positive":"danger"} dot>{e.active?"재직":"퇴사"}</Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {parsed.total > 8 && <div style={{ padding:"8px 12px", fontSize:11, color:"var(--color-label-alt)", textAlign:"center" }}>외 {parsed.total-8}명...</div>}
          </div>
          {error && <div style={S.errorMsg}>{error}</div>}
          <div style={{ display:"flex", gap:8 }}>
            <button style={{ ...S.btn, opacity:loading?0.6:1 }} onClick={handleImport} disabled={loading}>
              {loading ? progressText : `✅ ${parsed.total}명 등록하기`}
            </button>
            <button style={{ ...S.btnSecondary, flex:"0 0 80px" }} onClick={()=>{setPreviewing(false);setParsed(null);setFile(null);}}>다시</button>
          </div>
        </>
      )}
      {error && !previewing && <div style={S.errorMsg}>{error}</div>}
    </div>
  );
}

// ════════════════════════════════════════════════════════
// 개별 등록 모드
// ════════════════════════════════════════════════════════
function SingleRegMode({ codeData, code, routes, onDone }) {
  const empty = { empNo:"", name:"", dept:"", routeCode:"", active:true, pinLocked:false, nfcUid:"" };
  const [form, setForm] = useState(empty);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSave = async () => {
    if (!form.empNo.trim()) return setError("사번은 필수입니다");
    if (!form.name.trim()) return setError("이름은 필수입니다");
    // NFC 카드번호는 선택 입력 — 입력했다면 형식은 맞아야 한다(오타를 등록 시점에 차단).
    if (form.nfcUid.trim() && !isValidNfcUid(form.nfcUid)) {
      return setError("NFC 카드번호 형식이 올바르지 않습니다\n카드에 적힌 16진수(예: 0453CE9A)를 입력해주세요");
    }
    setLoading(true); setError("");
    try {
      const res = await importEmployees({
        companyId: codeData.companyId, partnerCode: code, partnerName: codeData.partnerName,
        employees: [{ ...form, empNo: form.empNo.trim(), name: form.name.trim(), dept: form.dept.trim(), active: form.active, pinLocked: !!form.pinLocked, nfcUid: normalizeNfcUid(form.nfcUid) }],
        routes,
      });
      onDone(res);
    } catch(e) { setError(e.message); }
    setLoading(false);
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
      <div style={{ display:"flex", gap:8 }}>
        <div style={{ flex:1 }}>
          <label style={S.label}>사번 *</label>
          <input style={S.input} placeholder="10001" value={form.empNo} onChange={e=>setForm({...form,empNo:e.target.value})} />
        </div>
        <div style={{ flex:1 }}>
          <label style={S.label}>이름 *</label>
          <input style={S.input} placeholder="홍길동" value={form.name} onChange={e=>setForm({...form,name:e.target.value})} />
        </div>
      </div>
      <div style={{ display:"flex", gap:8 }}>
        <div style={{ flex:1 }}>
          <label style={S.label}>부서</label>
          <input style={S.input} placeholder="개발팀" value={form.dept} onChange={e=>setForm({...form,dept:e.target.value})} />
        </div>
        <div style={{ flex:1 }}>
          <label style={S.label}>노선</label>
          <select style={S.input} value={form.routeCode} onChange={e=>setForm({...form,routeCode:e.target.value})}>
            <option value="">노선 선택</option>
            {partnerRouteOptions(routes, code, form.routeCode).map(r=><option key={r.id} value={r.code||r.id}>{r.name} ({r.code||r.id})</option>)}
          </select>
          {partnerRouteOptions(routes, code).length === 0 && (
            <div style={{ fontSize:11, color:"var(--color-label-mute)", marginTop:4 }}>
              지정된 노선이 없습니다 — 관리자에게 노선 지정을 요청해 주세요
            </div>
          )}
        </div>
      </div>
      <label style={S.checkBox}>
        <input type="checkbox" checked={form.active} onChange={e=>setForm({...form,active:e.target.checked})}
          style={{ accentColor:"var(--color-primary)", width:16, height:16, cursor:"pointer" }} />
        <span style={{ fontSize:13, color:"var(--color-label)", fontWeight:500 }}>재직 중 (체크 해제 시 비활성화)</span>
      </label>
      {/* 공용/통합 계정 보호(2026-07-21) — 여러 명이 함께 쓰는 계정은 한 사람이 PIN 을
          바꾸면 나머지가 전부 못 들어온다. 체크 시 승객앱 설정에서 PIN 변경 숨김. */}
      <label style={S.checkBox}>
        <input type="checkbox" checked={form.pinLocked} onChange={e=>setForm({...form,pinLocked:e.target.checked})}
          style={{ accentColor:"var(--color-primary)", width:16, height:16, cursor:"pointer" }} />
        <span style={{ fontSize:13, color:"var(--color-label)", fontWeight:500 }}>PIN 변경 잠금 (여러 명이 함께 쓰는 공용 계정)</span>
      </label>
      {/* NFC 사원증(2026-07-22) — 기사앱 태깅 시 이 값으로 사람을 찾는다.
          입력은 자유 형식(대소문자·콜론 허용)이고 저장은 normalizeNfcUid 로 통일. */}
      <div>
        <label style={S.label}>NFC 카드번호 (선택)</label>
        <input style={S.input} placeholder="0453CE9A 또는 04:53:CE:9A"
          value={form.nfcUid} onChange={e=>setForm({...form,nfcUid:e.target.value})} />
        <div style={{ fontSize:11, color:"var(--color-label-alt)", marginTop:4, lineHeight:1.5 }}>
          사원증 카드에 적힌 16진수 번호. 등록하면 기사앱에서 카드를 대는 것만으로 탑승 처리됩니다.
        </div>
      </div>
      {error && <div style={S.errorMsg}>{error}</div>}
      <div style={{ display:"flex", gap:8 }}>
        <button style={{ ...S.btn, opacity:loading?0.6:1 }} onClick={handleSave} disabled={loading}>
          {loading?"등록 중...":"✅ 등록하기"}
        </button>
        <button style={{ ...S.btnSecondary, flex:"0 0 80px" }} onClick={()=>setForm(empty)}>초기화</button>
      </div>
      <div style={{ fontSize:11, color:"var(--color-label-alt)", textAlign:"center" }}>비밀번호는 승객마다 다르게 자동 발급되며, 등록 후 안내문으로 인쇄할 수 있습니다</div>
    </div>
  );
}

// ════════════════════════════════════════════════════════
// 다중 등록 모드 (행 추가 방식)
// ════════════════════════════════════════════════════════
function MultiRegMode({ codeData, code, routes, onDone }) {
  const newRow = (id) => ({ id, empNo:"", name:"", dept:"", routeCode:"", active:true });
  const [rows, setRows] = useState([newRow(1), newRow(2), newRow(3)]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [nextId, setNextId] = useState(4);

  const addRow = () => { setRows(p=>[...p, newRow(nextId)]); setNextId(n=>n+1); };
  const removeRow = (id) => setRows(p=>p.filter(r=>r.id!==id));
  const updateRow = (id, field, value) => setRows(p=>p.map(r=>r.id===id?{...r,[field]:value}:r));

  const handleSave = async () => {
    const valid = rows.filter(r=>r.empNo.trim()&&r.name.trim());
    if (valid.length===0) return setError("최소 1명의 사번과 이름을 입력해주세요");
    setLoading(true); setError("");
    try {
      const res = await importEmployees({
        companyId: codeData.companyId, partnerCode: code, partnerName: codeData.partnerName,
        employees: valid.map(r=>({...r, empNo:r.empNo.trim(), name:r.name.trim(), dept:r.dept.trim()})),
        routes,
      });
      onDone(res);
    } catch(e) { setError(e.message); }
    setLoading(false);
  };

  const validCount = rows.filter(r=>r.empNo.trim()&&r.name.trim()).length;

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
      {/* 컬럼 헤더 */}
      <div style={{ display:"grid", gridTemplateColumns:"100px 90px 80px 1fr 40px 30px", gap:6, padding:"0 4px" }}>
        {["사번 *","이름 *","부서","노선","재직",""].map(h=>(
          <div key={h} style={{ fontSize:11, color:"var(--color-label-mute)", fontWeight:700 }}>{h}</div>
        ))}
      </div>

      {/* 행 목록 */}
      <div style={{ display:"flex", flexDirection:"column", gap:6, maxHeight:320, overflowY:"auto" }}>
        {rows.map(row=>(
          <div key={row.id} style={{ display:"grid", gridTemplateColumns:"100px 90px 80px 1fr 40px 30px", gap:6, alignItems:"center" }}>
            <input style={S.inputSm} placeholder="사번" value={row.empNo}
              onChange={e=>updateRow(row.id,"empNo",e.target.value)} />
            <input style={S.inputSm} placeholder="이름" value={row.name}
              onChange={e=>updateRow(row.id,"name",e.target.value)} />
            <input style={S.inputSm} placeholder="부서" value={row.dept}
              onChange={e=>updateRow(row.id,"dept",e.target.value)} />
            <select style={S.inputSm} value={row.routeCode}
              onChange={e=>updateRow(row.id,"routeCode",e.target.value)}>
              <option value="">노선</option>
              {partnerRouteOptions(routes, code, row.routeCode).map(r=><option key={r.id} value={r.code||r.id}>{r.code||r.name.substring(0,8)}</option>)}
            </select>
            <div style={{ display:"flex", justifyContent:"center" }}>
              <input type="checkbox" checked={row.active}
                onChange={e=>updateRow(row.id,"active",e.target.checked)}
                style={{ accentColor:"var(--color-primary)", width:16, height:16, cursor:"pointer" }} />
            </div>
            <button onClick={()=>removeRow(row.id)} disabled={rows.length<=1}
              style={{ background:"transparent", border:"none", color:"var(--color-destructive)", cursor:"pointer", fontSize:14, opacity:rows.length<=1?0.3:1, padding:0 }}>
              ✕
            </button>
          </div>
        ))}
      </div>

      {/* 행 추가 */}
      <button onClick={addRow} style={{ ...S.btnSecondary, fontSize:13 }}>+ 행 추가</button>

      {/* 요약 */}
      <div style={S.summaryBox}>
        <span style={{ color:"var(--color-label-mute)" }}>총 {rows.length}행 입력 중</span>
        <span style={{ color:"var(--color-primary)", fontWeight:700 }}>유효 {validCount}명 등록 예정</span>
      </div>

      {error && <div style={S.errorMsg}>{error}</div>}

      <button style={{ ...S.btn, opacity:(loading||validCount===0)?0.5:1 }}
        onClick={handleSave} disabled={loading||validCount===0}>
        {loading?`등록 중...`:`✅ ${validCount}명 등록하기`}
      </button>
      <div style={{ fontSize:11, color:"var(--color-label-alt)", textAlign:"center" }}>사번·이름이 비어있는 행은 자동 제외됩니다 · 비밀번호는 승객마다 다르게 자동 발급</div>
    </div>
  );
}

// ════════════════════════════════════════════════════════
// NFC 카드 일괄 등록 모드 (2026-07-22)
//
// 기존 사원증·출입카드를 재사용하는 현장은 회사에 UID 목록이 없다 → 카드를 한 번씩
// 읽어내야 한다. 승객 자가등록은 **아이폰 웹이 NFC 를 못 읽어** 채택하지 않았다
// (way 결정: 아이폰 사용자 비중이 높음) → 담당자가 **안드로이드 1대로 줄 세워 일괄 등록**.
//
// 흐름 최적화: 이름 선택 → 카드 태그 → 자동으로 선택 해제 + 검색어 초기화 →
// 바로 다음 사람. 1인당 3초를 목표로 클릭 수를 최소화한다.
//
// ⚠ Web NFC = 안드로이드 크롬 전용. PC·아이폰에서는 이 모드가 동작하지 않으므로
//    이유와 대안(엑셀 컬럼·개별 입력)을 화면에서 명시한다.
// ════════════════════════════════════════════════════════
function NfcRegMode({ codeData, code }) {
  const supported = isWebNfcSupported();
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [msg, setMsg] = useState(null);
  const [errMsg, setErrMsg] = useState("");
  const abortRef = useRef(null);
  const cooldownRef = useRef(createTagCooldown(2000));
  const handlerRef = useRef(() => {});
  const busyRef = useRef(false);

  useEffect(() => {
    if (!codeData?.companyId || !code) return;
    const q = query(
      collection(db, "companies", codeData.companyId, "passengers"),
      where("partnerCode", "==", code)
    );
    const unsub = onSnapshot(q, (snap) => {
      setEmployees(snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(e => e.active !== false)
        .sort((a, b) => (a.name || "").localeCompare(b.name || "", "ko")));
      setLoading(false);
    }, () => setLoading(false));
    return () => unsub();
  }, [codeData?.companyId, code]);

  useEffect(() => () => { try { abortRef.current?.abort(); } catch (_) {} }, []);

  const start = async () => {
    setErrMsg("");
    try {
      const ndef = new window.NDEFReader();
      const ac = new AbortController();
      abortRef.current = ac;
      await ndef.scan({ signal: ac.signal });
      ndef.onreadingerror = () => setErrMsg("카드를 읽지 못했습니다. 다시 태그해주세요");
      // ⚠ onreading 은 scan() 시점 클로저를 붙든다 → ref 경유로 최신 선택 승객을 본다.
      ndef.onreading = (e) => handlerRef.current(e?.serialNumber);
      setScanning(true);
    } catch (e) {
      setScanning(false);
      setErrMsg(e?.name === "NotAllowedError"
        ? "NFC 권한이 거부되었습니다.\n브라우저 설정에서 이 사이트의 NFC 를 허용해주세요"
        : "NFC 시작 오류: " + (e?.message || e));
    }
  };

  const stop = () => {
    try { abortRef.current?.abort(); } catch (_) {}
    abortRef.current = null;
    setScanning(false);
  };

  const onTag = async (serial) => {
    const uid = normalizeNfcUid(serial);
    if (!uid || !cooldownRef.current(uid) || busyRef.current) return;
    if (!selected) { setMsg({ ok: false, text: "먼저 등록할 승객을 선택해주세요" }); return; }
    busyRef.current = true;
    try {
      const r = await registerNfcCard({
        companyId: codeData.companyId, empNo: selected.id, uid, partnerCode: code,
      });
      setMsg({ ok: true, text: `${r.name || selected.name}님 ${r.replaced ? "카드 교체 완료" : "등록 완료"}` });
      if ("vibrate" in navigator) navigator.vibrate([100, 50, 100]);
      // 바로 다음 사람으로 — 연속 등록이 끊기지 않게 선택·검색어 초기화
      setSelected(null); setSearch("");
    } catch (e) {
      setMsg({ ok: false, text: e?.message || String(e) });
      if ("vibrate" in navigator) navigator.vibrate([200, 80, 200]);
    } finally { busyRef.current = false; }
  };
  handlerRef.current = onTag;

  const done = employees.filter(e => e.nfcUid).length;
  const filtered = (() => {
    const q = search.trim().toLowerCase();
    const base = employees;
    if (!q) return base;
    return base.filter(e => (e.name || "").toLowerCase().includes(q) || (e.empNo || "").toLowerCase().includes(q));
  })();

  if (!supported) {
    return (
      <div style={{ padding: 16, borderRadius: 12, background: "var(--color-bg-soft)", border: "1px solid var(--color-line)", fontSize: 13, lineHeight: 1.7, color: "var(--color-label-mute)" }}>
        <div style={{ fontWeight: 800, color: "var(--color-label)", marginBottom: 6 }}>이 기기에서는 카드 태깅을 쓸 수 없습니다</div>
        NFC 태깅은 <b>안드로이드 + 크롬</b>에서만 동작합니다(PC·아이폰 미지원).
        <br />· 안드로이드 폰·태블릿에서 <b>크롬으로</b> 이 포털에 접속해주세요.
        <br />· 카드번호를 이미 알고 있다면 <b>파일 업로드</b>(NFC카드번호 컬럼) 또는
        <b> 승객 관리 → 수정</b>에서 직접 입력할 수 있습니다.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 12, color: "var(--color-label-mute)", lineHeight: 1.6 }}>
        안드로이드 폰 한 대로 <b>승객을 줄 세워 연속 등록</b>할 수 있습니다.
        이름을 고르고 그 사람 사원증을 폰 뒷면에 대면 바로 다음 사람으로 넘어갑니다.
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ flex: 1, height: 8, borderRadius: 4, background: "var(--color-bg-soft)", overflow: "hidden" }}>
          <div style={{ width: `${employees.length ? (done / employees.length) * 100 : 0}%`, height: "100%", background: "var(--color-positive)" }} />
        </div>
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--color-label-mute)", whiteSpace: "nowrap" }}>
          {done} / {employees.length}명 등록
        </span>
      </div>

      {!scanning
        ? <button style={S.btn} onClick={start}>📇 카드 읽기 시작</button>
        : <button style={{ ...S.btn, background: "var(--color-bg-soft)", color: "var(--color-label-mute)" }} onClick={stop}>중지</button>}

      {selected && (
        <div style={{ padding: "12px 14px", borderRadius: 12, background: "var(--color-primary-soft)", border: "2px solid var(--color-primary)", textAlign: "center" }}>
          <div style={{ fontSize: 12, color: "var(--color-label-mute)" }}>선택됨</div>
          <div style={{ fontSize: 17, fontWeight: 800 }}>{selected.name} <span style={{ fontSize: 12, color: "var(--color-label-mute)" }}>({selected.empNo})</span></div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--color-primary-deep)", marginTop: 6 }}>
            {scanning ? "이 승객의 사원증을 태그하세요" : "‘카드 읽기 시작’을 먼저 눌러주세요"}
          </div>
        </div>
      )}

      {msg && (
        <div style={{
          padding: "10px 14px", borderRadius: 10, fontSize: 13, fontWeight: 700, whiteSpace: "pre-line", lineHeight: 1.6,
          background: msg.ok ? "#E6F7EB" : "#FCE5E5",
          color: msg.ok ? "#007A29" : "var(--color-destructive)",
          border: `1px solid ${msg.ok ? "#B7E6C7" : "#F6C9C9"}`,
        }}>{msg.text}</div>
      )}
      {errMsg && <div style={S.errorMsg}>{errMsg}</div>}

      <input style={{ ...S.input, padding: "9px 12px" }} placeholder="이름·사번 검색"
        value={search} onChange={e => setSearch(e.target.value)} />

      <div style={{ maxHeight: 300, overflowY: "auto", border: "1px solid var(--color-line)", borderRadius: 10 }}>
        {loading ? <div style={{ padding: 16, textAlign: "center", fontSize: 13, color: "var(--color-label-alt)" }}>명단 불러오는 중…</div>
          : filtered.length === 0 ? <div style={{ padding: 16, textAlign: "center", fontSize: 13, color: "var(--color-label-alt)" }}>
            {employees.length === 0 ? "등록된 승객이 없습니다" : "검색 결과가 없습니다"}</div>
            : filtered.map(e => (
              <button key={e.id} onClick={() => { setSelected(e); setMsg(null); }}
                style={{
                  display: "flex", width: "100%", alignItems: "center", justifyContent: "space-between", gap: 8,
                  padding: "11px 12px", border: "none", borderBottom: "1px solid var(--color-line-soft)",
                  background: selected?.id === e.id ? "var(--color-primary-soft)" : "var(--color-bg)",
                  cursor: "pointer", fontFamily: "inherit", textAlign: "left",
                }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: "var(--color-label)" }}>
                  {e.name} <span style={{ fontSize: 11, color: "var(--color-label-mute)" }}>{e.empNo}</span>
                </span>
                {e.nfcUid
                  ? <span style={{ fontSize: 10, fontWeight: 700, color: "#007A29", background: "#E6F7EB", padding: "2px 7px", borderRadius: 10, whiteSpace: "nowrap" }}>✓ {formatNfcUid(e.nfcUid)}</span>
                  : <span style={{ fontSize: 10, color: "var(--color-label-alt)" }}>미등록</span>}
              </button>
            ))}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════
// 직원 관리 모드 — 조회 + 수정 + 비활성화
// ════════════════════════════════════════════════════════
function EmployeeManageMode({ codeData, code, routes, wide = false }) {
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterActive, setFilterActive] = useState("전체"); // 전체|재직|퇴사
  // 🔴 표시 상한(2026-08-28) — 예전엔 걸러진 인원을 **전부** 카드로 그렸다. 250명 전제에선
  //    괜찮았지만 신촌세브란스병원 명부가 16,155명이 되면서 카드 하나에 DOM 15개꼴이라
  //    브라우저가 25만 노드를 그리다 멈췄다(게시판 「협력사페이지 느려짐」). 집계·검색은
  //    전체를 그대로 쓰고 **그리는 것만** 끊는다 — 숫자가 틀려지면 안 되므로.
  const PAGE = 100;
  const [shown, setShown] = useState(PAGE);
  const [editEmp, setEditEmp] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [saving, setSaving] = useState(false);
  // 승객 삭제(2026-07-30) — 확인 단계를 거치는 인라인 방식. delTarget = 확인 중인 사번.
  const [delTarget, setDelTarget] = useState(null);
  const [delBusy, setDelBusy] = useState(false);
  const [delMsg, setDelMsg] = useState("");
  const [msg, setMsg] = useState(null);
  // PIN 재발급 결과(평문 PIN 포함 — 모달을 닫으면 다시 볼 수 없다).
  const [pinResult, setPinResult] = useState(null);
  const [pinBusy, setPinBusy] = useState(false);

  // 실시간 직원 목록
  useEffect(() => {
    if (!codeData?.companyId || !code) return;
    setLoading(true);
    const q = query(
      collection(db, "companies", codeData.companyId, "passengers"),
      where("partnerCode", "==", code)
    );
    return onSnapshot(q, snap => {
      setEmployees(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      setLoading(false);
    });
  }, [codeData, code]);

  const filtered = employees.filter(e => {
    if (filterActive === "재직" && !e.active) return false;
    if (filterActive === "퇴사" && e.active) return false;
    if (search && !e.name?.includes(search) && !e.empNo?.includes(search) && !e.dept?.includes(search)) return false;
    return true;
  });
  // 검색어·필터가 바뀌면 처음부터 다시 100명 — 앞에서 더 보기를 눌러 둔 상태가 따라오면
  // 좁혀 놓고도 여전히 수천 장을 그린다.
  useEffect(() => { setShown(PAGE); }, [search, filterActive]);
  const visible = filtered.slice(0, shown);

  // 🔴 "아직 시작 안 한" 승객 판정(2026-07-27) — 접속 기록 없음 **AND** 발급받은 초기
  //   비밀번호를 그대로 둔 상태. `lastLoginAt` 은 이 날 신설한 필드라 그 전에 접속한
  //   사람에게는 아예 없다 → `!lastLoginAt` 만으로 판정하면 **이미 본인 비밀번호로
  //   잘 쓰고 있는 사람이 재발급 대상에 들어가 로그인 불가**가 된다. pinInitial 을 AND 로
  //   걸어 그 사고를 막는다(조건 완화 금지).
  const isUnstarted = (e) => !e.lastLoginAt && !!e.pinInitial;

  const openEdit = (emp) => {
    setEditEmp(emp);
    setEditForm({ name: emp.name||"", dept: emp.dept||"", routeCode: emp.routeCode||"", active: emp.active, pinLocked: !!emp.pinLocked, nfcUid: emp.nfcUid||"" });
    setMsg(null);
  };

  const handleSave = async () => {
    const rawUid = (editForm.nfcUid || "").trim();
    if (rawUid && !isValidNfcUid(rawUid)) {
      setMsg({ type: "error", text: "NFC 카드번호 형식이 올바르지 않습니다 (예: 0453CE9A)" });
      return;
    }
    setSaving(true); setMsg(null);
    try {
      const routeId = routes.find(r => r.code === editForm.routeCode || r.id === editForm.routeCode)?.id || editForm.routeCode;
      await updateDoc(
        doc(db, "companies", codeData.companyId, "passengers", editEmp.id),
        // nfcUid: 빈 입력이면 null 로 지운다(카드 분실·회수 시 해제 경로).
        { name: editForm.name.trim(), dept: editForm.dept.trim(), routeCode: editForm.routeCode, routeId, active: editForm.active, pinLocked: !!editForm.pinLocked, nfcUid: rawUid ? normalizeNfcUid(rawUid) : null, updatedAt: serverTimestamp() }
      );
      setMsg({ type: "success", text: "저장되었습니다" });
      setTimeout(() => { setEditEmp(null); setMsg(null); }, 800);
    } catch(e) {
      setMsg({ type: "error", text: "저장 실패: " + e.message });
    }
    setSaving(false);
  };

  // ── 승객 삭제(2026-07-30 배시현 개선요청 — 테스트·오류 계정 정리용) ──────
  // 퇴사 처리(active=false)와 다른 동작이다. 퇴사는 목록에 남지만 삭제는 문서를 지운다.
  // ⚠ 과거 탑승 기록(boardings)은 이름·사번을 자체 보관하므로 통계가 깨지지 않는다.
  //   되돌릴 수 없으니 목록에서 한 단계 확인(delTarget)을 거친 뒤에만 실행한다.
  const handleDelete = async (emp) => {
    setDelBusy(true);
    try {
      await deleteDoc(doc(db, "companies", codeData.companyId, "passengers", emp.id));
      setEmployees(prev => prev.filter(x => x.id !== emp.id));
      setDelTarget(null);
      setDelMsg(`${emp.name || emp.empNo} 삭제되었습니다`);
      setTimeout(() => setDelMsg(""), 2500);
    } catch (e) {
      setDelMsg(`삭제하지 못했습니다: ${e.message}`);
    }
    setDelBusy(false);
  };

  // ── PIN 재발급(2026-07-27) ─────────────────────────────
  // 예전엔 전원 "000000" 으로 되돌렸다. 사번만 알면 남의 계정에 들어갈 수 있어
  // 개인별 랜덤 발급으로 바꿨고, 평문은 저장하지 않으므로 발급 결과를 모달에서
  // 바로 인쇄(또는 메모)하게 한다.
  const handleResetPin = async (emp) => {
    if (!window.confirm(`${emp.name}(${emp.empNo})의 비밀번호를 새로 발급하시겠습니까?\n\n기존 비밀번호는 즉시 사용할 수 없게 됩니다.`)) return;
    setPinBusy(true);
    const res = await reissuePins({ companyId: codeData.companyId, partnerCode: code, passengers: [{ empNo: emp.id, name: emp.name, dept: emp.dept, routeCode: emp.routeCode }] });
    setPinBusy(false);
    setPinResult(res);
  };

  // 미접속자(=배부가 아직 도달하지 않았을 가능성이 큰 인원) 일괄 재발급.
  // 이 사람들은 관리자가 발급한 초기 비밀번호를 그대로 두고 있으므로 새로 발급해도 잃을 게 없다.
  // 이미 본인 비밀번호로 바꾼 사람은 대상에서 제외된다(로그인 못 하게 되는 사고 차단).
  const handleReissueUnvisited = async () => {
    const targets = filtered.filter(e => e.active && isUnstarted(e));
    if (targets.length === 0) return alert("아직 시작하지 않은 재직 승객이 없습니다.");
    if (!window.confirm(`아직 앱을 시작하지 않은 ${targets.length}명의 비밀번호를 새로 발급하고 안내문을 인쇄합니다.\n\n이미 본인 비밀번호로 바꿔 사용 중인 승객은 대상에서 제외됩니다.\n계속하시겠습니까?`)) return;
    setPinBusy(true);
    const res = await reissuePins({ companyId: codeData.companyId, partnerCode: code, passengers: targets.map(e => ({ empNo: e.id, name: e.name, dept: e.dept, routeCode: e.routeCode })) });
    setPinBusy(false);
    setPinResult(res);
  };

  const handlePrintPinResult = async () => {
    const ok = await printAccountCards({ credentials: pinResult.credentials, partnerName: codeData?.partnerName, routes, partnerCode: code });
    if (!ok) alert("팝업이 차단되었습니다. 브라우저 팝업 차단을 해제한 뒤 다시 시도하세요.");
  };

  // 정원 대비 등록 인원(2026-07-30) — 노선 좌석수 대비 몇 명 배정됐는지. 이미 갖고 있는
  // 승객 목록·노선으로 집계하므로 신규 조회 0. 이 거래처 노선만 보여준다.
  const seat = seatUsage(partnerRouteOptions(routes, code), employees.map(e => ({ routeId: e.routeId || e.routeCode, active: e.active })));
  const seatRows = Object.entries(seat)
    .map(([rid, u]) => ({ rid, ...u, name: (routes.find(r => r.id === rid) || {}).name || rid }))
    .filter(u => u.registered > 0 || u.seats)
    .sort((a, b) => (b.over ? 1 : 0) - (a.over ? 1 : 0) || b.registered - a.registered);

  // 행 조작 버튼 — 카드(모바일)와 표(PC)가 **같은 것**을 쓴다.
  // 🔴 삭제는 되돌릴 수 없으므로 한 단계 확인을 거친다(2026-07-30 요청: 테스트·오류 계정 정리용).
  //    퇴사 처리(재직 토글)와는 다른 동작임을 문구로 구분해 실수로 지우지 않게 한다.
  const rowActions = (emp) => (
    <div style={{ display:"inline-flex", gap:4, flexShrink:0, flexWrap:"wrap", justifyContent:"flex-end" }}>
      <button onClick={()=>openEdit(emp)} style={S.smallBtn}>수정</button>
      <button onClick={()=>handleResetPin(emp)} style={S.smallBtnWarn} disabled={pinBusy}>비밀번호 재발급</button>
      {delTarget === emp.empNo ? (
        <span style={{ display:"inline-flex", gap:4, alignItems:"center" }}>
          <button onClick={()=>handleDelete(emp)} disabled={delBusy}
            style={{ ...S.smallBtnWarn, background:"var(--color-destructive)", color:"#fff", borderColor:"var(--color-destructive)" }}>
            {delBusy ? "삭제 중…" : "정말 삭제"}
          </button>
          <button onClick={()=>setDelTarget(null)} style={S.smallBtn}>취소</button>
        </span>
      ) : (
        <button onClick={()=>{ setDelTarget(emp.empNo); setDelMsg(""); }} style={S.smallBtn}>삭제</button>
      )}
    </div>
  );

  // 남은 인원 안내 — 숫자는 늘 전체 기준이라 "몇 명 중 몇 명을 보고 있는지"를 밝힌다.
  const moreRow = filtered.length > visible.length ? (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:6, padding:"10px 0 4px" }}>
      <div style={{ fontSize:12, color:"var(--color-label-mute)", fontWeight:600 }}>
        {filtered.length.toLocaleString()}명 중 {visible.length.toLocaleString()}명 표시 중 · 이름·사번으로 검색하면 바로 찾을 수 있습니다
      </div>
      <button onClick={() => setShown(n => n + PAGE)} style={{ ...S.btnSecondary, width:"auto", padding:"8px 18px" }}>
        {Math.min(PAGE, filtered.length - visible.length)}명 더 보기
      </button>
    </div>
  ) : null;

  // 노선별 정원 — 초과면 먼저 보이게 정렬. PC 는 집계와 나란히, 모바일은 위아래로 쌓는다.
  const seatCard = seatRows.length > 0 ? (
    <div style={{ border:"1px solid var(--color-line)", borderRadius:10, padding:"10px 12px", background:"var(--color-bg-soft)" }}>
      <div style={{ fontSize:12, fontWeight:800, color:"var(--color-label)", marginBottom:6 }}>노선별 인원 / 좌석</div>
      <div style={{ display:"flex", flexDirection:"column", gap:4, maxHeight: wide ? 168 : "none", overflowY: wide ? "auto" : "visible" }}>
        {seatRows.map(u => (
          <div key={u.rid} style={{ display:"flex", justifyContent:"space-between", gap:8, fontSize:12 }}>
            <span style={{ color:"var(--color-label-mute)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{u.name}</span>
            <span style={{ fontWeight:800, flexShrink:0,
              color: u.over ? "var(--color-destructive)" : !u.seats ? "var(--color-label-mute)" : u.ratio >= 0.9 ? "var(--color-cautionary)" : "var(--color-label)" }}>
              {u.seats ? `${u.registered} / ${u.seats}석${u.over ? " 초과" : ""}` : `${u.registered}명 · 정원 미설정`}
            </span>
          </div>
        ))}
      </div>
    </div>
  ) : null;

  // 집계 — "미시작"(2026-07-27)은 계정을 아직 못 받았거나 안내문이 도달하지 않은 인원.
  const statGrid = (
    <div style={{ display:"grid", gridTemplateColumns:"repeat(4, minmax(0,1fr))", gap:8 }}>
      {[
        ["전체",employees.length,"var(--color-primary)"],
        ["재직",employees.filter(e=>e.active).length,"var(--color-positive)"],
        ["퇴사",employees.filter(e=>!e.active).length,"var(--color-destructive)"],
        ["미시작",employees.filter(e=>e.active && isUnstarted(e)).length,"var(--color-cautionary)"],
      ].map(([l,v,c])=>(
        <div key={l} style={S.statCard}>
          <div style={{ fontSize: wide ? 24 : 20, fontWeight:800, color:c, fontFamily:"var(--font-brand)" }}>{v.toLocaleString()}</div>
          <div style={{ fontSize:11, color:"var(--color-label-mute)", fontWeight:600 }}>{l}</div>
        </div>
      ))}
    </div>
  );

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
      {/* PC 는 정원·집계를 한 줄에 나란히(가로를 채운다), 모바일은 예전 순서 그대로 위아래로. */}
      {wide ? (
        <div style={{ display:"grid", gridTemplateColumns: seatCard ? "minmax(260px,1fr) minmax(360px,1.4fr)" : "1fr", gap:12, alignItems:"start" }}>
          {seatCard}
          {statGrid}
        </div>
      ) : seatCard}

      {/* 검색 + 필터 */}
      <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
        <input style={{ ...S.input, flex:1, minWidth:140, padding:"9px 12px" }}
          placeholder="🔍 이름·사번·부서 검색" value={search} onChange={e=>setSearch(e.target.value)} />
        {["전체","재직","퇴사"].map(f=>(
          <button key={f} onClick={()=>setFilterActive(f)}
            style={{ padding:"8px 14px", borderRadius:8, border: filterActive===f ? "none" : "1px solid var(--color-line)", cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight:700,
              background: filterActive===f ? "var(--color-primary)" : "var(--color-bg)",
              color: filterActive===f ? "#fff" : "var(--color-label-mute)" }}>
            {f}
          </button>
        ))}
      </div>

      {delMsg && (
        <div style={{ fontSize:12, fontWeight:700, padding:"8px 12px", borderRadius:8,
          background: delMsg.includes("못했습니다") ? "#FDECEC" : "#E6F7EB",
          color: delMsg.includes("못했습니다") ? "var(--color-destructive)" : "#007A29" }}>
          {delMsg}
        </div>
      )}

      {!wide && statGrid}

      {/* 계정 배부 도우미 — 아직 한 번도 접속하지 않은 인원만 골라 재발급+인쇄. */}
      <button style={{ ...S.btnSecondary, opacity: pinBusy ? 0.6 : 1, ...(wide ? { width:"auto", alignSelf:"flex-start", padding:"9px 16px" } : null) }}
        onClick={handleReissueUnvisited} disabled={pinBusy}>
        {pinBusy ? "발급 중..." : "📄 미시작 승객 계정 안내문 만들기"}
      </button>

      {/* 승객 목록 — 모바일은 카드, PC 는 표(관리자 콘솔과 같은 형태).
          🔴 두 표현이 **같은 `visible` 배열**을 그린다 — 표시 상한(2026-08-28)·검색·필터는 한 곳뿐이다. */}
      {loading ? (
        <div style={{ textAlign:"center", padding:20, color:"var(--color-label-mute)", fontSize:13 }}>로딩 중...</div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign:"center", padding:24, color:"var(--color-label-alt)", fontSize:13, background:"var(--color-bg-soft)", borderRadius:10 }}>
          {search ? "검색 결과가 없습니다" : "등록된 승객이 없습니다"}
        </div>
      ) : wide ? (
        <>
          {/* 높이는 화면에서 남는 만큼(머리·검색·집계를 뺀 값). 행이 적으면 그만큼만 차지한다. */}
          <div style={{ ...S.tableWrap, maxHeight:"calc(100dvh - 430px)" }}>
            <table style={S.table}>
              <thead>
                <tr>
                  {["이름","사번","부서","노선","상태","NFC 카드","작업"].map(h => (
                    <th key={h} style={{ ...S.th, textAlign: h === "작업" ? "right" : "left" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map(emp => (
                  <tr key={emp.id} style={{ background: emp.active ? "transparent" : "rgba(229,34,34,.03)" }}>
                    <td style={{ ...S.td, fontWeight:700, whiteSpace:"nowrap" }}>{emp.name}</td>
                    <td style={{ ...S.td, fontFamily:"var(--font-mono)", fontSize:12, color:"var(--color-label-mute)", whiteSpace:"nowrap" }}>{emp.empNo}</td>
                    <td style={{ ...S.td, color:"var(--color-label-mute)" }}>{emp.dept || "–"}</td>
                    <td style={{ ...S.td, color:"var(--color-label-mute)" }}>{emp.routeCode || "–"}</td>
                    <td style={S.td}>
                      <span style={{ display:"inline-flex", gap:4, flexWrap:"wrap", alignItems:"center" }}>
                        <Pill tone={emp.active?"positive":"danger"} dot>{emp.active?"재직":"퇴사"}</Pill>
                        {/* "미시작" 이 곧 "발급 비밀번호 그대로" 라 옛 PIN미변경 배지와 뜻이 겹친다 → 하나로 통합. */}
                        {emp.active && isUnstarted(emp) && <Pill tone="warn">미시작</Pill>}
                        {emp.pinLocked && <Pill tone="primary">🔒 PIN잠금</Pill>}
                      </span>
                    </td>
                    <td style={{ ...S.td, fontFamily:"var(--font-mono)", fontSize:11, color:"var(--color-label-mute)", whiteSpace:"nowrap" }}>
                      {emp.nfcUid ? formatNfcUid(emp.nfcUid) : "–"}
                    </td>
                    <td style={{ ...S.td, textAlign:"right", whiteSpace:"nowrap" }}>{rowActions(emp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {moreRow}
        </>
      ) : (
        <div style={{ display:"flex", flexDirection:"column", gap:8, maxHeight:360, overflowY:"auto" }}>
          {visible.map(emp => (
            <div key={emp.id} style={{
              background:"var(--color-bg)",
              borderRadius:10,
              padding:"12px 14px",
              border:`1px solid ${emp.active ? "var(--color-line)" : "rgba(229,34,34,.25)"}`,
              boxShadow: emp.active ? "0 1px 2px rgba(0,0,0,.03)" : "none"
            }}>
              <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:8 }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:5, flexWrap:"wrap" }}>
                    <span style={{ fontSize:14, fontWeight:700, color:"var(--color-label)" }}>{emp.name}</span>
                    <span style={{ fontSize:10, fontFamily:"monospace", color:"var(--color-label-mute)", background:"var(--color-bg-soft)", padding:"1px 6px", borderRadius:4 }}>{emp.empNo}</span>
                    <Pill tone={emp.active?"positive":"danger"} dot>{emp.active?"재직":"퇴사"}</Pill>
                    {emp.active && isUnstarted(emp) && <Pill tone="warn">미시작</Pill>}
                    {emp.pinLocked && <Pill tone="primary">🔒 PIN잠금</Pill>}
                    {emp.nfcUid && <Pill tone="positive">📇 NFC</Pill>}
                  </div>
                  <div style={{ fontSize:12, color:"var(--color-label-mute)" }}>
                    {emp.dept || "부서없음"} · {emp.routeCode || "노선없음"}
                    {emp.nfcUid && <> · <span style={{ fontFamily:"monospace" }}>{formatNfcUid(emp.nfcUid)}</span></>}
                  </div>
                </div>
                {rowActions(emp)}
              </div>
            </div>
          ))}
          {moreRow}
        </div>
      )}

      {/* 비밀번호 발급 결과(2026-07-27) — 평문 PIN 은 저장하지 않으므로 이 모달이 유일한 노출 지점.
          오버레이 클릭으로 닫지 않는다(실수로 닫으면 재발급 말고는 복구 경로가 없다). */}
      {pinResult && (
        <div style={S.overlay}>
          <div style={S.modal}>
            <div style={S.modalTitle}>비밀번호 발급 완료</div>
            <div style={{ background:"#FFF8ED", border:"1px solid #FFD9A8", borderRadius:8, padding:"10px 12px", fontSize:12, color:"#8A5200", lineHeight:1.6 }}>
              보안을 위해 비밀번호는 저장하지 않습니다. <b>이 창을 닫으면 다시 볼 수 없습니다.</b>
              먼저 안내문을 인쇄하거나 목록을 복사해두세요.
            </div>

            <div style={{ maxHeight:220, overflowY:"auto", border:"1px solid var(--color-line)", borderRadius:8 }}>
              {/* 🔴 목록에 다 그리지 않는다(2026-08-28) — 인원이 많으면 이 모달에서 브라우저가
                  멈춘다. 전원분은 아래 '안내문 인쇄'로 나가므로 화면은 앞부분만 보여준다. */}
              {pinResult.credentials.slice(0, 200).map(c => (
                <div key={c.empNo} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8, padding:"9px 12px", borderBottom:"1px solid var(--color-line-soft)" }}>
                  <div style={{ minWidth:0 }}>
                    <div style={{ fontSize:13, fontWeight:700, color:"var(--color-label)" }}>{c.name}</div>
                    <div style={{ fontSize:11, color:"var(--color-label-mute)", fontFamily:"monospace" }}>{c.empNo}</div>
                  </div>
                  <div style={{ fontSize:16, fontWeight:800, color:"var(--color-primary)", fontFamily:"monospace", letterSpacing:1 }}>{c.pin}</div>
                </div>
              ))}
              {pinResult.credentials.length > 200 && (
                <div style={{ padding:"10px 12px", fontSize:12, color:"var(--color-label-mute)", fontWeight:600, textAlign:"center" }}>
                  외 {(pinResult.credentials.length - 200).toLocaleString()}명 — 전원분은 아래 안내문 인쇄에 포함됩니다
                </div>
              )}
            </div>

            {pinResult.errors?.length > 0 && (
              <div style={{ fontSize:12, color:"var(--color-destructive)", fontWeight:600, lineHeight:1.5 }}>
                발급 실패 {pinResult.errors.length}건: {pinResult.errors.slice(0, 3).join(" / ")}
              </div>
            )}

            <div style={{ display:"flex", gap:8, marginTop:6 }}>
              <button style={S.btn} onClick={handlePrintPinResult}>📄 안내문 인쇄</button>
              <button style={{ ...S.btnSecondary, flex:"0 0 110px" }} onClick={() => {
                const text = pinResult.credentials.map(c => `${c.name} / 아이디 ${c.empNo} / 비밀번호 ${c.pin}`).join("\n");
                navigator.clipboard?.writeText(text).then(
                  () => alert("목록을 복사했습니다."),
                  () => alert("복사에 실패했습니다. 화면의 목록을 직접 옮겨 적어주세요.")
                );
              }}>목록 복사</button>
            </div>
            <button style={S.btnSecondary} onClick={() => setPinResult(null)}>닫기</button>
          </div>
        </div>
      )}

      {/* 수정 모달 */}
      {editEmp && (
        <div style={S.overlay}>
          <div style={S.modal}>
            <div style={S.modalTitle}>승객 정보 수정</div>
            <div style={{ fontSize:12, color:"var(--color-label-mute)" }}>{editEmp.empNo} · {editEmp.name}</div>

            <label style={S.label}>이름 *</label>
            <input style={S.input} value={editForm.name} onChange={e=>setEditForm({...editForm,name:e.target.value})} />

            <label style={S.label}>부서</label>
            <input style={S.input} placeholder="예) 개발팀" value={editForm.dept} onChange={e=>setEditForm({...editForm,dept:e.target.value})} />

            <label style={S.label}>노선</label>
            <select style={S.input} value={editForm.routeCode} onChange={e=>setEditForm({...editForm,routeCode:e.target.value})}>
              <option value="">노선 선택</option>
              {partnerRouteOptions(routes, code, editForm.routeCode).map(r=><option key={r.id} value={r.code||r.id}>{r.name} ({r.code||r.id})</option>)}
            </select>

            <label style={S.checkBox}>
              <input type="checkbox" checked={editForm.active} onChange={e=>setEditForm({...editForm,active:e.target.checked})}
                style={{ accentColor:"var(--color-primary)", width:16, height:16, cursor:"pointer" }} />
              <span style={{ fontSize:13, color:"var(--color-label)", fontWeight:500 }}>재직 중 (체크 해제 시 퇴사 처리)</span>
            </label>

            {/* 공용/통합 계정 보호(2026-07-21) — 체크 시 승객앱 설정에서 PIN 변경이 사라진다.
                PIN 이 바뀌면 같은 계정을 쓰는 전원이 로그인 못 하는 사고 방지. */}
            <label style={S.checkBox}>
              <input type="checkbox" checked={!!editForm.pinLocked} onChange={e=>setEditForm({...editForm,pinLocked:e.target.checked})}
                style={{ accentColor:"var(--color-primary)", width:16, height:16, cursor:"pointer" }} />
              <span style={{ fontSize:13, color:"var(--color-label)", fontWeight:500 }}>PIN 변경 잠금 (여러 명이 함께 쓰는 공용 계정)</span>
            </label>

            {/* NFC 사원증(2026-07-22) — 비우면 카드 해제(분실·회수). */}
            <label style={S.label}>NFC 카드번호</label>
            <input style={S.input} placeholder="0453CE9A 또는 04:53:CE:9A (비우면 해제)"
              value={editForm.nfcUid || ""} onChange={e=>setEditForm({...editForm,nfcUid:e.target.value})} />
            <div style={{ fontSize:11, color:"var(--color-label-alt)", lineHeight:1.5 }}>
              사원증 카드의 16진수 번호. 등록 시 기사앱에서 카드 태깅만으로 탑승 처리됩니다.
            </div>

            <div style={{ fontSize:11, color:"var(--color-label-alt)", lineHeight:1.5 }}>
              잠그면 승객앱 설정에서 PIN 변경 항목이 보이지 않습니다. PIN 재설정이 필요하면 목록의 “PIN초기화”를 사용하세요.
            </div>

            {msg && (
              <div style={{
                background: msg.type==="success" ? "#E6F7EB" : "#FCE5E5",
                border: `1px solid ${msg.type==="success" ? "#B7E6C7" : "#F6C9C9"}`,
                borderRadius:8, padding:"9px 12px", fontSize:13, fontWeight:600,
                color: msg.type==="success" ? "#007A29" : "#A81818"
              }}>
                {msg.text}
              </div>
            )}

            <div style={{ display:"flex", gap:8, marginTop:6 }}>
              <button style={{ ...S.btn, opacity:saving?0.6:1 }} onClick={handleSave} disabled={saving}>
                {saving?"저장 중...":"저장"}
              </button>
              <button style={{ ...S.btnSecondary, flex:"0 0 90px" }} onClick={()=>setEditEmp(null)}>취소</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 스타일 ────────────────────────────────────────────
const S = {
  wrap: {
    minHeight:"100dvh",
    background:"var(--color-bg-alt)",
    display:"flex",
    alignItems:"center",
    justifyContent:"center",
    padding:"24px 16px",
    fontFamily:"var(--font-base)",
    color:"var(--color-label)",
  },
  card: {
    background:"var(--color-bg)",
    border:"1px solid var(--color-line)",
    borderRadius:20,
    padding:"28px 26px",
    width:"100%",
    display:"flex",
    flexDirection:"column",
    gap:14,
    boxShadow:"0 8px 32px rgba(11,16,32,.06)",
  },
  header: {
    display:"flex",
    alignItems:"center",
    paddingBottom:6,
    borderBottom:"1px solid var(--color-line-soft)",
    marginBottom:4,
  },
  stepRow: { display:"flex", alignItems:"flex-start" },
  title: {
    fontSize:17,
    fontWeight:800,
    fontFamily:"var(--font-brand)",
    letterSpacing:"-0.02em",
    color:"var(--color-label)",
  },
  desc: { fontSize:13, color:"var(--color-label-mute)", marginTop:-4 },
  label: { fontSize:11, color:"var(--color-label-mute)", display:"block", marginBottom:4, fontWeight:700 },
  input: {
    background:"var(--color-bg)",
    border:"1px solid var(--color-line)",
    borderRadius:8,
    padding:"11px 14px",
    color:"var(--color-label)",
    fontSize:14,
    outline:"none",
    fontFamily:"inherit",
    width:"100%",
    boxSizing:"border-box",
  },
  inputSm: {
    background:"var(--color-bg)",
    border:"1px solid var(--color-line)",
    borderRadius:6,
    padding:"7px 9px",
    color:"var(--color-label)",
    fontSize:12,
    outline:"none",
    fontFamily:"inherit",
    width:"100%",
    boxSizing:"border-box",
  },
  btn: {
    background:"var(--color-primary)",
    border:"none",
    borderRadius:10,
    padding:"13px 16px",
    color:"#fff",
    fontSize:14,
    fontWeight:800,
    cursor:"pointer",
    fontFamily:"inherit",
    width:"100%",
    boxShadow:"0 2px 8px rgba(0,102,255,.22)",
    letterSpacing:"-0.01em",
  },
  btnSecondary: {
    background:"var(--color-bg-soft)",
    border:"1px solid var(--color-line)",
    borderRadius:10,
    padding:"11px 16px",
    color:"var(--color-label)",
    fontSize:13,
    fontWeight:700,
    cursor:"pointer",
    fontFamily:"inherit",
    width:"100%",
  },
  errorMsg: {
    background:"#FCE5E5",
    border:"1px solid #F6C9C9",
    borderRadius:8,
    padding:"10px 14px",
    fontSize:13,
    color:"#A81818",
    fontWeight:600,
    whiteSpace:"pre-line",
  },
  notice: { fontSize:11, color:"var(--color-label-alt)", textAlign:"center" },
  partnerInfo: {
    background:"var(--color-primary-soft)",
    border:"1px solid rgba(0,102,255,.18)",
    borderRadius:12,
    padding:"12px 16px",
  },
  tabBar: {
    display:"flex",
    gap:6,
    background:"var(--color-bg-soft)",
    border:"1px solid var(--color-line)",
    padding:4,
    borderRadius:10,
  },
  tabBtn: {
    flex:1,
    padding:"10px",
    borderRadius:7,
    border:"none",
    cursor:"pointer",
    fontFamily:"inherit",
    fontSize:13,
    fontWeight:700,
    transition:"all .15s",
  },
  subTabBar: {
    display:"flex",
    gap:4,
    background:"var(--color-bg-soft)",
    border:"1px solid var(--color-line)",
    padding:3,
    borderRadius:8,
  },
  subTabBtn: {
    flex:1,
    padding:"7px 4px",
    borderRadius:6,
    border:"none",
    cursor:"pointer",
    fontFamily:"inherit",
    fontSize:11.5,
    transition:"all .15s",
  },
  excelGuide: {
    background:"#FFF8E6",
    border:"1px solid #FFE0C2",
    borderRadius:10,
    padding:"14px 16px",
  },
  fileLabel: {
    display:"flex",
    flexDirection:"column",
    alignItems:"center",
    justifyContent:"center",
    gap:4,
    padding:"28px",
    border:"2px dashed var(--color-line)",
    borderRadius:12,
    cursor:"pointer",
    textAlign:"center",
    color:"var(--color-label)",
    fontSize:14,
    fontWeight:700,
    minHeight:110,
    background:"var(--color-bg-soft)",
  },
  statCard: {
    background:"var(--color-bg-soft)",
    border:"1px solid var(--color-line)",
    borderRadius:10,
    padding:"10px 12px",
    textAlign:"center",
  },
  warnBox: {
    background:"#FCE5E5",
    border:"1px solid #F6C9C9",
    borderRadius:8,
    padding:"10px 14px",
  },
  previewTableWrap: {
    background:"var(--color-bg)",
    border:"1px solid var(--color-line)",
    borderRadius:8,
    overflow:"hidden",
    maxHeight:200,
    overflowY:"auto",
  },
  previewTh: {
    padding:"8px 10px",
    textAlign:"left",
    color:"var(--color-label-mute)",
    background:"var(--color-bg-alt)",
    borderBottom:"1px solid var(--color-line)",
    fontWeight:700,
    fontSize:11,
  },
  previewTd: {
    padding:"6px 10px",
    borderBottom:"1px solid var(--color-line-soft)",
  },
  summaryBox: {
    background:"var(--color-primary-soft)",
    border:"1px solid rgba(0,102,255,.18)",
    borderRadius:8,
    padding:"9px 14px",
    fontSize:12,
    display:"flex",
    justifyContent:"space-between",
    fontWeight:600,
  },
  resultBox: {
    background:"var(--color-bg-soft)",
    border:"1px solid var(--color-line)",
    borderRadius:12,
    padding:"14px 18px",
    width:"100%",
  },
  checkBox: {
    display:"flex",
    alignItems:"center",
    gap:8,
    padding:"10px 14px",
    background:"var(--color-bg-soft)",
    border:"1px solid var(--color-line)",
    borderRadius:8,
    cursor:"pointer",
  },
  smallBtn: {
    background:"var(--color-bg-soft)",
    border:"1px solid var(--color-line)",
    borderRadius:6,
    padding:"6px 10px",
    color:"var(--color-label-mute)",
    fontSize:11,
    fontWeight:700,
    cursor:"pointer",
    fontFamily:"inherit",
  },
  smallBtnWarn: {
    background:"#FFF1E0",
    border:"1px solid #FFE0C2",
    borderRadius:6,
    padding:"6px 10px",
    color:"#B95300",
    fontSize:11,
    fontWeight:700,
    cursor:"pointer",
    fontFamily:"inherit",
  },
  overlay: {
    position:"fixed",
    inset:0,
    background:"var(--color-overlay)",
    zIndex:200,
    display:"flex",
    alignItems:"center",
    justifyContent:"center",
    padding:16,
  },
  modal: {
    background:"var(--color-bg)",
    border:"1px solid var(--color-line)",
    borderRadius:16,
    padding:"22px 20px",
    width:"100%",
    maxWidth:400,
    display:"flex",
    flexDirection:"column",
    gap:8,
    boxShadow:"0 20px 60px rgba(11,16,32,.18)",
    maxHeight:"88dvh",
    overflowY:"auto",
  },
  modalTitle: {
    fontSize:17,
    fontWeight:800,
    fontFamily:"var(--font-brand)",
    letterSpacing:"-0.02em",
    color:"var(--color-label)",
    marginBottom:2,
  },

  // ── PC 셸(≥1024px) — AdminApp 관리자 콘솔과 같은 치수·같은 시각 언어 ──────
  // 🔴 `minWidth:0` 은 세로글씨의 예방책이다(2026-08-26 AdminApp) — flex 아이템 기본값이
  //    min-width:auto 라 좁아질 때 안쪽 요소가 찌부러지며 한글이 글자당 한 줄로 쌓인다.
  //    `minHeight:0` 과 짝이다(세로 스크롤). 둘 다 빼지 말 것.
  shell: { display:"flex", height:"100dvh", background:"var(--color-bg-soft)", fontFamily:"var(--font-base)", color:"var(--color-label)", position:"relative", overflow:"hidden" },
  sideCol: { width:236, flexShrink:0, background:"var(--color-bg)", borderRight:"1px solid var(--color-line)", display:"flex", flexDirection:"column", minHeight:0, padding:"18px 14px" },
  sideLogo: { display:"flex", alignItems:"baseline", gap:8, flexShrink:0, padding:"4px 8px 14px", borderBottom:"1px solid var(--color-line)" },
  sidePartner: { flexShrink:0, marginTop:12, padding:"10px 12px", borderRadius:10, background:"var(--color-primary-soft)", border:"1px solid rgba(0,102,255,.18)" },
  sideSection: { fontSize:11, fontWeight:700, letterSpacing:"0.04em", color:"var(--color-label-alt)", flexShrink:0, padding:"14px 12px 8px" },
  // 목록만 스크롤 — 탭이 늘어도 아래 항목이 잘리지 않는다(2026-08-11 AdminApp 사이드바 교훈).
  sideNav: { display:"flex", flexDirection:"column", gap:2, flex:1, minHeight:0, overflowY:"auto", overflowX:"hidden" },
  navItem: { display:"flex", alignItems:"center", gap:11, flexShrink:0, padding:"10px 12px", borderRadius:10, cursor:"pointer", fontSize:13, fontWeight:500, color:"var(--color-label-mute)", position:"relative", transition:"background .15s,color .15s", userSelect:"none", whiteSpace:"nowrap" },
  navActive: { background:"var(--color-primary-soft)", color:"var(--color-primary-deep)", fontWeight:700 },
  navAccent: { position:"absolute", left:3, top:"50%", transform:"translateY(-50%)", width:3, height:18, borderRadius:3, background:"var(--color-primary)" },
  navIcon: { flexShrink:0, display:"flex", opacity:.92 },
  logoutBtn: { display:"flex", alignItems:"center", justifyContent:"center", width:"100%", flexShrink:0, marginTop:10, background:"var(--color-bg-soft)", border:"1px solid var(--color-line)", borderRadius:10, padding:"10px 12px", color:"var(--color-label-mute)", fontSize:13, fontWeight:600, cursor:"pointer", fontFamily:"inherit" },
  contentCol: { flex:1, minWidth:0, display:"flex", flexDirection:"column", minHeight:0, overflow:"hidden" },
  topbar: { display:"flex", alignItems:"center", justifyContent:"space-between", gap:16, padding:"14px 24px", background:"var(--color-bg)", borderBottom:"1px solid var(--color-line)", flexShrink:0 },
  main: { flex:1, minHeight:0, overflowY:"auto", padding:"20px 24px 32px" },

  // ── PC 표(승객 관리) — 관리자 콘솔 표와 같은 규격 ──────────────────────
  tableWrap: { background:"var(--color-bg)", border:"1px solid var(--color-line)", borderRadius:12, overflow:"auto" },
  table: { width:"100%", minWidth:820, borderCollapse:"collapse" },
  th: { textAlign:"left", padding:"10px 14px", fontSize:11, color:"var(--color-label-mute)", fontWeight:700, borderBottom:"1px solid var(--color-line)", whiteSpace:"nowrap", background:"var(--color-bg-alt)", position:"sticky", top:0, zIndex:1 },
  td: { padding:"10px 14px", fontSize:13, borderBottom:"1px solid var(--color-line-soft)", verticalAlign:"middle" },
};

// ════════════════════════════════════════════════════════
// 탑승 통계 모드 (일자별 누적, 2026-05-26)
// ════════════════════════════════════════════════════════
// companyId/boardings/{date}/list 컬렉션을 from~to 범위로 일자별 로딩 → partnerCode 일치 또는
// 자기 협력사 직원 empNo 매칭(legacy 데이터 호환). 누적 표시: 일자별/직원별/노선별.
function BoardingStatsMode({ codeData, code, routes, wide = false }) {
  const todayStr = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
  const daysAgo = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(d);
  };
  const [fromDate, setFromDate] = useState(daysAgo(29)); // 최근 30일
  const [toDate, setToDate] = useState(todayStr());
  const [loading, setLoading] = useState(false);
  const [boardings, setBoardings] = useState([]); // 필터 후 누적 데이터
  const [empNoSet, setEmpNoSet] = useState(new window.Set()); // 우리 협력사 직원 사번
  const [error, setError] = useState("");
  // 정류장별 GPS 매핑용 — boardings 에 등장한 routeId의 stops를 lazy 로드
  const [stopsByRoute, setStopsByRoute] = useState({});
  // 정류장 행을 눌러 «그 정류장에서 누가 탔나»를 펼친다(2026-09-03). 관리자 탑승 통계와 같은 동작.
  const [openStop, setOpenStop] = useState(null);

  // 협력사 직원 empNo 세트 로드 (legacy boarding 매칭용)
  useEffect(() => {
    if (!codeData?.companyId || !code) return;
    const q = query(
      collection(db, "companies", codeData.companyId, "passengers"),
      where("partnerCode", "==", code)
    );
    getDocs(q).then(snap => {
      const s = new window.Set();
      snap.forEach(d => { const e = d.data().empNo; if (e) s.add(e); });
      setEmpNoSet(s);
    }).catch(e => console.warn("[BoardingStats] passengers 조회 오류:", e.message));
  }, [codeData, code]);

  // 기간 내 일자별 boardings 로드 (수동 조회 — 자동 구독 시 N개 listener 부담)
  const loadStats = async () => {
    if (!codeData?.companyId) return;
    setLoading(true); setError(""); setBoardings([]);
    try {
      const from = new Date(fromDate + "T00:00:00");
      const to = new Date(toDate + "T00:00:00");
      if (from > to) { setError("종료일이 시작일보다 빠릅니다"); setLoading(false); return; }
      const dayMs = 86400000;
      const dates = [];
      for (let t = from.getTime(); t <= to.getTime(); t += dayMs) {
        const d = new Date(t);
        dates.push(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(d));
      }
      if (dates.length > 92) {
        setError("최대 92일까지 조회 가능합니다 (현재 " + dates.length + "일)");
        setLoading(false); return;
      }
      const collected = [];
      // 병렬 fetch (Promise.all) — 92건 이하라 안전
      await Promise.all(dates.map(async (d) => {
        try {
          const snap = await getDocs(collection(db, "companies", codeData.companyId, "boardings", d, "list"));
          snap.forEach(doc => {
            const b = doc.data();
            // 협력사 매칭: partnerCode 일치 또는 (legacy) 우리 직원 empNo 매칭
            if (b.partnerCode === code || (b.partnerCode == null && empNoSet.has(b.empNo))) {
              collected.push({ id: doc.id, date: d, ...b });
            }
          });
        } catch (_) { /* 특정 날짜 권한/네트워크 오류는 무시하고 계속 */ }
      }));
      // 시간 오름차순
      collected.sort((a, b) => {
        const ma = a.boardedAt?.toMillis ? a.boardedAt.toMillis() : 0;
        const mb = b.boardedAt?.toMillis ? b.boardedAt.toMillis() : 0;
        return ma - mb;
      });
      setBoardings(collected);
    } catch (e) { setError(e.message || "조회 오류"); }
    setLoading(false);
  };

  // 첫 마운트 + empNoSet 로드 후 1회 자동 조회
  useEffect(() => { if (empNoSet.size >= 0) loadStats(); /* eslint-disable-next-line */ }, [empNoSet]);

  // boardings 에 등장한 routeId의 stops 로드(아직 캐시 안 됐으면 가져옴) — 정류장 매핑용
  useEffect(() => {
    if (!codeData?.companyId || boardings.length === 0) return;
    const routeIds = Array.from(new window.Set(boardings.map(b => b.routeId).filter(Boolean)));
    const toLoad = routeIds.filter(rid => !stopsByRoute[rid]);
    if (toLoad.length === 0) return;
    Promise.all(toLoad.map(async rid => {
      try {
        const snap = await getDocs(query(
          collection(db, "companies", codeData.companyId, "routes", rid, "stops"),
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
  }, [codeData, boardings, stopsByRoute]);

  // 집계
  const byDate = (() => {
    const m = new window.Map();
    boardings.forEach(b => m.set(b.date, (m.get(b.date) || 0) + 1));
    return [...m.entries()].sort();
  })();
  const peakDayCount = Math.max(...byDate.map(([_, c]) => c), 1);

  const byEmployee = (() => {
    const m = new window.Map();
    boardings.forEach(b => {
      const k = b.empNo || "_";
      const cur = m.get(k) || { empNo: b.empNo || "–", name: b.name || "", count: 0 };
      cur.count++;
      if (b.name && !cur.name) cur.name = b.name;
      m.set(k, cur);
    });
    return [...m.values()].sort((a, b) => b.count - a.count);
  })();
  const byRoute = (() => {
    const m = new window.Map();
    boardings.forEach(b => {
      const k = b.routeId || "_";
      const cur = m.get(k) || { name: b.routeName || "노선 미지정", count: 0 };
      cur.count++;
      m.set(k, cur);
    });
    return [...m.values()].sort((a, b) => b.count - a.count);
  })();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* 기간 선택 */}
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 120 }}>
          <label style={S.label}>시작일</label>
          <input type="date" style={S.input} value={fromDate} max={todayStr()}
            onChange={e => { if (e.target.value) setFromDate(e.target.value); }} />
        </div>
        <div style={{ flex: 1, minWidth: 120 }}>
          <label style={S.label}>종료일</label>
          <input type="date" style={S.input} value={toDate} max={todayStr()}
            onChange={e => { if (e.target.value) setToDate(e.target.value); }} />
        </div>
        <button style={{ ...S.btn, flex: "0 0 100px", padding: "11px 10px" }} onClick={loadStats} disabled={loading}>
          {loading ? "조회 중..." : "🔍 조회"}
        </button>
      </div>

      {/* 빠른 선택 */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {[[7, "최근 7일"], [30, "최근 30일"], [90, "최근 90일"]].map(([n, label]) => (
          <button key={n} onClick={() => { setFromDate(daysAgo(n - 1)); setToDate(todayStr()); }}
            style={{
              padding: "6px 12px", borderRadius: 999, fontSize: 11, fontWeight: 700,
              border: "1px solid var(--color-line)", background: "var(--color-bg)",
              color: "var(--color-label-mute)", cursor: "pointer", fontFamily: "inherit",
            }}>
            {label}
          </button>
        ))}
      </div>

      {error && <div style={S.errorMsg}>{error}</div>}

      {/* 종합 카드 */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
        <div style={S.statCard}>
          <div style={{ fontSize: 22, fontWeight: 800, color: "var(--color-primary)", fontFamily: "var(--font-brand)" }}>
            {boardings.length}
          </div>
          <div style={{ fontSize: 11, color: "var(--color-label-mute)", fontWeight: 600, marginTop: 2 }}>총 탑승</div>
        </div>
        <div style={S.statCard}>
          <div style={{ fontSize: 22, fontWeight: 800, color: "var(--color-positive)", fontFamily: "var(--font-brand)" }}>
            {byEmployee.length}
          </div>
          <div style={{ fontSize: 11, color: "var(--color-label-mute)", fontWeight: 600, marginTop: 2 }}>고유 승객</div>
        </div>
        <div style={S.statCard}>
          <div style={{ fontSize: 22, fontWeight: 800, color: "var(--color-cautionary)", fontFamily: "var(--font-brand)" }}>
            {byRoute.length}
          </div>
          <div style={{ fontSize: 11, color: "var(--color-label-mute)", fontWeight: 600, marginTop: 2 }}>이용 노선</div>
        </div>
      </div>

      {/* 결과 패널 — PC 는 2열로 나란히(가로를 채운다), 모바일은 예전대로 한 줄씩 쌓는다.
          🔴 `auto-fit` 이라 패널이 하나뿐이면 그 하나가 가로를 다 쓴다(반쪽 칸이 안 남는다). */}
      <div style={wide
        ? { display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(420px, 1fr))", gap:14, alignItems:"start" }
        : { display:"flex", flexDirection:"column", gap:14 }}>
      {/* 일자별 막대 */}
      {byDate.length > 0 && (
        <div style={{ background: "var(--color-bg)", border: "1px solid var(--color-line)", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--color-line-soft)", fontSize: 12, fontWeight: 700, color: "var(--color-label)" }}>
            📅 일자별 탑승 추이
          </div>
          <div style={{ padding: "10px 14px", maxHeight: wide ? 320 : 220, overflowY: "auto" }}>
            {byDate.map(([d, c]) => (
              <div key={d} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}>
                <span style={{ fontSize: 11, color: "var(--color-label-mute)", fontFamily: "var(--font-mono)", width: 80, flexShrink: 0 }}>
                  {d.substring(5)} {/* MM-DD */}
                </span>
                <div style={{ flex: 1, height: 14, background: "var(--color-bg-soft)", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ width: `${(c / peakDayCount) * 100}%`, height: "100%", background: "var(--color-primary)", borderRadius: 3 }} />
                </div>
                <span style={{ fontSize: 11, fontWeight: 800, color: "var(--color-primary)", width: 40, textAlign: "right" }}>{c}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 직원별 / 노선별 */}
      {byEmployee.length > 0 && (
        <div style={{ background: "var(--color-bg)", border: "1px solid var(--color-line)", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--color-line-soft)", fontSize: 12, fontWeight: 700, color: "var(--color-label)" }}>
            👤 승객별 탑승 ({byEmployee.length}명)
          </div>
          <div style={{ maxHeight: wide ? 420 : 280, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "var(--color-bg-alt)" }}>
                  {["사번", "이름", "탑승"].map(h => (
                    <th key={h} style={{ padding: "6px 10px", textAlign: "left", color: "var(--color-label-mute)", fontWeight: 700, fontSize: 11 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {byEmployee.map(e => (
                  <tr key={e.empNo} style={{ borderTop: "1px solid var(--color-line-soft)" }}>
                    <td style={{ padding: "6px 10px", fontFamily: "var(--font-mono)", fontSize: 11 }}>{e.empNo}</td>
                    <td style={{ padding: "6px 10px", fontWeight: 700 }}>{e.name || "–"}</td>
                    <td style={{ padding: "6px 10px", fontWeight: 800, color: "var(--color-primary)", textAlign: "right" }}>{e.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {byRoute.length > 0 && (
        <div style={{ background: "var(--color-bg)", border: "1px solid var(--color-line)", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--color-line-soft)", fontSize: 12, fontWeight: 700, color: "var(--color-label)" }}>
            🛣 노선별 탑승
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <tbody>
              {byRoute.map((r, i) => (
                <tr key={i} style={{ borderTop: i > 0 ? "1px solid var(--color-line-soft)" : "none" }}>
                  <td style={{ padding: "8px 14px", fontWeight: 600 }}>{r.name}</td>
                  <td style={{ padding: "8px 14px", fontWeight: 800, color: "var(--color-primary)", textAlign: "right" }}>{r.count}건</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 정류장별 GPS 매핑 집계 */}
      {boardings.length > 0 && (() => {
        const { mapped, unmapped, noGps } = aggregateBoardingsByStop(boardings, stopsByRoute, 300);
        if (mapped.length === 0 && noGps === boardings.length) return null; // 전부 legacy → 미표시
        // 노선 그룹 + 노선 내 운행 순서(관리자 탑승 통계와 같은 규칙, 2026-09-03).
        const routeGroups = groupMappedByRoute(mapped, stopsByRoute);
        return (
          <div style={{ background: "var(--color-bg)", border: "1px solid var(--color-line)", borderRadius: 10, overflow: "hidden" }}>
            <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--color-line-soft)", fontSize: 12, fontWeight: 700, color: "var(--color-label)" }}>
              📍 노선별 정류장 탑승 <span style={{ fontSize: 10, fontWeight: 600, color: "var(--color-label-mute)", marginLeft: 4 }}>(GPS·반경 300m · 운행 순서)</span>
            </div>
            {mapped.length === 0 ? (
              <div style={{ padding: 20, fontSize: 12, color: "var(--color-label-alt)", textAlign: "center" }}>
                매핑된 정류장 없음
              </div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ background: "var(--color-bg-alt)" }}>
                    {["순번", "정류장", "탑승", "거리"].map(h => (
                      <th key={h} style={{ padding: "6px 10px", textAlign: h === "정류장" ? "left" : (h === "순번" ? "center" : "right"), color: "var(--color-label-mute)", fontWeight: 700, fontSize: 11 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                {routeGroups.map(g => (
                  <tbody key={g.routeId || g.routeName}>
                    <tr>
                      {/* 🔴 display:flex 를 주지 말 것 — td 가 table-cell 을 벗어나면 열 정렬이 죽는다. */}
                      <td style={{ ...pStopGroupHead, textAlign: "center" }}>🛣</td>
                      <td style={{ ...pStopGroupHead, fontWeight: 800 }}>{g.routeName}</td>
                      <td style={{ ...pStopGroupHead, textAlign: "right", fontWeight: 800, color: "var(--color-primary)" }}>{g.total}</td>
                      <td style={{ ...pStopGroupHead, textAlign: "right", fontSize: 10, fontWeight: 600, color: "var(--color-label-mute)" }}>
                        {g.stops.length}{g.routeStopCount > 0 ? `/${g.routeStopCount}` : ""}곳
                      </td>
                    </tr>
                    {g.stops.flatMap(m => {
                      const k = `${g.routeId || "_unknown"}::${m.stopId}`;
                      const open = openStop === k;
                      const rows = [(
                        <tr key={k} style={{ borderTop: "1px solid var(--color-line-soft)", cursor: "pointer", background: open ? "var(--color-primary-soft)" : undefined }}
                          onClick={() => setOpenStop(open ? null : k)}
                          title="클릭하면 이 정류장에서 탄 사람 명단">
                          <td style={{ padding: "6px 10px", textAlign: "center", fontSize: 11, fontWeight: 700, color: "var(--color-primary-deep)", fontFamily: "var(--font-mono)" }}>{m.seq != null ? m.seq : "–"}</td>
                          <td style={{ padding: "6px 10px", fontWeight: 700 }}>
                            <span style={{ color: "var(--color-label-mute)", marginRight: 5, fontSize: 10 }}>{open ? "▾" : "▸"}</span>
                            {m.stopName}
                          </td>
                          <td style={{ padding: "6px 10px", fontWeight: 800, color: "var(--color-primary)", textAlign: "right" }}>{m.count}</td>
                          <td style={{ padding: "6px 10px", fontSize: 10, color: "var(--color-label-mute)", textAlign: "right", fontFamily: "var(--font-mono)" }}>
                            {m.minDist != null ? `${Math.round(m.minDist)}m` : "–"}
                          </td>
                        </tr>
                      )];
                      if (open) {
                        // 집계와 같은 원본(items)을 쓴다 — 명단을 따로 필터링하면 합계와 어긋난다.
                        const list = [...(m.items || [])].sort((a, b) =>
                          (a.boardedAt?.toMillis?.() || 0) - (b.boardedAt?.toMillis?.() || 0));
                        rows.push(
                          <tr key={k + "::detail"}>
                            <td colSpan={4} style={{ padding: "0 0 0 34px", background: "var(--color-bg-alt)", borderTop: "1px solid var(--color-line-soft)" }}>
                              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                                <tbody>
                                  {list.map(b => (
                                    <tr key={b.id} style={{ borderTop: "1px solid var(--color-line-soft)" }}>
                                      <td style={{ padding: "5px 8px", fontFamily: "var(--font-mono)", color: "var(--color-label-mute)", width: 70 }}>{fmtBoardTime(b.boardedAt)}</td>
                                      <td style={{ padding: "5px 8px", fontFamily: "var(--font-mono)", color: "var(--color-label-mute)" }}>{b.empNo}</td>
                                      <td style={{ padding: "5px 8px", fontWeight: 700 }}>{b.name || "–"}</td>
                                      <td style={{ padding: "5px 8px", fontFamily: "var(--font-mono)", color: "var(--color-label-mute)", textAlign: "right" }}>{b.vehicleNo || "–"}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </td>
                          </tr>
                        );
                      }
                      return rows;
                    })}
                  </tbody>
                ))}
              </table>
            )}
            {(unmapped > 0 || noGps > 0) && (
              <div style={{ padding: "6px 14px", fontSize: 10, color: "var(--color-label-alt)", borderTop: "1px solid var(--color-line-soft)", background: "var(--color-bg-soft)" }}>
                ⓘ {noGps > 0 && <span>GPS 없음 {noGps}건</span>}
                {noGps > 0 && unmapped > 0 && <span> · </span>}
                {unmapped > 0 && <span>임계 초과 {unmapped}건</span>}
              </div>
            )}
          </div>
        );
      })()}
      </div>

      {boardings.length === 0 && !loading && (
        <div style={{ textAlign: "center", padding: 32, color: "var(--color-label-mute)", fontSize: 13, background: "var(--color-bg-soft)", borderRadius: 10 }}>
          조회 기간 탑승 기록이 없습니다.
          <div style={{ fontSize: 11, color: "var(--color-label-alt)", marginTop: 6 }}>
            QR로 탑승한 승객이 있으면 여기에 누적됩니다.
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════
// 운영 포털 모드(Phase 1.3, 2026-05-28)
// — 협력사 담당자가 자사 노선만 실시간 조회: 직원 노선 요약 / 실시간 버스 위치(카카오맵)
//   / 오늘 탑승 현황 / 공지 수신함. 모두 partnerCode 단위 필터(클라이언트).
// — BoardingStatsMode·EmployeeManageMode 인프라(props codeData/code/routes) 재사용.
// — onSnapshot deps에 wakeTick + recoverTick 포함(백그라운드/오프라인 복귀 자동 재구독).
// ════════════════════════════════════════════════════════
function OperationsMode({ codeData, code, routes, wide = false }) {
  const companyId = codeData?.companyId;
  const wakeTick = useWakeTick();
  const recoverTick = useOnlineRecover({ forceFirestoreReconnect: true });
  const todayStr = useMemo(
    () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date()),
    []
  );

  // ── 자사 직원 ↦ routeId 분포 ─────────────────────────
  // 🔴 2026-08-28: 예전엔 이 거래처 활성 승객을 **문서째 전부** 받아 노선별로 세었다.
  //    250명 전제에선 괜찮았지만 신촌세브란스병원이 16,155명이 되며 운영 포털을 열 때마다
  //    그걸 다 내려받느라 느려졌다(게시판 「협력사페이지 느려짐」). 필요한 건 **노선별 인원
  //    수와 총원**뿐이라 Firestore 집계(count)로 바꾼다 — 문서는 한 건도 안 내려온다.
  //    미배정 = 총원 − 노선별 합계(사라진 노선에 배정된 승객도 여기로 모인다).
  const [headcount, setHeadcount] = useState({ byRouteCount: {}, unassignedCount: 0, total: 0 });
  const [passengersLoading, setPassengersLoading] = useState(true);
  useEffect(() => {
    if (!companyId || !code || !routes.length) return;
    let alive = true;
    setPassengersLoading(true);
    const col = collection(db, "companies", companyId, "passengers");
    const base = [where("partnerCode", "==", code), where("active", "==", true)];
    (async () => {
      try {
        const totalSnap = await getCountFromServer(query(col, ...base));
        const total = totalSnap.data().count;
        const ids = routes.map(r => r.id);
        const byRouteCount = {};
        let i = 0;
        const workers = Array.from({ length: Math.min(8, ids.length) }, async () => {
          while (i < ids.length) {
            const id = ids[i++];
            try {
              const c = await getCountFromServer(query(col, ...base, where("routeId", "==", id)));
              if (c.data().count > 0) byRouteCount[id] = c.data().count;
            } catch (_) { /* 한 노선 실패가 나머지를 막지 않는다 */ }
          }
        });
        await Promise.all(workers);
        const assigned = Object.values(byRouteCount).reduce((a, b) => a + b, 0);
        if (alive) setHeadcount({ byRouteCount, unassignedCount: Math.max(0, total - assigned), total });
      } catch (e) {
        console.warn("[OperationsMode] 승객 집계 오류:", e?.message);
        if (alive) setHeadcount({ byRouteCount: {}, unassignedCount: 0, total: 0 });
      }
      if (alive) setPassengersLoading(false);
    })();
    return () => { alive = false; };
  }, [companyId, code, routes]);

  // 자사 routeId 집합 + 노선별 승객 수 — 정본 = partnerAccess.partnerOpsRoutes
  // 🔴 기준축은 **거래처에 지정된 노선**(routes.partnerCode)이고 승객 배정 노선은 합집합.
  //    승객 배정만으로 모으면 하교·요일별·방과후처럼 아무도 기준노선으로 잡지 않는 노선이
  //    통째로 빠진다(2026-08-11 실측: 채드윅 29개 중 8개만 표시). 되돌리지 말 것.
  const { myRouteIds, byRouteCount, unassignedCount } = useMemo(() => {
    const r = partnerOpsRoutes(routes, code, headcount);
    return { myRouteIds: r.ids, byRouteCount: r.byRouteCount, unassignedCount: r.unassignedCount };
  }, [headcount, routes, code]);

  // 노선 카드용 — routes props에서 매칭 + 필요 정보만 추출.
  const myRoutesList = useMemo(() => {
    const list = [];
    routes.forEach(r => {
      if (myRouteIds.has(r.id)) {
        list.push({
          id: r.id,
          name: r.name || r.code || r.id,
          type: r.type,
          shift: r.shift,
          departTime: r.departTime,
          stopsCount: undefined, // (정류장 수는 lazy load 안 함 — V1에서는 미표시. routePath 길이로도 대용 불가)
          routePath: Array.isArray(r.routePath) ? r.routePath.filter(p => typeof p?.lat === 'number' && typeof p?.lng === 'number') : [],
          employeeCount: byRouteCount.get(r.id) || 0,
        });
      }
    });
    // 🔴 여기서 다시 정렬하지 않는다(2026-08-26 게시판 DqF7nony). 종전엔 **출발시각만으로**
    //    다시 줄을 세워, 관리자가 정한 순서를 덮어쓰고 같은 시각대 노선을 뒤섞었다
    //    (실측: 관리자 9~15번 = 시청광화문 1·2·3 → 불광 1·2·3 인데, 08:15/08:20/08:25 와
    //     08:20/08:30 이 맞물려 포털에선 `시청광화문 2 → 불광 1 → 시청광화문 3` 로 갈렸다).
    //    위 `routes` 가 이미 관리자 순서로 정렬돼 있고 이 forEach 가 그 순서로 돈다.
    return list;
  }, [routes, myRouteIds, byRouteCount]);

  // 노선 필터(노선 카드 클릭 시 토글). null=전체.
  const [routeFilter, setRouteFilter] = useState(null);

  // 구분 필터(등교/하교/방과후 …) — 2026-08-18 배시현 요청.
  // 🔴 하교와 방과후하교는 `shift` 가 똑같이 "하교" 라 데이터만으론 못 가른다(routeKind 주석 참조).
  //    칩은 **이 거래처 노선에 실제로 있는 구분만** 그린다(거래처마다 어휘가 다르다).
  const [kindFilter, setKindFilter] = useState(null);
  const kindChips = useMemo(() => availableRouteKinds(myRoutesList), [myRoutesList]);
  const visibleRoutes = useMemo(
    () => filterRoutesByKind(myRoutesList, kindFilter),
    [myRoutesList, kindFilter]
  );
  const kindRouteIds = useMemo(() => {
    const s = new window.Set();
    visibleRoutes.forEach(r => s.add(r.id));
    return s;
  }, [visibleRoutes]);
  // 구분을 바꿨는데 고른 노선이 그 구분에 없으면 선택을 놓는다(빈 지도 방지).
  useEffect(() => {
    if (routeFilter && !kindRouteIds.has(routeFilter)) setRouteFilter(null);
  }, [routeFilter, kindRouteIds]);

  // ── 노선별 stops lazy fetch(미설정 노선은 폴리라인 폴백용) ──
  const [stopsByRoute, setStopsByRoute] = useState({}); // { routeId: [{id,name,lat,lng,order}] }
  useEffect(() => {
    if (!companyId || myRoutesList.length === 0) return;
    const toLoad = myRoutesList.map(r => r.id).filter(rid => !stopsByRoute[rid]);
    if (toLoad.length === 0) return;
    Promise.all(toLoad.map(async rid => {
      try {
        const snap = await getDocs(query(
          collection(db, "companies", companyId, "routes", rid, "stops"),
          orderBy("order", "asc")
        ));
        return [rid, snap.docs.map(d => ({ id: d.id, ...d.data() }))];
      } catch (_) { return [rid, []]; }
    })).then(pairs => {
      setStopsByRoute(prev => {
        const next = { ...prev };
        pairs.forEach(([rid, stops]) => { next[rid] = stops; });
        return next;
      });
    });
  }, [companyId, myRoutesList, stopsByRoute]);

  // ── GPS 구독 — 우리 회사 + 우리 노선 한정 ─────────────
  // gps 컬렉션은 top-level, doc id = `{companyId}_{vehicleId}`. 문서에 routeId 가 실려 있다
  // (모바일 sendGPS·서버 폴러 pollDeviceVehicleGps 양쪽 모두 기록).
  // 🔴 **배차가 아니라 routeId 로 거른다** — 관리자 실시간 관제(MapTab `allowMapRow(v.routeId)`)와
  //    같은 축. 배차로 거르면 배차 읽기 권한이 없는 이 화면에서는 항상 0대가 된다.
  const [rawBuses, setRawBuses] = useState([]);
  useEffect(() => {
    if (!companyId) return;
    return onSnapshot(
      query(collection(db, "gps"), where("companyId", "==", companyId)),
      snap => {
        const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        // 우리 노선의 차량만
        setRawBuses(list.filter(b => b.routeId && myRouteIds.has(b.routeId)));
      },
      err => {
        console.warn("[OperationsMode] gps 구독 오류:", err.message);
        setRawBuses([]);
      }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, myRouteIds, wakeTick, recoverTick]);
  const buses = useAnimatedPositions(rawBuses);

  // ── 오늘 도착 기록(노선도 통과 ✓) ─────────────────────
  // 🔴 `dispatches` 직접 읽기는 **익명에 닫혀 있다**(read = isAdmin || isDriverOf). 예전엔
  //    이 화면이 그 컬렉션을 구독하다 거부를 빈 배열로 흡수해 ✓ 가 하나도 안 찍혔다.
  //    서버 위임 CF `getRouteStopArrivals`(정본 훅 = src/lib/useRouteStopArrivals.js).
  //    노선이 29개까지 가므로 **한 번에 묶어** 부른다(노선당 1회 호출 금지).
  const arrivalRouteIds = useMemo(
    () => (routeFilter ? [routeFilter] : myRoutesList.map(r => r.id)),
    [routeFilter, myRoutesList]
  );
  const { byRoute: arrivalsByRoute } = useRouteStopArrivals({
    companyId,
    routeIds: arrivalRouteIds,
    active: rawBuses.length > 0, // 버스가 달릴 때만 갱신
    tick: wakeTick + recoverTick,
  });

  const filteredBuses = useMemo(() => (
    routeFilter ? buses.filter(b => b.routeId === routeFilter)
                : buses.filter(b => kindRouteIds.has(b.routeId))
  ), [buses, routeFilter, kindRouteIds]);

  // 지도 중심 — 첫 버스/첫 정류장/한국 기본
  const mapCenter = useMemo(() => {
    if (filteredBuses[0] && filteredBuses[0].lat && filteredBuses[0].lng) {
      return { lat: filteredBuses[0].lat, lng: filteredBuses[0].lng };
    }
    for (const r of visibleRoutes) {
      if (routeFilter && r.id !== routeFilter) continue;
      const ss = stopsByRoute[r.id];
      if (ss && ss.length > 0) return { lat: ss[0].lat, lng: ss[0].lng };
    }
    return { lat: 37.3894, lng: 126.9522 };
  }, [filteredBuses, visibleRoutes, stopsByRoute, routeFilter]);

  // ── 오늘 탑승 현황 ─────────────────────────────────
  // boardings/{today}/list where partnerCode==code. partnerCode 인덱스는 없으나
  // 단일 컬렉션 동등매칭은 자동 단일필드 인덱스로 처리.
  const [todayBoardings, setTodayBoardings] = useState([]);
  const [boardingsLoaded, setBoardingsLoaded] = useState(false);
  useEffect(() => {
    if (!companyId || !code) return;
    return onSnapshot(
      query(
        collection(db, "companies", companyId, "boardings", todayStr, "list"),
        where("partnerCode", "==", code)
      ),
      snap => {
        setTodayBoardings(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        setBoardingsLoaded(true);
      },
      err => {
        console.warn("[OperationsMode] boardings 구독 오류:", err.message);
        setBoardingsLoaded(true);
      }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, code, todayStr, wakeTick, recoverTick]);

  // 노선별 탑승 카운트
  const boardingByRoute = useMemo(() => {
    const m = new window.Map();
    todayBoardings.forEach(b => {
      const k = b.routeId || "_";
      m.set(k, (m.get(k) || 0) + 1);
    });
    return m;
  }, [todayBoardings]);
  const totalEmployees = headcount.total;
  const totalBoarded = todayBoardings.length;
  const boardingRate = totalEmployees > 0 ? Math.round(totalBoarded / totalEmployees * 100) : 0;

  // ── 공지 수신함(EmployeeApp NoticeTab 패턴 일관) ────
  const [notices, setNotices] = useState([]);
  useEffect(() => {
    if (!companyId) return;
    return onSnapshot(
      query(
        collection(db, "companies", companyId, "notices"),
        where("active", "==", true),
        orderBy("createdAt", "desc"),
        limit(20)
      ),
      snap => {
        const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        // partnerCode null=전체 + 우리 코드 일치만(EmployeeApp NoticeTab 패턴)
        setNotices(all.filter(n => {
          const p = n.partnerCode || null;
          return p === null || p === code;
        }));
      },
      err => console.warn("[OperationsMode] notices 구독 오류:", err.message)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, code, wakeTick, recoverTick]);

  const fmtNoticeDate = (n) => {
    const ts = n.createdAt;
    const ms = ts?.toMillis ? ts.toMillis() : (typeof ts === 'number' ? ts : null);
    if (!ms) return "";
    return new Date(ms).toLocaleString("ko-KR", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  // 지도 폴리라인 path 산출 — routePath 우선, 없으면 stops 직선 폴백.
  const routePolylines = useMemo(() => {
    const out = [];
    visibleRoutes.forEach(r => {
      if (routeFilter && r.id !== routeFilter) return;
      let path = r.routePath;
      if (!path || path.length < 2) {
        const ss = stopsByRoute[r.id];
        if (ss && ss.length >= 2) path = ss.map(s => ({ lat: s.lat, lng: s.lng }));
      }
      if (path && path.length >= 2) out.push({ routeId: r.id, path });
    });
    return out;
  }, [visibleRoutes, stopsByRoute, routeFilter]);

  // 지도 컨테이너 ref — 0px init 방어용
  const mapKeyRef = useRef(0);

  // ── 공지 발송(Phase 1.4) ─────────────────────────────
  // CF `sendPartnerNotice` 호출. CF 가 partnerCodes 검증·rate-limit·notices/fcmQueue create.
  const [noticeTitle, setNoticeTitle] = useState("");
  const [noticeBody, setNoticeBody] = useState("");
  const [noticeType, setNoticeType] = useState("normal");
  const [noticeSending, setNoticeSending] = useState(false);
  const [noticeConfirming, setNoticeConfirming] = useState(false);
  const [noticeResult, setNoticeResult] = useState(null); // {ok, msg, tone:"success"|"error", remaining?}
  const [noticeRemaining, setNoticeRemaining] = useState(null); // CF 반환 remainingPerHour 캐시

  // partnerCodes 의 recentNoticeTimestamps onSnapshot 으로 현재 남은 발송 횟수 표시
  // (CF write 후 자동 반영 + 다른 세션 발송도 즉시 가시화).
  // + 라이브 doc 전체 캡처(2026-07-16 회의 #3) — opsControlEnabled 토글이 재로그인 없이 반영되게.
  const [liveCodeData, setLiveCodeData] = useState(null);
  useEffect(() => {
    if (!code) return;
    return onSnapshot(
      doc(db, "partnerCodes", code),
      snap => {
        const data = snap.exists() ? snap.data() : null;
        setLiveCodeData(data);
        const arr = (data && data.recentNoticeTimestamps) || [];
        const cutoff = Date.now() - 60 * 60 * 1000;
        const inWindow = arr.filter(ts => typeof ts === "number" && ts > cutoff);
        const remaining = Math.max(0, PARTNER_NOTICE_LIMIT_PER_HOUR - inWindow.length);
        setNoticeRemaining(remaining);
      },
      err => console.warn("[OperationsMode] partnerCodes 구독 오류:", err.message)
    );
  }, [code, wakeTick, recoverTick]);

  // 관제(운행 현황) 노출 옵션(2026-07-16 회의 #3) — 협력사별 on/off. 부재=true(현행 유지).
  // 정보 과다 노출 → 불필요 CS 우려 대응. AdminApp 협력사 관리 "포탈 설정"에서 토글.
  const opsEnabled = ((liveCodeData ?? codeData) || {}).opsControlEnabled !== false;

  // 거래처 브랜딩(2026-07-16 회의 #5) — 메인 컬러를 포탈에도 적용(라이브 반영·언마운트 시 복원).
  useEffect(() => {
    applyPartnerBranding(((liveCodeData ?? codeData) || {}).branding);
    return () => clearPartnerBranding();
  }, [liveCodeData, codeData]);

  // 노선도(정류장 진행) — 버스의 현재 위치를 가장 가까운 정류장으로 매핑(표시 전용).
  // stops 좌표는 number/string/GeoPoint/nested 혼재(issues toLatLng 규칙) → coercion 필수.
  const stripRoutes = useMemo(() => {
    const toLL = (s) => {
      const lat = Number(s?.lat ?? s?.latitude ?? s?.location?.latitude);
      const lng = Number(s?.lng ?? s?.longitude ?? s?.location?.longitude);
      return (isFinite(lat) && isFinite(lng)) ? { lat, lng } : null;
    };
    const distM = (a, b) => {
      const R = 6371000, rad = x => x * Math.PI / 180;
      const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
      const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(s));
    };
    return visibleRoutes
      .filter(r => !routeFilter || r.id === routeFilter)
      .map(r => {
        const stops = (stopsByRoute[r.id] || []).map(s => ({ id: s.id, name: s.name || "", ll: toLL(s) }));
        // 이 노선의 실측 도착(stopArrivals) = 통과 정류장. 서버가 이미 배차들을 병합해 준다.
        const passed = new window.Set(Object.keys((arrivalsByRoute[r.id] || {}).arrivals || {}));
        // 이 노선 버스 → 가장 가까운 정류장 인덱스
        const busAt = new window.Map(); // stopIdx -> [vehicleNo...]
        filteredBuses.filter(b => b.routeId === r.id && b.lat && b.lng).forEach(b => {
          let best = -1, bestD = Infinity;
          stops.forEach((s, i) => {
            if (!s.ll) return;
            const dd = distM({ lat: b.lat, lng: b.lng }, s.ll);
            if (dd < bestD) { bestD = dd; best = i; }
          });
          if (best >= 0) busAt.set(best, [...(busAt.get(best) || []), b.vehicleNo || "버스"]);
        });
        return { id: r.id, name: r.name, stops, passed, busAt };
      })
      .filter(r => r.stops.length >= 2);
  }, [visibleRoutes, routeFilter, stopsByRoute, arrivalsByRoute, filteredBuses]);

  const noticeTitleLen = noticeTitle.trim().length;
  const noticeBodyLen = noticeBody.trim().length;
  const canSubmit = noticeTitleLen > 0 && noticeTitleLen <= PARTNER_NOTICE_TITLE_MAX
    && noticeBodyLen > 0 && noticeBodyLen <= PARTNER_NOTICE_BODY_MAX
    && !noticeSending && (noticeRemaining === null || noticeRemaining > 0);

  const handleNoticeSubmit = async () => {
    if (!canSubmit) return;
    setNoticeSending(true);
    setNoticeResult(null);
    try {
      const callable = httpsCallable(functions, "sendPartnerNotice");
      const res = await callable({
        companyId,
        partnerCode: code,
        title: noticeTitle.trim(),
        body: noticeBody.trim(),
        type: noticeType,
      });
      const out = res.data || {};
      setNoticeResult({
        ok: true,
        tone: "success",
        msg: `발송 완료 (이번 시간 남은 발송 ${out.remainingPerHour ?? "?"}건)`,
        remaining: out.remainingPerHour,
      });
      setNoticeTitle("");
      setNoticeBody("");
      setNoticeType("normal");
      setNoticeConfirming(false);
    } catch (e) {
      // HttpsError 한국어 메시지(CF 가 생성) 그대로 노출.
      setNoticeResult({
        ok: false,
        tone: "error",
        msg: e?.message || "발송 실패. 잠시 후 다시 시도해주세요",
      });
    } finally {
      setNoticeSending(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* ── 섹션 A: 자사 노선 요약 카드 ─────────────────── */}
      <div style={{ background: "var(--color-bg)", border: "1px solid var(--color-line)", borderRadius: 10, overflow: "hidden" }}>
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--color-line-soft)", fontSize: 12, fontWeight: 700, color: "var(--color-label)", display: "flex", alignItems: "center", gap: 8 }}>
          <span>🛣 자사 노선</span>
          {/* 구분 칩(등교·하교·방과후 …) — 이 거래처 노선에 실제로 있는 구분만.
              하교와 방과후하교가 같은 시간대에 겹쳐 혼선을 준다는 요청(2026-08-18)의 답이다. */}
          {kindChips.map(k => {
            const on = kindFilter === k;
            return (
              <button key={k} onClick={() => setKindFilter(on ? null : k)} style={{
                fontSize: 11, fontWeight: on ? 800 : 600, padding: "3px 10px", borderRadius: 999,
                border: `1px solid ${on ? "var(--color-primary)" : "var(--color-line)"}`,
                background: on ? "var(--color-primary-soft)" : "var(--color-bg-soft)",
                color: on ? "var(--color-primary-deep)" : "var(--color-label-mute)",
                cursor: "pointer", fontFamily: "inherit"
              }}>{k}</button>
            );
          })}
          {(routeFilter || kindFilter) && (
            <button onClick={() => { setRouteFilter(null); setKindFilter(null); }} style={{
              fontSize: 10, padding: "2px 8px", borderRadius: 999, border: "1px solid var(--color-line)",
              background: "var(--color-bg-soft)", color: "var(--color-label-mute)", cursor: "pointer", fontFamily: "inherit"
            }}>전체 보기</button>
          )}
        </div>
        {passengersLoading ? (
          <div style={{ padding: 20, textAlign: "center", color: "var(--color-label-mute)", fontSize: 12 }}>로딩 중...</div>
        ) : visibleRoutes.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--color-label-mute)", fontSize: 13 }}>
            표시할 노선이 없습니다
            <div style={{ fontSize: 11, color: "var(--color-label-alt)", marginTop: 4 }}>
              노선이 등록되면 여기에 표시됩니다
            </div>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8, padding: 12 }}>
            {visibleRoutes.map(r => {
              const active = routeFilter === r.id;
              return (
                <div key={r.id} onClick={() => setRouteFilter(active ? null : r.id)}
                  style={{
                    background: active ? "var(--color-primary-soft)" : "var(--color-bg-soft)",
                    border: `1px solid ${active ? "var(--color-primary)" : "var(--color-line)"}`,
                    borderRadius: 10, padding: "10px 12px", cursor: "pointer",
                  }}>
                  {/* 🔴 노선명은 자르지 않는다(2026-08-11) — 채드윅 이름이 44자라 한 줄 말줄임이면
                      `[H1] 등교(월~수,금) / To S…` 처럼 구분이 안 된다. 글자 크기는 줄이지 않고
                      줄바꿈으로 푼다(2026-08-07 승객앱과 같은 결정). `keep-all` 만으로는 띄어쓰기
                      없는 긴 이름이 가로로 넘치므로 `anywhere` 병용. */}
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 6, marginBottom: 4 }}>
                    <span style={{ fontSize: 13, fontWeight: 800, color: active ? "var(--color-primary-deep)" : "var(--color-label)", flex: 1, minWidth: 0, wordBreak: "keep-all", overflowWrap: "anywhere" }}>{r.name}</span>
                    {r.type && <Pill tone="primary">{r.type}</Pill>}
                  </div>
                  <div style={{ display: "flex", gap: 8, fontSize: 11, color: "var(--color-label-mute)" }}>
                    {r.departTime && <span>🕒 {r.departTime}</span>}
                    <span>👤 {r.employeeCount}명</span>
                  </div>
                </div>
              );
            })}
            {unassignedCount > 0 && (
              <div style={{
                background: "var(--color-bg-soft)", border: "1px dashed var(--color-line)",
                borderRadius: 10, padding: "10px 12px",
              }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "var(--color-label-mute)", marginBottom: 4 }}>미배정</div>
                <div style={{ fontSize: 11, color: "var(--color-label-alt)" }}>👤 {unassignedCount}명</div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── 섹션 B: 실시간 버스 위치 (카카오맵) — 협력사별 노출 옵션(opsControlEnabled) ── */}
      {opsEnabled && (
      <div style={{ background: "var(--color-bg)", border: "1px solid var(--color-line)", borderRadius: 10, overflow: "hidden" }}>
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--color-line-soft)", fontSize: 12, fontWeight: 700, color: "var(--color-label)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>📍 실시간 버스 위치</span>
          <span style={{ fontSize: 11, fontWeight: 600, color: filteredBuses.length > 0 ? "var(--color-positive)" : "var(--color-label-mute)" }}>
            {filteredBuses.length > 0 ? `${filteredBuses.length}대 운행 중` : "운행 중인 차량 없음"}
          </span>
        </div>
        {myRoutesList.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--color-label-mute)", fontSize: 13 }}>
            표시할 노선이 없습니다
          </div>
        ) : (
          <div style={{ height: wide ? "56vh" : "40vh", minHeight: wide ? 420 : 280, position: "relative" }}>
            <KakaoMap key={routeFilter || "all"} center={mapCenter} style={{ width: "100%", height: "100%" }} level={routeFilter ? 6 : 9}
              onCreate={m => { m.relayout(); setTimeout(() => m.relayout(), 300); mapKeyRef.current++; }}>
              {/* 노선 폴리라인 */}
              {routePolylines.map(rp => (
                <Polyline key={rp.routeId} path={rp.path} strokeWeight={4} strokeColor="#0066FF" strokeOpacity={0.6} strokeStyle="solid" />
              ))}
              {/* 정류장 마커 — 작은 빨간 점(필터된 노선만, 너무 많으면 생략) */}
              {routeFilter && (stopsByRoute[routeFilter] || []).map((s, i) => (
                <MapMarker key={`stop-${s.id}`} position={{ lat: s.lat, lng: s.lng }}
                  image={{
                    src: "https://t1.daumcdn.net/localimg/localimages/07/mapapidoc/marker_red.png",
                    size: { width: 16, height: 24 }
                  }}
                />
              ))}
              {/* 버스 마커 — 차량번호·노선명·속도. 신호가 5분 넘게 끊기면 회색(관리자 관제와 같은 잣대).
                  🔴 치수는 승객앱 노선 지도(2026-08-18 "아이콘이 너무 크다")와 같은 값으로 맞춘다 —
                     테두리 1.5px·패딩 2/7·글자 9.5/8.5·아이콘 11. 노선이 29개면 마커가 겹쳐
                     예전 크기(2px·5/10·11/9·이모지 16)로는 지도를 덮는다.
                  🔴 차량번호는 빼지 말 것 — 한 노선에 2대가 뜨면 그게 유일한 구분자다. */}
              {filteredBuses.map(b => {
                if (!b.lat || !b.lng) return null;
                const stale = gpsAgeMs(b.updatedAt) >= MARKER_STALE_MS;
                const tone = stale ? "var(--color-label-alt)" : "var(--color-primary)";
                return (
                <CustomOverlayMap key={b.id} position={{ lat: b.lat, lng: b.lng }} yAnchor={1.5}>
                  <div style={{ position: "relative", display: "inline-block" }}>
                    {!stale && (
                      <span style={{
                        position: "absolute", inset: -2, borderRadius: 999,
                        background: "var(--color-primary)", opacity: 0.4,
                        animation: "buspulse 2s ease-out infinite", pointerEvents: "none"
                      }} />
                    )}
                    <div style={{
                      position: "relative", background: "var(--color-bg)",
                      border: `1.5px solid ${tone}`, borderRadius: 999,
                      padding: "2px 7px", display: "flex", alignItems: "center", gap: 4,
                      boxShadow: "var(--shadow-emphasize)",
                    }}>
                      <span style={{ display: "inline-flex", color: tone }}><Icon name="bus" size={11} stroke={2} /></span>
                      <div style={{ lineHeight: 1.2 }} title={b.routeName || ""}>
                        <div style={{ fontSize: 9.5, fontWeight: 800, color: tone }}>
                          {b.vehicleNo || b.vehicleId || "차량"}
                        </div>
                        <div style={{ fontSize: 8.5, color: "var(--color-label-mute)" }}>
                          {stale ? "신호 지연" : `${Math.round(b.speed || 0)} km/h`}
                          {/* 🔴 노선명 전문을 붙이면 마커가 190px 까지 벌어진다(채드윅 이름이 44자).
                              구분(등교·하교·방과후)만 붙인다 — 이 요청이 가르고 싶어 한 축이 그것이고,
                              전체 이름은 마우스를 올리면 나온다. */}
                          {routeKind({ name: b.routeName }) ? ` · ${routeKind({ name: b.routeName })}` : ""}
                        </div>
                      </div>
                    </div>
                  </div>
                </CustomOverlayMap>
                );
              })}
            </KakaoMap>
            {filteredBuses.length === 0 && (
              <div style={{
                position: "absolute", top: 8, left: 8, right: 8,
                background: "rgba(255,255,255,0.95)", border: "1px solid var(--color-line)",
                borderRadius: 8, padding: "6px 10px", fontSize: 11, fontWeight: 600,
                color: "var(--color-label-mute)", textAlign: "center", pointerEvents: "none"
              }}>
                ⓘ 운행이 시작되면 이 지도에 버스가 표시됩니다
              </div>
            )}
          </div>
        )}
      </div>
      )}

      {/* PC 는 아래 네 판을 2열로 나란히 놓는다(가로를 채운다). 모바일은 예전대로 한 줄씩.
          🔴 `auto-fit` 이라 노출 옵션이 꺼져 판이 하나만 남아도 그 하나가 가로를 다 쓴다. */}
      <div style={wide
        ? { display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(420px, 1fr))", gap:14, alignItems:"start" }
        : { display:"flex", flexDirection:"column", gap:14 }}>

      {/* ── 섹션 B2: 차량 운행 현황 — 노선도(정류장 진행) (2026-07-16 회의 #3) ── */}
      {opsEnabled && (
      <div style={{ background: "var(--color-bg)", border: "1px solid var(--color-line)", borderRadius: 10, overflow: "hidden" }}>
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--color-line-soft)", fontSize: 12, fontWeight: 700, color: "var(--color-label)" }}>
          🚏 차량 운행 현황 (노선도)
        </div>
        {stripRoutes.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: "var(--color-label-mute)", fontSize: 12 }}>
            표시할 노선(정류장 2개 이상)이 없습니다
          </div>
        ) : (
          <div style={{ padding: "12px 0", display: "flex", flexDirection: "column", gap: 14 }}>
            {stripRoutes.map(r => (
              <div key={r.id}>
                <div style={{ padding: "0 14px 8px", fontSize: 12, fontWeight: 800, color: "var(--color-label)" }}>
                  {r.name}
                  <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 600, color: r.busAt.size > 0 ? "var(--color-positive)" : "var(--color-label-alt)" }}>
                    {r.busAt.size > 0 ? "운행 중" : "대기"}
                  </span>
                </div>
                {/* 가로 스크롤 정류장 스트립 — 통과=파랑 ✓ · 현재 버스 위치=🚌 */}
                <div style={{ overflowX: "auto", padding: "14px 14px 4px", WebkitOverflowScrolling: "touch" }}>
                  <div style={{ display: "flex", alignItems: "flex-start" }}>
                    {r.stops.map((s, i) => {
                      const isPassed = r.passed.has(s.id);
                      const busesHere = r.busAt.get(i) || [];
                      return (
                        <div key={s.id} style={{ display: "flex", alignItems: "flex-start", flexShrink: 0 }}>
                          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 64, position: "relative" }}>
                            {busesHere.length > 0 && (
                              <div style={{ position: "absolute", top: -14, fontSize: 14, lineHeight: 1 }} title={busesHere.join(", ")}>🚌</div>
                            )}
                            <div style={{
                              width: 14, height: 14, borderRadius: 999, boxSizing: "border-box",
                              background: isPassed ? "var(--color-primary)" : "var(--color-bg)",
                              border: `2px solid ${isPassed ? "var(--color-primary)" : "var(--color-line)"}`,
                              color: "#fff", fontSize: 9, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center",
                            }}>{isPassed ? "✓" : ""}</div>
                            <div style={{ marginTop: 4, fontSize: 10, fontWeight: isPassed ? 700 : 500, color: isPassed ? "var(--color-primary-deep)" : "var(--color-label-mute)", textAlign: "center", width: 62, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.name}>
                              {s.name}
                            </div>
                          </div>
                          {i < r.stops.length - 1 && (
                            <div style={{ width: 26, height: 2, marginTop: 6, flexShrink: 0, background: isPassed ? "var(--color-primary)" : "var(--color-line)" }} />
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      )}

      {/* ── 섹션 C: 오늘 탑승 현황 ─────────────────────── */}
      <div style={{ background: "var(--color-bg)", border: "1px solid var(--color-line)", borderRadius: 10, overflow: "hidden" }}>
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--color-line-soft)", fontSize: 12, fontWeight: 700, color: "var(--color-label)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>🎫 오늘 탑승 현황</span>
          <span style={{ fontSize: 10, fontWeight: 600, color: "var(--color-label-alt)" }}>{todayStr}</span>
        </div>
        <div style={{ padding: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 12 }}>
            <div style={S.statCard}>
              <div style={{ fontSize: 22, fontWeight: 800, color: "var(--color-primary)", fontFamily: "var(--font-brand)" }}>
                {totalBoarded}
              </div>
              <div style={{ fontSize: 11, color: "var(--color-label-mute)", fontWeight: 600, marginTop: 2 }}>탑승 인원</div>
            </div>
            <div style={S.statCard}>
              <div style={{ fontSize: 22, fontWeight: 800, color: "var(--color-positive)", fontFamily: "var(--font-brand)" }}>
                {totalEmployees}
              </div>
              <div style={{ fontSize: 11, color: "var(--color-label-mute)", fontWeight: 600, marginTop: 2 }}>전체 승객</div>
            </div>
            <div style={S.statCard}>
              <div style={{ fontSize: 22, fontWeight: 800, color: "var(--color-cautionary)", fontFamily: "var(--font-brand)" }}>
                {boardingRate}%
              </div>
              <div style={{ fontSize: 11, color: "var(--color-label-mute)", fontWeight: 600, marginTop: 2 }}>탑승률</div>
            </div>
          </div>
          {/* 노선별 미니 차트(상위 5) */}
          {boardingByRoute.size > 0 ? (
            <div>
              {[...boardingByRoute.entries()]
                .map(([rid, c]) => {
                  const r = myRoutesList.find(x => x.id === rid);
                  return { rid, name: r?.name || "노선 미지정", count: c };
                })
                .sort((a, b) => b.count - a.count)
                .slice(0, 5)
                .map(item => {
                  const peak = Math.max(...[...boardingByRoute.values()], 1);
                  return (
                    <div key={item.rid} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}>
                      <span style={{ fontSize: 11, color: "var(--color-label-mute)", width: 100, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {item.name}
                      </span>
                      <div style={{ flex: 1, height: 12, background: "var(--color-bg-soft)", borderRadius: 3, overflow: "hidden" }}>
                        <div style={{ width: `${(item.count / peak) * 100}%`, height: "100%", background: "var(--color-primary)", borderRadius: 3 }} />
                      </div>
                      <span style={{ fontSize: 11, fontWeight: 800, color: "var(--color-primary)", width: 32, textAlign: "right" }}>{item.count}</span>
                    </div>
                  );
                })}
              <div style={{ fontSize: 10, color: "var(--color-label-alt)", textAlign: "right", marginTop: 6 }}>
                ⓘ 상세 통계는 <span style={{ fontWeight: 700, color: "var(--color-primary)" }}>📊 탑승 통계</span> 탭
              </div>
            </div>
          ) : (
            <div style={{ textAlign: "center", padding: 16, color: "var(--color-label-mute)", fontSize: 12, background: "var(--color-bg-soft)", borderRadius: 8 }}>
              {boardingsLoaded ? "오늘 탑승 기록이 없습니다" : "조회 중..."}
            </div>
          )}
        </div>
      </div>

      {/* ── 섹션 C2(Phase 1.4): 공지 발송 ───────────────── */}
      <div style={{ background: "var(--color-bg)", border: "1px solid var(--color-line)", borderRadius: 10, overflow: "hidden" }}>
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--color-line-soft)", fontSize: 12, fontWeight: 700, color: "var(--color-label)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>📢 공지 발송</span>
          <span style={{ fontSize: 10, fontWeight: 600, color: noticeRemaining === 0 ? "var(--color-destructive)" : "var(--color-label-alt)" }}>
            {noticeRemaining === null ? "" : `시간당 남은 발송 ${noticeRemaining}/${PARTNER_NOTICE_LIMIT_PER_HOUR}건`}
          </span>
        </div>
        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          {/* 제목 */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "var(--color-label-mute)" }}>제목</label>
              <span style={{ fontSize: 10, color: noticeTitleLen > PARTNER_NOTICE_TITLE_MAX ? "var(--color-destructive)" : "var(--color-label-alt)" }}>
                {noticeTitleLen}/{PARTNER_NOTICE_TITLE_MAX}
              </span>
            </div>
            <input
              type="text"
              value={noticeTitle}
              onChange={e => setNoticeTitle(e.target.value)}
              maxLength={PARTNER_NOTICE_TITLE_MAX}
              placeholder="예) 내일 정상 운행 안내"
              disabled={noticeSending}
              style={{
                width: "100%", padding: "8px 10px", fontSize: 13,
                border: "1px solid var(--color-line)", borderRadius: 6,
                background: "var(--color-bg)", color: "var(--color-label)",
                fontFamily: "inherit", boxSizing: "border-box",
              }}
            />
          </div>
          {/* 본문 */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "var(--color-label-mute)" }}>본문</label>
              <span style={{ fontSize: 10, color: noticeBodyLen > PARTNER_NOTICE_BODY_MAX ? "var(--color-destructive)" : "var(--color-label-alt)" }}>
                {noticeBodyLen}/{PARTNER_NOTICE_BODY_MAX}
              </span>
            </div>
            <textarea
              value={noticeBody}
              onChange={e => setNoticeBody(e.target.value)}
              maxLength={PARTNER_NOTICE_BODY_MAX}
              placeholder="공지 본문을 입력하세요"
              rows={4}
              disabled={noticeSending}
              style={{
                width: "100%", padding: "8px 10px", fontSize: 13,
                border: "1px solid var(--color-line)", borderRadius: 6,
                background: "var(--color-bg)", color: "var(--color-label)",
                fontFamily: "inherit", resize: "vertical", boxSizing: "border-box",
                lineHeight: 1.5,
              }}
            />
          </div>
          {/* type 라디오 */}
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "var(--color-label-mute)" }}>구분</label>
            {[
              { value: "normal", label: "📢 일반", color: "var(--color-primary)" },
              { value: "emergency", label: "🚨 긴급", color: "var(--color-destructive)" },
            ].map(opt => (
              <label key={opt.value} style={{ display: "flex", alignItems: "center", gap: 4, cursor: noticeSending ? "default" : "pointer" }}>
                <input
                  type="radio"
                  name="partnerNoticeType"
                  value={opt.value}
                  checked={noticeType === opt.value}
                  onChange={() => setNoticeType(opt.value)}
                  disabled={noticeSending}
                  style={{ accentColor: opt.color }}
                />
                <span style={{ fontSize: 12, fontWeight: 600, color: noticeType === opt.value ? opt.color : "var(--color-label-mute)" }}>
                  {opt.label}
                </span>
              </label>
            ))}
          </div>
          {/* 발송 버튼 / 컨펌 */}
          {!noticeConfirming ? (
            <button
              type="button"
              onClick={() => setNoticeConfirming(true)}
              disabled={!canSubmit}
              style={{
                padding: "10px 14px", fontSize: 13, fontWeight: 800,
                background: canSubmit ? "var(--color-primary)" : "var(--color-bg-soft)",
                color: canSubmit ? "#fff" : "var(--color-label-mute)",
                border: "none", borderRadius: 8,
                cursor: canSubmit ? "pointer" : "default",
                boxShadow: canSubmit ? "0 2px 6px rgba(0,102,255,.25)" : "none",
                fontFamily: "inherit",
              }}>
              {noticeRemaining === 0 ? "이번 시간 발송 한도 초과" : "발송하기"}
            </button>
          ) : (
            <div style={{
              background: "var(--color-bg-soft)", border: "1px solid var(--color-line)",
              borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 8,
            }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--color-label)" }}>
                자사 승객에게 공지가 발송됩니다. 발송하시겠습니까?
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  onClick={handleNoticeSubmit}
                  disabled={noticeSending}
                  style={{
                    flex: 1, padding: "8px 12px", fontSize: 12, fontWeight: 800,
                    background: noticeType === "emergency" ? "var(--color-destructive)" : "var(--color-primary)",
                    color: "#fff", border: "none", borderRadius: 6,
                    cursor: noticeSending ? "default" : "pointer", fontFamily: "inherit",
                  }}>
                  {noticeSending ? "발송 중..." : "확인 — 발송"}
                </button>
                <button
                  type="button"
                  onClick={() => setNoticeConfirming(false)}
                  disabled={noticeSending}
                  style={{
                    flex: 1, padding: "8px 12px", fontSize: 12, fontWeight: 700,
                    background: "var(--color-bg)", color: "var(--color-label-mute)",
                    border: "1px solid var(--color-line)", borderRadius: 6,
                    cursor: noticeSending ? "default" : "pointer", fontFamily: "inherit",
                  }}>
                  취소
                </button>
              </div>
            </div>
          )}
          {/* 결과 카드 */}
          {noticeResult && (
            <div style={{
              background: noticeResult.tone === "success" ? "#E8F7EE" : "#FCE5E5",
              border: `1px solid ${noticeResult.tone === "success" ? "#9FD9B0" : "#F6C9C9"}`,
              borderRadius: 8, padding: "8px 10px",
              fontSize: 12, fontWeight: 600,
              color: noticeResult.tone === "success" ? "#1F7A3C" : "#A81818",
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
            }}>
              <span>{noticeResult.tone === "success" ? "✅" : "⚠️"} {noticeResult.msg}</span>
              <button
                type="button"
                onClick={() => setNoticeResult(null)}
                style={{
                  background: "transparent", border: "none", cursor: "pointer",
                  fontSize: 12, color: "inherit", padding: 0, fontFamily: "inherit",
                }}>닫기</button>
            </div>
          )}
        </div>
      </div>

      {/* ── 섹션 D: 공지 수신함 ─────────────────────────── */}
      <div style={{ background: "var(--color-bg)", border: "1px solid var(--color-line)", borderRadius: 10, overflow: "hidden" }}>
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--color-line-soft)", fontSize: 12, fontWeight: 700, color: "var(--color-label)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>📢 공지사항</span>
          <span style={{ fontSize: 10, fontWeight: 600, color: "var(--color-label-alt)" }}>최근 {notices.length}건</span>
        </div>
        <div style={{ maxHeight: 360, overflowY: "auto", padding: 12 }}>
          {notices.length === 0 ? (
            <div style={{ textAlign: "center", padding: 24, color: "var(--color-label-mute)", fontSize: 13 }}>
              <div style={{ fontSize: 28, marginBottom: 6 }}>📭</div>
              등록된 공지사항이 없습니다
            </div>
          ) : notices.map(n => {
            const emergency = n.type === "emergency";
            return (
              <div key={n.id} style={{
                background: "var(--color-bg)",
                border: `1px solid ${emergency ? "#F6C9C9" : "var(--color-line)"}`,
                borderLeft: `4px solid ${emergency ? "var(--color-destructive)" : "var(--color-primary)"}`,
                borderRadius: 10, padding: "10px 12px", marginBottom: 8,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, flexWrap: "wrap" }}>
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 999,
                    background: emergency ? "#FCE5E5" : "var(--color-primary-soft)",
                    color: emergency ? "#A81818" : "var(--color-primary-deep)"
                  }}>
                    {emergency ? "🚨 긴급" : "📢 공지"}
                  </span>
                  <span style={{ fontSize: 10, color: "var(--color-label-alt)", fontWeight: 600 }}>
                    {fmtNoticeDate(n)}
                  </span>
                </div>
                <div style={{ fontSize: 13, fontWeight: 800, color: "var(--color-label)", marginBottom: 3, lineHeight: 1.4, wordBreak: "keep-all" }}>
                  {n.title}
                </div>
                <div style={{ fontSize: 12, color: "var(--color-label-mute)", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "keep-all" }}>
                  {n.body}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      </div>
    </div>
  );
}

// 협력사 포털 «노선별 정류장 탑승» 머리줄 — 🔴 display:flex 금지(td 가 table-cell 을 벗어나면 열 정렬이 죽는다).
const pStopGroupHead = { padding: "7px 10px", background: "var(--color-bg-soft)", borderTop: "1px solid var(--color-line)", borderBottom: "1px solid var(--color-line-soft)", fontSize: 12, whiteSpace: "nowrap", verticalAlign: "middle" };

// 탑승 시각 표기 — 관리자 탑승 통계(AdminApp fmtTime)와 같은 규칙.
function fmtBoardTime(ts) {
  if (!ts) return "–";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
