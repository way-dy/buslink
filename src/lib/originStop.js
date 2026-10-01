// 출발지(기점·index 0) 승객 표시 규칙 — 순수 함수(2026-10-01 배시현 게시판 `Fc8Zs7TD`).
//
// 지적: 채드윅 H1-1 하교에서 버스가 학교에 15:28 에 미리 와 대기하는데(정시 출발 15:50),
//   승객 화면이 «도착 15:28 · 이미 지나침 · 다음 버스를 기다리세요 · 조기도착 21분» 으로 떴다.
//   기점의 시간은 «도착»이 아니라 «출발 약속»이다 — 미리 와서 기다리는 건 정상 운행이다.
//   (체인 기준점은 이미 2026-08-24 `stopSchedule.departureBaseMs` 가 계획시각으로 클램프했다.
//    이번엔 승객 화면이 기점에 «도착 시각»과 «지나침»을 그대로 보여주던 표시 쪽을 고친다.)
//
// 🔴 승객 화면 전용이다. 도착 기록(stopArrivals)·delaySec 은 사실이므로 그대로 두고,
//    기사·관리자 화면은 «30분 일찍 도착»을 계속 본다(departureBaseMs 주석과 같은 원칙).

function parseHHMM(s) {
  if (typeof s !== "string") return null;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

function todayMs(hhmm, nowMs) {
  const min = parseHHMM(hhmm);
  if (min == null) return null;
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime() + min * 60 * 1000;
}

// 기점의 계획 출발 시각 전인가 — 이때는 버스가 이미 와 있어도(또는 정류장 반경을 살짝
// 벗어난 주차 자리라 진행거리가 앞서 보여도) «지나침»이 아니라 «출발 대기»다.
// 계획 시각을 모르면 false(모르는 걸 대기로 지어내지 않는다 — 기존 판정 유지).
export function isHoldingAtOrigin({ idx, plannedAt, nowMs = Date.now() }) {
  if (idx !== 0) return false;
  const ms = todayMs(plannedAt, nowMs);
  return ms != null && nowMs < ms;
}

// 기점 시각 라벨 — 도착했거나 일찍 와 있으면 «도착 HH:MM»/«조기도착» 대신 «출발 계획시각».
// 반환 null = 기점 규칙 해당 없음(호출부의 기존 라벨을 그대로 쓴다).
//   ⚠ 기점에 늦게 오는 중(아직 미도착·지연)이면 null — 승객이 알아야 하는 정보라 기존대로 둔다.
export function originTimeLabel(idx, est) {
  if (idx !== 0 || !est || !est.plannedAt) return null;
  const early = typeof est.delaySec === "number" && est.delaySec < 0;
  if (est.status !== "arrived" && !early) return null;
  return { prefix: "출발", time: est.plannedAt };
}
