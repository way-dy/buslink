// 협력사 포털 노선 순서 격리 테스트 — 2026-08-26 배상준 게시판 `DqF7nony`.
//
//   node scripts/test_partner_route_order.cjs
//
// 신고 = "관리자 노선관리 등록 순서와 협력사 포털 노선도 순서가 다르다".
// 첨부 스크린샷 그대로 재현한다(관리자 9~15번 · 국민대학교 등교):
//
//   관리자 ▲▼ 순서            출발
//    9  시청광화문 1호차       08:15
//   10  시청광화문 2호차       08:20
//   11  시청광화문 3호차       08:25
//   12  압구정 1호차           08:15   ← 다른 거래처(포털에 안 보임)
//   13  불광 1호차             08:20
//   14  불광 2호차             08:30
//   15  불광 3호차             10:30
//
// 포털에서는 이렇게 보였다(빨간 상자로 지목된 구간):
//   시청광화문 1 → 시청광화문 2 → **불광 1** → **시청광화문 3** → 불광 2 → 불광 3
//
// 근인 두 겹:
//   ① `routes` 를 정렬 없이 받아 Firestore 문서 ID 순으로 썼다(관리자·승객앱·직원앱은
//      전부 `lib/routeOrder` 를 따르는데 이 포털만 빠져 있었다).
//   ② 운영 포털 노선도가 **출발시각만으로** 다시 줄을 세워, 관리자 순서를 덮어쓰고
//      같은 시각대(08:20·08:25) 노선을 뒤섞었다.
//
// 🔴 판정식을 베끼지 않는다 — `src/lib/routeOrder.js`·`src/lib/partnerAccess.js` 소스를
//    그대로 vm 에 태운다. 마지막 두 단언은 실제 `PartnerApp.js` 를 읽어 고친 자리가
//    되돌려지지 않았는지 본다(순수 테스트만 두면 파일이 회귀해도 초록으로 남는다).
// prod 쓰기 0 · 네트워크 0.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = path.join(__dirname, "..");

function strip(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/^import[\s\S]*?from\s+".*?";\s*$/gm, "")
    .replace(/^export const /gm, "const ")
    .replace(/^export function /gm, "function ");
}

const ctx = { console, Map, Set, Number, Array, String, isFinite };
vm.createContext(ctx);
vm.runInContext(strip("src/lib/routeOrder.js") + "\n" + strip("src/lib/partnerAccess.js"), ctx);
const { sortRoutes, partnerOpsRoutes } = ctx;

const CODE = "DY001-KMU-2026";
const OTHER = "DY001-APGUJEONG-2026";

// 🔴 입력을 **문서 ID 순처럼 섞어서** 준다 — 정렬이 실제로 일을 하는지 보려면
//    이미 정렬된 배열을 넣으면 안 된다.
const ROUTES = [
  { id: "r_bg2",  name: "불광 2호차",       order: 14, departTime: "08:30", partnerCode: CODE },
  { id: "r_scg3", name: "시청광화문 3호차", order: 11, departTime: "08:25", partnerCode: CODE },
  { id: "r_apg1", name: "압구정 1호차",     order: 12, departTime: "08:15", partnerCode: OTHER },
  { id: "r_bg1",  name: "불광 1호차",       order: 13, departTime: "08:20", partnerCode: CODE },
  { id: "r_scg1", name: "시청광화문 1호차", order: 9,  departTime: "08:15", partnerCode: CODE },
  { id: "r_bg3",  name: "불광 3호차",       order: 15, departTime: "10:30", partnerCode: CODE },
  { id: "r_scg2", name: "시청광화문 2호차", order: 10, departTime: "08:20", partnerCode: CODE },
];

// 승객은 일부 노선에만 배정돼 있다(합집합 규칙이 살아 있는지 함께 본다).
const PASSENGERS = [
  { routeId: "r_scg1", active: true },
  { routeId: "r_scg1", active: true },
  { routeId: "r_bg1", active: true },
];

let pass = 0, fail = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}\n       got  ${g}\n       want ${w}`); }
}
function ok(label, cond, hint) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${hint ? `\n       ${hint}` : ""}`); }
}

// ── 포털의 노선도 목록을 만드는 두 단계(고친 뒤 형태) ───────────────────────
const sorted = sortRoutes(ROUTES);
const { ids, byRouteCount, unassignedCount } = partnerOpsRoutes(sorted, CODE, PASSENGERS);
const shown = sorted.filter(r => ids.has(r.id)).map(r => r.name);

console.log("① 관리자 순서(routes.order)를 그대로 따르는가");
eq("전체 노선이 관리자 ▲▼ 순서로 정렬된다",
  sorted.map(r => r.order), [9, 10, 11, 12, 13, 14, 15]);
eq("포털 노선도가 관리자 순서 그대로 보인다",
  shown,
  ["시청광화문 1호차", "시청광화문 2호차", "시청광화문 3호차", "불광 1호차", "불광 2호차", "불광 3호차"]);
ok("다른 거래처 노선(압구정 1호차)은 안 보인다", !shown.includes("압구정 1호차"));

console.log("\n② 신고된 화면이 옛 규칙에서 실제로 재현되는가(회귀 가드)");
// 옛 코드: 문서 ID 순으로 받은 뒤 출발시각만으로 다시 정렬.
const legacy = ROUTES.filter(r => ids.has(r.id))
  .slice()
  .sort((a, b) => (a.departTime || "").localeCompare(b.departTime || ""))
  .map(r => r.name);
eq("옛 규칙은 첨부 스크린샷과 같은 순서를 만든다(불광 1 → 시청광화문 3)",
  legacy,
  ["시청광화문 1호차", "불광 1호차", "시청광화문 2호차", "시청광화문 3호차", "불광 2호차", "불광 3호차"]);
ok("옛 규칙과 새 규칙이 실제로 다르다(테스트가 헛돌지 않는다)",
  JSON.stringify(legacy) !== JSON.stringify(shown));

console.log("\n③ 순서 말고 다른 것은 안 건드렸는가");
eq("노선별 승객 수 집계 유지", [byRouteCount.get("r_scg1"), byRouteCount.get("r_bg1")], [2, 1]);
eq("미배정 승객 수 유지", unassignedCount, 0);
eq("보이는 노선 수 유지(거래처 지정 ∪ 승객 배정)", shown.length, 6);

console.log("\n④ 고친 자리가 파일에 남아 있는가");
const src = fs.readFileSync(path.join(ROOT, "src/pages/PartnerApp.js"), "utf8");
ok("업체코드 인증 직후 `sortRoutes` 로 받는다",
  /setRoutes\(sortRoutes\(/.test(src),
  "setRoutes(sortRoutes(...)) 가 사라졌다 — 포털이 다시 문서 ID 순으로 돌아간다");
ok("운영 포털 노선도에 출발시각 재정렬이 없다",
  !/list\.sort\(\(a, b\) => \(a\.departTime/.test(src),
  "departTime 재정렬이 되살아났다 — 관리자 순서를 다시 덮어쓴다");

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass}/${pass + fail} 통과`);
process.exit(fail === 0 ? 0 : 1);
