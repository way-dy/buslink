// 잔존 운행 신호 정리 (dry-run 기본) — 2026-07-28 개선요청 cv4XzFYLUdUfzqBEuDQw 후속.
//
//   관리자 화면(실시간 관제 → 🧹 잔존 운행 신호)의 CLI 대응물. 화면에서 한 건씩 누르는 것과
//   같은 일을 하되, 오래 묵은 잔존을 한 번에 훑을 때 쓴다.
//
// 하는 일(기사앱 "운행 종료" 와 같은 계약):
//   ① stale 한 `gps/{cid}_{vid}` 문서 삭제
//   ② 그 차량 배정 기사가 status="운행중" 이면 `status:"대기"` + `endedAt` 기록
//   ③ gps 문서는 없는데 status 만 "운행중" 인 기사도 되돌림(반대 방향 잔존)
//
// 사용:
//   node scripts/clear_stale_run_signals.cjs                  — dry-run(기본·아무것도 안 지움)
//   node scripts/clear_stale_run_signals.cjs --hours 24       — 임계 변경(기본 24시간)
//   node scripts/clear_stale_run_signals.cjs --apply          — 실제 정리
//
// ⚠ 안전장치
//   - **dry-run 이 기본**. --apply 없이는 절대 쓰지 않는다.
//   - 기본 임계 24시간 = 화면(10분)보다 훨씬 보수적. 실제 운행 중 GPS 가 65분 통째로 빈
//     사례가 있어(2026-06-26 진단) 일괄 삭제 임계는 "하루" 아래로 내리지 말 것.
//   - `source==="device"` 는 **건너뛴다** — 폴러가 1분마다 다시 쓰므로 지워도 의미가 없고,
//     운행 시간대라면 살아 있는 신호다.
//   - project_id 를 buslink-prod 로 검증.
const fs = require("fs");
const path = require("path");
const admin = require(path.join(__dirname, "..", "functions", "node_modules", "firebase-admin"));

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const hIdx = args.indexOf("--hours");
const STALE_HOURS = hIdx >= 0 ? Number(args[hIdx + 1]) : 24;
if (!Number.isFinite(STALE_HOURS) || STALE_HOURS < 1) {
  console.error("❌ --hours 는 1 이상의 숫자여야 합니다(하루 미만 일괄 삭제는 위험).");
  process.exit(1);
}

const kd = path.join(__dirname, "..", "key");
const kf = fs.existsSync(kd) && fs.readdirSync(kd).find((f) => f.endsWith(".json"));
if (!kf) { console.error("❌ app/buslink/key/*.json 서비스 계정 키가 없습니다."); process.exit(1); }
const key = require(path.join(kd, kf));
if (key.project_id !== "buslink-prod") {
  console.error(`❌ project_id 불일치: ${key.project_id} (buslink-prod 기대)`);
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();

function ms(ts) {
  if (!ts) return null;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}
function ago(v) {
  if (v == null) return "알 수 없음";
  const h = (Date.now() - v) / 3600000;
  return h < 48 ? `${h.toFixed(1)}시간 전` : `${(h / 24).toFixed(1)}일 전`;
}

(async () => {
  console.log(APPLY ? "\n⚠ 실제 정리 모드(--apply)\n" : "\n🔍 DRY-RUN — 아무것도 지우지 않습니다. 실제 정리는 --apply\n");
  console.log(`잔존 임계: ${STALE_HOURS}시간\n`);

  const cutoff = Date.now() - STALE_HOURS * 3600000;
  let delSignals = 0, resetDrivers = 0, skipped = 0;

  // ① stale gps 문서
  const gps = await db.collection("gps").get();
  for (const g of gps.docs) {
    const v = g.data();
    const t = ms(v.updatedAt);
    if (t != null && t > cutoff) continue;          // 신선 → 건너뜀
    if ((v.source || "mobile") === "device") {       // 단말 = 폴러가 다시 씀
      console.log(`  ⏭  skip(단말) ${g.id} 최종=${ago(t)}`);
      skipped++;
      continue;
    }
    const [cid, ...rest] = g.id.split("_");
    const vid = rest.join("_");
    console.log(`  🗑  신호 삭제 ${g.id}`);
    console.log(`        노선=${v.routeName || "-"} 기사=${v.driverName || "-"} 최종=${ago(t)}`);
    if (APPLY) await g.ref.delete();
    delSignals++;

    // 그 차량 배정 기사가 아직 운행중이면 같이 되돌림
    const ds = await db.collection("companies").doc(cid).collection("drivers").where("vehicleId", "==", vid).get();
    for (const d of ds.docs) {
      if (d.data().status !== "운행중") continue;
      console.log(`        ↳ 기사 ${d.data().name} 대기로 되돌림`);
      if (APPLY) await d.ref.update({ status: "대기", endedAt: new Date().toISOString() });
      resetDrivers++;
    }
  }

  // ② gps 문서 없이 status 만 운행중인 기사(반대 방향 잔존)
  const liveVeh = new Set(gps.docs.filter((g) => { const t = ms(g.data().updatedAt); return t != null && t > cutoff; })
    .map((g) => g.id.split("_").slice(1).join("_")));
  const companies = await db.collection("companies").get();
  for (const c of companies.docs) {
    const ds = await c.ref.collection("drivers").where("status", "==", "운행중").get();
    for (const d of ds.docs) {
      const v = d.data();
      if (v.vehicleId && liveVeh.has(v.vehicleId)) continue; // 실제 운행 중
      const startedMs = ms(v.startedAt);
      if (startedMs != null && startedMs > cutoff) {
        console.log(`  ⏭  skip(최근 운행 시작) ${v.name} 시작=${ago(startedMs)}`);
        skipped++;
        continue;
      }
      console.log(`  🔄 기사 상태 되돌림 ${v.name}(${c.id}) 시작=${ago(startedMs)} 차량=${v.vehicleNo || v.vehicleId || "-"}`);
      if (APPLY) await d.ref.update({ status: "대기", endedAt: new Date().toISOString() });
      resetDrivers++;
    }
  }

  console.log(`\n${APPLY ? "정리 완료" : "정리 예정"} — 신호 삭제 ${delSignals}건 · 기사 상태 되돌림 ${resetDrivers}명 · 건너뜀 ${skipped}건`);
  if (!APPLY) console.log("실제로 정리하려면: node scripts/clear_stale_run_signals.cjs --apply");
  process.exit(0);
})().catch((e) => { console.error("실패:", e); process.exit(1); });
