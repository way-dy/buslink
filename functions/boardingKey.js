// 탑승 멱등 키 — 순수 모듈(Firestore 접근 0 · 테스트가 격리 실행한다).
//
// 🔴 왜 노선이 키에 들어가는가 (2026-09-11 way 신고 · 최우석 실측)
//    예전 키는 `${empNo}__${vehicleId}` 였다 = **직원 1인 × 차량 × 당일 1건**.
//    그런데 통근버스는 **같은 차량이 출근·퇴근을 둘 다 뛴다**. 아침에 탄 사람이 저녁에
//    태깅하면 같은 doc id 에 걸려 「이미 탑승 처리됨」으로 막혔다.
//    실측(2026-09-11 dy001): 차량 44대 중 **22대가 하루 2배차**이고 그 22대 **전부
//    routeId 가 갈린다**(같은 routeId 로 2회차인 차량은 0대) · 그날 오전 기록 보유자
//    **241명**이 저녁에 전원 막힐 상태였다. 부수 피해로 **퇴근 노선 탑승 기록이 통째로
//    비어**(예: 06:30 김포 22명 ↔ 18:00 김포 1명) 탑승률·정류장 통계가 0에 가까웠다.
//
// ⚠ 왜 dispatchId 가 아니라 routeId 인가
//    같은 노선을 하루 여러 회차 도는 차량이 실측상 **0대**다. routeId 면 충분하고,
//    배차 문서가 재생성(`pruneScheduleDispatches`·「지금 펼치기」)돼도 키가 안 흔들린다.
//    dispatchId 를 쓰면 배차를 다시 펼친 순간 같은 사람이 두 번 적재될 수 있다.

// 노선까지 포함한 멱등 doc id. routeId 가 없으면(배차에 routeId 미설정) 옛 키를 그대로 써
// 기존 동작(차량 × 당일 1건)을 유지한다 — 노선을 모르면 갈라 줄 근거가 없다.
function buildBoardingDocId({ empNo, vehicleId, routeId }) {
  const e = String(empNo == null ? "" : empNo).trim();
  const v = String(vehicleId == null ? "" : vehicleId).trim();
  const r = String(routeId == null ? "" : routeId).trim();
  if (!e || !v) return "";
  return r ? `${e}__${v}__${r}` : `${e}__${v}`;
}

// 🔴 전환 유예(옛 키 문서가 같은 노선 재태깅을 막던 폴백)는 2026-09-15 제거했다.
//    boardings 가 날짜별 컬렉션이라 배포 다음 날(9/12)부터 옛 키 문서 자체가 없고,
//    9/11·9/14 실측으로 퇴근 노선 기록이 정상 적재되는 것을 확인했다.

module.exports = {
  buildBoardingDocId,
};
