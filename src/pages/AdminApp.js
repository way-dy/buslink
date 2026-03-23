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

const TABS = ["🏠 대시보드", "🗺 실시간 관제", "📋 배차 관리", "📍 노선 관리", "👤 기사 관리", "🚌 차량 관리", "🧪 시뮬레이터", "📅 운행 이력", "🤝 협력사 관리", "📢 공지 발송"];
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
            <span style={S.logoText}>BusLink</span>
            <span style={S.logoSub}>관리자</span>
          </div>
          <nav style={S.nav}>
            {TABS.map((t, i) => (
              <div key={i} onClick={() => setTab(i)}
                style={{ ...S.navItem, ...(tab === i ? S.navActive : {}) }}>
                {t}
              </div>
            ))}
          </nav>
          <div style={{ flex: 1 }} />
          <div style={{ padding:"8px 12px", fontSize:11, color:"#4A6FA5", marginBottom:4 }}>{companyId}</div>
          <button style={S.logoutBtn} onClick={() => signOut(auth)}>로그아웃</button>
        </div>
      )}

      {/* ── 콘텐츠 영역 ── */}
      <div style={S.content}>
        {/* 모바일 상단 헤더 */}
        {isMobile && (
          <div style={{ background:"#112240", borderBottom:"1px solid #1E3A5F", padding:"10px 14px", display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0, zIndex:50 }}>
            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
              <button onClick={() => setMenuOpen(p => !p)}
                style={{ background:"#1E3A5F", border:"none", borderRadius:8, padding:"6px 10px", color:"#F0F4FF", fontSize:18, cursor:"pointer", lineHeight:1 }}>
                ☰
              </button>
              <span style={{ fontSize:14, fontWeight:700, color:"#00C2FF" }}>
                {TABS[tab].replace(/^\S+\s/, "")}
              </span>
            </div>
            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
              <span style={{ fontSize:11, color:"#4A6FA5" }}>{companyId}</span>
              <button style={{ ...S.logoutBtn, padding:"5px 10px", fontSize:11 }} onClick={() => signOut(auth)}>로그아웃</button>
            </div>
          </div>
        )}

        {/* 모바일 드롭다운 메뉴 */}
        {isMobile && menuOpen && (
          <div style={{ position:"absolute", top:50, left:0, right:0, background:"#112240", zIndex:100, borderBottom:"1px solid #1E3A5F", boxShadow:"0 8px 32px rgba(0,0,0,.5)" }}>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:0 }}>
              {TABS.map((t, i) => (
                <div key={i} onClick={() => { setTab(i); setMenuOpen(false); }}
                  style={{ padding:"13px 16px", cursor:"pointer", fontSize:13, borderBottom:"1px solid #1E3A5F",
                    background: tab === i ? "#1A6BFF22" : "transparent",
                    color: tab === i ? "#00C2FF" : "#8896AA",
                    fontWeight: tab === i ? 700 : 400 }}>
                  {t}
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
    { label: "오늘 배차 노선", value: dispatches.length, sub: "금일 등록 기준", color: "#00C2FF" },
    { label: "운행중 차량", value: gpsVehicles.length, sub: `기사 운행중 ${driving}명`, color: "#00C48C" },
    { label: "오늘 탑승 인원", value: boardings.length, sub: "QR 탑승 기준", color: "#00C48C" },
    { label: "전체 기사", value: drivers.length, sub: `대기 ${waiting}명`, color: "#1A6BFF" },
  ];

  const driverName = (id) => drivers.find(d => d.id === id)?.name ?? id;

  return (
    <div style={S.panel}>
      <div style={S.panelHeader}>
        <div>
          <span style={{ fontSize:16, fontWeight:700 }}>🏠 대시보드</span>
          <div style={{ fontSize:12, color:"#8896AA", marginTop:2 }}>
            {new Date().toLocaleDateString("ko-KR", { year:"numeric", month:"long", day:"numeric", weekday:"short" })}
          </div>
        </div>
        <button style={S.addBtn} onClick={() => onNav(1)}>🗺 실시간 관제 →</button>
      </div>

      <div style={{ padding:"20px 24px", overflowY:"auto", flex:1 }}>
        {/* 통계 카드 */}
        <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:12, marginBottom:20 }}>
          {stats.map(s => (
            <div key={s.label} style={{ background:"#112240", border:"1px solid #1E3A5F", borderRadius:12, padding:"18px 20px" }}>
              <div style={{ fontSize:12, color:"#8896AA", marginBottom:8 }}>{s.label}</div>
              <div style={{ fontSize:30, fontWeight:700, color:s.color }}>{s.value}</div>
              <div style={{ fontSize:11, color:"#8896AA", marginTop:4 }}>{s.sub}</div>
            </div>
          ))}
        </div>

        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>
          {/* 오늘 배차 현황 */}
          <div style={{ background:"#112240", border:"1px solid #1E3A5F", borderRadius:12, overflow:"hidden" }}>
            <div style={{ padding:"14px 18px", borderBottom:"1px solid #1E3A5F", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <span style={{ fontWeight:600 }}>오늘 배차 현황</span>
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
                      <td style={{ ...S.td, color:"#00C2FF", fontSize:12, maxWidth:140, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{d.routeName}</td>
                      <td style={S.td}>{driverName(d.driverId)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* 기사 현황 */}
          <div style={{ background:"#112240", border:"1px solid #1E3A5F", borderRadius:12, overflow:"hidden" }}>
            <div style={{ padding:"14px 18px", borderBottom:"1px solid #1E3A5F", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <span style={{ fontWeight:600 }}>기사 현황</span>
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
                      <td style={{ ...S.td, color:"#8896AA", fontSize:12 }}>{d.vehicleNo || "–"}</td>
                      <td style={S.td}>
                        <span style={{ ...S.statusBadge, background:d.status==="운행중"?"#00C48C22":"#1E3A5F", color:d.status==="운행중"?"#00C48C":"#8896AA" }}>
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
          <div style={{ background:"#112240", border:"1px solid #1E3A5F", borderRadius:12, padding:"14px 18px", marginTop:16 }}>
            <div style={{ fontWeight:600, marginBottom:12 }}>📡 실시간 GPS 수신 차량 ({gpsVehicles.length}대)</div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:10 }}>
              {gpsVehicles.map(v => (
                <div key={v.id} style={{ background:"#0B1A2E", border:"1px solid #1E3A5F", borderRadius:8, padding:"8px 14px", fontSize:12 }}>
                  <span style={{ color:"#00C48C", marginRight:6 }}>●</span>
                  <span style={{ fontWeight:600 }}>{v.vehicleNo || v.vehicleId}</span>
                  <span style={{ color:"#8896AA", marginLeft:8 }}>{v.driverName}</span>
                  <span style={{ color:"#FFD166", marginLeft:8 }}>{timeSince(v.updatedAt)}</span>
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

  return (
    <div style={{ display:"flex", height:"100%", minHeight:0 }}>
      <div style={S.mapSidebar}>
        <div style={S.panelHeader}>
          <span>운행 중인 차량</span>
          <span style={{ color:"#00C48C", fontWeight:700 }}>{vehicles.length}대</span>
        </div>
        {vehicles.length === 0 ? (
          <div style={S.empty}>운행 중인 차량 없음</div>
        ) : vehicles.map(v => (
          <div key={v.id} onClick={() => { setSelected(v); if (v.lat && v.lng) setCenter({ lat:v.lat, lng:v.lng }); }}
            style={{ ...S.vehicleCard, border:selected?.id===v.id?"1px solid #00C2FF":"1px solid #1E3A5F" }}>
            <div style={S.vehicleTop}><span style={S.dot} /><span style={S.vehicleName}>{v.vehicleNo || v.id}</span></div>
            <div style={S.vehicleInfo}>기사: {v.driverName || v.driverId}</div>
            <div style={S.vehicleInfo}>노선: {v.routeName || v.routeId || "–"}</div>
            <div style={S.vehicleInfo}>속도: {v.speed ?? 0} km/h</div>
            <div style={{ ...S.vehicleInfo, color:"#FFD166" }}>갱신: {timeSince(v.updatedAt)}</div>
          </div>
        ))}
      </div>
      <div style={{ flex:1, position:"relative" }}>
        <Map center={center} style={{ width:"100%", height:"100%" }} level={7}>
          {vehicles.map(v => v.lat && v.lng && (
            <MapMarker key={v.id} position={{ lat:v.lat, lng:v.lng }} onClick={() => setSelected(v)} />
          ))}
        </Map>
        {selected && (
          <div style={S.infoBox}>
            <div style={S.infoTitle}>📍 {selected.vehicleNo || selected.id}</div>
            <div style={S.infoRow}>기사: {selected.driverName || selected.driverId}</div>
            <div style={S.infoRow}>노선: {selected.routeName || selected.routeId || "–"}</div>
            <div style={S.infoRow}>속도: {selected.speed ?? 0} km/h</div>
            <div style={S.infoRow}>정확도: ±{selected.accuracy}m</div>
            <div style={{ ...S.infoRow, color:"#FFD166" }}>마지막 수신: {timeSince(selected.updatedAt)}</div>
            <button onClick={() => setSelected(null)} style={S.closeBtn}>닫기</button>
          </div>
        )}
      </div>
    </div>
  );
}

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
    setLoading(true);
    try {
      if (editItem && editOriginalDate) {
        // ★ 수정: 원본 날짜 기준으로 업데이트
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

  const driverName = (id) => drivers.find(d => d.id === id)?.name ?? id;

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
            {dispatches.length === 0 ? <tr><td colSpan={5} style={{...S.td,textAlign:"center",color:"#4A6FA5"}}>배차 내역이 없습니다</td></tr>
            : [...dispatches].sort((a,b)=>a.departTime>b.departTime?1:-1).map(d=>(
              <tr key={d.id} style={S.tr}>
                <td style={S.td}><span style={S.timeBadge}>{d.departTime}</span></td>
                <td style={{...S.td,color:"#00C2FF",fontWeight:600}}>{d.routeName}</td>
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
  const [stopForm, setStopForm] = useState({ name:"", address:"", lat:"", lng:"" });
  const [stopLoading, setStopLoading] = useState(false);
  const [showMapPicker, setShowMapPicker] = useState(false);   // 지도 좌표 선택 모달
  const [pickerCenter, setPickerCenter] = useState({ lat: 37.3894, lng: 126.9522 });
  const [pickerPin, setPickerPin] = useState(null);            // 선택된 핀

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
  const openStopAdd = () => {
    setEditStop(null);
    setStopForm({ name:"", address:"", lat:"", lng:"" });
    setPickerPin(null);
    // 기존 정류장이 있으면 첫 번째 정류장 위치로 중심 설정
    if (stops.length > 0) setPickerCenter({ lat: stops[0].lat, lng: stops[0].lng });
    setShowStopForm(true);
  };
  const openStopEdit = (s) => {
    setEditStop(s);
    setStopForm({ name:s.name||"", address:s.address||"", lat:s.lat?.toString()||"", lng:s.lng?.toString()||"" });
    if (s.lat && s.lng) {
      setPickerCenter({ lat: s.lat, lng: s.lng });
      setPickerPin({ lat: s.lat, lng: s.lng });
    }
    setShowStopForm(true);
  };

  const handleStopSave = async () => {
    if (!stopForm.name || !stopForm.lat || !stopForm.lng) return alert("정류장명, 위도, 경도는 필수입니다");
    const lat = parseFloat(stopForm.lat), lng = parseFloat(stopForm.lng);
    if (isNaN(lat) || isNaN(lng)) return alert("위도/경도는 숫자로 입력해주세요");
    setStopLoading(true);
    const data = { name:stopForm.name.trim(), address:stopForm.address.trim(), lat, lng, updatedAt:new Date().toISOString() };
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
          <span style={{ fontSize:12, color:"#8896AA" }}>총 {routes.length}개</span>
          <button style={S.addBtn} onClick={openAdd}>+ 노선 추가</button>
        </div>
      </div>

      <div style={{ padding:"10px 16px", display:"flex", flexWrap:"wrap", gap:6, alignItems:"center", borderBottom:"1px solid #1E3A5F" }}>
        {/* 출근/퇴근 필터 */}
        {["전체","출근","퇴근"].map(f=>(
          <button key={f} onClick={()=>setFilter(f)}
            style={{ ...S.editBtn, background:filter===f?"#1A6BFF22":"#1E3A5F", color:filter===f?"#00C2FF":"#8896AA", border:filter===f?"1px solid rgba(0,194,255,.3)":"none" }}>
            {f}
          </button>
        ))}
        {/* 거래처 필터 */}
        <span style={{ fontSize:11, color:"#4A6FA5", marginLeft:4 }}>거래처:</span>
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
              <tr><td colSpan={8} style={{...S.td,textAlign:"center",color:"#4A6FA5"}}>
                {routes.length===0?"등록된 노선이 없습니다":"검색 결과가 없습니다"}
              </td></tr>
            ) : [...filtered].sort((a,b)=>a.departTime>b.departTime?1:-1).map(r=>(
              <tr key={r.id} style={S.tr}>
                <td style={S.td}><span style={{...S.statusBadge, background:r.type==="출근"?"rgba(26,107,255,.2)":"rgba(255,140,66,.15)", color:r.type==="출근"?"#3D8BFF":"#FF8C42"}}>{r.type}</span></td>
                <td style={{...S.td,fontSize:12}}><span style={{ background:"rgba(255,209,102,.1)", color:"#FFD166", borderRadius:6, padding:"2px 7px", fontSize:11, whiteSpace:"nowrap" }}>{r.partnerName||"–"}</span></td>
                <td style={{...S.td,color:"#8896AA",fontSize:12}}>{r.shift||"–"}</td>
                <td style={{...S.td,color:"#8896AA",fontSize:12,fontFamily:"monospace"}}>{r.code||"–"}</td>
                <td style={{...S.td,fontWeight:600,maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.name}</td>
                <td style={S.td}>{r.seats?`${r.seats}석`:"–"}</td>
                <td style={S.td}><span style={S.timeBadge}>{r.departTime}</span></td>
                <td style={S.td}>
                  <button onClick={()=>setStopsRoute(r)}
                    style={{...S.editBtn, background:stopsRoute?.id===r.id?"#1A6BFF22":"#1E3A5F", color:stopsRoute?.id===r.id?"#00C2FF":"#8896AA", border:stopsRoute?.id===r.id?"1px solid rgba(0,194,255,.3)":"none"}}>
                    정류장 관리
                  </button>
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
        <div style={{ position:"absolute", top:0, right:0, width:"min(380px,100%)", height:"100%", background:"#112240", borderLeft:"1px solid #1E3A5F", display:"flex", flexDirection:"column", zIndex:20 }}>
          <div style={{ padding:"14px 16px", borderBottom:"1px solid #1E3A5F", display:"flex", alignItems:"center", justifyContent:"space-between", background:"#0B1A2E" }}>
            <div>
              <div style={{ fontWeight:700, fontSize:14, color:"#00C2FF" }}>📍 정류장 관리</div>
              <div style={{ fontSize:11, color:"#8896AA", marginTop:2, maxWidth:280, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{stopsRoute.name}</div>
            </div>
            <div style={{ display:"flex", gap:8 }}>
              <button style={S.addBtn} onClick={openStopAdd}>+ 추가</button>
              <button style={S.editBtn} onClick={()=>setStopsRoute(null)}>✕</button>
            </div>
          </div>

          {/* 정류장 목록 */}
          <div style={{ flex:1, overflowY:"auto", padding:"8px 12px" }}>
            {stops.length === 0 ? (
              <div style={{ color:"#4A6FA5", textAlign:"center", padding:30, fontSize:13 }}>
                정류장이 없습니다<br/>
                <span style={{ fontSize:11, color:"#1E3A5F" }}>+ 추가 버튼으로 정류장을 등록하세요</span>
              </div>
            ) : stops.map((s, i) => (
              <div key={s.id} style={{ background:"#0B1A2E", border:"1px solid #1E3A5F", borderRadius:10, padding:"10px 12px", marginBottom:8 }}>
                <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                  <div style={{ width:24, height:24, borderRadius:"50%", background:"#1A6BFF22", border:"1px solid #1A6BFF44", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:700, color:"#3D8BFF", flexShrink:0 }}>
                    {s.order || i+1}
                  </div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:13, fontWeight:600, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{s.name}</div>
                    {s.address && <div style={{ fontSize:11, color:"#8896AA", marginTop:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{s.address}</div>}
                    <div style={{ fontSize:10, color:"#4A6FA5", marginTop:1 }}>{s.lat?.toFixed(5)}, {s.lng?.toFixed(5)}</div>
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
            <div style={{ padding:"14px 16px", borderTop:"1px solid #1E3A5F", background:"#0B1A2E" }}>
              <div style={{ fontSize:13, fontWeight:700, marginBottom:10, color:"#00C2FF" }}>{editStop?"정류장 수정":"정류장 추가"}</div>
              <label style={S.label}>정류장명 *</label>
              <input style={{...S.input, marginBottom:6}} placeholder="예) 서대전역 5번출구" value={stopForm.name} onChange={e=>setStopForm({...stopForm,name:e.target.value})}/>
              <label style={S.label}>주소 (선택)</label>
              <input style={{...S.input, marginBottom:8}} placeholder="예) 대전 서구 둔산동" value={stopForm.address} onChange={e=>setStopForm({...stopForm,address:e.target.value})}/>

              {/* 지도 클릭 좌표 선택 버튼 */}
              <button onClick={() => setShowMapPicker(true)}
                style={{ width:"100%", padding:"10px", background: pickerPin ? "rgba(0,196,140,.15)" : "#1E3A5F", border: pickerPin ? "1px solid rgba(0,196,140,.4)" : "1px solid #1E3A5F", borderRadius:8, color: pickerPin ? "#00C48C" : "#8896AA", fontSize:13, fontWeight:600, cursor:"pointer", fontFamily:"inherit", marginBottom:6 }}>
                {pickerPin
                  ? `📍 ${parseFloat(stopForm.lat).toFixed(5)}, ${parseFloat(stopForm.lng).toFixed(5)}`
                  : "🗺 지도에서 위치 선택"}
              </button>

              {/* 좌표 직접 입력 (접기/펼치기) */}
              <details style={{ marginBottom:8 }}>
                <summary style={{ fontSize:11, color:"#4A6FA5", cursor:"pointer", userSelect:"none" }}>좌표 직접 입력</summary>
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
      )}

      {/* ── 지도 좌표 선택 모달 ── */}
      {showMapPicker && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.7)", zIndex:200, display:"flex", flexDirection:"column" }}>
          {/* 모달 헤더 */}
          <div style={{ background:"#112240", padding:"12px 16px", display:"flex", justifyContent:"space-between", alignItems:"center", flexShrink:0 }}>
            <div>
              <div style={{ fontSize:14, fontWeight:700 }}>📍 위치 선택</div>
              <div style={{ fontSize:11, color:"#8896AA", marginTop:2 }}>
                {pickerPin ? `선택됨: ${pickerPin.lat.toFixed(5)}, ${pickerPin.lng.toFixed(5)}` : "지도를 클릭하여 정류장 위치를 선택하세요"}
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
                style={{ background: pickerPin ? "linear-gradient(135deg,#1A6BFF,#00C2FF)" : "#1E3A5F", border:"none", borderRadius:8, padding:"8px 16px", color: pickerPin ? "#fff" : "#4A6FA5", fontSize:13, fontWeight:700, cursor: pickerPin ? "pointer" : "default", fontFamily:"inherit", opacity: pickerPin ? 1 : 0.6 }}>
                이 위치로 선택
              </button>
              <button onClick={() => setShowMapPicker(false)}
                style={{ background:"#1E3A5F", border:"none", borderRadius:8, padding:"8px 14px", color:"#8896AA", fontSize:13, cursor:"pointer", fontFamily:"inherit" }}>
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
                    image={{ src:"https://t1.daumcdn.net/localimg/localimages/07/mapapidoc/markerStar.png", size:{ width:24, height:35 } }}
                  />
                  <CustomOverlayMap position={pickerPin} yAnchor={2.2}>
                    <div style={{ background:"#112240", border:"1px solid #00C2FF", borderRadius:8, padding:"4px 10px", fontSize:11, color:"#00C2FF", fontWeight:600, whiteSpace:"nowrap" }}>
                      {stopForm.name || "새 정류장"}<br/>
                      <span style={{ color:"#4A6FA5", fontWeight:400 }}>{pickerPin.lat.toFixed(5)}, {pickerPin.lng.toFixed(5)}</span>
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
          <div style={{ background:"#112240", padding:"10px 16px", borderTop:"1px solid #1E3A5F", flexShrink:0 }}>
            <div style={{ fontSize:12, color:"#8896AA", textAlign:"center" }}>
              지도를 클릭하면 핀이 찍힙니다 · 빨간 마커는 기존 정류장 위치입니다
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
                style={{...S.editBtn,flex:1,padding:"9px",background:form.type===t?"linear-gradient(135deg,#1A6BFF,#00C2FF)":"#1E3A5F",color:form.type===t?"#fff":"#8896AA",border:"none",cursor:"pointer",fontFamily:"inherit"}}>
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
            {drivers.length===0?<tr><td colSpan={6} style={{...S.td,textAlign:"center",color:"#4A6FA5"}}>등록된 기사가 없습니다</td></tr>
            :drivers.map(d=>(
              <tr key={d.id} style={S.tr}>
                <td style={S.td}>{d.empNo??d.id}</td>
                <td style={{...S.td,fontWeight:600}}>{d.name}</td>
                <td style={S.td}>{d.vehicleNo||"–"}</td>
                <td style={S.td}>{d.phone||"–"}</td>
                <td style={S.td}><span style={{...S.statusBadge,background:d.status==="운행중"?"#00C48C22":"#1E3A5F",color:d.status==="운행중"?"#00C48C":"#8896AA"}}>{d.status??"대기"}</span></td>
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
          {error&&<p style={{color:"#FF4D6A",fontSize:13,margin:0}}>{error}</p>}
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
          <span style={{fontSize:13,color:"#8896AA"}}>총 {vehicles.length}대</span>
          <button style={S.addBtn} onClick={openAdd}>+ 차량 등록</button>
        </div>
      </div>
      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead><tr>{["차량ID","차량번호","차종","모델명","좌석수","연식","비고"].map(h=><th key={h} style={S.th}>{h}</th>)}<th style={S.th}>관리</th></tr></thead>
          <tbody>
            {vehicles.length===0?<tr><td colSpan={8} style={{...S.td,textAlign:"center",color:"#4A6FA5"}}>등록된 차량이 없습니다</td></tr>
            :vehicles.map(v=>(
              <tr key={v.id} style={S.tr}>
                <td style={{...S.td,color:"#8896AA",fontSize:12}}>{v.id}</td>
                <td style={{...S.td,fontWeight:600}}>{v.plateNo}</td>
                <td style={S.td}><span style={{...S.statusBadge,background:v.type==="대형"?"#1A6BFF22":v.type==="중형"?"#FFD16622":"#00C48C22",color:v.type==="대형"?"#3D8BFF":v.type==="중형"?"#FFD166":"#00C48C"}}>{v.type||"–"}</span></td>
                <td style={S.td}>{v.model||"–"}</td>
                <td style={S.td}>{v.seats?`${v.seats}석`:"–"}</td>
                <td style={S.td}>{v.year||"–"}</td>
                <td style={{...S.td,fontSize:12,color:"#8896AA"}}>{v.memo||"–"}</td>
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
          <span style={{fontWeight:700}}>🧪 GPS 시뮬레이터</span>
          <span style={{fontSize:11,color:running?"#00C48C":"#8896AA"}}>{running?"● 송출 중":"○ 정지"}</span>
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
          <div style={{background:"#0B1A2E",borderRadius:8,padding:12}}>
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
            :<button style={{...S.addBtn,background:"#FF4D6A",padding:"10px"}} onClick={handleStop}>🔴 시뮬레이터 종료</button>
          }
          <button style={{...S.editBtn,padding:"8px",fontSize:13}} onClick={doSend} disabled={running}>📡 1회 수동 전송</button>
        </div>
        <div style={{margin:"12px 16px 0",background:"#0B1A2E",borderRadius:8,padding:10,fontSize:11,color:"#8896AA",maxHeight:200,overflowY:"auto"}}>
          {log.length===0?<span style={{color:"#4A6FA5"}}>로그 없음</span>:log.map((l,i)=><div key={i}>{l}</div>)}
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
          {points.length>0&&<span style={{fontSize:12,color:"#00C48C"}}>{points.length}개 포인트</span>}
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
            <div style={{fontSize:12,color:"#8896AA",padding:"4px 4px 8px",borderBottom:"1px solid #1E3A5F",marginBottom:8}}>{vehicle?.plateNo} · {date}</div>
            {points.map(p=>(
              <div key={p.id} onClick={()=>{setSelected(p);setCenter({lat:p.lat,lng:p.lng});}}
                style={{padding:"8px 10px",borderRadius:8,marginBottom:4,cursor:"pointer",background:selected?.id===p.id?"#1A6BFF22":"#0B1A2E",border:`1px solid ${selected?.id===p.id?"#1A6BFF":"transparent"}`}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <span style={{fontSize:11,fontWeight:700,color:"#00C2FF"}}>#{p.idx}</span>
                  <span style={{fontSize:11,color:"#8896AA"}}>{formatTs(p.ts)}</span>
                </div>
                <div style={{fontSize:11,color:"#8896AA",marginTop:2}}>{p.speed??0} km/h</div>
              </div>
            ))}
          </div>
        )}
        {!loading&&points.length===0&&vehicleId&&<div style={S.empty}>이력이 없습니다</div>}
      </div>
      <div style={{flex:1,position:"relative"}}>
        <Map center={center} style={{width:"100%",height:"100%"}} level={7}>
          {path.length>=2&&<Polyline path={path} strokeWeight={4} strokeColor="#1A6BFF" strokeOpacity={0.8} strokeStyle="solid"/>}
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
          <div style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",background:"#112240cc",border:"1px solid #1E3A5F",borderRadius:12,padding:"20px 32px",textAlign:"center",color:"#8896AA",fontSize:14}}>
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
                <tr><td colSpan={7} style={{ ...S.td, textAlign: "center", color: "#4A6FA5" }}>발급된 업체코드가 없습니다</td></tr>
              ) : [...codes].sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0)).map(c => (
                <tr key={c.id} style={{ ...S.tr, background: selectedCode === c.id ? "rgba(26,107,255,.08)" : "#112240" }}
                  onClick={() => setSelectedCode(selectedCode === c.id ? null : c.id)}>
                  <td style={{ ...S.td, fontWeight: 600 }}>{c.partnerName}</td>
                  <td style={{ ...S.td }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <code style={{ fontSize: 11, color: "#00C2FF", background: "#0B1A2E", padding: "2px 8px", borderRadius: 4 }}>
                        {c.code}
                      </code>
                      <button onClick={(e) => { e.stopPropagation(); copyCode(c.code); }}
                        style={{ ...S.editBtn, padding: "2px 8px", fontSize: 11 }}>
                        {copiedCode === c.code ? "✓" : "복사"}
                      </button>
                    </div>
                  </td>
                  <td style={S.td}>
                    <span style={{ ...S.statusBadge, background: c.active ? "#00C48C22" : "#FF4D6A22", color: c.active ? "#00C48C" : "#FF4D6A" }}>
                      ● {c.active ? "활성" : "비활성"}
                    </span>
                  </td>
                  <td style={{ ...S.td, fontSize: 12, color: "#8896AA" }}>{formatDate(c.expiresAt)}</td>
                  <td style={{ ...S.td, color: "#00C2FF", fontWeight: 600 }}>{c.uploadCount || 0}회</td>
                  <td style={{ ...S.td, fontSize: 12, color: "#8896AA" }}>{formatDate(c.lastUploadAt)}</td>
                  <td style={S.td} onClick={e => e.stopPropagation()}>
                    {c.active && (
                      <button style={S.delBtn} onClick={() => handleDeactivate(c)}>비활성화</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* 선택된 업체 직원 목록 */}
          {selectedCode && (
            <div style={{ marginTop: 20, background: "#0B1A2E", borderRadius: 12, overflow: "hidden" }}>
              <div style={{ padding: "12px 16px", borderBottom: "1px solid #1E3A5F", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontWeight: 700, color: "#00C2FF" }}>
                  {codes.find(c => c.id === selectedCode)?.partnerName} 직원 목록
                </span>
                <div style={{ display: "flex", gap: 10 }}>
                  <span style={{ fontSize: 12, color: "#00C48C" }}>재직 {passengers.filter(p => p.active).length}명</span>
                  <span style={{ fontSize: 12, color: "#FF8C42" }}>퇴사 {passengers.filter(p => !p.active).length}명</span>
                </div>
              </div>
              <div style={{ maxHeight: 300, overflowY: "auto" }}>
                <table style={S.table}>
                  <thead>
                    <tr>{["사번", "이름", "부서", "노선", "상태"].map(h => <th key={h} style={S.th}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {passengers.length === 0
                      ? <tr><td colSpan={5} style={{ ...S.td, textAlign: "center", color: "#4A6FA5" }}>등록된 직원이 없습니다</td></tr>
                      : passengers.map(p => (
                        <tr key={p.id} style={S.tr}>
                          <td style={{ ...S.td, fontFamily: "monospace", fontSize: 12 }}>{p.empNo}</td>
                          <td style={{ ...S.td, fontWeight: 600 }}>{p.name}</td>
                          <td style={{ ...S.td, color: "#8896AA", fontSize: 12 }}>{p.dept || "–"}</td>
                          <td style={{ ...S.td, color: "#8896AA", fontSize: 12 }}>{p.routeCode || "–"}</td>
                          <td style={S.td}>
                            <span style={{ ...S.statusBadge, background: p.active ? "#00C48C22" : "#FF4D6A22", color: p.active ? "#00C48C" : "#FF4D6A" }}>
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
          <div style={{ background: "rgba(255,209,102,.08)", border: "1px solid rgba(255,209,102,.2)", borderRadius: 8, padding: "10px 14px", fontSize: 12, color: "#FFD166" }}>
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
      setResult({ ok: true, msg: "공지가 발송되었습니다\n(인앱 배너 즉시 표시, FCM 푸시는 Cloud Function 배포 후 동작)" });
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
        <span style={{ fontSize:12, color:"#8896AA" }}>인앱 배너 + FCM 푸시</span>
      </div>

      <div style={{ padding:"16px 20px", display:"flex", flexDirection:"column", gap:12 }}>
        {/* 공지 유형 */}
        <div style={{ display:"flex", gap:8 }}>
          {[["normal","📋 일반 공지","#1A6BFF"],["emergency","🚨 긴급 공지","#FF4D6A"]].map(([v,label,color])=>(
            <button key={v} onClick={()=>setType(v)}
              style={{ flex:1, padding:"10px", borderRadius:10, border:"none", cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:700,
                background: type===v ? color+"33" : "#1E3A5F",
                color: type===v ? color : "#8896AA",
                outline: type===v ? `2px solid ${color}` : "none" }}>
              {label}
            </button>
          ))}
        </div>

        {/* 긴급 안내 */}
        {type === "emergency" && (
          <div style={{ background:"rgba(255,77,106,.08)", border:"1px solid rgba(255,77,106,.3)", borderRadius:8, padding:"10px 14px", fontSize:12, color:"#FF4D6A" }}>
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
          <div style={{ background: result.ok?"rgba(0,196,140,.1)":"rgba(255,77,106,.1)", border:`1px solid ${result.ok?"rgba(0,196,140,.3)":"rgba(255,77,106,.3)"}`, borderRadius:8, padding:"10px 14px", fontSize:13, color: result.ok?"#00C48C":"#FF4D6A", whiteSpace:"pre-line" }}>
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
            <div style={{ color:"#4A6FA5", fontSize:13, textAlign:"center", padding:"16px 0" }}>발송된 공지가 없습니다</div>
          ) : notices.slice(0,10).map(n => (
            <div key={n.id} style={{ background:"#0B1A2E", borderRadius:10, padding:"12px 14px", marginBottom:8, border:`1px solid ${n.type==="emergency"?"rgba(255,77,106,.3)":"#1E3A5F"}`, opacity: n.active?1:0.5 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:8 }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:4 }}>
                    <span style={{ fontSize:10, padding:"2px 8px", borderRadius:8, fontWeight:700,
                      background: n.type==="emergency"?"rgba(255,77,106,.2)":"rgba(26,107,255,.2)",
                      color: n.type==="emergency"?"#FF4D6A":"#3D8BFF" }}>
                      {n.type==="emergency"?"🚨 긴급":"📋 일반"}
                    </span>
                    {!n.active && <span style={{ fontSize:10, color:"#4A6FA5" }}>비활성</span>}
                    <span style={{ fontSize:11, color:"#4A6FA5", marginLeft:"auto" }}>{fmt(n.createdAt)}</span>
                  </div>
                  <div style={{ fontSize:13, fontWeight:700, marginBottom:2, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{n.title}</div>
                  <div style={{ fontSize:12, color:"#8896AA", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{n.body}</div>
                </div>
                {n.active && (
                  <button onClick={()=>handleDeactivate(n.id)}
                    style={{ background:"transparent", border:"1px solid #1E3A5F", borderRadius:6, padding:"4px 8px", color:"#8896AA", fontSize:11, cursor:"pointer", fontFamily:"inherit", flexShrink:0 }}>
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
const S = {
  wrap:{display:"flex",height:"100dvh",background:"#0B1A2E",fontFamily:"'Noto Sans KR',sans-serif",color:"#F0F4FF",position:"relative",overflow:"hidden",fontSize:13},
  sidebar:{width:220,background:"#112240",borderRight:"1px solid #1E3A5F",display:"flex",flexDirection:"column",padding:"20px 12px"},
  logo:{display:"flex",alignItems:"baseline",gap:8,marginBottom:24,paddingBottom:16,borderBottom:"1px solid #1E3A5F"},
  logoText:{fontSize:20,fontWeight:800,background:"linear-gradient(90deg,#1A6BFF,#00C2FF)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"},
  logoSub:{fontSize:12,color:"#8896AA"},
  nav:{display:"flex",flexDirection:"column",gap:4},
  navItem:{padding:"10px 12px",borderRadius:8,cursor:"pointer",fontSize:13,color:"#8896AA",transition:"all .15s"},
  navActive:{background:"#1A6BFF22",color:"#00C2FF",fontWeight:600},
  logoutBtn:{background:"transparent",border:"1px solid #1E3A5F",borderRadius:8,padding:"8px 12px",color:"#8896AA",fontSize:13,cursor:"pointer",fontFamily:"inherit"},
  content:{flex:1,display:"flex",flexDirection:"column",minHeight:0,overflow:"hidden"},
  mapSidebar:{width:"min(280px,38vw)",minWidth:180,background:"#112240",borderRight:"1px solid #1E3A5F",display:"flex",flexDirection:"column",overflowY:"auto"},
  panelHeader:{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8,padding:"12px 16px",borderBottom:"1px solid #1E3A5F",background:"#112240",flexShrink:0},
  vehicleCard:{margin:"8px 12px 0",background:"#0B1A2E",borderRadius:10,padding:"12px 14px",cursor:"pointer"},
  vehicleTop:{display:"flex",alignItems:"center",gap:8,marginBottom:6},
  dot:{width:8,height:8,borderRadius:"50%",background:"#00C48C",flexShrink:0,boxShadow:"0 0 6px #00C48C"},
  vehicleName:{fontSize:13,fontWeight:600},
  vehicleInfo:{fontSize:12,color:"#8896AA",marginTop:2},
  infoBox:{position:"absolute",top:20,right:20,background:"#112240",border:"1px solid #1E3A5F",borderRadius:12,padding:20,minWidth:220,zIndex:10},
  infoTitle:{fontSize:14,fontWeight:700,marginBottom:12,color:"#00C2FF"},
  infoRow:{fontSize:13,color:"#8896AA",marginBottom:6},
  closeBtn:{marginTop:8,width:"100%",padding:"8px",background:"rgba(255,255,255,.05)",border:"1px solid #1E3A5F",borderRadius:8,color:"#8896AA",cursor:"pointer",fontFamily:"inherit",fontSize:13},
  panel:{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"},
  empty:{color:"#4A6FA5",fontSize:13,textAlign:"center",padding:20},
  tableWrap:{flex:1,overflowY:"auto",overflowX:"auto",padding:"0 0 24px",WebkitOverflowScrolling:"touch"},
  table:{width:"100%",minWidth:520,borderCollapse:"collapse"},
  th:{textAlign:"left",padding:"10px 12px",fontSize:11,color:"#8896AA",fontWeight:600,borderBottom:"1px solid #1E3A5F",whiteSpace:"nowrap"},
  td:{padding:"10px 12px",fontSize:13,borderBottom:"1px solid #0B1A2E",whiteSpace:"nowrap"},
  tr:{background:"#112240"},
  timeBadge:{background:"#1A6BFF22",color:"#00C2FF",padding:"3px 10px",borderRadius:20,fontSize:13,fontWeight:600},
  statusBadge:{padding:"3px 10px",borderRadius:20,fontSize:12,fontWeight:600},
  addBtn:{background:"linear-gradient(90deg,#1A6BFF,#00C2FF)",border:"none",borderRadius:8,padding:"7px 12px",color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap",flexShrink:0},
  editBtn:{background:"#1E3A5F",border:"none",borderRadius:6,padding:"4px 8px",color:"#8896AA",fontSize:11,cursor:"pointer",marginRight:4,fontFamily:"inherit",whiteSpace:"nowrap"},
  delBtn:{background:"#FF4D6A22",border:"none",borderRadius:6,padding:"4px 8px",color:"#FF4D6A",fontSize:11,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap"},
  dateInput:{background:"#0B1A2E",border:"1px solid #1E3A5F",borderRadius:8,padding:"6px 12px",color:"#F0F4FF",fontSize:13,outline:"none",fontFamily:"inherit"},
  overlay:{position:"fixed",inset:0,background:"rgba(0,0,0,.6)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:100},
  modal:{background:"#112240",border:"1px solid #1E3A5F",borderRadius:16,padding:"20px 18px",width:"calc(100% - 32px)",maxWidth:420,display:"flex",flexDirection:"column",gap:8,maxHeight:"88dvh",overflowY:"auto",margin:"0 auto"},
  modalTitle:{fontSize:16,fontWeight:700,marginBottom:8,color:"#00C2FF"},
  label:{fontSize:12,color:"#8896AA",marginTop:4},
  input:{background:"#0B1A2E",border:"1px solid #1E3A5F",borderRadius:8,padding:"10px 14px",color:"#F0F4FF",fontSize:14,outline:"none",fontFamily:"inherit",width:"100%",boxSizing:"border-box"},
};
