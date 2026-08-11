import { useState, useEffect, useMemo, useRef } from "react";
import {
  validatePartnerCode, parseEmployeeExcel,
  importEmployees, downloadSampleExcel, reissuePins
} from "../lib/partner";
import { partnerRouteOptions, partnerOpsRoutes } from "../lib/partnerAccess";
import { seatUsage } from "../lib/routeOrder";
import QRCode from "qrcode";
import { buildAccountCardsHtml, buildPassengerLoginUrl, openPrintWindow } from "../lib/accountCards";
import { normalizeNfcUid, isValidNfcUid, formatNfcUid, isWebNfcSupported, createTagCooldown } from "../lib/nfc";
import { registerNfcCard } from "../lib/boarding";
import { db, auth } from "../firebase";
import { signInAnonymously } from "firebase/auth";
import { collection, getDocs, doc, setDoc, getDoc, updateDoc, deleteDoc, onSnapshot, query, where, orderBy, serverTimestamp, limit } from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import { BusLinkLogo, Pill } from "../components/ui";
import InstallPrompt from "../components/InstallPrompt";
import { applyAppManifest } from "../lib/pwaManifest";
import { aggregateBoardingsByStop } from "../lib/stopMapping";
// Phase 1.3 (2026-05-28): mainTab="ops" 운영 포털 — 실시간 버스 위치 지도.
// 카카오 SDK import — react-kakao-maps-sdk의 `Map`이 native `Map` 클래스를 shadow하므로
// 이 파일 내에서 `new Map()` 쓸 일 있으면 반드시 `new window.Map()`(issues.md `[패턴]`).
import { Map as KakaoMap, MapMarker, Polyline, CustomOverlayMap } from "react-kakao-maps-sdk";
import { useAnimatedPositions } from "../lib/useAnimatedPositions";
import { useWakeTick } from "../lib/useWakeTick";
import { useOnlineRecover } from "../lib/useOnlineRecover";
// 거래처 브랜딩(2026-07-16 회의 #5) — 메인 컬러 CSS 변수 덮어쓰기(포탈 진입 시 적용·이탈 시 복원).
import { applyPartnerBranding, clearPartnerBranding } from "../lib/partnerBranding";

const STEPS = { CODE:"code", MAIN:"main", DONE:"done", MANAGE:"manage" };
const REG_MODES = { FILE:"file", SINGLE:"single", MULTI:"multi", NFC:"nfc" };

// Phase 1.4 (2026-05-29) — 협력사 공지 발송 onCall(`sendPartnerNotice`) 호출용.
// region="us-central1" 명시(AdminApp 패턴 일관, functions/index.js 리전 고정).
const functions = getFunctions(undefined, "us-central1");

