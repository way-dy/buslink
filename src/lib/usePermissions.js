// src/lib/usePermissions.js — 위치/알림 권한 + PWA 설치 상태 훅 (순수 브라우저 API)
// ---------------------------------------------------------------------------
// callcenter driver.html getPermStates/renderPermBanner/beforeinstallprompt 패턴을
// React 훅으로 재구현. Firebase/로직 import 없음(순수 프레젠테이션 보조).
// PermissionGate 컴포넌트가 사용. DriverApp handleStart는 ensureGeolocationPermission만 import.
// ---------------------------------------------------------------------------
import { useState, useEffect, useCallback, useRef } from "react";

// ── 현재 권한 상태 조회 ──────────────────────────────────
// notif: 'granted'|'denied'|'default'|'unsupported'
// geo  : 'granted'|'denied'|'prompt'|'unknown'  (Permissions API 미지원 시 'unknown')
export async function getPermStates() {
  const notif = ("Notification" in window) ? Notification.permission : "unsupported";
  let geo = "unknown";
  if (navigator.permissions && navigator.permissions.query) {
    try {
      const r = await navigator.permissions.query({ name: "geolocation" });
      geo = r.state; // 'granted'|'prompt'|'denied'
    } catch { geo = "unknown"; }
  }
  return { notif, geo };
}

// ── 위치 권한 보장 (DriverApp.handleStart 사전 점검 재사용) ──
// granted → true. prompt/unknown → getCurrentPosition으로 OS 팝업 유도, 허용 시 true.
// denied → false (OS 팝업이 안 뜨므로 호출측이 안내).
export async function ensureGeolocationPermission() {
  if (!("geolocation" in navigator)) return false;
  const { geo } = await getPermStates();
  if (geo === "granted") return true;
  if (geo === "denied") return false;
  // prompt | unknown — 실제 측위 시도로 OS 권한 팝업을 띄움
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      () => resolve(true),
      (err) => resolve(err.code !== 1), // code 1 = PERMISSION_DENIED
      { enableHighAccuracy: false, maximumAge: 30000, timeout: 8000 }
    );
  });
}

// ── 권한 + 설치 상태 훅 ──────────────────────────────────
// focus/visibilitychange/30초 주기로 자동 재점검(사용자가 설정에서 허용 후 복귀 시 반영).
export function usePermissions() {
  const [perm, setPerm] = useState({ notif: "default", geo: "unknown" });
  const [installable, setInstallable] = useState(false);
  const [installed, setInstalled] = useState(
    typeof window !== "undefined" &&
    window.matchMedia && window.matchMedia("(display-mode: standalone)").matches
  );
  const deferredRef = useRef(null);

  const refresh = useCallback(() => {
    getPermStates().then(setPerm);
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 30000);
    const onVis = () => { if (!document.hidden) refresh(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);

  // PWA 설치 프롬프트 보관 / 설치 완료 감지
  useEffect(() => {
    const onBIP = (e) => {
      e.preventDefault();
      deferredRef.current = e;
      if (!(window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)) {
        setInstallable(true);
      }
    };
    const onInstalled = () => { setInstalled(true); setInstallable(false); deferredRef.current = null; };
    window.addEventListener("beforeinstallprompt", onBIP);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBIP);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  // 알림 권한 요청 (default일 때 OS 팝업)
  const requestNotif = useCallback(async () => {
    if (!("Notification" in window)) return "unsupported";
    try {
      const r = await Notification.requestPermission();
      setTimeout(refresh, 600);
      return r;
    } catch { return Notification.permission; }
  }, [refresh]);

  // 위치 권한 요청 (prompt일 때 getCurrentPosition으로 OS 팝업)
  const requestGeo = useCallback(() => {
    if (!("geolocation" in navigator)) return;
    navigator.geolocation.getCurrentPosition(
      () => setTimeout(refresh, 400),
      () => setTimeout(refresh, 400),
      { enableHighAccuracy: false, maximumAge: 30000, timeout: 8000 }
    );
  }, [refresh]);

  // PWA 설치 트리거
  const promptInstall = useCallback(async () => {
    const d = deferredRef.current;
    if (!d) return;
    d.prompt();
    try { await d.userChoice; } catch {}
    deferredRef.current = null;
    setInstallable(false);
  }, []);

  // 배너 노출 판정 — 어느 한쪽이라도 미허용(차단/미요청)이면 표시
  const notifBad = perm.notif !== "granted" && perm.notif !== "unsupported";
  const geoBad = perm.geo === "denied" || perm.geo === "prompt";
  const needsBanner = notifBad || geoBad;
  const anyDenied = perm.notif === "denied" || perm.geo === "denied";

  return {
    perm, notifBad, geoBad, needsBanner, anyDenied,
    installable, installed,
    requestNotif, requestGeo, promptInstall, refresh,
  };
}
