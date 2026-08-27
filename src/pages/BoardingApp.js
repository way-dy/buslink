import { useState, useEffect } from "react";
import { validateAndBoard, validateAndBoardStatic } from "../lib/boarding";
import { passengerLogin, passengerResume, passengerMigrate } from "../lib/passengerAuth";
import { unlockTagSound, playTagBeep } from "../lib/tagSound";
import { auth } from "../firebase";
import { signInAnonymously } from "firebase/auth";
import { BusLinkLogo, Icon } from "../components/ui";
import { fetchPartnerCodeData, applyPartnerTheme } from "../lib/partnerBranding";

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
    return (r && r.empNo && (r.resumeToken || r.pinHash) && (!cId || r.companyId === cId)) ? r : null;
  });
  const [empNo, setEmpNo] = useState("");
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [result, setResult] = useState(null);
  const [errMsg, setErrMsg] = useState("");
  const [authReady, setAuthReady] = useState(false);

  // ── 거래처 테마 (2026-08-27) ──────────────────────────────────────────────
  // 🔴 이 화면은 URL 에 거래처가 없다(`?c=회사&v=차량`). 신원이 생긴 뒤에야 누구 화면인지
  //    알 수 있으므로, 로그인·복원이 돌려주는 `passenger.partnerCode` 로 한 번 조회한다.
  //    그 전(사번·비밀번호 입력 화면)은 기본 테마다 — 아직 누구인지 모르니 당연하다.
  // ⚠ 조회 실패·거래처 없음은 조용히 기본 테마(현행). 탑승은 테마와 무관하게 진행돼야 한다.
  const themeFor = (passenger) => {
    const pc = passenger && passenger.partnerCode;
    if (!pc) return;
    fetchPartnerCodeData(pc).then(applyPartnerTheme).catch(() => {});
  };

  // 🔴 신원이 생기기 «전»에도, 인쇄된 QR 이 거래처를 실어 왔으면 그 톤으로 연다(2026-08-27).
  //    한 거래처 전용 차량에만 관리자가 넣는 값이고(`?pc=`), 없으면 예전처럼 기본 테마다.
  //    로그인이 끝나면 위 `themeFor` 가 **토큰의 거래처**로 덮으므로 값이 틀려도 바로잡힌다.
  useEffect(() => {
    const pc = getParam("pc");
    if (!pc) return;
    let alive = true;
    fetchPartnerCodeData(pc).then(d => { if (alive) applyPartnerTheme(d); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!tokenId && !isStatic) {
      setErrMsg("QR코드가 올바르지 않습니다.\n버스 내 QR코드를 다시 스캔해주세요.");
      setStep(STEPS.ERROR);
    }
  }, [tokenId, isStatic]);

  // ── 인증 부팅 ────────────────────────────────────────────────────────────
  // 기억된 사람이 있으면 **승객 신원**(커스텀 토큰)으로 복원한다(2026-08-25 P1) — 고정 QR
  // 탑승은 이제 서버가 토큰의 사번으로 적재하므로 익명으로는 못 찍는다.
  // 기억이 없으면 익명(2026-05-26) — 기사 QR(`?t=`) 경로의 `boardings` create 규칙(`isAuth()`)
  // 통과용이다. 미인증 시 탑승 저장이 차단된다.
  useEffect(() => {
    let alive = true;
    const done = () => { if (alive) setAuthReady(true); };
    // 인증 실패해도 사용자가 시도는 할 수 있게 한다(에러는 boarding 시점에 표면).
    const anon = () => signInAnonymously(auth).catch(e => console.warn("[BoardingApp] 익명 인증 실패:", e?.message));
    const drop = (why) => {
      console.warn("[BoardingApp] 세션 복원 실패:", why);
      clearRemembered();
      if (alive) setRemembered(null);
      return anon();
    };
    const r = remembered;
    let p;
    if (isStatic && r && r.resumeToken) {
      p = passengerResume({ companyId: cId, resumeToken: r.resumeToken })
        .then(({ passenger }) => { if (alive) themeFor(passenger); })
        .catch(e => drop(e && e.message));
    } else if (isStatic && r && r.pinHash && r.empNo) {
      // 🔴 이 배포 이전에 기억된 기기 — 승계표가 없다. 한 번만 승계한다(서버에 만료일 있음).
      p = passengerMigrate({ companyId: cId, empNo: r.empNo, pinHash: r.pinHash })
        .then(({ resumeToken, passenger }) => {
          if (!alive) return;
          themeFor(passenger);
          const nr = { companyId: cId, empNo: r.empNo, name: r.name || "", resumeToken };
          saveRemembered(nr); setRemembered(nr);
        })
        .catch(e => drop(e && e.message));
    } else {
      p = anon();
    }
    p.finally(done);
    return () => { alive = false; };
    // 마운트 1회 — remembered 는 초기값만 본다(복원 결과로 갱신되면 재실행하면 안 된다).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 오디오 잠금 해제 — 버튼을 누르는 순간이 곧 사용자 제스처다(첫 태깅 무음 방지).
  const handleBoard = async () => {
    unlockTagSound();
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
      // 🔴 본인 확인 = **로그인**이다(2026-08-25 P2). 기억된 기기는 부팅 때 이미 신원을
      //    복원했고, 처음 찍는 사람은 여기서 사번+PIN 으로 로그인한다. 예전엔 클라가 만든
      //    `pinHash` 를 증거로 보냈는데 그 값은 명부에서 누구나 읽을 수 있어 증거가 못 됐다.
      if (isStatic && !remembered) {
        const issued = await passengerLogin({ companyId: cId, empNo: useEmpNo, pin });
        themeFor(issued.passenger);   // 이제 누구인지 안다 → 그 거래처 테마로
        // 로그인 성공이 곧 본인 확인 성공이다 → **여기서** 기억한다. 탑승이 뒤에서
        // 실패해도(그 시간에 배차가 없다 등) 신원은 맞았으므로 PIN 을 다시 칠 이유가 없다.
        // (틀린 값을 굳혀 두면 매번 실패하므로 로그인 전에는 기억하지 않는다.)
        const r = { companyId: cId, empNo: useEmpNo, name: useName, resumeToken: issued.resumeToken };
        saveRemembered(r); setRemembered(r);
      }
      const res = isStatic
        ? await validateAndBoardStatic({ companyId: cId, vehicleId: vId, empNo: useEmpNo, name: useName })
        : await validateAndBoard({ tokenId, empNo: useEmpNo, name: useName });
      setResult(res);
      setStep(STEPS.SUCCESS);
      // 진동 + 확인음 (2026-08-25 미팅). 🔴 앱 밖 경로라 거래처 강제 설정을 모른다 —
      // 여기서는 개인 설정(기본 켜짐)만 따른다. 강제로 켜야 하는 거래처도 기본이 켜짐이라
      // 실제로 안 나는 경우는 승객이 앱에서 일부러 끈 때뿐이다.
      if ("vibrate" in navigator) navigator.vibrate([100, 50, 100]);
      playTagBeep();
    } catch (e) {
      // 기억해 둔 사람으로 본인 확인이 깨지면(앱에서 PIN 을 바꿨거나 명부에서 빠짐)
      // 그 값을 붙들고 있으면 **영원히 실패**한다 → 지우고 다시 입력받는다.
      if (remembered && /본인 확인|등록되지 않은|비활성화|다시 로그인|보안 정책/.test(e.message || "")) {
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
        {/* 워드마크는 다른 화면과 같은 `BusLinkLogo`. 색을 CSS 변수로 넘겨 거래처 테마를 따라간다. */}
        <div style={S.header}>
          <BusLinkLogo size={24} color="var(--color-primary)" sub={isStatic ? "고정 QR 탑승" : "탑승 확인"} />
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
                  QR코드는 <span style={{ color: "var(--color-cautionary)", fontWeight: 700 }}>5분</span> 후 만료됩니다.
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
                    style={{ background: "none", border: "none", color: "var(--color-primary)", fontSize: 12, fontFamily: "inherit", cursor: "pointer", textDecoration: "underline", flexShrink: 0 }}>
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
            <div style={{ color: "var(--color-label-mute)", fontSize: 14, marginTop: 16 }}>탑승 확인 중...</div>
          </div>
        )}

        {/* ─ 성공 ─ */}
        {step === STEPS.SUCCESS && result && (
          <div style={S.centerBox}>
            <div style={S.successIcon}>✓</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: "var(--color-positive)", marginBottom: 8 }}>
              {result.alreadyBoarded ? "이미 탑승 처리됨" : "탑승 완료!"}
            </div>
            {result.alreadyBoarded && (
              <div style={{ fontSize: 13, color: "var(--color-cautionary)", marginBottom: 8, textAlign: "center" }}>
                이미 탑승 처리된 QR입니다.
              </div>
            )}
            <div style={{ fontSize: 15, color: "var(--color-label)", fontWeight: 700, marginBottom: 4, textAlign: "center", wordBreak: "keep-all" }}>
              {result.routeName}
            </div>
            <div style={{ fontSize: 13, color: "var(--color-label-mute)", marginBottom: 20, textAlign: "center" }}>
              {result.vehicleNo} · {result.dispatchDate}
            </div>

            <div style={S.detail}>
              <div style={{ ...S.detailRow, marginBottom: 8 }}>
                <span style={S.detailKey}>사번</span>
                <span style={S.detailVal}>{empNo}</span>
              </div>
              {name && (
                <div style={{ ...S.detailRow, marginBottom: 8 }}>
                  <span style={S.detailKey}>이름</span>
                  <span style={S.detailVal}>{name}</span>
                </div>
              )}
              <div style={S.detailRow}>
                <span style={S.detailKey}>탑승 시각</span>
                <span style={{ ...S.detailVal, color: "var(--color-positive)" }}>
                  {new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </span>
              </div>
            </div>

            <div style={{ fontSize: 12, color: "var(--color-label-alt)", textAlign: "center" }}>
              창을 닫아도 됩니다
            </div>
          </div>
        )}

        {/* ─ 오류 ─ */}
        {step === STEPS.ERROR && (
          <div style={S.centerBox}>
            <div style={S.errorIcon}>✕</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "var(--color-destructive)", marginBottom: 12 }}>
              탑승 실패
            </div>
            <div style={{ fontSize: 14, color: "var(--color-label-mute)", textAlign: "center", whiteSpace: "pre-line", lineHeight: 1.6, marginBottom: 24 }}>
              {errMsg}
            </div>
            {/* 만료성 오류(QR 5분 만료)는 재시도해도 무의미 → 버튼 숨김.
                그 외 복구 가능한 오류(잘못된/사용된 QR, 사번 미입력 등)는 재시도 노출 */}
            {errMsg.includes("만료") ? null : (
              <button
                style={{ ...S.btn, background: "var(--color-bg-soft)", color: "var(--color-label)", fontSize: 14 }}
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

// ─── 스타일 (2026-08-27 라이트 리스킨 + 토큰화) ─────────────────────────────
// 🔴 이 화면은 2026-05-16 리디자인 0~7단계에서 **통째로 빠져 있었다**(redesign.md 목록에
//    Login/Driver/Passenger/Admin/Employee/Partner 만 있다). 그래서 앱 안 탑승 탭(`/p`)은
//    흰 화면인데 고정 QR 로 들어온 같은 사람은 **남색 화면 + 다른 글꼴**을 봤다 —
//    `'Noto Sans KR'` 은 이 저장소 어디에서도 로드하지 않으므로(Pretendard 만 self-host)
//    실제로는 기기 기본 산세리프로 떨어지고 있었다.
// 🔴 색은 전부 tokens.css 변수로 — 이래야 거래처 테마(`applyPartnerTheme`)가 이 화면에도 걸린다.
//    하드코딩 hex 40곳이 이 화면만 테마를 못 따라오게 만들던 원인이었다.
// ⚠ **의도적으로 남긴 것 없음** — 카메라 뷰파인더 같은 "검정이 곧 기능"인 요소가 이 화면엔 없다.
const S = {
  wrap: {
    minHeight: "100vh", background: "var(--color-bg-alt)",
    display: "flex", alignItems: "center", justifyContent: "center",
    padding: 20, fontFamily: "var(--font-base)",
  },
  card: {
    background: "var(--color-bg)", borderRadius: "var(--radius-24)", padding: "32px 28px",
    width: "100%", maxWidth: 380, display: "flex", flexDirection: "column",
    gap: 16, boxShadow: "var(--shadow-strong)",
  },
  header: { display: "flex", alignItems: "center", gap: 12, marginBottom: 4 },
  iconWrap: { display: "flex", justifyContent: "center", margin: "8px 0" },
  busIcon: { fontSize: 48, lineHeight: 1 },
  title: { fontSize: 22, fontWeight: 800, color: "var(--color-label)", textAlign: "center" },
  desc: { fontSize: 13, color: "var(--color-label-mute)", textAlign: "center", lineHeight: 1.6 },
  inputGroup: { display: "flex", flexDirection: "column", gap: 6 },
  inputLabel: { fontSize: 12, color: "var(--color-label-mute)", fontWeight: 600, letterSpacing: "0.03em" },
  input: {
    background: "var(--color-bg)", border: "1px solid var(--color-line)", borderRadius: "var(--radius-12)",
    // 🔴 16px 미만으로 줄이지 말 것 — iOS 사파리가 입력 포커스 때 화면을 확대해 버린다.
    padding: "13px 16px", color: "var(--color-label)", fontSize: 16, outline: "none",
    fontFamily: "inherit", width: "100%", boxSizing: "border-box",
    transition: "border .2s",
  },
  btn: {
    background: "var(--color-primary)", border: "none",
    borderRadius: "var(--radius-12)", padding: "15px", color: "#fff", fontSize: 16,
    fontWeight: 800, cursor: "pointer", fontFamily: "inherit", width: "100%",
    letterSpacing: "0.02em",
  },
  notice: { fontSize: 11, color: "var(--color-label-alt)", textAlign: "center", lineHeight: 1.6 },
  centerBox: { display: "flex", flexDirection: "column", alignItems: "center", padding: "20px 0", gap: 8 },
  successIcon: {
    width: 72, height: 72, borderRadius: "50%",
    background: "var(--color-atomic-green-90)", border: "2px solid var(--color-positive)",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 32, color: "var(--color-positive)", fontWeight: 700, marginBottom: 12,
  },
  errorIcon: {
    width: 72, height: 72, borderRadius: "50%",
    background: "var(--color-atomic-red-90)", border: "2px solid var(--color-destructive)",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 32, color: "var(--color-destructive)", fontWeight: 700, marginBottom: 12,
  },
  // 결과 상세 상자 — 카드(흰색) 안에 한 단계 눌린 면.
  detail: {
    background: "var(--color-bg-alt)", border: "1px solid var(--color-line-soft)",
    borderRadius: "var(--radius-12)", padding: "14px 20px", width: "100%", marginBottom: 20,
  },
  detailRow: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 },
  detailKey: { fontSize: 12, color: "var(--color-label-mute)" },
  detailVal: { fontSize: 13, fontWeight: 600, color: "var(--color-label)" },
  spinner: {
    width: 40, height: 40, borderRadius: "50%",
    border: "3px solid var(--color-line)", borderTopColor: "var(--color-primary)",
    animation: "spin 0.8s linear infinite",
  },
};

// 스피너 CSS 주입
const style = document.createElement("style");
style.textContent = `@keyframes spin { to { transform: rotate(360deg); } }`;
document.head.appendChild(style);
