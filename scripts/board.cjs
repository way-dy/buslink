// buslink 개선요청 게시판 CLI (Admin SDK) — /board 읽기 + 완료/댓글 처리.
//   buslink 는 로컬 prod 접근 수단이 없어(webhook 도 시크릿으로 우회), 게시판 읽기·상태
//   변경을 하려면 서비스 계정 키가 필요하다. 이 스크립트가 그 채널.
//
// 준비(1회): Firebase 콘솔 → buslink-prod → 프로젝트 설정 → 서비스 계정 →
//   "새 비공개 키 생성" → 다운로드 → app/buslink/key/ 폴더에 넣기(.gitignore 로 커밋 차단됨).
//
// 사용:
//   node scripts/board.cjs list                  — 미처리 요청(요청/검토/반영중) 목록 + 문서 id
//   node scripts/board.cjs done <id>             — 완료 처리(status:done + history + resultNote)
//   node scripts/board.cjs status <id> <상태>     — 상태 전이(reviewing|in_progress|rejected)
//   node scripts/board.cjs comment <id> <내용>     — 댓글(history) 추가. 사용자 용어만.
//
// ⚠ 게시판은 고객이 보는 화면이다. 완료 코멘트는 항상 "반영완료되었습니다" 로 고정하고
//   변경 상세·빌드 해시·파일명 등 시스템 용어는 절대 남기지 않는다(자유 메모 인자 없음).
//   기술 기록은 .claude/tasks.md 에, 사용법 안내는 사용자에게 대화로 전달.
//
// 안전: project_id 를 buslink-prod 로 검증. firebase-admin 은 functions/node_modules 재사용.
const fs = require("fs");
const path = require("path");
const admin = require(path.join(__dirname, "..", "functions", "node_modules", "firebase-admin"));

const COL = "improvement_requests";
const BYUID = "claude-cli";
const BYNAME = "WAY"; // 처리자 표기 = 계정 이름(2026-07-16 way — "시스템 관리자" 금지)
const DONE_NOTE = "반영완료되었습니다";
const STATUS_NOTE = { reviewing: "확인 중입니다", in_progress: "반영 중입니다", rejected: "반영이 어렵습니다", done: DONE_NOTE };
const STATUSES = Object.keys(STATUS_NOTE).concat("requested");

const kd = path.join(__dirname, "..", "key");
const kf = fs.existsSync(kd) && fs.readdirSync(kd).find((f) => f.endsWith(".json"));
if (!kf) {
  console.error("❌ app/buslink/key/*.json 서비스 계정 키가 없습니다.");
  console.error("   Firebase 콘솔 buslink-prod > 프로젝트 설정 > 서비스 계정 > 새 비공개 키 생성 → app/buslink/key/ 에 넣으세요.");
  process.exit(1);
}
const key = require(path.join(kd, kf));
if (key.project_id !== "buslink-prod") {
  console.error(`❌ project_id 불일치: ${key.project_id} (buslink-prod 기대) — 다른 프로젝트 키입니다.`);
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();
const { serverTimestamp, arrayUnion } = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;

const plain = (h) => String(h || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const histEntry = (statusTo, comment) => {
  const e = { byUid: BYUID, byName: BYNAME, at: Timestamp.now(), comment: comment || "" };
  if (statusTo) e.statusTo = statusTo;
  return e;
};

const [, , cmd, id, ...rest] = process.argv;
const arg = rest.join(" ");

(async () => {
  if (cmd === "list") {
    const snap = await db.collection(COL).orderBy("createdAt", "asc").get();
    const pending = snap.docs.filter((d) => !["done", "rejected"].includes(d.data().status));
    console.log(`미처리 ${pending.length}건 / 전체 ${snap.size}건`);
    for (const d of pending) {
      const x = d.data();
      const ts = x.createdAt && x.createdAt.toDate ? x.createdAt.toDate().toISOString() : "";
      console.log(`\n[${d.id}] (${x.status}) ${x.title || "(제목 없음)"}`);
      console.log(`  요청자 ${x.requesterName || "-"} · ${x.companyId || "-"} · ${ts}`);
      console.log(`  내용: ${plain(x.content).slice(0, 300)}`);
      console.log(`  첨부 ${(x.screenshots || []).length}장 · 이력 ${(x.history || []).length}건`);
    }
    return;
  }

  if (cmd === "done" || cmd === "status" || cmd === "comment") {
    if (!id) { console.error("문서 id 가 필요합니다."); process.exit(1); }
    const ref = db.collection(COL).doc(id);
    const s = await ref.get();
    if (!s.exists) { console.error(`문서 없음: ${id}`); process.exit(1); }

    if (cmd === "comment") {
      if (!arg) { console.error("usage: comment <id> <내용>"); process.exit(1); }
      await ref.update({ updatedAt: serverTimestamp(), history: arrayUnion(histEntry(null, arg)) });
      console.log(`💬 댓글 추가: [${id}] ${s.data().title}`);
      return;
    }

    const status = cmd === "done" ? "done" : rest[0];
    if (!STATUSES.includes(status)) { console.error(`상태값 오류: ${status} (${STATUSES.join("|")})`); process.exit(1); }
    // 코멘트는 상태별 고정 문구(사용자 용어). 자유 메모를 받지 않는다 — 시스템 용어 유출 차단.
    const note = STATUS_NOTE[status] || "";
    const upd = { status, updatedAt: serverTimestamp(), history: arrayUnion(histEntry(status, note)) };
    if (status === "done") upd.resultNote = DONE_NOTE;
    await ref.update(upd);
    console.log(`✅ [${id}] ${s.data().title} → ${status}` + (note ? ` · 코멘트: ${note}` : ""));
    return;
  }

  console.error("usage: node scripts/board.cjs list | done <id> | status <id> <상태> | comment <id> <내용>");
  process.exit(1);
})().catch((e) => { console.error(e.message); process.exit(1); });
