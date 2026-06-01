// src/lib/etaDiag.js — ETA 자동 진단 로깅 (2026-05-29 신설, ≤80줄)
// ---------------------------------------------------------------------------
// 운행 중 폰 조작 0으로 ETA 진단 데이터를 Firestore 에 자동 누적. 부모(개발자)는
// Firebase Console 로 회수해 정밀 진단. 30초 throttle + stopArrivals 갱신 시 즉시.
//
// 저장처: etaDiagnostics/{YYYY-MM-DD}/runs/{runId}/points/{pointId}
//   runId = `${driverId}_${vehicleId}_${운행시작ms}` — 운행 1회 단위.
//   일자별 분리로 회수 편리(부모가 콘솔에서 날짜 한정 조회).
//
// 권한(firestore.rules): create=isAuth() (기사 본인 익명/실명 모두 허용),
//   read=admin/superadmin, update/delete=false (불변 로그).
//
// 실패는 console.warn 만 — 운행 흐름 영향 0(진단 로깅이 운행을 막으면 안 됨).
// ---------------------------------------------------------------------------

import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase";

// 운행 1회 식별자.
export function buildRunId({ driverId, vehicleId, startedAtMs }) {
  return `${driverId || "unknown"}_${vehicleId || "unknown"}_${startedAtMs || Date.now()}`;
}

// estimates 배열을 표시 필수 6필드만으로 간소화(Firestore 페이로드/비용 축소).
function slimEstimate(e) {
  if (!e) return null;
  return {
    stopId: e.stopId || null,
    status: e.status || null,
    source: e.source || null,
    plannedAt: e.plannedAt || null,
    estimatedAt: e.estimatedAt || null,
    delaySec: typeof e.delaySec === "number" ? e.delaySec : null,
  };
}

// 진단 1포인트 기록(async, 실패 무해).
//   companyId/runId 필수. 나머지는 null 허용 — 부재 시 그대로 저장(진단 단서로 활용).
//   2026-06-01 — stopArrivalsLog 옵셔널 추가: CF recordStopArrival 호출 결과 누적
//   (각 entry = {stopId, ok, alreadyExists?, error?, code?, viaBackfill, ts}).
//   미제공 시 저장 안 함(undefined 필드 회피).
export async function recordEtaDiagnostic({
  companyId, runId,
  vehiclePos = null, vehicleSpeed = null,
  busProgress = null, nextStopProgress = null,
  estimates = [], nextIdx = -1,
  T_NOW = Date.now(),
  source = "auto", // 트리거 출처: 'interval' | 'stopArrivals' | 'auto'
  stopArrivalsLog = null, // 2026-06-01 — Array | null
  appVersion = null, // 2026-06-02 — 빌드 식별자(옛 캐시 번들 vs 코드결함 구분)
}) {
  if (!companyId || !runId) return;
  try {
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(T_NOW));
    const payload = {
      ts: serverTimestamp(),
      tsMs: T_NOW,
      vehiclePos, // { lat, lng } | null
      vehicleSpeed, // m/s | null
      busProgress, // routePath 누적 진척률(m) | null
      nextStopProgress, // next 정류장 stopProgress(m) | null
      nextIdx,
      estimates: Array.isArray(estimates) ? estimates.map(slimEstimate) : [],
      source,
    };
    if (appVersion) payload.appVersion = appVersion;
    // 옵셔널 — 미제공 시 undefined 필드 회피(Firestore 가 undefined 거부).
    if (Array.isArray(stopArrivalsLog) && stopArrivalsLog.length > 0) {
      payload.stopArrivalsLog = stopArrivalsLog;
    }
    await addDoc(
      collection(db, "etaDiagnostics", date, "runs", runId, "points"),
      payload
    );
  } catch (e) {
    console.warn("[BusLink] etaDiagnostic 기록 실패:", e?.message || e);
  }
}

// 모듈 상태 throttle — 30초 미달 시 skip. 외부 호출자는 stopArrivals 트리거 시
// `force:true` 로 우회 가능. runId 키별 분리(다중 운행 동시 가정 0이지만 안전).
const lastByRun = new Map();
export function throttleGate({ runId, intervalMs = 30_000, force = false }) {
  if (!runId) return false;
  const now = Date.now();
  const last = lastByRun.get(runId) || 0;
  if (!force && now - last < intervalMs) return false;
  lastByRun.set(runId, now);
  return true;
}
