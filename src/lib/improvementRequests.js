// 개선 요청 게시판 — 순수 data-access + 상수 (2026-07-13)
//
// 최상위 컬렉션 `improvement_requests/{autoId}`. companyId 로 멀티테넌트 스코핑.
// 회사 admin = 자기 회사 요청만, superadmin = 전 회사 요청.
//
// ⚠ history 배열 요소에는 serverTimestamp() 를 넣을 수 없다(Firestore 가 배열 내부
//   sentinel 을 거부) → Timestamp.now()(클라 시각) 사용. createdAt/updatedAt 은
//   문서 최상위 필드라 serverTimestamp() 정상.

import {
  collection, addDoc, updateDoc, deleteDoc, doc,
  query, where, orderBy, serverTimestamp, arrayUnion, Timestamp,
} from "firebase/firestore";
import { db } from "../firebase";

export const IMPROVEMENT_COLLECTION = "improvement_requests";

// 상태 enum(순서 = 진행 흐름). 화이트리스트 — 신규 상태 추가 시 이 배열에만 추가.
export const IMPROVEMENT_STATUSES = ["requested", "reviewing", "in_progress", "done", "rejected"];

export const IMPROVEMENT_STATUS_LABELS = {
  requested: "요청",
  reviewing: "검토",
  in_progress: "반영중",
  done: "완료",
  rejected: "반려",
};

// tokens.css 색 매핑용 tone(배지/타임라인). ImprovementTab 이 tone→CSS 변수로 해석.
export const IMPROVEMENT_STATUS_TONE = {
  requested: "neutral",
  reviewing: "info",
  in_progress: "warning",
  done: "positive",
  rejected: "destructive",
};

/** 목록 쿼리 빌더(컴포넌트가 onSnapshot 직접 구독). createdAt 내림차순. */
export function improvementQuery({ companyId, isSuperAdmin }) {
  const col = collection(db, IMPROVEMENT_COLLECTION);
  if (isSuperAdmin) {
    // superadmin = 전 회사. 단일필드 orderBy(자동 인덱스).
    return query(col, orderBy("createdAt", "desc"));
  }
  // 회사 admin = 자기 회사만. 복합 인덱스(companyId ASC + createdAt DESC) 필요.
  return query(col, where("companyId", "==", companyId), orderBy("createdAt", "desc"));
}

/**
 * 개선 요청 신규 등록. status='requested', history 초기 1건.
 * @returns {Promise<string>} 생성된 문서 id
 */
export async function createRequest({ companyId, title, content, requesterUid, requesterName, requesterEmail, screenshots }) {
  const now = Timestamp.now();
  const ref = await addDoc(collection(db, IMPROVEMENT_COLLECTION), {
    title: (title || "").trim(),
    content: content || "",
    companyId,
    requesterUid,
    requesterName: requesterName || "",
    requesterEmail: requesterEmail || "",
    status: "requested",
    screenshots: Array.isArray(screenshots) ? screenshots : [],
    history: [{
      statusTo: "requested",
      byUid: requesterUid,
      byName: requesterName || "",
      at: now,
      comment: "요청 등록",
    }],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

/**
 * 상태 전이(superadmin). 완료(done) 시에만 resultNote 기록.
 * history 에 상태전이 항목 arrayUnion. comment 는 옵션(현재 UI 미사용).
 */
export async function updateRequestStatus({ id, status, byUid, byName, resultNote, comment }) {
  const patch = {
    status,
    updatedAt: serverTimestamp(),
    history: arrayUnion({
      statusTo: status,
      byUid,
      byName: byName || "",
      at: Timestamp.now(),
      comment: comment || "",
    }),
  };
  // resultNote 는 완료 시에만(값 있을 때).
  if (status === "done" && resultNote && resultNote.trim()) {
    patch.resultNote = resultNote.trim();
  }
  await updateDoc(doc(db, IMPROVEMENT_COLLECTION, id), patch);
}

/** 댓글 추가(누구나). history 에 코멘트 항목 arrayUnion(statusTo 없음). */
export async function addRequestComment({ id, comment, byUid, byName }) {
  await updateDoc(doc(db, IMPROVEMENT_COLLECTION, id), {
    updatedAt: serverTimestamp(),
    history: arrayUnion({
      byUid,
      byName: byName || "",
      at: Timestamp.now(),
      comment: comment || "",
    }),
  });
}

/** 요청 삭제(superadmin 또는 자기 회사 admin — rules 강제). */
export async function deleteRequest(id) {
  await deleteDoc(doc(db, IMPROVEMENT_COLLECTION, id));
}
