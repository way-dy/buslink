// 개선 요청 인앱 안읽음 배지 — 클라 전용(백엔드 변경 0). (2026-07-13)
//
// localStorage `buslink_improve_seen_v1` = { [reqId]: lastSeenMs }.
// "새 답변" = history 중 byUid!==myUid 인 항목의 at 최댓값 > seen[reqId].
// 상세 모달 오픈 시 markSeen(현재 시각 저장). 순수 로컬 — Firestore write 0.

const SEEN_KEY = "buslink_improve_seen_v1";

/** localStorage 에서 seen 맵 로드(파싱 실패 시 빈 객체). */
export function loadSeenMap() {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

/** 특정 요청을 지금 본 것으로 기록하고 갱신된 맵을 반환. */
export function markSeen(reqId, seenMap) {
  const next = { ...(seenMap || loadSeenMap()), [reqId]: Date.now() };
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(next));
  } catch {
    /* 저장 실패해도 배지만 부정확할 뿐 기능 무손상 */
  }
  return next;
}

// history 항목 at(Timestamp|Date|ms) → ms.
function atMs(at) {
  if (!at) return 0;
  if (typeof at === "number") return at;
  if (typeof at.toMillis === "function") return at.toMillis();
  if (typeof at.toDate === "function") return at.toDate().getTime();
  const d = new Date(at);
  const ms = d.getTime();
  return isNaN(ms) ? 0 : ms;
}

/** 내가 아닌 사람(byUid!==myUid)의 history 항목 중 최신 at(ms). 없으면 0. */
export function latestOtherReplyMs(req, myUid) {
  const hist = Array.isArray(req?.history) ? req.history : [];
  let max = 0;
  for (const h of hist) {
    if (h && h.byUid !== myUid) {
      const ms = atMs(h.at);
      if (ms > max) max = ms;
    }
  }
  return max;
}

/** 이 요청에 내가 아직 못 본 새 답변이 있는가. */
export function isUnread(req, myUid, seenMap) {
  const seen = (seenMap || loadSeenMap())[req.id] || 0;
  return latestOtherReplyMs(req, myUid) > seen;
}

/** 목록 전체에서 안읽음 개수(탭 라벨 배지용). */
export function countUnread(list, myUid, seenMap) {
  const map = seenMap || loadSeenMap();
  let n = 0;
  for (const req of list || []) {
    if (isUnread(req, myUid, map)) n++;
  }
  return n;
}
