// 탑승 멱등 키에 «노선» 이 들어있는지 — 2026-09-11 way 신고 회귀 가드.
//   node scripts/test_boarding_dupe_key.cjs
//
// 지키는 불변식: **같은 차량이 출근·퇴근을 둘 다 뛰어도 두 번 다 기록된다.**
//   예전 키 `${empNo}__${vehicleId}` 는 차량·당일 1건이라 아침에 탄 사람이 저녁에 태깅하면
//   「이미 탑승 처리됨」으로 막혔다. 실측(2026-09-11 dy001): 44대 중 22대가 하루 2배차,
//   그 22대 전부 routeId 가 갈린다 · 241명이 저녁에 막힐 상태 · 퇴근 노선 기록이 거의 0.
//
// 🔴 순수 모듈(functions/boardingKey.js)만 격리 실행한다 — firebase-admin·네트워크 0.
//    그 위에 **소스 가드**를 얹어, 순수 모듈이 아무리 옳아도 CF 가 그걸 실제로 쓰는지까지 잰다
//    (모듈만 맞고 호출부가 옛 리터럴이면 아무것도 안 고친 것이다).
const path = require("path");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const K = require(path.join(ROOT, "functions", "boardingKey.js"));

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { pass++; } else { fail++; console.log("  ❌ " + label); }
}
function eq(a, b, label) { ok(a === b, label + "  (받음: " + JSON.stringify(a) + " · 기대: " + JSON.stringify(b) + ")"); }

// 실측에서 가져온 표본 — 임시2875053(김포). 오전 22명 / 저녁 1명이던 그 차량이다.
const EMP = "50001";
const VEH = "CBYpwLwCiTEIZrwyA0VC";
const R_AM = "iLC7WegARJTFlPSEgjgb"; // 06:30 김포
const R_PM = "m5o0GurPoMX5hjgXIkeB"; // 18:00 김포

console.log("[1] 출근·퇴근이 서로 다른 문서가 된다 (이 고침의 존재 이유)");
const idAm = K.buildBoardingDocId({ empNo: EMP, vehicleId: VEH, routeId: R_AM });
const idPm = K.buildBoardingDocId({ empNo: EMP, vehicleId: VEH, routeId: R_PM });
ok(idAm !== idPm, "같은 사람·같은 차량이라도 노선이 다르면 doc id 가 달라야 한다");
ok(idAm.indexOf(R_AM) !== -1, "출근 키에 출근 routeId 가 들어간다");
ok(idPm.indexOf(R_PM) !== -1, "퇴근 키에 퇴근 routeId 가 들어간다");
eq(idAm, EMP + "__" + VEH + "__" + R_AM, "키 형식 = empNo__vehicleId__routeId");

console.log("[2] 같은 노선 재태깅은 여전히 한 건 (중복 방지는 안 풀렸다)");
eq(K.buildBoardingDocId({ empNo: EMP, vehicleId: VEH, routeId: R_AM }), idAm, "같은 입력 → 같은 키(결정적)");
ok(K.buildBoardingDocId({ empNo: "50002", vehicleId: VEH, routeId: R_AM }) !== idAm, "사람이 다르면 키가 다르다");
ok(K.buildBoardingDocId({ empNo: EMP, vehicleId: "OTHER", routeId: R_AM }) !== idAm, "차량이 다르면 키가 다르다");

console.log("[3] 공백·타입 정리");
eq(K.buildBoardingDocId({ empNo: "  " + EMP + " ", vehicleId: VEH, routeId: " " + R_AM }), idAm, "앞뒤 공백은 무시된다");
eq(K.buildBoardingDocId({ empNo: 50001, vehicleId: VEH, routeId: R_AM }), idAm, "숫자 사번도 같은 키");
eq(K.buildBoardingDocId({ empNo: "", vehicleId: VEH, routeId: R_AM }), "", "사번 없으면 빈 문자열(호출부가 쓰기 전에 걸러야 한다)");
eq(K.buildBoardingDocId({ empNo: EMP, vehicleId: "", routeId: R_AM }), "", "차량 없으면 빈 문자열");

console.log("[4] routeId 가 없으면 옛 동작(차량 × 당일 1건)을 유지한다");
eq(K.buildBoardingDocId({ empNo: EMP, vehicleId: VEH, routeId: "" }), EMP + "__" + VEH, "노선 미상 → 레거시 키");
eq(K.buildBoardingDocId({ empNo: EMP, vehicleId: VEH }), EMP + "__" + VEH, "routeId 미전달 → 레거시 키");
eq(K.buildLegacyBoardingDocId({ empNo: EMP, vehicleId: VEH }), EMP + "__" + VEH, "레거시 키 빌더");