// ── 계정 안내문 인쇄(2026-07-27) ─────────────────────────
// credentials(평문 PIN 포함·발급 직후에만 존재)로 개인별 QR 을 만들어 A4 인쇄창을 연다.
// QR = 사번이 프리필된 승객앱 링크 → 배부받은 사람이 ID 를 타이핑할 필요가 없다.
// QR 생성이 실패해도(용량·환경) 카드 자체는 ID/PIN 으로 쓸 수 있게 계속 진행한다.
async function printAccountCards({ credentials, partnerName, routes }) {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const cards = [];
  for (const c of credentials) {
    const loginUrl = buildPassengerLoginUrl({ origin, empNo: c.empNo });
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
  useEffect(() => {
    signInAnonymously(auth).catch(e => console.warn("[PartnerApp] 익명 인증 실패:", e?.message));
  }, []);

  // 협력사앱 전용 PWA 아이콘/제목(2026-06) — 설치 시 'BusLink 협력사' + partner 아이콘.
  useEffect(() => {
    applyAppManifest({ manifestHref: "/manifest-partner.json", appleTouchHref: "/icons/passenger-1024.png", title: "BusLink 협력사" });
  }, []);

  const handleCodeSubmit = async () => {
    if (!code.trim()) return;
    setLoading(true); setError("");
    try {
      const data = await validatePartnerCode(code.trim());
      setCodeData(data);
      const snap = await getDocs(collection(db, "companies", data.companyId, "routes"));
      setRoutes(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      setStep(STEPS.MAIN);
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  const handleDone = (res) => { setResult(res); setStep(STEPS.DONE); };
  const reset = () => { setStep(STEPS.CODE); setCode(""); setCodeData(null); setResult(null); setError(""); setRegMode(REG_MODES.FILE); };

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
            <div style={S.notice}>업체코드가 없으시면 통근버스 운영사 담당자에게 문의하세요</div>
          </>
        )}

        {/* ─── STEP 2: 직원 등록 / 직원 관리 탭 ─── */}
        {step === STEPS.MAIN && codeData && (
          <>
            <div style={S.partnerInfo}>
              <div style={{ fontSize:11, color:"var(--color-label-mute)", fontWeight:600 }}>인증된 업체</div>
              <div style={{ fontSize:16, fontWeight:800, color:"var(--color-primary-deep)", fontFamily:"var(--font-brand)", letterSpacing:"-0.01em", marginTop:2 }}>{codeData.partnerName}</div>
              <div style={{ fontSize:11, color:"var(--color-label-alt)", marginTop:2 }}>{codeData.companyId} 소속</div>
            </div>

            {/* 메인 탭 선택 — 2026-05-28 Phase 1.3 운영 포털 탭 추가 (4번째) */}
            <div style={S.tabBar}>
              {[["register","📋 승객 등록"],["manage","👥 승객 관리"],["stats","📊 탑승 통계"],["ops","🚌 운영 포털"]].map(([t,label])=>(
                <button key={t} onClick={()=>setMainTab(t)}
                  style={{ ...S.tabBtn,
                    background: mainTab===t ? "var(--color-primary)" : "transparent",
                    color: mainTab===t ? "#fff" : "var(--color-label-mute)",
                    boxShadow: mainTab===t ? "0 2px 6px rgba(0,102,255,.25)" : "none" }}>
                  {label}
                </button>
              ))}
            </div>

            {/* ── 직원 등록 탭 ── */}
            {mainTab === "register" && (
              <>
                <div style={S.subTabBar}>
                  {[[REG_MODES.FILE,"📂 파일 업로드"],[REG_MODES.SINGLE,"👤 개별 등록"],[REG_MODES.MULTI,"👥 다중 등록"],[REG_MODES.NFC,"📇 카드 등록"]].map(([mode,label])=>(
                    <button key={mode} onClick={()=>setRegMode(mode)}
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

            {/* ── 직원 관리 탭 ── */}
            {mainTab === "manage" && (
              <EmployeeManageMode codeData={codeData} code={code} routes={routes} />
            )}

            {/* ── 탑승 통계 탭 ── */}
            {mainTab === "stats" && (
              <BoardingStatsMode codeData={codeData} code={code} routes={routes} />
            )}

            {/* ── 운영 포털 탭(Phase 1.3) ── */}
            {mainTab === "ops" && (
              <OperationsMode codeData={codeData} code={code} routes={routes} />
            )}
          </>
        )}

        {/* ─── 완료 ─── */}
        {step === STEPS.DONE && result && (
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:14 }}>
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
                  const ok = await printAccountCards({ credentials: result.credentials, partnerName: codeData?.partnerName, routes });
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
            <button style={S.btnSecondary} onClick={reset}>추가 등록하기</button>
          </div>
        )}
      </div>
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
    setLoading(true);
    try {
      const res = await importEmployees({ companyId:codeData.companyId, partnerCode:code, partnerName:codeData.partnerName, employees:parsed.employees, routes });
      onDone(res);
    } catch(e) { setError(e.message); }
    setLoading(false);
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
      {!previewing ? (
        <>
          <button onClick={downloadSampleExcel} style={S.btnSecondary}>📥 엑셀 양식 다운로드</button>
          <div style={S.excelGuide}>
            <div style={{ fontWeight:700, marginBottom:10, color:"#B95300", fontSize:13 }}>📋 양식 작성 안내</div>
            {[["사번","필수 · 숫자 또는 문자"],["이름","필수"],["부서","선택 · 통계 사용"],["노선코드","선택 · 예) 662"],["재직여부","Y / N"],["NFC카드번호","선택 · 비우면 기존 등록 유지"],["초기PIN","선택 · 비우면 자동 발급(권장)"]].map(([k,v])=>(
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
              {loading?"등록 중...":`✅ ${parsed.total}명 등록하기`}
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
function EmployeeManageMode({ codeData, code, routes }) {
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterActive, setFilterActive] = useState("전체"); // 전체|재직|퇴사
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
    const res = await reissuePins({ companyId: codeData.companyId, passengers: [{ empNo: emp.id, name: emp.name, dept: emp.dept, routeCode: emp.routeCode }] });
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
    const res = await reissuePins({ companyId: codeData.companyId, passengers: targets.map(e => ({ empNo: e.id, name: e.name, dept: e.dept, routeCode: e.routeCode })) });
    setPinBusy(false);
    setPinResult(res);
  };

  const handlePrintPinResult = async () => {
    const ok = await printAccountCards({ credentials: pinResult.credentials, partnerName: codeData?.partnerName, routes });
    if (!ok) alert("팝업이 차단되었습니다. 브라우저 팝업 차단을 해제한 뒤 다시 시도하세요.");
  };

  // 정원 대비 등록 인원(2026-07-30) — 노선 좌석수 대비 몇 명 배정됐는지. 이미 갖고 있는
  // 승객 목록·노선으로 집계하므로 신규 조회 0. 이 거래처 노선만 보여준다.
  const seat = seatUsage(partnerRouteOptions(routes, code), employees.map(e => ({ routeId: e.routeId || e.routeCode, active: e.active })));
  const seatRows = Object.entries(seat)
    .map(([rid, u]) => ({ rid, ...u, name: (routes.find(r => r.id === rid) || {}).name || rid }))
    .filter(u => u.registered > 0 || u.seats)
    .sort((a, b) => (b.over ? 1 : 0) - (a.over ? 1 : 0) || b.registered - a.registered);

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
      {/* 노선별 정원 — 초과면 먼저 보이게 정렬 */}
      {seatRows.length > 0 && (
        <div style={{ border:"1px solid var(--color-line)", borderRadius:10, padding:"10px 12px", background:"var(--color-bg-soft)" }}>
          <div style={{ fontSize:12, fontWeight:800, color:"var(--color-label)", marginBottom:6 }}>노선별 인원 / 좌석</div>
          <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
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
      )}

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

      {/* 집계 — "미접속"(2026-07-27)은 계정을 아직 못 받았거나 안내문이 도달하지 않은 인원. */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:8 }}>
        {[
          ["전체",employees.length,"var(--color-primary)"],
          ["재직",employees.filter(e=>e.active).length,"var(--color-positive)"],
          ["퇴사",employees.filter(e=>!e.active).length,"var(--color-destructive)"],
          ["미시작",employees.filter(e=>e.active && isUnstarted(e)).length,"var(--color-cautionary)"],
        ].map(([l,v,c])=>(
          <div key={l} style={S.statCard}>
            <div style={{ fontSize:20, fontWeight:800, color:c, fontFamily:"var(--font-brand)" }}>{v}</div>
            <div style={{ fontSize:11, color:"var(--color-label-mute)", fontWeight:600 }}>{l}</div>
          </div>
        ))}
      </div>

      {/* 계정 배부 도우미 — 아직 한 번도 접속하지 않은 인원만 골라 재발급+인쇄. */}
      <button style={{ ...S.btnSecondary, opacity: pinBusy ? 0.6 : 1 }} onClick={handleReissueUnvisited} disabled={pinBusy}>
        {pinBusy ? "발급 중..." : "📄 미시작 승객 계정 안내문 만들기"}
      </button>

      {/* 직원 목록 */}
      {loading ? (
        <div style={{ textAlign:"center", padding:20, color:"var(--color-label-mute)", fontSize:13 }}>로딩 중...</div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign:"center", padding:24, color:"var(--color-label-alt)", fontSize:13, background:"var(--color-bg-soft)", borderRadius:10 }}>
          {search ? "검색 결과가 없습니다" : "등록된 승객이 없습니다"}
        </div>
      ) : (
        <div style={{ display:"flex", flexDirection:"column", gap:8, maxHeight:360, overflowY:"auto" }}>
          {filtered.map(emp => (
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
                    {/* "미시작" 이 곧 "발급 비밀번호 그대로" 라 옛 PIN미변경 배지와 뜻이 겹친다 → 하나로 통합. */}
                    {emp.active && isUnstarted(emp) && <Pill tone="warn">미시작</Pill>}
                    {emp.pinLocked && <Pill tone="primary">🔒 PIN잠금</Pill>}
                    {emp.nfcUid && <Pill tone="positive">📇 NFC</Pill>}
                  </div>
                  <div style={{ fontSize:12, color:"var(--color-label-mute)" }}>
                    {emp.dept || "부서없음"} · {emp.routeCode || "노선없음"}
                    {emp.nfcUid && <> · <span style={{ fontFamily:"monospace" }}>{formatNfcUid(emp.nfcUid)}</span></>}
                  </div>
                </div>
                <div style={{ display:"flex", gap:4, flexShrink:0, flexWrap:"wrap", justifyContent:"flex-end" }}>
                  <button onClick={()=>openEdit(emp)} style={S.smallBtn}>수정</button>
                  <button onClick={()=>handleResetPin(emp)} style={S.smallBtnWarn} disabled={pinBusy}>비밀번호 재발급</button>
                  {/* 삭제 — 되돌릴 수 없으므로 한 단계 확인을 거친다(2026-07-30 요청:
                      테스트·오류 계정 정리용). 퇴사 처리(재직 토글)와는 다른 동작임을
                      문구로 구분해 실수로 지우지 않게 한다. */}
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
              </div>
            </div>
          ))}
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
              {pinResult.credentials.map(c => (
                <div key={c.empNo} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8, padding:"9px 12px", borderBottom:"1px solid var(--color-line-soft)" }}>
                  <div style={{ minWidth:0 }}>
                    <div style={{ fontSize:13, fontWeight:700, color:"var(--color-label)" }}>{c.name}</div>
                    <div style={{ fontSize:11, color:"var(--color-label-mute)", fontFamily:"monospace" }}>{c.empNo}</div>
                  </div>
                  <div style={{ fontSize:16, fontWeight:800, color:"var(--color-primary)", fontFamily:"monospace", letterSpacing:1 }}>{c.pin}</div>
                </div>
              ))}
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
};

// ════════════════════════════════════════════════════════
// 탑승 통계 모드 (일자별 누적, 2026-05-26)
// ════════════════════════════════════════════════════════
// companyId/boardings/{date}/list 컬렉션을 from~to 범위로 일자별 로딩 → partnerCode 일치 또는
// 자기 협력사 직원 empNo 매칭(legacy 데이터 호환). 누적 표시: 일자별/직원별/노선별.
function BoardingStatsMode({ codeData, code, routes }) {
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

      {/* 일자별 막대 */}
      {byDate.length > 0 && (
        <div style={{ background: "var(--color-bg)", border: "1px solid var(--color-line)", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--color-line-soft)", fontSize: 12, fontWeight: 700, color: "var(--color-label)" }}>
            📅 일자별 탑승 추이
          </div>
          <div style={{ padding: "10px 14px", maxHeight: 220, overflowY: "auto" }}>
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
          <div style={{ maxHeight: 280, overflowY: "auto" }}>
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
        return (
          <div style={{ background: "var(--color-bg)", border: "1px solid var(--color-line)", borderRadius: 10, overflow: "hidden" }}>
            <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--color-line-soft)", fontSize: 12, fontWeight: 700, color: "var(--color-label)" }}>
              📍 정류장별 탑승 <span style={{ fontSize: 10, fontWeight: 600, color: "var(--color-label-mute)", marginLeft: 4 }}>(GPS·반경 300m)</span>
            </div>
            {mapped.length === 0 ? (
              <div style={{ padding: 20, fontSize: 12, color: "var(--color-label-alt)", textAlign: "center" }}>
                매핑된 정류장 없음
              </div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ background: "var(--color-bg-alt)" }}>
                    {["노선", "정류장", "탑승", "거리"].map(h => (
                      <th key={h} style={{ padding: "6px 10px", textAlign: h === "탑승" || h === "거리" ? "right" : "left", color: "var(--color-label-mute)", fontWeight: 700, fontSize: 11 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {mapped.map((m, i) => (
                    <tr key={i} style={{ borderTop: "1px solid var(--color-line-soft)" }}>
                      <td style={{ padding: "6px 10px", color: "var(--color-label-mute)" }}>{m.routeName}</td>
                      <td style={{ padding: "6px 10px", fontWeight: 700 }}>{m.stopName}</td>
                      <td style={{ padding: "6px 10px", fontWeight: 800, color: "var(--color-primary)", textAlign: "right" }}>{m.count}</td>
                      <td style={{ padding: "6px 10px", fontSize: 10, color: "var(--color-label-mute)", textAlign: "right", fontFamily: "var(--font-mono)" }}>
                        {m.minDist != null ? `${Math.round(m.minDist)}m` : "–"}
                      </td>
                    </tr>
                  ))}
                </tbody>
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
function OperationsMode({ codeData, code, routes }) {
  const companyId = codeData?.companyId;
  const wakeTick = useWakeTick();
  const recoverTick = useOnlineRecover({ forceFirestoreReconnect: true });
  const todayStr = useMemo(
    () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date()),
    []
  );

  // ── 자사 직원 ↦ routeId 분포 ─────────────────────────
  const [passengers, setPassengers] = useState([]); // [{empNo,name,routeId,...}]
  const [passengersLoading, setPassengersLoading] = useState(true);
  useEffect(() => {
    if (!companyId || !code) return;
    setPassengersLoading(true);
    const q = query(
      collection(db, "companies", companyId, "passengers"),
      where("partnerCode", "==", code),
      where("active", "==", true)
    );
    getDocs(q).then(snap => {
      setPassengers(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      setPassengersLoading(false);
    }).catch(e => {
      console.warn("[OperationsMode] passengers 조회 오류:", e?.message);
      setPassengers([]); setPassengersLoading(false);
    });
  }, [companyId, code]);

  // 자사 routeId 집합 + 노선별 승객 수 — 정본 = partnerAccess.partnerOpsRoutes
  // 🔴 기준축은 **거래처에 지정된 노선**(routes.partnerCode)이고 승객 배정 노선은 합집합.
  //    승객 배정만으로 모으면 하교·요일별·방과후처럼 아무도 기준노선으로 잡지 않는 노선이
  //    통째로 빠진다(2026-08-11 실측: 채드윅 29개 중 8개만 표시). 되돌리지 말 것.
  const { myRouteIds, byRouteCount, unassignedCount } = useMemo(() => {
    const r = partnerOpsRoutes(routes, code, passengers);
    return { myRouteIds: r.ids, byRouteCount: r.byRouteCount, unassignedCount: r.unassignedCount };
  }, [passengers, routes, code]);

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
    list.sort((a, b) => (a.departTime || "").localeCompare(b.departTime || ""));
    return list;
  }, [routes, myRouteIds, byRouteCount]);

  // 노선 필터(노선 카드 클릭 시 토글). null=전체.
  const [routeFilter, setRouteFilter] = useState(null);

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

  // ── 오늘 dispatches(routeId in myRouteIds) ─────────────
  const [todayDispatches, setTodayDispatches] = useState([]); // [{id, routeId, vehicleId, vehicleNo, driverName, ...}]
  useEffect(() => {
    if (!companyId) return;
    return onSnapshot(
      collection(db, "companies", companyId, "dispatches", todayStr, "list"),
      snap => {
        const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        // 우리 routeId만
        setTodayDispatches(list.filter(d => myRouteIds.has(d.routeId)));
      },
      err => {
        console.warn("[OperationsMode] dispatches 구독 오류:", err.message);
        setTodayDispatches([]);
      }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, todayStr, myRouteIds, wakeTick, recoverTick]);

  // 우리 노선의 vehicleId 집합
  const myVehicleIds = useMemo(() => {
    const s = new window.Set();
    todayDispatches.forEach(d => { if (d.vehicleId) s.add(d.vehicleId); });
    return s;
  }, [todayDispatches]);

  // ── GPS 구독 — 우리 회사 + 우리 vehicleId 한정 ────────
  // gps 컬렉션은 top-level, doc id = `{companyId}_{vehicleId}`.
  // companyId 동등 필터 1개로 자사 차량만 받고 vehicleId in 필터는 클라이언트(노선 dispatch와 정합).
  const [rawBuses, setRawBuses] = useState([]);
  useEffect(() => {
    if (!companyId) return;
    return onSnapshot(
      query(collection(db, "gps"), where("companyId", "==", companyId)),
      snap => {
        const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        // 우리 vehicleId만(노선 dispatch에 묶인 차량만 표시)
        setRawBuses(list.filter(b => myVehicleIds.has(b.vehicleId)));
      },
      err => {
        console.warn("[OperationsMode] gps 구독 오류:", err.message);
        setRawBuses([]);
      }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, myVehicleIds, wakeTick, recoverTick]);
  const buses = useAnimatedPositions(rawBuses);

  // 노선 필터 적용된 dispatches/buses
  const filteredDispatches = useMemo(() => (
    routeFilter ? todayDispatches.filter(d => d.routeId === routeFilter) : todayDispatches
  ), [todayDispatches, routeFilter]);
  const filteredVehicleIds = useMemo(() => {
    const s = new window.Set();
    filteredDispatches.forEach(d => { if (d.vehicleId) s.add(d.vehicleId); });
    return s;
  }, [filteredDispatches]);
  const filteredBuses = useMemo(() => (
    buses.filter(b => filteredVehicleIds.has(b.vehicleId))
  ), [buses, filteredVehicleIds]);

  // 지도 중심 — 첫 버스/첫 정류장/한국 기본
  const mapCenter = useMemo(() => {
    if (filteredBuses[0] && filteredBuses[0].lat && filteredBuses[0].lng) {
      return { lat: filteredBuses[0].lat, lng: filteredBuses[0].lng };
    }
    for (const r of myRoutesList) {
      if (routeFilter && r.id !== routeFilter) continue;
      const ss = stopsByRoute[r.id];
      if (ss && ss.length > 0) return { lat: ss[0].lat, lng: ss[0].lng };
    }
    return { lat: 37.3894, lng: 126.9522 };
  }, [filteredBuses, myRoutesList, stopsByRoute, routeFilter]);

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
  const totalEmployees = passengers.length;
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
    myRoutesList.forEach(r => {
      if (routeFilter && r.id !== routeFilter) return;
      let path = r.routePath;
      if (!path || path.length < 2) {
        const ss = stopsByRoute[r.id];
        if (ss && ss.length >= 2) path = ss.map(s => ({ lat: s.lat, lng: s.lng }));
      }
      if (path && path.length >= 2) out.push({ routeId: r.id, path });
    });
    return out;
  }, [myRoutesList, stopsByRoute, routeFilter]);

  // dispatchById — 버스 마커 라벨용
  const dispatchByVehicleId = useMemo(() => {
    const m = new window.Map();
    filteredDispatches.forEach(d => { if (d.vehicleId) m.set(d.vehicleId, d); });
    return m;
  }, [filteredDispatches]);

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
    return myRoutesList
      .filter(r => !routeFilter || r.id === routeFilter)
      .map(r => {
        const stops = (stopsByRoute[r.id] || []).map(s => ({ id: s.id, name: s.name || "", ll: toLL(s) }));
        // 이 노선 배차들의 실측 도착(stopArrivals) 합집합 = 통과 정류장
        const passed = new window.Set();
        filteredDispatches.filter(d => d.routeId === r.id).forEach(d => {
          Object.keys(d.stopArrivals || {}).forEach(sid => passed.add(sid));
        });
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
  }, [myRoutesList, routeFilter, stopsByRoute, filteredDispatches, filteredBuses]);

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
          {routeFilter && (
            <button onClick={() => setRouteFilter(null)} style={{
              fontSize: 10, padding: "2px 8px", borderRadius: 999, border: "1px solid var(--color-line)",
              background: "var(--color-bg-soft)", color: "var(--color-label-mute)", cursor: "pointer", fontFamily: "inherit"
            }}>전체 보기</button>
          )}
        </div>
        {passengersLoading ? (
          <div style={{ padding: 20, textAlign: "center", color: "var(--color-label-mute)", fontSize: 12 }}>로딩 중...</div>
        ) : myRoutesList.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--color-label-mute)", fontSize: 13 }}>
            표시할 노선이 없습니다
            <div style={{ fontSize: 11, color: "var(--color-label-alt)", marginTop: 4 }}>
              노선이 등록되면 여기에 표시됩니다
            </div>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8, padding: 12 }}>
            {myRoutesList.map(r => {
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
            {filteredBuses.length > 0 ? `${filteredBuses.length}대 운행 중` : (todayDispatches.length === 0 ? "오늘 배차 없음" : "운행 대기")}
          </span>
        </div>
        {myRoutesList.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--color-label-mute)", fontSize: 13 }}>
            표시할 노선이 없습니다
          </div>
        ) : (
          <div style={{ height: "40vh", minHeight: 280, position: "relative" }}>
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
              {/* 버스 마커 */}
              {filteredBuses.map(b => b.lat && b.lng && (
                <CustomOverlayMap key={b.id} position={{ lat: b.lat, lng: b.lng }} yAnchor={1.5}>
                  <div style={{ position: "relative", display: "inline-block" }}>
                    <span style={{
                      position: "absolute", inset: -2, borderRadius: 999,
                      background: "var(--color-primary)", opacity: 0.4,
                      animation: "buspulse 2s ease-out infinite", pointerEvents: "none"
                    }} />
                    <div style={{
                      position: "relative", background: "#fff",
                      border: "2px solid var(--color-primary)", borderRadius: 999,
                      padding: "5px 10px", display: "flex", alignItems: "center", gap: 6,
                      boxShadow: "0 4px 12px rgba(0,102,255,0.3)",
                    }}>
                      <span style={{ fontSize: 16 }}>🚌</span>
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 800, color: "var(--color-label)" }}>
                          {b.vehicleNo || (dispatchByVehicleId.get(b.vehicleId)?.vehicleNo) || b.vehicleId || "차량"}
                        </div>
                        <div style={{ fontSize: 9, fontWeight: 600, color: "var(--color-label-mute)" }}>
                          {Math.round(b.speed || 0)} km/h
                        </div>
                      </div>
                    </div>
                  </div>
                </CustomOverlayMap>
              ))}
            </KakaoMap>
            {filteredBuses.length === 0 && todayDispatches.length > 0 && (
              <div style={{
                position: "absolute", top: 8, left: 8, right: 8,
                background: "rgba(255,255,255,0.95)", border: "1px solid var(--color-line)",
                borderRadius: 8, padding: "6px 10px", fontSize: 11, fontWeight: 600,
                color: "var(--color-label-mute)", textAlign: "center", pointerEvents: "none"
              }}>
                ⓘ 배차 {todayDispatches.length}건 — GPS 신호 대기 중
              </div>
            )}
          </div>
        )}
      </div>
      )}

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
  );
}
