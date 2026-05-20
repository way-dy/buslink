import { useState, useEffect, useRef } from "react";
import { auth, db } from "../firebase";
import { signOut } from "firebase/auth";
import { collection, query, where, getDocs, doc, updateDoc, getDoc, onSnapshot, orderBy, serverTimestamp } from "firebase/firestore";
import { startGPS, stopGPS, clearGPS } from "../lib/gps";
import { planTimeForStop, computeStopEstimates, formatDelayLabel } from "../lib/stopSchedule";
import { ensureGeolocationPermission } from "../lib/usePermissions";
import { createBoardingToken, getBoardingUrl } from "../lib/boarding";
import QRCode from "qrcode";
import { BusLinkLogo, Pill, StatusDot, Icon } from "../components/ui";
import InstallPrompt from "../components/InstallPrompt";
import { applyAppManifest } from "../lib/pwaManifest";
import PermissionGate from "../components/PermissionGate";

// 리디자인 2단계(2026-05-16): 라이트 테마 리스킨.
// ── 로직 100% 불변: state/effect·init(driver/dispatch/stops 로드)·loadDispatch
//    ·loadStops·Wake Lock·Notification·handleStart/handleStop/refreshToken
//    ·startGPS/stopGPS/clearGPS·createBoardingToken/getBoardingUrl·QRCode.toDataURL
//    ·setInterval 5분 토큰 갱신·signOut·companyId(propCompanyId||"dy001")
//    ·activeTab("운행"|"탑승 QR")·currentStopIdx·App.js 분기 전부 그대로.
//    마크업/스타일(S 객체)만 다크 하드코딩 → tokens.css 변수·components/ui 로 교체.
// ── 목업 design/src/screens-mobile.jsx DriverApp 의 "시각 언어"만 차용:
//    헤더→인사→#0066FF→#003DCC 그라데이션 히어로 배차카드(다음정류장 진행바)
//    →MiniStat 3→QR/탭 버튼→정류장 리스트→하단 검정 운행종료.
//    목업의 가짜 수치(속도 42·GPS ±4m·탑승 38/45·가짜 시간·회차)는 도입 금지 —
//    실제 dispatch/stops/currentStopIdx 데이터만 리스킨.
export default function DriverApp({ companyId: propCompanyId }) {
  const [driver, setDriver] = useState(null);
  // 다중 배차 지원: 같은 기사·날짜에 dispatch 여러 건 가능 → 칩으로 선택.
  // 기존 `dispatch` 단일 참조는 derived 값으로 호환(아래 derived dispatch).
  const [dispatches, setDispatches] = useState([]);
  const [activeDispatchId, setActiveDispatchId] = useState(null);
  const dispatch = dispatches.find(d => d.id === activeDispatchId) || null;
  // 배차 선택 모달 (EmployeeApp routePicker 패턴) — 가로 칩을 모달로 교체.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dispatchQuery, setDispatchQuery] = useState("");
  const filteredDispatches = dispatches.filter(d => {
    const q = dispatchQuery.trim().toLowerCase();
    if (!q) return true;
    return (d.routeName || "").toLowerCase().includes(q)
      || (d.vehicleNo || "").toLowerCase().includes(q)
      || (d.departTime || "").includes(q)
      || (d.partnerName || "").toLowerCase().includes(q);
  });
  const [stops, setStops] = useState([]);
  const [currentStopIdx, setCurrentStopIdx] = useState(-1);
  const [boardingToken, setBoardingToken] = useState(null);   // 현재 탑승 토큰
  const [qrUrl, setQrUrl] = useState(null);        // 탑승 링크 URL
  const [qrDataUrl, setQrDataUrl] = useState(null); // canvas → base64 이미지
  const [activeTab, setActiveTab] = useState("운행");          // "운행" | "QR"
  const tokenTimerRef = useRef(null);
  const [nextStopDist, setNextStopDist] = useState(null);
  const [driving, setDriving] = useState(false);
  const [watchId, setWatchId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [companyId, setCompanyId] = useState(propCompanyId || "dy001");
  const [gpsStatus, setGpsStatus] = useState("");   // GPS 신호 안내 ("" | "확보중" | "권한")
  const wakeLockRef = useRef(null);
  const currentStopRowRef = useRef(null);

  // 현재 정류장 변경 시 리스트에서 자동 스크롤(중앙 정렬) — 운행 시작 전/리스트 없음/이미 보임 케이스는 skip
  useEffect(() => {
    if (currentStopIdx < 0) return;
    const el = currentStopRowRef.current;
    if (!el || typeof el.scrollIntoView !== "function") return;
    // 약간의 지연 — 카드 배경 전환 직후 위치 안정 후 스크롤
    const t = setTimeout(() => {
      try { el.scrollIntoView({ behavior: "smooth", block: "center" }); } catch { /* 일부 구형 브라우저 무해 */ }
    }, 80);
    return () => clearTimeout(t);
  }, [currentStopIdx]);

  // 알림 권한 요청
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  // 설치형 앱(PWA) 조건용 SW 등록 1회 — 브라우저가 URL+scope 로 dedupe.
  // DriverApp 은 FCM 미사용이나 설치 가능 조건 충족 위해 등록만 추가. 실패 무해 처리.
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/firebase-messaging-sw.js")
        .catch(() => {});
    }
  }, []);

  // 앱별 PWA 설치 아이콘(기사앱) — DriverApp 은 / 에서 Auth 역할 분기로 마운트되므로
  // 정적 path-scope 불가 → 마운트 시점에 manifest/apple-touch/제목 교체. 1회.
  useEffect(() => {
    applyAppManifest({
      manifestHref: "/manifest-driver.json",
      appleTouchHref: "/icons/driver-1024.png",
      title: "BusLink 기사",
    });
  }, []);

  useEffect(() => {
    const u = auth.currentUser;
    if (!u) return;
    const cid = propCompanyId || "dy001";
    setCompanyId(cid);
    const init = async () => {
      try {
        let snap = await getDocs(query(
          collection(db, "companies", cid, "drivers"),
          where("uid", "==", u.uid)
        ));
        if (snap.empty && u.email?.endsWith("@buslink.com")) {
          const empNo = u.email.replace("@buslink.com", "");
          snap = await getDocs(query(
            collection(db, "companies", cid, "drivers"),
            where("empNo", "==", empNo)
          ));
          if (!snap.empty) {
            await updateDoc(doc(db, "companies", cid, "drivers", snap.docs[0].id), { uid: u.uid });
          }
        }
        if (!snap.empty) {
          const d = { id: snap.docs[0].id, ...snap.docs[0].data() };
          setDriver(d);
          await loadDispatch(d.id, cid);
        } else {
          setError("기사 정보를 찾을 수 없습니다.\n관리자에게 문의하세요.");
        }
      } catch (e) {
        setError("데이터 로드 중 오류가 발생했습니다.");
      }
      setLoading(false);
    };
    init();
  }, [propCompanyId]);

  const loadDispatch = async (driverId, cid) => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
    const snap = await getDocs(query(
      collection(db, "companies", cid, "dispatches", today, "list"),
      where("driverId", "==", driverId)
    ));
    if (snap.empty) { setDispatches([]); setActiveDispatchId(null); return; }
    const list = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.departTime || "").localeCompare(b.departTime || ""));  // 출발시간 오름차순
    setDispatches(list);
    // 활성 선택: localStorage 우선(같은 날 재진입 시 복원) > 첫 항목
    let pick = null;
    try {
      const saved = localStorage.getItem(`buslink_driver_active_dispatch_${today}`);
      if (saved && list.some(d => d.id === saved)) pick = saved;
    } catch {}
    pick = pick || list[0].id;
    setActiveDispatchId(pick);
    // 정류장 로드는 activeDispatchId 변경 useEffect 가 책임(중복 호출 회피)
  };

  const loadStops = async (routeId, cid) => {
    try {
      const snap = await getDocs(query(
        collection(db, "companies", cid, "routes", routeId, "stops"),
        orderBy("order", "asc")
      ));
      setStops(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (e) {
      console.warn("[BusLink] 정류장 로드 실패:", e.message);
    }
  };

  // 운행 중 "GPS 신호 확보 중…" 안내 자동 해제 — 실제 측위가 들어오면 표시 끔.
  // (startGPS 파이프라인을 건드리지 않고 동일 위치권한으로 1회 확인 — 권한 거부는 유지)
  useEffect(() => {
    if (!driving || gpsStatus !== "확보중") return;
    let cancelled = false;
    const w = navigator.geolocation.watchPosition(
      () => { if (!cancelled) setGpsStatus(""); },
      () => {},
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 }
    );
    return () => { cancelled = true; navigator.geolocation.clearWatch(w); };
  }, [driving, gpsStatus]);

  // 활성 배차 변경 시 stops 재로드 + 선택 영속화
  useEffect(() => {
    if (!dispatch?.routeId || !companyId) { setStops([]); return; }
    loadStops(dispatch.routeId, companyId);
    try {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
      localStorage.setItem(`buslink_driver_active_dispatch_${today}`, dispatch.id);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDispatchId, dispatch?.routeId, companyId]);

  // ── 활성 dispatch 문서 실시간 구독 — stopArrivals 표시·멱등 가드용 ──
  // 운행중일 때만 구독(미운행 시엔 정류장 표시 자체가 없으므로 비용 절감).
  // dispatch.stopArrivals = { [stopId]: { actualAt: serverTimestamp, plannedAt, delaySec } }
  const [stopArrivals, setStopArrivals] = useState({});
  useEffect(() => {
    if (!companyId || !dispatch?.id) { setStopArrivals({}); return; }
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
    const ref = doc(db, "companies", companyId, "dispatches", today, "list", dispatch.id);
    return onSnapshot(ref, snap => {
      if (!snap.exists()) { setStopArrivals({}); return; }
      const sa = snap.data().stopArrivals || {};
      const out = {};
      Object.entries(sa).forEach(([sid, v]) => {
        const at = v?.actualAt?.toMillis ? v.actualAt.toMillis() : (typeof v?.actualAt === 'number' ? v.actualAt : null);
        if (at != null) out[sid] = at;
      });
      setStopArrivals(out);
    }, () => setStopArrivals({}));
  }, [companyId, dispatch?.id]);

  // Wake Lock 재획득
  useEffect(() => {
    const fn = async () => {
      if (document.visibilityState === "visible" && driving && "wakeLock" in navigator) {
        try { wakeLockRef.current = await navigator.wakeLock.request("screen"); } catch {}
      }
    };
    document.addEventListener("visibilitychange", fn);
    return () => document.removeEventListener("visibilitychange", fn);
  }, [driving]);

  // ── 정류장 estimates(계획·예상시각·지연) ──
  // 기사 화면엔 GPS 가중 무의미(차량 자기 좌표) → vehiclePos 미주입, plan+delay 모드.
  // todayDispatch.stopArrivals 갱신 → 누적지연 자동 반영. offsetMin 미설정 = unplanned.
  const stopEstimates = computeStopEstimates({
    stops,
    departTime: dispatch?.departTime,
    actualArrivals: stopArrivals,
    vehiclePos: null,
    speed: null,
    routePath: null,
  });
  const estByStopId = Object.fromEntries(stopEstimates.map(e => [e.stopId, e]));

  const sendNotification = (stop, dist) => {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("🚌 정류장 도착", {
        body: `${stop.name} 도착 (${dist}m)`,
        icon: "/favicon.ico",
      });
    }
  };

  const handleStart = async () => {
    if (!driver.vehicleId) {
      alert("배정된 차량이 없습니다.\n관리자에게 차량 배정을 요청하세요.");
      return;
    }
    // 위치 권한 사전 점검(작업4 헬퍼 재사용) — 미허용이면 startGPS 전에 권한 요청 흐름.
    // ensureGeolocationPermission: granted|prompt면 OS 팝업 유도, denied면 false 반환.
    setGpsStatus("확보중");
    const ok = await ensureGeolocationPermission();
    if (!ok) {
      setGpsStatus("권한");
      alert("GPS 권한이 필요합니다.\n위치 권한을 허용해주세요.");
      return;
    }
    if ("wakeLock" in navigator) {
      try { wakeLockRef.current = await navigator.wakeLock.request("screen"); } catch {}
    }
    await updateDoc(doc(db, "companies", companyId, "drivers", driver.id), {
      status: "운행중", startedAt: new Date().toISOString(),
    });
    // 운행 시작 시점의 활성 dispatch·노선 정보를 캡쳐(중간에 dispatch picker 전환되어도
    // 콜백 클로저는 시작 dispatch에 stopArrivals 기록 — 단일 운행 단위 일관성).
    const activeDispId = dispatch?.id || null;
    const activeRouteDepart = dispatch?.departTime || null;
    const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
    const id = startGPS({
      companyId, vehicleId: driver.vehicleId, vehicleNo: driver.vehicleNo || "",
      driverId: driver.id, driverName: driver.name || "",
      routeId: dispatch?.routeId || "", routeName: dispatch?.routeName || "",
      stops,
      onStopReached: async (stop, dist) => {
        setCurrentStopIdx(stops.findIndex(s => s.id === stop.id));
        sendNotification(stop, dist);
        // ── stopArrivals 기록(멱등) ─────────────────────────────
        // 활성 dispatch 있을 때만, 같은 stopId가 이미 있으면 덮어쓰지 않음(서버측 가드).
        // 권한: 운행 중 기사(driver) 본인은 자신 dispatch 의 stopArrivals 필드만 update 가능
        // (firestore.rules 신규 화이트리스트). 실패는 무해 처리(로컬 진행 UI는 불변).
        if (!activeDispId) return;
        try {
          const ref = doc(db, "companies", companyId, "dispatches", todayStr, "list", activeDispId);
          const snap = await getDoc(ref);
          if (!snap.exists()) return;
          const sa = snap.data().stopArrivals || {};
          if (sa[stop.id]) return; // 멱등 — 첫 도착만 기록
          const plannedAt = planTimeForStop(activeRouteDepart, stop.offsetMin);
          // delaySec 추정: plannedAt(오늘 ms) - now. 클라 추정값(서버는 actualAt에 serverTimestamp).
          let delaySec = null;
          if (plannedAt && typeof stop.offsetMin === "number") {
            const m = plannedAt.match(/^(\d{2}):(\d{2})$/);
            if (m) {
              const planDate = new Date(); planDate.setHours(+m[1], +m[2], 0, 0);
              delaySec = Math.round((Date.now() - planDate.getTime()) / 1000);
            }
          }
          await updateDoc(ref, {
            [`stopArrivals.${stop.id}`]: {
              actualAt: serverTimestamp(),
              plannedAt: plannedAt || null,
              delaySec,
            },
          });
        } catch (e) {
          console.warn("[BusLink] stopArrivals 기록 실패:", e.message);
        }
      },
      onGpsError: (err) => {
        // err.code 1=PERMISSION_DENIED, 3=TIMEOUT — 화면 안내(작업4 권한 UI와 연동)
        setGpsStatus(err.code === 1 ? "권한" : "확보중");
      },
    });
    setWatchId(id);
    setDriving(true);
    // ✅ 탑승 QR 토큰 최초 생성
    await refreshToken(driver, dispatch);
    // 5분마다 자동 갱신
    tokenTimerRef.current = setInterval(() => refreshToken(driver, dispatch), 5 * 60 * 1000);
  };

  const handleStop = async () => {
    stopGPS(watchId);
    await clearGPS({ companyId, vehicleId: driver.vehicleId });
    await updateDoc(doc(db, "companies", companyId, "drivers", driver.id), {
      status: "대기", endedAt: new Date().toISOString(),
    });
    if (wakeLockRef.current) { wakeLockRef.current.release(); wakeLockRef.current = null; }
    if (tokenTimerRef.current) { clearInterval(tokenTimerRef.current); tokenTimerRef.current = null; }
    setDriving(false);
    setWatchId(null);
    setGpsStatus("");
    setCurrentStopIdx(-1);
    setBoardingToken(null);
    setQrUrl(null);
    setActiveTab("운행");
  };

  const refreshToken = async (drv, disp) => {
    try {
      const tokenId = await createBoardingToken({
        companyId,
        routeId: disp?.routeId || "",
        routeName: disp?.routeName || "",
        vehicleId: drv.vehicleId,
        vehicleNo: drv.vehicleNo || "",
        driverId: drv.id,
      });
      const url = getBoardingUrl(tokenId);
      setBoardingToken(tokenId);
      setQrUrl(url);
      // ✅ qrcode 라이브러리로 로컬 생성 (외부 API 의존성 없음, 오프라인 동작)
      const dataUrl = await QRCode.toDataURL(url, {
        width: 220,
        margin: 2,
        color: { dark: "#0B1A2E", light: "#FFFFFF" },
        errorCorrectionLevel: "M",
      });
      setQrDataUrl(dataUrl);
    } catch (e) {
      console.warn("[BusLink] 토큰 생성 실패:", e.message);
    }
  };

  const handleLogout = async () => {
    if (driving) await handleStop();
    signOut(auth);
  };

  // 오늘 날짜 — 인사 영역 표시용(시각 전용, 로직 무관)
  const todayLabel = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  }).format(new Date());

  if (loading) return (
    <div style={S.fullCenter}>
      <InstallPrompt />
      <div style={{ color: "var(--color-primary)", fontSize: 16, fontWeight: 600 }}>로딩 중...</div>
    </div>
  );

  if (error) return (
    <div style={{ ...S.fullCenter, flexDirection: "column", gap: 16 }}>
      <InstallPrompt />
      <div style={{ color: "var(--color-destructive)", fontSize: 15, textAlign: "center", whiteSpace: "pre-line", fontWeight: 600 }}>{error}</div>
      <button style={S.outlineBtn} onClick={() => signOut(auth)}>로그아웃</button>
    </div>
  );

  return (
    <div style={S.container}>
      <InstallPrompt />
      <div style={S.card}>
        {/* 헤더 */}
        <div style={S.header}>
          <BusLinkLogo size={18} sub="기사" />
          <button style={S.logoutBtn} onClick={handleLogout}>로그아웃</button>
        </div>

        {/* 권한 경고 배너 + 앱 설치 버튼 (운행 화면 상단) */}
        <PermissionGate />

        {/* GPS 신호 안내 — 운행 시작 시 측위 확보 전/권한 미허용일 때만 */}
        {gpsStatus && (
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "9px 12px", borderRadius: "var(--radius-12)",
            background: gpsStatus === "권한" ? "#FDECEC" : "var(--color-primary-soft)",
            border: gpsStatus === "권한" ? "1px solid var(--color-destructive)" : "1px solid var(--color-primary)",
            color: gpsStatus === "권한" ? "var(--color-destructive)" : "var(--color-primary-deep)",
            fontSize: 13, fontWeight: 700,
          }}>
            <StatusDot tone={gpsStatus === "권한" ? "danger" : "primary"} size={8} pulse />
            {gpsStatus === "권한" ? "GPS 권한을 허용해주세요" : "GPS 신호 확보 중…"}
          </div>
        )}

        {/* 인사 */}
        <div>
          <div style={S.greetingDate}>{todayLabel}</div>
          <div style={S.greetingName}>
            {driver?.name ? `${driver.name} 기사님, 안녕하세요` : "안녕하세요"}
          </div>
        </div>

        {/* 배차 정보 — 그라데이션 히어로 카드 */}
        {dispatch ? (
          <div style={S.heroCard}>
            {/* 흐린 버스 아이콘 */}
            <svg viewBox="0 0 100 100" style={S.heroBusIcon}>
              <rect x="10" y="20" width="80" height="48" rx="10" fill="#fff" />
              <circle cx="28" cy="76" r="8" fill="#fff" /><circle cx="72" cy="76" r="8" fill="#fff" />
            </svg>
            <div style={{ position: "relative" }}>
              <div style={S.heroTop}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <Pill tone="dark" dot style={{ background: "rgba(255,255,255,0.18)", color: "#fff" }}>
                    오늘 배차
                  </Pill>
                  {dispatches.length > 1 && (
                    <button
                      onClick={() => { setDispatchQuery(""); setPickerOpen(true); }}
                      style={S.dispatchChangeBtn}
                    >
                      🔄 배차 변경 ({dispatches.length}건)
                    </button>
                  )}
                </div>
                {driving && (
                  <span style={S.heroLiveBadge}>
                    <StatusDot tone="positive" size={6} pulse /> 운행중
                  </span>
                )}
              </div>
              <div style={S.heroRoute}>{dispatch.routeName}</div>
              <div style={S.heroMetaRow}>
                <div><span style={S.heroMetaLabel}>차량 </span><span style={S.heroMetaVal}>{dispatch.vehicleNo || "-"}</span></div>
                {dispatch.departTime && (
                  <div><span style={S.heroMetaLabel}>출발 </span><span style={S.heroMetaVal}>{dispatch.departTime}</span></div>
                )}
              </div>

              {/* 정류장 진행 — 운행 중이고 현재 정류장이 잡혔을 때만 실제 데이터로 */}
              {driving && stops.length > 0 && (() => {
                const total = stops.length;
                const done = currentStopIdx < 0 ? 0 : Math.min(currentStopIdx + 1, total);
                const next = stops[currentStopIdx + 1] || stops[currentStopIdx] || null;
                const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                const nextEst = next ? estByStopId[next.id] : null;
                const lab = nextEst ? formatDelayLabel(nextEst.delaySec) : { tone: "mute", label: "" };
                const labColor = lab.tone === 'danger' ? '#FFD8D8'
                  : lab.tone === 'warn' ? '#FFE7BF'
                  : '#CFEFE0';
                return (
                  <div style={S.heroProgress}>
                    <div style={S.heroProgressTop}>
                      <span>다음 정류장</span>
                      <span style={S.heroProgressCount}>{done}/{total} 정류장</span>
                    </div>
                    <div style={S.heroNextStop}>{next ? next.name : "운행 시작"}</div>
                    {nextEst && nextEst.plannedAt && (
                      <div style={{ fontSize: 17, color: "#fff", marginTop: 8, fontWeight: 800, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
                        <span style={{ opacity: 0.85, fontWeight: 700 }}>계획</span>
                        <span style={{ fontSize: 20 }}>{nextEst.plannedAt}</span>
                        {nextEst.estimatedAt && nextEst.estimatedAt !== nextEst.plannedAt && (
                          <>
                            <span style={{ opacity: 0.55 }}>·</span>
                            <span style={{ opacity: 0.85, fontWeight: 700 }}>예상</span>
                            <span style={{ fontSize: 20 }}>{nextEst.estimatedAt}</span>
                          </>
                        )}
                        {lab.label && lab.tone !== 'mute' && (
                          <span style={{ background: "rgba(255,255,255,0.22)", border: `2px solid ${labColor}`, color: labColor, borderRadius: 999, padding: "4px 13px", fontSize: 15, fontWeight: 800 }}>
                            {lab.label}
                          </span>
                        )}
                      </div>
                    )}
                    <div style={S.heroBar}>
                      <div style={{ ...S.heroBarFill, width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        ) : (
          <div style={S.emptyDispatch}>
            <Icon name="bus" size={28} />
            <div style={{ marginTop: 8 }}>오늘 배차된 노선이 없습니다</div>
          </div>
        )}

        {/* 라이브 상태 스트립 — GPS 전송 상태(실제 driving / Wake Lock 만, 가짜 수치 없음) */}
        {driving && (
          <div style={S.statStrip}>
            <div style={S.miniStat}>
              <div style={S.miniStatLabel}>상태</div>
              <div style={{ ...S.miniStatVal, color: "var(--color-positive)" }}>운행중</div>
            </div>
            <div style={S.miniStat}>
              <div style={S.miniStatLabel}>GPS</div>
              <div style={{ ...S.miniStatVal, color: "var(--color-positive)" }}>전송중</div>
            </div>
            <div style={S.miniStat}>
              <div style={S.miniStatLabel}>화면</div>
              <div style={S.miniStatVal}>{"wakeLock" in navigator ? "켜짐 유지" : "기본"}</div>
            </div>
          </div>
        )}

        {/* 운행 시작 버튼 (미운행 시) */}
        {!driving && (
          <button
            style={{ ...S.primaryBtn, ...(dispatch ? {} : S.primaryBtnDisabled) }}
            onClick={handleStart}
            disabled={!dispatch}
          >
            <Icon name="play" size={18} /> 운행 시작
          </button>
        )}

        {/* 탭 전환 — 항상 표시 */}
        <div style={S.tabRow}>
          {["운행", "탑승 QR"].map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              style={{ ...S.tabBtn, ...(activeTab === tab ? S.tabBtnActive : S.tabBtnIdle) }}>
              {tab === "탑승 QR" && <Icon name="qr" size={16} />} {tab}
            </button>
          ))}
        </div>

        {/* ─ 운행 탭: 정류장 현황 ─ */}
        {(!driving || activeTab === "운행") && stops.length > 0 && (
          <div style={S.listCard}>
            <div style={S.listHeader}>
              <span style={S.listTitle}>오늘 운행 정류장</span>
              <span style={S.listCount}>{stops.length}개소</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 8 }}>
              {stops.map((stop, i) => {
                const isDone = i < currentStopIdx;
                const isCurrent = i === currentStopIdx;
                const isNext = i === currentStopIdx + 1;
                const est = estByStopId[stop.id];
                const lab = est ? formatDelayLabel(est.delaySec) : { tone: "mute", label: "" };
                const labColor = lab.tone === 'danger' ? 'var(--color-destructive)'
                  : lab.tone === 'warn' ? 'var(--color-cautionary)'
                  : 'var(--color-positive)';
                const labBg = lab.tone === 'danger' ? '#FDECEC'
                  : lab.tone === 'warn' ? '#FFF3E0'
                  : '#E6F7EB';
                const arrived = est && est.status === 'arrived';
                // 행 배경 — 도착(arrived)=positive 카드, 현재=primary 카드, 그 외=투명
                const rowBg = arrived ? '#F0FAF4'
                  : isCurrent ? 'var(--color-primary-soft)'
                  : 'transparent';
                const rowBorder = arrived ? '1px solid #B6E6C6'
                  : isCurrent ? '1px solid var(--color-primary)'
                  : '1px solid transparent';
                return (
                  <div key={stop.id}
                    ref={isCurrent ? currentStopRowRef : null}
                    style={{
                      ...S.stopRow,
                      background: rowBg, border: rowBorder,
                      // 현재 정류장 글로우 — 어르신 기사 시인성
                      boxShadow: isCurrent ? "0 0 0 4px rgba(0,102,255,0.18), 0 4px 14px rgba(0,102,255,0.20)" : "none",
                      transition: "box-shadow .25s ease, background .25s ease",
                      // 현재 정류장은 살짝 padding 더(더 큰 카드 느낌)
                      padding: isCurrent ? "18px 14px" : "14px 10px",
                    }}>
                    {/* 현재 정류장 dot은 펄스 ring으로 강조(buspulse 재사용) */}
                    <div style={{ position: "relative", flexShrink: 0 }}>
                      <div style={{
                        ...S.stopDot,
                        // 현재 정류장은 한 단계 더 큼
                        width: isCurrent ? 18 : 14, height: isCurrent ? 18 : 14,
                        background: arrived ? "var(--color-positive)"
                          : isCurrent ? "var(--color-primary)"
                          : isDone ? "var(--color-primary)" : "#fff",
                        border: `3px solid ${arrived ? "var(--color-positive)"
                          : (isCurrent || isDone) ? "var(--color-primary)"
                          : "var(--color-atomic-coolNeutral-90)"}`,
                      }} />
                      {isCurrent && (
                        <div style={{
                          position: "absolute", inset: -3,
                          borderRadius: "50%", background: "var(--color-primary)",
                          animation: "buspulse 2s ease-out infinite",
                          pointerEvents: "none",
                        }} />
                      )}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {/* 정류장 이름 — 통과한 정류장(도착 제외)은 흐리되, 시각·지연 정보는 또렷 유지 */}
                      <div style={{
                        ...S.stopName,
                        color: isCurrent ? "var(--color-primary-deep)" : "var(--color-label)",
                        opacity: (isDone && !arrived) ? 0.55 : 1,
                      }}>
                        {stop.name}
                      </div>
                      {/* 계획·실제 시각 — offsetMin 설정된 정류장만(폴백은 정류장명만).
                          예상/지연은 운행 중 또는 도착 실측이 있을 때만 — 어르신 기사 가독성 위해 크게+칩 형태. */}
                      {est && est.plannedAt && (
                        <div style={{ fontSize: 16, marginTop: 5, fontWeight: 700, color: "var(--color-label)", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                          <span style={{ color: "var(--color-label-mute)" }}>
                            {arrived ? "도착" : "계획"}
                          </span>
                          <span style={{ color: arrived ? 'var(--color-positive)' : 'var(--color-primary-deep)', fontWeight: 800, fontSize: 18 }}>
                            {arrived ? est.estimatedAt : est.plannedAt}
                          </span>
                          {!arrived && driving && est.estimatedAt && est.estimatedAt !== est.plannedAt && (
                            <>
                              <span style={{ color: "var(--color-label-alt)" }}>·</span>
                              <span style={{ color: "var(--color-label-mute)" }}>예상</span>
                              <span style={{ color: 'var(--color-primary-deep)', fontWeight: 800, fontSize: 18 }}>{est.estimatedAt}</span>
                            </>
                          )}
                          {(arrived || driving) && lab.label && lab.tone !== 'mute' && (
                            <span style={{
                              background: labBg, color: labColor, fontWeight: 800, fontSize: 15,
                              padding: "3px 11px", borderRadius: 999, border: `1.5px solid ${labColor}`,
                            }}>
                              {lab.label}
                            </span>
                          )}
                        </div>
                      )}
                      {stop.address && (
                        <div style={{ ...S.stopAddr, opacity: (isDone && !arrived) ? 0.55 : 1 }}>
                          {stop.address}
                        </div>
                      )}
                    </div>
                    {isCurrent && <span style={S.tagCurrent}>현재</span>}
                    {isNext && <span style={S.tagNext}>다음</span>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ─ 탑승 QR 탭 ─ */}
        {activeTab === "탑승 QR" && !driving && (
          <div style={S.qrNotice}>
            <Icon name="qr" size={26} />
            <div>
              <div style={S.qrNoticeTitle}>운행 시작 후 QR이 활성화됩니다</div>
              <div style={S.qrNoticeSub}>운행 시작 버튼을 누르면 탑승 QR이 자동 생성됩니다</div>
            </div>
          </div>
        )}
        {activeTab === "탑승 QR" && driving && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
            {qrUrl ? (
              <>
                <div style={S.qrGuide}>승객이 아래 QR을 스캔하면 탑승이 기록됩니다</div>
                {/* QR 코드 이미지 - qrcode 라이브러리 (로컬 생성, 오프라인 동작) */}
                <div style={S.qrBox}>
                  {qrDataUrl
                    ? <img src={qrDataUrl} alt="탑승 QR" width={220} height={220} style={{ display: "block", borderRadius: 8 }} />
                    : <div style={S.qrPlaceholder}>생성 중...</div>
                  }
                </div>
                <div style={S.qrRouteBox}>
                  <div style={S.qrRouteLabel}>노선</div>
                  <div style={S.qrRouteVal}>{dispatch?.routeName}</div>
                </div>
                <div style={S.qrAutoNote}>QR코드는 5분마다 자동 갱신됩니다</div>
                <button onClick={() => refreshToken(driver, dispatch)} style={S.refreshBtn}>
                  QR 즉시 갱신
                </button>
              </>
            ) : (
              <div style={S.qrGuide}>QR 생성 중...</div>
            )}
          </div>
        )}
      </div>

      {/* 하단 운행 종료 바 — 운행 중에만 (목업: 검정 sticky) */}
      {driving && (
        <div style={S.bottomBar}>
          <button style={S.endBtn} onClick={handleStop}>
            <StatusDot tone="positive" size={8} pulse /> 운행 중 — 종료
          </button>
        </div>
      )}

      {/* ── 배차 선택 모달 — EmployeeApp routePicker 패턴(풀모달 오버레이·검색·카드 리스트) ── */}
      {pickerOpen && (
        <div onClick={() => setPickerOpen(false)} style={S.pickerBack}>
          <div onClick={e => e.stopPropagation()} style={S.pickerModal}>
            <div style={S.pickerHead}>
              <div style={{ width: 36, height: 4, background: "var(--color-line)", borderRadius: 2, margin: "0 auto 12px" }} />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 15, fontWeight: 800 }}>오늘 배차 선택 ({dispatches.length}건)</span>
                <button onClick={() => setPickerOpen(false)} style={S.pickerClose}>✕</button>
              </div>
              {dispatches.length > 6 && (
                <input
                  style={{ ...S.pickerSearch, marginTop: 10 }}
                  placeholder="🔍 노선·차량·시간·거래처 검색"
                  value={dispatchQuery}
                  onChange={e => setDispatchQuery(e.target.value)}
                  autoFocus
                />
              )}
            </div>
            <div style={S.pickerBody}>
              {filteredDispatches.length === 0 ? (
                <div style={{ textAlign: "center", padding: "32px 16px", color: "var(--color-label-mute)", fontSize: 13 }}>
                  {dispatches.length === 0 ? "오늘 배차된 노선이 없습니다" : "검색 결과가 없습니다"}
                </div>
              ) : filteredDispatches.map(d => {
                const cur = d.id === activeDispatchId;
                return (
                  <div
                    key={d.id}
                    onClick={() => { setActiveDispatchId(d.id); setPickerOpen(false); }}
                    style={{ ...S.pickerCard, ...(cur ? S.pickerCardActive : {}) }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5, flexWrap: "wrap" }}>
                      <span style={S.pickerTime}>{d.departTime || "--:--"}</span>
                      <span style={S.pickerType}>{d.routeType || ""}</span>
                      {cur && <span style={S.pickerCurrent}>현재</span>}
                    </div>
                    <div style={S.pickerRoute}>{d.routeName || "노선?"}</div>
                    <div style={S.pickerMeta}>
                      {d.vehicleNo && <span>🚌 {d.vehicleNo}</span>}
                      {d.partnerName && <span> · {d.partnerName}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// DriverApp 한정 인라인 스타일. 색/라운드/그림자는 tokens.css 변수 기반(라이트).
const S = {
  fullCenter: {
    minHeight: "100vh", background: "var(--color-bg-alt)", display: "flex",
    alignItems: "center", justifyContent: "center", fontFamily: "var(--font-base)",
  },
  outlineBtn: {
    background: "var(--color-bg)", border: "1px solid var(--color-line)",
    borderRadius: "var(--radius-8)", padding: "8px 20px", color: "var(--color-label)",
    cursor: "pointer", fontFamily: "inherit", fontWeight: 600, fontSize: 14,
  },

  // 배차 변경 — hero 카드 안의 작은 버튼(흰 반투명, 그라데이션 위 라이트 토큰만)
  dispatchChangeBtn: {
    background: "rgba(255,255,255,0.18)", border: "1px solid rgba(255,255,255,0.4)",
    borderRadius: "var(--radius-pill)", padding: "4px 11px", color: "#fff",
    fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
    backdropFilter: "blur(4px)",
  },

  // 배차 선택 모달 (EmployeeApp routePicker 패턴 차용)
  pickerBack: {
    position: "fixed", inset: 0, background: "var(--color-overlay)", zIndex: 200,
    display: "flex", flexDirection: "column", justifyContent: "flex-end",
  },
  pickerModal: {
    background: "var(--color-bg)", borderRadius: "20px 20px 0 0",
    width: "100%", maxHeight: "82dvh", display: "flex", flexDirection: "column",
    boxShadow: "var(--shadow-heavy)",
  },
  pickerHead: {
    padding: "14px 16px 12px", borderBottom: "1px solid var(--color-line)",
    flexShrink: 0,
  },
  pickerClose: {
    background: "var(--color-bg-soft)", border: "1px solid var(--color-line)",
    borderRadius: "var(--radius-8)", padding: "6px 12px",
    color: "var(--color-label-mute)", cursor: "pointer",
    fontFamily: "inherit", fontSize: 12,
  },
  pickerSearch: {
    width: "100%", padding: "9px 12px",
    border: "1px solid var(--color-line)", borderRadius: "var(--radius-8)",
    fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box",
  },
  pickerBody: { padding: "12px 16px 22px", overflowY: "auto", flex: 1 },
  pickerCard: {
    display: "block", padding: "12px 14px", marginBottom: 8,
    borderRadius: "var(--radius-12)", cursor: "pointer",
    border: "1px solid var(--color-line)", background: "var(--color-bg)",
  },
  pickerCardActive: {
    border: "1px solid var(--color-primary)", background: "var(--color-primary-soft)",
  },
  pickerTime: { fontSize: 13, fontWeight: 800, color: "var(--color-primary-deep)" },
  pickerType: {
    fontSize: 10, padding: "3px 9px", borderRadius: "var(--radius-pill)",
    background: "var(--color-bg-soft)", color: "var(--color-label-mute)", fontWeight: 600,
  },
  pickerCurrent: {
    fontSize: 10, padding: "3px 9px", borderRadius: "var(--radius-pill)",
    background: "var(--color-primary)", color: "#fff", fontWeight: 700, marginLeft: "auto",
  },
  pickerRoute: {
    fontSize: 14, fontWeight: 700, color: "var(--color-label)", marginBottom: 3,
    wordBreak: "keep-all",
  },
  pickerMeta: { fontSize: 11, color: "var(--color-label-mute)" },

  container: {
    minHeight: "100vh", background: "var(--color-bg-alt)", display: "flex",
    alignItems: "flex-start", justifyContent: "center", padding: 16,
    fontFamily: "var(--font-base)", color: "var(--color-label)", overflowY: "auto",
  },
  card: {
    background: "transparent", borderRadius: 0, padding: 0, width: "100%", maxWidth: 420,
    display: "flex", flexDirection: "column", gap: 14, marginTop: 8, marginBottom: 96,
  },

  header: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "4px 4px 0",
  },
  logoutBtn: {
    background: "var(--color-bg)", border: "1px solid var(--color-line)",
    borderRadius: "var(--radius-8)", padding: "6px 12px", color: "var(--color-label-mute)",
    fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
  },

  greetingDate: { fontSize: 13, color: "var(--color-label-mute)", fontWeight: 600, padding: "0 4px" },
  greetingName: {
    fontSize: 22, fontWeight: 800, marginTop: 2, letterSpacing: "-0.02em",
    color: "var(--color-label)", padding: "0 4px",
  },

  // 그라데이션 히어로 배차카드 (목업 #0066FF → #003DCC)
  heroCard: {
    padding: "20px 20px 18px", borderRadius: "var(--radius-20)",
    background: "linear-gradient(155deg, var(--color-primary) 0%, var(--color-primary-deep) 100%)",
    color: "#fff", position: "relative", overflow: "hidden",
    boxShadow: "var(--shadow-strong)",
  },
  heroBusIcon: { position: "absolute", right: -10, top: -10, width: 140, opacity: 0.15 },
  heroTop: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  heroLiveBadge: {
    display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12,
    fontWeight: 700, color: "#fff",
  },
  heroRoute: {
    fontFamily: "var(--font-brand)", fontSize: 28, fontWeight: 800, marginTop: 14,
    letterSpacing: "-0.025em",
  },
  heroMetaRow: { display: "flex", gap: 16, marginTop: 10, fontSize: 13 },
  heroMetaLabel: { color: "rgba(255,255,255,0.6)" },
  heroMetaVal: { fontWeight: 700, fontFamily: "var(--font-mono)" },
  heroProgress: {
    marginTop: 18, padding: 14, background: "rgba(255,255,255,0.10)",
    borderRadius: "var(--radius-12)",
  },
  heroProgressTop: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    fontSize: 13, fontWeight: 700, color: "rgba(255,255,255,0.85)",
  },
  heroProgressCount: { fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 14 },
  heroNextStop: { fontSize: 24, fontWeight: 800, marginTop: 6, letterSpacing: "-0.01em" },
  heroBar: {
    marginTop: 10, height: 6, background: "rgba(255,255,255,0.18)",
    borderRadius: 3, overflow: "hidden",
  },
  heroBarFill: { height: "100%", background: "#fff", borderRadius: 3, transition: "width .4s ease" },

  emptyDispatch: {
    background: "var(--color-bg)", borderRadius: "var(--radius-16)", padding: "32px 20px",
    border: "1px solid var(--color-line)", textAlign: "center",
    color: "var(--color-label-mute)", fontSize: 14, fontWeight: 600,
    display: "flex", flexDirection: "column", alignItems: "center",
    boxShadow: "var(--shadow-emphasize)",
  },

  statStrip: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 },
  miniStat: {
    background: "var(--color-bg)", borderRadius: "var(--radius-12)", padding: "10px 12px",
    textAlign: "center", boxShadow: "var(--shadow-emphasize)",
  },
  miniStatLabel: { fontSize: 11, color: "var(--color-label-mute)", fontWeight: 600 },
  miniStatVal: {
    fontFamily: "var(--font-brand)", fontSize: 15, fontWeight: 800,
    color: "var(--color-label)", marginTop: 3,
  },

  primaryBtn: {
    border: "none", borderRadius: "var(--radius-16)", padding: "18px 0",
    background: "var(--color-primary)", color: "#fff", fontSize: 16, fontWeight: 700,
    cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center",
    justifyContent: "center", gap: 8, boxShadow: "var(--shadow-strong)",
  },
  primaryBtnDisabled: {
    background: "var(--color-atomic-coolNeutral-90)", color: "var(--color-label-mute)",
    cursor: "not-allowed", boxShadow: "none",
  },

  tabRow: { display: "flex", gap: 6 },
  tabBtn: {
    flex: 1, padding: "10px", borderRadius: "var(--radius-12)", border: "none",
    cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 700,
    display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
  },
  tabBtnActive: { background: "var(--color-primary)", color: "#fff" },
  tabBtnIdle: { background: "var(--color-bg)", color: "var(--color-label-mute)", boxShadow: "var(--shadow-emphasize)" },

  listCard: {
    background: "var(--color-bg)", borderRadius: "var(--radius-16)", padding: "14px 16px",
    boxShadow: "var(--shadow-emphasize)",
  },
  listHeader: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  listTitle: { fontSize: 16, fontWeight: 800, color: "var(--color-label)" },
  listCount: { fontSize: 14, color: "var(--color-primary)", fontWeight: 700 },
  stopRow: { display: "flex", alignItems: "center", gap: 14, padding: "14px 10px", borderRadius: "var(--radius-12)" },
  stopDot: { width: 14, height: 14, borderRadius: "50%", flexShrink: 0 },
  stopName: {
    fontSize: 18, fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    letterSpacing: "-0.01em",
  },
  stopAddr: {
    fontSize: 13, color: "var(--color-label-mute)", overflow: "hidden",
    textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 2, fontWeight: 600,
  },
  tagCurrent: {
    fontSize: 13, background: "var(--color-primary-soft)", color: "var(--color-primary-deep)",
    borderRadius: 999, padding: "5px 12px", flexShrink: 0, fontWeight: 800,
  },
  tagNext: {
    fontSize: 13, background: "var(--color-atomic-orange-90)", color: "#B95300",
    borderRadius: 999, padding: "5px 12px", flexShrink: 0, fontWeight: 800,
  },

  qrNotice: {
    background: "var(--color-atomic-orange-90)", borderRadius: "var(--radius-12)",
    padding: "16px 18px", display: "flex", alignItems: "center", gap: 12, color: "#B95300",
  },
  qrNoticeTitle: { fontSize: 13, fontWeight: 700, marginBottom: 4 },
  qrNoticeSub: { fontSize: 12, color: "#B95300", opacity: 0.85 },
  qrGuide: { fontSize: 12, color: "var(--color-label-mute)", textAlign: "center" },
  qrBox: {
    background: "#fff", borderRadius: "var(--radius-16)", padding: 16,
    display: "inline-block", boxShadow: "var(--shadow-strong)",
  },
  qrPlaceholder: {
    width: 220, height: 220, display: "flex", alignItems: "center",
    justifyContent: "center", color: "var(--color-label-mute)", fontSize: 12,
  },
  qrRouteBox: {
    background: "var(--color-bg)", borderRadius: "var(--radius-12)", padding: "10px 16px",
    textAlign: "center", width: "100%", boxShadow: "var(--shadow-emphasize)",
  },
  qrRouteLabel: { fontSize: 11, color: "var(--color-label-mute)", marginBottom: 4 },
  qrRouteVal: { fontSize: 14, fontWeight: 700, color: "var(--color-primary)" },
  qrAutoNote: { fontSize: 11, color: "var(--color-cautionary)", textAlign: "center", fontWeight: 600 },
  refreshBtn: {
    border: "1px solid var(--color-line)", borderRadius: "var(--radius-12)",
    padding: "12px", color: "var(--color-label)", fontSize: 13, fontWeight: 700,
    cursor: "pointer", fontFamily: "inherit", background: "var(--color-bg)", width: "100%",
  },

  // 하단 운행 종료 바 (목업: 검정 sticky)
  bottomBar: {
    position: "fixed", left: 0, right: 0, bottom: 0, padding: "12px 16px 20px",
    background: "linear-gradient(to top, var(--color-bg-alt) 60%, rgba(247,247,248,0))",
    display: "flex", justifyContent: "center",
  },
  endBtn: {
    width: "100%", maxWidth: 420, padding: "18px 0", borderRadius: "var(--radius-16)",
    border: "none", background: "var(--color-label)", color: "#fff", fontSize: 16,
    fontWeight: 800, fontFamily: "inherit", boxShadow: "var(--shadow-heavy)",
    display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
    cursor: "pointer",
  },
};
