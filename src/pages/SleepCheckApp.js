// 슬리핑 차일드 확인 화면 (2026-08-18 배시현 건의 `Eg8ZbQTMmPR6AAYo4fp0`)
//
// 차량 **맨 뒷좌석에 붙인 QR** 을 기사가 스캔하면 열리는 한 장짜리 화면.
// `/sleep?c={companyId}&v={vehicleId}` — 익명 진입(기사 로그인 불요. 그 QR 은 차 안에만 있다).
//
// 🔴 이 화면의 목적은 "버튼을 눌렀다"가 아니라 **기사가 맨 뒤까지 걸어갔다**는 것이다.
//    그래서 앱 안(기사앱)에는 같은 버튼을 만들지 않는다 — 앉아서 누를 수 있으면 의미가 없다.
// 🔴 화면은 운행 중 차 안에서 **장갑 낀 손으로 한 번에** 눌러야 한다: 버튼 하나·큰 글씨·
//    성공/실패가 색으로 즉시 갈리게. 입력 항목 0개.
import { useState, useEffect, useCallback } from "react";
import { auth } from "../firebase";
import { signInAnonymously } from "firebase/auth";
import { getFunctions, httpsCallable } from "firebase/functions";
import { BusLinkLogo, Icon } from "../components/ui";

const functions = getFunctions(undefined, "us-central1");
const getParam = (k) => new URLSearchParams(window.location.search).get(k);

const S = {
  wrap: { minHeight: "100dvh", background: "var(--color-bg-soft)", display: "flex", flexDirection: "column",
    alignItems: "center", justifyContent: "center", padding: 20, gap: 18, fontFamily: "var(--font-base)" },
  card: { width: "100%", maxWidth: 420, background: "var(--color-bg)", border: "1px solid var(--color-line)",
    borderRadius: 16, padding: "26px 20px", textAlign: "center", boxShadow: "var(--shadow-float)" },
  title: { fontSize: 20, fontWeight: 800, color: "var(--color-label)", marginTop: 12 },
  sub: { fontSize: 13, color: "var(--color-label-mute)", marginTop: 8, lineHeight: 1.6, whiteSpace: "pre-line" },
  btn: { width: "100%", marginTop: 22, padding: "20px 16px", fontSize: 19, fontWeight: 800, color: "#fff",
    background: "var(--color-primary)", border: "none", borderRadius: 14, cursor: "pointer",
    fontFamily: "inherit", boxShadow: "var(--shadow-emphasize)" },
  meta: { fontSize: 12, color: "var(--color-label-alt)", marginTop: 14, lineHeight: 1.6 },
};

export default function SleepCheckApp() {
  const companyId = getParam("c");
  const vehicleId = getParam("v");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);   // { alreadyChecked, routeName, vehicleNo }
  const [err, setErr] = useState("");

  useEffect(() => {
    signInAnonymously(auth).then(() => setReady(true)).catch(() => setReady(true));
  }, []);

  const submit = useCallback(async () => {
    if (busy) return;
    setBusy(true); setErr("");
    try {
      const call = httpsCallable(functions, "recordSleepingCheck");
      const res = await call({ companyId, vehicleId, via: "qr" });
      setDone(res.data || {});
    } catch (e) {
      // 오늘 배차가 없거나(운행 전) 통신 실패 — 기사에게 그대로 보여 준다.
      setErr(e?.message || "확인을 기록하지 못했습니다. 다시 눌러주세요.");
    } finally {
      setBusy(false);
    }
  }, [busy, companyId, vehicleId]);

  if (!companyId || !vehicleId) return (
    <div style={S.wrap}>
      <BusLinkLogo size={26} />
      <div style={S.card}>
        <div style={{ color: "var(--color-destructive)" }}><Icon name="close" size={40} stroke={1.8} /></div>
        <div style={S.title}>확인용 QR이 아닙니다</div>
        <div style={S.sub}>차량 뒷좌석에 붙은 확인용 QR을 다시 스캔해주세요.</div>
      </div>
    </div>
  );

  if (done) return (
    <div style={S.wrap}>
      <BusLinkLogo size={26} />
      <div style={{ ...S.card, borderColor: "var(--color-positive)" }}>
        <div style={{ color: "var(--color-positive)" }}><Icon name="check" size={46} stroke={2} /></div>
        <div style={S.title}>{done.alreadyChecked ? "이미 확인되었습니다" : "확인되었습니다"}</div>
        <div style={S.sub}>차 안에 남은 사람이 없는 것으로 기록했습니다.</div>
        <div style={S.meta}>
          {done.vehicleNo || ""}{done.routeName ? ` · ${done.routeName}` : ""}
          {done.dispatchDate ? `\n${done.dispatchDate}` : ""}
        </div>
      </div>
    </div>
  );

  return (
    <div style={S.wrap}>
      <BusLinkLogo size={26} />
      <div style={S.card}>
        <div style={{ color: "var(--color-primary)" }}><Icon name="bus" size={40} stroke={1.6} /></div>
        <div style={S.title}>빈 차 확인</div>
        <div style={S.sub}>맨 뒷좌석까지 둘러보신 뒤{"\n"}아래 버튼을 눌러주세요.</div>
        <button style={{ ...S.btn, opacity: busy || !ready ? 0.6 : 1 }} onClick={submit} disabled={busy || !ready}>
          {busy ? "기록 중…" : "확인 완료"}
        </button>
        {err && (
          <div style={{ marginTop: 14, fontSize: 13, fontWeight: 700, color: "var(--color-destructive)", whiteSpace: "pre-line" }}>
            {err}
          </div>
        )}
      </div>
    </div>
  );
}
