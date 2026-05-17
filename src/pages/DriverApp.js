import { useState, useEffect, useRef } from "react";
import { auth, db } from "../firebase";
import { signOut } from "firebase/auth";
import { collection, query, where, getDocs, doc, updateDoc, orderBy } from "firebase/firestore";
import { startGPS, stopGPS, clearGPS } from "../lib/gps";
import { createBoardingToken, getBoardingUrl } from "../lib/boarding";
import QRCode from "qrcode";
import { BusLinkLogo, Pill, StatusDot, Icon } from "../components/ui";

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
  const [dispatch, setDispatch] = useState(null);
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
  const wakeLockRef = useRef(null);

  // 알림 권한 요청
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
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
    if (!snap.empty) {
      const d = { id: snap.docs[0].id, ...snap.docs[0].data() };
      setDispatch(d);
      // 정류장 로드
      if (d.routeId) await loadStops(d.routeId, cid);
    }
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
    if ("wakeLock" in navigator) {
      try { wakeLockRef.current = await navigator.wakeLock.request("screen"); } catch {}
    }
    await updateDoc(doc(db, "companies", companyId, "drivers", driver.id), {
      status: "운행중", startedAt: new Date().toISOString(),
    });
    const id = startGPS({
      companyId, vehicleId: driver.vehicleId, vehicleNo: driver.vehicleNo || "",
      driverId: driver.id, driverName: driver.name || "",
      routeId: dispatch?.routeId || "", routeName: dispatch?.routeName || "",
      stops,
      onStopReached: (stop, dist) => {
        setCurrentStopIdx(stops.findIndex(s => s.id === stop.id));
        sendNotification(stop, dist);
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
      <div style={{ color: "var(--color-primary)", fontSize: 16, fontWeight: 600 }}>로딩 중...</div>
    </div>
  );

  if (error) return (
    <div style={{ ...S.fullCenter, flexDirection: "column", gap: 16 }}>
      <div style={{ color: "var(--color-destructive)", fontSize: 15, textAlign: "center", whiteSpace: "pre-line", fontWeight: 600 }}>{error}</div>
      <button style={S.outlineBtn} onClick={() => signOut(auth)}>로그아웃</button>
    </div>
  );

  return (
    <div style={S.container}>
      <div style={S.card}>
        {/* 헤더 */}
        <div style={S.header}>
          <BusLinkLogo size={18} sub="기사" />
          <button style={S.logoutBtn} onClick={handleLogout}>로그아웃</button>
        </div>

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
                <Pill tone="dark" dot style={{ background: "rgba(255,255,255,0.18)", color: "#fff" }}>
                  오늘 배차
                </Pill>
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
                return (
                  <div style={S.heroProgress}>
                    <div style={S.heroProgressTop}>
                      <span>다음 정류장</span>
                      <span style={S.heroProgressCount}>{done}/{total} 정류장</span>
                    </div>
                    <div style={S.heroNextStop}>{next ? next.name : "운행 시작"}</div>
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
                return (
                  <div key={stop.id} style={{ ...S.stopRow, opacity: isDone ? 0.5 : 1 }}>
                    <div style={{
                      ...S.stopDot,
                      background: isCurrent ? "var(--color-primary)" : (isDone ? "var(--color-primary)" : "#fff"),
                      border: `2px solid ${isCurrent || isDone ? "var(--color-primary)" : "var(--color-atomic-coolNeutral-90)"}`,
                    }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        ...S.stopName,
                        fontWeight: isCurrent ? 700 : 600,
                        color: isCurrent ? "var(--color-primary)" : (isNext ? "var(--color-label)" : "var(--color-label)"),
                      }}>
                        {stop.name}
                      </div>
                      {stop.address && <div style={S.stopAddr}>{stop.address}</div>}
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
    fontSize: 11, color: "rgba(255,255,255,0.8)",
  },
  heroProgressCount: { fontFamily: "var(--font-mono)", fontWeight: 700 },
  heroNextStop: { fontSize: 17, fontWeight: 700, marginTop: 4 },
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
  listTitle: { fontSize: 13, fontWeight: 700, color: "var(--color-label)" },
  listCount: { fontSize: 12, color: "var(--color-primary)", fontWeight: 600 },
  stopRow: { display: "flex", alignItems: "center", gap: 12, padding: "8px 0" },
  stopDot: { width: 10, height: 10, borderRadius: "50%", flexShrink: 0 },
  stopName: {
    fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  stopAddr: {
    fontSize: 11, color: "var(--color-label-mute)", overflow: "hidden",
    textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 1,
  },
  tagCurrent: {
    fontSize: 10, background: "var(--color-primary-soft)", color: "var(--color-primary-deep)",
    borderRadius: 999, padding: "3px 9px", flexShrink: 0, fontWeight: 700,
  },
  tagNext: {
    fontSize: 10, background: "var(--color-atomic-orange-90)", color: "#B95300",
    borderRadius: 999, padding: "3px 9px", flexShrink: 0, fontWeight: 700,
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
