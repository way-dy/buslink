// 격리 테스트 — 출발지(기점) 승객 표시 규칙(src/lib/originStop.js) + EmployeeApp 배선.
//   node scripts/test_origin_stop.cjs
//
// 2026-10-01 배시현 게시판 `Fc8Zs7TD`: 채드윅 H1-1 하교 버스가 학교에 15:28 에 와 대기(정시 15:50)
// 하는데 승객 화면이 «도착 15:28 · 이미 지나침 · 다음 버스를 기다리세요 · 조기도착 21분».
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "src", "lib", "originStop.js"), "utf8")
  .replace(/^export\s+function\s+/gm, "function ");
const ctx = vm.createContext({ Date });
vm.runInContext(src, ctx);
const { isHoldingAtOrigin, originTimeLabel } = ctx;

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${x !== undefined ? " — " + JSON.stringify(x) : ""}`); } };

const at = (hh, mm) => { const d = new Date(2026, 9, 1, hh, mm, 0, 0); return d.getTime(); };

console.log("[1] 출발 대기 판정");
ok("기점·계획 15:50·지금 15:28 → 대기", isHoldingAtOrigin({ idx: 0, plannedAt: "15:50", nowMs: at(15, 28) }) === true);
ok("기점·지금 15:49 → 대기", isHoldingAtOrigin({ idx: 0, plannedAt: "15:50", nowMs: at(15, 49) }) === true);
ok("기점·지금 15:50 → 대기 아님(출발 시각 도달)", isHoldingAtOrigin({ idx: 0, plannedAt: "15:50", nowMs: at(15, 50) }) === false);
ok("기점·지금 16:10 → 대기 아님", isHoldingAtOrigin({ idx: 0, plannedAt: "15:50", nowMs: at(16, 10) }) === false);
ok("중간 정류장은 대기 판정 안 함", isHoldingAtOrigin({ idx: 1, plannedAt: "16:43", nowMs: at(15, 28) }) === false);
ok("계획 시각 모르면 대기로 지어내지 않음", isHoldingAtOrigin({ idx: 0, plannedAt: null, nowMs: at(15, 28) }) === false);
ok("형식 불량 시각 → false", isHoldingAtOrigin({ idx: 0, plannedAt: "25:99", nowMs: at(15, 28) }) === false);
ok("내 정류장 미선택(null) → false", isHoldingAtOrigin({ idx: null, plannedAt: "15:50", nowMs: at(15, 28) }) === false);

console.log("[2] 기점 시각 라벨");
const arrivedEarly = { plannedAt: "15:50", estimatedAt: "15:28", status: "arrived", delaySec: -1320 };
const lab = originTimeLabel(0, arrivedEarly);
ok("일찍 도착한 기점 → «출발 15:50»", !!lab && lab.prefix === "출발" && lab.time === "15:50", lab);
ok("정시 도착 기점도 «출발 계획시각»", (originTimeLabel(0, { plannedAt: "15:50", estimatedAt: "15:50", status: "arrived", delaySec: 0 }) || {}).time === "15:50");
ok("아직 안 온 기점·조기 예상 → «출발»", (originTimeLabel(0, { plannedAt: "15:50", estimatedAt: "15:45", status: "next", delaySec: -300 }) || {}).prefix === "출발");
ok("기점에 늦게 오는 중(지연)은 규칙 해당 없음 → 기존 라벨", originTimeLabel(0, { plannedAt: "15:50", estimatedAt: "15:58", status: "next", delaySec: 480 }) === null);
ok("아직 정보 없는 기점(upcoming·delay null) → 기존 라벨", originTimeLabel(0, { plannedAt: "15:50", status: "upcoming", delaySec: null }) === null);
ok("중간 정류장 도착은 그대로(null)", originTimeLabel(1, { plannedAt: "16:43", estimatedAt: "16:40", status: "arrived", delaySec: -180 }) === null);
ok("계획 시각 없으면 null", originTimeLabel(0, { estimatedAt: "15:28", status: "arrived", delaySec: null }) === null);
ok("est 없음 → null", originTimeLabel(0, null) === null);

console.log("[3] EmployeeApp 배선(소스 가드)");
const app = fs.readFileSync(path.join(ROOT, "src", "pages", "EmployeeApp.js"), "utf8");
ok("originStop import", /from "\.\.\/lib\/originStop"/.test(app));
ok("etaStatus 가 기점 대기를 departing 으로 덮는다", /isHoldingAtOrigin\(\{\s*idx:\s*myStopIdx/.test(app) && /type:\s*'departing'/.test(app));
ok("departing 은 passed/arriving 만 덮는다(접근 중 카운트다운 보존)", /rawEtaStatus\.type === 'passed' \|\| rawEtaStatus\.type === 'arriving'/.test(app));
ok("카드 큰 글씨가 출발 시각을 보여준다", /etaStatus\.type === 'departing'\s*\n\s*\?\s*`\$\{originPlannedAt\} 출발`/.test(app));
ok("originTimeLabel 사용처 3곳(카드·지도 말풍선·정류장 목록)", (app.match(/originTimeLabel\(/g) || []).length === 3, (app.match(/originTimeLabel\(/g) || []).length);

console.log(`\n${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
