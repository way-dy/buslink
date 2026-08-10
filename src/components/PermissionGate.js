// src/components/PermissionGate.js — 권한 경고 배너 + 차단 안내 모달 + PWA 설치 버튼
// ---------------------------------------------------------------------------
// callcenter driver.html 권한 배너/모달/PWA 패턴의 React 재구현(plain HTML 복사 아님).
// 순수 프레젠테이션 + 브라우저 API(usePermissions)만. Firebase import 없음.
// EmployeeApp(/p)·DriverApp(/) 메인 진입 후 상단에 마운트.
// buslink tokens.css 라이트 토큰 사용(콜센터 다크 톤 → 라이트 전환).
// ---------------------------------------------------------------------------
import { useState } from "react";
import { usePermissions } from "../lib/usePermissions";
import { Icon } from "./ui";

// 🔴 이 배너는 **누락되면 안 되는 메시지**다(way 2026-08-10). 권한이 없으면 도착 알림도
//    실시간 위치도 동작하지 않는데, 사용자는 "앱이 고장났다"로만 인지한다.
//    그래서 아래 규칙을 지킨다:
//      ① `needsBanner` 면 **어떤 경우에도 무언가는 반드시 렌더**한다(조건부 숨김 금지).
//      ② 차단(`anyDenied`)은 **항상 큰 빨간 카드** — 압축 대상이 아니다.
//      ③ 압축(한 줄)은 아직 안 물어본 상태에만 적용하고, 그때도 **행동 버튼을 유지**한다.
//    ⚠ 설치 안내는 여기서 하지 않는다 — `InstallPrompt` 로 일원화(스누즈·iOS Safari 커버).
//       예전엔 둘 다 카드를 띄워 홈 상단에 회색 카드가 두 장 쌓였다.
export default function PermissionGate({ containerStyle }) {
  const {
    perm, notifBad, geoBad, needsBanner, anyDenied,
    requestNotif, requestGeo,
  } = usePermissions();
  const [showModal, setShowModal] = useState(false);
  const hasContent = needsBanner;
  // 아직 아무 문제도 아닌 상태(물어보지 않았을 뿐)는 한 줄로 — 단 버튼은 남긴다.
  const compact = needsBanner && !anyDenied;

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
      {/* ② 차단됨 — 실제 문제 상황이라 크게. 압축하지 않는다. */}
      {needsBanner && anyDenied && (
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "10px 14px", margin: "0 0 4px",
          background: "#FDECEC",
          border: "1px solid var(--color-destructive)",
          borderRadius: "var(--radius-12)",
        }}>
          <div style={{ flexShrink: 0, color: "var(--color-destructive)", display: "inline-flex" }}>
            <Icon name="bell" size={20} stroke={1.9} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: "var(--color-destructive)" }}>
              {items.join(" · ")} 권한 필요
            </div>
            <div style={{ fontSize: 11, color: "var(--color-label-mute)", marginTop: 2, lineHeight: 1.45 }}>
              권한이 차단되어 도착 알림·실시간 위치가 동작하지 않습니다. 설정에서 허용해주세요.
            </div>
          </div>
          <button onClick={handleBannerClick}
            style={{
              flexShrink: 0, height: 32, padding: "0 13px", borderRadius: "var(--radius-8)",
              border: "none", cursor: "pointer", fontFamily: "inherit",
              fontSize: 12, fontWeight: 700, color: "#fff",
              background: "var(--color-destructive)",
            }}>
            설정 방법
          </button>
        </div>
      )}

      {/* ③ 아직 안 물어본 상태 — 한 줄로. 🔴 버튼은 남긴다(여기서 허용을 받는다). */}
      {compact && (
        <div style={{
          display: "flex", alignItems: "center", gap: 9,
          padding: "7px 12px", margin: "0 0 4px",
          background: "var(--color-primary-soft)",
          border: "1px solid var(--color-primary)",
          borderRadius: "var(--radius-pill)",
        }}>
          <div style={{ flexShrink: 0, color: "var(--color-primary-deep)", display: "inline-flex" }}>
            <Icon name="bell" size={15} stroke={2} />
          </div>
          <div style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 700, color: "var(--color-primary-deep)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            도착 알림을 받으려면 {items.join(" · ")} 권한이 필요합니다
          </div>
          <button onClick={handleBannerClick}
            style={{
              flexShrink: 0, height: 26, padding: "0 12px", borderRadius: "var(--radius-pill)",
              border: "none", cursor: "pointer", fontFamily: "inherit",
              fontSize: 11.5, fontWeight: 700, color: "#fff",
              background: "var(--color-primary)",
            }}>
            허용
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
              권한 허용 방법
            </h3>
            <p style={{ margin: "0 0 14px", fontSize: 12, color: "var(--color-label-mute)", lineHeight: 1.5 }}>
              이전에 권한을 차단하셨거나, 브라우저가 자동으로 차단했습니다.<br />
              아래 절차로 직접 허용해주세요.
            </p>

            <h4 style={{ margin: "0 0 6px", fontSize: 13, fontWeight: 700, color: "var(--color-primary-deep)" }}>
              안드로이드 (Chrome / 삼성 인터넷)
            </h4>
            <ol style={{ margin: "0 0 14px", paddingLeft: 18, fontSize: 12, color: "var(--color-label)", lineHeight: 1.7 }}>
              <li>주소창 좌측 <b>자물쇠</b> 또는 <b>ⓘ</b> 아이콘 탭</li>
              <li><b>권한</b> → <b>알림 / 위치</b> 항목을 <b>허용</b>으로 변경</li>
              <li>또는 <b>설정 → 앱 → Chrome → 권한</b>에서 변경</li>
              <li>변경 후 이 화면 새로고침</li>
            </ol>

            <h4 style={{ margin: "0 0 6px", fontSize: 13, fontWeight: 700, color: "var(--color-primary-deep)" }}>
              아이폰 (Safari)
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
