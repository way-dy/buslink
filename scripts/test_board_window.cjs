// 노선별 「태깅 가능 시간」 게이트 — 2026-09-29 개선요청 3whpOuuC(최우석) 회귀 가드.
//   node scripts/test_board_window.cjs
//
// 지키는 불변식
//  ① boardStart/boardEnd 가 **둘 다** 있을 때만 게이트. 한쪽만·미설정·형식 오류 = 게이트 없음(현상 유지)
//  ② 창 안이면 통과, 밖이면 거부 — 자정을 넘긴 창(22:00~02:00) 포함
//  ③ 거부 시 같은 차량 오늘 배차 중 **지금 창이 열린 다른 노선**을 안내(자동 적재는 안 한다)
//  ④ 배차 선택(pickDispatch) — 창 설정 노선이 없으면 기존 departTime 최근접 규칙과 **글자 그대로 같다**
//  ⑤ 소스 가드 — 탑승 CF 두 곳만 게이트를 부르고, recordSleepingCheck 는 opts 없이 부른다
//
// 🔴 순수 모듈(functions/boardWindow.js)만 격리 실행 — firebase-admin·네트워크 0.
const path = require("path");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const W = require(path.join(ROOT, "functions", "boardWindow.js"));

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { pass++; } else { fail++; console.log("  ❌ " + label); }
}
function eq(a, b, label) { ok(a === b, label + "  (받음: " + JSON.stringify(a) + " · 기대: " + JSON.stringify(b) + ")"); }
const m = (hm) => W.hhmmToMin(hm);

// 실측 모양 — 같은 차량이 출근(06:30)·퇴근(18:00)을 둘 다 뛴다(boardingKey.js 주석).
const R_AM = "rAM";
const R_PM = "rPM";
const routes = {
  [R_AM]: { name: "06:30 김포", boardStart: "06:00", boardEnd: "09:00" },
  [R_PM]: { name: "18:00 김포", boardStart: "17:00", boardEnd: "20:00" },
};
const dispatches = [
  { routeId: R_AM, routeName: "06:30 김포", departTime: "06:30" },
  { routeId: R_PM, routeName: "18:00 김포", departTime: "18:00" },
];

console.log("[1] 창 판정 — 안/밖/경계");
{
  const w = W.boardWindowOf(routes[R_AM]);
  eq(w.startMin, 360, "시작 06:00=360");
  eq(w.endMin, 540, "종료 09:00=540");
  ok(W.boardWindowContains(w, m("06:00")), "시작 경계 포함");
  ok(W.boardWindowContains(w, m("09:00")), "종료 경계 포함");
  ok(W.boardWindowContains(w, m("07:15")), "창 안");
  ok(!W.boardWindowContains(w, m("05:59")), "시작 1분 전 밖");
  ok(!W.boardWindowContains(w, m("09:01")), "종료 1분 뒤 밖");
  ok(!W.boardWindowContains(w, m("18:10")), "저녁은 밖");
}

console.log("[2] 자정 넘김(22:00~02:00)");
{
  const w = W.boardWindowOf({ boardStart: "22:00", boardEnd: "02:00" });
  ok(W.boardWindowContains(w, m("23:30")), "23:30 안");
  ok(W.boardWindowContains(w, m("00:00")), "00:00 안");
  ok(W.boardWindowContains(w, m("01:59")), "01:59 안");
  ok(W.boardWindowContains(w, m("02:00")), "02:00 경계 안");
  ok(!W.boardWindowContains(w, m("02:01")), "02:01 밖");
  ok(!W.boardWindowContains(w, m("12:00")), "정오 밖");
  ok(!W.boardWindowContains(w, m("21:59")), "21:59 밖");
}

console.log("[3] 게이트 없음 — 한쪽만·미설정·형식 오류 (현상 유지)");
{
  eq(W.boardWindowOf({ boardStart: "06:00" }), null, "시작만");
  eq(W.boardWindowOf({ boardEnd: "09:00" }), null, "종료만");
  eq(W.boardWindowOf({ boardStart: "06:00", boardEnd: "" }), null, "종료 빈 문자열");
  eq(W.boardWindowOf({ boardStart: null, boardEnd: null }), null, "둘 다 null");
  eq(W.boardWindowOf({}), null, "필드 없음");
  eq(W.boardWindowOf(undefined), null, "노선 문서 없음");
  eq(W.boardWindowOf({ boardStart: "25:00", boardEnd: "09:00" }), null, "시 범위 밖");
  eq(W.boardWindowOf({ boardStart: "6시", boardEnd: "9시" }), null, "형식 오류");
  // 🔴 displayStart/departTime 파생창으로 폴백하지 않는다 — 켜는 순간 기존 노선이 막힌다.
  eq(W.boardWindowOf({ displayStart: "06:00", displayEnd: "09:00", departTime: "06:30" }), null,
    "displayStart·departTime 만 있는 노선 = 게이트 없음(폴백 금지)");
  ok(W.boardWindowContains(null, m("03:00")), "창 null 은 항상 허용");
  ok(W.boardWindowContains({ startMin: 0, endMin: 10 }, null), "시각 모름 = 막지 않음");
  const g = W.evaluateBoardGate({
    routeId: "rX", routeName: "X", dispatches: [{ routeId: "rX" }],
    routesById: { rX: { boardStart: "06:00" } }, nowMin: m("23:00"),
  });
  eq(g.ok, true, "한쪽만 설정한 노선은 한밤에도 통과");
  const g2 = W.evaluateBoardGate({ routeId: "rX", routeName: "X", dispatches: [], routesById: {}, nowMin: m("23:00") });
  eq(g2.ok, true, "노선 문서 못 읽음(빈 routesById) = 통과");
}

