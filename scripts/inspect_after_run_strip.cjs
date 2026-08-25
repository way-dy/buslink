// 운행 종료 뒤 노선도가 다시 파래지는가 — 실측(2026-08-25 채드윅 배시현 신고).
//   node scripts/inspect_after_run_strip.cjs [YYYY-MM-DD] [노선이름일부]
//
// 신고: "운행이 끝나 다 회색으로 바뀌었는데 10~20분 뒤에 갑자기 어느 부분만 파란색으로 뜬다.
//        기사가 운행 끝나고 판교 쪽에 가 있으면."
//
// 🔴 화면이 색을 정하는 식을 **베끼지 않고 EmployeeApp 소스에서 그대로 뽑아** 태운다:
//      usePathProgress = routePath 2점 이상
//      busProj  = projectToPolyline(bus, routePath)
//      busProgress = perpDist <= OFF_ROUTE_M(70) ? proj.progress : 직전 유효값(ref 유지)
//      busStopIdx = busProgress 지난 마지막 정류장(+PASSED_MARGIN_M)
//      inService  = !!mainBus && busStopIdx >= 0
//      isReached  = inService && i <= busStopIdx      ← 파란색
//   즉 **`runEnded` 를 안 본다**(그게 이 신고의 가설이다).
// prod 쓰기 0.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = path.join(__dirname, "..");
const DATE = process.argv[2] || "2026-08-24";
const QUERY = process.argv[3] || "하교";

// ── routeProgress 정본을 그대로 태운다 ──────────────────────────────────────
function loadRouteProgress() {
  const src = fs.readFileSync(path.join(ROOT, "src/lib/routeProgress.js"), "utf8")
    .replace(/^export function /gm, "function ");
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(src + "\n;this.__m = { projectToPolyline, buildCumulativeLengths, haversine };", ctx);
  return ctx.__m;
}
// EmployeeApp 소스에서 상수를 뽑는다(손으로 옮겨 적으면 화면과 어긋난다).
function readConst(name) {
  const src = fs.readFileSync(path.join(ROOT, "src/pages/EmployeeApp.js"), "utf8");
  const m = new RegExp(`^const ${name} = (\\d+)`, "m").exec(src);
  if (!m) throw new Error(`${name} 을 소스에서 못 찾음`);
  return Number(m[1]);
}

const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
const sa = require(path.join(ROOT, "key", kf));
if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치");
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const COMPANY = "dy001";
const hhmm = (ms) => new Date(ms).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour12: false });

