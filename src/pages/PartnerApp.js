import { useState, useEffect } from "react";
import {
  validatePartnerCode, parseEmployeeExcel,
  importEmployees, downloadSampleExcel, hashPin
} from "../lib/partner";
import { db } from "../firebase";
import { collection, getDocs, doc, setDoc, getDoc, updateDoc, deleteDoc, onSnapshot, query, where, serverTimestamp } from "firebase/firestore";

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
      <div style={{ ...S.card, maxWidth: regMode === REG_MODES.MULTI && step === STEPS.MAIN ? 640 : 480 }}>
        {/* 헤더 */}
        <div style={S.header}>
          <div style={S.logo}>BL</div>
          <div>
            <div style={S.logoText}>BusLink</div>
            <div style={S.logoSub}>협력사 직원 등록 포털</div>
          </div>
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
                    <div style={{ width:28, height:28, borderRadius:"50%", display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:700,
                      background: done?"#00C48C": active?"linear-gradient(135deg,#1A6BFF,#00C2FF)":"#1E3A5F",
                      color: done||active?"#fff":"#8896AA" }}>
                      {done?"✓":i+1}
                    </div>
                    <div style={{ fontSize:10, color: active?"#00C2FF":done?"#00C48C":"#8896AA", whiteSpace:"nowrap" }}>{label}</div>
                  </div>
                  {i < 1 && <div style={{ flex:1, height:1, background: done?"#00C48C":"#1E3A5F", marginBottom:16 }}/>}
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
            <div style={{ background:"#0B1A2E", borderRadius:10, padding:"10px 14px" }}>
              <div style={{ fontSize:11, color:"#8896AA" }}>인증된 업체</div>
              <div style={{ fontSize:15, fontWeight:700, color:"#00C2FF" }}>{codeData.partnerName}</div>
              <div style={{ fontSize:11, color:"#8896AA", marginTop:2 }}>{codeData.companyId} 소속</div>
            </div>

            {/* 메인 탭 선택 */}
            <div style={{ display:"flex", gap:6, background:"#0B1A2E", padding:4, borderRadius:10 }}>
              {[["register","📋 직원 등록"],["manage","👥 직원 관리"]].map(([t,label])=>(
                <button key={t} onClick={()=>setMainTab(t)}
                  style={{ flex:1, padding:"9px", borderRadius:8, border:"none", cursor:"pointer", fontFamily:"inherit", fontSize:13, fontWeight:700,
                    background: mainTab===t?"linear-gradient(135deg,#1A6BFF,#00C2FF)":"transparent",
                    color: mainTab===t?"#fff":"#8896AA" }}>
                  {label}
                </button>
              ))}
            </div>

            {/* ── 직원 등록 탭 ── */}
            {mainTab === "register" && (
              <>
                <div style={{ display:"flex", gap:6, background:"#0B1A2E", padding:4, borderRadius:10 }}>
                  {[[REG_MODES.FILE,"📂 파일 업로드"],[REG_MODES.SINGLE,"👤 개별 등록"],[REG_MODES.MULTI,"👥 다중 등록"]].map(([mode,label])=>(
                    <button key={mode} onClick={()=>setRegMode(mode)}
                      style={{ flex:1, padding:"7px 4px", borderRadius:8, border:"none", cursor:"pointer", fontFamily:"inherit", fontSize:11, fontWeight:600,
                        background: regMode===mode?"rgba(26,107,255,.4)":"transparent", color: regMode===mode?"#fff":"#8896AA" }}>
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
          </>
        )}

        {/* ─── 완료 ─── */}
        {step === STEPS.DONE && result && (
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:12 }}>
            <div style={{ width:72, height:72, borderRadius:"50%", background:"rgba(0,196,140,.15)", border:"2px solid #00C48C", display:"flex", alignItems:"center", justifyContent:"center", fontSize:32, color:"#00C48C", fontWeight:700 }}>✓</div>
            <div style={{ fontSize:20, fontWeight:800, color:"#00C48C" }}>등록 완료!</div>
            <div style={{ background:"#0B1A2E", borderRadius:12, padding:"16px 20px", width:"100%" }}>
              {[
                ["신규 등록", result.added, "#00C2FF"],
                ["정보 업데이트", result.updated, "#FFD166"],
                ["비활성화 (퇴사)", result.deactivated, "#FF8C42"],
              ].map(([label, val, color]) => (
                <div key={label} style={{ display:"flex", justifyContent:"space-between", padding:"7px 0", borderBottom:"1px solid #1E3A5F" }}>
                  <span style={{ fontSize:13, color:"#8896AA" }}>{label}</span>
                  <span style={{ fontSize:14, fontWeight:700, color }}>{val}명</span>
                </div>
              ))}
              {result.errors?.length > 0 && (
                <div style={{ marginTop:8, fontSize:11, color:"#FF4D6A" }}>오류 {result.errors.length}건 스킵됨</div>
              )}
            </div>
            <div style={{ fontSize:12, color:"#8896AA", textAlign:"center" }}>
              신규 등록 직원의 초기 PIN은 <span style={{ color:"#FFD166", fontWeight:700 }}>000000</span>입니다
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
            <div style={{ fontWeight:700, marginBottom:8, color:"#FFD166" }}>📋 양식 작성 안내</div>
            {[["사번","필수 · 숫자 또는 문자"],["이름","필수"],["부서","선택 · 통계 사용"],["노선코드","선택 · 예) 662"],["재직여부","Y / N"]].map(([k,v])=>(
              <div key={k} style={{ display:"flex", gap:8, fontSize:12, marginBottom:4 }}>
                <span style={{ color:"#00C2FF", fontWeight:600, minWidth:60 }}>{k}</span>
                <span style={{ color:"#8896AA" }}>{v}</span>
              </div>
            ))}
          </div>
          <label style={S.fileLabel}>
            <input type="file" accept=".xlsx,.xls,.csv" onChange={handleFile} style={{ display:"none" }} />
            {file ? (
              <><div style={{ color:"#00C2FF", fontWeight:600 }}>📎 {file.name}</div><div style={{ fontSize:11, color:"#8896AA", marginTop:4 }}>클릭하여 다시 선택</div></>
            ) : (
              <><div style={{ fontSize:24, marginBottom:8 }}>📂</div><div style={{ fontWeight:600 }}>클릭하여 파일 선택</div><div style={{ fontSize:11, color:"#8896AA", marginTop:4 }}>.xlsx .xls .csv 지원</div></>
            )}
          </label>
          {loading && <div style={{ color:"#8896AA", fontSize:13, textAlign:"center" }}>파일 분석 중...</div>}
        </>
      ) : parsed && (
        <>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
            {[["총 인원",parsed.total,"#00C2FF"],["재직자",parsed.employees.filter(e=>e.active).length,"#00C48C"],["퇴사",parsed.employees.filter(e=>!e.active).length,"#FF8C42"]].map(([l,v,c])=>(
              <div key={l} style={{ background:"#0B1A2E", borderRadius:8, padding:"10px 12px", textAlign:"center" }}>
                <div style={{ fontSize:22, fontWeight:800, color:c }}>{v}</div>
                <div style={{ fontSize:11, color:"#8896AA", marginTop:2 }}>{l}</div>
              </div>
            ))}
          </div>
          {parsed.errors.length > 0 && (
            <div style={{ background:"rgba(255,77,106,.08)", border:"1px solid rgba(255,77,106,.3)", borderRadius:8, padding:"10px 14px" }}>
              <div style={{ fontSize:12, color:"#FF4D6A", fontWeight:700, marginBottom:4 }}>⚠️ 오류 {parsed.errors.length}건 스킵</div>
              {parsed.errors.slice(0,3).map((e,i)=><div key={i} style={{ fontSize:11, color:"#FF4D6A" }}>{e}</div>)}
            </div>
          )}
          <div style={{ background:"#0B1A2E", borderRadius:8, overflow:"hidden", maxHeight:180, overflowY:"auto" }}>
            <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
              <thead><tr>{["사번","이름","부서","노선","재직"].map(h=><th key={h} style={{ padding:"7px 10px", textAlign:"left", color:"#8896AA", borderBottom:"1px solid #1E3A5F", fontWeight:600 }}>{h}</th>)}</tr></thead>
              <tbody>
                {parsed.employees.slice(0,8).map((e,i)=>(
                  <tr key={i}>
                    <td style={{ padding:"5px 10px", color:"#F0F4FF" }}>{e.empNo}</td>
                    <td style={{ padding:"5px 10px", fontWeight:600 }}>{e.name}</td>
                    <td style={{ padding:"5px 10px", color:"#8896AA" }}>{e.dept||"–"}</td>
                    <td style={{ padding:"5px 10px", color:"#8896AA" }}>{e.routeCode||"–"}</td>
                    <td style={{ padding:"5px 10px" }}>
                      <span style={{ fontSize:10, borderRadius:10, padding:"2px 7px", background:e.active?"#00C48C22":"#FF4D6A22", color:e.active?"#00C48C":"#FF4D6A" }}>{e.active?"재직":"퇴사"}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {parsed.total > 8 && <div style={{ padding:"6px 10px", fontSize:11, color:"#4A6FA5", textAlign:"center" }}>외 {parsed.total-8}명...</div>}
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
      <div style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 14px", background:"#0B1A2E", borderRadius:8 }}>
        <label style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer", fontSize:13 }}>
          <input type="checkbox" checked={form.active} onChange={e=>setForm({...form,active:e.target.checked})}
            style={{ accentColor:"#1A6BFF", width:16, height:16 }} />
          재직 중 (체크 해제 시 비활성화)
        </label>
      </div>
      {error && <div style={S.errorMsg}>{error}</div>}
      <div style={{ display:"flex", gap:8 }}>
        <button style={{ ...S.btn, opacity:loading?0.6:1 }} onClick={handleSave} disabled={loading}>
          {loading?"등록 중...":"✅ 등록하기"}
        </button>
        <button style={{ ...S.btnSecondary, flex:"0 0 80px" }} onClick={()=>setForm(empty)}>초기화</button>
      </div>
      <div style={{ fontSize:11, color:"#4A6FA5" }}>초기 PIN은 000000으로 설정됩니다</div>
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
          <div key={h} style={{ fontSize:11, color:"#8896AA", fontWeight:600 }}>{h}</div>
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
                style={{ accentColor:"#1A6BFF", width:16, height:16, cursor:"pointer" }} />
            </div>
            <button onClick={()=>removeRow(row.id)} disabled={rows.length<=1}
              style={{ background:"transparent", border:"none", color:"#FF4D6A", cursor:"pointer", fontSize:14, opacity:rows.length<=1?0.3:1, padding:0 }}>
              ✕
            </button>
          </div>
        ))}
      </div>

      {/* 행 추가 */}
      <button onClick={addRow} style={{ ...S.btnSecondary, fontSize:13 }}>+ 행 추가</button>

      {/* 요약 */}
      <div style={{ background:"rgba(0,194,255,.06)", border:"1px solid rgba(0,194,255,.15)", borderRadius:8, padding:"8px 14px", fontSize:12, color:"#8896AA", display:"flex", justifyContent:"space-between" }}>
        <span>총 {rows.length}행 입력 중</span>
        <span style={{ color:"#00C2FF", fontWeight:600 }}>유효 {validCount}명 등록 예정</span>
      </div>

      {error && <div style={S.errorMsg}>{error}</div>}

      <button style={{ ...S.btn, opacity:(loading||validCount===0)?0.5:1 }}
        onClick={handleSave} disabled={loading||validCount===0}>
        {loading?`등록 중...`:`✅ ${validCount}명 등록하기`}
      </button>
      <div style={{ fontSize:11, color:"#4A6FA5" }}>사번·이름이 비어있는 행은 자동 제외됩니다 · 초기 PIN: 000000</div>
    </div>
  );
}

// ─── 스타일 ────────────────────────────────────────────
const S = {
  wrap: { minHeight:"100vh", background:"#0B1A2E", display:"flex", alignItems:"center", justifyContent:"center", padding:20, fontFamily:"'Noto Sans KR',sans-serif" },
  card: { background:"#112240", borderRadius:24, padding:"32px 28px", width:"100%", display:"flex", flexDirection:"column", gap:14, boxShadow:"0 24px 64px rgba(0,0,0,.5)" },
  header: { display:"flex", alignItems:"center", gap:12, marginBottom:4 },
  logo: { width:36, height:36, borderRadius:10, background:"linear-gradient(135deg,#1A6BFF,#00C2FF)", display:"flex", alignItems:"center", justifyContent:"center", fontWeight:800, fontSize:14, color:"#fff", flexShrink:0 },
  logoText: { fontSize:18, fontWeight:800, background:"linear-gradient(90deg,#1A6BFF,#00C2FF)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" },
  logoSub: { fontSize:11, color:"#8896AA" },
  stepRow: { display:"flex", alignItems:"flex-start" },
  title: { fontSize:16, fontWeight:700, color:"#F0F4FF" },
  desc: { fontSize:13, color:"#8896AA" },
  label: { fontSize:11, color:"#8896AA", display:"block", marginBottom:4, fontWeight:600 },
  input: { background:"#0B1A2E", border:"1px solid #1E3A5F", borderRadius:8, padding:"10px 14px", color:"#F0F4FF", fontSize:14, outline:"none", fontFamily:"inherit", width:"100%", boxSizing:"border-box" },
  inputSm: { background:"#0B1A2E", border:"1px solid #1E3A5F", borderRadius:6, padding:"7px 8px", color:"#F0F4FF", fontSize:12, outline:"none", fontFamily:"inherit", width:"100%", boxSizing:"border-box" },
  btn: { background:"linear-gradient(135deg,#1A6BFF,#00C2FF)", border:"none", borderRadius:12, padding:"14px", color:"#fff", fontSize:15, fontWeight:800, cursor:"pointer", fontFamily:"inherit", width:"100%" },
  btnSecondary: { background:"#1E3A5F", border:"none", borderRadius:10, padding:"11px 16px", color:"#8896AA", fontSize:13, fontWeight:600, cursor:"pointer", fontFamily:"inherit", width:"100%" },
  errorMsg: { background:"rgba(255,77,106,.1)", border:"1px solid rgba(255,77,106,.3)", borderRadius:8, padding:"10px 14px", fontSize:13, color:"#FF4D6A", whiteSpace:"pre-line" },
  notice: { fontSize:11, color:"#4A6FA5", textAlign:"center" },
  excelGuide: { background:"rgba(255,209,102,.06)", border:"1px solid rgba(255,209,102,.2)", borderRadius:10, padding:"14px 16px" },
  fileLabel: { display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:4, padding:"24px", border:"2px dashed #1E3A5F", borderRadius:12, cursor:"pointer", textAlign:"center", color:"#F0F4FF", fontSize:14, fontWeight:600, minHeight:100 },
};

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
        <input style={{ ...S.input, flex:1, minWidth:140, padding:"8px 12px" }}
          placeholder="이름·사번·부서 검색" value={search} onChange={e=>setSearch(e.target.value)} />
        {["전체","재직","퇴사"].map(f=>(
          <button key={f} onClick={()=>setFilterActive(f)}
            style={{ padding:"7px 12px", borderRadius:8, border:"none", cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight:600,
              background: filterActive===f?"linear-gradient(135deg,#1A6BFF,#00C2FF)":"#1E3A5F",
              color: filterActive===f?"#fff":"#8896AA" }}>
            {f}
          </button>
        ))}
      </div>

      {/* 집계 */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
        {[["전체",employees.length,"#00C2FF"],["재직",employees.filter(e=>e.active).length,"#00C48C"],["퇴사",employees.filter(e=>!e.active).length,"#FF8C42"]].map(([l,v,c])=>(
          <div key={l} style={{ background:"#0B1A2E", borderRadius:8, padding:"8px 10px", textAlign:"center" }}>
            <div style={{ fontSize:20, fontWeight:800, color:c }}>{v}</div>
            <div style={{ fontSize:11, color:"#8896AA" }}>{l}</div>
          </div>
        ))}
      </div>

      {/* 직원 목록 */}
      {loading ? (
        <div style={{ textAlign:"center", padding:20, color:"#8896AA", fontSize:13 }}>로딩 중...</div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign:"center", padding:20, color:"#4A6FA5", fontSize:13 }}>
          {search ? "검색 결과가 없습니다" : "등록된 직원이 없습니다"}
        </div>
      ) : (
        <div style={{ display:"flex", flexDirection:"column", gap:8, maxHeight:360, overflowY:"auto" }}>
          {filtered.map(emp => (
            <div key={emp.id} style={{ background:"#0B1A2E", borderRadius:10, padding:"12px 14px", border:`1px solid ${emp.active?"#1E3A5F":"rgba(255,77,106,.2)"}` }}>
              <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:8 }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:4 }}>
                    <span style={{ fontSize:13, fontWeight:700 }}>{emp.name}</span>
                    <span style={{ fontSize:10, fontFamily:"monospace", color:"#8896AA" }}>{emp.empNo}</span>
                    <span style={{ fontSize:10, padding:"1px 7px", borderRadius:8,
                      background:emp.active?"rgba(0,196,140,.15)":"rgba(255,77,106,.15)",
                      color:emp.active?"#00C48C":"#FF4D6A" }}>
                      {emp.active?"재직":"퇴사"}
                    </span>
                    {emp.pinInitial && <span style={{ fontSize:10, padding:"1px 7px", borderRadius:8, background:"rgba(255,209,102,.15)", color:"#FFD166" }}>PIN미변경</span>}
                  </div>
                  <div style={{ fontSize:12, color:"#8896AA" }}>
                    {emp.dept || "부서없음"} · {emp.routeCode || "노선없음"}
                  </div>
                </div>
                <div style={{ display:"flex", gap:4, flexShrink:0 }}>
                  <button onClick={()=>openEdit(emp)}
                    style={{ background:"#1E3A5F", border:"none", borderRadius:6, padding:"5px 10px", color:"#8896AA", fontSize:11, cursor:"pointer", fontFamily:"inherit" }}>
                    수정
                  </button>
                  <button onClick={()=>handleResetPin(emp)}
                    style={{ background:"rgba(255,209,102,.1)", border:"none", borderRadius:6, padding:"5px 10px", color:"#FFD166", fontSize:11, cursor:"pointer", fontFamily:"inherit" }}>
                    PIN초기화
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 수정 모달 */}
      {editEmp && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.7)", zIndex:200, display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}>
          <div style={{ background:"#112240", borderRadius:16, padding:"24px 20px", width:"100%", maxWidth:380, display:"flex", flexDirection:"column", gap:10 }}>
            <div style={{ fontSize:15, fontWeight:700, color:"#00C2FF" }}>직원 정보 수정</div>
            <div style={{ fontSize:12, color:"#8896AA" }}>{editEmp.empNo} · {editEmp.name}</div>

            <label style={S.label}>이름 *</label>
            <input style={S.input} value={editForm.name} onChange={e=>setEditForm({...editForm,name:e.target.value})} />

            <label style={S.label}>부서</label>
            <input style={S.input} placeholder="예) 개발팀" value={editForm.dept} onChange={e=>setEditForm({...editForm,dept:e.target.value})} />

            <label style={S.label}>노선</label>
            <select style={S.input} value={editForm.routeCode} onChange={e=>setEditForm({...editForm,routeCode:e.target.value})}>
              <option value="">노선 선택</option>
              {routes.map(r=><option key={r.id} value={r.code||r.id}>{r.name} ({r.code||r.id})</option>)}
            </select>

            <label style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer", fontSize:13 }}>
              <input type="checkbox" checked={editForm.active} onChange={e=>setEditForm({...editForm,active:e.target.checked})}
                style={{ accentColor:"#1A6BFF", width:16, height:16 }} />
              재직 중 (체크 해제 시 퇴사 처리)
            </label>

            {msg && (
              <div style={{ background: msg.type==="success"?"rgba(0,196,140,.1)":"rgba(255,77,106,.1)", border:`1px solid ${msg.type==="success"?"rgba(0,196,140,.3)":"rgba(255,77,106,.3)"}`, borderRadius:8, padding:"8px 12px", fontSize:13, color: msg.type==="success"?"#00C48C":"#FF4D6A" }}>
                {msg.text}
              </div>
            )}

            <div style={{ display:"flex", gap:8, marginTop:4 }}>
              <button style={{ ...S.btn, opacity:saving?0.6:1 }} onClick={handleSave} disabled={saving}>
                {saving?"저장 중...":"저장"}
              </button>
              <button style={{ ...S.btnSecondary, flex:"0 0 80px" }} onClick={()=>setEditEmp(null)}>취소</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