console.log("[4] 거부 메시지 — 신고 상황(저녁에 출근 노선을 고른 채 태깅)");
{
  const g = W.evaluateBoardGate({ routeId: R_AM, routeName: "06:30 김포", dispatches, routesById: routes, nowMin: m("18:05") });
  eq(g.ok, false, "저녁 18:05 출근 노선 = 거부");
  eq(g.window, "06:00~09:00", "창 라벨");
  eq(g.altRouteId, R_PM, "대안 = 퇴근 노선");
  ok(g.message.startsWith("지금은 06:30 김포 태깅 시간이 아닙니다\n태깅 가능 시간: 06:00~09:00"), "첫 두 줄 형식");
  ok(g.message.includes("지금은 18:00 김포 운행 시간입니다 — 앱에서 노선을 바꾼 뒤 다시 찍어주세요"), "대안 안내 문구");
  const ok1 = W.evaluateBoardGate({ routeId: R_PM, routeName: "18:00 김포", dispatches, routesById: routes, nowMin: m("18:05") });
  eq(ok1.ok, true, "같은 시각 퇴근 노선은 통과");
  // 대안 없음(다른 노선 창도 닫힘) → 안내 줄 없이 두 줄만
  const g3 = W.evaluateBoardGate({ routeId: R_AM, routeName: "06:30 김포", dispatches, routesById: routes, nowMin: m("13:00") });
  eq(g3.ok, false, "한낮 출근 노선 거부");
  eq(g3.altRouteId, null, "한낮엔 열린 대안 없음");
  eq(g3.message.split("\n").length, 2, "대안 없으면 두 줄");
  // 창 미설정 노선은 '열린 노선'으로 권하지 않는다
  const r2 = { [R_AM]: routes[R_AM], [R_PM]: { name: "18:00 김포" } };
  const g4 = W.evaluateBoardGate({ routeId: R_AM, routeName: "06:30 김포", dispatches, routesById: r2, nowMin: m("18:05") });
  eq(g4.altRouteId, null, "창 미설정 노선은 대안으로 안내하지 않음");
  // 배차 routeName 이 비면 노선 문서 name 폴백
  const g5 = W.evaluateBoardGate({ routeId: R_AM, routeName: "", dispatches, routesById: routes, nowMin: m("18:05") });
  ok(g5.message.startsWith("지금은 06:30 김포 태깅"), "노선명 폴백(routes.name)");
}

console.log("[5] 배차 선택 — 창 설정 노선이 없으면 기존 규칙과 동일");
{
  const oldPick = (pool, nowMin) => {
    const gap = (d) => { const x = W.hhmmToMin(d.departTime); return (x === null || nowMin === null) ? Infinity : Math.abs(x - nowMin); };
    return pool.reduce((best, d) => (gap(d) < gap(best) ? d : best), pool[0]);
  };
  const plain = { [R_AM]: { name: "a" }, [R_PM]: { name: "b" } };
  let same = 0; let total = 0;
  for (let t = 0; t < 1440; t += 7) {
    total++;
    if (W.pickDispatch(dispatches, t, plain) === oldPick(dispatches, t)) same++;
    if (W.pickDispatch(dispatches, t, null) === oldPick(dispatches, t)) same++;
  }
  eq(same, total * 2, "창 없음/routesById 없음 = 기존 결과와 1440분 전 구간 일치");
  // 창이 있으면 열린 쪽 우선 — 12:00 은 옛 규칙이면 출근(06:30)이 가깝다
  eq(oldPick(dispatches, m("12:00")).routeId, R_AM, "옛 규칙 12:00 → 출근(대조)");
  eq(W.pickDispatch(dispatches, m("17:00"), routes).routeId, R_PM, "17:00 퇴근창 열림 → 퇴근");
  eq(W.pickDispatch(dispatches, m("08:30"), routes).routeId, R_AM, "08:30 출근창 열림 → 출근");
  // 창 닫힌 배차는 창 미설정 배차에 밀린다
  const mix = { [R_AM]: routes[R_AM], [R_PM]: { name: "b" } };
  eq(W.pickDispatch(dispatches, m("12:00"), mix).routeId, R_PM, "12:00 출근창 닫힘 + 퇴근 미설정 → 퇴근");
  // 전부 닫혔으면 기존 최근접(판정은 게이트가 한다)
  eq(W.pickDispatch(dispatches, m("12:00"), routes).routeId, R_AM, "전부 닫힘 → 기존 최근접");
  eq(W.pickDispatch([], m("12:00"), routes), null, "빈 풀 = null");
}

