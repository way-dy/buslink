// 격리 테스트 — src/lib/runSignals.js (잔존 운행 신호 판정).
//   node scripts/test_run_signals.cjs
//
// runSignals.js 는 ESM + runStatus.js import 라 여기서 두 파일을 읽어 CJS 로 변환해 평가한다
// (CRA 빌드 없이 순수 로직만 검증 — buslink 격리 테스트 관례).
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadModule(relPath, deps = {}) {
  let src = fs.readFileSync(path.join(__dirname, "..", relPath), "utf8");
  src = src
    .replace(/^import\s+\{[^}]*\}\s+from\s+["'][^"']+["'];?$/gm, "")
    .replace(/^export\s+function\s+/gm, "function ")
    // vm 컨텍스트에서 top-level `const` 는 global 에 안 붙는다 → `var` 로 바꿔야 꺼내 쓸 수 있다.
    .replace(/^export\s+const\s+/gm, "var ");
  const ctx = vm.createContext({ ...deps, console });
  vm.runInContext(src, ctx);
  return ctx;
}

const statusCtx = loadModule("src/lib/runStatus.js");
const { gpsAgeMs, RUN_GPS_FRESH_MS } = statusCtx;
const signalsCtx = loadModule("src/lib/runSignals.js", { gpsAgeMs, RUN_GPS_FRESH_MS });
const { classifyRunSignals, isSignalStale, formatSignalAge, STALE_SIGNAL_MIN } = signalsCtx;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`); }
}
function eq(name, actual, expected) { ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected }); }

const NOW = Date.parse("2026-07-28T09:00:00+09:00");
const minsAgo = (m) => new Date(NOW - m * 60000).toISOString();
const ts = (m) => ({ toMillis: () => NOW - m * 60000 }); // Firestore Timestamp 흉내

console.log("\n[1] isSignalStale — 입력 형식 3종 + 경계");
ok("null(=serverTimestamp pending)은 잔존 아님", !isSignalStale(null, NOW));
ok("undefined 도 잔존 아님", !isSignalStale(undefined, NOW));
ok("ISO 문자열 5분 전 = 잔존 아님", !isSignalStale(minsAgo(5), NOW));
ok("ISO 문자열 30분 전 = 잔존", isSignalStale(minsAgo(30), NOW));
ok("Firestore Timestamp 30분 전 = 잔존", isSignalStale(ts(30), NOW));
ok("정확히 10분 = 잔존(경계 포함)", isSignalStale(minsAgo(STALE_SIGNAL_MIN), NOW));
ok("9분 59초 = 잔존 아님", !isSignalStale(new Date(NOW - (10 * 60000 - 1000)).toISOString(), NOW));
ok("파싱 불가 문자열 = 방금 취급(잔존 아님)", !isSignalStale("헛소리", NOW));

console.log("\n[2] formatSignalAge");
eq("25분", formatSignalAge(25 * 60000), "25분 전");
eq("3시간", formatSignalAge(3 * 3600000), "3시간 전");
eq("13일", formatSignalAge(13 * 24 * 3600000), "13일 전");
eq("0 이하는 방금", formatSignalAge(0), "방금");

console.log("\n[3] prod 실측 재현 — 고아 신호(조이형TEST)");
{
  // gps 문서는 남아 있는데 그 vehicleId 를 배정받은 기사가 없음(기사 삭제·차량 재배정).
  // → 어떤 기사가 로그아웃해도 안 지워진다. 관리자 강제 종료만이 유일한 경로.
  const gpsDocs = [{ id: "dy001_IgG40JBc3C0FR7qSdps1", vehicleId: "IgG40JBc3C0FR7qSdps1", source: "mobile", routeId: "r1", routeName: "[판교] 등교(월~수,금)", driverName: "조이형TEST", updatedAt: minsAgo(309 * 60) }];
  const drivers = [{ id: "other", name: "조이형", status: "대기", vehicleId: "HLHCul1kY1bIrXWkC7FO" }];
  const { staleSignals, strandedDrivers } = classifyRunSignals({ gpsDocs, drivers, now: NOW });
  eq("잔존 신호 1건", staleSignals.length, 1);
  ok("고아로 판정", staleSignals[0].orphan === true, staleSignals[0]);
  eq("되돌릴 기사 없음", staleSignals[0].ownerDriverId, null);
  eq("경과 라벨", staleSignals[0].ageLabel, "12일 전");
  eq("잔존 기사 0명(기사 status 는 이미 대기)", strandedDrivers.length, 0);
}

console.log("\n[4] prod 실측 재현 — 잔존 상태(박상제): gps 문서 없음 + status 운행중");
{
  const gpsDocs = [];
  const drivers = [{ id: "eUL6", name: "박상제", status: "운행중", vehicleId: "uAU9", vehicleNo: "경기76아6984", startedAt: "2026-07-10T08:17:04.213Z" }];
  const { staleSignals, strandedDrivers } = classifyRunSignals({ gpsDocs, drivers, now: NOW });
  eq("잔존 신호 0건(문서 자체가 없음)", staleSignals.length, 0);
  eq("잔존 기사 1명", strandedDrivers.length, 1);
  eq("기사 id", strandedDrivers[0].id, "eUL6");
  ok("gps 문서 없음 표기", strandedDrivers[0].hasGpsDoc === false);
}

console.log("\n[5] 운행 중인 기사는 잔존으로 잡지 않는다(오검출 = 운행 중 차량 강제 종료 위험)");
{
  const gpsDocs = [{ id: "c_v1", vehicleId: "v1", source: "mobile", updatedAt: minsAgo(0.3) }];
  const drivers = [{ id: "d1", name: "운행중기사", status: "운행중", vehicleId: "v1" }];
  const { staleSignals, strandedDrivers } = classifyRunSignals({ gpsDocs, drivers, now: NOW });
  eq("신선한 신호는 잔존 목록에 없음", staleSignals.length, 0);
  eq("신선 신호 내는 기사는 잔존 아님", strandedDrivers.length, 0);
}

console.log("\n[6] 신호가 잠깐(5분) 끊긴 운행 중 차량도 지우자고 제안하지 않는다");
{
  const gpsDocs = [{ id: "c_v1", vehicleId: "v1", source: "mobile", updatedAt: minsAgo(5) }];
  const drivers = [{ id: "d1", name: "터널통과중", status: "운행중", vehicleId: "v1" }];
  const { staleSignals, strandedDrivers } = classifyRunSignals({ gpsDocs, drivers, now: NOW });
  eq("5분 끊김은 잔존 신호 아님", staleSignals.length, 0);
  // 단 60초 신선도 기준으로는 '미수신' 이라 기존 GPS 미수신 경고에는 잡힌다(기존 동작 보존).
  eq("기존 GPS 미수신 경고 대상으로는 잡힘", strandedDrivers.length, 1);
  ok("gps 문서는 존재함을 표기", strandedDrivers[0].hasGpsDoc === true);
}

console.log("\n[7] 소유 기사 있는 잔존 신호 — 강제 종료가 기사 상태까지 되돌릴 수 있어야");
{
  const gpsDocs = [{ id: "dy001_vehicle_003", vehicleId: "vehicle_003", source: "mobile", routeName: "테스트노선", driverName: "배시현(TEST)", updatedAt: minsAgo(1102 * 60) }];
  const drivers = [{ id: "MBV6", name: "배시현(TEST)", status: "대기", vehicleId: "vehicle_003", vehicleNo: "254호2542" }];
  const { staleSignals } = classifyRunSignals({ gpsDocs, drivers, now: NOW });
  eq("고아 아님", staleSignals[0].orphan, false);
  eq("되돌릴 기사 id", staleSignals[0].ownerDriverId, "MBV6");
  eq("차량번호는 기사 문서에서 보완", staleSignals[0].vehicleNo, "254호2542");
}

console.log("\n[8] 정렬 — 오래된 신호가 먼저");
{
  const gpsDocs = [
    { id: "a", vehicleId: "a", updatedAt: minsAgo(20) },
    { id: "b", vehicleId: "b", updatedAt: minsAgo(9999) },
    { id: "c", vehicleId: "c", updatedAt: minsAgo(600) },
  ];
  const { staleSignals } = classifyRunSignals({ gpsDocs, drivers: [], now: NOW });
  eq("오래된 순", staleSignals.map((s) => s.id), ["b", "c", "a"]);
}

console.log("\n[9] device 신호도 잔존이면 잡되 source 를 그대로 전달(호출부가 안내 분기)");
{
  const gpsDocs = [{ id: "d", vehicleId: "d", source: "device", updatedAt: minsAgo(120) }];
  const { staleSignals } = classifyRunSignals({ gpsDocs, drivers: [], now: NOW });
  eq("source 보존", staleSignals[0].source, "device");
  eq("source 미기재는 mobile 기본", classifyRunSignals({ gpsDocs: [{ id: "x", vehicleId: "x", updatedAt: minsAgo(120) }], now: NOW }).staleSignals[0].source, "mobile");
}

console.log("\n[10] 빈 입력·결측 필드에도 throw 하지 않는다");
{
  eq("인자 없음", classifyRunSignals(), { staleSignals: [], strandedDrivers: [] });
  const r = classifyRunSignals({ gpsDocs: [null, {}], drivers: [null, {}], now: NOW });
  ok("null 요소 무시", Array.isArray(r.staleSignals) && Array.isArray(r.strandedDrivers));
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
