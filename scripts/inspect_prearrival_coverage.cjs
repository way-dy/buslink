// 도착 임박 알림 실제 도달률 점검 (읽기 전용) — 2026-07-28.
//   node scripts/inspect_prearrival_coverage.cjs [일수(기본 14)]
//
// 왜 보는가: 도착 임박 푸시(`notifyPreArrival`)는 **오직** dispatch 의 `stopArrivals` 가
// 갱신될 때만 발화한다. stopArrivals 는 GPS 도착 감지의 산물이므로,
//   기사 폰 GPS 끊김 → 도착 감지 없음 → stopArrivals 없음 → 알림 없음
// 이 조용히 성립한다(에러도 로그도 안 남는다). 시간표 기반 폴백은 없다.
//
// 그래서 "배차는 있었는데 도착 기록이 하나도 없는 날/노선"이 곧 **알림이 통째로 안 나간 운행**이다.
const fs = require("fs");
const path = require("path");
const admin = require(path.join(__dirname, "..", "functions", "node_modules", "firebase-admin"));

const DAYS = Number(process.argv[2] || 14);
const kd = path.join(__dirname, "..", "key");
const kf = fs.existsSync(kd) && fs.readdirSync(kd).find((f) => f.endsWith(".json"));
if (!kf) { console.error("❌ key/*.json 없음"); process.exit(1); }
const key = require(path.join(kd, kf));
if (key.project_id !== "buslink-prod") { console.error(`❌ project_id 불일치: ${key.project_id}`); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();

function kstDay(offset) {
  const now = new Date(Date.now() - offset * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

(async () => {
  const cid = "dy001";
  console.log(`최근 ${DAYS}일 · ${cid}\n`);
  console.log("날짜        배차   도착기록有  임박알림有   알림 못 간 배차");
  let tD = 0, tA = 0, tN = 0;
  for (let i = 1; i <= DAYS; i++) {
    const day = kstDay(i);
    const list = await db.collection("companies").doc(cid).collection("dispatches").doc(day).collection("list").get();
    if (list.empty) continue;
    let withArr = 0, withNoti = 0;
    for (const d of list.docs) {
      const v = d.data();
      const arr = v.stopArrivals && Object.keys(v.stopArrivals).length > 0;
      const noti = Array.isArray(v.preArrivalNotified) && v.preArrivalNotified.length > 0;
      if (arr) withArr++;
      if (noti) withNoti++;
    }
    tD += list.size; tA += withArr; tN += withNoti;
    const miss = list.size - withNoti;
    const flag = withNoti === 0 && list.size > 0 ? "  ← 그날 전체 미발송" : "";
    console.log(`${day}  ${String(list.size).padStart(4)}  ${String(withArr).padStart(9)}  ${String(withNoti).padStart(9)}  ${String(miss).padStart(12)}${flag}`);
  }
  console.log("\n─────────────────────────────────────────────");
  console.log(`합계 배차 ${tD}건`);
  console.log(`  도착 기록이 남은 배차   ${tA}건 (${tD ? Math.round(tA / tD * 100) : 0}%)`);
  console.log(`  임박 알림이 나간 배차   ${tN}건 (${tD ? Math.round(tN / tD * 100) : 0}%)`);
  console.log(`  알림이 안 나간 배차     ${tD - tN}건 (${tD ? Math.round((tD - tN) / tD * 100) : 0}%)`);
  console.log("\n※ '내 정류장'을 지정한 승객이 없으면 알림 대상이 0명이라 마커도 안 남는다 →");
  console.log("   아래 fcmTokens 의 내 정류장 지정 수를 함께 볼 것.");
  // ── 수신자 층 분해(메모리 [[notification-missing-report-split-four-layers]]) ──
  // 전체 → companyId 일치 → 내 정류장 지정 순으로 좁혀 어디서 0 이 되는지 본다.
  // ⚠ fcmTokens 는 **회사 하위 컬렉션**(`companies/{cid}/fcmTokens`) — 최상위가 아니다.
  //   CF `sendNoticeToCompany`(24행)·`notifyPreArrival`(275행)이 쓰는 경로와 동일하게 볼 것.
  const mine = await db.collection("companies").doc(cid).collection("fcmTokens").get();
  const withStop = mine.docs.filter((d) => d.data().stopId);
  const withToken = mine.docs.filter((d) => d.data().token);
  console.log(`   fcmTokens(회사 하위) ${mine.size}개 · 실제 토큰 보유 ${withToken.length}개`);
  console.log(`     └ '내 정류장' 지정 ${withStop.length}개  ← 도착 임박 푸시 대상`);
  if (withStop.length) {
    const byRoute = {};
    withStop.forEach((d) => { const r = d.data().routeId || "(노선없음)"; byRoute[r] = (byRoute[r] || 0) + 1; });
    Object.entries(byRoute).forEach(([r, n]) => console.log(`         · ${r}: ${n}명`));
  }
  // 공지 푸시 발송 결과(fcmQueue)도 같이 — 수신자 0 이면 no_tokens 로 남는다.
  const q = await db.collection("fcmQueue").orderBy("createdAt", "desc").limit(20).get().catch(() => null);
  if (q && !q.empty) {
    const byStatus = {};
    q.docs.forEach((d) => { const s = d.data().status || "(없음)"; byStatus[s] = (byStatus[s] || 0) + 1; });
    console.log(`\n   최근 공지 발송 20건 상태: ${Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
    const last = q.docs[0].data();
    console.log(`   가장 최근: status=${last.status} 대상토큰=${last.totalTokens ?? "-"} 성공=${last.successCount ?? "-"}`);
  }
  process.exit(0);
})().catch((e) => { console.error("실패:", e); process.exit(1); });
