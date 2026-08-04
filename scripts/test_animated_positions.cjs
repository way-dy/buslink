// 격리 테스트 — src/lib/useAnimatedPositions.js (차량 마커 rAF 보간 훅).
//   node scripts/test_animated_positions.cjs
//
// 이 훅은 React 훅이라 순수 함수처럼 부를 수 없다. 그래서 **소스는 손대지 않고**
// 최소 React 런타임(useState/useEffect/useRef/useCallback)과 수동 rAF 큐를 만들어
// 실제 소스를 vm 에 그대로 태운다 — 프레임을 한 칸씩 흘려 보내며 반환값을 관찰한다.
// (buslink 격리 테스트 관례 = 판정 대상을 소스에서 뽑아 평가·재구현 금지)
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// ── 최소 React 훅 런타임 ───────────────────────────────────────────
// 렌더 = 훅 함수 1회 호출 + 이펙트 flush. 이펙트가 setState 하면 재렌더(가드 50).
function createHookRuntime(hookFactory) {
  const slots = [];
  let cursor = 0;
  let effectQueue = [];
  let dirty = false;

  const depsChanged = (prev, next) => {
    if (!prev || !next) return true;
    if (prev.length !== next.length) return true;
    return prev.some((v, i) => !Object.is(v, next[i]));
  };

  const React = {
    useState(init) {
      const i = cursor++;
      if (!slots[i]) slots[i] = { value: typeof init === "function" ? init() : init };
      const slot = slots[i];
      const set = (v) => {
        const nv = typeof v === "function" ? v(slot.value) : v;
        if (!Object.is(nv, slot.value)) { slot.value = nv; dirty = true; }
      };
      return [slot.value, set];
    },
    useRef(init) {
      const i = cursor++;
      if (!slots[i]) slots[i] = { current: init };
      return slots[i];
    },
    useCallback(fn, deps) {
      const i = cursor++;
      const slot = slots[i] || (slots[i] = {});
      if (depsChanged(slot.deps, deps)) { slot.fn = fn; slot.deps = deps; }
      return slot.fn;
    },
    useMemo(fn, deps) {
      const i = cursor++;
      const slot = slots[i] || (slots[i] = {});
      if (depsChanged(slot.deps, deps)) { slot.value = fn(); slot.deps = deps; }
      return slot.value;
    },
    useEffect(fn, deps) {
      const i = cursor++;
      const slot = slots[i] || (slots[i] = {});
      if (depsChanged(slot.deps, deps)) {
        slot.deps = deps;
        effectQueue.push(() => {
          if (slot.cleanup) slot.cleanup();
          slot.cleanup = fn() || null;
        });
      }
    },
  };

  // ── 수동 rAF 큐 + 가상 시계 ──────────────────────────────────────
  let rafQueue = [];
  let rafSeq = 1;
  let clock = 0;
  const env = {
    requestAnimationFrame(cb) { const id = rafSeq++; rafQueue.push({ id, cb }); return id; },
    cancelAnimationFrame(id) { rafQueue = rafQueue.filter((f) => f.id !== id); },
    performance: { now: () => clock },
  };

  const hook = hookFactory(React, env);
  let lastArgs = [];
  let out;

  function renderPass() {
    let guard = 0;
    do {
      dirty = false;
      cursor = 0;
      effectQueue = [];
      out = hook(...lastArgs);
      effectQueue.forEach((run) => run());
    } while (dirty && ++guard < 50);
    return out;
  }

  return {
    render(...args) { lastArgs = args; return renderPass(); },
    // 프레임 1회 진행: 대기 중인 rAF 콜백 실행 → setState 났으면 재렌더
    frame(dtMs = 16) {
      clock += dtMs;
      const q = rafQueue;
      rafQueue = [];
      q.forEach((f) => f.cb(clock));
      if (dirty) renderPass();
      return out;
    },
    frames(n, dtMs = 16) { let r = out; for (let i = 0; i < n; i++) r = this.frame(dtMs); return r; },
    pendingFrames: () => rafQueue.length,
    get value() { return out; },
  };
}

