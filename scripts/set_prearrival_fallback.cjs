// 도착 임박 알림 — 시간표 폴백 켜기/끄기 (dry-run 기본).
//   node scripts/set_prearrival_fallback.cjs                      — 현재 상태 조회
//   node scripts/set_prearrival_fallback.cjs dy001 on             — dry-run(안 바뀜)
//   node scripts/set_prearrival_fallback.cjs dy001 on --apply     — 실제 켜기
//   node scripts/set_prearrival_fallback.cjs dy001 off --apply    — 끄기
//   node scripts/set_prearrival_fallback.cjs dy001 on --lead 7 --apply   — 몇 분 전에 보낼지
//
// 무엇이 바뀌나: `companies/{cid}` 의 `preArrivalScheduleFallback`(bool) ·
//   `preArrivalLeadMin`(number, 기본 5) 두 필드만. 다른 필드는 건드리지 않는다.
//
// 켜면 CF `notifyPreArrivalBySchedule` 이 매분 돌며 **GPS 가 끊긴 배차에 한해** 예정 시각
// N분 전에 승객에게 알림을 보낸다. GPS 가 살아 있으면 기존 실측 알림이 그대로 나가고
// 폴백은 물러난다. 발송량은 `simulate_prearrival_schedule.cjs` 로 미리 확인할 것.
const fs = require("fs");
const path = require("path");
const admin = require(path.join(__dirname, "..", "functions", "node_modules", "firebase-admin"));

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const li = args.indexOf("--lead");
const LEAD = li >= 0 ? Number(args[li + 1]) : null;
const positional = args.filter((a) => !a.startsWith("--") && a !== String(LEAD));
const CID = positional[0];
const MODE = positional[1];

if (LEAD !== null && (!Number.isFinite(LEAD) || LEAD < 1 || LEAD > 60)) {
  console.error("❌ --lead 는 1~60 사이 분이어야 합니다."); process.exit(1);
}
if (CID && MODE && !["on", "off"].includes(MODE)) {
  console.error("❌ 두 번째 인자는 on 또는 off"); process.exit(1);
}

const kd = path.join(__dirname, "..", "key");
const kf = fs.existsSync(kd) && fs.readdirSync(kd).find((f) => f.endsWith(".json"));
if (!kf) { console.error("❌ key/*.json 없음"); process.exit(1); }
const key = require(path.join(kd, kf));
if (key.project_id !== "buslink-prod") { console.error(`❌ project_id 불일치: ${key.project_id}`); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();

(async () => {
  if (!CID || !MODE) {
    const snap = await db.collection("companies").get();
    console.log("\n회사별 시간표 폴백 상태:");
    snap.docs.forEach((d) => {
      const v = d.data() || {};
      console.log(`  ${d.id.padEnd(10)} ${v.preArrivalScheduleFallback === true ? "🟢 켜짐" : "⚪ 꺼짐"}  lead ${v.preArrivalLeadMin ?? 5}분   ${v.name || ""}`);
    });
    console.log("\n켜기: node scripts/set_prearrival_fallback.cjs <회사ID> on --apply");
    process.exit(0);
  }

  const ref = db.collection("companies").doc(CID);
  const snap = await ref.get();
  if (!snap.exists) { console.error(`❌ 회사 없음: ${CID}`); process.exit(1); }
  const cur = snap.data() || {};
  const next = MODE === "on";
  const patch = { preArrivalScheduleFallback: next };
  if (LEAD !== null) patch.preArrivalLeadMin = LEAD;

  console.log(APPLY ? "\n⚠ 실제 변경(--apply)\n" : "\n🔍 DRY-RUN — 실제 변경은 --apply\n");
  console.log(`회사 ${CID} (${cur.name || "-"})`);
  console.log(`  시간표 폴백  ${cur.preArrivalScheduleFallback === true ? "켜짐" : "꺼짐"} → ${next ? "켜짐" : "꺼짐"}`);
  console.log(`  lead        ${cur.preArrivalLeadMin ?? 5}분 → ${patch.preArrivalLeadMin ?? cur.preArrivalLeadMin ?? 5}분`);
  if (APPLY) {
    await ref.update(patch);
    console.log("\n✅ 반영됨 — 다음 분부터 적용됩니다.");
  } else {
    console.log("\n실제 반영: 위 명령에 --apply 추가");
  }
  process.exit(0);
})().catch((e) => { console.error("실패:", e); process.exit(1); });
