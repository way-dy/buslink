import React, { useState } from "react";

/**
 * 승객앱 도움말 시트 (2026-08-10 경쟁사 대조에서 도입)
 *
 * 순수 프레젠테이션 — Firebase·로직 import 금지(components/ui 규약과 동일).
 * 화면(탭)별 사용법 + **"안 보여요/안 와요" 문제 해결**을 한곳에.
 *
 * 🔴 문구 규칙: **지금 화면에 실제로 있는 것만** 적는다.
 *    없는 기능을 도움말이 약속하면 그게 곧 문의가 된다
 *    (= 사용자 대면 안내는 지금 보이는 것만).
 *    화면을 바꿀 때 이 파일도 같이 고칠 것.
 */

// 탭 id → 사용법 단계. 여기에 없는 탭은 공통 문제해결만 보여준다.
const GUIDES = {
  home: {
    title: "홈 화면",
    steps: [
      ["지금 타는 노선", "맨 위에 내 노선 이름이 나옵니다. 다른 노선을 보려면 노선 이름 옆 “노선 변경”을 누르세요."],
      ["버스 위치", "지도의 버스 아이콘이 실시간 위치입니다. 운행 전이거나 표시 시간대가 아니면 버스가 없습니다."],
      ["내 정류장 지정", "지도에서 내가 타는 정류장을 누른 뒤 “이 정류장을 내 정류장으로 설정”을 누르세요. 버스가 2정거장·1정거장 앞에 오면 알림이 옵니다."],
      ["도착 예정 시각", "정류장마다 계획 시각과 예상 시각이 함께 나옵니다. 예상은 실제 운행 상황에 따라 계속 바뀝니다."],
    ],
  },
  routes: {
    title: "노선 탭",
    steps: [
      ["노선 찾기", "위 검색창에 노선 이름을 넣거나 “출근 / 퇴근” 칩으로 거를 수 있습니다."],
      ["시간표 보기", "“시간표”를 누르면 출발 시각 순으로 한 번에 볼 수 있습니다."],
      ["즐겨찾기", "노선 카드 오른쪽의 별을 누르면 위쪽에 고정됩니다."],
      ["탑승 위치 확인", "노선을 누르면 정류장 목록 · 실시간 지도 · 거리뷰를 볼 수 있습니다. 거리뷰는 실제 거리 사진이라 어디서 타는지 눈으로 확인됩니다."],
    ],
  },
  notices: {
    title: "공지 탭",
    steps: [
      ["공지 보기", "관리자와 담당 협력사가 보낸 공지가 최신순으로 쌓입니다."],
      ["긴급 공지", "빨간 공지는 긴급입니다. 앱을 열면 전체 화면으로 한 번 뜹니다."],
    ],
  },
  scan: {
    title: "탑승 탭",
    steps: [
      ["QR로 탑승", "기사님 휴대폰의 QR 또는 차량에 부착된 QR을 스캔하면 탑승 처리됩니다."],
      ["사원증(NFC)", "NFC 사원증을 쓰는 회사는 기사님 단말에 카드를 대면 됩니다. 카드 등록은 담당자에게 요청하세요."],
      ["중복 걱정 없음", "같은 차량에 두 번 찍어도 한 번만 기록됩니다."],
    ],
  },
  settings: {
    title: "설정 탭",
    steps: [
      ["알림", "도착 임박 알림은 “내 정류장”을 지정해야 옵니다. 지정 상태를 여기서 확인할 수 있습니다."],
      ["비밀번호", "처음 받은 비밀번호는 본인 것으로 바꿔 쓰세요."],
      ["앱처럼 쓰기", "홈 화면에 추가하면 실행이 빠르고 알림도 더 잘 도착합니다."],
    ],
  },
};

// 실제로 가장 많이 오는 문의 — 화면에 이유를 못 적는 상황을 여기서 받는다.
const TROUBLE = [
  {
    q: "노선이 화면에 안 나와요",
    a: [
      "노선마다 **표시 시간대**가 정해져 있습니다. 운행 시간 전후로는 표시되지 않습니다.",
      "소속된 협력사(회사·학교)의 노선만 보입니다. 다른 곳 노선은 나오지 않습니다.",
      "담당자가 아직 노선을 등록하지 않았을 수 있습니다.",
      "노선 탭 위쪽 검색어나 칩이 걸려 있으면 지워 보세요.",
    ],
  },
  {
    q: "버스가 지도에 안 보여요",
    a: [
      "기사님이 아직 운행을 시작하지 않았을 수 있습니다.",
      "운행 시작 직후에는 위치가 잡히기까지 잠시 걸립니다.",
      "표시 시간대가 아니면 안내 문구와 함께 감춰집니다.",
      "그래도 안 보이면 화면 위 “↻ 새로고침”을 눌러 주세요.",
    ],
  },
  {
    q: "도착 알림이 안 와요",
    a: [
      "설정 탭에서 **내 정류장이 지정되어 있는지** 먼저 확인하세요. 지정하지 않으면 알림이 가지 않습니다.",
      "설정 탭 “알림 진단”에서 권한이 “허용”인지 확인하고, 아니면 “알림 재발급”을 눌러 주세요.",
      "휴대폰 절전 기능이 앱을 잠재우면 알림이 늦거나 빠질 수 있습니다(설정 탭 안내 참고).",
    ],
  },
  {
    q: "탑승이 안 찍혀요",
    a: [
      "선택한 노선과 다른 차량의 QR을 찍으면 막힙니다. 노선을 먼저 확인하세요.",
      "오늘 그 차량에 운행 배차가 없으면 처리되지 않습니다.",
      "카메라 권한이 꺼져 있으면 스캔 화면이 뜨지 않습니다.",
    ],
  },
];