(async () => {
  const RP = loadRouteProgress();
  const OFF_ROUTE_M = readConst("OFF_ROUTE_M");
  const PASSED_MARGIN_M = readConst("PASSED_MARGIN_M");
  console.log(`\n소스에서 읽은 상수 · OFF_ROUTE_M=${OFF_ROUTE_M} · PASSED_MARGIN_M=${PASSED_MARGIN_M}`);

  // 대상 = 그날 그 이름의 배차 중 종점 도착 기록이 있는 것
  const dsnap = await db.collection("companies").doc(COMPANY)
    .collection("dispatches").doc(DATE).collection("list").get();
  const cands = dsnap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((d) => String(d.routeName || "").includes(QUERY) && d.stopArrivals && Object.keys(d.stopArrivals).length);
  if (!cands.length) { console.log(`⏭ ${DATE} 에 '${QUERY}' 도착 기록 배차 없음`); process.exit(0); }

  for (const disp of cands.slice(0, 3)) {
    const rsnap = await db.collection("companies").doc(COMPANY).collection("routes").doc(disp.routeId).get();
    const route = rsnap.exists ? rsnap.data() : {};
    const ssnap = await db.collection("companies").doc(COMPANY).collection("routes").doc(disp.routeId)
      .collection("stops").orderBy("order", "asc").get();
    const stops = ssnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const rawPath = Array.isArray(route.routePath) ? route.routePath : [];
    const routePath = rawPath.filter((p) => typeof p?.lat === "number" && typeof p?.lng === "number");
    const usePathProgress = routePath.length >= 2;

    const last = stops[stops.length - 1];
    const endMs = disp.stopArrivals?.[last?.id]?.actualAt?.toMillis?.() ?? null;
    console.log(`\n${"═".repeat(78)}\n${disp.routeName} · ${disp.vehicleNo || disp.vehicleId} · 정류장 ${stops.length} · 경로 ${routePath.length}점`);
    console.log(`  종점(${last?.name}) 도착 ${endMs ? hhmm(endMs) : "기록 없음"}`);
    if (!usePathProgress) { console.log("  ⏭ 경로 미설정 — 이 노선은 직선 폴백이라 대상 아님"); continue; }
    if (!endMs) continue;

    const cum = RP.buildCumulativeLengths(routePath);
    const stopProgresses = stops.map((s) => RP.projectToPolyline({ lat: s.lat, lng: s.lng }, routePath, cum)?.progress ?? 0);

    // 종점 도착 이후 그 차량의 GPS 이력
    const pts = await db.collection("gpsHistory").doc(COMPANY).collection(disp.vehicleId)
      .doc(DATE).collection("points").get();
    const after = pts.docs.map((d) => d.data())
      .map((p) => ({ lat: p.lat, lng: p.lng, ms: p.ts?.toMillis?.() ?? null, source: p.source, routeId: p.routeId }))
      .filter((p) => p.ms != null && p.ms >= endMs && typeof p.lat === "number")
      .sort((a, b) => a.ms - b.ms);
    console.log(`  종점 도착 이후 GPS 포인트 ${after.length}개`);
    if (!after.length) { console.log("  ↳ 종료 후 신호 없음 = 이 배차에서는 재활성 조건이 성립하지 않는다"); continue; }

    // 화면과 같은 순서로 재생 — lastBusProgressRef 유지 규칙까지 그대로
    let lastRef = null;
    let prevBlue = null;
    console.log(`  ${"시각".padEnd(9)}${"경로이탈".padEnd(10)}${"busProgress".padEnd(13)}${"busStopIdx".padEnd(11)}파란 정류장`);
    after.forEach((p, i) => {
      const proj = RP.projectToPolyline({ lat: p.lat, lng: p.lng }, routePath, cum);
      let busProgress = null;
      if (proj) {
        if (proj.perpDist <= OFF_ROUTE_M) { busProgress = proj.progress; lastRef = busProgress; }
        else busProgress = lastRef;
      }
      let idx = -1;
      if (busProgress !== null) { idx = 0; for (let k = 0; k < stopProgresses.length; k++) if (stopProgresses[k] <= busProgress + PASSED_MARGIN_M) idx = k; }
      const inService = idx >= 0;
      const blue = inService ? idx + 1 : 0;   // isReached = i <= busStopIdx → 파란 정류장 수
      const changed = prevBlue !== null && blue !== prevBlue;
      if (i < 4 || changed || i === after.length - 1) {
        console.log(`  ${hhmm(p.ms).padEnd(9)}${String(Math.round(proj?.perpDist ?? -1) + "m").padEnd(10)}${String(busProgress === null ? "—" : Math.round(busProgress) + "m").padEnd(13)}${String(idx).padEnd(11)}${blue}/${stops.length}${changed ? "   ← 변화" : ""}`);
      }
      prevBlue = blue;
    });

    // gps 현재 문서(운행 종료 후에도 남아 있나)
    const g = await db.collection("gps").doc(`${COMPANY}_${disp.vehicleId}`).get();
    if (g.exists) {
      const gd = g.data() || {};
      const gms = gd.updatedAt?.toMillis?.() ?? gd.ts?.toMillis?.() ?? null;
      console.log(`  gps 문서 잔존 · routeId=${gd.routeId === disp.routeId ? "이 노선" : gd.routeId || "-"} · source=${gd.source} · 마지막 ${gms ? hhmm(gms) : "?"}`);
    } else {
      console.log("  gps 문서 없음(삭제됨)");
    }
  }
  process.exit(0);
})();
