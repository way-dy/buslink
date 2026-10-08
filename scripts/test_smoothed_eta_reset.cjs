// 승객 도착 예정 카운트다운 — 내 정류장을 바꾸면 smoothing 을 버리는가 (2026-10-08 way)
//   node scripts/test_smoothed_eta_reset.cjs
// 🔴 Firebase 접속 0. 훅 소스를 최소 React 런타임(useRef/useState/useEffect 즉시 실행)에 그대로 태운다.
//
// 결함: 과천대로 인덕원힐스테이트(계획 15:34) ↔ 회사(15:36) 는 2분 차이. 점프 판정(180초)에
//       안 걸려서, 내 정류장을 회사 → 인덕원으로 바꾸면 회사 시각이 그대로 남아 «둘이 같은 시각»으로 보였다.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
};

const src = fs.readFileSync(path.join(ROOT, "src/lib/useSmoothedEta.js"), "utf8")
  .replace(/^import .*$/gm, "").replace(/^export /gm, "");

// 최소 훅 런타임 — 한 컴포넌트 인스턴스. effect 는 deps 가 바뀌면 렌더 직후 바로 돈다.
function makeRuntime(clock) {
  const slots = [];
  let i = 0;
  const React = {
    useRef: (v) => { const k = i++; if (!slots[k]) slots[k] = { current: v }; return slots[k]; },
    useState: (v) => { const k = i++; if (!slots[k]) slots[k] = { v }; const s = slots[k]; return [s.v, (n) => { s.v = n; }]; },
    useEffect: (fn, deps) => {
      const k = i++; const prev = slots[k];
      if (!prev || deps.some((d, j) => !Object.is(d, prev.deps[j]))) { slots[k] = { deps }; fn(); }
    },
  };
  const ctx = { ...React, Date: { now: () => clock.now }, Math, isFinite, Object };
  vm.createContext(ctx);
  vm.runInContext(src + "\n;this.H=useSmoothedEta;", ctx);
  // 한 번 «렌더»: effect 가 setState 하면 그 값을 보려고 한 번 더 렌더한다.
  return (raw, opts) => { i = 0; ctx.H(raw, opts); i = 0; return ctx.H(raw, opts); };
}

console.log("\n[1] 결함 재현 — resetKey 없이 정류장을 바꾸면 앞 값이 남는다(대조군)");
{
  const clock = { now: 1e9 };
  const render = makeRuntime(clock);
  render(400);                       // 회사: 6분 40초 뒤
  clock.now += 2000;
  const v = render(280);             // 인덕원: 4분 40초 뒤 (차이 120초 < 180)
  ok("옛 동작: 인덕원으로 바꿔도 회사 값 근처에 머문다", v > 380, String(v));
}

console.log("\n[2] resetKey 가 바뀌면 새 값을 즉시 쓴다");
{
  const clock = { now: 1e9 };
  const render = makeRuntime(clock);
  render(400, { resetKey: "r:회사" });
  clock.now += 2000;
  const v = render(280, { resetKey: "r:인덕원" });
  ok("인덕원으로 바꾸면 곧바로 인덕원 값", v === 280, String(v));
  clock.now += 2000;
  const back = render(398, { resetKey: "r:회사" });
  ok("다시 회사로 돌아가도 곧바로 회사 값", back === 398, String(back));
}

console.log("\n[3] 같은 정류장이면 smoothing 은 그대로(회귀 0)");
{
  const clock = { now: 1e9 };
  const render = makeRuntime(clock);
  render(400, { resetKey: "r:회사" });
  clock.now += 2000;
  const v = render(470, { resetKey: "r:회사" });   // 70초 증가 — 캡(0.5초/초)에 걸려야 한다
  ok("같은 키면 증가 캡이 그대로 걸린다", v <= 400 - 2 + 1 + 1e-9, String(v));
  const clock2 = { now: 1e9 };
  const r2 = makeRuntime(clock2);
  r2(400);
  clock2.now += 2000;
  ok("resetKey 를 안 주는 호출도 예전과 같다", r2(470) <= 399 + 1e-9);
}

