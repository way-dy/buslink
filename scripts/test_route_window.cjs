// 격리 테스트 — src/lib/routeWindow.js (노선 표시 시간창, 2026-08-05 회의 #2·#3).
//   node scripts/test_route_window.cjs
//
// buslink 격리 테스트 관례 = 판정 대상을 소스에서 그대로 뽑아 평가(재구현 금지).
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadModule(relPath) {
  let src = fs.readFileSync(path.join(__dirname, "..", relPath), "utf8");
  src = src
    .replace(/^import\s+\{[^}]*\}\s+from\s+["'][^"']+["'];?$/gm, "")
    .replace(/^export\s+function\s+/gm, "function ")
    .replace(/^export\s+const\s+/gm, "var ");
  const ctx = vm.createContext({ console, Intl, Date, Number, Math, String });
  vm.runInContext(src, ctx);
  return ctx;
}

const M = loadModule("src/lib/routeWindow.js");
const { hhmmToMinutes, computeRouteWindow, isWithinRouteWindow, describeRouteWindow,
        normalizeWindowOpts, WINDOW_PRE_MIN_DEFAULT, WINDOW_POST_MIN_DEFAULT } = M;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`); }
}
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b), { actual: a, expected: b });
const at = (s) => hhmmToMinutes(s);

console.log("\n[1] hhmmToMinutes");
eq("07:50", hhmmToMinutes("07:50"), 470);
eq("00:00", hhmmToMinutes("00:00"), 0);
eq("23:59", hhmmToMinutes("23:59"), 1439);
eq("공백 허용", hhmmToMinutes(" 08:00 "), 480);
eq("24:00 은 무효", hhmmToMinutes("24:00"), null);
eq("07:60 은 무효", hhmmToMinutes("07:60"), null);
eq("빈 문자열", hhmmToMinutes(""), null);
eq("숫자 입력", hhmmToMinutes(750), null);

console.log("\n[2] 게이트 없음(관대한 폴백) — 설정 전에 차가 사라지면 안 된다");
eq("route 없음", computeRouteWindow(null, [], {}), null);
eq("출발시각·표시시간 둘 다 없음", computeRouteWindow({}, [], {}), null);
eq("표시시간 한쪽만 입력", computeRouteWindow({ displayStart: "07:00" }, [], {}), null);
ok("창이 null 이면 언제든 표시", isWithinRouteWindow(null, 3));

console.log("\n[3] 파생 창 — 출발시각 ± 회사 기본값");
{
  // 07:50 출발, 마지막 정류장 offset 80분 → 07:20 ~ 09:40 (기본 30/30)
  const w = computeRouteWindow({ departTime: "07:50" }, [{ offsetMin: 20 }, { offsetMin: 80 }], {});
  eq("07:20~09:40 파생", [w.startMin, w.endMin, w.source], [at("07:20"), at("09:40"), "derived"]);
  eq("문구", describeRouteWindow(w), "07:20~09:40");
  ok("07:19 는 밖", !isWithinRouteWindow(w, at("07:19")));
  ok("07:20 은 안(경계 포함)", isWithinRouteWindow(w, at("07:20")));
  ok("09:40 은 안(경계 포함)", isWithinRouteWindow(w, at("09:40")));
  ok("09:41 은 밖", !isWithinRouteWindow(w, at("09:41")));
  ok("신고 상황: 오전 10시엔 안 보인다", !isWithinRouteWindow(w, at("10:00")));
}
{
  const w = computeRouteWindow({ departTime: "07:50" }, [], {}); // offsetMin 전무 → 기본 120분
  eq("offsetMin 없으면 120분 소요 가정", [w.startMin, w.endMin], [at("07:20"), at("10:20")]);
}
{
  const w = computeRouteWindow({ departTime: "07:50" }, [{ offsetMin: 80 }], { preMin: 10, postMin: 5 });
  eq("회사 기본값 반영(10/5)", [w.startMin, w.endMin], [at("07:40"), at("09:15")]);
}
{
  const w = computeRouteWindow({ departTime: "00:10" }, [{ offsetMin: 30 }], {});
  eq("자정 이전은 0 으로 클램프", w.startMin, 0);
  const w2 = computeRouteWindow({ departTime: "23:30" }, [{ offsetMin: 60 }], {});
  eq("자정 이후는 23:59 로 클램프", w2.endMin, 1439);
}

console.log("\n[4] 명시 창 — 관리자가 직접 넣으면 최우선(온세미 다회차)");
{
  const r = { departTime: "07:00", displayStart: "07:00", displayEnd: "19:00" };
  const w = computeRouteWindow(r, [{ offsetMin: 40 }], {});
  eq("명시 창 채택", [w.startMin, w.endMin, w.source], [at("07:00"), at("19:00"), "explicit"]);
  ok("오후 3시에도 보인다(파생이면 안 보였을 시각)", isWithinRouteWindow(w, at("15:00")));
  ok("20:00 은 밖", !isWithinRouteWindow(w, at("20:00")));
  // 같은 노선을 파생으로 계산하면 오후엔 닫힌다 — 명시 창이 실제로 문제를 푸는지 확인
  const derived = computeRouteWindow({ departTime: "07:00" }, [{ offsetMin: 40 }], {});
  ok("파생 창이었다면 15:00 은 밖", !isWithinRouteWindow(derived, at("15:00")));
}

console.log("\n[5] 자정을 넘긴 명시 창(야간조)");
{
  const w = computeRouteWindow({ displayStart: "22:00", displayEnd: "02:00" }, [], {});
  ok("23:00 안", isWithinRouteWindow(w, at("23:00")));
  ok("01:00 안", isWithinRouteWindow(w, at("01:00")));
  ok("12:00 밖", !isWithinRouteWindow(w, at("12:00")));
  ok("02:01 밖", !isWithinRouteWindow(w, at("02:01")));
}

console.log("\n[6] 회사 기본값 정규화");
eq("부재는 기본 30/30", normalizeWindowOpts(undefined), { preMin: WINDOW_PRE_MIN_DEFAULT, postMin: WINDOW_POST_MIN_DEFAULT });
eq("문자열 숫자 허용", normalizeWindowOpts({ gpsWindowPreMin: "15", gpsWindowPostMin: 45 }), { preMin: 15, postMin: 45 });
eq("0 허용", normalizeWindowOpts({ gpsWindowPreMin: 0, gpsWindowPostMin: 0 }), { preMin: 0, postMin: 0 });
eq("음수는 기본값", normalizeWindowOpts({ gpsWindowPreMin: -5 }).preMin, WINDOW_PRE_MIN_DEFAULT);
eq("240 초과는 기본값", normalizeWindowOpts({ gpsWindowPostMin: 999 }).postMin, WINDOW_POST_MIN_DEFAULT);
eq("쓰레기값은 기본값", normalizeWindowOpts({ gpsWindowPreMin: "abc" }).preMin, WINDOW_PRE_MIN_DEFAULT);

console.log("\n[7] 시각을 못 구하면 가리지 않는다");
{
  const w = computeRouteWindow({ departTime: "07:50" }, [], {});
  ok("nowMin null 이면 표시", isWithinRouteWindow(w, null));
  ok("nowMin undefined 면 표시", isWithinRouteWindow(w, undefined));
}

console.log("\n[8] 회귀 가드 — 소스에 관대한 폴백이 남아 있는지");
{
  const src = fs.readFileSync(path.join(__dirname, "..", "src/lib/routeWindow.js"), "utf8");
  ok("창 없음(null) 폴백 유지", /if \(!win\) return true;/.test(src));
  ok("departTime 없으면 null 반환 유지", /if \(dep === null\) return null;/.test(src));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} pass ${pass} / fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
