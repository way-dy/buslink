// 진행거리 역행 금지 — 2026-08-25 채드윅(배시현) "운행 끝나고 회색이던 노선도가 다시 파래진다".
//   node scripts/test_progress_no_rewind.cjs
// 🔴 판정식을 베끼지 않고 `src/lib/routeProgress.js` 소스를 그대로 vm 에 태운다(재구현 0).
// 🔴 **옛 동작을 같은 잣대로 재현**해 되감김이 실재했음을 먼저 단언한다 — 그게 없으면
//    "지금 안 되감긴다"가 공허하다([[verification-harness-passes-on-no-signal]]).
// prod 접속 0 · 쓰기 0.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = path.join(__dirname, "..");

function load() {
  const src = fs.readFileSync(path.join(ROOT, "src/lib/routeProgress.js"), "utf8")
    .replace(/^export function /gm, "function ");
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(src + "\n;this.__m = { advanceProgress, pathUpTo, pathFrom, buildCumulativeLengths };", ctx);
  return ctx.__m;
}

// 옛 동작(수정 전 EmployeeApp/PassengerApp 인라인 로직) — 대조군.
function legacyPick(proj, prev, offRouteM) {
  if (!proj) return null;
  if (proj.perpDist <= offRouteM) return proj.progress;
  return prev;
}

(async () => {
  let fail = 0, n = 0;
  const ok = (name, cond, got) => {
    n++; console.log(`  ${cond ? "✓" : "✗"} ${name}${!cond && got !== undefined ? " → " + JSON.stringify(got) : ""}`);
    if (!cond) fail++;
  };
  const M = load();
  const OFF = 70;

  // ── prod 실측: [A] 방과후하교 2026-08-24, 종점 도착(19:03) 이후 궤적 ──────────
  //   (perpDist, progress) — inspect_after_run_strip.cjs 출력 그대로.
  const REAL = [
    { t: "19:03", perpDist: 2,    progress: 54217 },
    { t: "19:04", perpDist: 4,    progress: 54245 },
    { t: "19:05", perpDist: 91,   progress: 54245 },
    { t: "19:07", perpDist: 132,  progress: 54245 },
    { t: "19:10", perpDist: 55,   progress: 52483 },
    { t: "19:14", perpDist: 8,    progress: 47404 },
    { t: "19:29", perpDist: 2223, progress: 41720 },
  ];

  console.log("\n[0] 신호 유무 — 표본에 실제 역행이 들어 있나(없으면 판정이 공허하다)");
  const hasRewind = REAL.some((p, i) => i > 0 && p.perpDist <= OFF && p.progress < REAL[i - 1].progress);
  ok("표본에 경로 위 역행이 실재한다", hasRewind);

  console.log("\n[1] 🔴 옛 동작 재현 — 되감겼다");
  let prevOld = null;
  const oldSeq = REAL.map((p) => { prevOld = legacyPick(p, prevOld, OFF); return prevOld; });
  console.log(`     ${oldSeq.map((v) => Math.round(v)).join(" → ")}`);
  ok("옛 동작은 54245m 까지 갔다가 47404m 로 되돌아간다",
    Math.max(...oldSeq) === 54245 && oldSeq[oldSeq.length - 2] === 47404, oldSeq);
  ok("되감긴 거리가 6.8km 다(회색이던 구간이 다시 파래진 양)",
    Math.max(...oldSeq) - oldSeq[oldSeq.length - 2] === 6841);

  console.log("\n[2] 새 동작 — 역행하지 않는다");
  let prevNew = null;
  const newSeq = REAL.map((p) => { prevNew = M.advanceProgress(p, prevNew, OFF); return prevNew; });
  console.log(`     ${newSeq.map((v) => Math.round(v)).join(" → ")}`);
  ok("단조 비감소", newSeq.every((v, i) => i === 0 || v >= newSeq[i - 1]), newSeq);
  ok("종점 진행거리(54245m)를 끝까지 유지", newSeq[newSeq.length - 1] === 54245, newSeq);

  console.log("\n[3] 정상 운행은 그대로 나아간다(회귀 0)");
  let p3 = null;
  const fwd = [{ perpDist: 5, progress: 100 }, { perpDist: 10, progress: 400 }, { perpDist: 3, progress: 900 }]
    .map((x) => { p3 = M.advanceProgress(x, p3, OFF); return p3; });
  ok("전진은 그대로 채택", fwd.join(",") === "100,400,900", fwd);

  console.log("\n[4] 경로 이탈 좌표는 여전히 버린다(2026-08-06 가드 보존)");
  ok("이탈이면 직전 값 유지", M.advanceProgress({ perpDist: 200, progress: 999 }, 500, OFF) === 500);
  ok("직전 값이 없으면 null", M.advanceProgress({ perpDist: 200, progress: 999 }, null, OFF) === null);
  ok("proj 자체가 없으면 직전 값", M.advanceProgress(null, 300, OFF) === 300);
  ok("proj 없고 직전도 없으면 null", M.advanceProgress(null, null, OFF) === null);

  console.log("\n[5] 되감김이 화면에 무엇을 했나 — 폴리라인 분할로 확인");
  // 직선 경로 1000m(11점)에서 900m 까지 갔다가 300m 로 되감기는 상황.
  const line = Array.from({ length: 11 }, (_, i) => ({ lat: 37.5, lng: 127 + i * 0.001 }));
  const cum = M.buildCumulativeLengths(line);
  const total = cum[cum.length - 1];
  const at = (r) => total * r;
  const blueLen = (prog) => {
    const rest = M.pathFrom(line, cum, prog);
    return rest.length >= 2 ? 1 : 0;
  };
  ok("완주 지점에선 남은(파랑) 구간이 없다", blueLen(total) === 0);
  ok("되감기면 남은(파랑) 구간이 다시 생긴다 — 신고 증상 그 자체", blueLen(at(0.3)) === 1);

  console.log("\n[6] 소스 가드 — 호출부가 정본을 쓰는가");
  const emp = fs.readFileSync(path.join(ROOT, "src/pages/EmployeeApp.js"), "utf8");
  const pas = fs.readFileSync(path.join(ROOT, "src/pages/PassengerApp.js"), "utf8");
  ok("EmployeeApp 이 advanceProgress 를 쓴다", /advanceProgress\(busProj/.test(emp));
  ok("PassengerApp 이 advanceProgress 를 쓴다", /advanceProgress\(busProj/.test(pas));
  ok("EmployeeApp 에 노선 리셋이 있다", /progressRouteRef\.current !== activeRouteId/.test(emp));
  ok("PassengerApp 에 노선 리셋이 있다", /progressRouteRef\.current !== routeId/.test(pas));
  ok("옛 인라인 분기가 남아 있지 않다",
    !/busProgress = busProj\.progress;/.test(emp) && !/busProgress = busProj\.progress;/.test(pas));

  console.log(`\n${fail === 0 ? "✅" : "❌"} ${n - fail}/${n} 통과`);
  process.exit(fail === 0 ? 0 : 1);
})();
