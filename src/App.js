import { useState, useEffect } from "react";
import { auth, db } from "./firebase";
import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import DriverApp from "./pages/DriverApp";
import AdminApp from "./pages/AdminApp";

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
          setRole("driver"); // users 문서 없으면 기사로 기본값
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

  if (!user) return <AdminApp />;
return <AdminApp />;
  
  if (role === "admin" || role === "superadmin") return <AdminApp user={user} />;

  return <DriverApp />;
}

export default App;

