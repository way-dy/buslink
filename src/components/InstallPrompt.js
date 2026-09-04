// src/components/InstallPrompt.js
// ---------------------------------------------------------------------------
// 설치형 앱(PWA) 설치 유도 팝업. 순수 프레젠테이션 + 브라우저 API 만 사용.
// Firebase/로직 import 금지. /p(EmployeeApp)·기사앱(DriverApp) 최상위에 1줄 마운트.
//
// 동작 요약
//  - 이미 설치(standalone)면 렌더 안 함.
//  - Android/Chrome: beforeinstallprompt 가로채 stash → 하단 배너 → [설치] 시 네이티브 프롬프트.
//  - Android(BIP 미발화): "Chrome 메뉴 → 홈 화면에 추가" 수동 안내(android-manual).
//  - iOS Safari: beforeinstallprompt 미지원이므로 단계 번호 일러스트 바텀시트로 안내.
//  - **인앱 브라우저(카톡 등): 설치 안내 대신 «인터넷 브라우저로 열기»(inapp, 2026-09-04).**
//  - 닫기/나중에: **이번 방문에만** 숨김 → 다음에 앱을 열면 다시 뜬다(설치할 때까지).
//  - appinstalled 또는 standalone 이면 영구 비표시. «이미 설치했어요» 자가신고는 30일 침묵.
//
// 🔴 2026-09-04 정책 변경 두 건 — 한 벌이다. 한쪽만 되돌리지 말 것.
//   ① way «설치할 때까지 팝업»: 3일 스누즈 → **방문마다 재노출**(세션당 1회).
//   ② 인앱 브라우저 분기: 카톡 안에서는 `beforeinstallprompt` 가 아예 발생하지 않아
//      **설치가 원천 불가능**하다. ①만 넣으면 카톡 승객에게 «닫아도 계속 뜨는데 눌러도
//      설치가 안 되는» 광고가 된다. ②가 그 사람들을 설치 가능한 브라우저로 보낸다.
//   되돌리려면 NAG_UNTIL_INSTALL 를 false 로(옛 SNOOZE_DAYS 경로가 그대로 살아 있다).
//
// export
//  - default InstallPrompt   : 자동 노출 바텀시트(스누즈·standalone 가드 포함)
//  - named  InstallGuide     : 설치 단계 안내 UI 단독(설정 탭 인라인 재사용 — 가드 없음)
// ---------------------------------------------------------------------------
import React, { useEffect, useState } from "react";
import { Btn } from "./ui";
import { resolveAppIcons } from "../lib/appIcons";
import { withEulReul } from "../lib/josa";
import { detectBrowserEnv, buildEscapeGuide } from "../lib/inAppBrowser";

const LS_KEY = "buslink_pwa_prompt";
// 이번 «방문» 표식. sessionStorage 라 탭을 닫았다 다시 열면 사라진다 = 다음 방문에 또 뜬다.
// 🔴 localStorage 로 옮기지 말 것 — 그 순간 «설치할 때까지» 가 «한 번 닫으면 끝» 이 된다.
const SS_KEY = "buslink_pwa_prompt_session";

// 주소에 `?install=1` 이 있으면 3일 스누즈를 무시하고 다시 띄운다(2026-08-30 way «다시 안 보여»).
// 🔴 스누즈 자체는 그대로 둔다 — 매번 뜨면 광고가 된다. 이건 «지금 보고 싶다» 는 통로다.
// 🔴 이미 설치된(standalone) 상태는 여전히 안 뜬다 — 설치한 사람에게 설치를 권할 이유가 없다.
// 설정 탭 «📲 앱 설치하기» 는 예전부터 스누즈와 무관한 상시 진입점이다(이건 그걸 못 찾는 사람용).
function isForcedByUrl() {
  try {
    const v = new URLSearchParams(window.location.search).get("install");
    return v === "1" || v === "true";
  } catch {
    return false;
  }
}
// 옛 정책(2026-09-04 이전) — 되돌리기용으로 코드 경로째 남겨 둔다. NAG_UNTIL_INSTALL=false 면 부활.
const SNOOZE_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/** way «설치할 때까지 팝업»(2026-09-04). 「나중에」는 이번 방문에만 유효해진다. */
const NAG_UNTIL_INSTALL = true;