console.log("[6] kstNowMinutes");
{
  const d = new Date("2026-09-29T09:05:00Z"); // KST 18:05
  eq(W.kstNowMinutes(d), 18 * 60 + 5, "UTC 09:05 = KST 18:05");
  const d2 = new Date("2026-09-29T15:00:00Z"); // KST 00:00
  eq(W.kstNowMinutes(d2), 0, "KST 자정 = 0(24:00 표기 방어)");
}

console.log("[7] 소스 가드 — 게이트는 탑승 CF 에만");
{
  const src = fs.readFileSync(path.join(ROOT, "functions", "index.js"), "utf8");
  const body = (name) => {
    const i = src.indexOf(`exports.${name} = onCall(`);
    if (i < 0) return "";
    const j = src.indexOf("\n});", i + 10); // 함수 본문만(뒤에 붙은 헬퍼 정의가 섞이지 않게)
    return src.slice(i, j < 0 ? undefined : j);
  };
  const bs = body("boardStatic");
  const bn = body("boardNfc");
  const sl = body("recordSleepingCheck");
  const pv = body("resolveStaticBoarding");
  ok(bs.includes('enforceBoardWindow("boardStatic"'), "boardStatic 이 게이트를 부른다");
  ok(bn.includes('enforceBoardWindow("boardNfc"'), "boardNfc 가 게이트를 부른다");
  ok(bs.indexOf("enforceBoardWindow") < bs.indexOf("boardingRef.set("), "boardStatic: 게이트가 기록 생성보다 먼저");
  ok(bs.indexOf("enforceBoardWindow") < bs.indexOf("existing.exists"), "boardStatic: 게이트가 멱등 조회보다 먼저");
  ok(bn.indexOf("enforceBoardWindow") < bn.indexOf('.collection("nfcRejects")'), "boardNfc: 게이트가 nfcRejects 기록보다 먼저");
  ok(bn.indexOf("enforceBoardWindow") < bn.indexOf("boardingRef.set("), "boardNfc: 게이트가 boardings 기록보다 먼저");
  ok(!sl.includes("boardWindow") && !sl.includes("enforceBoardWindow"), "recordSleepingCheck 는 게이트·opts 없음");
  ok(sl.includes("resolveStaticDispatchAdmin(db, companyId, vehicleId)"), "recordSleepingCheck 호출 모양 불변");
  ok(!pv.includes("enforceBoardWindow"), "resolveStaticBoarding(프리뷰)는 거부하지 않는다");
  ok(pv.includes("boardGate: _bg"), "프리뷰는 내부 재료 boardGate 를 응답에서 뺀다");
  ok(src.includes('console.warn(`[${tag}:거부] 태깅시간'), "거부 로그 형식 [boardStatic:거부] 태깅시간");
}

console.log("[8] 관리자 노선 폼 — 입력·저장·복사");
{
  const a = fs.readFileSync(path.join(ROOT, "src", "pages", "AdminApp.js"), "utf8");
  ok((a.match(/boardStart:"", boardEnd:""/g) || []).length === 2, "form 초기값·openAdd 2곳");
  ok(a.includes(`boardStart:item.boardStart||"", boardEnd:item.boardEnd||""`), "openEdit 이 기존 값을 채운다");
  ok(a.includes("if ((bs && !be) || (!bs && be))"), "한쪽만 입력하면 저장 거부");
  ok(a.includes("boardStart:bs||null, boardEnd:be||null"), "저장 payload 에 포함(비우면 null)");
  ok(a.includes("boardStart: item.boardStart || null") && a.includes("boardEnd: item.boardEnd || null"), "복사본이 물려받는다");
  ok(a.includes("비워두면 시간 제한 없이 태깅됩니다."), "도움말 문구");
  ok(a.includes('value={form.boardStart}') && a.includes('value={form.boardEnd}'), "time 입력 2개");
}

console.log(`\n결과: ${pass} 통과 · ${fail} 실패`);
if (fail) process.exit(1);
