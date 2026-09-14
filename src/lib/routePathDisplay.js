// 승객앱 노선 경로(파란 선) 노출 (2026-09-15 배시현 개선요청 `l0hDzQv1…`)
//
// 요청: "관리자가 그려놓은 버스경로(파란색)를 키고 끌 수 있게". 채드윅은 고정 경로라 필요하지만
//   365일 3교대마다 노선이 달라지는 거래처(온세미 등)는 그려 둔 선이 그날 실제 길과 달라 혼선을 준다.
//
// 🔴 **부재 = 노출(현행)** — `qrBoarding` 과 같은 폴러리티. 이미 모든 거래처에 보이던 선이라
//   `enabled === true` 로 베끼면 배포 순간 전 거래처 지도에서 경로가 사라진다.
//
// 🔴 **표시만 끈다.** 진행거리·ETA 계산은 계속 routePath 를 쓴다(계산까지 끄면 도착 예측이 달라져
//   요청 범위를 넘는다). 끄면 정류장 직선 폴백도 그리지 않는다 — 직선도 "이 길로 간다"로 읽힌다.
//
// 이 모듈은 **순수**(Firebase import 0) — 격리 테스트가 그대로 태운다.

/**
 * `partnerCodes/{code}` 문서 → 노선 경로 표시 설정.
 * 🔴 부재·모르는 값 = 노출. `visible === false` 일 때만 숨긴다.
 * @param {object|null|undefined} codeData
 * @returns {{visible:boolean}}
 */
export function resolveRoutePathDisplayConfig(codeData) {
  const raw = codeData && typeof codeData === "object" ? codeData.routePathDisplay : null;
  if (!raw || typeof raw !== "object") return { visible: true };
  return { visible: raw.visible !== false };
}
