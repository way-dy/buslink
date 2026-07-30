// 격리 테스트 — 협력사 포털 노선 드롭다운 필터(src/lib/partnerAccess.js partnerRouteOptions).
//   node scripts/test_partner_route_options.cjs
//
// 2026-07-30 배시현 개선요청: "승객등록 시 노선선택에 해당협력사 노선 外 다른노선이 뜹니다".
// prod 실측 = 노선 59개가 전 거래처에 그대로 노출되고 있었고, 승객 13명 중 1명이 이미
// 다른 거래처 노선에 배정돼 있었다. 필터를 넣되 **현재 배정값이 사라져 저장 시 노선이
// 지워지는 것**을 막는 게 이 함수의 핵심 계약.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "partnerAccess.js"), "utf8")
  .replace(/^export\s+function\s+/gm, "function ")
  .replace(/^export\s+const\s+/gm, "var ");
const ctx = vm.createContext({ console });
vm.runInContext(src, ctx);
const { partnerRouteOptions } = ctx;

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${x !== undefined ? " — " + JSON.stringify(x) : ""}`); } };
const ids = (a) => a.map((r) => r.id);

// prod 구조를 닮은 표본: 채드윅 2개 · 다우 1개 · 거래처 미지정 1개 · 한화 1개
const CHAD = "DY001-채드윅송도국제학-2026-LKO5";
const DAOU = "DY001-다우디지털스퀘어-2026-H1F4";
const HANWHA = "DY001-한화판교RD센터-2026-YLQV";
const ROUTES = [
  { id: "r1", code: "CH1", name: "[강남1] 등교", partnerCode: CHAD },
  { id: "r2", code: "CH2", name: "[압구정] 등교", partnerCode: CHAD },
  { id: "r3", code: "DA1", name: "08:20 판교역", partnerCode: DAOU },
  { id: "r4", name: "테스트노선" },                       // 거래처 미지정(code 없음)
  { id: "r5", code: "HW1", name: "한화 통근", partnerCode: HANWHA },
];

console.log("\n[1] 자기 거래처 노선만 보인다(신규 등록 — 현재 값 없음)");
ok("채드윅 → 2개", JSON.stringify(ids(partnerRouteOptions(ROUTES, CHAD))) === JSON.stringify(["r1", "r2"]), ids(partnerRouteOptions(ROUTES, CHAD)));
ok("다우 → 1개", JSON.stringify(ids(partnerRouteOptions(ROUTES, DAOU))) === JSON.stringify(["r3"]));
ok("남의 노선 안 보임", !ids(partnerRouteOptions(ROUTES, CHAD)).includes("r3"));
ok("거래처 미지정 노선도 안 보임", !ids(partnerRouteOptions(ROUTES, CHAD)).includes("r4"));

console.log("\n[2] 노선이 하나도 없는 거래처 → 빈 목록(전체 폴백 금지)");
{
  const none = partnerRouteOptions(ROUTES, "DY001-드라이버스-2026-NDW0");
  ok("빈 배열", none.length === 0, none);
  // prod 실측: 그 거래처엔 등록된 승객도 0명이라 막힐 사람이 없다.
}

console.log("\n[3] 🔴 현재 배정된 노선은 남긴다 — 없으면 저장 시 노선이 지워진다");
{
  // 김은혜 케이스: 채드윅 담당인데 '거래처 미지정' 노선(r4)에 배정돼 있다
  const withCur = partnerRouteOptions(ROUTES, CHAD, "r4");
  ok("현재 노선 포함", ids(withCur).includes("r4"), ids(withCur));
  ok("자기 노선도 그대로", ids(withCur).includes("r1") && ids(withCur).includes("r2"));
  ok("여전히 남의 노선은 제외", !ids(withCur).includes("r3"));

  // 배시현 케이스: 채드윅 담당인데 한화 노선(r5)에 배정돼 있다 — 그 값도 유지
  ok("잘못 배정된 노선도 유지(수정 전까지)", ids(partnerRouteOptions(ROUTES, CHAD, "HW1")).includes("r5"));
}

console.log("\n[4] 현재 값은 routeCode·routeId 둘 다로 들어온다(폼이 섞어 쓴다)");
ok("code 로 매칭", ids(partnerRouteOptions(ROUTES, DAOU, "HW1")).includes("r5"));
ok("id 로 매칭", ids(partnerRouteOptions(ROUTES, DAOU, "r5")).includes("r5"));
ok("숫자로 와도 문자 비교", partnerRouteOptions([{ id: 7, partnerCode: "X" }], "Y", 7).length === 1);

console.log("\n[5] 결측·이상 입력에 throw 하지 않는다");
ok("routes null", partnerRouteOptions(null, CHAD).length === 0);
ok("routes 아님", partnerRouteOptions("x", CHAD).length === 0);
ok("code 없음 → 현재 값만", JSON.stringify(ids(partnerRouteOptions(ROUTES, "", "r1"))) === JSON.stringify(["r1"]));
ok("code·현재값 둘 다 없음 → 빈 목록", partnerRouteOptions(ROUTES, "", "").length === 0);
ok("배열에 null 요소 섞임", partnerRouteOptions([null, ROUTES[0]], CHAD).length === 1);
ok("빈 문자열 current 는 무시", !ids(partnerRouteOptions(ROUTES, CHAD, "")).includes("r4"));
ok("인자 없음", partnerRouteOptions() .length === 0);

// ── 좌석예약 모드(2026-07-30) ─────────────────────────────
const { seatReservationMode, canEnableSeatReservation, SEAT_MODES } = ctx;

console.log("\n[6] 좌석예약 모드 정규화 — 모르는 값·부재는 전부 off(회귀 0)");
ok("부재", seatReservationMode({}) === "off");
ok("문서 없음", seatReservationMode(null) === "off");
ok("optional", seatReservationMode({ seatReservation: "optional" }) === "optional");
ok("required", seatReservationMode({ seatReservation: "required" }) === "required");
ok("오타·구값은 off", seatReservationMode({ seatReservation: "Optional" }) === "off");
ok("true 같은 옛 boolean 도 off", seatReservationMode({ seatReservation: true }) === "off");
ok("상수 노출", SEAT_MODES.OFF === "off" && SEAT_MODES.REQUIRED === "required");

console.log("\n[7] 🔴 정원 미설정 노선이 있으면 켤 수 없다");
{
  const R2 = [
    { id: "a", name: "강남1", partnerCode: CHAD, seats: 45 },
    { id: "b", name: "압구정", partnerCode: CHAD },          // 정원 없음
    { id: "c", name: "판교", partnerCode: DAOU, seats: 25 },
  ];
  const chad = canEnableSeatReservation(R2, CHAD);
  ok("켤 수 없음", chad.ok === false, chad);
  ok("빠진 노선 이름을 알려준다", chad.missing.join() === "압구정", chad.missing);
  ok("대상 노선 수", chad.total === 2);

  const daou = canEnableSeatReservation(R2, DAOU);
  ok("전부 정원 있으면 켤 수 있음", daou.ok === true, daou);
  ok("빠진 것 없음", daou.missing.length === 0);

  // seats:0 은 미설정 취급(정원 0석 노선은 없다)
  ok("seats:0 은 미설정", canEnableSeatReservation([{ id: "z", name: "영석", partnerCode: CHAD, seats: 0 }], CHAD).ok === false);
  // 노선이 아예 없는 거래처도 켤 수 없다(예약할 대상이 없다)
  ok("노선 0개 거래처는 켤 수 없음", canEnableSeatReservation(R2, "DY001-없는곳").ok === false);
  ok("routes 결측에도 throw 없음", canEnableSeatReservation(null, CHAD).ok === false);
}

console.log(`\n최종: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