/**
 * «이미 설치했어요» 자가신고의 침묵 기간.
 * 🔴 영구로 두지 않는 이유: 잘못 눌렀거나 나중에 앱을 지운 사람에게 **영영** 안 뜨게 된다.
 * 🔴 그렇다고 없앨 수도 없다: iOS 는 `appinstalled` 이벤트가 없어서, 설치한 사람이 카톡
 *    링크로 다시 들어오면(브라우저 탭 = standalone 아님) 계속 설치를 권하게 된다.
 */
const SELF_REPORT_DAYS = 30;

// 이미 설치된(홈 화면 실행) 상태인가
function isStandalone() {
  try {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true
    );
  } catch {
    return false;
  }
}

// iOS(iPhone/iPad) 인가
function isIos() {
  const ua = window.navigator.userAgent || "";
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ 는 Mac 으로 위장하나 터치 포인트로 구분
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

// iOS(iPhone/iPad) Safari 인가 — Chrome/Firefox iOS 등 in-app 브라우저는 제외(과도 노출 방지)
function isIosSafari() {
  if (!isIos()) return false;
  const ua = window.navigator.userAgent || "";
  // Safari 만: CriOS(Chrome)·FxiOS(Firefox)·EdgiOS(Edge)·OPiOS(Opera) 등 배제
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA|Line|FBAN|FBAV|Instagram|KAKAOTALK/.test(ua);
  return isSafari;
}

// 안드로이드 Chrome/삼성 인터넷(Samsung Internet) 등 PWA 설치 지원 브라우저 — in-app 브라우저는 제외
function isAndroidPwaCapable() {
  const ua = window.navigator.userAgent || "";
  if (!/Android/.test(ua)) return false;
  // 카카오톡·라인·페북 등 인앱 브라우저는 BIP 미지원 + PWA 설치 메뉴도 없음 → 안내 무용
  if (/FBAN|FBAV|Instagram|KAKAOTALK|Line\//.test(ua)) return false;
  // Chrome / Edge / Samsung Internet 모두 PWA 설치 지원
  return /Chrome|SamsungBrowser|EdgA/.test(ua);
}

// 최근에 닫았으면(3일 이내) true
// ★ installed 플래그 검증식: 실제 standalone 아닌데 플래그만 남아있으면 PWA 삭제로 간주 → flag 자동 청소.
// 사용자가 홈 아이콘 길게 눌러 PWA 삭제해도 origin localStorage는 잔존 → 영구 차단 결함(iOS 빈번).
function isSnoozed() {
  // 이번 방문에 이미 띄웠으면 다시 띄우지 않는다. 이게 없으면 탭을 옮길 때마다 팝업이 떠서
  // **앱을 쓸 수 없게** 된다 — «설치할 때까지» 는 «매 순간» 이 아니라 «방문마다» 다.
  if (NAG_UNTIL_INSTALL) {
    try {
      if (sessionStorage.getItem(SS_KEY)) return true;
    } catch {
      /* sessionStorage 불가 환경(시크릿·인앱) — 아래 판정으로 계속 */
    }
  }
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return false;
    const { dismissedAt, installed, selfReportedAt } = JSON.parse(raw);
    if (installed) {
      // standalone이면 진짜 설치 상태 — 영구 비표시 유지(여기 도달 전 isStandalone() 분기에서 처리되나 안전망)
      if (isStandalone()) return true;
      // standalone 아닌데 installed flag만 → PWA 삭제됨 → flag 청소하고 안내 재노출
      try { localStorage.removeItem(LS_KEY); } catch {}
      return false;
    }
    // «이미 설치했어요» 자가신고 — 30일 침묵 후 다시 물어본다(위 SELF_REPORT_DAYS 주석 참조).
    if (selfReportedAt && Date.now() - selfReportedAt < SELF_REPORT_DAYS * DAY_MS) return true;
    if (!dismissedAt) return false;
    // 🔴 새 정책에서는 「나중에」가 **날짜로 남지 않는다**(이번 방문 표식은 위 sessionStorage).
    //    남긴 dismissedAt 은 옛 정책으로 되돌릴 때 그대로 쓰인다.
    if (NAG_UNTIL_INSTALL) return false;
    return Date.now() - dismissedAt < SNOOZE_DAYS * DAY_MS;
  } catch {
    return false;
  }
}

// 이번 방문에만 숨김. 다음에 앱을 열면 다시 뜬다.
function writeDismiss() {
  try { sessionStorage.setItem(SS_KEY, "1"); } catch { /* 무해 처리 */ }
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ dismissedAt: Date.now() }));
  } catch {
    /* localStorage 불가 환경 무해 처리 */
  }
}

