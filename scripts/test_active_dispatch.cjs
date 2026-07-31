// 격리 테스트 — 단말(유비칸) 폴러의 회차 선택(functions/index.js `pickActiveDispatch`).
//   node scripts/test_active_dispatch.cjs
//
// 배경(2026-07-31 배시현 신고 "오전 관제가 안된다"): 한 차량이 등교·하교를 모두 뛰는데
// 폴러가 vehicleId 맵에 배차를 덮어써 **1건만** 남겼고, 그 1건의 시간창으로만 판정해
// 나머지 회차 좌표가 통째로 차단됐다. prod 실측 = 오늘 27대 중 10대가 다중 회차,
// 그중 4대가 오전 좌표 0~4건(등교 대신 하교 배차가 뽑힌 차량들).
//
// 실제 소스에서 함수를 뽑아 평가한다 — 구현이 바뀌면 이 테스트가 같이 깨져야 한다.
// loadRouteMeta 만 픽스처 stub(Firestore 접근 제거), 나머지는 진짜 소스.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "functions", "index.js"), "utf8");
const grab = (name) => {
  const m = src.match(new RegExp(`(?:async )?function ${name}\\s*\\([\\s\\S]*?\\n\\}`));
  if (!m) throw new Error(`${name} 를 소스에서 못 찾음`);
  return m[0];
};
const constOf = (name) => {
  const m = src.match(new RegExp(`const ${name}\\s*=\\s*([0-9]+)`));
  return m ? Number(m[1]) : null;
};

// 노선 픽스처 — routeId → { departTime, stops }
const ROUTES = {
  going:   { departTime: "07:00", stops: [{ id: "g1", offsetMin: 0 }, { id: "g2", offsetMin: 75 }] },   // 창 06:30~08:45
  coming:  { departTime: "15:50", stops: [{ id: "c1", offsetMin: 0 }, { id: "c2", offsetMin: 70 }] },   // 창 15:20~17:30
  coming2: { departTime: "15:50", stops: [{ id: "d1", offsetMin: 0 }, { id: "d2", offsetMin: 60 }] },   // 창 15:20~17:20
  early:   { departTime: "15:00", stops: [{ id: "e1", offsetMin: 0 }, { id: "e2", offsetMin: 60 }] },   // 창 14:30~16:30
  nodepart:{ departTime: "",     stops: [{ id: "n1", offsetMin: 0 }] },                                  // 게이트 없음
};

