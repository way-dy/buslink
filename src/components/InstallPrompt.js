// src/components/InstallPrompt.js
// ---------------------------------------------------------------------------
// 설치형 앱(PWA) 설치 유도 팝업. 순수 프레젠테이션 + 브라우저 API 만 사용.
// Firebase/로직 import 금지. /p(EmployeeApp)·기사앱(DriverApp) 최상위에 1줄 마운트.
//
// 동작 요약
//  - 이미 설치(standalone)면 렌더 안 함.
//  - Android/Chrome: beforeinstallprompt 가로채 stash → 하단 배너 → [설치] 시 네이티브 프롬프트.
//  - iOS Safari: beforeinstallprompt 미지원이므로 "공유 → 홈 화면에 추가" 안내 팝업.
//  - 닫기/나중에: localStorage buslink_pwa_prompt 에 기록 → 14일 후 재노출.
//  - appinstalled 또는 standalone 이면 영구 비표시.
// ---------------------------------------------------------------------------
import React, { useEffect, useState } from "react";
import { Btn } from "./ui";

const LS_KEY = "buslink_pwa_prompt";
const SNOOZE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

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

// iOS(iPhone/iPad) Safari 인가 — Chrome/Firefox iOS 등 in-app 브라우저는 제외(과도 노출 방지)
function isIosSafari() {
  const ua = window.navigator.userAgent || "";
  const iOS = /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ 는 Mac 으로 위장하나 터치 포인트로 구분
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (!iOS) return false;
  // Safari 만: CriOS(Chrome)·FxiOS(Firefox)·EdgiOS(Edge)·OPiOS(Opera) 등 배제
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA|Line|FBAN|FBAV|Instagram|KAKAOTALK/.test(ua);
  return isSafari;
}

// 최근에 닫았으면(14일 이내) true
function isSnoozed() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return false;
    const { dismissedAt, installed } = JSON.parse(raw);
    if (installed) return true; // 영구 비표시
    if (!dismissedAt) return false;
    return Date.now() - dismissedAt < SNOOZE_DAYS * DAY_MS;
  } catch {
    return false;
  }
}

function writeDismiss() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ dismissedAt: Date.now() }));
  } catch {
    /* localStorage 불가 환경 무해 처리 */
  }
}

function writeInstalled() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ installed: true, dismissedAt: Date.now() }));
  } catch {
    /* 무해 처리 */
  }
}

// iOS 공유 아이콘(네모+위 화살표) 묘사 — 텍스트 안내 보조
function ShareGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"
      style={{ verticalAlign: "-3px", margin: "0 2px" }}>
      <path d="M12 3v11" stroke="#0066FF" strokeWidth="2" strokeLinecap="round" />
      <path d="M8.5 6.5 12 3l3.5 3.5" stroke="#0066FF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6 11v8a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-8" stroke="#0066FF" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export default function InstallPrompt() {
  // mode: null(미표시) | "android"(네이티브 프롬프트 가능) | "ios"(수동 안내)
  const [mode, setMode] = useState(null);
  const [deferred, setDeferred] = useState(null);

  useEffect(() => {
    // 이미 설치됨 / 최근 닫음이면 아무것도 하지 않음
    if (isStandalone() || isSnoozed()) return;

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

    // index.js 글로벌 stash 회수 — 리스너 부착 전 이미 발화된 BIP 캐치
    if (typeof window !== "undefined" && window.__buslinkDeferredBIP) {
      setDeferred(window.__buslinkDeferredBIP);
      setMode("android");
      window.__buslinkDeferredBIP = null; // 중복 방지
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

    return () => {
      mounted = false;
      window.removeEventListener("beforeinstallprompt", onBIP);
      window.removeEventListener("appinstalled", onInstalled);
      if (iosTimer) clearTimeout(iosTimer);
    };
  }, []);

  const close = () => {
    writeDismiss();
    setMode(null);
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
        // 거절 → 14일 스누즈
        close();
      }
    } catch {
      close();
    }
  };

  if (!mode) return null;

  return (
    <div
      role="dialog"
      aria-label="앱 설치 안내"
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
            src="/logo192.png"
            alt="BusLink"
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
              앱으로 설치하면 더 빠르게 이용할 수 있어요
            </div>
            {mode === "android" ? (
              <div
                style={{
                  fontSize: 13,
                  lineHeight: 1.5,
                  color: "var(--color-label-mute, rgba(46,47,51,0.62))",
                }}
              >
                홈 화면에 BusLink 를 추가하면 앱처럼 바로 실행돼요.
              </div>
            ) : (
              <div
                style={{
                  fontSize: 13,
                  lineHeight: 1.6,
                  color: "var(--color-label-mute, rgba(46,47,51,0.62))",
                }}
              >
                Safari 하단의 공유 버튼
                <ShareGlyph />
                을 누른 뒤<br />
                <b style={{ color: "var(--color-label, #171719)" }}>'홈 화면에 추가'</b> 를 선택하세요.
              </div>
            )}
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

        <div
          style={{
            display: "flex",
            gap: 8,
            marginTop: 14,
            justifyContent: "flex-end",
          }}
        >
          <Btn variant="secondary" size="md" onClick={close}>
            나중에
          </Btn>
          {mode === "android" && (
            <Btn variant="primary" size="md" onClick={handleInstall}>
              설치
            </Btn>
          )}
        </div>
      </div>
    </div>
  );
}
