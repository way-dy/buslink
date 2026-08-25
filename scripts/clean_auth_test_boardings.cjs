// 2026-08-25 본인확인 하네스가 만든 가짜 탑승 기록 정리(1회성).
//
//   node scripts/clean_auth_test_boardings.cjs            (dry-run — 지우지 않음)
//   node scripts/clean_auth_test_boardings.cjs --apply    (실제 삭제)
//
// 배경: `test_board_static_auth.cjs` 를 **배포 전** 대조군으로 돌렸는데, 그 시점 prod 는
//   본인 확인이 없어 세 호출이 전부 **성공**했다 — 즉 거부를 재려던 호출이 탑승을 적재했다.
//   ① 명부에 없는 사번 ② 실재 사번(본인은 찍은 적 없음) 두 건. 멱등 id 라 3번째는 중복.
// 🔴 지우기 전에 **내가 만든 것이 맞는지** 문서 내용으로 확인한다 — via/생성시각/차량.
//    실제 승객이 오늘 그 차를 정말 탔다면 그 기록은 건드리면 안 된다.
const path = require("path");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const APPLY = process.argv.includes("--apply");

const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
const sa = require(path.join(ROOT, "key", kf));
if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치");
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const COMPANY = "dy001";
const DATE = "2026-08-25";
const VEHICLE = "XlRFfJZi0oDqJ2LQmXix";           // 하네스가 집은 오늘 배차 차량(경기73사2626)
const FAKE_EMP = "9999zz-not-a-real-emp";          // ① 명부에 없는 사번(하네스 리터럴)

(async () => {
  const listRef = db.collection("companies").doc(COMPANY)
    .collection("boardings").doc(DATE).collection("list");

  // 하네스가 건드린 차량의 오늘 탑승 전수 — 그 안에서만 고른다.
  const snap = await listRef.where("vehicleId", "==", VEHICLE).get();
  console.log(`\n${DATE} · 차량 ${VEHICLE} 탑승 기록 ${snap.size}건`);

  // 하네스 실행 시각(대략) 이후 생성 + 고정 QR 경로인 것만 후보.
  const cutoff = new Date(`${DATE}T13:40:00+09:00`).getTime();
  const targets = [];
  snap.forEach((d) => {
    const b = d.data() || {};
    const atMs = b.boardedAt?.toMillis ? b.boardedAt.toMillis()
      : (b.createdAt?.toMillis ? b.createdAt.toMillis() : null);
    const line = `    ${d.id.padEnd(46)} emp=${String(b.empNo).padEnd(22)} via=${b.via || "-"} at=${atMs ? new Date(atMs).toISOString() : "?"}`;
    const isFake = b.empNo === FAKE_EMP;
    const isRecent = atMs != null && atMs >= cutoff && b.via === "static";
    if (isFake || isRecent) { targets.push({ ref: d.ref, id: d.id, line }); console.log("  [대상]" + line); }
    else console.log("  [보존]" + line);
  });

  console.log(`\n삭제 대상 ${targets.length}건${APPLY ? "" : " (dry-run — --apply 로 실행)"}`);
  if (!APPLY || targets.length === 0) process.exit(0);
  for (const t of targets) { await t.ref.delete(); console.log(`  삭제 ${t.id}`); }
  console.log("완료");
  process.exit(0);
})();
