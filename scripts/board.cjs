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
//   node scripts/board.cjs comment <id> --file <경로> — 긴 안내(사용가이드 등)를 파일로.
//        (여러 줄·한글이 셸 인자로 깨지는 것 방지. 파일은 UTF-8)
//   node scripts/board.cjs dump <id> <출력폴더>    — 첨부 + **본문 인라인 이미지**를 파일로 저장
//
// ⚠ 첨부는 두 군데에 있다: `screenshots` 배열과 **본문 content 안의 인라인 `<img data:...>`**
//   (2026-07-13 리치 텍스트 도입분). 목록의 "첨부 N장" 만 보면 본문 이미지를 못 보고
//   "화면 못 고름"으로 헤맨다(2026-08-04 실제로 그럴 뻔했다) → 목록이 둘 다 센다.
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
// 본문 HTML 안에 인라인으로 박힌 이미지(data URI). screenshots 와 별개 경로다.
const inlineImages = (content) => [...String(content || "").matchAll(/<img[^>]*src="data:image\/([a-z]+);base64,([^"]+)"/g)];
const histEntry = (statusTo, comment) => {
  const e = { byUid: BYUID, byName: BYNAME, at: Timestamp.now(), comment: comment || "" };
  if (statusTo) e.statusTo = statusTo;
  return e;
};

const [, , cmd, id, ...rest] = process.argv;
const arg = rest.join(" ");

// 이 uid 가 우리(처리자) 쪽인가 — `users/{uid}.role === "superadmin"`. 조회 결과는 캐시.
const staffCache = new Map();
async function isStaff(uid) {
  if (!uid) return false;
  if (staffCache.has(uid)) return staffCache.get(uid);
  let staff = false;
  try {
    const u = await db.collection("users").doc(uid).get();
    staff = u.exists && (u.data() || {}).role === "superadmin";
  } catch (_) { /* 조회 실패는 '고객'으로 보수적 처리 — 놓치는 것보다 낫다 */ }
  staffCache.set(uid, staff);
  return staff;
}