// **굵게** 만 지원하는 최소 강조(마크업 주입 없이 렌더 — dangerouslySetInnerHTML 금지)
function withBold(text, key) {
  const parts = String(text).split(/\*\*(.+?)\*\*/g);
  return parts.map((p, i) =>
    i % 2 === 1
      ? <b key={`${key}-b${i}`} style={{ color: "var(--color-label)" }}>{p}</b>
      : <React.Fragment key={`${key}-t${i}`}>{p}</React.Fragment>
  );
}

export default function HelpSheet({ tab, onClose }) {
  const guide = GUIDES[tab] || null;
  const [openQ, setOpenQ] = useState(null);

  return (
    // 🔴 배경 클릭으로 닫는다 — 읽기 전용 시트라 폐기될 입력이 없다
    //    (입력을 품은 모달은 바깥 클릭으로 닫지 않는 것이 이 저장소 규약).
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "var(--color-overlay)", zIndex: 250,
        display: "flex", flexDirection: "column", justifyContent: "flex-end",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--color-bg)", borderRadius: "20px 20px 0 0", width: "100%",
          maxHeight: "88dvh", display: "flex", flexDirection: "column", boxShadow: "var(--shadow-heavy)",
        }}
      >
        {/* 핸들 + 헤더 */}
        <div style={{ padding: "12px 16px 10px", borderBottom: "1px solid var(--color-line)", flexShrink: 0 }}>
          <div style={{ width: 36, height: 4, background: "var(--color-line)", borderRadius: 2, margin: "0 auto 10px" }} />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: "var(--color-label)" }}>
              도움말{guide ? ` · ${guide.title}` : ""}
            </div>
            <button
              onClick={onClose}
              style={{
                background: "var(--color-bg-soft)", border: "1px solid var(--color-line)",
                borderRadius: "var(--radius-8)", padding: "6px 12px", color: "var(--color-label-mute)",
                cursor: "pointer", fontFamily: "inherit", fontSize: 12, flexShrink: 0,
              }}
            >
              닫기
            </button>
          </div>
        </div>

        <div style={{ overflowY: "auto", padding: "14px 16px 24px", flex: 1 }}>
          {/* ── 이 화면 사용법 ── */}
          {guide && (
            <div style={{ marginBottom: 22 }}>
              {guide.steps.map(([t, d], i) => (
                <div key={t} style={{ display: "flex", gap: 11, marginBottom: 13 }}>
                  <div
                    style={{
                      width: 22, height: 22, borderRadius: "50%", flexShrink: 0, marginTop: 1,
                      background: "var(--color-primary)", color: "#fff", fontSize: 11, fontWeight: 700,
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}
                  >
                    {i + 1}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--color-label)", marginBottom: 2 }}>{t}</div>
                    <div style={{ fontSize: 12.5, color: "var(--color-label-mute)", lineHeight: 1.55, wordBreak: "keep-all" }}>{d}</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── 문제 해결 ── */}
          <div style={{ fontSize: 13, fontWeight: 800, color: "var(--color-label)", marginBottom: 9 }}>
            이럴 땐 어떻게 하나요?
          </div>
          {TROUBLE.map((t) => {
            const open = openQ === t.q;
            return (
              <div
                key={t.q}
                style={{
                  border: "1px solid var(--color-line)", borderRadius: "var(--radius-12)",
                  marginBottom: 8, overflow: "hidden", background: "var(--color-bg-soft)",
                }}
              >
                <div
                  onClick={() => setOpenQ(open ? null : t.q)}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "11px 12px", cursor: "pointer" }}
                >
                  <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 700, color: "var(--color-label)", wordBreak: "keep-all" }}>
                    {t.q}
                  </div>
                  <span
                    style={{
                      fontSize: 15, fontWeight: 800, color: "var(--color-label-mute)", flexShrink: 0,
                      transform: open ? "rotate(90deg)" : "none", transition: "transform .15s",
                    }}
                  >
                    ›
                  </span>
                </div>
                {open && (
                  <ul style={{ margin: 0, padding: "0 14px 12px 30px" }}>
                    {t.a.map((line, i) => (
                      <li
                        key={i}
                        style={{ fontSize: 12.5, color: "var(--color-label-mute)", lineHeight: 1.6, marginBottom: 5, wordBreak: "keep-all" }}
                      >
                        {withBold(line, `${t.q}-${i}`)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}

          <div style={{ marginTop: 14, fontSize: 11.5, color: "var(--color-label-alt)", lineHeight: 1.6, wordBreak: "keep-all" }}>
            여기서 해결되지 않으면 회사 담당자 또는 셔틀버스 운영사에 문의해 주세요.
          </div>
        </div>
      </div>
    </div>
  );
}
