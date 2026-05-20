import { useState, useEffect, useRef, useCallback } from "react";
import { Map, MapMarker, Polyline, CustomOverlayMap } from "react-kakao-maps-sdk";
import { db, auth } from "../firebase";
import { signOut } from "firebase/auth";
import { getFunctions, httpsCallable } from "firebase/functions";
import {
  collection, onSnapshot, query, where,
  doc, addDoc, updateDoc, deleteDoc, getDocs, setDoc, orderBy
} from "firebase/firestore";
import { useAnimatedPositions } from "../lib/useAnimatedPositions";
import { sendGPS } from "../lib/gps";
import { createPartnerCode, getBoardingUrl } from "../lib/partner";
import { sendNotice } from "../lib/notifications";
import { compressImageFile } from "../lib/image";
import { planTimeForStop, offsetMinFromPlanTime } from "../lib/stopSchedule";
// 리디자인 3단계 — 실시간 관제(MapTab) 라이트 리스킨 전용. 타 탭 미사용.
import { BusLinkLogo, Pill, StatusDot, Icon } from "../components/ui";

const TABS = ["대시보드", "실시간 관제", "배차 관리", "노선 관리", "기사 관리", "차량 관리", "시뮬레이터", "운행 이력", "협력사 관리", "공지 발송"];
const TAB_ICONS = ["grid", "pin", "flag", "route", "user", "bus", "play", "clock", "globe", "bell"];
const functions = getFunctions(undefined, "us-central1");
const getToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());

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