console.log("[5] 전환 유예 — 옛 문서는 «같은 노선일 때만» 막는다");
ok(K.legacyBlocks({ legacyExists: true, legacyRouteId: R_AM, routeId: R_AM }) === true,
  "오전에 찍은 사람이 오전 노선을 또 찍으면 막는다(중복 방지 유지)");
ok(K.legacyBlocks({ legacyExists: true, legacyRouteId: R_AM, routeId: R_PM }) === false,
  "🔴 오전 레거시 기록이 퇴근 태깅을 막으면 안 된다 — 여기가 신고된 증상 그 자체다");
ok(K.legacyBlocks({ legacyExists: false, legacyRouteId: undefined, routeId: R_PM }) === false,
  "레거시 문서가 없으면 막지 않는다");
ok(K.legacyBlocks({ legacyExists: true, legacyRouteId: R_AM, routeId: "" }) === true,
  "노선 미상이면 옛 동작대로 막는다(갈라 줄 근거가 없다)");
ok(K.legacyBlocks({ legacyExists: true, legacyRouteId: undefined, routeId: R_PM }) === false,
  "레거시에 routeId 필드가 없으면 퇴근을 막지 않는다");

console.log("[6] 전환 창은 날짜(KST 문자열)로 닫힌다");
ok(K.withinBoardingKeyLegacyWindow("2026-09-11") === true, "배포 당일은 열려 있다");
ok(K.withinBoardingKeyLegacyWindow(K.BOARDING_KEY_LEGACY_UNTIL) === true, "마지막 날 포함");
ok(K.withinBoardingKeyLegacyWindow("2026-12-31") === false, "지나면 닫힌다(추가 read 0)");

console.log("[7] 소스 가드 — CF 가 실제로 이 키를 쓴다");
const cf = fs.readFileSync(path.join(ROOT, "functions", "index.js"), "utf8");
ok(cf.indexOf('require("./boardingKey")') !== -1, "functions/index.js 가 boardingKey 를 불러온다");
ok(cf.indexOf("buildBoardingDocId({ empNo: trimmedEmpNo, vehicleId, routeId })") !== -1,
  "boardStatic 이 노선 포함 키로 doc 를 잡는다");
ok(cf.indexOf("buildBoardingDocId({ empNo, vehicleId, routeId })") !== -1,
  "boardNfc 가 노선 포함 키로 doc 를 잡는다");
// 🔴 옛 리터럴이 doc() 인자로 남아 있으면 위 두 단언이 통과해도 실제 경로가 갈릴 수 있다.
const OLD_STATIC = ".doc(`" + "${trimmedEmpNo}__${vehicleId}" + "`)";
const OLD_NFC = ".doc(`" + "${empNo}__${vehicleId}" + "`)";
ok(cf.indexOf(OLD_STATIC) === -1, "boardStatic 에 옛 리터럴 키가 남아 있지 않다");
ok(cf.indexOf(OLD_NFC) === -1, "boardNfc 에 옛 리터럴 키가 남아 있지 않다");
ok(cf.indexOf("legacyBlocks({") !== -1, "전환 유예 폴백이 배선돼 있다");

console.log("[8] 소스 가드 — 기사 화면 집계도 노선으로 좁혔다");
// 차량만으로 세면 아침 출근분이 저녁 기사 화면에 얹힌다(실측: 차량 23 = 오전 22 + 저녁 1).
ok(cf.indexOf('q = q.where("routeId", "==", routeId)') !== -1,
  "countToday 가 routeId 로 좁힌다");
const driver = fs.readFileSync(path.join(ROOT, "src", "pages", "DriverApp.js"), "utf8");
ok(driver.indexOf("오늘 이 노선 탑승") !== -1, "기사 화면 라벨이 집계 단위(노선)와 맞는다");
ok(driver.indexOf("오늘 이 차량 탑승") === -1, "옛 라벨(차량)이 남아 있지 않다");

console.log("[9] 소스 가드 — 승객 화면 문구도 노선 기준");
const emp = fs.readFileSync(path.join(ROOT, "src", "pages", "EmployeeApp.js"), "utf8");
ok(emp.indexOf("오늘 이 노선 탑승은 이미 기록되어 있습니다") !== -1, "승객앱 문구가 «이 노선»");
ok(emp.indexOf("오늘 이 차량 탑승은 이미 기록되어 있습니다") === -1, "승객앱 옛 문구 제거");

console.log("");
console.log(fail === 0 ? "✅ " + pass + "단언 전부 통과" : "❌ 실패 " + fail + "건 / 단언 " + (pass + fail) + "건");
process.exit(fail === 0 ? 0 : 1);
