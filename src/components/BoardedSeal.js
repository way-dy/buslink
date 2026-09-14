// 탑승 완료 «살아있는 화면» 표시 — 2026-09-14 신촌세브란스병원 요청(최우석 매니저 전달).
//
// 배경: 승객이 완료 화면을 기사에게 보여주고 타는데, 그 화면을 캡처해 두었다가
//       다음에 보여주는 부정승차가 생겼다. 캡처는 멈춰 있으므로 «움직이는가»와
//       «지금 시각이 흐르는가» 두 가지로 기사가 한눈에 가를 수 있게 한다.
//   ① 체크 둘레 고리가 계속 돈다  ② 빛 띠가 가로질러 흐른다
//   ③ 현재 시각이 초 단위로 흐른다  ④ 탑승 후 경과 시간이 늘어난다
//
// 🔴 회귀 가드(복원 금지)
//   ⓐ 시각을 렌더 시점 `new Date()` 한 번으로 되돌리지 말 것 — 멈춘 시각은 캡처와 같다.
//   ⓑ 탑승 시각은 마운트 때 한 번만 잡는다(useState 초기값). 매 틱 새로 잡으면 경과가 늘 0초다.
//   ⓒ prefers-reduced-motion 으로 애니메이션을 끄지 말 것 — 멈추면 이 기능이 사라진다.
//   ⓓ 키프레임(blsealspin/sweep/beat)은 전부 transform 을 쓴다 — 인라인 transform 이 있는
//      요소에 걸지 말고 전용 요소에만 건다(2026-08-04 진척바 결함과 같은 클래스).
//   ⓔ 순수 프레젠테이션 — Firebase·세션 import 금지(components/ui 규칙과 같다).
import { useEffect, useState } from "react";

const GREEN = "#007A29";

function formatClock(ms) {
  return new Date(ms).toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

export function formatElapsed(sec) {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 ${s % 60}초`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}

export default function BoardedSeal({ title, iconSize = 80, children }) {
  const [boardedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  const ring = iconSize + 16;

  return (
    <div data-boarded-seal style={{ position: "relative", width: "100%", maxWidth: 320, overflow: "hidden",
      borderRadius: "var(--radius-16)", padding: "18px 12px 16px", display: "flex", flexDirection: "column",
      alignItems: "center", gap: 10 }}>
      {/* ② 빛 띠 — 전용 요소(인라인 transform 없음) */}
      <div aria-hidden style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: "34%", pointerEvents: "none",
        background: "linear-gradient(90deg, rgba(0,191,64,0) 0%, rgba(0,191,64,.16) 50%, rgba(0,191,64,0) 100%)",
        animation: "blsealsweep 2.2s linear infinite" }} />

      <div style={{ position: "relative", width: ring, height: ring, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {/* ① 도는 고리 — 전용 요소 */}
        <div data-seal-ring aria-hidden style={{ position: "absolute", inset: 0, borderRadius: "50%",
          border: "3px solid rgba(0,191,64,.18)", borderTopColor: "var(--color-positive)", borderRightColor: "var(--color-positive)",
          animation: "blsealspin 1.1s linear infinite" }} />
        <div style={{ width: iconSize, height: iconSize, borderRadius: "50%", background: "#E6F7EB",
          border: "2px solid var(--color-positive)", display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: Math.round(iconSize * 0.45), color: GREEN, animation: "blsealbeat 1.4s ease-in-out infinite" }}>✓</div>
      </div>

      <div style={{ fontSize: 22, fontWeight: 800, color: GREEN, textAlign: "center" }}>{title}</div>

      {/* ③ 흐르는 현재 시각 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--color-positive)",
          animation: "busblink 1s ease-in-out infinite" }} />
        <span data-seal-clock style={{ fontSize: 26, fontWeight: 800, color: "var(--color-label)",
          fontVariantNumeric: "tabular-nums", letterSpacing: "-0.01em" }}>{formatClock(now)}</span>
      </div>

      {/* ④ 탑승 후 경과 */}
      <div data-seal-elapsed style={{ fontSize: 12, color: "var(--color-label-mute)", fontVariantNumeric: "tabular-nums" }}>
        {formatClock(boardedAt)} 탑승 · {formatElapsed((now - boardedAt) / 1000)} 경과
      </div>

      {children}
    </div>
  );
}
