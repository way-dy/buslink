// getRouteStopArrivals 대조 검증 — **익명 클라이언트로 실제 호출**해 Admin SDK 실값과 맞춘다.
//
//   node scripts/test_stop_arrivals_call.cjs [노선이름일부]
//
// 🔴 이 CF 가 생긴 이유 자체가 "익명은 dispatches 를 못 읽는다" 이므로, 검증도
//    **익명 로그인으로** 해야 의미가 있다(서비스 계정으로 부르면 늘 통과한다).
// 🔴 도착 기록이 하루도 없으면 "일치"가 공허하다 → 신호 유무를 검사 0번으로 둔다.
// 병합 규칙(정류장마다 가장 이른 actualAt)을 여기서 **독립 재구현**해 서버 응답과 대조한다.
// prod 쓰기 0.
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const COMPANY = "dy001";

function loadAdminDb() {
  const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
  const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
  const sa = require(path.join(ROOT, "key", kf));
  if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치: " + sa.project_id);
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  return admin.firestore();
}
function loadEnv() {
  return Object.fromEntries(
    fs.readFileSync(path.join(ROOT, ".env.local"), "utf8")
      .split(/\r?\n/).filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
  );
}

(async () => {
  let fail = 0;
  const ok = (n, c, x) => { console.log(`  ${c ? "✓" : "✗"} ${n}${!c && x !== undefined ? " → " + x : ""}`); if (!c) fail++; };

  const db = loadAdminDb();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
  const q = process.argv[2] || "";

  // ── 정답지: Admin SDK 로 오늘 배차를 읽어 노선별로 병합(서버와 독립 구현) ──
  const dispSnap = await db.collection("companies").doc(COMPANY)
    .collection("dispatches").doc(today).collection("list").get();
  const truth = {};   // routeId -> { count, arrivals }
  dispSnap.docs.forEach((d) => {
    const v = d.data() || {};
    if (!v.routeId) return;
    if (q && !String(v.routeName || "").includes(q)) return;
    const b = (truth[v.routeId] = truth[v.routeId] || { count: 0, arrivals: {}, name: v.routeName || "" });
    b.count += 1;
    Object.entries(v.stopArrivals || {}).forEach(([sid, rec]) => {
      const at = rec && rec.actualAt;
      const ms = at && typeof at.toMillis === "function" ? at.toMillis() : (typeof at === "number" ? at : null);
      if (ms == null) return;
      if (b.arrivals[sid] == null || ms < b.arrivals[sid]) b.arrivals[sid] = ms;
    });
  });
  const routeIds = Object.keys(truth);
  const withArrivals = routeIds.filter((r) => Object.keys(truth[r].arrivals).length > 0);
  const totalStops = withArrivals.reduce((a, r) => a + Object.keys(truth[r].arrivals).length, 0);

  console.log(`\n${today} · 대상 노선 ${routeIds.length}개 · 도착 기록 있는 노선 ${withArrivals.length}개(정류장 ${totalStops}개)`);
  ok("[0] 신호 있음 — 오늘 도착 기록이 실제로 있다", totalStops > 0, totalStops);
  if (totalStops === 0) { console.log("  ↳ 대조할 값이 없다. 운행 시간 뒤에 다시 돌릴 것(SKIP)."); process.exit(0); }

  // ── 익명 클라이언트로 CF 호출 ──
  const env = loadEnv();
  const { initializeApp } = require(path.join(ROOT, "node_modules/firebase/app"));
  const { getAuth, signInAnonymously } = require(path.join(ROOT, "node_modules/firebase/auth"));
  const { getFunctions, httpsCallable } = require(path.join(ROOT, "node_modules/firebase/functions"));
  const { getFirestore, collection, getDocs } = require(path.join(ROOT, "node_modules/firebase/firestore"));
  const app = initializeApp({
    apiKey: env.REACT_APP_FIREBASE_API_KEY,
    authDomain: env.REACT_APP_FIREBASE_AUTH_DOMAIN,
    projectId: env.REACT_APP_FIREBASE_PROJECT_ID,
    storageBucket: env.REACT_APP_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
    appId: env.REACT_APP_FIREBASE_APP_ID,
  });
  await signInAnonymously(getAuth(app));
  const call = httpsCallable(getFunctions(app, "us-central1"), "getRouteStopArrivals");

  // 대조군 — 익명이 dispatches 를 직접 읽으면 여전히 막혀야 한다(그래야 이 CF 가 필요한 게 맞다)
  let directDenied = false;
  try {
    await getDocs(collection(getFirestore(app), "companies", COMPANY, "dispatches", today, "list"));
  } catch (e) { directDenied = e.code === "permission-denied"; }
  ok("[1] 대조군 — 익명 직접 읽기는 여전히 거부된다(규칙 완화 안 함)", directDenied);

  // 한 노선(승객앱 패턴)
  const one = withArrivals[0];
  const r1 = (await call({ companyId: COMPANY, routeIds: one })).data;
  ok("[2] 한 노선 호출 — 날짜가 오늘", r1.date === today, r1.date);
  ok(`[3] 한 노선 도착 기록이 실값과 일치(${truth[one].name})`,
    JSON.stringify(r1.routes[one].arrivals) === JSON.stringify(truth[one].arrivals),
    JSON.stringify(r1.routes[one].arrivals));
  ok("[4] 배차 건수도 함께 온다(운행 종료 판정용)", r1.routes[one].count === truth[one].count, r1.routes[one].count);

  // 여러 노선 묶음(협력사 포털 패턴 — 10개 단위 chunk 를 넘겨 본다)
  const many = routeIds.slice(0, Math.min(25, routeIds.length));
  const rN = (await call({ companyId: COMPANY, routeIds: many })).data;
  const missing = many.filter((r) => !rN.routes[r]);
  ok(`[5] 묶음 호출 ${many.length}개 전부 응답에 있다(10개 chunk 경계 포함)`, missing.length === 0, missing.slice(0, 5));
  const mismatch = many.filter((r) =>
    JSON.stringify(rN.routes[r].arrivals) !== JSON.stringify(truth[r].arrivals) ||
    rN.routes[r].count !== truth[r].count);
  ok("[6] 묶음 응답이 노선별 실값과 전부 일치", mismatch.length === 0,
    mismatch.slice(0, 3).map((r) => truth[r].name));

  // 모르는 노선 → 빈 값(오류 아님). 화면이 폴백만 하면 되게.
  const rUnknown = (await call({ companyId: COMPANY, routeIds: ["__no_such_route__"] })).data;
  ok("[7] 없는 노선은 count 0·빈 도착기록(오류 아님)",
    rUnknown.routes.__no_such_route__ && rUnknown.routes.__no_such_route__.count === 0 &&
    Object.keys(rUnknown.routes.__no_such_route__.arrivals).length === 0);

  // 입력 가드
  let badArg = "";
  try { await call({ companyId: COMPANY, routeIds: [] }); } catch (e) { badArg = e.code || e.message; }
  ok("[8] 빈 routeIds 는 거부", /invalid-argument/.test(badArg), badArg);
  let tooMany = "";
  try { await call({ companyId: COMPANY, routeIds: Array.from({ length: 41 }, (_, i) => "r" + i) }); }
  catch (e) { tooMany = e.code || e.message; }
  ok("[9] 41개는 거부(상한 40)", /invalid-argument/.test(tooMany), tooMany);

  // 반환에 기사명·차량번호가 섞이지 않았는지(최소 노출)
  const leaked = JSON.stringify(rN).match(/driverName|vehicleNo|driverId|departTime/);
  ok("[10] 도착 기록 외 배차 정보(기사명·차량번호)는 반환하지 않는다", !leaked, leaked && leaked[0]);

  console.log(`\n${fail === 0 ? "✅ 통과" : `❌ ${fail}건 실패`}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
