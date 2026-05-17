import { useState } from "react";
import { auth, db } from "../firebase";
import { signInWithEmailAndPassword } from "firebase/auth";
import { collection, query, where, getDocs, doc, getDoc } from "firebase/firestore";
import { BusLinkLogo, Pill, StatusDot, Btn } from "../components/ui";

// 리디자인 1단계(2026-05-16): 라이트 split 리스킨.
// ── 로직 불변: state(empNo/pin/error/loading)·handleLogin·합성이메일
//    `${empNo}@buslink.com`·signInWithEmailAndPassword·Enter 제출·App.js
//    onAuthStateChanged 분기 100% 보존. 마크업/스타일(S 객체)만 교체.
// ── 목업 design/src/screens-login.jsx LoginAdmin 의 "시각 언어"만 차용:
//    좌 다크 브랜드 패널 + 우 라이트 폼 카드. 로직 없는 장식 요소
//    (역할 토글·한/영 토글·로그인 유지·비번찾기·맵 실루엣)는 의도적 제외.
export default function LoginApp() {
  const [empNo, setEmpNo] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!empNo || pin.length < 1) {
      setError("사번과 PIN 6자리를 입력해주세요");
      return;
    }
    try {
      setError("");
      setLoading(true);
      const email = `${empNo}@buslink.com`;
      await signInWithEmailAndPassword(auth, email, pin);
      // onAuthStateChanged가 App.js에서 감지해서 자동 분기
    } catch (e) {
      setError("사번 또는 PIN이 올바르지 않습니다");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={S.page} data-login-page>
      {/* 좌 — 브랜드 패널 (다크, 데스크톱에서만 노출) */}
      <aside style={S.brandPane} data-login-brand>
        <BusLinkLogo size={26} color="#fff" />

        <div style={S.brandBody}>
          <div style={S.eyebrow}>통근버스 관제 플랫폼</div>
          <h1 style={S.headline}>
            노선과 차량을<br />
            <span style={S.headlineAccent}>한 화면에서.</span>
          </h1>
          <p style={S.lede}>
            동영관광이 직접 운영하며 만든 통근버스 관제 시스템.
            설치 없이 링크 하나로 시작합니다.
          </p>

          <div style={S.statRow}>
            <div style={S.stat}>
              <div style={S.statHead}>
                <StatusDot tone="positive" size={7} pulse />
                <span style={S.statN}>실시간</span>
              </div>
              <div style={S.statLabel}>차량 위치 추적</div>
            </div>
            <div style={S.stat}>
              <div style={S.statN}>GPS</div>
              <div style={S.statLabel}>운행 기록 자동화</div>
            </div>
            <div style={S.stat}>
              <div style={S.statN}>웹</div>
              <div style={S.statLabel}>설치 없이 접속</div>
            </div>
          </div>
        </div>

        <div style={S.copyright}>© 2026 BusLink · 동영관광</div>
      </aside>

      {/* 우 — 폼 */}
      <main style={S.formPane}>
        <div style={S.formCol}>
          {/* 모바일에서만 노출되는 상단 로고 */}
          <div style={S.mobileLogo} data-login-mobile-logo>
            <BusLinkLogo size={22} />
          </div>

          <Pill tone="primary" dot style={{ marginBottom: 18 }}>
            관제 시스템 로그인
          </Pill>
          <h2 style={S.title}>다시 오신 걸 환영합니다</h2>
          <p style={S.subtitle}>사번과 비밀번호로 로그인하세요.</p>

          <div style={S.field}>
            <label style={S.label} htmlFor="login-empNo">사번</label>
            <input
              id="login-empNo"
              style={S.input}
              placeholder="사번"
              value={empNo}
              onChange={e => setEmpNo(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleLogin()}
              autoComplete="username"
            />
          </div>

          <div style={S.field}>
            <label style={S.label} htmlFor="login-pin">비밀번호</label>
            <input
              id="login-pin"
              style={S.input}
              placeholder="비밀번호"
              type="password"
              value={pin}
              onChange={e => setPin(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleLogin()}
              autoComplete="current-password"
            />
          </div>

          {error && <p style={S.error}>{error}</p>}

          <Btn
            variant="primary"
            size="lg"
            onClick={handleLogin}
            disabled={loading}
            style={S.submit}
          >
            {loading ? "로그인 중..." : "로그인"}
          </Btn>
        </div>
      </main>
    </div>
  );
}

// LoginApp 한정 인라인 스타일. 색/라운드/그림자는 tokens.css 변수 기반.
const S = {
  page: {
    minHeight: "100vh",
    display: "flex",
    background: "var(--color-bg)",
    fontFamily: "var(--font-base)",
  },

  // 좌 브랜드 패널 — 다크 그라데이션 (목업 LoginAdmin 좌측 차용)
  brandPane: {
    flex: "0 0 480px",
    background:
      "linear-gradient(160deg, var(--color-bg-dark) 0%, #0F1A3D 60%, var(--color-primary) 150%)",
    color: "#fff",
    padding: "56px 52px",
    display: "flex",
    flexDirection: "column",
    position: "relative",
    overflow: "hidden",
  },
  brandBody: { position: "relative", marginTop: "auto", marginBottom: "auto" },
  eyebrow: {
    fontSize: 13,
    color: "rgba(255,255,255,0.6)",
    fontWeight: 600,
    letterSpacing: 1,
    marginBottom: 12,
  },
  headline: {
    fontFamily: "var(--font-brand)",
    fontSize: 44,
    lineHeight: 1.18,
    letterSpacing: "-0.03em",
    fontWeight: 800,
    margin: 0,
    color: "#fff",
  },
  headlineAccent: { color: "#7AB0FF" },
  lede: {
    marginTop: 18,
    fontSize: 15,
    lineHeight: 1.65,
    color: "rgba(255,255,255,0.72)",
    maxWidth: 360,
  },
  statRow: { marginTop: 44, display: "flex", gap: 26, flexWrap: "wrap" },
  stat: {},
  statHead: { display: "flex", alignItems: "center", gap: 7 },
  statN: {
    fontFamily: "var(--font-brand)",
    fontSize: 20,
    fontWeight: 800,
    color: "#fff",
    letterSpacing: "-0.02em",
  },
  statLabel: { fontSize: 12, color: "rgba(255,255,255,0.6)", marginTop: 4 },
  copyright: {
    position: "relative",
    fontSize: 12,
    color: "rgba(255,255,255,0.4)",
  },

  // 우 폼 패널 — 라이트
  formPane: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "40px 24px",
    background: "var(--color-bg)",
  },
  formCol: { width: "100%", maxWidth: 380 },
  mobileLogo: { display: "none", marginBottom: 28 },

  title: {
    fontSize: 28,
    fontWeight: 800,
    margin: 0,
    letterSpacing: "-0.025em",
    color: "var(--color-label)",
  },
  subtitle: {
    fontSize: 15,
    color: "var(--color-label-mute)",
    marginTop: 8,
    marginBottom: 28,
  },

  field: { marginBottom: 14 },
  label: {
    display: "block",
    fontSize: 13,
    fontWeight: 600,
    color: "var(--color-label)",
    marginBottom: 6,
  },
  input: {
    width: "100%",
    padding: "14px 16px",
    border: "1px solid var(--color-line)",
    borderRadius: "var(--radius-12)",
    background: "var(--color-bg)",
    fontSize: 15,
    color: "var(--color-label)",
    fontWeight: 500,
    outline: "none",
    fontFamily: "inherit",
  },
  error: {
    color: "var(--color-destructive)",
    fontSize: 13,
    margin: "4px 0 0",
  },
  submit: {
    width: "100%",
    marginTop: 24,
    padding: "16px",
    fontSize: 16,
    fontWeight: 700,
  },
};