function loadHook() {
  let src = fs.readFileSync(path.join(__dirname, "..", "src/lib/useAnimatedPositions.js"), "utf8");
  src = src
    .replace(/^import\s+\{[^}]*\}\s+from\s+["'][^"']+["'];?$/gm, "")
    .replace(/^export\s+function\s+/gm, "function ")
    .replace(/^export\s+const\s+/gm, "var ");
  return (React, env) => {
    const ctx = vm.createContext({
      console,
      useState: React.useState, useEffect: React.useEffect,
      useRef: React.useRef, useCallback: React.useCallback, useMemo: React.useMemo,
      requestAnimationFrame: env.requestAnimationFrame,
      cancelAnimationFrame: env.cancelAnimationFrame,
      performance: env.performance,
    });
    vm.runInContext(src, ctx);
    return ctx.useAnimatedPositions;
  };
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`); }
}
const ids = (list) => (list || []).map((v) => v.id);

const factory = loadHook();
const BUS_A = { id: "dy001_vA", routeId: "routeA", vehicleNo: "A", lat: 37.40, lng: 127.11 };
const BUS_B = { id: "dy001_vB", routeId: "routeB", vehicleNo: "B", lat: 37.50, lng: 126.90 };

console.log("\n[1] 기본 동작 — 첫 로드·이동 보간(회귀 가드)");
{
  const rt = createHookRuntime(factory);
  ok("첫 로드는 원본 그대로", ids(rt.render([BUS_A])).join() === "dy001_vA", ids(rt.value));
  rt.frames(3);
  const moved = [{ ...BUS_A, lat: 37.42, lng: 127.13 }];
  rt.render(moved);
  const mid = rt.frame(400);
  const b = mid.find((v) => v.id === BUS_A.id);
  ok("이동 시작 후 중간 프레임은 출발↔도착 사이를 지난다",
    b.lat > 37.40 && b.lat < 37.42, { lat: b.lat });
  rt.frames(200, 20);
  const done = rt.value.find((v) => v.id === BUS_A.id);
  ok("충분한 프레임 뒤 목표 좌표 도달", Math.abs(done.lat - 37.42) < 1e-9, { lat: done.lat });
}

console.log("\n[2] 🔴 신고 재현 — 노선 변경으로 목록이 빈 배열이 되면");
{
  const rt = createHookRuntime(factory);
  rt.render([BUS_A]);
  rt.frames(5);
  const after = rt.render([]); // 다른 노선으로 변경 → 그 노선엔 운행 차량 없음
  ok("빈 목록이면 반환도 비어야 한다(운행 없음)", after.length === 0, ids(after));
  const afterFrames = rt.frames(10, 100);
  ok("프레임을 더 흘려도 이전 노선 차량이 남지 않는다", afterFrames.length === 0, ids(afterFrames));
}

console.log("\n[3] 다른 노선 차량으로 교체");
{
  const rt = createHookRuntime(factory);
  rt.render([BUS_A]);
  rt.frames(5);
  rt.render([BUS_B]);
  const out = rt.frames(3);
  ok("교체 후 새 노선 차량만 남는다", ids(out).join() === "dy001_vB", ids(out));
  const b = out.find((v) => v.id === BUS_B.id);
  ok("새 차량은 자기 좌표에 즉시 표시(다른 노선 좌표에서 미끄러지지 않음)",
    b && b.lat === BUS_B.lat && b.lng === BUS_B.lng, b && { lat: b.lat, lng: b.lng });
}

console.log("\n[4] 목록에서 빠졌다가 돌아온 차량은 옛 좌표에서 미끄러지지 않는다");
{
  const rt = createHookRuntime(factory);
  rt.render([BUS_A]);
  rt.frames(5);
  rt.render([]);            // 노선 변경(차량 없는 노선)
  rt.frames(5);
  const returned = [{ ...BUS_A, lat: 37.60, lng: 127.40 }]; // 한참 뒤 원래 노선 복귀
  rt.render(returned);
  const first = rt.frames(2);
  const a = first.find((v) => v.id === BUS_A.id);
  ok("복귀 즉시 현재 좌표로 표시", a && Math.abs(a.lat - 37.60) < 1e-9, a && { lat: a.lat });
}

console.log("\n[5] 좌표 없는 문서·다중 차량 안전성");
{
  const rt = createHookRuntime(factory);
  const noCoord = { id: "dy001_vX", routeId: "routeA" };
  const out = rt.render([BUS_A, noCoord]);
  ok("좌표 없는 문서도 그대로 통과(throw 없음)", ids(out).join() === "dy001_vA,dy001_vX", ids(out));
  rt.render([BUS_A, BUS_B]);
  rt.frames(3);
  ok("두 대 동시 표시", ids(rt.value).sort().join() === "dy001_vA,dy001_vB", ids(rt.value));
  ok("한 대만 남기면 나머지는 사라진다", ids(rt.render([BUS_B])).join() === "dy001_vB", ids(rt.value));
}

console.log("\n[6] 회귀 가드 — 소스에 가드가 실제로 있는지");
{
  const src = fs.readFileSync(path.join(__dirname, "..", "src/lib/useAnimatedPositions.js"), "utf8");
  ok("빈 목록일 때 표시 상태를 비우는 처리가 있다",
    /rawVehicles\.length\s*===\s*0/.test(src) || /!rawVehicles\.length/.test(src));
  ok("목록에서 사라진 차량의 보간 상태를 정리한다", /delete\s+prevPositions\.current\[/.test(src));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} pass ${pass} / fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