console.log("\n[4] 호출부 배선");
{
  const emp = fs.readFileSync(path.join(ROOT, "src/pages/EmployeeApp.js"), "utf8");
  const pas = fs.readFileSync(path.join(ROOT, "src/pages/PassengerApp.js"), "utf8");
  ok("직원앱 홈 카운트다운이 노선+내 정류장을 키로 준다", /useSmoothedEta\([\s\S]{0,200}resetKey: `\$\{activeRouteId[^`]*\$\{myStop\?\.id/.test(emp));
  ok("승객앱(/bus)도 노선+내 정류장을 키로 준다", /useSmoothedEta\(myStopRawSec, \{ resetKey: `\$\{selectedRouteId[^`]*\$\{myStopIdx/.test(pas));
}

console.log("\n[5] 큰 글씨 시각 = «예상» 줄 시각(alignLabelTime)");
{
  const ss = fs.readFileSync(path.join(ROOT, "src/lib/stopSchedule.js"), "utf8").replace(/\r\n/g, "\n")
    .replace(/^import .*$/gm, "").replace(/^export /gm, "");
  const rp = fs.readFileSync(path.join(ROOT, "src/lib/routeProgress.js"), "utf8").replace(/^export /gm, "");
  const c = { Date, Math, Number, isFinite, Array, Object, String, console };
  vm.createContext(c);
  vm.runInContext(rp + "\n" + ss + "\n;this.A=alignLabelTime;", c);
  const NOW = new Date(); NOW.setHours(14, 49, 0, 0); const T = NOW.getTime();
  const L = { primary: "2분 후", tone: "primary", precise: "14:51", bucket: "min" }; // smoothing 이 늦게 따라온 값
  const r = c.A(L, { estimatedAt: "14:52", status: "next" }, T);
  ok("시각은 예상 14:52 로", r.precise === "14:52", r.precise);
  ok("«N분 후»도 같은 예상 시각에서(14:49 → 14:52 = 3분 후)", r.primary === "3분 후", r.primary);
  const r5 = c.A(L, { estimatedAt: "14:56", status: "next" }, T);
  ok("7분 뒤면 «약 5분»(5분 단위 반올림 규칙 그대로)", r5.primary === "약 5분" && r5.precise === "14:56", r5.primary);
  const far = c.A(L, { estimatedAt: "16:30", status: "upcoming" }, T);
  ok("한 시간 넘으면 «HH:MM 예상» 도 같은 시각", far.primary === "16:30 예상" && far.precise === "16:30", far.primary);
  ok("도착함·미설정·형식 오류·없음이면 들어온 라벨 그대로",
    c.A(L, { estimatedAt: "14:54", status: "arrived" }, T) === L && c.A(L, { estimatedAt: "14:54", status: "unplanned" }, T) === L
    && c.A(L, { estimatedAt: "", status: "next" }, T) === L && c.A(L, null, T) === L);
  ok("한참 지난 예상(어제 값 등)이면 손대지 않는다", c.A(L, { estimatedAt: "10:00", status: "next" }, T) === L);
  ok("라벨이 없으면 null 그대로", c.A(null, { estimatedAt: "14:54", status: "next" }) === null);
  const emp = fs.readFileSync(path.join(ROOT, "src/pages/EmployeeApp.js"), "utf8");
  const pas = fs.readFileSync(path.join(ROOT, "src/pages/PassengerApp.js"), "utf8");
  ok("직원앱 홈 카드가 맞춘 라벨을 쓴다", /alignLabelTime\(formatPassengerEta\(smoothedEtaSec\), myStopEst\)/.test(emp));
  ok("승객앱(/bus)도 맞춘 라벨을 쓴다", /alignLabelTime\(formatPassengerEta\(smoothedMyEtaSec\), myStop \? estByStopId\[myStop\.id\] : null\)/.test(pas));
}

console.log(`\n${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
