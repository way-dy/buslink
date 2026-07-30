// 격리 테스트 — 노선별 정원 대비 인원(src/lib/routeOrder.js seatUsage).
//   node scripts/test_seat_usage.cjs
//
// 2026-07-30 경쟁사(위즈돔 미쓰고) 대조에서 드러난 갭: 노선에 좌석수는 있는데
// 정원 대비 몇 명인지 볼 화면이 없었다. 승객 245명 등록 후에도 초과를 못 잡는다.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "routeOrder.js"), "utf8")
  .replace(/^import\s+\{[^}]*\}\s+from\s+["'][^"']+["'];?$/gm, "")
  .replace(/^export\s+function\s+/gm, "function ")
  .replace(/^export\s+const\s+/gm, "var ");
const ctx = vm.createContext({ console });
vm.runInContext(src, ctx);
const { seatUsage } = ctx;

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${x !== undefined ? " — " + JSON.stringify(x) : ""}`); } };

const ROUTES = [
  { id: "r1", seats: 45 },
  { id: "r2", seats: 25 },
  { id: "r3" },              // 정원 미설정
  { id: "r4", seats: 0 },    // 0 = 미설정 취급
];

console.log("\n[1] 등록 인원 집계");
{
  const px = [
    { routeId: "r1" }, { routeId: "r1" }, { routeId: "r1" },
    { routeId: "r2" },
    { routeId: "없는노선" },          // 무시
    { routeId: "r1", active: false }, // 퇴사 제외
  ];
  const u = seatUsage(ROUTES, px);
  ok("r1 = 3명(퇴사 제외)", u.r1.registered === 3, u.r1);
  ok("r2 = 1명", u.r2.registered === 1);
  ok("없는 노선은 무시", Object.keys(u).length === 4);
  ok("좌석수 그대로", u.r1.seats === 45 && u.r2.seats === 25);
}

console.log("\n[2] 🔴 정원 미설정 노선은 초과 판정하지 않는다");
{
  const px = Array.from({ length: 100 }, () => ({ routeId: "r3" }));
  const u = seatUsage(ROUTES, px);
  ok("100명이어도 over=false", u.r3.over === false, u.r3);
  ok("seats=null", u.r3.seats === null);
  ok("ratio=null", u.r3.ratio === null);
  ok("seats:0 도 미설정 취급", seatUsage(ROUTES, [{ routeId: "r4" }]).r4.seats === null);
}

console.log("\n[3] 정원 초과 판정 — 경계");
{
  const at = (n) => seatUsage([{ id: "x", seats: 25 }], Array.from({ length: n }, () => ({ routeId: "x" }))).x;
  ok("24명 → 초과 아님", at(24).over === false);
  ok("정확히 25명 → 초과 아님", at(25).over === false, at(25));
  ok("26명 → 초과", at(26).over === true);
  ok("비율 계산", Math.abs(at(25).ratio - 1) < 1e-9);
}

console.log("\n[4] 오늘 탑승 집계(선택 인자)");
{
  const u = seatUsage(ROUTES, [{ routeId: "r1" }, { routeId: "r1" }], [{ routeId: "r1" }, { routeId: "r2" }]);
  ok("r1 탑승 1", u.r1.boarded === 1, u.r1);
  ok("r2 탑승 1", u.r2.boarded === 1);
  ok("탑승 인자 없으면 0", seatUsage(ROUTES, [{ routeId: "r1" }]).r1.boarded === 0);
}

console.log("\n[5] 결측·이상 입력에 throw 하지 않는다");
{
  ok("routes 없음", Object.keys(seatUsage()).length === 0);
  ok("routes 배열 아님", Object.keys(seatUsage("x", [])).length === 0);
  ok("승객 null", seatUsage(ROUTES, null).r1.registered === 0);
  ok("배열에 null 요소", seatUsage([null, ROUTES[0]], [null, { routeId: "r1" }]).r1.registered === 1);
  ok("id 없는 노선 무시", Object.keys(seatUsage([{ seats: 10 }], [])).length === 0);
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
