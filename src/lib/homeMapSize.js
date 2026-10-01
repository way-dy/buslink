// 승객앱 홈 지도 크게 보기 (2026-10-01 채드윅 시스템 관련 미팅 — "지도 확대 온오프")
//
// 배경: 2026-08-28 세브란스 요청("홈화면 QR탑승이 한 페이지에")으로 홈 지도는 **남는 공간만** 쓴다
//   (EmployeeApp HomeTab `flex: '1 1 0', minHeight: 150`). 채드윅은 정반대로 지도를 크게 원한다.
//   그래서 전역 레이아웃을 바꾸지 않고 거래처 스위치로 가른다.
//
// 🔴 **부재 = 현행(작게)** — qrBoarding·routePathDisplay 와 **반대** 폴러리티. 이건 새로 생기는
//   동작이라 `large === true` 를 명시한 거래처에서만 켠다. 반대로 하면 배포 순간 세브란스의
//   QR 버튼이 다시 접힘 아래로 밀린다(headless_check_home_qr_fold.cjs 가 막던 회귀).
//
// 🔴 **지도 바닥값을 올리는 방식은 쓰지 않는다**(2026-10-01 실측으로 기각): `minHeight: 46dvh` 로
//   지도를 키우면 360x640 에서 **노선도가 0px** 가 된다 — 정류장은 노선도에서 고르므로 그러면
//   내 정류장을 못 고르고 QR 탑승 버튼도 영영 안 나온다. 대신 **노선도의 높이를 묶는다**:
//   켜면 노선도는 LIST_MAX_PX 까지만 차지하고(넘치면 그 안에서 스크롤) 남는 칸은 전부 지도가
//   가져간다. 노선도는 LIST_MIN_PX 아래로는 줄지 않는다(작은 폰에서도 정류장 줄이 남는다).
//   QR 패널·상단 밴드는 그대로(flexShrink 0).
//
// 이 모듈은 **순수**(Firebase import 0) — 격리 테스트가 그대로 태운다.

export const LIST_MAX_PX = 124; // 안내 문구 + 출발/도착 + 정류장 점 줄이 보이는 높이
export const LIST_MIN_PX = 96;  // 정류장 점 줄까지는 반드시 보인다(선택할 수 있어야 한다)

/**
 * `partnerCodes/{code}` 문서 → 홈 지도 크기 설정.
 * 🔴 부재·모르는 값 = 현행(작게). `large === true` 일 때만 크게.
 * @param {object|null|undefined} codeData
 * @returns {{large:boolean}}
 */
export function resolveHomeMapConfig(codeData) {
  const raw = codeData && typeof codeData === "object" ? codeData.homeMap : null;
  if (!raw || typeof raw !== "object") return { large: false };
  return { large: raw.large === true };
}

/**
 * 홈 노선도 스크롤 영역의 높이 제약. 꺼짐 = 현행 그대로(minHeight 0 · 상한 없음).
 * 지도 컨테이너(`flex:'1 1 0', minHeight:150`)는 어느 쪽에서도 건드리지 않는다.
 * @param {boolean} large
 */
export function homeRouteListBounds(large) {
  return large ? { minHeight: LIST_MIN_PX, maxHeight: LIST_MAX_PX } : { minHeight: 0 };
}