const ctx = vm.createContext({ console });
vm.runInContext(grab("hhmmToMinutes"), ctx);
vm.runInContext(`var GPS_WINDOW_PRE_MIN=${constOf("GPS_WINDOW_PRE_MIN")};`, ctx);
vm.runInContext(`var GPS_WINDOW_POST_MIN=${constOf("GPS_WINDOW_POST_MIN")};`, ctx);
vm.runInContext(`var GPS_WINDOW_DEFAULT_DURATION_MIN=${constOf("GPS_WINDOW_DEFAULT_DURATION_MIN")};`, ctx);
vm.runInContext(grab("computeGpsWindow"), ctx);
// loadRouteMeta stub — 픽스처만 반환(실제 구현은 Firestore 읽기라 격리 대상에서 제외).
ctx.ROUTES = ROUTES;
vm.runInContext(`async function loadRouteMeta(db, cid, routeId, cache){ return ROUTES[routeId] || null; }`, ctx);
vm.runInContext(grab("pickActiveDispatch"), ctx);
const { pickActiveDispatch, computeGpsWindow } = ctx;

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${x !== undefined ? " — " + JSON.stringify(x) : ""}`); } };
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b), { actual: a, expected: b });

const at = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const D = (routeId, departTime, dispatchId) => ({ dispatchId: dispatchId || routeId, routeId, routeName: routeId, departTime });
const pick = async (list, hhmm) => {
  const r = await pickActiveDispatch(null, "dy001", list, at(hhmm), {});
  return r ? r.disp.routeId : null;
};

(async () => {
  console.log("\n[1] 🔴 신고 재현 — 서울72바7026(등교 07:00 + 하교 15:50 ×2)");
  // prod 실제 구성: [강남2]등교 07:00 · [강남2]하교 15:50 · [강남1]하교 15:50
  const REPORTED = [D("going", "07:00"), D("coming", "15:50", "gangnam2"), D("coming2", "15:50", "gangnam1")];
  eq("07:10 오전 운행 중 → 등교 회차", await pick(REPORTED, "07:10"), "going");
  eq("06:35 출발 전 여유 안 → 등교 회차", await pick(REPORTED, "06:35"), "going");
  eq("08:40 창 끝 직전 → 등교 회차", await pick(REPORTED, "08:40"), "going");
  eq("16:00 오후 운행 중 → 하교 회차", await pick(REPORTED, "16:00"), "coming");
  ok("12:00 회차 사이 → 없음(좌표 차단·gps 문서 정리)", (await pick(REPORTED, "12:00")) === null);
  ok("05:00 첫 운행 전 → 없음", (await pick(REPORTED, "05:00")) === null);
  ok("22:00 운행 종료 후 → 없음", (await pick(REPORTED, "22:00")) === null);

  console.log("\n[2] 옛 동작(마지막 1건만 사용) 이었다면 오전이 막혔다는 것");
  // last-wins = 문서 ID 순 마지막 = 하교. 그 창(15:20~17:30)에 07:10 은 들어가지 않는다.
  const onlyLast = computeGpsWindow(ROUTES.coming2);
  ok("하교 창만 보면 07:10 은 창 밖 = 차단(회귀 시 재현될 증상)",
    at("07:10") < onlyLast.startMin || at("07:10") > onlyLast.endMin);
  eq("고친 뒤에는 같은 시각에 등교가 잡힌다", await pick(REPORTED, "07:10"), "going");

  console.log("\n[3] 회차 1건 = 기존 동작 100% 보존");
  eq("창 안", await pick([D("going", "07:00")], "07:10"), "going");
  ok("창 밖 → 없음", (await pick([D("going", "07:00")], "13:00")) === null);
  ok("배차 0건 → 없음", (await pickActiveDispatch(null, "dy001", [], at("07:10"), {})) === null);

  console.log("\n[4] 🔴 departTime 미설정 노선 = 게이트 없음(레거시 관대 폴백 유지)");
  eq("단독이면 언제나 채택(새벽)", await pick([D("nodepart", "")], "03:00"), "nodepart");
  eq("단독이면 언제나 채택(한낮)", await pick([D("nodepart", "")], "13:00"), "nodepart");
  eq("🔴 창이 맞는 회차가 있으면 그쪽 우선(게이트 없는 회차가 가로채면 안 됨)",
    await pick([D("nodepart", ""), D("going", "07:00")], "07:10"), "going");
  eq("후보 순서를 뒤집어도 같은 결과", await pick([D("going", "07:00"), D("nodepart", "")], "07:10"), "going");
  eq("창 맞는 회차가 없을 때만 폴백", await pick([D("nodepart", ""), D("going", "07:00")], "13:00"), "nodepart");

  console.log("\n[5] 창이 겹치면 출발시각이 지금에 가까운 회차");
  const OVERLAP = [D("early", "15:00"), D("coming", "15:50")];
  eq("15:10 → 15:00 회차", await pick(OVERLAP, "15:10"), "early");
  eq("15:45 → 15:50 회차", await pick(OVERLAP, "15:45"), "coming");
  eq("순서 뒤집어도 동일(15:45)", await pick([D("coming", "15:50"), D("early", "15:00")], "15:45"), "coming");
  eq("16:45 → early 창 밖이라 coming", await pick(OVERLAP, "16:45"), "coming");

  console.log("\n[6] 선택된 회차의 meta 가 같이 나온다(도착감지가 그 노선 정류장을 봐야 함)");
  const r1 = await pickActiveDispatch(null, "dy001", REPORTED, at("07:10"), {});
  eq("오전엔 등교 노선 정류장", r1.meta.stops.map(s => s.id), ["g1", "g2"]);
  const r2 = await pickActiveDispatch(null, "dy001", REPORTED, at("16:00"), {});
  eq("오후엔 하교 노선 정류장", r2.meta.stops.map(s => s.id), ["c1", "c2"]);
  eq("dispatchId 도 그 회차 것", r2.disp.dispatchId, "gangnam2");

  console.log("\n[7] 🔴 회귀 가드 — 소스에 안전장치가 실제로 있는가");
  ok("배차를 배열로 모은다(last-wins 덮어쓰기 재도입 금지)",
    /dispByVehicle\[v\.vehicleId\] \|\| \[\]\)\.push\(/.test(src));
  ok("dispByVehicle 에 단건 대입이 없다",
    !/dispByVehicle\[v\.vehicleId\]\s*=\s*\{/.test(src));
  ok("폴러가 pickActiveDispatch 를 호출한다", /await pickActiveDispatch\(db, cid, candidates/.test(src));
  ok("창 밖/미배차면 gps 문서를 정리한다", (src.match(/await cleanupDeviceGpsDoc\(db, cid, vehicleId\)/g) || []).length >= 2);
  ok("15분 신선도 가드 유지", /nowMin - coordMin\) > 15/.test(src));

  console.log(`\n${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
