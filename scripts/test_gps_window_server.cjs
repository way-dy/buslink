// 격리 테스트 — functions/index.js 의 GPS 시간창(computeGpsWindow / gpsWindowContains /
// normalizeGpsWindowOpts)이 클라 미러(src/lib/routeWindow.js)와 **같은 판정**을 하는지.
//   node scripts/test_gps_window_server.cjs
//
// 🔴 두 구현이 어긋나면 "관제엔 있는데 승객앱엔 없는"(또는 반대) 상태가 된다.
//    NFC UID 정규화(2026-07-22)에서 겪은 이중 구현 함정과 같은 클래스라 일치를 직접 검증한다.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");

// ── 서버 구현 추출 (functions/index.js 에서 해당 함수들만 떼어 평가) ──
function loadServer() {
  const src = fs.readFileSync(path.join(root, "functions/index.js"), "utf8");
  const grab = (name) => {
    const i = src.indexOf(`function ${name}(`);
    if (i < 0) throw new Error(`서버 함수 ${name} 없음`);
    // 중괄호 균형으로 함수 끝 찾기
    let d = 0, started = false, j = i;
    for (; j < src.length; j++) {
      if (src[j] === "{") { d++; started = true; }
      else if (src[j] === "}") { d--; if (started && d === 0) { j++; break; } }
    }
    return src.slice(i, j);
  };
  const consts = /const GPS_WINDOW_PRE_MIN = \d+;[\s\S]*?const GPS_WINDOW_DEFAULT_DURATION_MIN = \d+;/.exec(src);
  if (!consts) throw new Error("GPS_WINDOW_* 상수 블록 없음");
  const code = [
    consts[0],
    grab("hhmmToMinutes"),
    grab("computeGpsWindow"),
    grab("gpsWindowContains"),
    grab("normalizeGpsWindowOpts"),
  ].join("\n");
  const ctx = vm.createContext({ console, Number, Math, String, isFinite });
  vm.runInContext(code, ctx);
  return ctx;
}

// ── 클라 구현 추출 ──
function loadClient() {
  let src = fs.readFileSync(path.join(root, "src/lib/routeWindow.js"), "utf8")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["'][^"']+["'];?$/gm, "")
    .replace(/^export\s+function\s+/gm, "function ")
    .replace(/^export\s+const\s+/gm, "var ");
  const ctx = vm.createContext({ console, Intl, Date, Number, Math, String });
  vm.runInContext(src, ctx);
  return ctx;
}

const S = loadServer();
const C = loadClient();

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`); }
}

const at = (s) => C.hhmmToMinutes(s);

// 서버 meta 와 클라 route/stops 는 모양이 다르다 — 같은 사실을 각자 형태로 넘긴다.
const CASES = [
  { label: "출발시각만", route: { departTime: "07:50" }, stops: [{ offsetMin: 80 }] },
  { label: "offsetMin 없음", route: { departTime: "07:50" }, stops: [] },
  { label: "명시 창", route: { departTime: "07:00", displayStart: "07:00", displayEnd: "19:00" }, stops: [{ offsetMin: 40 }] },
  { label: "명시 창 + offset 무관", route: { departTime: "22:00", displayStart: "22:00", displayEnd: "02:00" }, stops: [{ offsetMin: 90 }] },
  { label: "설정 전무(게이트 없음)", route: {}, stops: [] },
  { label: "표시시간 한쪽만", route: { departTime: "06:00", displayStart: "05:00" }, stops: [] },
  { label: "자정 클램프(이른 출발)", route: { departTime: "00:10" }, stops: [{ offsetMin: 30 }] },
  { label: "자정 클램프(늦은 출발)", route: { departTime: "23:30" }, stops: [{ offsetMin: 60 }] },
];
const OPTS = [undefined, { preMin: 30, postMin: 30 }, { preMin: 0, postMin: 0 }, { preMin: 60, postMin: 90 }];

console.log("\n[1] 서버 창 == 클라 창 (전 조합)");
for (const c of CASES) {
  for (const o of OPTS) {
    const sv = S.computeGpsWindow({ departTime: c.route.departTime || "", displayStart: c.route.displayStart || "", displayEnd: c.route.displayEnd || "", stops: c.stops }, o);
    const cw = C.computeRouteWindow(c.route, c.stops, o);
    const norm = (w) => (w ? { startMin: w.startMin, endMin: w.endMin } : null);
    ok(`${c.label} / opts=${o ? `${o.preMin}/${o.postMin}` : "기본"}`,
      JSON.stringify(norm(sv)) === JSON.stringify(norm(cw)), { server: norm(sv), client: norm(cw) });
  }
}

console.log("\n[2] 서버 창-포함 판정 == 클라 판정 (하루 전 구간)");
{
  let mismatch = 0;
  for (const c of CASES) {
    const sv = S.computeGpsWindow({ departTime: c.route.departTime || "", displayStart: c.route.displayStart || "", displayEnd: c.route.displayEnd || "", stops: c.stops }, undefined);
    const cw = C.computeRouteWindow(c.route, c.stops, undefined);
    for (let m = 0; m < 1440; m += 7) {
      if (S.gpsWindowContains(sv, m) !== C.isWithinRouteWindow(cw, m)) mismatch++;
    }
  }
  ok("1440분 전 구간에서 불일치 0", mismatch === 0, { mismatch });
}

console.log("\n[3] 회사 기본값 정규화 일치");
for (const co of [undefined, {}, { gpsWindowPreMin: 15, gpsWindowPostMin: 45 }, { gpsWindowPreMin: "10" },
                  { gpsWindowPreMin: -1 }, { gpsWindowPostMin: 999 }, { gpsWindowPreMin: 0, gpsWindowPostMin: 0 }]) {
  ok(`정규화 ${JSON.stringify(co)}`,
    JSON.stringify(S.normalizeGpsWindowOpts(co)) === JSON.stringify(C.normalizeWindowOpts(co)),
    { server: S.normalizeGpsWindowOpts(co), client: C.normalizeWindowOpts(co) });
}

console.log("\n[4] 온세미 시나리오 — 명시 창이 실제로 오후 회차를 살리는지");
{
  const route = { departTime: "07:00", displayStart: "07:00", displayEnd: "19:00" };
  const stops = [{ offsetMin: 40 }];
  const withExplicit = S.computeGpsWindow({ departTime: "07:00", displayStart: "07:00", displayEnd: "19:00", stops }, undefined);
  const derived = S.computeGpsWindow({ departTime: "07:00", displayStart: "", displayEnd: "", stops }, undefined);
  ok("명시 창이면 15:00 에 수집된다", S.gpsWindowContains(withExplicit, at("15:00")));
  ok("파생 창이었다면 15:00 은 끊긴다(이게 문제였던 것)", !S.gpsWindowContains(derived, at("15:00")));
  ok("클라도 같은 판정", C.isWithinRouteWindow(C.computeRouteWindow(route, stops), at("15:00")));
}

console.log("\n[5] 회귀 가드 — 소스 단언");
{
  const fsrc = fs.readFileSync(path.join(root, "functions/index.js"), "utf8");
  ok("loadRouteMeta 가 displayStart/End 를 싣는다", /meta = \{ departTime:[^}]*displayStart/.test(fsrc));
  ok("폴러가 회사 기본값을 넘긴다", /pickActiveDispatch\(db, cid, candidates, nowMin, routeMetaCache, winOpts\)/.test(fsrc));
  ok("창 판정이 자정 넘김을 처리한다", /function gpsWindowContains/.test(fsrc));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} pass ${pass} / fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
