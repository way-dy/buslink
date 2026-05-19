// src/components/PermissionGate.js — 권한 경고 배너 + 차단 안내 모달 + PWA 설치 버튼
// ---------------------------------------------------------------------------
// callcenter driver.html 권한 배너/모달/PWA 패턴의 React 재구현(plain HTML 복사 아님).
// 순수 프레젠테이션 + 브라우저 API(usePermissions)만. Firebase import 없음.
// EmployeeApp(/p)·DriverApp(/) 메인 진입 후 상단에 마운트.
// buslink tokens.css 라이트 토큰 사용(콜센터 다크 톤 → 라이트 전환).
// ---------------------------------------------------------------------------
import { useState } from "react";
import { usePermissions } from "../lib/usePermissions";

export default function PermissionGate({ containerStyle }) {
  const {
    perm, notifBad, geoBad, needsBanner, anyDenied,
    installable, requestNotif, requestGeo, promptInstall,
  } = usePermissions();
  const [showModal, setShowModal] = useState(false);
  const hasContent = needsBanner || installable;

  const handleBannerClick = async () => {
    // 어느 한쪽이라도 차단(denied)이면 OS 팝업이 안 뜨므로 안내 모달
    if (anyDenied) { setShowModal(true); return; }
    if (perm.notif === "default") await requestNotif();
    if (perm.geo === "prompt" || perm.geo === "unknown") requestGeo();
  };

  // 표시할 항목 라벨
  const items = [];
  if (notifBad) items.push(perm.notif === "denied" ? "알림(차단됨)" : "알림");
  if (geoBad) items.push(perm.geo === "denied" ? "위치(차단됨)" : "위치");

  return (
    <>
      {hasContent && (
      <div style={containerStyle}>
      {/* ── 권한 경고 배너 ── */}
      {needsBanner && (
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "10px 14px", margin: "0 0 4px",
          background: anyDenied ? "#FDECEC" : "var(--color-primary-soft)",
          border: anyDenied ? "1px solid var(--color-destructive)" : "1px solid var(--color-primary)",
          borderRadius: "var(--radius-12)",
        }}>
          <div style={{ fontSize: 20, flexShrink: 0 }}>{anyDenied ? "🔒" : "🔔"}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: 13, fontWeight: 800,
              color: anyDenied ? "var(--color-destructive)" : "var(--color-primary-deep)",
            }}>
              {items.join(" · ")} 권한 필요
            </div>
            <div style={{ fontSize: 11, color: "var(--color-label-mute)", marginTop: 2, lineHeight: 1.45 }}>
              {anyDenied
                ? "권한이 차단되어 도착 알림·실시간 위치가 동작하지 않습니다. 설정에서 허용해주세요."
                : "버스 도착 알림과 실시간 위치 표시를 위해 필요합니다."}
            </div>
          </div>
          <button onClick={handleBannerClick}
            style={{
              flexShrink: 0, padding: "8px 14px", borderRadius: "var(--radius-8)",
              border: "none", cursor: "pointer", fontFamily: "inherit",
              fontSize: 12, fontWeight: 700, color: "#fff",
              background: anyDenied ? "var(--color-destructive)" : "var(--color-primary)",
            }}>
            {anyDenied ? "설정 방법" : "허용하기"}
          </button>
        </div>
      )}

      {/* ── PWA 설치 버튼 (설치 가능 + 미설치 시) ── */}
      {installable && (
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "10px 14px", margin: "0 0 4px",
          background: "var(--color-bg)",
          border: "1px solid var(--color-line)", borderRadius: "var(--radius-12)",
          boxShadow: "var(--shadow-emphasize)",
        }}>
          <div style={{ fontSize: 22, flexShrink: 0 }}>📲</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: "var(--color-label)" }}>홈 화면에 앱 추가</div>
            <div style={{ fontSize: 11, color: "var(--color-label-mute)", marginTop: 2 }}>
              빠른 실행을 위해 설치하세요
            </div>
          </div>
          <button onClick={promptInstall}
            style={{
              flexShrink: 0, padding: "8px 14px", borderRadius: "var(--radius-8)",
              border: "1px solid var(--color-primary)", cursor: "pointer",
              fontFamily: "inherit", fontSize: 12, fontWeight: 700,
              color: "var(--color-primary-deep)", background: "var(--color-primary-soft)",
            }}>
            설치
          </button>
        </div>
      )}
      </div>
      )}

      {/* ── 차단 상태 안내 모달 (콜센터 driver.html 문구 재사용) ── */}
      {showModal && (
        <div onClick={() => setShowModal(false)}
          style={{
            position: "fixed", inset: 0, zIndex: 1000,
            background: "rgba(0,0,0,0.5)",
            display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
          }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--color-bg)", borderRadius: "var(--radius-16)",
              padding: "20px 18px", maxWidth: 380, width: "100%",
              maxHeight: "85vh", overflowY: "auto", boxShadow: "var(--shadow-heavy)",
            }}>
            <h3 style={{ margin: "0 0 6px", fontSize: 16, fontWeight: 800, color: "var(--color-label)" }}>
              🔒 권한 허용 방법
            </h3>
            <p style={{ margin: "0 0 14px", fontSize: 12, color: "var(--color-label-mute)", lineHeight: 1.5 }}>
              이전에 권한을 차단하셨거나, 브라우저가 자동으로 차단했습니다.<br />
              아래 절차로 직접 허용해주세요.
            </p>

            <h4 style={{ margin: "0 0 6px", fontSize: 13, fontWeight: 700, color: "var(--color-primary-deep)" }}>
              🤖 안드로이드 (Chrome / 삼성 인터넷)
            </h4>
            <ol style={{ margin: "0 0 14px", paddingLeft: 18, fontSize: 12, color: "var(--color-label)", lineHeight: 1.7 }}>
              <li>주소창 좌측 <b>🔒 자물쇠</b> 또는 <b>ⓘ</b> 아이콘 탭</li>
              <li><b>권한</b> → <b>알림 / 위치</b> 항목을 <b>허용</b>으로 변경</li>
              <li>또는 <b>설정 → 앱 → Chrome → 권한</b>에서 변경</li>
              <li>변경 후 이 화면 새로고침</li>
            </ol>

            <h4 style={{ margin: "0 0 6px", fontSize: 13, fontWeight: 700, color: "var(--color-primary-deep)" }}>
              🍎 아이폰 (Safari)
            </h4>
            <ol style={{ margin: "0 0 16px", paddingLeft: 18, fontSize: 12, color: "var(--color-label)", lineHeight: 1.7 }}>
              <li><b>설정 앱</b> → <b>Safari</b> 진입</li>
              <li><b>위치 / 알림</b> 항목을 <b>허용</b>으로 변경</li>
              <li>또는 <b>설정 → 개인정보 → 위치 → Safari 웹사이트</b></li>
              <li>변경 후 Safari로 돌아와 새로고침</li>
            </ol>

            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setShowModal(false)}
                style={{
                  flex: 1, padding: "10px", borderRadius: "var(--radius-8)",
                  border: "1px solid var(--color-line)", cursor: "pointer",
                  fontFamily: "inherit", fontSize: 13, fontWeight: 600,
                  color: "var(--color-label-mute)", background: "var(--color-bg-soft)",
                }}>
                닫기
              </button>
              <button onClick={() => window.location.reload()}
                style={{
                  flex: 1, padding: "10px", borderRadius: "var(--radius-8)",
                  border: "none", cursor: "pointer",
                  fontFamily: "inherit", fontSize: 13, fontWeight: 700,
                  color: "#fff", background: "var(--color-primary)",
                }}>
                다시 시도
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
