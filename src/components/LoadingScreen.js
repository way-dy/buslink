// 공통 로딩 화면 (순수 프레젠테이션 — Firebase/로직 import 0).
// App.js 초기 로딩 게이트 전역 사용(관제·기사·직원·승객·협력사). 밝은 브랜드 테마 +
// 버스 스피너 + 따뜻한 문구. 다크 잔존(#0B1A2E "지도 로딩 중...") 교체(2026-06-08).
import React from "react";

export default function LoadingScreen({ message = "잠시만요, 준비하고 있어요", sub }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 20,
        background: "linear-gradient(165deg, #EAF1FF 0%, #FFFFFF 55%)",
        color: "var(--color-label, #171719)",
        fontFamily: "var(--font-base)",
        padding: 24,
        textAlign: "center",
      }}
    >
      {/* 회전 스피너 + 살짝 떠오르는 버스 */}
      <div style={{ position: "relative", width: 76, height: 76 }}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "50%",
            border: "4px solid var(--color-primary-soft, #EAF1FF)",
            borderTopColor: "var(--color-primary, #0066FF)",
            animation: "blspin 0.9s linear infinite",
          }}
        />
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 32,
            animation: "blbob 1.6s ease-in-out infinite",
          }}
          aria-hidden="true"
        >
          🚌
        </div>
      </div>

      <div>
        <div
          style={{
            fontSize: 18,
            fontWeight: 800,
            letterSpacing: "-0.02em",
            color: "var(--color-primary-deep, #0047B3)",
          }}
        >
          BusLink
        </div>
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            marginTop: 7,
            color: "var(--color-label, #171719)",
          }}
        >
          {message}
        </div>
        <div
          style={{
            fontSize: 12,
            marginTop: 4,
            color: "var(--color-label-mute, rgba(46,47,51,0.62))",
          }}
        >
          {sub || "잠시만 기다려 주세요"}
        </div>
      </div>
    </div>
  );
}
