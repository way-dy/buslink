// 격리 테스트 — 승객앱 홈 노선 목록(src/lib/routeOrder.js homeRouteList).
//   node scripts/test_home_route_list.cjs
//
// 2026-08-18 배시현 개선요청 "즐겨찾기 설정을 안한 노선 홈탭에서 빼주실 수 있으신가요":
// 가입 때 자동으로 잡힌 배정 노선이 즐겨찾기가 아닌데도 홈에서 안 없어졌다(옛 규칙 = 배정 ∪ 즐겨찾기).
// prod 실측(dy001 승객 251명): 즐겨찾기 보유 **14명** · 그중 **11명은 배정 노선을 이미 즐겨찾기에
// 넣어 둬 화면 변화 0** · 즐겨찾기가 없는 **237명은 기존과 동일**(배정 1개) · 실제로 배정 노선이
// 홈에서 빠지는 사람은 **3명**(요청자 포함).
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "src", "lib", "routeOrder.js");
const raw = fs.readFileSync(SRC, "utf8");
const ctx = vm.createContext({ console });
vm.runInContext(raw.replace(/^export\s+function\s+/gm, "function ").replace(/^export\s+const\s+/gm, "var "), ctx);
const { homeRouteList } = ctx;

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${x !== undefined ? " — " + JSON.stringify(x) : ""}`); } };
const ids = (a) => a.map(r => r.id);

const ALL = [
  { id: "g1s", name: "[G1] 등교" },
  { id: "g1h", name: "[G1] 하교" },   // 요청자의 배정 노선(즐겨찾기 아님)
  { id: "g2s", name: "[G2] 등교" },
  { id: "as",  name: "[A] 등교" },
];

console.log("\n[0] 신호 유무 — 표본이 옛 규칙에서 실제로 문제를 일으키는가");
{
  const old = ALL.filter(r => r.id === "g1h" || ["g1s", "g2s"].includes(r.id));
  ok("옛 규칙이면 배정 노선(g1h)이 홈에 남는다", ids(old).includes("g1h"), ids(old));
}

console.log("\n[1] 즐겨찾기가 있으면 즐겨찾기만 — 배정 노선은 빠진다(요청 그대로)");
{
  const r = homeRouteList(ALL, { assignedRouteId: "g1h", favorites: ["g1s", "g2s"] });
  ok("2개", r.length === 2, ids(r));
  ok("배정 노선 g1h 빠짐", !ids(r).includes("g1h"), ids(r));
  ok("입력 순서 보존", JSON.stringify(ids(r)) === JSON.stringify(["g1s", "g2s"]), ids(r));
}

console.log("\n[2] 🔴 즐겨찾기가 없으면 배정 노선(홈이 통째로 비지 않는다 — 237명의 경우)");
{
  const r = homeRouteList(ALL, { assignedRouteId: "g1h", favorites: [] });
  ok("배정 1개", JSON.stringify(ids(r)) === JSON.stringify(["g1h"]), ids(r));
  ok("favorites 미전달도 동일", ids(homeRouteList(ALL, { assignedRouteId: "g1h" }))[0] === "g1h");
  ok("favorites=null 도 동일", ids(homeRouteList(ALL, { assignedRouteId: "g1h", favorites: null }))[0] === "g1h");
}

console.log("\n[3] 배정 노선이 즐겨찾기에 포함된 사람 = 화면 변화 0(11명의 경우)");
{
  const r = homeRouteList(ALL, { assignedRouteId: "g1s", favorites: ["g1s", "as"] });
  ok("배정 노선이 그대로 남는다", ids(r).includes("g1s"), ids(r));
  ok("2개", r.length === 2, ids(r));
}

console.log("\n[4] 사라진 노선·빈 입력");
ok("즐겨찾기 ID 가 지금 없는 노선이면 무시", ids(homeRouteList(ALL, { assignedRouteId: "g1h", favorites: ["삭제된노선"] }))[0] === "g1h");
ok("배정도 즐겨찾기도 없으면 빈 배열(호출부가 폴백)", homeRouteList(ALL, {}).length === 0);
ok("빈 노선 목록", homeRouteList([], { assignedRouteId: "g1h", favorites: ["g1s"] }).length === 0);
ok("null 입력 throw 없음", homeRouteList(null, null) === undefined || homeRouteList(null).length === 0);
ok("배열에 null 섞여도 throw 없음", homeRouteList([null, { id: "g1s" }], { favorites: ["g1s"] }).length === 1);

console.log("\n[5] 소스 회귀 가드 — 복원 금지 규칙이 코드에 실제로 있는가");
{
  const emp = fs.readFileSync(path.join(__dirname, "..", "src", "pages", "EmployeeApp.js"), "utf8");
  ok("홈 목록은 정본 헬퍼로 계산", /homeRouteList\(all, \{ assignedRouteId: session\.routeId, favorites \}\)/.test(emp));
  ok("옛 규칙(배정 ∪ 즐겨찾기)이 남아 있지 않다",
    !/all\.filter\(r => r\.id === session\.routeId \|\| favorites\.includes\(r\.id\)\)/.test(emp));
  ok("칩은 homeRoutes(즐겨찾기 + 지금 보는 노선)로 그린다", /homeRoutes\.map\(r =>/.test(emp));
  ok("활성 노선 재바인딩은 첫 로드에서만", /initialRouteBoundRef\.current/.test(emp));
  ok("즐겨찾기 없을 때 배정 폴백 유지", /assignedRouteId \? list\.filter/.test(raw));
}

console.log(`\n${fail === 0 ? "✅ 전부 통과" : "❌ 실패 있음"} — ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
