// 빈 차 확인 서버 가드 실호출 검증 — 2026-08-18 way "인쇄한 QR 을 사진 찍어 도용할 수 있지 않나".
//
//   node scripts/test_sleep_guard_live.cjs
//
// 🔴 **익명 클라이언트로 실제 CF 를 부른다** — 그게 도용자가 서 있는 자리다.
//    ① 운행 시간창 밖 노선은 **거부**되는지(차고지·전날·다음날 미리 찍기 차단)
//    ② 창 안 노선은 통과하되 **위치·경과초가 기록**되는지(막지 않고 드러내기)
//    ③ 멀리서 찍으면 nearOk=false 로 남는지
// 🔴 검사가 남긴 확인 기록은 **반드시 지운다**(안 지우면 그 운행이 확인됨으로 굳는다).
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const CID = "dy001";

function loadEnv() {
  return Object.fromEntries(
    fs.readFileSync(path.join(ROOT, ".env.local"), "utf8")
      .split(/\r?\n/).filter(l => l.includes("=") && !l.trim().startsWith("#"))
      .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
}
function loadAdmin() {
  const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
  const kf = fs.readdirSync(path.join(ROOT, "key")).find(f => f.endsWith(".json"));
  const sa = require(path.join(ROOT, "key", kf));
  if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치");
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  return { admin, db: admin.firestore() };
}
const hhmmToMin = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim()); return m ? +m[1] * 60 + +m[2] : null; };

(async () => {
  let fail = 0;
  const ok = (n, c, x) => { console.log(`  ${c ? "✓" : "✗"} ${n}${!c && x !== undefined ? " → " + x : ""}`); if (!c) fail++; };

  const { admin, db } = loadAdmin();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
  const kst = new Date(Date.now() + 9 * 3600e3);
  const nowMin = kst.getUTCHours() * 60 + kst.getUTCMinutes();

  const routes = {};
  (await db.collection("companies").doc(CID).collection("routes").get()).docs
    .forEach(d => { const v = d.data() || {}; routes[d.id] = { name: v.name, departTime: v.departTime, displayStart: v.displayStart, displayEnd: v.displayEnd }; });
  const listRef = db.collection("companies").doc(CID).collection("dispatches").doc(today).collection("list");
  const disp = (await listRef.get()).docs.map(d => ({ id: d.id, ...(d.data() || {}) }));

  // 🔴 창 밖 표본은 **차량 단위**로 골라야 한다 — 서버(resolveStaticDispatchAdmin)는 그 차량의
  //    오늘 배차 중 **지금과 가장 가까운 회차**를 다시 고른다. 배차 문서 하나만 보고 "창 밖"이라
  //    단정하면, 같은 차량이 지금 다른 회차를 뛰고 있어 통과한다(2026-08-18 실측으로 걸렀다).
  const byVeh = {};
  disp.forEach(d => { if (d.vehicleId) (byVeh[d.vehicleId] = byVeh[d.vehicleId] || []).push(d); });
  const outside = Object.values(byVeh).map(list => {
    const deps = list.map(d => hhmmToMin((routes[d.routeId] || {}).departTime)).filter(v => v !== null);
    if (deps.length !== list.length) return null;                       // 출발시각 없는 회차가 섞이면 판정 불가
    if (list.some(d => d.sleepingCheck)) return null;
    const nearest = Math.min(...deps.map(v => Math.abs(nowMin - v)));
    return nearest > 240 ? list[0] : null;                              // 모든 회차가 4시간 이상 떨어짐
  }).find(Boolean);
  // 창 안 = 출발시각이 최근(±90분)
  const inside = disp.find(d => {
    if (d.sleepingCheck || !d.vehicleId) return false;
    const dep = hhmmToMin((routes[d.routeId] || {}).departTime);
    return dep !== null && Math.abs(nowMin - dep) <= 90;
  });

  console.log(`\n${today} · 지금 ${String(Math.floor(nowMin / 60)).padStart(2, "0")}:${String(nowMin % 60).padStart(2, "0")} KST`);
  console.log(`  창 밖 표본: ${outside ? `${outside.vehicleNo} · ${outside.routeName}` : "없음"}`);
  console.log(`  창 안 표본: ${inside ? `${inside.vehicleNo} · ${inside.routeName}` : "없음"}`);
  ok("[0] 신호 있음 — 두 표본 중 하나 이상", !!(outside || inside));
  if (!outside && !inside) { console.log("  ↳ 판정 불가(SKIP)"); process.exit(0); }

  const env = loadEnv();
  const { initializeApp } = require(path.join(ROOT, "node_modules/firebase/app"));
  const { getAuth, signInAnonymously } = require(path.join(ROOT, "node_modules/firebase/auth"));
  const { getFunctions, httpsCallable } = require(path.join(ROOT, "node_modules/firebase/functions"));
  const app = initializeApp({
    apiKey: env.REACT_APP_FIREBASE_API_KEY, authDomain: env.REACT_APP_FIREBASE_AUTH_DOMAIN,
    projectId: env.REACT_APP_FIREBASE_PROJECT_ID, storageBucket: env.REACT_APP_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID, appId: env.REACT_APP_FIREBASE_APP_ID,
  });
  await signInAnonymously(getAuth(app));
  const call = httpsCallable(getFunctions(app, "us-central1"), "recordSleepingCheck");

  const cleanup = [];
  try {
    if (outside) {
      let msg = "";
      try { await call({ companyId: CID, vehicleId: outside.vehicleId, via: "qr" }); }
      catch (e) { msg = e?.message || ""; }
      ok("[1] 🔴 운행 시간창 밖 확인은 거부된다(미리·나중에 찍기 차단)", /운행 시간이 아닙니다/.test(msg), msg || "거부 안 됨(통과)");
      if (!msg) cleanup.push(outside.id);
    }
    if (inside) {
      // 서울시청 좌표 = 인천 송도·판교 어디서든 수 km 밖 → "먼 곳에서 찍음" 재현
      const r = await call({ companyId: CID, vehicleId: inside.vehicleId, via: "qr", lat: 37.5665, lng: 126.9780 });
      cleanup.push(inside.id);
      const d = r.data || {};
      ok("[2] 창 안 확인은 통과한다(막지 않는다)", d.ok === true && d.alreadyChecked === false, JSON.stringify(d));
      ok("[3] 🔴 멀리서 찍힌 것이 기록된다(nearOk=false)", d.nearOk === false, JSON.stringify({ distanceM: d.distanceM, nearOk: d.nearOk }));
      const saved = ((await listRef.doc(inside.id).get()).data() || {}).sleepingCheck || {};
      ok("[4] 거리·기준·경과초가 문서에 남는다", typeof saved.distanceM === "number" && !!saved.distanceRef,
        JSON.stringify({ distanceM: saved.distanceM, ref: saved.distanceRef, after: saved.afterTerminalSec }));
      console.log(`     (거리 ${saved.distanceM}m · 기준 ${saved.distanceRef} · 종점 도착 후 ${saved.afterTerminalSec ?? "-"}초)`);
    }
  } finally {
    for (const id of cleanup) {
      await listRef.doc(id).update({ sleepingCheck: admin.firestore.FieldValue.delete() }).catch(() => {});
    }
    let left = 0;
    for (const id of cleanup) {
      const c = (await listRef.doc(id).get()).data() || {};
      if (c.sleepingCheck) left++;
    }
    ok("[5] 검사가 남긴 확인 기록을 전부 지웠다", left === 0, left);
  }

  console.log(`\n${fail === 0 ? "✅ 통과" : `❌ ${fail}건 실패`}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
