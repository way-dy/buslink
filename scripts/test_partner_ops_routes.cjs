// 격리 테스트 — 협력사 포털 운영 포털의 노선 집합(src/lib/partnerAccess.js partnerOpsRoutes).
//   node scripts/test_partner_ops_routes.cjs
//
// 2026-08-11 배시현 개선요청 `DnPGSfHB9tzdK7kKq331` "협력사포털 조회 시 특정노선만 보이는 현상".
// 근인 = 노선 집합을 **승객 배정(routeId)** 으로만 모았다. 승객은 routeId 를 하나만 갖기 때문에
// 하교·요일별·방과후처럼 아무도 기준노선으로 잡지 않는 노선이 통째로 빠졌다.
// prod 실측: 채드윅 29개 중 8개 · 다우디지털스퀘어 18개 중 2개.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "partnerAccess.js"), "utf8")
  .replace(/^import\s+\{[^}]*\}\s+from\s+["'][^"']+["'];?$/gm, "")
  .replace(/^export\s+function\s+/gm, "function ")
  .replace(/^export\s+const\s+/gm, "var ");
const ctx = vm.createContext({ console, Map, Set });
vm.runInContext(src, ctx);
const { partnerOpsRoutes } = ctx;

// 옛 동작(결함) 재현 — 같은 잣대로 재서 "예전엔 빠졌다"를 단언하기 위한 것.
const oldOpsRouteIds = (routes, code, passengers) =>
  new Set(passengers.map(p => p.routeId).filter(Boolean));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${x !== undefined ? " — " + JSON.stringify(x) : ""}`); } };

const CODE = "DY001-채드윅송도국제학-2026-LKO5";
const OTHER = "DY001-다우디지털스퀘어-2026-H1F4";

// prod 구조 축약본: 등교(월~수,금)에만 승객이 배정되고 등교(목)·하교·방과후는 0명.
const ROUTES = [
  { id: "r_h1_go",   name: "[H1] 등교(월~수,금)", partnerCode: CODE, departTime: "06:25" },
  { id: "r_h1_thu",  name: "[H1] 등교(목)",       partnerCode: CODE, departTime: "07:20" },
  { id: "r_h1_back", name: "[H1] 하교",           partnerCode: CODE, departTime: "15:50" },
  { id: "r_h1_late", name: "[H1] 방과후하교",     partnerCode: CODE, departTime: "17:30" },
  { id: "r_dawoo",   name: "07:10 판교역",        partnerCode: OTHER, departTime: "07:10" },
  { id: "r_orphan",  name: "거래처 미지정 노선",  departTime: "13:50" },
];
const PASSENGERS = [
  { id: "e1", routeId: "r_h1_go" },
  { id: "e2", routeId: "r_h1_go" },
  { id: "e3", routeId: "r_orphan" },   // 거래처 미지정 노선에 걸린 승객(prod 실재)
  { id: "e4" },                         // 노선 미배정
];

console.log("\n[1] 신고 재현 — 옛 동작은 등교(월~수,금)만 보였다");
{
  const before = oldOpsRouteIds(ROUTES, CODE, PASSENGERS);
  const mine = ROUTES.filter(r => r.partnerCode === CODE);
  const shown = mine.filter(r => before.has(r.id));
  ok("옛 동작: 이 거래처 노선 4개 중 1개만 표시", mine.length === 4 && shown.length === 1, shown.map(r => r.name));
  ok("옛 동작: 하교가 빠진다", !before.has("r_h1_back"));
  ok("옛 동작: 방과후가 빠진다", !before.has("r_h1_late"));
}

console.log("\n[2] 수정 후 — 거래처 노선이 전부 나온다");
{
  const { ids } = partnerOpsRoutes(ROUTES, CODE, PASSENGERS);
  const mine = ROUTES.filter(r => r.partnerCode === CODE);
  ok("이 거래처 노선 4개 전부 포함", mine.every(r => ids.has(r.id)), [...ids]);
  ok("승객 0명인 하교·목요일·방과후도 포함", ids.has("r_h1_back") && ids.has("r_h1_thu") && ids.has("r_h1_late"));
}

console.log("\n[3] 회귀 0 — 지금 보이던 것이 사라지지 않는다");
{
  const { ids } = partnerOpsRoutes(ROUTES, CODE, PASSENGERS);
  ok("거래처 미지정 노선에 배정된 승객의 노선은 남는다", ids.has("r_orphan"));
  const before = oldOpsRouteIds(ROUTES, CODE, PASSENGERS);
  ok("옛 집합이 새 집합의 부분집합(사라진 노선 0)", [...before].every(id => ids.has(id)), [...before]);
}

console.log("\n[4] 남의 거래처 노선은 안 들어온다");
{
  const { ids } = partnerOpsRoutes(ROUTES, CODE, PASSENGERS);
  ok("다우디지털스퀘어 노선 미포함", !ids.has("r_dawoo"));
  const other = partnerOpsRoutes(ROUTES, OTHER, []);
  ok("다른 코드로 부르면 그쪽 노선만", other.ids.size === 1 && other.ids.has("r_dawoo"), [...other.ids]);
}

console.log("\n[5] 승객 수 집계 — 카드의 '👤 N명'");
{
  const { byRouteCount, unassignedCount } = partnerOpsRoutes(ROUTES, CODE, PASSENGERS);
  ok("등교(월~수,금) 2명", byRouteCount.get("r_h1_go") === 2);
  ok("하교는 집계에 없음 → 카드는 0명", byRouteCount.get("r_h1_back") === undefined);
  ok("미배정 1명", unassignedCount === 1);
}

console.log("\n[6] 나쁜 입력");
{
  ok("routes 없음", partnerOpsRoutes(null, CODE, PASSENGERS).ids.has("r_h1_go"));
  ok("passengers 없음이면 거래처 노선만", partnerOpsRoutes(ROUTES, CODE, null).ids.size === 4);
  ok("code 없음이면 승객 배정분만", (() => {
    const { ids } = partnerOpsRoutes(ROUTES, "", PASSENGERS);
    return ids.size === 2 && ids.has("r_h1_go") && ids.has("r_orphan");
  })());
  ok("전부 비어도 throw 0", partnerOpsRoutes(null, null, null).ids.size === 0);
  ok("routeId 빈 문자열은 미배정", partnerOpsRoutes([], CODE, [{ routeId: "" }]).unassignedCount === 1);
}

console.log("\n[7] 회귀 가드 — 소스에 실제로 남아 있는지");
{
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "pages", "PartnerApp.js"), "utf8");
  ok("PartnerApp 이 partnerOpsRoutes 를 쓴다", /partnerOpsRoutes\(routes,\s*code,\s*passengers\)/.test(app));
  ok("myRouteIds 를 승객 배정만으로 다시 만들지 않는다",
    !/myRouteIds:\s*new window\.Set\(m\.keys\(\)\)/.test(app));
  ok("memo deps 에 routes·code 가 있다", /\}, \[passengers, routes, code\]\);/.test(app));
  const lib = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "partnerAccess.js"), "utf8");
  ok("합집합(승객 배정 보존) 주석 가드", /합집합으로 남긴다/.test(lib));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
