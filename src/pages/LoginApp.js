import { useState } from "react";
import { auth, db } from "../firebase";
import { signInWithEmailAndPassword } from "firebase/auth";
import { collection, query, where, getDocs, doc, getDoc } from "firebase/firestore";

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
    <div style={S.container}>
      <div style={S.card}>
        <div style={S.logo}>🚌</div>
        <h1 style={S.brand}>BusLink</h1>
        <p style={S.sub}>버스 관제 플랫폼</p>
        <div style={S.divider} />
        <input
          style={S.input}
          placeholder="사번"
          value={empNo}
          onChange={e => setEmpNo(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleLogin()}
        />
   <input style={S.input} placeholder="비밀번호" type="password"
  value={pin} onChange={e => setPin(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleLogin()}
        />
        {error && <p style={S.error}>{error}</p>}
        <button style={{ ...S.btn, opacity: loading ? 0.6 : 1 }} onClick={handleLogin} disabled={loading}>
          {loading ? "로그인 중..." : "로그인"}
        </button>
      </div>
    </div>
  );
}

const S = {
  container: { minHeight: "100vh", background: "#0B1A2E", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, fontFamily: "'Noto Sans KR',sans-serif" },
  card: { background: "#112240", borderRadius: 20, padding: "40px 32px", width: "100%", maxWidth: 360, display: "flex", flexDirection: "column", gap: 14, boxShadow: "0 20px 60px rgba(0,0,0,0.4)" },
  logo: { fontSize: 48, textAlign: "center" },
  brand: { color: "#F0F4FF", textAlign: "center", fontSize: 24, fontWeight: 800, background: "linear-gradient(90deg,#1A6BFF,#00C2FF)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", margin: 0 },
  sub: { color: "#4A6FA5", textAlign: "center", fontSize: 13, margin: 0 },
  divider: { height: 1, background: "#1E3A5F", margin: "4px 0" },
  input: { background: "#0B1A2E", border: "1px solid #1E3A5F", borderRadius: 10, padding: "13px 16px", color: "#F0F4FF", fontSize: 16, outline: "none", fontFamily: "inherit" },
  btn: { background: "linear-gradient(90deg,#1A6BFF,#00C2FF)", border: "none", borderRadius: 10, padding: "14px", color: "#fff", fontSize: 16, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" },
  error: { color: "#FF4D6A", fontSize: 13, textAlign: "center", margin: 0 },
};