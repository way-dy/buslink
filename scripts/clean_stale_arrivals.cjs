// buslink — 배차에 복제된 "운행 실행 상태" 정리 스크립트 (Admin SDK).
//
// [대상 1] 잔존(다른 날짜) stopArrivals
//   dispatches/{date}/list/{id}.stopArrivals[stopId].actualAt 의 KST 날짜가
//   배차 날짜(date)와 다르면 = "다른 날 기록"(복사 배차·과거 회차 잔존) → 제거 대상.
//   ① 노선도 뷰에 "조기도착 수천분" 오표시(표시측은 이미 배포 수정됨)
//   ② recordStopArrival 멱등 가드가 그 날 실제 도착 기록을 skip 하게 만듦(운영 문제).
//
// [대상 2] 미래 날짜 배차의 preArrivalNotified (2026-07-22 추가)
//   `preArrivalNotified` 는 CF notifyPreArrival 의 도착 임박 푸시 **멱등 마커**다.
//   아직 오지 않은 날짜의 배차에 마커가 있다 = 복사로 딸려온 것(그 날 운행은 아직 없었음).
//   두면 그 배차의 도착 임박 푸시가 "이미 보냄"으로 판정돼 **조용히 발송 안 됨**.
//   → KST 오늘보다 **미래인 날짜만** 제거. 오늘·과거는 실제 발송분일 수 있어 절대 안 건드림.
//
// 근본 원인(2026-07-22 수정·배포): AdminApp `handleCopyDispatches` 가 `{...data}` 스프레드로
//   배차를 복사해 stopArrivals·preArrivalNotified 까지 복제. 명시 필드 화이트리스트로 교체됨.
//   이 스크립트는 그 전에 생성된 오염 데이터를 치우는 1회성 청소기.
//
// 사용:
//   node scripts/clean_stale_arrivals.cjs            — DRY-RUN(기본, 아무것도 안 바꿈)
//   node scripts/clean_stale_arrivals.cjs --apply     — 실제 제거(FieldValue.delete)
//
// 안전: project_id=buslink-prod 검증. 배차 날짜와 같은 날 도착기록은 절대 안 건드림.
//       preArrivalNotified 는 미래 날짜에서만 제거(오늘·과거 보존).
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
const TODAY = kstDate(Date.now()); // KST 오늘 — 이보다 큰 날짜만 preArrivalNotified 제거 대상

(async () => {
  console.log(`=== 배차 복제 실행상태 정리 ${APPLY ? "[APPLY 실제 제거]" : "[DRY-RUN 미변경]"} · KST 오늘=${TODAY} ===`);
  const dateDocs = await db.collection("companies").doc(COMPANY).collection("dispatches").listDocuments();
  let scanned = 0, staleDispatches = 0, staleKeys = 0, cleanedDispatches = 0;
  let preDispatches = 0, preMarkers = 0;

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
      // 미래 날짜 배차의 preArrivalNotified = 복사로 딸려온 푸시 멱등 마커(그 날 운행은 아직 없음).
      // 오늘·과거는 실제 발송분일 수 있으므로 제외.
      const pre = Array.isArray(d.preArrivalNotified) ? d.preArrivalNotified : [];
      const dropPre = date > TODAY && pre.length > 0;

      if (removeKeys.length === 0 && !dropPre) continue;
      const upd = {};
      const parts = [];
      if (removeKeys.length > 0) {
        staleDispatches++;
        staleKeys += removeKeys.length;
        const kept = Object.keys(sa).length - removeKeys.length;
        parts.push(`도착기록 제거 ${removeKeys.length} (${[...new Set(removeKeys.map(r => r.when))].join(",")}) · 보존 ${kept}`);
        for (const r of removeKeys) upd[`stopArrivals.${r.stopId}`] = FieldValue.delete();
      }
      if (dropPre) {
        preDispatches++;
        preMarkers += pre.length;
        parts.push(`푸시마커 제거 ${pre.length}(미래일)`);
        upd.preArrivalNotified = FieldValue.delete();
      }
      console.log(`  ${date}/${doc.id}  [${d.departTime || "--:--"}] ${d.routeName || d.routeId || ""}  ${parts.join(" · ")}`);
      if (APPLY) {
        await doc.ref.update(upd);
        cleanedDispatches++;
      }
    }
  }
  console.log(`\n스캔 배차 ${scanned}건`
    + `\n  · 잔존 도착기록: 배차 ${staleDispatches}건 / 기록 ${staleKeys}건`
    + `\n  · 미래일 푸시마커: 배차 ${preDispatches}건 / 마커 ${preMarkers}건`
    + (APPLY ? `\n  → 실제 정리한 배차 ${cleanedDispatches}건 완료` : `\n  (DRY-RUN — --apply 로 실행)`));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