(async () => {
  if (cmd === "list") {
    const snap = await db.collection(COL).orderBy("createdAt", "asc").get();

    // 🔴 완료 처리 뒤 고객이 남긴 코멘트 — status 가 done 이라 미처리 목록에서 사라져
    //   영영 못 본다(재현 정보·"고쳐준 게 안 된다" 신고가 그렇게 묻힌다).
    //   판정 = 우리가 마지막으로 손댄 뒤(byUid === BYUID) 다른 사람이 남긴 코멘트.
    //   최근 14일로 좁힌다 — 안 그러면 옛 "감사합니다"가 전부 딸려온다.
    const cutoff = Date.now() - 14 * 86400000;
    const followUps = [];
    for (const d of snap.docs) {
      const h = d.data().history || [];
      let lastOurs = -1;
      h.forEach((e, i) => { if (e && e.byUid === BYUID) lastOurs = i; });
      if (lastOurs < 0) continue;                       // 우리가 손댄 적 없으면 미처리 목록에 이미 있다
      const after = [];
      for (const e of h.slice(lastOurs + 1)) {
        if (!e || e.byUid === BYUID) continue;
        if (!(e.comment || "").trim()) continue;
        const ms = e.at && e.at.toMillis ? e.at.toMillis() : 0;
        if (ms < cutoff) continue;
        // ⚠ 슈퍼관리자(way)가 게시판에서 직접 남긴 안내도 '처리자' 다 — 고객 답변이 아니다.
        //   uid 하드코딩 대신 **역할로 판정**해 새 계정·새 PC 에서도 맞게 동작한다.
        //   byName 으로 판정하지 말 것(`WAY`/`시스템 관리자`/이메일로 표기가 흔들린다).
        if (await isStaff(e.byUid)) continue;
        after.push(e);
      }
      if (after.length) followUps.push({ id: d.id, title: d.data().title, status: d.data().status, items: after });
    }
    if (followUps.length) {
      console.log(`🔔 완료 처리 뒤 새 코멘트 ${followUps.length}건 — 확인 필요\n`);
      for (const f of followUps) {
        console.log(`  #${f.id}  [${f.status}]  ${f.title || "(제목 없음)"}`);
        f.items.forEach((e) => {
          const t = e.at && e.at.toDate ? e.at.toDate().toISOString().slice(0, 16).replace("T", " ") : "";
          console.log(`    · ${t} ${e.byName || "-"}: ${(e.comment || "").replace(/\n/g, " ").slice(0, 160)}`);
        });
        console.log("");
      }
    }

    const pending = snap.docs.filter((d) => !["done", "rejected"].includes(d.data().status));
    console.log(`미처리 ${pending.length}건 / 전체 ${snap.size}건`);
    for (const d of pending) {
      const x = d.data();
      const ts = x.createdAt && x.createdAt.toDate ? x.createdAt.toDate().toISOString() : "";
      console.log(`\n[${d.id}] (${x.status}) ${x.title || "(제목 없음)"}`);
      console.log(`  요청자 ${x.requesterName || "-"} · ${x.companyId || "-"} · ${ts}`);
      console.log(`  내용: ${plain(x.content).slice(0, 300)}`);
      const inline = inlineImages(x.content).length;
      console.log(`  첨부 ${(x.screenshots || []).length}장` + (inline ? ` · 본문 이미지 ${inline}장 → dump ${d.id} <폴더>` : "") + ` · 이력 ${(x.history || []).length}건`);
    }
    return;
  }

  if (cmd === "dump") {
    if (!id || !rest[0]) { console.error("usage: dump <id> <출력폴더>"); process.exit(1); }
    const outDir = rest[0];
    const s = await db.collection(COL).doc(id).get();
    if (!s.exists) { console.error(`문서 없음: ${id}`); process.exit(1); }
    const x = s.data();
    fs.mkdirSync(outDir, { recursive: true });
    console.log(`[${id}] ${x.title}`);
    console.log(`본문: ${plain(x.content).slice(0, 500)}`);
    (x.screenshots || []).forEach((sc, i) => {
      const m = /^data:image\/([a-z]+);base64,(.+)$/.exec(sc.dataUrl || "");
      if (!m) return;
      const p = path.join(outDir, `${id}_shot${i}.${m[1]}`);
      fs.writeFileSync(p, Buffer.from(m[2], "base64"));
      console.log(`  📎 ${p}`);
    });
    inlineImages(x.content).forEach((m, i) => {
      const p = path.join(outDir, `${id}_inline${i}.${m[1]}`);
      fs.writeFileSync(p, Buffer.from(m[2], "base64"));
      console.log(`  🖼 ${p}`);
    });
    return;
  }

  if (cmd === "done" || cmd === "status" || cmd === "comment") {
    if (!id) { console.error("문서 id 가 필요합니다."); process.exit(1); }
    const ref = db.collection(COL).doc(id);
    const s = await ref.get();
    if (!s.exists) { console.error(`문서 없음: ${id}`); process.exit(1); }

    if (cmd === "comment") {
      // 긴 안내는 `--file <경로>` 로 — 여러 줄·한글이 셸 인자를 거치며 깨지는 것을 피한다.
      const body = rest[0] === "--file" ? fs.readFileSync(rest[1], "utf8").trim() : arg;
      if (!body) { console.error("usage: comment <id> <내용> | comment <id> --file <경로>"); process.exit(1); }
      await ref.update({ updatedAt: serverTimestamp(), history: arrayUnion(histEntry(null, body)) });
      console.log(`💬 댓글 추가(${body.length}자): [${id}] ${s.data().title}`);
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

  console.error("usage: node scripts/board.cjs list | dump <id> <폴더> | done <id> | status <id> <상태> | comment <id> <내용>");
  process.exit(1);
})().catch((e) => { console.error(e.message); process.exit(1); });
