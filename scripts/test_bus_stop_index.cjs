// 격리 테스트 — 노선도 '현재' 정류장 판정(최근접 정류장 폴백의 거리 상한).
//   node scripts/test_bus_stop_index.cjs
//
// 2026-08-06 배시현 신고: "첫정류장 도착 전인데 이미 첫정류장 및 노선을 지나쳤다고 나와
// 세부관제가 안 됩니다"(채드윅 강남2·반포·압구정·서초).
//
// 근인 = 버스가 아직 노선(routePath)에 안 올랐으면 perpDist>OFF_ROUTE_M 이라 busProgress 가
// null 이 되고 **최근접 정류장 폴백**으로 떨어지는데, 그 폴백에 **거리 상한이 없어서**
// 몇 km 밖에서도 정류장을 '현재'로 골랐다. 그러면 그 앞 정류장이 전부 '지나침'이 된다.
// (같은 값이 내 정류장 카드의 "이미 지나침" 문구도 몬다.)
//
// 판정식은 EmployeeApp.js **소스에서 그대로 뽑아** 평가한다(복제본 금지).
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const emp = fs.readFileSync(path.join(ROOT, "src/pages/EmployeeApp.js"), "utf8");

// 상수·헬퍼를 소스에서 추출
const constOf = (n) => Number((emp.match(new RegExp(`const ${n} = (\\d+)`)) || [])[1]);
const NEAR_STOP_M = constOf("NEAR_STOP_M");
const OFF_ROUTE_M = constOf("OFF_ROUTE_M");

function extractFn(name) {
  const start = emp.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`소스에 ${name} 없음`);
  let i = emp.indexOf("{", start), depth = 0;
  for (; i < emp.length; i++) {
    if (emp[i] === "{") depth++;
    else if (emp[i] === "}") { depth--; if (depth === 0) return emp.slice(start, i + 1); }
  }
  throw new Error(`${name} 끝을 못 찾음`);
}
const ctx = vm.createContext({ console, Math, isFinite, Number });
vm.runInContext(extractFn("haversineM"), ctx);
const { haversineM } = ctx;

// `_busStopIdx` 본문을 소스에서 뽑아 그대로 평가한다(로직을 옮겨 적지 않는다)
const bodyStart = emp.indexOf("const _busStopIdx = (() => {");
if (bodyStart < 0) throw new Error("_busStopIdx 를 소스에서 못 찾음");
const bodyEnd = emp.indexOf("})();", bodyStart) + 5;
const body = emp.slice(bodyStart, bodyEnd).replace("const _busStopIdx =", "var _busStopIdx =");
function busStopIdxOf(mainBus, stops) {
  const c = vm.createContext({ mainBus, stops, Math, isFinite, Number, NEAR_STOP_M, haversineM, console });
  vm.runInContext(body, c);
  return c._busStopIdx;
}

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${x !== undefined ? ` — ${JSON.stringify(x)}` : ""}`); } };
const eq = (n, a, b) => ok(n, a === b, { actual: a, expected: b });

console.log(`소스 상수: NEAR_STOP_M=${NEAR_STOP_M}m · OFF_ROUTE_M=${OFF_ROUTE_M}m`);

// prod 실좌표([서초] 등교(목) · 2026-08-06 Firestore 에서 그대로 읽음 — 지어낸 값 금지)
const SEOCHO = [
  { name: "(구)서울행정법원 아크로비스타 건너편", lat: 37.497615, lng: 127.012626 },
  { name: "서초역3번 출구 신한은행 앞", lat: 37.489292, lng: 127.008709 },
  { name: "채드윅국제학교", lat: 37.398523, lng: 126.644181 },
];

console.log("\n[1] 🔴 신고 재현 — 노선 밖 몇 km 지점에서 '현재'를 만들지 않는다");
{
  const bus = { lat: 37.5028, lng: 126.9793 };              // 동작역 부근(스크린샷)
  const d = Math.round(haversineM(bus, SEOCHO[1]));
  ok("프로브는 실제로 정류장에서 멀다", d > 2000, { meters: d });
  eq("어느 정류장에도 있지 않음(-1)", busStopIdxOf(bus, SEOCHO), -1);
  // 옛 동작 재현 — 상한이 없으면 1번(서초역)을 골라 0번이 '지나침'이 된다
  const oldPick = (() => {
    let m = Infinity, idx = 0;
    SEOCHO.forEach((s, i) => { const t = Math.hypot(s.lat - bus.lat, s.lng - bus.lng); if (t < m) { m = t; idx = i; } });
    return idx;
  })();
  ok("옛 코드였다면 정류장을 골라 앞 정류장이 지나침이 됐다", oldPick >= 1, { oldPick });
}

console.log("\n[2] 정류장 근처면 그대로 그 정류장");
{
  eq("정류장 위", busStopIdxOf({ lat: 37.4925, lng: 127.0077 }, SEOCHO), 1);
  // 서초역 정류장에서 남쪽으로 약 200m(다른 정류장보다 확실히 가까운 쪽)
  const near = { lat: SEOCHO[1].lat - 200 / 111320, lng: SEOCHO[1].lng };
  ok("200m 안이면 그 정류장", busStopIdxOf(near, SEOCHO) === 1,
    { idx: busStopIdxOf(near, SEOCHO), m: Math.round(haversineM(near, SEOCHO[1])) });
}

console.log("\n[3] 경계 — NEAR_STOP_M 근처");
{
  const at = (m) => ({ lat: SEOCHO[0].lat + m / 111320, lng: SEOCHO[0].lng });
  ok(`${NEAR_STOP_M - 50}m 는 안`, busStopIdxOf(at(NEAR_STOP_M - 50), SEOCHO) === 0);
  ok(`${NEAR_STOP_M + 100}m 는 밖(-1)`, busStopIdxOf(at(NEAR_STOP_M + 100), SEOCHO) === -1);
}

console.log("\n[4] 나쁜 입력");
{
  eq("버스 없음", busStopIdxOf(null, SEOCHO), -1);
  eq("정류장 없음", busStopIdxOf({ lat: 37.5, lng: 127 }, []), -1);
  eq("좌표 결손이면 -1(지어내지 않는다)", busStopIdxOf({ lat: NaN, lng: 127 }, SEOCHO), -1);
}

console.log("\n[5] 회귀 가드 — 소스 단언");
{
  ok("폴백에 거리 상한이 있다", /meters === null \|\| meters > NEAR_STOP_M \? -1 : idx/.test(emp));
  ok("NEAR_STOP_M 상수가 선언돼 있다", /const NEAR_STOP_M = \d+;/.test(emp));
  ok("노선 진입 전 안내 문구가 있다", /첫 정류장으로 이동 중입니다/.test(emp));
  // 진입 전에도 위치를 볼 수 있어야 한다
  ok("차량 위치 보기 버튼이 inService 에 묶여 있지 않다", !/\{inService && mainBus && \(\s*<button onClick=\{\(\) => \{ userCenteredRef/.test(emp));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} pass ${pass} / fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
