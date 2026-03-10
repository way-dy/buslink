import { useState, useEffect } from "react";
import { auth, db } from "./firebase";
import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import DriverApp from "./pages/DriverApp";
import AdminApp from "./pages/AdminApp";
import LoginApp from "./pages/LoginApp";

function App() {
  const [user, setUser] = useState(null);
  const [role, setRole] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (u) {
        const snap = await getDoc(doc(db, "users", u.uid));
        if (snap.exists()) {
          setRole(snap.data().role);
        } else {
          setRole("driver");
        }
        setUser(u);
      } else {
        setUser(null);
        setRole(null);
      }
      setLoading(false);
    });
    return () => unsub();
  }, []);

  if (loading) return (
    <div style={{ minHeight:"100vh", background:"#0B1A2E", display:"flex", alignItems:"center", justifyContent:"center", color:"#00C2FF", fontSize:18 }}>
      로딩 중...
    </div>
  );

  // 미로그인 → 로그인 화면
  if (!user) return <LoginApp />;

  // 역할에 따라 분기
  if (role === "admin" || role === "superadmin") return <AdminApp user={user} />;
  return <DriverApp />;
}

export default App;