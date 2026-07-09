import { useState, useEffect } from "react";
import { validateAndBoard, validateAndBoardStatic } from "../lib/boarding";
import { auth } from "../firebase";
import { signInAnonymously } from "firebase/auth";

function getParam(key) {
  return new URLSearchParams(window.location.search).get(key);
}

const STEPS = { INPUT: "input", LOADING: "loading", SUCCESS: "success", ERROR: "error" };

export default function BoardingApp() {
  const tokenId = getParam("t");
  // 정적(고정) QR — 토큰 없이 회사/차량 ID 만 인코딩(`?c=&v=`). BoardingApp 이 오늘 배차로 노선 해석.
  const cId = getParam("c");
  const vId = getParam("v");
  const isStatic = !tokenId && !!cId && !!vId;
  const [step, setStep] = useState(STEPS.INPUT);
  const [empNo, setEmpNo] = useState("");
  const [name, setName] = useState("");
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
    if (!empNo.trim()) return;
    if (!authReady) {
      setErrMsg("연결 중입니다. 잠시 후 다시 시도해주세요.");
      setStep(STEPS.ERROR);
      return;
    }
    setStep(STEPS.LOADING);
    try {
      const res = isStatic
        ? await validateAndBoardStatic({ companyId: cId, vehicleId: vId, empNo, name })
        : await validateAndBoard({ tokenId, empNo, name });
      setResult(res);
      setStep(STEPS.SUCCESS);
      // 진동 피드백 (모바일)
      if ("vibrate" in navigator) navigator.vibrate([100, 50, 100]);
    } catch (e) {
      setErrMsg(e.message);
      setStep(STEPS.ERROR);
    }
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
              <div style={S.busIcon}>🚌</div>
            </div>
            <div style={S.title}>탑승 확인</div>
            <div style={S.desc}>
              사번을 입력하면 탑승이 기록됩니다.
              {!isStatic && (
                <>
                  <br/>
                  QR코드는 <span style={{ color: "#FFD166", fontWeight: 600 }}>5분</span> 후 만료됩니다.
                </>
              )}
            </div>

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
              <label style={S.inputLabel}>이름 (선택)</label>
              <input
                style={S.input}
                type="text"
                placeholder="이름 입력 (선택사항)"
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={handleKeyDown}
              />
            </div>

            <button
              style={{ ...S.btn, opacity: empNo.trim() ? 1 : 0.5 }}
              onClick={handleBoard}
              disabled={!empNo.trim()}
            >
              탑승 확인
            </button>

            <div style={S.notice}>
              본인 확인 후 탑승이 기록됩니다.<br/>타인의 사번을 무단 사용 시 불이익이 있습니다.
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
