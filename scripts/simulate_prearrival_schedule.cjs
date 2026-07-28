// 도착 임박 시간표 폴백 — prod 실데이터 하루치 시뮬레이션 (읽기 전용·발송 0).
//   node scripts/simulate_prearrival_schedule.cjs [YYYY-MM-DD] [lead분]
//
// 알림을 보내는 기능은 배포 전에 **몇 건이 나갈지** 숫자로 확인해야 한다(알림 폭탄이 최대 위험).
// CF `notifyPreArrivalBySchedule` 과 같은 판정을 그대로 재현해 05:00~23:00 을 1분씩 돌린다.
// ⚠ 실제 발송·문서 write 는 하지 않는다. GPS 신선도는 과거 재현이 불가하므로
//   **"GPS 가 전혀 없었다"(최악 = 최대 발송)** 가정으로 상한을 본다.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const admin = require(path.join(__dirname, "..", "functions", "node_modules", "firebase-admin"));

// 판정 함수는 CF 소스에서 그대로 가져온다(구현이 갈라지지 않게).
const src = fs.readFileSync(path.join(__dirname, "..", "functions", "index.js"), "utf8");
const grab = (n) => src.match(new RegExp(`function ${n}\\s*\\([\\s\\S]*?\\n\\}`))[0];
const ctx = vm.createContext({ console });
vm.runInContext(grab("hhmmToMinutes"), ctx);
vm.runInContext("var PRE_ARRIVAL_LEAD_MIN_DEFAULT = 5;", ctx);
vm.runInContext(grab("dueStopsBySchedule"), ctx);
const { dueStopsBySchedule } = ctx;

const kd = path.join(__dirname, "..", "key");
const key = require(path.join(kd, fs.readdirSync(kd).find((f) => f.endsWith(".json"))));
if (key.project_id !== "buslink-prod") { console.error("project_id 불일치"); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();

const DAY = process.argv[2] || new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
const LEAD = Number(process.argv[3] || 5);
const CID = "dy001";

(async () => {
  console.log(`\n시뮬레이션 ${DAY} · lead ${LEAD}분 · 회사 ${CID}`);
  console.log("(GPS 가 하루종일 없었다고 가정 = 발송 상한)\n");

  const disp = await db.collection("companies").doc(CID).collection("dispatches").doc(DAY).collection("list").get();
  if (disp.empty) { console.log("그날 배차 없음"); process.exit(0); }

  // 노선 시간표 + 정류장별 '내 정류장' 지정 인원
  const routeCache = {};
  const tokenCount = {};   // `${routeId}__${stopId}` → 명
  const toks = await db.collection("companies").doc(CID).collection("fcmTokens").get();
  toks.docs.forEach((t) => {
    const v = t.data();
    if (v.routeId && v.stopId && v.token) {
      const k = `${v.routeId}__${v.stopId}`;
      tokenCount[k] = (tokenCount[k] || 0) + 1;
    }
  });

  async function schedOf(routeId) {
    if (routeId in routeCache) return routeCache[routeId];
    const r = await db.collection("companies").doc(CID).collection("routes").doc(routeId).get();
    let meta = null;
    if (r.exists) {
      const st = await r.ref.collection("stops").orderBy("order").get();
      meta = {
        departTime: (r.data() || {}).departTime || null,
        stops: st.docs.map((d) => ({ id: d.id, name: (d.data() || {}).name || "", offsetMin: typeof (d.data() || {}).offsetMin === "number" ? d.data().offsetMin : null })),
      };
    }
    routeCache[routeId] = meta;
    return meta;
  }

  let sendEvents = 0, pushes = 0, noTokenSkips = 0, noSchedule = 0;
  const perDispatch = [];
  for (const d of disp.docs) {
    const dv = d.data() || {};
    if (!dv.routeId) continue;
    const meta = await schedOf(dv.routeId);
    if (!meta || !meta.departTime) { noSchedule++; continue; }
    const notified = Array.isArray(dv.preArrivalNotified) ? [...dv.preArrivalNotified] : [];
    let cnt = 0, ppl = 0;
    // 05:00~23:00 을 1분씩 — CF 가 매분 도는 것과 동일
    for (let m = 300; m <= 1380; m++) {
      const due = dueStopsBySchedule({ stops: meta.stops, departTime: dv.departTime || meta.departTime, nowMin: m, leadMin: LEAD, notified });
      for (const t of due) {
        const n = tokenCount[`${dv.routeId}__${t.stopId}`] || 0;
        if (n === 0) { noTokenSkips++; continue; }   // 마커 미기록 → 다음 분에 재평가(CF 와 동일)
        notified.push(t.marker);
        cnt++; ppl += n;
      }
    }
    sendEvents += cnt; pushes += ppl;
    if (cnt > 0) perDispatch.push({ route: dv.routeName || dv.routeId, depart: dv.departTime || meta.departTime, cnt, ppl });
  }

  console.log(`배차 ${disp.size}건 (시간표 없는 노선 ${noSchedule}건 제외)`);
  console.log(`\n하루 발송 이벤트  ${sendEvents}건`);
  console.log(`실제 푸시 통수     ${pushes}통   ← 승객이 받는 알림 수`);
  console.log(`대상 0명이라 건너뜀 ${noTokenSkips}회 (분 단위 재평가 포함이라 크게 나오는 게 정상)`);
  if (perDispatch.length) {
    console.log("\n발송이 생기는 배차:");
    perDispatch.forEach((p) => console.log(`  ${p.depart}  ${p.route}  — ${p.cnt}건 / ${p.ppl}통`));
  }
  console.log("\n※ 실제로는 GPS 가 살아 있는 배차엔 폴백이 안 나가므로 이보다 적다.");
  process.exit(0);
})().catch((e) => { console.error("실패:", e); process.exit(1); });
