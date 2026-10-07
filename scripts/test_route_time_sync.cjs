// 격리 테스트 — 노선 출발시각 변경 시 배차 일정·앞으로의 배차 함께 맞추기(2026-10-07 way).
//   node scripts/test_route_time_sync.cjs
//
// 🔴 절반이 «안 바꾼다» 쪽 단언이다: 다른 시각 회차(하루 여러 번 도는 노선)·지난 배차·운행 기록
//    있는 배차·다른 노선은 절대 대상에 들어오면 안 된다. 그리고 신호 유무 — 신고 상황(옛 시각과
//    같은 일정·배차)에서 실제로 대상이 잡히는지를 먼저 단언한다.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log("  ✅ " + label); } else { fail++; console.log("  ❌ " + label); } };

function load() {
  const ds = fs.readFileSync(path.join(root, "src/lib/dispatchSchedule.js"), "utf8");
  const i = ds.indexOf("export function hasRunTrace(");
  let d = 0, started = false, j = i;
  for (; j < ds.length; j++) {
    if (ds[j] === "{") { d++; started = true; }
    else if (ds[j] === "}") { d--; if (started && d === 0) { j++; break; } }
  }
  const trace = ds.slice(i, j).replace(/^export /, "");
  const src = fs.readFileSync(path.join(root, "src/lib/routeTimeSync.js"), "utf8")
    .replace(/^import .*$/gm, "")
    .replace(/^export (const|function)/gm, "$1");
  const ctx = vm.createContext({ module: { exports: {} } });
  vm.runInContext(trace + "\n" + src + "\nmodule.exports = { selectRouteTimeSync, ROUTE_TIME_SYNC_DAYS };", ctx);
  return ctx.module.exports;
}
const { selectRouteTimeSync, ROUTE_TIME_SYNC_DAYS } = load();

const today = "2026-10-07";
const base = {
  routeId: "R1", oldTime: "07:30", newTime: "07:40", today,
  schedules: [
    { id: "s1", routeId: "R1", departTime: "07:30", name: "A 출근" },
    { id: "s2", routeId: "R1", departTime: "08:10", name: "A 출근 2회차" },
    { id: "s3", routeId: "R2", departTime: "07:30", name: "다른 노선" },
  ],
  dispatchesByDay: {
    "2026-10-06": [{ id: "past", routeId: "R1", departTime: "07:30" }],
    "2026-10-07": [
      { id: "todayRun", routeId: "R1", departTime: "07:30", stopArrivals: { a: 1 } },
      { id: "todayIdle", routeId: "R1", departTime: "07:30" },
    ],
    "2026-10-08": [
      { id: "exp", routeId: "R1", departTime: "07:30", source: "schedule", scheduleId: "s1", manualOverride: true },
      { id: "second", routeId: "R1", departTime: "08:10" },
      { id: "other", routeId: "R2", departTime: "07:30" },
      { id: "noroute", routeName: "직접 입력", departTime: "07:30" },
    ],
  },
};

console.log("[1] 신고 상황 — 옛 시각을 따르던 것은 잡힌다");
const r = selectRouteTimeSync(base);
ok(r.schedules.map(s => s.id).join() === "s1", "옛 시각 일정 s1 만 대상");
ok(r.schedules[0].label === "A 출근", "일정 이름을 같이 넘긴다");
ok(r.dispatches.map(d => d.id).join() === "todayIdle,exp", "오늘(기록 없음)·내일 배차가 대상(날짜순)");
ok(r.dispatches.some(d => d.id === "exp"), "기사·차량을 손으로 고친 배차도 시각이 같았으면 옮긴다");

console.log("[2] 건드리면 안 되는 것");
ok(!r.dispatches.some(d => d.id === "past"), "지난 배차 제외");
ok(r.keptWithTrace.map(d => d.id).join() === "todayRun", "운행 기록 있는 배차는 보고만");
ok(!r.dispatches.some(d => d.id === "second") && r.keptOtherTime.some(k => k.id === "second"), "다른 시각 회차(08:10) 배차 그대로");
ok(r.keptOtherTime.some(k => k.id === "s2"), "다른 시각 회차 일정 그대로");
ok(!r.schedules.some(s => s.id === "s3") && !r.dispatches.some(d => d.id === "other"), "다른 노선 제외");
ok(!r.dispatches.some(d => d.id === "noroute"), "노선 미지정(직접 입력) 배차 제외");

console.log("[3] 바뀐 게 없거나 기준이 없으면 아무것도 안 한다");
const empty = (x) => x.schedules.length + x.dispatches.length === 0;
ok(empty(selectRouteTimeSync({ ...base, newTime: "07:30" })), "같은 시각으로 저장");
ok(empty(selectRouteTimeSync({ ...base, oldTime: "" })), "옛 노선 시각이 비어 있었음");
ok(empty(selectRouteTimeSync({ ...base, routeId: "" })), "노선 id 없음");
ok(ROUTE_TIME_SYNC_DAYS >= 7, "살피는 기간이 일정 펼침(오늘+6)보다 길다");

console.log("[4] 소스 가드 — AdminApp");
const app = fs.readFileSync(path.join(root, "src/pages/AdminApp.js"), "utf8");
const rt = app.slice(app.indexOf("function RoutesTab"));
ok(/\(editItem\.departTime \|\| ""\) !== data\.departTime/.test(rt) && /syncRouteTime\(editItem\.id/.test(rt), "노선 수정에서 시각이 바뀌었을 때만 맞추기 호출");
const fn = rt.slice(rt.indexOf("const syncRouteTime"), rt.indexOf("const handleSave"));
ok(/window\.confirm\(/.test(fn) && fn.indexOf("window.confirm(") < fn.indexOf("updateDoc("), "쓰기 전에 확인을 받는다");
ok((fn.match(/updateDoc\(/g) || []).length === 2 && /\{ departTime: newTime, updatedAt \}/.test(fn) && /\{ departTime: newTime \}\)/.test(fn), "바꾸는 필드는 departTime 하나");
const dt = app.slice(app.indexOf("function DispatchTab"), app.indexOf("function DispatchScheduleTab"));
ok(/dispatch-time-oneday-hint/.test(dt) && /rt === form\.departTime\) return null/.test(dt), "배차 관리: 노선 시각과 다를 때만 «이 날만» 안내");

console.log(fail ? `\n❌ ${fail} fail / ${pass} pass` : `\n✅ 전부 통과 — ${pass} pass / 0 fail`);
process.exit(fail ? 1 : 0);