// ═══════════════════════════════════════════════════════
export default function AdminApp({ user, companyId }) {
  const [tab, setTab] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const vehicles = useVehicles(companyId);
  const drivers = useDrivers(companyId);

  // 화면 크기 변경 감지
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);

  return (
    <div style={S.wrap}>
      {/* ── PC: 사이드바 ── */}
      {!isMobile && (
        <div style={S.sidebar}>
          <div style={S.logo}>
            <BusLinkLogo size={22} sub="관리자" />
          </div>
          <div style={S.sideSection}>메뉴</div>
          <nav style={S.nav}>
            {TABS.map((t, i) => (
              <div key={i} data-nav-item onClick={() => setTab(i)}
                style={{ ...S.navItem, ...(tab === i ? S.navActive : {}) }}>
                {tab === i && <span style={S.navAccent} />}
                <span style={S.navIcon}><Icon name={TAB_ICONS[i]} size={17} stroke={tab === i ? 2 : 1.7} /></span>
                {t}
              </div>
            ))}
          </nav>
          <div style={{ flex: 1 }} />
          <div style={S.sideFoot}>
            <StatusDot tone="positive" size={7} />
            <span>{companyId}</span>
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
              <span style={{ fontSize:11, color:"var(--color-label-alt)" }}>{companyId}</span>
              <button style={{ ...S.logoutBtn, padding:"5px 10px", fontSize:11 }} onClick={() => signOut(auth)}>로그아웃</button>
            </div>
          </div>
        )}

        {/* 모바일 드롭다운 메뉴 */}
        {isMobile && menuOpen && (
          <div style={{ position:"absolute", top:50, left:0, right:0, background:"var(--color-bg)", zIndex:100, borderBottom:"1px solid var(--color-line)", boxShadow:"var(--shadow-strong)" }}>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:0 }}>
              {TABS.map((t, i) => (
                <div key={i} onClick={() => { setTab(i); setMenuOpen(false); }}
                  style={{ display:"flex", alignItems:"center", gap:10, padding:"13px 16px", cursor:"pointer", fontSize:13, borderBottom:"1px solid var(--color-line)",
                    background: tab === i ? "var(--color-primary-soft)" : "transparent",
                    color: tab === i ? "var(--color-primary-deep)" : "var(--color-label-mute)",
                    fontWeight: tab === i ? 700 : 500 }}>
                  <Icon name={TAB_ICONS[i]} size={16} /> {t}
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 0 && <DashboardTab companyId={companyId} drivers={drivers} vehicles={vehicles} onNav={setTab} />}
        {tab === 1 && <MapTab companyId={companyId} />}
        {tab === 2 && <DispatchTab companyId={companyId} vehicles={vehicles} drivers={drivers} />}
        {tab === 3 && <RoutesTab companyId={companyId} />}
        {tab === 4 && <DriverTab companyId={companyId} vehicles={vehicles} />}
        {tab === 5 && <VehicleTab companyId={companyId} vehicles={vehicles} />}
        {tab === 6 && <SimulatorTab companyId={companyId} vehicles={vehicles} drivers={drivers} />}
        {tab === 7 && <HistoryTab companyId={companyId} vehicles={vehicles} />}
        {tab === 8 && <PartnerTab companyId={companyId} />}
        {tab === 9 && <NoticeTab companyId={companyId} />}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// 탭0: 대시보드
// ═══════════════════════════════════════════════════════
function DashboardTab({ companyId, drivers, vehicles, onNav }) {
  const [dispatches, setDispatches] = useState([]);
  const [gpsVehicles, setGpsVehicles] = useState([]);
  const [boardings, setBoardings] = useState([]);

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

  const driving = drivers.filter(d => d.status === "운행중").length;
  const waiting = drivers.filter(d => d.status !== "운행중").length;

  const stats = [
    { label: "오늘 배차 노선", value: dispatches.length, sub: "금일 등록 기준", color: "var(--color-primary)" },
    { label: "운행중 차량", value: gpsVehicles.length, sub: `기사 운행중 ${driving}명`, color: "var(--color-positive)" },
    { label: "오늘 탑승 인원", value: boardings.length, sub: "QR 탑승 기준", color: "var(--color-positive)" },
    { label: "전체 기사", value: drivers.length, sub: `대기 ${waiting}명`, color: "var(--color-primary-deep)" },
  ];

  const driverName = (id) => drivers.find(d => d.id === id)?.name ?? id;

  return (
    <div style={S.panel}>
      <div style={S.panelHeader}>
        <div>
          <span style={{ fontSize:16, fontWeight:700, color:"var(--color-label)" }}>🏠 대시보드</span>
          <div style={{ fontSize:12, color:"var(--color-label-mute)", marginTop:2 }}>
            {new Date().toLocaleDateString("ko-KR", { year:"numeric", month:"long", day:"numeric", weekday:"short" })}
          </div>
        </div>
        <button style={S.addBtn} onClick={() => onNav(1)}>🗺 실시간 관제 →</button>
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
            {dispatches.length === 0 ? (
              <div style={S.empty}>오늘 배차 내역이 없습니다</div>
            ) : (
              <table style={S.table}>
                <thead>
                  <tr><th style={S.th}>출발</th><th style={S.th}>노선명</th><th style={S.th}>기사</th></tr>
                </thead>
                <tbody>
                  {[...dispatches].sort((a,b) => a.departTime > b.departTime ? 1 : -1).map(d => (
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
              <button style={S.editBtn} onClick={() => onNav(4)}>기사 관리</button>
            </div>
            {drivers.length === 0 ? (
              <div style={S.empty}>등록된 기사가 없습니다</div>
            ) : (
              <table style={S.table}>
                <thead>
                  <tr><th style={S.th}>이름</th><th style={S.th}>차량</th><th style={S.th}>상태</th></tr>
                </thead>
                <tbody>
                  {drivers.slice(0, 8).map(d => (
                    <tr key={d.id} style={S.tr}>
                      <td style={{ ...S.td, fontWeight:600 }}>{d.name}</td>
                      <td style={{ ...S.td, color:"var(--color-label-mute)", fontSize:12 }}>{d.vehicleNo || "–"}</td>
                      <td style={S.td}>
                        <span style={{ ...S.statusBadge, background:d.status==="운행중"?"#E6F7EB":"var(--color-bg-soft)", color:d.status==="운행중"?"#007A29":"var(--color-label-mute)" }}>
                          ●{d.status ?? "대기"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* GPS 수신 현황 */}
        {gpsVehicles.length > 0 && (
          <div style={{ background:"var(--color-bg)", border:"1px solid var(--color-line)", borderRadius:12, padding:"14px 18px", marginTop:16, boxShadow:"var(--shadow-emphasize)" }}>
            <div style={{ fontWeight:700, marginBottom:12, color:"var(--color-label)" }}>📡 실시간 GPS 수신 차량 ({gpsVehicles.length}대)</div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:10 }}>
              {gpsVehicles.map(v => (
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
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// 탭1: 실시간 관제
// ═══════════════════════════════════════════════════════
function MapTab({ companyId }) {
  const [rawVehicles, setRawVehicles] = useState([]);
  const [selected, setSelected] = useState(null);
  const [center, setCenter] = useState({ lat: 37.3894, lng: 126.9522 });
  const [tick, setTick] = useState(0);
  const vehicles = useAnimatedPositions(rawVehicles);

  useEffect(() => { const t = setInterval(() => setTick(x => x+1), 1000); return () => clearInterval(t); }, []);

  useEffect(() => {
    if (!companyId) return;
    const q = query(collection(db, "gps"), where("companyId", "==", companyId));
    return onSnapshot(q, (snap) => {
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setRawVehicles(list);
      if (list.length > 0 && list[0].lat && list[0].lng)
        setCenter({ lat: list[0].lat, lng: list[0].lng });
    });
  }, [companyId]);

  // 운행중(좌표 유효) 차량만 카운트 — 실데이터 기반(가짜 KPI 미도입)
  const liveCount = vehicles.filter(v => v.lat && v.lng).length;

  return (
    <div style={MS.wrap}>
      {/* 맵 퍼스트 — 카카오맵 구조/마커 불변(목업 MapMock 도입 금지) */}
      <Map center={center} style={MS.map} level={7}>
        {vehicles.map(v => v.lat && v.lng && (
          <MapMarker key={v.id} position={{ lat:v.lat, lng:v.lng }} onClick={() => setSelected(v)} />
        ))}
      </Map>

      {/* 부유 글래스 탑바 — 로고+회사(실제 companyId). 검색/벨/아바타는 로직 부재로 제외 */}
      <div style={MS.topbar}>
        <BusLinkLogo size={20} />
        <div style={MS.topDivider} />
        <span style={MS.topCo}>동영관광 <span style={{ color:"var(--color-label-alt)" }}>· {companyId}</span></span>
        <span style={MS.topTab}><Icon name="pin" size={15}/> 실시간 관제</span>
        <span style={MS.topNow}>
          <StatusDot tone="positive" size={6} pulse /> 실시간 GPS 수신
        </span>
      </div>

      {/* 좌 레일 — 운행 차량 목록(실 onSnapshot 데이터만) */}
      <div style={MS.leftRail}>
        <div style={MS.railHead}>
          <span style={MS.railTitle}>운행 중인 차량</span>
          <Pill tone={liveCount > 0 ? "positive" : "neutral"} dot>{liveCount}대</Pill>
        </div>
        <div style={MS.railBody}>
          {vehicles.length === 0 ? (
            <div style={MS.empty}>운행 중인 차량 없음</div>
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
      </div>

      {/* 우 상세 — 선택 차량(실데이터 stats·기사). 가짜 ETA/탑승인원/정류장 타임라인 제외 */}
      {selected && (
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
};

// ═══════════════════════════════════════════════════════
// 탭2: 배차 관리
// ═══════════════════════════════════════════════════════
function DispatchTab({ companyId, vehicles, drivers }) {
  const [date, setDate] = useState(getToday());
  const [dispatches, setDispatches] = useState([]);
  const [routes, setRoutes] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [editOriginalDate, setEditOriginalDate] = useState(null); // ★ 수정 시 원본 날짜 추적
  const [form, setForm] = useState({ driverId:"", routeId:"", routeName:"", vehicleNo:"", vehicleId:"", departTime:"" });
  const [loading, setLoading] = useState(false);

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
        await updateDoc(doc(db, "companies", companyId, "dispatches", editOriginalDate, "list", editItem.id), { ...form, date: editOriginalDate });
      } else {
        // 신규: 현재 선택된 날짜에 추가
        const ref = collection(db, "companies", companyId, "dispatches", date, "list");
        await addDoc(ref, { ...form, date });
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
  const handleCopyDispatches = async () => {
    if (dispatches.length === 0) return alert("복사할 배차가 없습니다");
    const targetDate = prompt("복사할 대상 날짜를 입력하세요 (예: 2026-03-24)", "");
    if (!targetDate || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) return;
    if (targetDate === date) return alert("같은 날짜로는 복사할 수 없습니다");
    if (!window.confirm(`${date} 배차 ${dispatches.length}건을 ${targetDate}로 복사하시겠습니까?`)) return;
    setLoading(true);
    try {
      const ref = collection(db, "companies", companyId, "dispatches", targetDate, "list");
      for (const d of dispatches) {
        const { id: _id, ...data } = d;
        await addDoc(ref, { ...data, date: targetDate });
      }
      alert(`${dispatches.length}건 복사 완료`);
    } catch (e) { alert("복사 오류: " + e.message); }
    setLoading(false);
  };

  const driverName = (id) => drivers.find(d => d.id === id)?.name ?? id;

  return (
    <div style={S.panel}>
      <div style={S.panelHeader}>
        <span style={{ fontSize:16, fontWeight:700 }}>배차 관리</span>
        <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
          <input type="date" value={date} onChange={e => { if (e.target.value) setDate(e.target.value); }} style={S.dateInput} />
          <button style={S.addBtn} onClick={openAdd}>+ 배차 등록</button>
          {dispatches.length > 0 && (
            <button style={{...S.editBtn, fontSize:12, padding:"6px 10px"}} onClick={handleCopyDispatches} disabled={loading}>📋 복사</button>
          )}
        </div>
      </div>
      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead><tr>{["출발시간","노선명","차량번호","기사"].map(h=><th key={h} style={S.th}>{h}</th>)}<th style={S.th}>관리</th></tr></thead>
          <tbody>
            {dispatches.length === 0 ? <tr><td colSpan={5} style={{...S.td,textAlign:"center",color:"var(--color-label-alt)"}}>배차 내역이 없습니다</td></tr>
            : [...dispatches].sort((a,b)=>a.departTime>b.departTime?1:-1).map(d=>(
              <tr key={d.id} style={S.tr}>
                <td style={S.td}><span style={S.timeBadge}>{d.departTime}</span></td>
                <td style={{...S.td,color:"var(--color-primary)",fontWeight:600}}>{d.routeName}</td>
                <td style={S.td}>{d.vehicleNo}</td>
                <td style={S.td}>{driverName(d.driverId)}</td>
                <td style={S.td}>
                  <button style={S.editBtn} onClick={()=>openEdit(d)}>수정</button>
                  <button style={S.delBtn} onClick={()=>handleDelete(d.id)}>삭제</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {showForm && (
        <div style={S.overlay}><div style={S.modal}>
          <div style={S.modalTitle}>{editItem?"배차 수정":"배차 등록"}</div>
          <label style={S.label}>기사 *</label>
          <select style={S.input} value={form.driverId} onChange={e=>handleDriverSelect(e.target.value)}>
            <option value="">기사 선택</option>
            {drivers.map(d=><option key={d.id} value={d.id}>{d.name} ({d.empNo??d.id})</option>)}
          </select>
          <label style={S.label}>노선 선택 *</label>
          <select style={S.input} value={form.routeId} onChange={e=>handleRouteSelect(e.target.value)}>
            <option value="">노선 선택 (노선 관리에서 먼저 등록)</option>
            {routes.map(r=><option key={r.id} value={r.id}>[{r.shift}] {r.name} ({r.departTime})</option>)}
          </select>
          {!form.routeId && (
            <>
              <label style={S.label}>노선명 직접 입력 (노선 미등록 시)</label>
              <input style={S.input} placeholder="예) [주간조] 대전↔삼성" value={form.routeName} onChange={e=>setForm({...form,routeName:e.target.value})} />
            </>
          )}
          <label style={S.label}>차량 선택</label>
          <select style={S.input} value={form.vehicleId} onChange={e=>handleVehicleSelect(e.target.value)}>
            <option value="">차량 선택</option>
            {vehicles.map(v=><option key={v.id} value={v.id}>{v.plateNo} ({v.model||v.id})</option>)}
          </select>
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

// 탭3: 노선 관리
// ═══════════════════════════════════════════════════════
function RoutesTab({ companyId }) {
  const [routes, setRoutes] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [filter, setFilter] = useState("전체");
  const [search, setSearch] = useState("");
  const [form, setForm] = useState({ name:"", code:"", type:"출근", shift:"주간조", seats:"45", departTime:"", memo:"", partnerCode:"", partnerName:"" });
  const [loading, setLoading] = useState(false);
  const [partners, setPartners] = useState([]); // 협력사 목록
  const [partnerFilter, setPartnerFilter] = useState("전체"); // 거래처 필터
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

  const openAdd = () => { setEditItem(null); setForm({ name:"", code:"", type:"출근", shift:"주간조", seats:"45", departTime:"", memo:"", partnerCode:"", partnerName:"" }); setShowForm(true); };
  const openEdit = (item) => {
    setEditItem(item);
    setForm({ name:item.name||"", code:item.code||"", type:item.type||"출근", shift:item.shift||"주간조", seats:item.seats?.toString()||"", departTime:item.departTime||"", memo:item.memo||"", partnerCode:item.partnerCode||"", partnerName:item.partnerName||"" });
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.name || !form.departTime) return alert("노선명과 출발시간은 필수입니다");
    setLoading(true);
    const data = { name:form.name.trim(), code:form.code.trim(), type:form.type, shift:form.shift, seats:form.seats?parseInt(form.seats):null, departTime:form.departTime, memo:form.memo.trim(), partnerCode:form.partnerCode, partnerName:form.partnerName, updatedAt:new Date().toISOString() };
    try {
      if (editItem) {
        await updateDoc(doc(db, "companies", companyId, "routes", editItem.id), data);
      } else {
        data.createdAt = new Date().toISOString();
        await addDoc(collection(db, "companies", companyId, "routes"), data);
      }
      setShowForm(false);
    } catch (e) { alert("저장 오류: " + e.message); }
    setLoading(false);
  };

  const handleDelete = async (item) => {
    if (!window.confirm(`"${item.name}" 노선을 삭제하시겠습니까?`)) return;
    await deleteDoc(doc(db, "companies", companyId, "routes", item.id));
  };

  // ─── 정류장 CRUD ────────────────────────────────────
  const resetAddrSearch = () => { setAddrQuery(""); setAddrResults([]); setAddrSearching(false); setAddrMsg(""); };
  const openStopAdd = () => {
    setEditStop(null);
    setStopForm({ name:"", address:"", lat:"", lng:"", photo:"", description:"", plannedTime:"" });
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
    const finish = (list, msg) => {
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
    // plannedTime("HH:MM") → 노선 departTime 기준 offsetMin(분) 변환 저장.
    // 빈값=null(미설정, 폴백). 노선 departTime 없거나 형식 오류면 저장 거부.
    const rawTime = (stopForm.plannedTime ?? "").toString().trim();
    let offsetMin = null;
    if (rawTime !== "") {
      if (!stopsRoute?.departTime) { setStopLoading(false); return alert("노선 출발시각이 먼저 설정되어야 정류장 진입시각을 계산할 수 있습니다"); }
      const off = offsetMinFromPlanTime(stopsRoute.departTime, rawTime);
      if (off == null) { setStopLoading(false); return alert("정류장 진입시각 형식이 올바르지 않습니다 (HH:MM)"); }
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

  const filtered = routes.filter(r => {
    if (filter !== "전체" && r.type !== filter) return false;
    if (partnerFilter !== "전체" && r.partnerCode !== partnerFilter) return false;
    if (search && !r.name.includes(search) && !r.code?.includes(search)) return false;
    return true;
  });

  const shifts = ["주간조","야간조","오전조","오후조"];

  return (
    <div style={{ ...S.panel, position:"relative" }}>
      <div style={S.panelHeader}>
        <span style={{ fontSize:16, fontWeight:700 }}>📍 노선 관리</span>
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          <span style={{ fontSize:12, color:"var(--color-label-mute)" }}>총 {routes.length}개</span>
          <button style={S.addBtn} onClick={openAdd}>+ 노선 추가</button>
        </div>
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
          <option value="전체">전체</option>
          {partners.map(p => <option key={p.code} value={p.code}>{p.partnerName}</option>)}
        </select>
        <input style={{ ...S.dateInput, marginLeft:"auto" }} placeholder="노선명·코드 검색"
          value={search} onChange={e=>setSearch(e.target.value)} />
      </div>

      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>{["구분","거래처","근무조","코드","노선명","좌석수","출발시간","정류장"].map(h=><th key={h} style={S.th}>{h}</th>)}<th style={S.th}>관리</th></tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={8} style={{...S.td,textAlign:"center",color:"var(--color-label-alt)"}}>
                {routes.length===0?"등록된 노선이 없습니다":"검색 결과가 없습니다"}
              </td></tr>
            ) : [...filtered].sort((a,b)=>a.departTime>b.departTime?1:-1).map(r=>(
              <tr key={r.id} style={S.tr}>
                <td style={S.td}><span style={{...S.statusBadge, background:r.type==="출근"?"var(--color-primary-soft)":"#FFF1E0", color:r.type==="출근"?"var(--color-primary-deep)":"#B95300"}}>{r.type}</span></td>
                <td style={{...S.td,fontSize:12}}><span style={{ background:"var(--color-bg-soft)", color:"var(--color-label-mute)", borderRadius:6, padding:"2px 7px", fontSize:11, fontWeight:600, whiteSpace:"nowrap" }}>{r.partnerName||"–"}</span></td>
                <td style={{...S.td,color:"var(--color-label-mute)",fontSize:12}}>{r.shift||"–"}</td>
                <td style={{...S.td,color:"var(--color-label-mute)",fontSize:12,fontFamily:"monospace"}}>{r.code||"–"}</td>
                <td style={{...S.td,fontWeight:600,maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.name}</td>
                <td style={S.td}>{r.seats?`${r.seats}석`:"–"}</td>
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
                    {/* 계획 진입시각 — 노선 출발 + 정류장 offsetMin. 미설정은 '—' */}
                    {(() => {
                      const plan = planTimeForStop(stopsRoute?.departTime, s.offsetMin);
                      return (
                        <div style={{ fontSize:10, color: plan ? "var(--color-primary-deep)" : "var(--color-label-assistive)", marginTop:1, fontWeight: plan ? 600 : 500 }}>
                          🕒 계획 진입 {plan || "—"}
                          {typeof s.offsetMin === "number" ? ` (+${s.offsetMin}분)` : ""}
                        </div>
                      );
                    })()}
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
            {["출근","퇴근"].map(t=>(
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
function DriverTab({ companyId, vehicles }) {
  const [drivers, setDrivers] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [form, setForm] = useState({ name:"", empNo:"", vehicleId:"", vehicleNo:"", phone:"", pin:"" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

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
          await addDoc(collection(db,"companies",companyId,"drivers"),{name:form.name,empNo:form.empNo,vehicleId:form.vehicleId,vehicleNo:form.vehicleNo,phone:form.phone,status:"대기",createdAt:new Date().toISOString()});
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
      catch { await deleteDoc(doc(db,"companies",companyId,"drivers",driver.id)); }
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
            {drivers.length===0?<tr><td colSpan={6} style={{...S.td,textAlign:"center",color:"var(--color-label-alt)"}}>등록된 기사가 없습니다</td></tr>
            :drivers.map(d=>(
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
          <input style={{...S.input,...(editItem?{opacity:0.6}:{})}} placeholder="10001" value={form.empNo} onChange={e=>setForm({...form,empNo:e.target.value})} readOnly={!!editItem}/>
          <label style={S.label}>{editItem?"비밀번호 변경 (변경 시에만 입력)":"PIN * (최소 6자리)"}</label>
          <input style={S.input} placeholder={editItem?"변경하지 않으려면 비워두세요":"000000"} type="password" value={form.pin} onChange={e=>setForm({...form,pin:e.target.value})}/>
          <label style={S.label}>배정 차량</label>
          <select style={S.input} value={form.vehicleId} onChange={e=>handleVehicleSelect(e.target.value)}>
            <option value="">차량 선택 (선택사항)</option>
            {vehicles.map(v=><option key={v.id} value={v.id}>{v.plateNo} ({v.model||v.type||v.id})</option>)}
          </select>
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
function VehicleTab({ companyId, vehicles }) {
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [form, setForm] = useState({ plateNo:"", model:"", type:"", seats:"", year:"", memo:"" });
  const [loading, setLoading] = useState(false);

  const openAdd = () => { setEditItem(null); setForm({plateNo:"",model:"",type:"대형",seats:"45",year:"",memo:""}); setShowForm(true); };
  const openEdit = (item) => { setEditItem(item); setForm({plateNo:item.plateNo||"",model:item.model||"",type:item.type||"대형",seats:item.seats?.toString()||"",year:item.year||"",memo:item.memo||""}); setShowForm(true); };

  const handleSave = async () => {
    if (!form.plateNo) return alert("차량번호는 필수입니다");
    setLoading(true);
    try {
      const data = {plateNo:form.plateNo.trim(),model:form.model.trim(),type:form.type,seats:form.seats?parseInt(form.seats):null,year:form.year.trim(),memo:form.memo.trim(),updatedAt:new Date().toISOString()};
      if (editItem) {
        await updateDoc(doc(db,"companies",companyId,"vehicles",editItem.id),data);
      } else {
        data.createdAt = new Date().toISOString();
        await setDoc(doc(db,"companies",companyId,"vehicles",`vehicle_${String(vehicles.length+1).padStart(3,"0")}`),data);
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
          <span style={{fontSize:13,color:"var(--color-label-mute)"}}>총 {vehicles.length}대</span>
          <button style={S.addBtn} onClick={openAdd}>+ 차량 등록</button>
        </div>
      </div>
      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead><tr>{["차량ID","차량번호","차종","모델명","좌석수","연식","비고"].map(h=><th key={h} style={S.th}>{h}</th>)}<th style={S.th}>관리</th></tr></thead>
          <tbody>
            {vehicles.length===0?<tr><td colSpan={8} style={{...S.td,textAlign:"center",color:"var(--color-label-alt)"}}>등록된 차량이 없습니다</td></tr>
            :vehicles.map(v=>(
              <tr key={v.id} style={S.tr}>
                <td style={{...S.td,color:"var(--color-label-mute)",fontSize:12}}>{v.id}</td>
                <td style={{...S.td,fontWeight:600}}>{v.plateNo}</td>
                <td style={S.td}><span style={{...S.statusBadge,background:v.type==="대형"?"var(--color-primary-soft)":v.type==="중형"?"#FFF1E0":"#E6F7EB",color:v.type==="대형"?"var(--color-primary-deep)":v.type==="중형"?"#B95300":"#007A29"}}>{v.type||"–"}</span></td>
                <td style={S.td}>{v.model||"–"}</td>
                <td style={S.td}>{v.seats?`${v.seats}석`:"–"}</td>
                <td style={S.td}>{v.year||"–"}</td>
                <td style={{...S.td,fontSize:12,color:"var(--color-label-mute)"}}>{v.memo||"–"}</td>
                <td style={S.td}>
                  <button style={S.editBtn} onClick={()=>openEdit(v)}>수정</button>
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
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// 탭6: GPS 시뮬레이터
// ═══════════════════════════════════════════════════════
function SimulatorTab({ companyId, vehicles, drivers }) {
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
    <div style={{display:"flex",height:"100%",minHeight:0}}>
      <div style={{...S.mapSidebar,padding:"0 0 16px"}}>
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
function HistoryTab({ companyId, vehicles }) {
  const [date, setDate] = useState(getToday());
  const [vehicleId, setVehicleId] = useState("");
  const [points, setPoints] = useState([]);
  const [loading, setLoading] = useState(false);
  const [center, setCenter] = useState({ lat:37.3894, lng:126.9522 });
  const [selected, setSelected] = useState(null);
  const vehicle = vehicles.find(v=>v.id===vehicleId);

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

  const path = points.map(p=>({lat:p.lat,lng:p.lng}));
  const formatTs = (ts) => { if (!ts) return "–"; const d=ts.toDate?ts.toDate():new Date(ts); return d.toLocaleTimeString("ko-KR",{hour:"2-digit",minute:"2-digit",second:"2-digit"}); };

  return (
    <div style={{display:"flex",height:"100%",minHeight:0}}>
      <div style={{...S.mapSidebar}}>
        <div style={S.panelHeader}>
          <span style={{fontWeight:700}}>📅 운행 이력</span>
          {points.length>0&&<span style={{fontSize:12,fontWeight:600,color:"var(--color-positive)"}}>{points.length}개 포인트</span>}
        </div>
        <div style={{padding:16,display:"flex",flexDirection:"column",gap:10}}>
          <div><label style={S.label}>날짜</label><input type="date" style={S.dateInput} value={date} onChange={e=>{ if(e.target.value) setDate(e.target.value); }}/></div>
          <div><label style={S.label}>차량</label>
            <select style={S.input} value={vehicleId} onChange={e=>setVehicleId(e.target.value)}>
              <option value="">차량 선택</option>
              {vehicles.map(v=><option key={v.id} value={v.id}>{v.plateNo}</option>)}
            </select>
          </div>
          <button style={{...S.addBtn,padding:"10px"}} onClick={handleLoad} disabled={loading}>{loading?"조회 중...":"🔍 이력 조회"}</button>
        </div>
        {points.length>0&&(
          <div style={{flex:1,overflowY:"auto",padding:"0 12px"}}>
            <div style={{fontSize:12,color:"var(--color-label-mute)",padding:"4px 4px 8px",borderBottom:"1px solid var(--color-line)",marginBottom:8}}>{vehicle?.plateNo} · {date}</div>
            {points.map(p=>(
              <div key={p.id} onClick={()=>{setSelected(p);setCenter({lat:p.lat,lng:p.lng});}}
                style={{padding:"8px 10px",borderRadius:8,marginBottom:4,cursor:"pointer",background:selected?.id===p.id?"var(--color-primary-soft)":"var(--color-bg-alt)",border:`1px solid ${selected?.id===p.id?"var(--color-primary)":"var(--color-line)"}`}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <span style={{fontSize:11,fontWeight:700,color:"var(--color-primary)"}}>#{p.idx}</span>
                  <span style={{fontSize:11,color:"var(--color-label-mute)"}}>{formatTs(p.ts)}</span>
                </div>
                <div style={{fontSize:11,color:"var(--color-label-mute)",marginTop:2}}>{p.speed??0} km/h</div>
              </div>
            ))}
          </div>
        )}
        {!loading&&points.length===0&&vehicleId&&<div style={S.empty}>이력이 없습니다</div>}
      </div>
      <div style={{flex:1,position:"relative"}}>
        <Map center={center} style={{width:"100%",height:"100%"}} level={7}>
          {path.length>=2&&<Polyline path={path} strokeWeight={4} strokeColor="#0066FF" strokeOpacity={0.8} strokeStyle="solid"/>}
          {points.length>0&&<MapMarker position={{lat:points[0].lat,lng:points[0].lng}} title="출발"/>}
          {points.length>1&&<MapMarker position={{lat:points[points.length-1].lat,lng:points[points.length-1].lng}} title="도착"/>}
          {selected&&<MapMarker position={{lat:selected.lat,lng:selected.lng}}/>}
        </Map>
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
          <div style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",background:"rgba(255,255,255,0.92)",backdropFilter:"blur(8px)",WebkitBackdropFilter:"blur(8px)",border:"1px solid var(--color-line)",borderRadius:12,padding:"20px 32px",textAlign:"center",color:"var(--color-label-mute)",fontSize:14,boxShadow:"var(--shadow-float)"}}>
            차량과 날짜를 선택 후<br/>이력 조회를 눌러주세요
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// 탭8: 협력사 관리
// ═══════════════════════════════════════════════════════
function PartnerTab({ companyId }) {
  const [codes, setCodes] = useState([]);
  const [routes, setRoutes] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ partnerName: "", memo: "" });
  const [loading, setLoading] = useState(false);
  const [copiedCode, setCopiedCode] = useState(null);
  const [passengers, setPassengers] = useState([]);
  const [selectedCode, setSelectedCode] = useState(null);

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
      const code = await create({ companyId, partnerName: form.partnerName.trim(), memo: form.memo.trim() });
      setShowForm(false);
      setForm({ partnerName: "", memo: "" });
      alert(`업체코드 발급 완료:\n${code}\n\n협력사에 전달해주세요.`);
    } catch (e) { alert("오류: " + e.message); }
    setLoading(false);
  };

  const handleDeactivate = async (code) => {
    if (!window.confirm(`${code.partnerName} 업체코드를 비활성화하시겠습니까?`)) return;
    await updateDoc(doc(db, "partnerCodes", code.id), { active: false });
  };

  const handleActivate = async (code) => {
    if (!window.confirm(`${code.partnerName} 업체코드를 다시 활성화하시겠습니까?`)) return;
    await updateDoc(doc(db, "partnerCodes", code.id), { active: true });
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
              {codes.length === 0 ? (
                <tr><td colSpan={7} style={{ ...S.td, textAlign: "center", color: "var(--color-label-alt)" }}>발급된 업체코드가 없습니다</td></tr>
              ) : [...codes].sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0)).map(c => (
                <tr key={c.id} style={{ ...S.tr, background: selectedCode === c.id ? "var(--color-primary-soft)" : "var(--color-bg)" }}
                  onClick={() => setSelectedCode(selectedCode === c.id ? null : c.id)}>
                  <td style={{ ...S.td, fontWeight: 600 }}>{c.partnerName}</td>
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
                    {c.active ? (
                      <button style={S.delBtn} onClick={() => handleDeactivate(c)}>비활성화</button>
                    ) : (
                      <button style={S.actBtn} onClick={() => handleActivate(c)}>활성화</button>
                    )}
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
                  {codes.find(c => c.id === selectedCode)?.partnerName} 직원 목록
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
                      ? <tr><td colSpan={5} style={{ ...S.td, textAlign: "center", color: "var(--color-label-alt)" }}>등록된 직원이 없습니다</td></tr>
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
    </div>
  );
}


// ═══════════════════════════════════════════════════════
// 탭9: 공지 발송
// ═══════════════════════════════════════════════════════
function NoticeTab({ companyId }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [type, setType] = useState("normal"); // normal | emergency
  const [loading, setLoading] = useState(false);
  const [notices, setNotices] = useState([]);
  const [result, setResult] = useState(null);

  // 발송 이력 구독
  useEffect(() => {
    if (!companyId) return;
    return onSnapshot(
      query(
        collection(db, "companies", companyId, "notices"),
        orderBy("createdAt", "desc")
      ),
      snap => setNotices(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    );
  }, [companyId]);

  const handleSend = async () => {
    if (!title.trim() || !body.trim()) return alert("제목과 내용을 입력해주세요");
    setLoading(true); setResult(null);
    try {
      await sendNotice({ companyId, title, body, type });
      setResult({ ok: true, msg: "공지가 발송되었습니다\n(인앱 배너 즉시 표시, FCM 푸시는 알림 허용 직원에게 발송)" });
      setTitle(""); setBody(""); setType("normal");
    } catch (e) {
      setResult({ ok: false, msg: "발송 실패: " + e.message });
    }
    setLoading(false);
  };

  const handleDeactivate = async (id) => {
    await updateDoc(doc(db, "companies", companyId, "notices", id), { active: false });
  };

  const fmt = (ts) => {
    if (!ts) return "–";
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleString("ko-KR", { month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" });
  };

  return (
    <div style={S.panel}>
      <div style={S.panelHeader}>
        <span style={{ fontSize:16, fontWeight:700 }}>📢 공지 발송</span>
        <span style={{ fontSize:12, color:"var(--color-label-mute)" }}>인앱 배너 + FCM 푸시</span>
      </div>

      <div style={{ padding:"16px 20px", display:"flex", flexDirection:"column", gap:12 }}>
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

        <button style={{ ...S.addBtn, padding:"13px", fontSize:15, opacity:loading?0.6:1, width:"100%" }}
          onClick={handleSend} disabled={loading}>
          {loading ? "발송 중..." : "📢 공지 발송"}
        </button>

        {/* 발송 이력 */}
        <div style={{ marginTop:8 }}>
          <div style={{ fontSize:13, fontWeight:700, marginBottom:10 }}>발송 이력</div>
          {notices.length === 0 ? (
            <div style={{ color:"var(--color-label-alt)", fontSize:13, textAlign:"center", padding:"16px 0" }}>발송된 공지가 없습니다</div>
          ) : notices.slice(0,10).map(n => (
            <div key={n.id} style={{ background:"var(--color-bg)", borderRadius:10, padding:"12px 14px", marginBottom:8, border:`1px solid ${n.type==="emergency"?"#F6C9C9":"var(--color-line)"}`, boxShadow:"var(--shadow-emphasize)", opacity: n.active?1:0.5 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:8 }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:4 }}>
                    <span style={{ fontSize:10, padding:"2px 8px", borderRadius:8, fontWeight:700,
                      background: n.type==="emergency"?"#FCE5E5":"var(--color-primary-soft)",
                      color: n.type==="emergency"?"#A81818":"var(--color-primary-deep)" }}>
                      {n.type==="emergency"?"🚨 긴급":"📋 일반"}
                    </span>
                    {!n.active && <span style={{ fontSize:10, color:"var(--color-label-alt)" }}>비활성</span>}
                    <span style={{ fontSize:11, color:"var(--color-label-alt)", marginLeft:"auto" }}>{fmt(n.createdAt)}</span>
                  </div>
                  <div style={{ fontSize:13, fontWeight:700, marginBottom:2, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{n.title}</div>
                  <div style={{ fontSize:12, color:"var(--color-label-mute)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{n.body}</div>
                </div>
                {n.active && (
                  <button onClick={()=>handleDeactivate(n.id)}
                    style={{ background:"transparent", border:"1px solid var(--color-line)", borderRadius:6, padding:"4px 8px", color:"var(--color-label-mute)", fontSize:11, cursor:"pointer", fontFamily:"inherit", flexShrink:0 }}>
                    숨기기
                  </button>
                )}
              </div>
            </div>
          ))}
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
const S = {
  wrap:{display:"flex",height:"100dvh",background:"var(--color-bg-soft)",fontFamily:"var(--font-base)",color:"var(--color-label)",position:"relative",overflow:"hidden",fontSize:13},
  sidebar:{width:236,background:"var(--color-bg)",borderRight:"1px solid var(--color-line)",display:"flex",flexDirection:"column",padding:"18px 14px"},
  logo:{display:"flex",alignItems:"baseline",gap:8,padding:"4px 8px 16px",marginBottom:10,borderBottom:"1px solid var(--color-line)"},
  logoText:{fontSize:20,fontWeight:800,fontFamily:"var(--font-brand)",letterSpacing:"-0.03em",color:"var(--color-primary)"},
  logoSub:{fontSize:12,color:"var(--color-label-mute)"},
  sideSection:{fontSize:11,fontWeight:700,letterSpacing:"0.04em",color:"var(--color-label-alt)",padding:"6px 12px 8px"},
  nav:{display:"flex",flexDirection:"column",gap:2},
  navItem:{display:"flex",alignItems:"center",gap:11,padding:"10px 12px",borderRadius:10,cursor:"pointer",fontSize:13,fontWeight:500,color:"var(--color-label-mute)",position:"relative",transition:"background .15s,color .15s",userSelect:"none"},
  navActive:{background:"var(--color-primary-soft)",color:"var(--color-primary-deep)",fontWeight:700},
  navAccent:{position:"absolute",left:3,top:"50%",transform:"translateY(-50%)",width:3,height:18,borderRadius:3,background:"var(--color-primary)"},
  navIcon:{flexShrink:0,display:"flex",opacity:.92},
  sideFoot:{display:"flex",alignItems:"center",gap:7,padding:"10px 12px 8px",fontSize:11,color:"var(--color-label-alt)"},
  logoutBtn:{display:"flex",alignItems:"center",justifyContent:"center",gap:7,width:"100%",border:"1px solid var(--color-line)",borderRadius:10,padding:"10px 12px",color:"var(--color-label-mute)",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit"},
  content:{flex:1,display:"flex",flexDirection:"column",minHeight:0,overflow:"hidden"},
  mapSidebar:{width:"min(280px,38vw)",minWidth:180,background:"var(--color-bg)",borderRight:"1px solid var(--color-line)",display:"flex",flexDirection:"column",overflowY:"auto"},
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
