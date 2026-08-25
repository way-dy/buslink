import { useState, useEffect } from "react";
import { validateAndBoard, validateAndBoardStatic } from "../lib/boarding";
import { hashPin } from "../lib/partner";
import { auth } from "../firebase";
import { signInAnonymously } from "firebase/auth";
import { Icon } from "../components/ui";

function getParam(key) {
  return new URLSearchParams(window.location.search).get(key);
}

const STEPS = { INPUT: "input", LOADING: "loading", SUCCESS: "success", ERROR: "error" };

// ─── 이 기기 기억(2026-08-25 본인 확인) ────────────────────────────────────
// 🔴 앱 밖(외부 카메라)에서 고정 QR 을 열면 예전엔 사번만 받고 탑승이 적재됐다 — 아무
//    문자열이나 통과했다. 이제 PIN 을 함께 받아 서버가 명부와 대조한다.
//    다만 버스를 탈 때마다 6자리를 치게 하면 그게 곧 다음 민원이므로, **한 번 확인에
//    성공하면 이 기기에 기억**해 두 번째부터는 버튼 한 번이다.
// ⚠ 앱(`/p`)의 세션 키(`buslink_employee`)와 **일부러 다른 키**다 — 고정 QR 주소는
//    관리자가 인쇄한 호스트(admin.*)를 가리킬 수 있어 origin 이 다르고, 앱 세션을
//    여기서 덮어쓰면 로그인 상태가 꼬인다.
const LS_KEY = "buslink_board_id";
function loadRemembered() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "null"); } catch { return null; }
}
function saveRemembered(v) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(v)); } catch { /* 사파리 프라이빗 등 — 무해 */ }
}
function clearRemembered() {
  try { localStorage.removeItem(LS_KEY); } catch { /* 무해 */ }
}

