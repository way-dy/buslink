// 격리 테스트 — 홈이 보는 노선 = 스캐너가 보내는 노선 (src/lib/routeOrder.js pickHomeRoute).
//   node scripts/test_home_route_bind.cjs
//
// 2026-09-01 조수빈(신촌세브란스병원) 클레임:
//   "노선에서 내 정류장을 아무리 지정해도 자꾸 풀립니다 … 오늘 탑승 시에 자꾸 이 노선이
//    아니라고 해서 못 탈 뻔 했네요"
// prod 실측: 배정 07:19 갈현동 · 즐겨찾기 06:48/18:00 광명 · fcmTokens 내정류장은 광명 노선
// (07:23 지정) · 그런데 스캐너가 보낸 노선은 갈현동 → CF 가 "선택한 노선의 차량이 아닙니다".
// 같은 조건(즐겨찾기 ⊅ 배정노선)인 승객이 **390명**(즐겨찾기 보유 469명 중)이었다.
//
// 원인: 홈 탭은 탭 전환 시 언마운트된다(QR 탑승 버튼도 setTab('scan') 이다). 재마운트마다
// "활성 노선을 홈 목록 안으로 끌어오기"가 다시 돌았는데 그건 화면 state 만 바꾸고
// 세션(=스캐너가 읽는 값)에는 안 썼다. 그래서 화면과 스캐너가 갈라졌고, 내 정류장 복원은
// 활성 노선 기준이라 매번 실패했다.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "src", "lib", "routeOrder.js");
const raw = fs.readFileSync(SRC, "utf8");
const ctx = vm.createContext({ console });
vm.runInContext(raw.replace(/^export\s+function\s+/gm, "function ").replace(/^export\s+const\s+/gm, "var "), ctx);
const { homeRouteList, pickHomeRoute, boardingRouteId } = ctx;

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${x !== undefined ? " — " + JSON.stringify(x) : ""}`); } };
const eq = (n, a, b) => ok(n, a === b, { actual: a, expected: b });

const ALL = [
  { id: "gal",  name: "07:19 갈현동" },   // 신고자 배정 노선(거래처 전원 동일 = 사실상 기본값)
  { id: "km1",  name: "06:48 광명" },     // 신고자 즐겨찾기 = 실제로 타는 노선
  { id: "km2",  name: "18:00 광명" },
  { id: "ilsan", name: "06:50 일산" },
];
// 홈 목록은 실제 호출부와 같은 함수로 만든다(재구현 금지).
const shownFor = (routeId, favorites) => homeRouteList(ALL, { assignedRouteId: routeId, favorites });

console.log("\n[0] 신호 — 신고자 조건에서 홈 목록이 배정 노선을 안 담는다(그래서 갈라졌다)");
{
  const shown = shownFor("gal", ["km1", "km2"]);
  ok("홈 목록 = 즐겨찾기(광명 2개)", JSON.stringify(shown.map(r => r.id)) === '["km1","km2"]', shown.map(r => r.id));
  ok("배정 노선(갈현동)은 홈 목록 밖", !shown.some(r => r.id === "gal"));
}

console.log("\n[1] 신고자 재현 — 아직 직접 고른 적 없으면 홈 목록 노선으로 **묶어서 세션에 남긴다**");
{
  const shown = shownFor("gal", ["km1", "km2"]);
  eq("첫 진입: 광명으로 정착", pickHomeRoute({ all: ALL, shown, fallback: ALL, routeId: "gal", pinned: false }), "km1");
  // 그 값이 세션에 써졌다면 다음 재마운트(=QR 탭 다녀오기)에서는 더 묶을 게 없다.
  const shown2 = shownFor("km1", ["km1", "km2"]);
  eq("재마운트: 유지(=탭 전환에도 안 튄다)", pickHomeRoute({ all: ALL, shown: shown2, fallback: ALL, routeId: "km1", pinned: false }), null);
}

console.log("\n[2] 2026-08-18 요청 보존 — 직접 고른 노선은 즐겨찾기가 아니어도 안 튕긴다");
{
  const shown = shownFor("ilsan", ["km1", "km2"]);
  eq("노선 변경/칩으로 고름(pinned)", pickHomeRoute({ all: ALL, shown, fallback: ALL, routeId: "ilsan", pinned: true }), null);
  eq("pin 없으면 홈 목록으로 정착", pickHomeRoute({ all: ALL, shown, fallback: ALL, routeId: "ilsan", pinned: false }), "km1");
}

console.log("\n[3] 즐겨찾기 없는 절대다수(prod 16,409명 중 15,940명) — 동작 변화 0");
{
  const shown = shownFor("gal", []);
  eq("홈 목록 = 배정 1개 → 유지", pickHomeRoute({ all: ALL, shown, fallback: ALL, routeId: "gal", pinned: false }), null);
}

console.log("\n[4] 관대한 폴백 — 값이 없거나 깨져도 화면이 비지 않는다");
{
  eq("배정도 즐겨찾기도 없음 → 폴백 첫 노선", pickHomeRoute({ all: ALL, shown: [], fallback: ALL, routeId: null, pinned: false }), "gal");
  eq("삭제된 노선을 가리킴(pinned 여도) → 재선택", pickHomeRoute({ all: ALL, shown: shownFor("zzz", ["km1"]), fallback: ALL, routeId: "zzz", pinned: true }), "km1");
  eq("홈·폴백 둘 다 비면 유지", pickHomeRoute({ all: [], shown: [], fallback: [], routeId: "gal", pinned: false }), null);
  eq("opts 자체가 null 이어도 던지지 않는다", pickHomeRoute(null), null);
  eq("문자열 id 배열도 받는다", pickHomeRoute({ all: ["a", "b"], shown: ["b"], routeId: "a", pinned: false }), "b");
}

console.log("\n[4b] 스캐너가 보낼 노선 — 명부 배정값은 «선택» 이 아니다");
{
  // prod 실측: 신촌세브란스 승객 16,155명 중 16,149명이 배정 `07:19 갈현동`(일괄 업로드 부산물).
  // 그 값으로 오탑승 방지를 걸면 자기 버스를 타고도 막힌다 — 보호가 아니라 거짓 차단이다.
  eq("고른 적 없음 + 즐겨찾기 없음 → 안 보냄(15,765명이 이 경우)",
    boardingRouteId({ routeId: "gal", pinned: false, favorites: [] }), null);
  eq("즐겨찾기는 있지만 지금 노선은 배정값 → 안 보냄",
    boardingRouteId({ routeId: "gal", pinned: false, favorites: ["km1", "km2"] }), null);
  // 🔴 아래 둘은 오탑승 방지가 **그대로 살아 있어야** 하는 경우다(완화가 과하면 여기서 깨진다).
  eq("노선 변경·칩으로 직접 골랐다(pinned) → 보낸다",
    boardingRouteId({ routeId: "ilsan", pinned: true, favorites: [] }), "ilsan");
  eq("별을 눌러 고른 노선으로 정착 → 보낸다(신고자의 정상 상태)",
    boardingRouteId({ routeId: "km1", pinned: false, favorites: ["km1", "km2"] }), "km1");
  eq("노선 자체가 없음", boardingRouteId({ routeId: null, pinned: true, favorites: ["km1"] }), null);
  eq("opts 가 null 이어도 던지지 않는다", boardingRouteId(null), null);
  eq("favorites 가 배열이 아니어도 던지지 않는다",
    boardingRouteId({ routeId: "gal", pinned: false, favorites: null }), null);
}

console.log("\n[5] 구조 잠금 — 노선을 바꾸는 길은 bindRoute 하나뿐이어야 한다");
{
  const emp = fs.readFileSync(path.join(__dirname, "..", "src", "pages", "EmployeeApp.js"), "utf8");
  const calls = emp.split("\n").filter(l => /setActiveRouteId\(/.test(l) && !/^\s*(\/\/|\*)/.test(l));
  // 허용: useState 선언 1 · bindRoute 본체 1 · session.routeId 미러 효과 1
  ok(`setActiveRouteId 호출부 3곳 이하 (현재 ${calls.length})`, calls.length <= 3, calls.map(l => l.trim()));
  ok("bindRoute 가 세션에 routeId 를 쓴다",
    /const bindRoute[\s\S]{0,400}?onSessionUpdate\([\s\S]{0,120}?routeId: rid/.test(emp));
  ok("노선 칩이 bindRoute 를 쓴다(화면 state 직접 변경 금지)",
    /onClick=\{\(\) => \{ bindRoute\(r\.id, \{ pin: true \}\); setMyStopIdx\(null\); \}\}/.test(emp));
  ok("'정류장 변경'은 영속값까지 지운다(selectMyStop)",
    /onClick=\{\(\) => selectMyStop\(null\)\}/.test(emp));
  // 🔴 인앱 스캐너는 session.routeId 를 **그대로** 보내면 안 된다(명부 배정값 = 거짓 차단).
  ok("인앱 스캐너가 session.routeId 를 그대로 보내지 않는다",
    !/selectedRouteId = session\?\.routeId/.test(emp));
  ok("정본 판정 boardingRouteId 를 거쳐 보낸다", /selectedRouteId = boardingRouteId\(/.test(emp));
  // 폰 기본 카메라 경로는 원래 아무것도 안 보낸다 — 이 완화는 그 동작과 같아지는 것이다.
  const bd = fs.readFileSync(path.join(__dirname, "..", "src", "pages", "BoardingApp.js"), "utf8");
  ok("폰 카메라 경로는 여전히 노선을 안 보낸다(대조군)", !/selectedRouteId/.test(bd));
}

console.log(`\n${fail === 0 ? "✅ 전부 통과" : "❌ 실패 있음"} — ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
