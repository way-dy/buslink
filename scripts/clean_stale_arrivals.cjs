// buslink — 잔존(다른 날짜) stopArrivals 정리 스크립트 (Admin SDK).
//   dispatches/{date}/list/{id}.stopArrivals[stopId].actualAt 의 KST 날짜가
//   배차 날짜(date)와 다르면 = "다른 날 기록"(테스트 복제·과거 회차 잔존) → 제거 대상.
//   이런 잔존 기록은 ① 노선도 뷰에 "조기도착 수천분" 오표시(표시측은 이미 배포 수정됨)
//   ② recordStopArrival 멱등 가드가 오늘 실제 도착 기록을 skip 하게 만듦(운영 문제).
//
// 사용:
//   node scripts/clean_stale_arrivals.cjs            — DRY-RUN(기본, 아무것도 안 바꿈)
//   node scripts/clean_stale_arrivals.cjs --apply     — 실제 제거(FieldValue.delete)
//
// 안전: project_id=buslink-prod 검증. 배차 날짜와 같은 날 기록은 절대 안 건드림.
const fs = require("fs");
const path = require("path");
const admin = require(path.join(__dirname, "..", "functions", "node_modules", "firebase-admin"));

const COMPANY = "dy001";
const APPLY = process.argv.includes("--apply");

const kd = path.join(__dirname, "..", "key");
const kf = fs.existsSync(kd) && fs.readdirSync(kd).find((f) => f.endsWith(".json"));
if (!kf) { console.error("❌ app/buslink/key/*.json 서비스 계정 키가 없습니다."); process.exit(1); }
const key = require(path.join(kd, kf));
if (key.project_id !== "buslink-prod") {
  console.error(`❌ project_id 불일치: ${key.project_id} (buslink-prod 기대)`); process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();
const { FieldValue } = admin.firestore;

// millis → KST 날짜("YYYY-MM-DD")
const kstDate = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(ms));

(async () => {
  console.log(`=== 잔존 stopArrivals 정리 ${APPLY ? "[APPLY 실제 제거]" : "[DRY-RUN 미변경]"} ===`);
  const dateDocs = await db.collection("companies").doc(COMPANY).collection("dispatches").listDocuments();
  let scanned = 0, staleDispatches = 0, staleKeys = 0, cleanedDispatches = 0;

  for (const dateRef of dateDocs) {
    const date = dateRef.id;               // 배차 운행 날짜(KST)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const listSnap = await dateRef.collection("list").get();
    for (const doc of listSnap.docs) {
      scanned++;
      const d = doc.data();
      const sa = d.stopArrivals || {};
      const removeKeys = [];
      for (const stopId in sa) {
        const a = sa[stopId];
        const ms = a?.actualAt?.toMillis ? a.actualAt.toMillis()
          : (typeof a?.actualAt === "number" ? a.actualAt : null);
        if (ms == null) continue;          // 형식 불명 = 보존(건드리지 않음)
        if (kstDate(ms) !== date) removeKeys.push({ stopId, when: kstDate(ms) });
      }
      if (removeKeys.length === 0) continue;
      staleDispatches++;
      staleKeys += removeKeys.length;
      const kept = Object.keys(sa).length - removeKeys.length;
      console.log(`  ${date}/${doc.id}  [${d.departTime || "--:--"}] ${d.routeName || d.routeId || ""}`
        + `  제거 ${removeKeys.length} (${[...new Set(removeKeys.map(r => r.when))].join(",")}) · 보존 ${kept}`);
      if (APPLY) {
        const upd = {};
        for (const r of removeKeys) upd[`stopArrivals.${r.stopId}`] = FieldValue.delete();
        await doc.ref.update(upd);
        cleanedDispatches++;
      }
    }
  }
  console.log(`\n스캔 배차 ${scanned}건 · 잔존 있는 배차 ${staleDispatches}건 · 제거 대상 도착기록 ${staleKeys}건`
    + (APPLY ? ` · 실제 정리 ${cleanedDispatches}건 완료` : ` · (DRY-RUN — --apply 로 실행)`));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