// «이미 설치했어요» — 승객 자가신고. 30일 침묵.
function writeSelfReported() {
  try { sessionStorage.setItem(SS_KEY, "1"); } catch { /* 무해 처리 */ }
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ selfReportedAt: Date.now() }));
  } catch {
    /* 무해 처리 */
  }
}

function writeInstalled() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ installed: true, dismissedAt: Date.now() }));
  } catch {
    /* 무해 처리 */
  }
}

// iOS 공유 아이콘(네모+위 화살표) 묘사 — 단계 일러스트·인라인 보조 공용.
function ShareGlyph({ size = 18, color = "#0066FF" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true"
      style={{ display: "block" }}>
      <path d="M12 3v11" stroke={color} strokeWidth="2" strokeLinecap="round" />
      <path d="M8.5 6.5 12 3l3.5 3.5" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6 11v8a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-8" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// '홈 화면에 추가' 메뉴 항목 묘사(네모+ 안의 +) — 단계 ② 일러스트.
function AddToHomeGlyph({ size = 18, color = "#0066FF" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true"
      style={{ display: "block" }}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="4" stroke={color} strokeWidth="2" />
      <path d="M12 8v8M8 12h8" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// iPhone Safari 하단 툴바 모형 — 공유 버튼 위치를 화살표로 가리킴(단계 ① 시각 표시).
function SafariToolbarHint() {
  return (
    <div style={{ position: "relative", paddingTop: 26 }}>
      {/* 공유 버튼을 가리키는 화살표 + 안내 */}
      <div style={{
        position: "absolute", top: 0, left: "50%", transform: "translateX(-50%)",
        display: "flex", flexDirection: "column", alignItems: "center",
      }}>
        <span style={{ fontSize: 11, fontWeight: 800, color: "#0066FF", whiteSpace: "nowrap" }}>여기를 탭</span>
        <svg width="14" height="12" viewBox="0 0 14 12" fill="none" aria-hidden="true">
          <path d="M7 12 1 3h12L7 12Z" fill="#0066FF" />
        </svg>
      </div>
      {/* 툴바 모형 */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-around",
        background: "#f2f2f3", border: "1px solid rgba(112,115,124,0.18)",
        borderRadius: 12, padding: "9px 8px",
      }}>
        {/* 좌우 더미 아이콘 */}
        <span style={{ width: 16, height: 16, borderRadius: 3, border: "2px solid #b9bcc4" }} />
        <span style={{ width: 16, height: 16, borderRadius: 3, border: "2px solid #b9bcc4" }} />
        {/* 공유 버튼(강조) */}
        <span style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: 30, height: 30, borderRadius: 8, background: "#fff",
          boxShadow: "0 0 0 2px #0066FF",
        }}>
          <ShareGlyph size={17} />
        </span>
        <span style={{ width: 16, height: 16, borderRadius: 3, border: "2px solid #b9bcc4" }} />
        <span style={{ width: 16, height: 16, borderRadius: 3, border: "2px solid #b9bcc4" }} />
      </div>
    </div>
  );
}

// 단계 행 — 번호 원 + 일러스트 + 텍스트.
function StepRow({ n, glyph, children }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
      <span style={{
        flexShrink: 0, width: 24, height: 24, borderRadius: "50%",
        background: "#0066FF", color: "#fff", fontSize: 13, fontWeight: 800,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {n}
      </span>
      <div style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.55, paddingTop: 2,
        color: "var(--color-label, #171719)" }}>
        {children}
      </div>
      {glyph && (
        <span style={{
          flexShrink: 0, width: 34, height: 34, borderRadius: 8,
          background: "var(--color-primary-soft, #EAF1FF)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          {glyph}
        </span>
      )}
    </div>
  );
}

// ─── InstallGuide — 설치 단계 안내 UI(가드 없음, 단독 재사용 가능) ─────────
// platform: "ios" | "android-manual" | "android"(=android-manual 와 동일 텍스트) | "auto"
//   - "auto": 현재 기기를 감지해 적절한 안내 표시(설정 탭 인라인용).
// onInstall: android 네이티브 프롬프트 핸들러(있을 때만 "설치" 버튼 노출).
// brandName = 홈 화면에 생길 앱 이름. 거래처 워드마크를 쓰는 화면이 자기 이름을 넘긴다
// (2026-08-28). 안 넘기면 "BusLink" — 관리자·기사·협력사 화면은 예전 그대로다.
export function InstallGuide({ platform = "auto", onInstall, inline = false, brandName = "BusLink" }) {
  // auto → 실제 기기 감지
  let mode = platform;
  if (mode === "auto") {
    if (isIos()) mode = "ios";
    else mode = "android-manual";
  }

  const wrapStyle = inline
    ? { padding: "10px 18px 16px" }
    : { padding: 0 };

  if (mode === "ios") {
    return (
      <div style={wrapStyle}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <StepRow n={1} glyph={<ShareGlyph size={18} />}>
            Safari 화면 하단의 <b>공유 버튼</b>을 탭하세요.
          </StepRow>
          <SafariToolbarHint />
          <StepRow n={2} glyph={<AddToHomeGlyph size={18} />}>
            메뉴를 위로 올려 <b>'홈 화면에 추가'</b>를 선택하세요.
          </StepRow>
          <StepRow n={3}>
            오른쪽 위 <b>'추가'</b>를 누르면 홈 화면에 {brandName} 아이콘이 생깁니다.
          </StepRow>
        </div>
        <div style={{
          marginTop: 12, fontSize: 11, lineHeight: 1.5,
          color: "var(--color-label-alt, rgba(55,53,47,0.45))",
        }}>
          ※ Chrome 등 다른 브라우저에서는 설치 메뉴가 보이지 않을 수 있어요. <b>Safari</b>로 열어 주세요.
        </div>
      </div>
    );
  }

  // android / android-manual — 텍스트 단계 안내(+ 네이티브 프롬프트 가능 시 버튼)
  return (
    <div style={wrapStyle}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <StepRow n={1}>
          Chrome 우측 상단의 <b style={{ color: "var(--color-label, #171719)" }}>⋮</b> 메뉴를 탭하세요.
        </StepRow>
        <StepRow n={2} glyph={<AddToHomeGlyph size={18} />}>
          <b>'홈 화면에 추가'</b> 또는 <b>'앱 설치'</b>를 선택하세요.
        </StepRow>
        <StepRow n={3}>
          <b>'설치'</b>를 누르면 홈 화면에 {brandName} 아이콘이 생깁니다.
        </StepRow>
      </div>
      {onInstall && (
        <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end" }}>
          <Btn variant="primary" size="md" onClick={onInstall}>
            지금 설치
          </Btn>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════
// InstallPrompt — 자동 노출 바텀시트(standalone·스누즈 가드 포함)
// ════════════════════════════════════════════════════════
// brandName / iconHref = 거래처 테마가 있는 화면이 넘기는 «홈 화면에 생길 앱» 이름·아이콘
// (2026-08-30). 🔴 **부재 = 현행** — 안 넘기면 예전 그대로 앱 고정 아이콘(resolveAppIcons)과
// "BusLink" 다. 기사·관리자·협력사 화면은 인자를 안 주므로 한 픽셀도 안 바뀐다.
// 왜 필요했나: <head> 의 파비콘·애플터치·매니페스트는 이미 거래처 테마를 따라가는데
// (EmployeeApp 이 applyAppManifest 로 교체) **이 팝업만** 앱 고정 매핑을 봐서, 화면은
// 카카오 톤인데 "홈 화면에 BusLink 를 추가하세요" 가 파란 BusLink 아이콘과 함께 떴다.
/**
 * @param {boolean} [escapeOnly] 인앱 브라우저 탈출 안내만 띄우고 설치 안내는 띄우지 않는다.
 *   🔴 **로그인 화면 전용**이다(2026-09-04). 이유: 탈출하면 브라우저가 바뀌고 저장소도 갈리므로
 *   먼저 로그인한 뒤 옮기면 **옮겨간 브라우저에서 또 로그인**해야 한다. 카톡으로 들어온 승객은
 *   로그인 **전에** 옮겨 놔야 로그인이 한 번으로 끝난다(안내문 링크의 `?emp=` 프리필도 따라간다).
 *   설치 안내는 로그인 뒤 본체에서 띄운다 — 로그인도 안 한 사람에게 설치부터 권하지 않는다.
 */
export default function InstallPrompt({ brandName = null, iconHref = null, escapeOnly = false }) {
  const forced = typeof window !== "undefined" && isForcedByUrl();
  // mode: null(미표시) | "android"(네이티브 프롬프트 가능) | "android-manual" | "ios" | "inapp"
  const [mode, setMode] = useState(null);
  const [deferred, setDeferred] = useState(null);

  useEffect(() => {
    // 이미 설치됨 / 최근 닫음이면 아무것도 하지 않음
    // 🔴 standalone 은 강제 노출로도 뚫지 않는다(이미 설치된 앱 안에서 설치를 권하게 된다).
    if (isStandalone()) return;
    if (!forced && isSnoozed()) return;

    // 🔴 인앱 브라우저(카톡·네이버 등)에서는 설치가 **원천 불가능**하다 — beforeinstallprompt 가
    //    발생하지 않고 「홈 화면에 추가」 메뉴도 없다. 그래서 아래 BIP 리스너·타이머를 아예 달지
    //    않고(어차피 안 온다) «설치할 수 있는 브라우저로 옮기기» 안내만 띄운다.
    //    이 분기가 없으면 카톡 승객은 ⓐ 예전엔 아무것도 못 보고 ⓑ «설치할 때까지 팝업» 이후엔
    //    눌러도 설치가 안 되는 팝업을 방문마다 보게 된다.
    const env0 = detectBrowserEnv(
      typeof navigator !== "undefined" ? navigator.userAgent : ""
    );
    if (env0.inApp) {
      setMode("inapp");
      return;
    }
    // 로그인 화면에서는 여기까지다 — 탈출 안내 말고는 아무것도 띄우지 않는다.
    if (escapeOnly) return;

    let mounted = true;

    // Android/Chrome: 네이티브 설치 프롬프트 가로채기
    const onBIP = (e) => {
      e.preventDefault();
      if (!mounted) return;
      setDeferred(e);
      setMode("android");
    };

    // 설치 완료 → 영구 비표시
    const onInstalled = () => {
      writeInstalled();
      if (!mounted) return;
      setMode(null);
      setDeferred(null);
    };

    window.addEventListener("beforeinstallprompt", onBIP);
    window.addEventListener("appinstalled", onInstalled);

    // index.js 글로벌 stash 회수 — 리스너 부착 전 이미 발화된 BIP 캐치.
    // PermissionGate(usePermissions)도 같은 stash를 회수하므로 null로 비우지 않음 — 공유.
    // 한 쪽이 promptInstall 호출 시 이벤트 객체가 consumed 되는 건 자연스러움(설치는 1회).
    if (typeof window !== "undefined" && window.__buslinkDeferredBIP) {
      setDeferred(window.__buslinkDeferredBIP);
      setMode("android");
    }

    // iOS Safari 는 beforeinstallprompt 가 없으므로 약간의 지연 후 안내 노출
    // (혹시 늦게 발생할 beforeinstallprompt 와 충돌 방지)
    let iosTimer = null;
    if (isIosSafari()) {
      iosTimer = setTimeout(() => {
        if (mounted) {
          setMode((prev) => (prev === "android" ? prev : "ios"));
        }
      }, 1500);
    }

    // 안드로이드 Chrome BIP 영구 차단 케이스 폴백: 한 번 설치 후 홈에서 삭제해도
    // Chrome 내부가 "이미 설치됨"으로 기억해 BIP 미발화 → 우리 카드 자체 미표시.
    // 3초까지 BIP 안 오면 수동 안내 모드("android-manual")로 — "Chrome 메뉴 → 홈 화면에 추가" 가이드.
    let androidTimer = null;
    if (isAndroidPwaCapable()) {
      androidTimer = setTimeout(() => {
        if (mounted) {
          setMode((prev) => (prev === "android" ? prev : "android-manual"));
        }
      }, 3000);
    }

    // 강제 노출인데 iOS Safari 도 안드로이드 크롬도 아니면 위 두 타이머가 안 돌아 «눌렀는데 아무 일도
    // 안 일어난다» 가 된다 → 기기에 맞는 안내라도 띄운다(설치 버튼은 어차피 BIP 가 있을 때만 뜬다).
    let forcedTimer = null;
    if (forced && !isIosSafari() && !isAndroidPwaCapable()) {
      forcedTimer = setTimeout(() => {
        if (mounted) setMode((prev) => prev || (isIos() ? "ios" : "android-manual"));
      }, 1500);
    }

    return () => {
      mounted = false;
      if (forcedTimer) clearTimeout(forcedTimer);
      window.removeEventListener("beforeinstallprompt", onBIP);
      window.removeEventListener("appinstalled", onInstalled);
      if (iosTimer) clearTimeout(iosTimer);
      if (androidTimer) clearTimeout(androidTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forced, escapeOnly]);

  const close = () => {
    writeDismiss();
    setMode(null);
  };

  // «이미 설치했어요» — 30일 침묵. iOS 는 appinstalled 이벤트가 없어 이 통로가 없으면
  // 설치를 마친 승객에게도 방문마다 팝업이 뜬다.
  const closeAsInstalled = () => {
    writeSelfReported();
    setMode(null);
  };

  // 인앱 브라우저 탈출 — 같은 주소를 일반 브라우저에서 다시 연다.
  // 🔴 여기서 닫기 기록을 남기지 않는다: 브라우저가 바뀌면 저장소도 갈리므로 의미가 없고,
  //    옮겨간 브라우저에서는 팝업이 **떠야** 승객이 설치를 마칠 수 있다.
  const handleEscape = (url) => {
    try {
      window.location.href = url;
    } catch {
      /* 차단되면 아무 일도 일어나지 않는다 — 아래 손안내가 그대로 남아 있다 */
    }
  };

  const handleInstall = async () => {
    if (!deferred) {
      close();
      return;
    }
    try {
      deferred.prompt();
      const choice = await deferred.userChoice;
      if (choice && choice.outcome === "accepted") {
        // appinstalled 이벤트가 별도로 영구 비표시 처리. 여기선 팝업만 닫음.
        setMode(null);
        setDeferred(null);
      } else {
        // 거절 → 이번 방문에만 숨김(다음에 앱을 열면 다시 뜬다 — «설치할 때까지», 2026-09-04)
        close();
      }
    } catch {
      close();
    }
  };

  if (!mode) return null;

  // iOS 는 단계 일러스트 바텀시트 — 한 줄 안내보다 시각적으로 명확.
  const isIosMode = mode === "ios";

  // 인앱 브라우저 안내 — 문구·버튼 라벨·탈출 URL 을 순수 모듈이 전부 만들어 준다.
  // guide 가 null 이면(판정이 뒤집힌 경우) 아무것도 안 그린다 — 빈 카드보다 낫다.
  const escapeGuide =
    mode === "inapp"
      ? buildEscapeGuide(
          typeof window !== "undefined" ? window.location.href : "",
          detectBrowserEnv(typeof navigator !== "undefined" ? navigator.userAgent : "")
        )
      : null;
  if (mode === "inapp" && !escapeGuide) return null;

  // 현재 앱(호스트명/경로) 전용 아이콘·이름 — logo192(React 기본 로고) 하드코딩 제거.
  const appIcon = resolveAppIcons(
    typeof window !== "undefined" ? window.location.hostname : "",
    typeof window !== "undefined" ? window.location.pathname : ""
  );

  // 거래처 표기·아이콘이 오면 그것으로, 아니면 앱 기본(부재=현행).
  const name = brandName || "BusLink";
  const iconSrc = iconHref || appIcon.install;

  return (
    <div
      role="dialog"
      aria-label={mode === "inapp" ? "인터넷 브라우저로 열기 안내" : "앱 설치 안내"}
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 2147483000, // 공지 배너(999) 등 위
        display: "flex",
        justifyContent: "center",
        padding: "0 12px calc(12px + env(safe-area-inset-bottom)) 12px",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          pointerEvents: "auto",
          width: "100%",
          maxWidth: 440,
          background: "var(--color-bg, #fff)",
          color: "var(--color-label, #171719)",
          borderRadius: 16,
          boxShadow: "var(--shadow-strong, 0 12px 40px rgba(0,0,0,.18))",
          border: "1px solid var(--color-line, rgba(112,115,124,0.18))",
          padding: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
          <img
            src={iconSrc}
            alt={brandName || appIcon.title}
            width={44}
            height={44}
            style={{ borderRadius: 10, flexShrink: 0 }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 15,
                fontWeight: 800,
                letterSpacing: "-0.01em",
                marginBottom: 4,
              }}
            >
              {escapeGuide ? escapeGuide.title : "앱으로 설치하면 더 빠르게 이용할 수 있어요"}
            </div>
            <div
              style={{
                fontSize: 13,
                lineHeight: 1.5,
                color: "var(--color-label-mute, rgba(46,47,51,0.62))",
              }}
            >
              {escapeGuide
                ? escapeGuide.body
                : isIosMode || mode === "android-manual"
                  ? `아래 순서대로 홈 화면에 ${withEulReul(name)} 추가하세요.`
                  : `홈 화면에 ${withEulReul(name)} 추가하면 앱처럼 바로 실행돼요.`}
            </div>
          </div>
          <button
            onClick={close}
            aria-label="닫기"
            style={{
              background: "var(--color-bg-soft, #f2f2f3)",
              border: "none",
              borderRadius: 8,
              width: 28,
              height: 28,
              fontSize: 14,
              lineHeight: 1,
              color: "var(--color-label-mute, rgba(46,47,51,0.62))",
              cursor: "pointer",
              fontFamily: "inherit",
              flexShrink: 0,
            }}
          >
            ✕
          </button>
        </div>

        {/* iOS · android-manual: 단계 일러스트 안내. android: 네이티브 프롬프트만. */}
        {(isIosMode || mode === "android-manual") && (
          <div style={{ marginTop: 14 }}>
            <InstallGuide platform={mode} brandName={name} />
          </div>
        )}

        {/* 인앱 브라우저인데 탈출 버튼을 만들 수 없는 환경(주로 iOS) — 손으로 하는 법만 알려 준다.
            🔴 여기에 버튼을 만들면 눌러도 아무 일도 안 일어나는 «먹통 버튼» 이 된다. */}
        {escapeGuide && escapeGuide.manualHint && (
          <div
            style={{
              marginTop: 12,
              padding: "10px 12px",
              borderRadius: 10,
              background: "var(--color-bg-soft, #f2f2f3)",
              fontSize: 13,
              lineHeight: 1.55,
              color: "var(--color-label, #171719)",
            }}
          >
            {escapeGuide.manualHint}
          </div>
        )}

        <div
          style={{
            display: "flex",
            gap: 8,
            marginTop: 14,
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          {/* 설치를 이미 마친 사람에게 방문마다 묻지 않기 위한 통로(2026-09-04).
              인앱 브라우저에서는 띄우지 않는다 — 거기선 애초에 설치가 불가능하므로
              «이미 설치했어요» 가 성립하지 않고, 눌러 봤자 30일간 탈출 안내만 사라진다. */}
          {mode !== "inapp" ? (
            <button
              onClick={closeAsInstalled}
              style={{
                background: "none",
                border: "none",
                padding: "6px 2px",
                fontSize: 12.5,
                color: "var(--color-label-mute, rgba(46,47,51,0.62))",
                textDecoration: "underline",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              이미 설치했어요
            </button>
          ) : (
            <span />
          )}

          <span style={{ display: "flex", gap: 8 }}>
            <Btn variant="secondary" size="md" onClick={close}>
              나중에
            </Btn>
            {mode === "android" && (
              <Btn variant="primary" size="md" onClick={handleInstall}>
                설치
              </Btn>
            )}
            {escapeGuide && escapeGuide.escapeUrl && escapeGuide.buttonLabel && (
              <Btn
                variant="primary"
                size="md"
                onClick={() => handleEscape(escapeGuide.escapeUrl)}
              >
                {escapeGuide.buttonLabel}
              </Btn>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
