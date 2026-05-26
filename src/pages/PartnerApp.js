import { useState, useEffect } from "react";
import {
  validatePartnerCode, parseEmployeeExcel,
  importEmployees, downloadSampleExcel, hashPin
} from "../lib/partner";
import { db, auth } from "../firebase";
import { signInAnonymously } from "firebase/auth";
import { collection, getDocs, doc, setDoc, getDoc, updateDoc, deleteDoc, onSnapshot, query, where, orderBy, serverTimestamp } from "firebase/firestore";
import { BusLinkLogo, Pill } from "../components/ui";
import { aggregateBoardingsByStop } from "../lib/stopMapping";

const STEPS = { CODE:"code", MAIN:"main", DONE:"done", MANAGE:"manage" };
const REG_MODES = { FILE:"file", SINGLE:"single", MULTI:"multi" };

export default function PartnerApp() {
  const [step, setStep] = useState(STEPS.CODE);
  const [code, setCode] = useState("");
  const [codeData, setCodeData] = useState(null);
  const [routes, setRoutes] = useState([]);
  const [regMode, setRegMode] = useState(REG_MODES.FILE);
  const [mainTab, setMainTab] = useState("register"); // "register" | "manage"
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
      <div style={{ ...S.card, maxWidth: regMode === REG_MODES.MULTI && step === STEPS.MAIN ? 720 : 480 }}>
        {/* 헤더 */}
        <div style={S.header}>
          <BusLinkLogo size={26} sub="협력사 포털" />
        </div>

        {/* Step 진행 표시 */}
        {step !== STEPS.DONE && (
          <div style={S.stepRow}>
            {[["업체코드 인증", STEPS.CODE], ["직원 등록", STEPS.MAIN]].map(([label, s], i) => {
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

            {/* 메인 탭 선택 */}
            <div style={S.tabBar}>
              {[["register","📋 직원 등록"],["manage","👥 직원 관리"],["stats","📊 탑승 통계"]].map(([t,label])=>(
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
                  {[[REG_MODES.FILE,"📂 파일 업로드"],[REG_MODES.SINGLE,"👤 개별 등록"],[REG_MODES.MULTI,"👥 다중 등록"]].map(([mode,label])=>(
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
            <div style={{ fontSize:12, color:"var(--color-label-mute)", textAlign:"center", lineHeight:1.5 }}>
              신규 등록 직원의 초기 PIN은 <span style={{ color:"var(--color-cautionary)", fontWeight:800, background:"#FFF1E0", padding:"2px 8px", borderRadius:6 }}>000000</span>입니다
            </div>
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
            {[["사번","필수 · 숫자 또는 문자"],["이름","필수"],["부서","선택 · 통계 사용"],["노선코드","선택 · 예) 662"],["재직여부","Y / N"]].map(([k,v])=>(
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
              <div style={{ fontSize:12, color:"var(--color-destructive)", fontWeight:700, marginBottom:4 }}>⚠️ 오류 {parsed.errors.length}건 스킵</div>
              {parsed.errors.slice(0,3).map((e,i)=><div key={i} style={{ fontSize:11, color:"#A81818" }}>{e}</div>)}
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
  const empty = { empNo:"", name:"", dept:"", routeCode:"", active:true };
  const [form, setForm] = useState(empty);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSave = async () => {
    if (!form.empNo.trim()) return setError("사번은 필수입니다");
    if (!form.name.trim()) return setError("이름은 필수입니다");
    setLoading(true); setError("");
    try {
      const res = await importEmployees({
        companyId: codeData.companyId, partnerCode: code, partnerName: codeData.partnerName,
        employees: [{ ...form, empNo: form.empNo.trim(), name: form.name.trim(), dept: form.dept.trim(), active: form.active }],
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
            {routes.map(r=><option key={r.id} value={r.code||r.id}>{r.name} ({r.code||r.id})</option>)}
          </select>
        </div>
      </div>
      <label style={S.checkBox}>
        <input type="checkbox" checked={form.active} onChange={e=>setForm({...form,active:e.target.checked})}
          style={{ accentColor:"var(--color-primary)", width:16, height:16, cursor:"pointer" }} />
        <span style={{ fontSize:13, color:"var(--color-label)", fontWeight:500 }}>재직 중 (체크 해제 시 비활성화)</span>
      </label>
      {error && <div style={S.errorMsg}>{error}</div>}
      <div style={{ display:"flex", gap:8 }}>
        <button style={{ ...S.btn, opacity:loading?0.6:1 }} onClick={handleSave} disabled={loading}>
          {loading?"등록 중...":"✅ 등록하기"}
        </button>
        <button style={{ ...S.btnSecondary, flex:"0 0 80px" }} onClick={()=>setForm(empty)}>초기화</button>
      </div>
      <div style={{ fontSize:11, color:"var(--color-label-alt)", textAlign:"center" }}>초기 PIN은 000000으로 설정됩니다</div>
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
              {routes.map(r=><option key={r.id} value={r.code||r.id}>{r.code||r.name.substring(0,8)}</option>)}
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
      <div style={{ fontSize:11, color:"var(--color-label-alt)", textAlign:"center" }}>사번·이름이 비어있는 행은 자동 제외됩니다 · 초기 PIN: 000000</div>
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
  const [msg, setMsg] = useState(null);

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

  const openEdit = (emp) => {
    setEditEmp(emp);
    setEditForm({ name: emp.name||"", dept: emp.dept||"", routeCode: emp.routeCode||"", active: emp.active });
    setMsg(null);
  };

  const handleSave = async () => {
    setSaving(true); setMsg(null);
    try {
      const routeId = routes.find(r => r.code === editForm.routeCode || r.id === editForm.routeCode)?.id || editForm.routeCode;
      await updateDoc(
        doc(db, "companies", codeData.companyId, "passengers", editEmp.id),
        { name: editForm.name.trim(), dept: editForm.dept.trim(), routeCode: editForm.routeCode, routeId, active: editForm.active, updatedAt: serverTimestamp() }
      );
      setMsg({ type: "success", text: "저장되었습니다" });
      setTimeout(() => { setEditEmp(null); setMsg(null); }, 800);
    } catch(e) {
      setMsg({ type: "error", text: "저장 실패: " + e.message });
    }
    setSaving(false);
  };

  const handleResetPin = async (emp) => {
    if (!window.confirm(`${emp.name}(${emp.empNo})의 PIN을 000000으로 초기화하시겠습니까?`)) return;
    const { hashPin } = await import("../lib/partner");
    const newHash = await hashPin("000000");
    await updateDoc(doc(db, "companies", codeData.companyId, "passengers", emp.id), {
      pinHash: newHash, pinInitial: true, updatedAt: serverTimestamp()
    });
    alert("PIN이 초기화되었습니다. (초기 PIN: 000000)");
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
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

      {/* 집계 */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
        {[["전체",employees.length,"var(--color-primary)"],["재직",employees.filter(e=>e.active).length,"var(--color-positive)"],["퇴사",employees.filter(e=>!e.active).length,"var(--color-destructive)"]].map(([l,v,c])=>(
          <div key={l} style={S.statCard}>
            <div style={{ fontSize:20, fontWeight:800, color:c, fontFamily:"var(--font-brand)" }}>{v}</div>
            <div style={{ fontSize:11, color:"var(--color-label-mute)", fontWeight:600 }}>{l}</div>
          </div>
        ))}
      </div>

      {/* 직원 목록 */}
      {loading ? (
        <div style={{ textAlign:"center", padding:20, color:"var(--color-label-mute)", fontSize:13 }}>로딩 중...</div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign:"center", padding:24, color:"var(--color-label-alt)", fontSize:13, background:"var(--color-bg-soft)", borderRadius:10 }}>
          {search ? "검색 결과가 없습니다" : "등록된 직원이 없습니다"}
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
                    {emp.pinInitial && <Pill tone="warn">PIN미변경</Pill>}
                  </div>
                  <div style={{ fontSize:12, color:"var(--color-label-mute)" }}>
                    {emp.dept || "부서없음"} · {emp.routeCode || "노선없음"}
                  </div>
                </div>
                <div style={{ display:"flex", gap:4, flexShrink:0 }}>
                  <button onClick={()=>openEdit(emp)} style={S.smallBtn}>수정</button>
                  <button onClick={()=>handleResetPin(emp)} style={S.smallBtnWarn}>PIN초기화</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 수정 모달 */}
      {editEmp && (
        <div style={S.overlay}>
          <div style={S.modal}>
            <div style={S.modalTitle}>직원 정보 수정</div>
            <div style={{ fontSize:12, color:"var(--color-label-mute)" }}>{editEmp.empNo} · {editEmp.name}</div>

            <label style={S.label}>이름 *</label>
            <input style={S.input} value={editForm.name} onChange={e=>setEditForm({...editForm,name:e.target.value})} />

            <label style={S.label}>부서</label>
            <input style={S.input} placeholder="예) 개발팀" value={editForm.dept} onChange={e=>setEditForm({...editForm,dept:e.target.value})} />

            <label style={S.label}>노선</label>
            <select style={S.input} value={editForm.routeCode} onChange={e=>setEditForm({...editForm,routeCode:e.target.value})}>
              <option value="">노선 선택</option>
              {routes.map(r=><option key={r.id} value={r.code||r.id}>{r.name} ({r.code||r.id})</option>)}
            </select>

            <label style={S.checkBox}>
              <input type="checkbox" checked={editForm.active} onChange={e=>setEditForm({...editForm,active:e.target.checked})}
                style={{ accentColor:"var(--color-primary)", width:16, height:16, cursor:"pointer" }} />
              <span style={{ fontSize:13, color:"var(--color-label)", fontWeight:500 }}>재직 중 (체크 해제 시 퇴사 처리)</span>
            </label>

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
          <div style={{ fontSize: 11, color: "var(--color-label-mute)", fontWeight: 600, marginTop: 2 }}>고유 직원</div>
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
            👤 직원별 탑승 ({byEmployee.length}명)
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
            QR로 탑승한 직원이 있으면 여기에 누적됩니다.
          </div>
        </div>
      )}
    </div>
  );
}
