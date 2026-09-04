// 승객앱 QR 탑승 노출 (2026-09-04 배시현 개선요청 `ELDcdSFD…`)
//
// 요청: "승객어플 홈 화면 중 QR탑승을 노출 안 시킬 수 있게 관리자가 설정 가능하도록".
//   첨부는 채드윅 홈 화면의 우하단 `QR 탑승` 버튼을 가리켰지만, **하단 탭바의 `탑승` 탭도
//   같이 숨긴다** — 버튼만 감추고 탭을 남기면 승객이 그대로 스캔 화면에 들어가므로
//   "노출 안 함"이 성립하지 않는다(반쪽 상태는 다음 문의로 돌아온다).
//
// 🔴 **폴러리티가 다른 옵션들과 반대다.** `homepage`·`tagSound`·`inquiry` 는 신규 기능이라
//   `부재 = 꺼짐`이지만, QR 탑승은 **이미 모든 거래처에 보이던 기능**이다. 그래서 여기만
//   `부재 = 노출`이고, 숨기려면 관리자가 명시적으로 꺼야 한다(기존 거래처 회귀 0).
//   판정을 `enabled === true` 로 베끼면 배포 순간 전 거래처에서 QR 탑승이 사라진다.
//
// ⚠ 이 스위치는 **고정 QR 경로(`/board?c=&v=`)를 막지 않는다.** 그건 외부 카메라로 여는
//   별도 화면이라 승객앱 탭과 무관하다. 그 경로까지 닫아야 하면 별건으로 다룬다.
//
// 이 모듈은 **순수**(Firebase import 0) — 격리 테스트가 그대로 태운다.

/**
 * `partnerCodes/{code}` 문서 → QR 탑승 노출 설정.
 * 🔴 **부재·모르는 값 = 노출**(현행 유지). `visible === false` 일 때만 숨긴다.
 * @param {object|null|undefined} codeData
 * @returns {{visible:boolean}}
 */
export function resolveQrBoardingConfig(codeData) {
  const raw = codeData && typeof codeData === "object" ? codeData.qrBoarding : null;
  if (!raw || typeof raw !== "object") return { visible: true };
  return { visible: raw.visible !== false };
}