export default function BoardingApp() {
  const tokenId = getParam("t");
  // 정적(고정) QR — 토큰 없이 회사/차량 ID 만 인코딩(`?c=&v=`). BoardingApp 이 오늘 배차로 노선 해석.
  const cId = getParam("c");
  const vId = getParam("v");
  const isStatic = !tokenId && !!cId && !!vId;
  const [step, setStep] = useState(STEPS.INPUT);
  // 이 기기에 기억된 사람(있으면 사번·PIN 입력 없이 버튼 한 번). 회사가 다르면 무시.
  const [remembered, setRemembered] = useState(() => {
    const r = loadRemembered();
    return (r && r.empNo && r.pinHash && (!cId || r.companyId === cId)) ? r : null;
  });
  const [empNo, setEmpNo] = useState("");
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [result, setResult] = useState(null);
  const [errMsg, setErrMsg] = useState("");
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    if (!tokenId && !isStatic) {
      setErrMsg("QR코드가 올바르지 않습니다.\n버스 내 QR코드를 다시 스캔해주세요.");
      setStep(STEPS.ERROR);
    }
  }, [tokenId, isStatic]);

  // 익명 인증 (2026-05-26) — boardings create rule(`isAuth()`) 통과용. 미인증 시 탑승 저장 차단됨.
  // EmployeeApp·PassengerApp·PartnerApp 패턴 일관. BoardingApp만 누락되어 있어 QR 탑승이 통계에 안 잡히는 결함 보정.
  useEffect(() => {
    signInAnonymously(auth)
      .then(() => setAuthReady(true))
      .catch(e => {
        console.warn("[BoardingApp] 익명 인증 실패:", e?.message);
        setAuthReady(true); // 인증 실패해도 사용자가 시도할 수 있게 함(에러는 boarding 시점에 표면).
      });
  }, []);

  const handleBoard = async () => {
    // 기억된 사람이면 입력 없이 진행, 아니면 사번+PIN 을 다 받아야 한다.
    const useEmpNo = remembered ? remembered.empNo : empNo.trim();
    const useName  = remembered ? (remembered.name || "") : name;
    if (!useEmpNo) return;
    if (!remembered && pin.length < 4) return;
    if (!authReady) {
      setErrMsg("연결 중입니다. 잠시 후 다시 시도해주세요.");
      setStep(STEPS.ERROR);
      return;
    }
    setStep(STEPS.LOADING);
    try {
      // 🔴 서버가 명부의 pinHash 와 대조한다 — 여기서 만든 해시가 곧 본인 확인 근거다.
      const proof = remembered ? remembered.pinHash : await hashPin(pin);
      const res = isStatic
        ? await validateAndBoardStatic({ companyId: cId, vehicleId: vId, empNo: useEmpNo, name: useName, pinHash: proof })
        : await validateAndBoard({ tokenId, empNo: useEmpNo, name: useName });
      // 확인에 성공한 뒤에만 기억한다(틀린 값을 굳혀 두면 매번 실패한다).
      if (isStatic && !remembered) {
        const r = { companyId: cId, empNo: useEmpNo, name: useName, pinHash: proof };
        saveRemembered(r); setRemembered(r);
      }
      setResult(res);
      setStep(STEPS.SUCCESS);
      // 진동 피드백 (모바일)
      if ("vibrate" in navigator) navigator.vibrate([100, 50, 100]);
    } catch (e) {
      // 기억해 둔 사람으로 본인 확인이 깨지면(앱에서 PIN 을 바꿨거나 명부에서 빠짐)
      // 그 값을 붙들고 있으면 **영원히 실패**한다 → 지우고 다시 입력받는다.
      if (remembered && /본인 확인|등록되지 않은|비활성화/.test(e.message || "")) {
        clearRemembered(); setRemembered(null); setEmpNo(""); setPin("");
      }
      setErrMsg(e.message);
      setStep(STEPS.ERROR);
    }
  };

  // 다른 사람으로 찍기 — 기억을 지우고 입력 화면으로.
  const handleSwitchUser = () => {
    clearRemembered(); setRemembered(null);
    setEmpNo(""); setPin(""); setName(""); setErrMsg(""); setStep(STEPS.INPUT);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") handleBoard();
  };

  return (
    <div style={S.wrap}>
      <div style={S.card}>
        {/* 헤더 */}
        <div style={S.header}>
          <div style={S.logo}>BL</div>
          <div>
            <div style={S.logoText}>BusLink</div>
            <div style={S.logoSub}>{isStatic ? "고정 QR 탑승" : "탑승 확인"}</div>
          </div>
        </div>

        {/* ─ 입력 단계 ─ */}
        {step === STEPS.INPUT && (
          <>
            <div style={S.iconWrap}>
              <div style={{ ...S.busIcon, color: "var(--color-primary)", display: "flex" }}><Icon name="bus" size={46} stroke={1.5} /></div>
            </div>
            <div style={S.title}>탑승 확인</div>
            <div style={S.desc}>
              {remembered
                ? <>버튼을 누르면 탑승이 기록됩니다.</>
                : <>사번과 비밀번호로 본인 확인 후 탑승이 기록됩니다.</>}
              {!isStatic && (
                <>
                  <br/>
                  QR코드는 <span style={{ color: "#FFD166", fontWeight: 600 }}>5분</span> 후 만료됩니다.
                </>
              )}
            </div>

            {/* 이 기기에 기억된 사람 — 두 번째부터는 입력 없이 버튼 한 번(2026-08-25). */}
            {remembered ? (
              <div style={S.inputGroup}>
                <label style={S.inputLabel}>탑승자</label>
                <div style={{ ...S.input, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ fontWeight: 700 }}>
                    {remembered.name ? `${remembered.name} · ` : ""}{remembered.empNo}
                  </span>
                  <button onClick={handleSwitchUser}
                    style={{ background: "none", border: "none", color: "#9FB6FF", fontSize: 12, fontFamily: "inherit", cursor: "pointer", textDecoration: "underline", flexShrink: 0 }}>
                    다른 사람
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div style={S.inputGroup}>
                  <label style={S.inputLabel}>사번 *</label>
                  <input
                    style={S.input}
                    type="tel"
                    inputMode="numeric"
                    placeholder="사번 입력 (예: 10001)"
                    value={empNo}
                    onChange={e => setEmpNo(e.target.value)}
                    onKeyDown={handleKeyDown}
                    autoFocus
                  />
                </div>

                <div style={S.inputGroup}>
                  <label style={S.inputLabel}>비밀번호 *</label>
                  <input
                    style={S.input}
                    type="password"
                    inputMode="numeric"
                    maxLength={6}
                    placeholder="앱 로그인과 같은 비밀번호"
                    value={pin}
                    onChange={e => setPin(e.target.value)}
                    onKeyDown={handleKeyDown}
                  />
                </div>
              </>
            )}

            <button
              style={{ ...S.btn, opacity: (remembered || (empNo.trim() && pin.length >= 4)) ? 1 : 0.5 }}
              onClick={handleBoard}
              disabled={!(remembered || (empNo.trim() && pin.length >= 4))}
            >
              탑승 확인
            </button>

            <div style={S.notice}>
              {remembered
                ? <>이 휴대폰에 기억해 둔 정보로 확인합니다.<br/>다른 분이 타실 때는 <b>다른 사람</b>을 눌러주세요.</>
                : <>한 번 확인하면 이 휴대폰에 기억해 다음부터는 바로 탑승됩니다.<br/>타인의 사번을 무단 사용 시 불이익이 있습니다.</>}
            </div>
          </>
        )}

        {/* ─ 처리 중 ─ */}
        {step === STEPS.LOADING && (
          <div style={S.centerBox}>
            <div style={S.spinner} />
            <div style={{ color: "#8896AA", fontSize: 14, marginTop: 16 }}>탑승 확인 중...</div>
          </div>
        )}

        {/* ─ 성공 ─ */}
        {step === STEPS.SUCCESS && result && (
          <div style={S.centerBox}>
            <div style={S.successIcon}>✓</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: "#00C48C", marginBottom: 8 }}>
              {result.alreadyBoarded ? "이미 탑승 처리됨" : "탑승 완료!"}
            </div>
            {result.alreadyBoarded && (
              <div style={{ fontSize: 13, color: "#FFD166", marginBottom: 8, textAlign: "center" }}>
                이미 탑승 처리된 QR입니다.
              </div>
            )}
            <div style={{ fontSize: 15, color: "#F0F4FF", fontWeight: 600, marginBottom: 4, textAlign: "center" }}>
              {result.routeName}
            </div>
            <div style={{ fontSize: 13, color: "#8896AA", marginBottom: 20, textAlign: "center" }}>
              {result.vehicleNo} · {result.dispatchDate}
            </div>

            <div style={{ background: "#0B1A2E", borderRadius: 12, padding: "14px 20px", width: "100%", marginBottom: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 12, color: "#8896AA" }}>사번</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: "#F0F4FF" }}>{empNo}</span>
              </div>
              {name && (
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                  <span style={{ fontSize: 12, color: "#8896AA" }}>이름</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#F0F4FF" }}>{name}</span>
                </div>
              )}
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontSize: 12, color: "#8896AA" }}>탑승 시각</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: "#00C48C" }}>
                  {new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </span>
              </div>
            </div>

            <div style={{ fontSize: 12, color: "#4A6FA5", textAlign: "center" }}>
              창을 닫아도 됩니다
            </div>
          </div>
        )}

        {/* ─ 오류 ─ */}
        {step === STEPS.ERROR && (
          <div style={S.centerBox}>
            <div style={S.errorIcon}>✕</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#FF4D6A", marginBottom: 12 }}>
              탑승 실패
            </div>
            <div style={{ fontSize: 14, color: "#8896AA", textAlign: "center", whiteSpace: "pre-line", lineHeight: 1.6, marginBottom: 24 }}>
              {errMsg}
            </div>
            {/* 만료성 오류(QR 5분 만료)는 재시도해도 무의미 → 버튼 숨김.
                그 외 복구 가능한 오류(잘못된/사용된 QR, 사번 미입력 등)는 재시도 노출 */}
            {errMsg.includes("만료") ? null : (
              <button
                style={{ ...S.btn, background: "#1E3A5F", fontSize: 14 }}
                onClick={() => { setStep(STEPS.INPUT); setErrMsg(""); }}
              >
                다시 시도
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const S = {
  wrap: {
    minHeight: "100vh", background: "#0B1A2E",
    display: "flex", alignItems: "center", justifyContent: "center",
    padding: 20, fontFamily: "'Noto Sans KR',sans-serif",
  },
  card: {
    background: "#112240", borderRadius: 24, padding: "32px 28px",
    width: "100%", maxWidth: 380, display: "flex", flexDirection: "column",
    gap: 16, boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
  },
  header: { display: "flex", alignItems: "center", gap: 12, marginBottom: 4 },
  logo: {
    width: 36, height: 36, borderRadius: 10,
    background: "linear-gradient(135deg,#1A6BFF,#00C2FF)",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontWeight: 800, fontSize: 14, color: "#fff", flexShrink: 0,
  },
  logoText: { fontSize: 18, fontWeight: 800, background: "linear-gradient(90deg,#1A6BFF,#00C2FF)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" },
  logoSub: { fontSize: 11, color: "#8896AA" },
  iconWrap: { display: "flex", justifyContent: "center", margin: "8px 0" },
  busIcon: { fontSize: 48, lineHeight: 1 },
  title: { fontSize: 22, fontWeight: 800, color: "#F0F4FF", textAlign: "center" },
  desc: { fontSize: 13, color: "#8896AA", textAlign: "center", lineHeight: 1.6 },
  inputGroup: { display: "flex", flexDirection: "column", gap: 6 },
  inputLabel: { fontSize: 12, color: "#8896AA", fontWeight: 600, letterSpacing: "0.03em" },
  input: {
    background: "#0B1A2E", border: "1px solid #1E3A5F", borderRadius: 10,
    padding: "13px 16px", color: "#F0F4FF", fontSize: 16, outline: "none",
    fontFamily: "inherit", width: "100%", boxSizing: "border-box",
    transition: "border .2s",
  },
  btn: {
    background: "linear-gradient(135deg,#1A6BFF,#00C2FF)", border: "none",
    borderRadius: 12, padding: "15px", color: "#fff", fontSize: 16,
    fontWeight: 800, cursor: "pointer", fontFamily: "inherit", width: "100%",
    letterSpacing: "0.02em",
  },
  notice: { fontSize: 11, color: "#4A6FA5", textAlign: "center", lineHeight: 1.6 },
  centerBox: { display: "flex", flexDirection: "column", alignItems: "center", padding: "20px 0", gap: 8 },
  successIcon: {
    width: 72, height: 72, borderRadius: "50%",
    background: "rgba(0,196,140,.15)", border: "2px solid #00C48C",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 32, color: "#00C48C", fontWeight: 700, marginBottom: 12,
  },
  errorIcon: {
    width: 72, height: 72, borderRadius: "50%",
    background: "rgba(255,77,106,.15)", border: "2px solid #FF4D6A",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 32, color: "#FF4D6A", fontWeight: 700, marginBottom: 12,
  },
  spinner: {
    width: 40, height: 40, borderRadius: "50%",
    border: "3px solid #1E3A5F", borderTopColor: "#00C2FF",
    animation: "spin 0.8s linear infinite",
  },
};

// 스피너 CSS 주입
const style = document.createElement("style");
style.textContent = `@keyframes spin { to { transform: rotate(360deg); } }`;
document.head.appendChild(style);
