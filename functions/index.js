const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const { HOLIDAY_SET } = require("./holidays");
admin.initializeApp();

// ════════════════════════════════════════════════════════
// FCM 푸시 발송 — fcmQueue 문서 생성 시 트리거 (v2)
// ════════════════════════════════════════════════════════
exports.sendNoticeToCompany = onDocumentCreated("fcmQueue/{queueId}", async (event) => {
  const data = event.data.data();
  const { companyId, title, body, type, partnerCode } = data;
  console.log("[FCM] 발송 시작:", { companyId, title, type, partnerCode: partnerCode || "(전체)" });

  try {
    // partnerCode 있으면 해당 협력사 토큰만, 없으면 전체.
    // 기존 partnerCode 필드 없는 fcmTokens 문서는 "전체"에만 포함(특정 협력사 발송 시 제외).
    let tokensQuery = admin.firestore()
      .collection("companies").doc(companyId)
      .collection("fcmTokens");
    if (partnerCode) {
      tokensQuery = tokensQuery.where("partnerCode", "==", partnerCode);
    }
    const tokensSnap = await tokensQuery.get();

    const tokens = tokensSnap.docs.map(d => d.data().token).filter(Boolean);
    console.log("[FCM] 토큰 수:", tokens.length, partnerCode ? `(협력사=${partnerCode})` : "(전체)");

    if (tokens.length === 0) {
      await event.data.ref.update({ status: "no_tokens", totalTokens: 0, successCount: 0, failureCount: 0 });
      return;
    }

    const chunkSize = 500;
    let totalSuccess = 0, totalFail = 0;

    for (let i = 0; i < tokens.length; i += chunkSize) {
      const chunk = tokens.slice(i, i + chunkSize);

      const message = {
        tokens: chunk,

        // ✅ notification 추가 — 시스템이 직접 알림 표시 (Android Chrome 백그라운드/종료 시 확실히 수신)
        notification: {
          title: title || "BusLink 공지",
          body: body || "",
        },

        // ✅ data 유지 — SW notificationclick에서 companyId, type 등 활용
        data: {
          type: type || "normal",
          companyId,
          title: title || "BusLink 공지",
          body: body || "",
        },

        // ✅ 항상 high priority — 절전모드에서도 즉시 수신
        android: {
          priority: "high",
          notification: {
            channelId: "default",
            sound: "default",
            defaultVibrateTimings: true,
            priority: "high",
          },
        },

        apns: {
          headers: {
            "apns-priority": "10",
            "apns-push-type": "alert",   // background → alert 로 변경
          },
          payload: {
            aps: {
              "content-available": 1,
              sound: "default",
              alert: {
                title: title || "BusLink 공지",
                body: body || "",
              },
            },
          },
        },

        webpush: {
          headers: { Urgency: "high" },
          // ★ 브랜드 아이콘: BusLink 직원앱 정본(public/icons/notification-employee.png — passenger-1024 사본).
          // ⚠ public/logo192.png 는 CRA 기본 React 로고이므로 사용 금지(과거 알림 아이콘이 React 로고로
          // 표시·상태바 silhouette 변환 실패로 Chrome 폴백되어 사용자가 "Chrome 아이콘"으로 인식한 결함, 2026-05-27).
          notification: {
            icon: "https://buslink-prod.web.app/icons/notification-employee.png",
            badge: "https://buslink-prod.web.app/icons/notification-employee.png",
          },
          fcmOptions: { link: "/p?c=" + companyId },
        },
      };

      const response = await admin.messaging().sendEachForMulticast(message);
      totalSuccess += response.successCount;
      totalFail += response.failureCount;

      // 만료 토큰 삭제
      const deletePromises = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const code = resp.error?.code;
          if (code === "messaging/invalid-registration-token" ||
              code === "messaging/registration-token-not-registered") {
            const badToken = chunk[idx];
            deletePromises.push(
              admin.firestore()
                .collection("companies").doc(companyId)
                .collection("fcmTokens")
                .where("token", "==", badToken).get()
                .then(s => s.docs.forEach(d => d.ref.delete()))
            );
          }
        }
      });
      await Promise.all(deletePromises);
    }

    console.log("[FCM] 완료 — 성공:", totalSuccess, "실패:", totalFail, "총", tokens.length);
    await event.data.ref.update({
      status: "sent",
      totalTokens: tokens.length,
      successCount: totalSuccess,
      failureCount: totalFail,
    });
  } catch (e) {
    console.error("[FCM] 오류:", e.message);
    await event.data.ref.update({ status: "error", error: e.message });
  }
});

// ════════════════════════════════════════════════════════
// 도착 임박 푸시 — dispatches 의 stopArrivals 갱신 시 트리거 (v2)
// 기사앱이 정류장 도착을 감지하면 stopArrivals.{stopId} 가 추가됨.
// 그 신호로 "내 정류장 2/1 정거장 전" 직원에게 FCM 발송.
//
// v1 단순화(후속 과제): routeId+stopId 로만 타겟 → 같은 routeId 의 다른
// 배차(shift)에도 발송될 수 있음. shift 별 정밀 타겟은 후속 과제.
// ════════════════════════════════════════════════════════

// 발송할 푸시 메시지(공지 발송과 동일한 high-priority 구조 재사용).
function buildPreArrivalMessage(tokens, { companyId, threshold, stopName }) {
  const title = "버스 도착 알림";
  const body = threshold === "pre2"
    ? "버스가 곧 도착해요 — 2 정거장 전입니다"
    : "버스가 한 정거장 앞이에요. 정류장으로 이동하세요";
  return {
    tokens,
    notification: { title, body },
    data: {
      type: "pre_arrival",
      companyId,
      threshold,            // "pre1" | "pre2"
      stopName: stopName || "",
      title,
      body,
    },
    android: {
      priority: "high",
      notification: {
        channelId: "default",
        sound: "default",
        defaultVibrateTimings: true,
        priority: "high",
      },
    },
    apns: {
      headers: { "apns-priority": "10", "apns-push-type": "alert" },
      payload: {
        aps: {
          "content-available": 1,
          sound: "default",
          alert: { title, body },
        },
      },
    },
    webpush: {
      headers: { Urgency: "high" },
      // 알림 아이콘 정본 — sendNoticeToCompany 의 webpush 설명 참조.
      notification: {
        icon: "https://buslink-prod.web.app/icons/notification-employee.png",
        badge: "https://buslink-prod.web.app/icons/notification-employee.png",
      },
      fcmOptions: { link: "/p?c=" + companyId },
    },
  };
}

exports.notifyPreArrival = onDocumentUpdated(
  {
    document: "companies/{companyId}/dispatches/{date}/list/{dispatchId}",
    region: "us-central1",
  },
  async (event) => {
    const { companyId } = event.params;
    const before = event.data.before.data() || {};
    const after = event.data.after.data() || {};

    const routeId = after.routeId;
    if (!routeId) return;

    // ── 1. before vs after stopArrivals diff → 새로 추가된 도착 stopId ──
    const beforeArr = before.stopArrivals || {};
    const afterArr = after.stopArrivals || {};
    const newlyArrived = Object.keys(afterArr).filter(sid => !(sid in beforeArr));
    if (newlyArrived.length === 0) return;

    const db = admin.firestore();

    // ── 2. route stops 를 order 오름차순 정렬한 배열로 구성 ──
    // raw order 값 산술(K+1)은 order 가 0,1,2,… 연속 정수라는 가정에 의존 →
    // 정류장 삭제·재정렬로 결번(예 0,1,2,4,5)이 생기면 대상 정류장을 놓침.
    // src/lib/stopSchedule.js computeStopEstimates 와 동일하게
    // "order 로 정렬한 배열에서 인덱스(position)로 순회" 한다.
    const stopsSnap = await db
      .collection("companies").doc(companyId)
      .collection("routes").doc(routeId)
      .collection("stops").get();
    if (stopsSnap.empty) return;

    const nameByStopId = {};    // stopId → name (메시지용)
    const sortedStops = stopsSnap.docs
      .map(d => {
        const v = d.data();
        nameByStopId[d.id] = v.name || "";
        return { id: d.id, order: typeof v.order === "number" ? v.order : null };
      })
      .filter(s => s.order !== null)   // 기존처럼 order 가 number 인 것만
      .sort((a, b) => a.order - b.order);
    if (sortedStops.length === 0) return;

    // stopId → 정렬 배열에서의 위치(index)
    const posByStopId = {};
    sortedStops.forEach((s, idx) => { posByStopId[s.id] = idx; });

    // 도착한 모든 정류장 중 가장 큰 배열 위치 = K (버스 실제 최전방).
    // GPS 복구 백필이 한 번에 여러 정류장을 기록할 수 있어 max 로 산출.
    let K = -Infinity;
    Object.keys(afterArr).forEach(sid => {
      const pos = posByStopId[sid];
      if (typeof pos === "number" && pos > K) K = pos;
    });
    if (K === -Infinity) return;

    // ── 3. 정렬 배열에서 한 칸 뒤 = "1 정거장 전", 두 칸 뒤 = "2 정거장 전" ──
    const targets = [
      { threshold: "pre1", stopId: (sortedStops[K + 1] || {}).id },
      { threshold: "pre2", stopId: (sortedStops[K + 2] || {}).id },
    ].filter(t => t.stopId);   // 노선 끝이라 배열 범위 밖이면 skip
    if (targets.length === 0) return;

    // ── 멱등 마커: 같은 (stopId, 임계) 조합은 배차당 1회만 ──
    // diff 기반 + 마커 2중 가드 → onDocumentUpdated 재발화·백필 다중기록에도 중복 0.
    const alreadyNotified = Array.isArray(after.preArrivalNotified)
      ? after.preArrivalNotified : [];
    const pending = targets.filter(
      t => !alreadyNotified.includes(`${t.stopId}:${t.threshold}`)
    );
    if (pending.length === 0) return;

    const newMarkers = [];
    for (const t of pending) {
      // ── 4. fcmTokens 중 routeId·stopId 매칭 + token 존재 → 멀티캐스트 ──
      const tokSnap = await db
        .collection("companies").doc(companyId)
        .collection("fcmTokens")
        .where("routeId", "==", routeId)
        .where("stopId", "==", t.stopId)
        .get();
      const tokens = tokSnap.docs.map(d => d.data().token).filter(Boolean);

      // 발송 대상이 없어도 마커는 기록 — 이후 재발화 시 재평가 비용 차단(멱등).
      newMarkers.push(`${t.stopId}:${t.threshold}`);
      if (tokens.length === 0) {
        console.log(`[도착임박] ${t.threshold} stop=${t.stopId} 대상 0명 — skip`);
        continue;
      }

      const message = buildPreArrivalMessage(tokens, {
        companyId,
        threshold: t.threshold,
        stopName: nameByStopId[t.stopId],
      });
      const resp = await admin.messaging().sendEachForMulticast(message);
      console.log(`[도착임박] ${t.threshold} stop=${t.stopId} 발송 — 성공:${resp.successCount} 실패:${resp.failureCount}`);

      // 무효 토큰 자동 삭제(sendNoticeToCompany 와 동일 처리).
      const deletePromises = [];
      resp.responses.forEach((r, idx) => {
        if (!r.success) {
          const code = r.error && r.error.code;
          if (code === "messaging/invalid-registration-token" ||
              code === "messaging/registration-token-not-registered") {
            const badToken = tokens[idx];
            deletePromises.push(
              db.collection("companies").doc(companyId)
                .collection("fcmTokens")
                .where("token", "==", badToken).get()
                .then(s => s.docs.forEach(d => d.ref.delete()))
            );
          }
        }
      });
      await Promise.all(deletePromises);
    }

    // ── 5. 발송 마커를 dispatch 문서에 기록(멱등 가드 영속) ──
    if (newMarkers.length > 0) {
      await event.data.after.ref.update({
        preArrivalNotified: admin.firestore.FieldValue.arrayUnion(...newMarkers),
      });
    }
  }
);

// ════════════════════════════════════════════════════════
// (2026-06-01) 정류장 도착 기록 — onCall (DriverApp 위임 채널)
//
// 배경: 기사앱 onStopReached 콜백이 클라이언트에서 `dispatches/{date}/list/{id}` 의
// `stopArrivals.{stopId}` 를 직접 updateDoc 하던 패턴은 firestore.rules 의 driver
// 본인 검증(`get(drivers/{driverId}).data.uid == request.auth.uid` + affectedKeys
// hasOnly `[stopArrivals]`) 통과에 의존했음. 2026-06-01 사용자 진단 JSON 결과
// stopArrivals 갱신 0건·`source:"stopArrivals"` 트리거 0개 확정 — onStopReached 는
// 호출되는데(setCurrentStopIdx 갱신은 됨) updateDoc 만 silent fail. 정확한 근인은
// 추후 진단(rules 매핑·drivers.uid 누락 등) 가능성. 본질 우회 = Admin SDK 위임.
//
// 입력: { companyId, date, dispatchId, stopId, plannedAt?, delaySec?, estimated?, viaBackfill? }
// 검증:
//  1. request.auth 필수(unauthenticated).
//  2. users/{request.auth.uid} 의 companyId 일치(타 회사 dispatch 차단).
//     role admin/superadmin/driver 허용. driver 면 dispatch.driverId 가 본인
//     drivers/{driverId}.uid 와 일치하는지 추가 검증(rules 패턴 미러).
//  3. date 형식 `YYYY-MM-DD`. stopId/dispatchId/companyId non-empty.
//  4. dispatch 존재 검증. stopArrivals[stopId] 이미 있으면 alreadyExists 멱등 반환
//     (첫 도착만 기록 정책 보존 — 백필 다중 호출에도 중복 0).
// 동작:
//   Admin SDK update — dot notation 으로 `stopArrivals.{stopId}` 만 갱신.
//   { actualAt: serverTimestamp, plannedAt: plannedAt||null,
//     delaySec: typeof number ? value : null, estimated: !!viaBackfill }
// 반환: { ok:true, stopId, actualAt:"serverTimestamp" } 또는 { ok:true, alreadyExists:true }.
//
// firestore.rules 변경 없음 — Admin SDK 가 우회. 향후 클라이언트 updateDoc 경로 제거
// 후 rules 좁힘은 별도 작업(현재는 양쪽 공존 가능).
// ════════════════════════════════════════════════════════
exports.recordStopArrival = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "로그인이 필요합니다");

  const { companyId, date, dispatchId, stopId, plannedAt, delaySec, viaBackfill } = request.data || {};

  // ── 입력 검증 ──
  if (!companyId || typeof companyId !== "string") {
    throw new HttpsError("invalid-argument", "companyId가 필요합니다");
  }
  if (!date || typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new HttpsError("invalid-argument", "date 형식이 올바르지 않습니다(YYYY-MM-DD)");
  }
  if (!dispatchId || typeof dispatchId !== "string") {
    throw new HttpsError("invalid-argument", "dispatchId가 필요합니다");
  }
  if (!stopId || typeof stopId !== "string") {
    throw new HttpsError("invalid-argument", "stopId가 필요합니다");
  }

  const db = admin.firestore();

  // ── 호출자 권한 검증 ──
  // users/{uid} 조회 → companyId 일치 + role admin/superadmin/driver 허용.
  const userSnap = await db.collection("users").doc(request.auth.uid).get();
  if (!userSnap.exists) {
    throw new HttpsError("permission-denied", "사용자 정보를 찾을 수 없습니다");
  }
  const userData = userSnap.data() || {};
  const userRole = userData.role || null;
  if (userData.companyId !== companyId) {
    throw new HttpsError("permission-denied", "다른 회사의 운행 정보는 기록할 수 없습니다");
  }
  if (userRole !== "admin" && userRole !== "superadmin" && userRole !== "driver") {
    throw new HttpsError("permission-denied", "권한이 없습니다");
  }

  // ── dispatch 존재 검증 ──
  const dispatchRef = db
    .collection("companies").doc(companyId)
    .collection("dispatches").doc(date)
    .collection("list").doc(dispatchId);
  const dispatchSnap = await dispatchRef.get();
  if (!dispatchSnap.exists) {
    throw new HttpsError("not-found", "배차 정보를 찾을 수 없습니다");
  }
  const dispatchData = dispatchSnap.data() || {};

  // ── 멱등 가드: 이미 도착 기록 있으면 그대로 반환 ──
  const existingArrivals = dispatchData.stopArrivals || {};
  if (existingArrivals[stopId]) {
    return { ok: true, alreadyExists: true, stopId };
  }

  // ── driver 추가 검증(보안 강화 — rules 패턴 미러) ──
  // role==="driver" 이면 dispatch.driverId 의 drivers/{driverId}.uid 가 호출자와 일치해야.
  // admin/superadmin 은 회사 전체 권한이므로 skip.
  if (userRole === "driver") {
    if (!dispatchData.driverId) {
      throw new HttpsError("permission-denied", "배차에 기사 정보가 없습니다");
    }
    const driverSnap = await db
      .collection("companies").doc(companyId)
      .collection("drivers").doc(dispatchData.driverId).get();
    if (!driverSnap.exists) {
      throw new HttpsError("permission-denied", "기사 정보를 찾을 수 없습니다");
    }
    if ((driverSnap.data() || {}).uid !== request.auth.uid) {
      throw new HttpsError("permission-denied", "본인 배차만 기록할 수 있습니다");
    }
  }

  // ── stopArrivals.{stopId} 기록(dot notation) ──
  const payload = {
    actualAt: admin.firestore.FieldValue.serverTimestamp(),
    plannedAt: (typeof plannedAt === "string" && plannedAt) ? plannedAt : null,
    delaySec: typeof delaySec === "number" ? delaySec : null,
    estimated: !!viaBackfill,
  };
  await dispatchRef.update({ [`stopArrivals.${stopId}`]: payload });

  console.log(`[stopArrival] cid=${companyId} date=${date} disp=${dispatchId} stop=${stopId} backfill=${!!viaBackfill}`);
  return { ok: true, stopId, actualAt: "serverTimestamp" };
});

// ════════════════════════════════════════════════════════
// SaaS Phase 1.4 (2026-05-29) — 협력사 공지 발송 (onCall)
//
// 협력사 인사 담당이 자기 직원에게 직접 공지 발송.
// PartnerApp 은 익명 인증 + 업체코드 인증 흐름 → notices/fcmQueue 클라이언트 직접 create
// 룰(admin only) 불가 → 이 onCall 이 Admin SDK 로 룰 우회.
//
// 옵션 A(사용자 결정): 자기 partnerCode 직원만, 1시간 5건, title 50 / body 500.
//
// 입력: { companyId, partnerCode, title, body, type? }
// 검증:
//  1. request.auth 필수(익명도 통과).
//  2. partnerCodes/{code} exists + active==true + companyId 일치.
//  3. title 1~50자, body 1~500자(trim). type ∈ {"normal","emergency"} 또는 기본 "normal".
//  4. rate-limit: partnerCodes/{code}.recentNoticeTimestamps 배열에서
//     now - 1시간 이내 항목 ≥5면 resource-exhausted (한국어 + 남은 분).
//
// 동작:
//  a. companies/{cid}/notices create — partnerCode·sender:"partner"·senderCode:code.
//  b. fcmQueue create — partnerCode 포함. 기존 sendNoticeToCompany 트리거가
//     partnerCode 필터 multicast(인프라 재사용, CF 신규 발송 로직 없음).
//  c. partnerCodes/{code}.recentNoticeTimestamps 갱신 — 1시간 초과 항목 정리
//     + now 추가(무한 증가 방지).
//
// 반환: { ok, noticeId, queueId, remainingPerHour }.
// ════════════════════════════════════════════════════════
const PARTNER_NOTICE_LIMIT_PER_HOUR = 5;
const PARTNER_NOTICE_WINDOW_MS = 60 * 60 * 1000;
const PARTNER_NOTICE_TITLE_MAX = 50;
const PARTNER_NOTICE_BODY_MAX = 500;

exports.sendPartnerNotice = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "로그인이 필요합니다");

  const { companyId, partnerCode, title, body, type } = request.data || {};
  // ── 입력 검증 ──
  if (!companyId || typeof companyId !== "string") {
    throw new HttpsError("invalid-argument", "companyId가 필요합니다");
  }
  if (!partnerCode || typeof partnerCode !== "string") {
    throw new HttpsError("invalid-argument", "partnerCode가 필요합니다");
  }
  const t = typeof title === "string" ? title.trim() : "";
  const b = typeof body === "string" ? body.trim() : "";
  if (!t || t.length > PARTNER_NOTICE_TITLE_MAX) {
    throw new HttpsError("invalid-argument", `제목은 1~${PARTNER_NOTICE_TITLE_MAX}자입니다`);
  }
  if (!b || b.length > PARTNER_NOTICE_BODY_MAX) {
    throw new HttpsError("invalid-argument", `본문은 1~${PARTNER_NOTICE_BODY_MAX}자입니다`);
  }
  const noticeType = (type === "emergency") ? "emergency" : "normal";

  const db = admin.firestore();

  // ── partnerCodes 검증 ──
  const codeRef = db.collection("partnerCodes").doc(partnerCode);
  const codeSnap = await codeRef.get();
  if (!codeSnap.exists) {
    throw new HttpsError("not-found", "업체코드가 존재하지 않습니다");
  }
  const codeData = codeSnap.data() || {};
  if (codeData.active === false) {
    throw new HttpsError("permission-denied", "비활성 업체코드입니다");
  }
  if (codeData.companyId !== companyId) {
    throw new HttpsError("permission-denied", "업체코드와 회사가 일치하지 않습니다");
  }

  // ── rate-limit 검증(서버 시각 기준, 클라 시각 신뢰 X) ──
  const now = Date.now();
  const cutoff = now - PARTNER_NOTICE_WINDOW_MS;
  const rawRecent = Array.isArray(codeData.recentNoticeTimestamps) ? codeData.recentNoticeTimestamps : [];
  const recentInWindow = rawRecent.filter(ts => typeof ts === "number" && ts > cutoff);

  if (recentInWindow.length >= PARTNER_NOTICE_LIMIT_PER_HOUR) {
    const oldest = Math.min(...recentInWindow);
    const remainingMs = (oldest + PARTNER_NOTICE_WINDOW_MS) - now;
    const remainingMin = Math.max(1, Math.ceil(remainingMs / 60000));
    throw new HttpsError(
      "resource-exhausted",
      `시간당 ${PARTNER_NOTICE_LIMIT_PER_HOUR}건까지 발송 가능합니다. 남은 시간: ${remainingMin}분`
    );
  }

  // ── notices create ──
  const noticeRef = db.collection("companies").doc(companyId).collection("notices").doc();
  await noticeRef.set({
    title: t,
    body: b,
    type: noticeType,
    companyId,
    partnerCode,
    active: true,
    sender: "partner",
    senderCode: partnerCode,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // ── fcmQueue create — 기존 sendNoticeToCompany 트리거가 partnerCode 필터 발송 ──
  const queueRef = db.collection("fcmQueue").doc();
  await queueRef.set({
    companyId,
    noticeId: noticeRef.id,
    title: t,
    body: b,
    type: noticeType,
    partnerCode,
    status: "pending",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // ── partnerCodes.recentNoticeTimestamps 갱신(옛 항목 정리 + now 추가) ──
  const updatedRecent = [...recentInWindow, now];
  await codeRef.update({ recentNoticeTimestamps: updatedRecent });

  const remainingPerHour = PARTNER_NOTICE_LIMIT_PER_HOUR - updatedRecent.length;
  console.log(`[협력사공지] code=${partnerCode} cid=${companyId} title="${t}" remaining=${remainingPerHour}`);

  return {
    ok: true,
    noticeId: noticeRef.id,
    queueId: queueRef.id,
    remainingPerHour,
  };
});

// ════════════════════════════════════════════════════════
// 호출자 권한 검증 — users/{uid}.role 이 admin/superadmin 인지 확인
// (같은 프로젝트의 익명 인증(승객·직원)은 토큰만 보유 → role 없음 → 차단)
// ════════════════════════════════════════════════════════
async function assertAdmin(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "로그인이 필요합니다");
  const userSnap = await admin.firestore()
    .collection("users").doc(request.auth.uid).get();
  const role = userSnap.exists ? userSnap.data().role : null;
  if (role !== "admin" && role !== "superadmin") {
    throw new HttpsError("permission-denied", "관리자 권한이 필요합니다");
  }
}

// SaaS Phase 1.2 (2026-05-28) — 슈퍼관리자 전용 검증.
// 회사 생성/목록/활성 토글은 cross-company 권한이라 admin 으론 부족.
async function assertSuperAdmin(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "로그인이 필요합니다");
  const userSnap = await admin.firestore()
    .collection("users").doc(request.auth.uid).get();
  const role = userSnap.exists ? userSnap.data().role : null;
  if (role !== "superadmin") {
    throw new HttpsError("permission-denied", "슈퍼관리자 권한이 필요합니다");
  }
}

// ════════════════════════════════════════════════════════
// SaaS Phase 1.2 (2026-05-28) — 회사 관리(슈퍼관리자 전용)
//
// createCompany: companies/{cid} + Auth 계정 + users/{newUid} 3건 동기 생성.
// 실패 시 rollback(Auth 계정 생성 후 users 생성 실패면 Auth 삭제) — createDriver 패턴 미러.
// listCompanies: companies 컬렉션 list(id/name/active/createdAt).
// toggleCompanyActive: companies/{cid}.active 토글.
// ════════════════════════════════════════════════════════

exports.createCompany = onCall(async (request) => {
  await assertSuperAdmin(request);
  const { companyId, companyName, adminEmpNo, adminEmail, adminPassword, adminName } = request.data || {};

  if (!companyId || !/^[a-z0-9]{3,20}$/.test(companyId)) {
    throw new HttpsError("invalid-argument", "companyId는 소문자·숫자 3~20자입니다");
  }
  if (!companyName || !adminEmpNo || !adminEmail || !adminPassword || !adminName) {
    throw new HttpsError("invalid-argument", "companyName/adminEmpNo/adminEmail/adminPassword/adminName 모두 필요합니다");
  }
  if (adminPassword.length < 6) {
    throw new HttpsError("invalid-argument", "비밀번호는 최소 6자리여야 합니다");
  }

  const db = admin.firestore();
  const companyRef = db.collection("companies").doc(companyId);
  const existing = await companyRef.get();
  if (existing.exists) {
    throw new HttpsError("already-exists", `회사 ${companyId}가 이미 존재합니다`);
  }

  // 1) companies/{cid} 도큐먼트 생성
  await companyRef.set({
    name: companyName,
    active: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // 2) Auth 계정 생성
  let userRecord;
  try {
    userRecord = await admin.auth().createUser({
      email: adminEmail,
      password: adminPassword,
      displayName: adminName,
    });
  } catch (e) {
    // rollback: 회사 도큐먼트 삭제
    await companyRef.delete().catch(() => {});
    if (e.code === "auth/email-already-exists") {
      throw new HttpsError("already-exists", "이미 등록된 관리자 이메일입니다");
    }
    throw new HttpsError("internal", `Auth 계정 생성 실패: ${e.message}`);
  }

  // 3) users/{newUid} 도큐먼트 생성 — role=admin (관리자 권한). 슈퍼관리자 신설은 별도.
  try {
    await db.collection("users").doc(userRecord.uid).set({
      role: "admin",
      companyId,
      empNo: adminEmpNo,
      name: adminName,
    });
  } catch (e) {
    // rollback: Auth 계정 + companies 도큐먼트 삭제
    await admin.auth().deleteUser(userRecord.uid).catch(() => {});
    await companyRef.delete().catch(() => {});
    throw new HttpsError("internal", `users 문서 생성 실패: ${e.message}`);
  }

  console.log(`[회사생성] cid=${companyId} adminUid=${userRecord.uid} 호출자=${request.auth.uid}`);
  return { ok: true, companyId, uid: userRecord.uid };
});

exports.listCompanies = onCall(async (request) => {
  await assertSuperAdmin(request);
  const db = admin.firestore();
  const snap = await db.collection("companies").get();
  const list = snap.docs.map(d => {
    const v = d.data() || {};
    return {
      id: d.id,
      name: v.name || d.id,
      active: v.active !== false,   // 기존 도큐먼트(필드 없음) = true(호환)
      createdAt: v.createdAt && v.createdAt.toDate
        ? v.createdAt.toDate().toISOString()
        : (v.createdAt || null),
    };
  });
  // 활성 우선, 그 다음 이름순 정렬(클라 UI 안정).
  list.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return (a.name || "").localeCompare(b.name || "");
  });
  return { companies: list };
});

exports.toggleCompanyActive = onCall(async (request) => {
  await assertSuperAdmin(request);
  const { companyId, active } = request.data || {};
  if (!companyId) throw new HttpsError("invalid-argument", "companyId가 필요합니다");
  if (typeof active !== "boolean") throw new HttpsError("invalid-argument", "active(boolean)가 필요합니다");

  const db = admin.firestore();
  const ref = db.collection("companies").doc(companyId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", `회사 ${companyId}가 없습니다`);

  await ref.update({ active });
  console.log(`[회사토글] cid=${companyId} active=${active} 호출자=${request.auth.uid}`);
  return { ok: true, companyId, active };
});

// ════════════════════════════════════════════════════════
// SaaS Phase 1.2+ (2026-05-29) — 회사 운영 메뉴 4종(슈퍼관리자 전용)
//
// 사용자 결정: "둘 다 제공" — 비활성(toggleCompanyActive, 기존)과 영구 삭제(deleteCompany) 양쪽.
//
// updateCompanyInfo({companyId, name})
//   companies/{cid}.name 만 update. 자기 회사 회사명 변경은 자유.
//
// resetCompanyAdminPassword({companyId, newPassword})
//   그 회사 첫 admin uid 의 Firebase Auth 비밀번호 변경. >=6자.
//
// updateCompanyAdminInfo({companyId, displayName?, email?})
//   그 회사 첫 admin 의 Auth displayName/email + users 도큐먼트 name/email 동기 변경.
//   둘 중 최소 1개 제공 필요.
//
// deleteCompany({companyId, confirmCompanyId})
//   cascade 영구 삭제:
//     companies/{cid} 하위 전체(recursiveDelete) + gpsHistory/{cid} (recursiveDelete)
//     + 최상위 컬렉션(gps/partnerCodes/boardingTokens/passengerTokens/fcmQueue) where companyId==cid 일괄 삭제
//     + users where companyId==cid 의 Auth 계정 + users 도큐먼트 삭제.
//   한계 명시(주석): etaDiagnostics 는 companyId 인덱싱 불가능 → skip(일자별 자연 정리).
//   자기 회사 보호: 호출자 users/{uid}.companyId === companyId 면 차단(자기 lockout 방지).
//   confirmCompanyId === companyId 일치 검증(오삭제 방지).
//
// 부분 실패 시 throw — 사용자 재시도하면 멱등(이미 삭제된 건 자연 skip).
// ════════════════════════════════════════════════════════

/**
 * 그 회사의 첫 admin user 도큐먼트를 찾아 반환(uid + 데이터).
 * 없으면 not-found 한국어 throw.
 */
async function findCompanyAdmin(db, companyId) {
  const snap = await db.collection("users")
    .where("companyId", "==", companyId)
    .where("role", "==", "admin")
    .limit(1)
    .get();
  if (snap.empty) {
    throw new HttpsError("not-found", "회사 관리자 계정을 찾을 수 없습니다");
  }
  const doc = snap.docs[0];
  return { uid: doc.id, data: doc.data() || {} };
}

/**
 * Firestore query 결과를 500개 청크로 batch delete.
 * 최상위 컬렉션 where companyId==cid 삭제용(gps/partnerCodes/boardingTokens/passengerTokens/fcmQueue).
 */
async function deleteQueryInBatches(db, query, label) {
  let totalDeleted = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const snap = await query.limit(500).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    totalDeleted += snap.size;
    console.log(`[회사삭제] ${label} 청크 삭제: ${snap.size}건(누적 ${totalDeleted})`);
    if (snap.size < 500) break;
  }
  return totalDeleted;
}

exports.updateCompanyInfo = onCall(async (request) => {
  await assertSuperAdmin(request);
  const { companyId, name } = request.data || {};
  if (!companyId || typeof companyId !== "string") {
    throw new HttpsError("invalid-argument", "companyId가 필요합니다");
  }
  const n = typeof name === "string" ? name.trim() : "";
  if (!n || n.length > 50) {
    throw new HttpsError("invalid-argument", "회사 이름은 1~50자입니다");
  }
  const db = admin.firestore();
  const ref = db.collection("companies").doc(companyId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", `회사 ${companyId}가 없습니다`);

  await ref.update({ name: n });
  console.log(`[회사정보수정] cid=${companyId} name="${n}" 호출자=${request.auth.uid}`);
  return { ok: true, companyId, name: n };
});

exports.resetCompanyAdminPassword = onCall(async (request) => {
  await assertSuperAdmin(request);
  const { companyId, newPassword } = request.data || {};
  if (!companyId || typeof companyId !== "string") {
    throw new HttpsError("invalid-argument", "companyId가 필요합니다");
  }
  if (typeof newPassword !== "string" || newPassword.length < 6) {
    throw new HttpsError("invalid-argument", "비밀번호는 최소 6자리여야 합니다");
  }
  const db = admin.firestore();
  const companySnap = await db.collection("companies").doc(companyId).get();
  if (!companySnap.exists) throw new HttpsError("not-found", `회사 ${companyId}가 없습니다`);

  const adminUser = await findCompanyAdmin(db, companyId);
  try {
    await admin.auth().updateUser(adminUser.uid, { password: newPassword });
  } catch (e) {
    throw new HttpsError("internal", `비밀번호 변경 실패: ${e.message}`);
  }
  console.log(`[관리자비번초기화] cid=${companyId} uid=${adminUser.uid} 호출자=${request.auth.uid}`);
  return { ok: true, uid: adminUser.uid, email: adminUser.data.email || null };
});

exports.updateCompanyAdminInfo = onCall(async (request) => {
  await assertSuperAdmin(request);
  const { companyId, displayName, email } = request.data || {};
  if (!companyId || typeof companyId !== "string") {
    throw new HttpsError("invalid-argument", "companyId가 필요합니다");
  }
  const hasName = typeof displayName === "string" && displayName.trim().length > 0;
  const hasEmail = typeof email === "string" && email.trim().length > 0;
  if (!hasName && !hasEmail) {
    throw new HttpsError("invalid-argument", "displayName 또는 email 중 최소 1개를 제공해야 합니다");
  }
  if (hasEmail) {
    // 간단한 이메일 형식 검증.
    const e = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      throw new HttpsError("invalid-argument", "이메일 형식이 올바르지 않습니다");
    }
  }

  const db = admin.firestore();
  const companySnap = await db.collection("companies").doc(companyId).get();
  if (!companySnap.exists) throw new HttpsError("not-found", `회사 ${companyId}가 없습니다`);

  const adminUser = await findCompanyAdmin(db, companyId);

  const authPatch = {};
  const userDocPatch = {};
  if (hasName) {
    authPatch.displayName = displayName.trim();
    userDocPatch.name = displayName.trim();
  }
  if (hasEmail) {
    authPatch.email = email.trim();
    userDocPatch.email = email.trim();
  }

  try {
    await admin.auth().updateUser(adminUser.uid, authPatch);
  } catch (e) {
    if (e.code === "auth/email-already-exists") {
      throw new HttpsError("already-exists", "이미 등록된 이메일입니다");
    }
    throw new HttpsError("internal", `Auth 정보 변경 실패: ${e.message}`);
  }

  try {
    await db.collection("users").doc(adminUser.uid).update(userDocPatch);
  } catch (e) {
    // users 도큐먼트 update 실패는 비치명적 — Auth 는 이미 변경됨. 경고만.
    console.warn(`[관리자정보수정] users 도큐먼트 update 실패 uid=${adminUser.uid}: ${e.message}`);
  }

  console.log(`[관리자정보수정] cid=${companyId} uid=${adminUser.uid} 변경=${JSON.stringify(authPatch)} 호출자=${request.auth.uid}`);
  return {
    ok: true,
    uid: adminUser.uid,
    displayName: authPatch.displayName || null,
    email: authPatch.email || null,
  };
});

exports.deleteCompany = onCall(async (request) => {
  await assertSuperAdmin(request);
  const { companyId, confirmCompanyId } = request.data || {};
  if (!companyId || typeof companyId !== "string") {
    throw new HttpsError("invalid-argument", "companyId가 필요합니다");
  }
  if (companyId !== confirmCompanyId) {
    throw new HttpsError("failed-precondition", "확인 입력값이 일치하지 않습니다");
  }

  const db = admin.firestore();

  // ── 자기 회사 보호: 호출자가 슈퍼관리자라도 자기 회사 삭제는 차단 ──
  // 슈퍼관리자가 다른 회사 소속일 수도 있으므로 본인 users 도큐먼트의 companyId 와 비교.
  const callerSnap = await db.collection("users").doc(request.auth.uid).get();
  const callerCompanyId = callerSnap.exists ? (callerSnap.data() || {}).companyId : null;
  if (callerCompanyId === companyId) {
    throw new HttpsError("permission-denied", "자기 소속 회사는 삭제할 수 없습니다");
  }

  const companyRef = db.collection("companies").doc(companyId);
  const companySnap = await companyRef.get();
  if (!companySnap.exists) {
    throw new HttpsError("not-found", `회사 ${companyId}가 없습니다`);
  }

  console.log(`[회사삭제] cid=${companyId} 시작 호출자=${request.auth.uid}`);
  const deletedCount = {};

  // ── 1. 최상위 컬렉션 where companyId==cid (gps/partnerCodes/boardingTokens/passengerTokens/fcmQueue) ──
  // 각 컬렉션은 모두 companyId 필드를 가짐(backend.md 참조). 500개씩 청크 삭제.
  const topLevelTargets = ["gps", "partnerCodes", "boardingTokens", "passengerTokens", "fcmQueue"];
  for (const col of topLevelTargets) {
    try {
      const q = db.collection(col).where("companyId", "==", companyId);
      deletedCount[col] = await deleteQueryInBatches(db, q, col);
    } catch (e) {
      console.error(`[회사삭제] ${col} 삭제 오류: ${e.message}`);
      throw new HttpsError("internal", `${col} 삭제 실패: ${e.message}`);
    }
  }

  // ── 2. gpsHistory/{cid} 하위 전체(recursiveDelete) ──
  // companyId 가 path 첫 segment.
  try {
    await admin.firestore().recursiveDelete(db.doc(`gpsHistory/${companyId}`));
    deletedCount.gpsHistory = 1;
    console.log(`[회사삭제] gpsHistory/${companyId} recursive 완료`);
  } catch (e) {
    // 없으면 무시(멱등).
    console.warn(`[회사삭제] gpsHistory 삭제 경고: ${e.message}`);
    deletedCount.gpsHistory = 0;
  }

  // ── 3. companies/{cid} 하위 전체(routes/stops/dispatches/drivers/vehicles/passengers/boardings/fcmTokens/notices) + 본 문서 ──
  try {
    await admin.firestore().recursiveDelete(companyRef);
    console.log(`[회사삭제] companies/${companyId} recursive 완료`);
  } catch (e) {
    console.error(`[회사삭제] companies recursive 오류: ${e.message}`);
    throw new HttpsError("internal", `companies 삭제 실패: ${e.message}`);
  }

  // ── 4. users where companyId==cid → Auth 계정 + users 도큐먼트 삭제 ──
  let usersDeleted = 0;
  try {
    const usersSnap = await db.collection("users").where("companyId", "==", companyId).get();
    for (const uDoc of usersSnap.docs) {
      const uid = uDoc.id;
      // Auth 계정 삭제(이미 없으면 무시 — 멱등).
      await admin.auth().deleteUser(uid).catch((e) => {
        console.warn(`[회사삭제] Auth 계정 삭제 실패(무시) uid=${uid}: ${e.message}`);
      });
      await uDoc.ref.delete().catch((e) => {
        console.warn(`[회사삭제] users 도큐먼트 삭제 실패(무시) uid=${uid}: ${e.message}`);
      });
      usersDeleted++;
    }
    deletedCount.users = usersDeleted;
    console.log(`[회사삭제] users + Auth 계정 ${usersDeleted}건 삭제 완료`);
  } catch (e) {
    console.error(`[회사삭제] users 삭제 오류: ${e.message}`);
    throw new HttpsError("internal", `users 삭제 실패: ${e.message}`);
  }

  // ── 5. (한계 명시) etaDiagnostics 는 companyId 직접 매칭 불가 → skip ──
  // runId 안에 driverId 만 포함되어 companyId 인덱싱 어려움. 진단 데이터·일자별 자연 정리.
  // 후속에서 runId 에 companyId 포함하면 cascade 가능.

  console.log(`[회사삭제] cid=${companyId} 완료 deleted=${JSON.stringify(deletedCount)}`);
  return { ok: true, companyId, deletedCount };
});

// ════════════════════════════════════════════════════════
// SaaS Phase A (2026-05-29) — admin별 협력사 권한 인프라(슈퍼관리자 전용)
//
// 한 회사 안에서 여러 담당자 admin이 각자 자기 협력사만 관리하는 모델.
// users/{uid}.allowedPartnerCodes: string[] 도입
//   - ["*"] = 회사 본부(전체 협력사 접근)
//   - ["code1","code2"] = 특정 협력사 코드 한정
//   - 필드 미존재 = 기존 admin 호환(클라이언트가 ?? ["*"]로 폴백, 마이그 불필요)
//
// 4종:
//   createCompanyAdmin         — Auth + users 동시 생성(rollback 패턴, createCompany 미러)
//   updateCompanyAdminPermissions — allowedPartnerCodes 만 update(다른 필드 보호)
//   deleteCompanyAdmin         — Auth + users 삭제, 자기 삭제 차단
//   listCompanyAdmins          — 회사 단위 admin 목록(allowedPartnerCodes 미존재 시 ["*"] 정규화)
//
// rules/indexes 변경 0 — 전부 Admin SDK 우회. users write 는 이미 superadmin 만.
// Phase B(AdminApp 협력사 필터 자동 적용) 는 별도 — 이 4종은 인프라+관리 UI 한정.
// ════════════════════════════════════════════════════════

/**
 * allowedPartnerCodes 입력 검증(공통 헬퍼).
 * - 배열이어야 함, 각 요소 string(1자 이상).
 * - 빈 배열 허용(어떤 협력사도 접근 못 하는 admin — 유효 케이스).
 * - "*" 가 들어있으면 ["*"] 로 정규화(혼합 입력 방어).
 */
function normalizeAllowedPartnerCodes(input) {
  if (!Array.isArray(input)) {
    throw new HttpsError("invalid-argument", "allowedPartnerCodes는 배열이어야 합니다");
  }
  for (const c of input) {
    if (typeof c !== "string" || c.length === 0) {
      throw new HttpsError("invalid-argument", "allowedPartnerCodes의 각 요소는 비어있지 않은 문자열이어야 합니다");
    }
  }
  if (input.includes("*")) return ["*"];
  // 중복 제거(set).
  return Array.from(new Set(input));
}

exports.createCompanyAdmin = onCall(async (request) => {
  await assertSuperAdmin(request);
  const { companyId, empNo, email, name, password, allowedPartnerCodes } = request.data || {};

  // ── 입력 검증 ──
  if (!companyId || typeof companyId !== "string") {
    throw new HttpsError("invalid-argument", "companyId가 필요합니다");
  }
  if (typeof empNo !== "string" || !/^[A-Za-z0-9]{1,30}$/.test(empNo)) {
    throw new HttpsError("invalid-argument", "empNo는 1~30자 영숫자여야 합니다");
  }
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    throw new HttpsError("invalid-argument", "이메일 형식이 올바르지 않습니다");
  }
  if (typeof password !== "string" || password.length < 6) {
    throw new HttpsError("invalid-argument", "비밀번호는 최소 6자리여야 합니다");
  }
  const nameTrim = typeof name === "string" ? name.trim() : "";
  if (!nameTrim || nameTrim.length > 30) {
    throw new HttpsError("invalid-argument", "이름은 1~30자여야 합니다");
  }
  const allowed = normalizeAllowedPartnerCodes(allowedPartnerCodes);

  const db = admin.firestore();

  // ── companies/{cid} 존재 검증 ──
  const companySnap = await db.collection("companies").doc(companyId).get();
  if (!companySnap.exists) {
    throw new HttpsError("not-found", `회사 ${companyId}가 없습니다`);
  }

  const emailTrim = email.trim();

  // ── 1) Auth 계정 생성 ──
  let userRecord;
  try {
    userRecord = await admin.auth().createUser({
      email: emailTrim,
      password,
      displayName: nameTrim,
    });
  } catch (e) {
    if (e.code === "auth/email-already-exists") {
      throw new HttpsError("already-exists", "이미 등록된 이메일입니다");
    }
    throw new HttpsError("internal", `Auth 계정 생성 실패: ${e.message}`);
  }

  // ── 2) users/{newUid} 도큐먼트 생성 ──
  try {
    await db.collection("users").doc(userRecord.uid).set({
      role: "admin",
      companyId,
      empNo,
      email: emailTrim,
      name: nameTrim,
      allowedPartnerCodes: allowed,
    });
  } catch (e) {
    // rollback: Auth 계정 삭제(멱등).
    await admin.auth().deleteUser(userRecord.uid).catch(() => {});
    throw new HttpsError("internal", `users 문서 생성 실패: ${e.message}`);
  }

  console.log(`[관리자추가] cid=${companyId} uid=${userRecord.uid} empNo=${empNo} allowed=${JSON.stringify(allowed)} 호출자=${request.auth.uid}`);
  return { ok: true, uid: userRecord.uid, email: emailTrim };
});

exports.updateCompanyAdminPermissions = onCall(async (request) => {
  await assertSuperAdmin(request);
  const { uid, allowedPartnerCodes } = request.data || {};
  if (!uid || typeof uid !== "string") {
    throw new HttpsError("invalid-argument", "uid가 필요합니다");
  }
  const allowed = normalizeAllowedPartnerCodes(allowedPartnerCodes);

  const db = admin.firestore();
  const ref = db.collection("users").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "사용자를 찾을 수 없습니다");
  }
  const data = snap.data() || {};
  if (data.role !== "admin") {
    throw new HttpsError("failed-precondition", "관리자 계정만 권한 변경 가능합니다");
  }

  // allowedPartnerCodes 필드만 update — 다른 필드(role/companyId/empNo/email/name) 보호.
  await ref.update({ allowedPartnerCodes: allowed });
  console.log(`[관리자권한변경] uid=${uid} allowed=${JSON.stringify(allowed)} 호출자=${request.auth.uid}`);
  return { ok: true, uid, allowedPartnerCodes: allowed };
});

// updateCompanyAdminProfile({uid, name?, email?, password?})
//   특정 uid 의 admin 로그인 정보(이름/이메일/비밀번호) 수정.
//   - updateCompanyAdminInfo 는 companyId 기준(회사 첫 admin 타겟)이라 특정 uid 수정엔 부적합 → 본 함수는 uid 기준.
//   - role/companyId/empNo/allowedPartnerCodes 절대 미변경(권한상승 벡터 차단).
//   - 대상이 role==="admin" 아니면 거부(superadmin/driver 보호).
//   - 자기 자신(uid===request.auth.uid)도 허용(슈퍼관리자가 본인 admin 정보 수정 가능).
exports.updateCompanyAdminProfile = onCall(async (request) => {
  await assertSuperAdmin(request);
  const { uid, name, email, password } = request.data || {};
  if (!uid || typeof uid !== "string") {
    throw new HttpsError("invalid-argument", "uid가 필요합니다");
  }

  const hasName = typeof name === "string" && name.trim().length > 0;
  const hasEmail = typeof email === "string" && email.trim().length > 0;
  const hasPassword = typeof password === "string" && password.length > 0;
  if (!hasName && !hasEmail && !hasPassword) {
    throw new HttpsError("invalid-argument", "이름·이메일·비밀번호 중 최소 1개를 제공해야 합니다");
  }

  // ── 필드별 검증(제공된 것만) ──
  const nameTrim = hasName ? name.trim() : null;
  if (hasName && nameTrim.length > 30) {
    throw new HttpsError("invalid-argument", "이름은 1~30자여야 합니다");
  }
  const emailTrim = hasEmail ? email.trim() : null;
  if (hasEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTrim)) {
    throw new HttpsError("invalid-argument", "이메일 형식이 올바르지 않습니다");
  }
  if (hasPassword && password.length < 6) {
    throw new HttpsError("invalid-argument", "비밀번호는 최소 6자리여야 합니다");
  }

  const db = admin.firestore();
  const ref = db.collection("users").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "사용자를 찾을 수 없습니다");
  }
  const data = snap.data() || {};
  // role==="admin" 아니면 거부(superadmin/driver 보호·권한상승 차단).
  if (data.role !== "admin") {
    throw new HttpsError("failed-precondition", "관리자 계정만 정보 수정 가능합니다");
  }

  // ── 변경 제공된 것만 patch 구성 ──
  const authPatch = {};
  const userDocPatch = {};
  if (hasName) {
    authPatch.displayName = nameTrim;
    userDocPatch.name = nameTrim;
  }
  if (hasEmail) {
    authPatch.email = emailTrim;
    userDocPatch.email = emailTrim;
  }
  if (hasPassword) {
    authPatch.password = password;
  }

  // ── Auth 정보 변경(rules 우회) ──
  try {
    await admin.auth().updateUser(uid, authPatch);
  } catch (e) {
    if (e.code === "auth/email-already-exists") {
      throw new HttpsError("already-exists", "이미 사용 중인 이메일입니다");
    }
    throw new HttpsError("internal", `Auth 정보 변경 실패: ${e.message}`);
  }

  // ── users 도큐먼트 update(name/email 만 — role/companyId/empNo/allowedPartnerCodes 미변경) ──
  if (Object.keys(userDocPatch).length > 0) {
    try {
      await ref.update(userDocPatch);
    } catch (e) {
      // Auth 는 이미 변경됨 — 비치명적, 경고만.
      console.warn(`[관리자정보수정] users 도큐먼트 update 실패 uid=${uid}: ${e.message}`);
    }
  }

  console.log(`[관리자정보수정] uid=${uid} cid=${data.companyId || "?"} 변경=${JSON.stringify(Object.keys(authPatch))} 호출자=${request.auth.uid}`);
  return {
    ok: true,
    uid,
    name: hasName ? nameTrim : null,
    email: hasEmail ? emailTrim : null,
    passwordChanged: hasPassword,
  };
});

exports.deleteCompanyAdmin = onCall(async (request) => {
  await assertSuperAdmin(request);
  const { uid } = request.data || {};
  if (!uid || typeof uid !== "string") {
    throw new HttpsError("invalid-argument", "uid가 필요합니다");
  }
  // ── 자기 삭제 차단(이중 안전망, 클라 카드 disabled + 여기서도 거부) ──
  if (uid === request.auth.uid) {
    throw new HttpsError("permission-denied", "자기 자신은 삭제할 수 없습니다");
  }

  const db = admin.firestore();
  const ref = db.collection("users").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "사용자를 찾을 수 없습니다");
  }
  const data = snap.data() || {};
  if (data.role !== "admin") {
    throw new HttpsError("failed-precondition", "관리자 계정만 삭제 가능합니다");
  }

  // Auth 계정 삭제(이미 없으면 무시 — 멱등).
  await admin.auth().deleteUser(uid).catch((e) => {
    console.warn(`[관리자삭제] Auth 계정 삭제 실패(무시) uid=${uid}: ${e.message}`);
  });
  await ref.delete();

  console.log(`[관리자삭제] uid=${uid} cid=${data.companyId || "?"} 호출자=${request.auth.uid}`);
  return { ok: true, uid };
});

exports.listCompanyAdmins = onCall(async (request) => {
  await assertSuperAdmin(request);
  const { companyId } = request.data || {};
  if (!companyId || typeof companyId !== "string") {
    throw new HttpsError("invalid-argument", "companyId가 필요합니다");
  }

  const db = admin.firestore();
  // 회사 존재 검증(없는 회사의 admin 목록 요청은 오용).
  const companySnap = await db.collection("companies").doc(companyId).get();
  if (!companySnap.exists) {
    throw new HttpsError("not-found", `회사 ${companyId}가 없습니다`);
  }

  const snap = await db.collection("users")
    .where("companyId", "==", companyId)
    .where("role", "==", "admin")
    .get();

  const admins = snap.docs.map(d => {
    const v = d.data() || {};
    // 기존 admin 호환: allowedPartnerCodes 부재 = ["*"] (전체).
    const allowed = Array.isArray(v.allowedPartnerCodes) && v.allowedPartnerCodes.length > 0
      ? v.allowedPartnerCodes
      : ["*"];
    return {
      uid: d.id,
      empNo: v.empNo || "",
      email: v.email || "",
      name: v.name || "",
      allowedPartnerCodes: allowed,
    };
  });

  // 이름순 정렬(클라 UI 안정).
  admins.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  return { companyId, admins };
});

// ════════════════════════════════════════════════════════
// 기사 등록
// ════════════════════════════════════════════════════════
exports.createDriver = onCall(async (request) => {
  await assertAdmin(request);
  const { companyId, name, empNo, pin, vehicleId, vehicleNo, phone } = request.data;
  const email = `${empNo}@buslink.com`;
  try {
    const userRecord = await admin.auth().createUser({ email, password: pin, displayName: name });
    const driverRef = await admin.firestore()
      .collection("companies").doc(companyId).collection("drivers").add({
        name, empNo, vehicleId: vehicleId || "", vehicleNo: vehicleNo || "",
        phone: phone || "", uid: userRecord.uid, status: "대기", createdAt: new Date().toISOString(),
      });
    await admin.firestore().collection("users").doc(userRecord.uid).set({
      role: "driver", companyId, empNo, name,
    });
    return { success: true, driverId: driverRef.id, uid: userRecord.uid };
  } catch (e) {
    if (e.code === "auth/email-already-exists")
      throw new HttpsError("already-exists", "이미 등록된 사번입니다");
    throw new HttpsError("internal", e.message);
  }
});

// ════════════════════════════════════════════════════════
// 기사 삭제
// ════════════════════════════════════════════════════════
exports.deleteDriver = onCall(async (request) => {
  await assertAdmin(request);
  const { companyId, driverId, uid } = request.data;
  try {
    if (uid) await admin.auth().deleteUser(uid);
    await admin.firestore()
      .collection("companies").doc(companyId).collection("drivers").doc(driverId).delete();
    if (uid) await admin.firestore().collection("users").doc(uid).delete().catch(() => {});
    return { success: true };
  } catch (e) {
    throw new HttpsError("internal", e.message);
  }
});

// ════════════════════════════════════════════════════════
// 기사 비밀번호 변경
// ════════════════════════════════════════════════════════
exports.updateDriverPassword = onCall(async (request) => {
  await assertAdmin(request);
  const { uid, newPassword } = request.data;
  if (!uid || !newPassword) throw new HttpsError("invalid-argument", "uid와 newPassword가 필요합니다");
  if (newPassword.length < 6) throw new HttpsError("invalid-argument", "비밀번호는 최소 6자리여야 합니다");
  try {
    await admin.auth().updateUser(uid, { password: newPassword });
    return { success: true };
  } catch (e) {
    throw new HttpsError("internal", e.message);
  }
});

// ════════════════════════════════════════════════════════
// 기존 기사에 Auth 계정 생성
// ════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════
// 배차 일정 자동 펼침
// dispatchSchedules → 매일 새벽 KST 00:30 향후 7일치 dispatches 생성 (멱등 ID)
// 즉시 펼침: AdminApp 운영자가 onCall expandDispatchSchedulesNow 호출
// ════════════════════════════════════════════════════════

const LOOKAHEAD_DAYS = 7; // 오늘 + 6일 = 7일치(안전 마진)

/**
 * 'YYYY-MM-DD' string 을 KST 기준 yyyy-mm-dd / dayOfWeek(일=0~토=6) 로 반환.
 * Date 객체를 직접 만들지 않고 KST formatter 로만 처리(서버 UTC 영향 차단).
 */
function ymdKST(d) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(d);
}
function dayOfWeekKST(dateStr) {
  // dateStr 의 KST 자정으로 Date 만들기: ISO에 +09:00 부착하면 안전
  const dt = new Date(`${dateStr}T00:00:00+09:00`);
  return dt.getDay(); // 0=일 ... 6=토 (KST 자정 시각이라 ts 변환 후에도 동일)
}

/**
 * 한 schedule + day 가 펼침 대상인지 판정.
 */
function shouldExpand(schedule, day) {
  if (schedule.startDate && day < schedule.startDate) return false;
  if (schedule.endDate && day > schedule.endDate) return false;
  if (!Array.isArray(schedule.weekdays) || schedule.weekdays.length === 0) return false;
  const dow = dayOfWeekKST(day);
  if (!schedule.weekdays.includes(dow)) return false;
  if (Array.isArray(schedule.excludeDates) && schedule.excludeDates.includes(day)) return false;
  if (schedule.excludeHolidays !== false && HOLIDAY_SET.has(day)) return false;
  return true;
}

/**
 * 단일 회사 전체 schedule 펼침. 멱등 dispatchId = `${scheduleId}_${day}`.
 * exists() 시 skip(일별 수정 보존). 결과 카운트 반환.
 */
async function expandCompany(companyId) {
  const db = admin.firestore();
  const today = new Date();
  const days = [];
  for (let i = 0; i < LOOKAHEAD_DAYS; i++) {
    const d = new Date(today.getTime() + i * 86400000);
    days.push(ymdKST(d));
  }

  const schedSnap = await db
    .collection("companies").doc(companyId)
    .collection("dispatchSchedules")
    .where("active", "==", true)
    .get();

  let created = 0, skipped = 0;
  for (const sdoc of schedSnap.docs) {
    const schedule = sdoc.data();
    const scheduleId = sdoc.id;
    for (const day of days) {
      if (!shouldExpand(schedule, day)) continue;
      const dispatchId = `${scheduleId}_${day}`;
      const dispRef = db
        .collection("companies").doc(companyId)
        .collection("dispatches").doc(day)
        .collection("list").doc(dispatchId);
      const existing = await dispRef.get();
      if (existing.exists) { skipped++; continue; }
      await dispRef.set({
        driverId: schedule.driverId || "",
        driverName: schedule.driverName || "",
        routeId: schedule.routeId || "",
        routeName: schedule.routeName || "",
        vehicleNo: schedule.vehicleNo || "",
        vehicleId: schedule.vehicleId || "",
        departTime: schedule.departTime || "",
        date: day,
        scheduleId,
        source: "schedule",
        createdAt: new Date().toISOString(),
      });
      created++;
    }
  }
  return { companyId, schedules: schedSnap.size, created, skipped };
}

/**
 * 전체 회사 펼침. companies 컬렉션 순회(현재 dy001 1개지만 멀티테넌트 대비).
 */
async function expandAllCompanies() {
  const companiesSnap = await admin.firestore().collection("companies").get();
  const results = [];
  for (const c of companiesSnap.docs) {
    try {
      results.push(await expandCompany(c.id));
    } catch (e) {
      console.error(`[펼침] 회사 ${c.id} 오류:`, e.message);
      results.push({ companyId: c.id, error: e.message });
    }
  }
  return results;
}

// 매일 KST 00:30 자동 펼침
exports.expandDispatchSchedules = onSchedule(
  {
    schedule: "30 0 * * *",
    timeZone: "Asia/Seoul",
    region: "us-central1",
  },
  async () => {
    console.log("[배차펼침] 자동 트리거 시작");
    const results = await expandAllCompanies();
    console.log("[배차펼침] 완료:", JSON.stringify(results));
  }
);

// 운영자 즉시 펼침 — AdminApp "지금 펼치기" 버튼
exports.expandDispatchSchedulesNow = onCall(async (request) => {
  await assertAdmin(request);
  const { companyId } = request.data || {};
  if (!companyId) throw new HttpsError("invalid-argument", "companyId가 필요합니다");
  console.log(`[배차펼침] 즉시 트리거 회사=${companyId} 호출자=${request.auth.uid}`);
  try {
    const result = await expandCompany(companyId);
    return { success: true, ...result };
  } catch (e) {
    console.error("[배차펼침] 즉시 오류:", e.message);
    throw new HttpsError("internal", e.message);
  }
});

// ════════════════════════════════════════════════════════
// ETA 자동 진단 조회 — 슈퍼관리자 전용(2026-05-29)
//
// etaDiagnostics/{date}/runs/{runId}/points 컬렉션을 부모(개발자)가
// gcloud/ADC 없이도 회수할 수 있도록 한 임시 진단 채널.
// 슈퍼관리자가 AdminApp 회사 관리 탭의 진단 조회 카드에서 호출 →
// JSON 텍스트로 노출 → 사용자가 복사해 채팅에 붙여넣어 부모가 분석.
//
// 보안: assertSuperAdmin 강제. Admin SDK 사용으로 firestore.rules 무관.
//
// 입력: { date?: "YYYY-MM-DD" KST, runId?: string }
// 반환:
//   runId 없을 때 → { date, runIds: string[] } (선택 드롭다운용)
//   runId 있을 때 → { date, runId, count, points: [{ id, ...point }] } (tsMs asc)
// ════════════════════════════════════════════════════════
exports.fetchEtaDiagnostic = onCall(async (request) => {
  await assertSuperAdmin(request);
  const { date: dateInput, runId } = request.data || {};

  // 기본 날짜 = 오늘(KST). 입력 형식은 "YYYY-MM-DD" 만 허용.
  const date = (typeof dateInput === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateInput))
    ? dateInput
    : new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());

  const db = admin.firestore();
  const runsCol = db.collection("etaDiagnostics").doc(date).collection("runs");

  // runId 미지정 → 그 날짜의 run 도큐먼트 ID 목록만 반환.
  // 문서 자체에 필드가 없을 수 있으므로 listDocuments() 사용(빈 문서 ID도 회수).
  if (!runId) {
    const runDocs = await runsCol.listDocuments();
    const runIds = runDocs.map(d => d.id).sort();
    console.log(`[진단조회] date=${date} runs=${runIds.length} 호출자=${request.auth.uid}`);
    return { date, runIds };
  }

  // runId 지정 → points 컬렉션 전체 조회(tsMs asc).
  // V1: 페이징 없이 전체 반환. 운행 1회당 ≤300 도큐먼트(30초 throttle × 시간) 전제.
  const pointsSnap = await runsCol.doc(runId).collection("points").orderBy("tsMs", "asc").get();
  const points = pointsSnap.docs.map(d => {
    const data = d.data();
    return {
      id: d.id,
      tsMs: data.tsMs ?? null,
      source: data.source ?? null,
      vehiclePos: data.vehiclePos ?? null,
      vehicleSpeed: data.vehicleSpeed ?? null,
      busProgress: data.busProgress ?? null,
      nextStopProgress: data.nextStopProgress ?? null,
      nextIdx: typeof data.nextIdx === "number" ? data.nextIdx : -1,
      estimates: Array.isArray(data.estimates) ? data.estimates : [],
      // 2026-06-08 — 빌드 식별·도착기록 결과 진단에 필수(이전엔 누락돼 깜깜이였음).
      appVersion: data.appVersion ?? null, // 폰 빌드 확인(옛 캐시 vs 신빌드)
      stopArrivalsLog: Array.isArray(data.stopArrivalsLog) ? data.stopArrivalsLog : null, // recordStopArrival 호출 ok/error/code
      allStopProgress: Array.isArray(data.allStopProgress) ? data.allStopProgress : null, // 정류장 routePath 투영값(감지 실패 근인 판별)
    };
  });

  console.log(`[진단조회] date=${date} runId=${runId} points=${points.length} 호출자=${request.auth.uid}`);
  return { date, runId, count: points.length, points };
});

exports.createDriverAuth = onCall(async (request) => {
  await assertAdmin(request);
  const { companyId, driverId, empNo, name, pin } = request.data;
  const email = `${empNo}@buslink.com`;
  if (!driverId || !empNo || !pin) throw new HttpsError("invalid-argument", "driverId, empNo, pin이 필요합니다");
  if (pin.length < 6) throw new HttpsError("invalid-argument", "비밀번호는 최소 6자리여야 합니다");
  try {
    const userRecord = await admin.auth().createUser({ email, password: pin, displayName: name || empNo });
    await admin.firestore()
      .collection("companies").doc(companyId).collection("drivers").doc(driverId)
      .update({ uid: userRecord.uid });
    await admin.firestore().collection("users").doc(userRecord.uid).set({
      role: "driver", companyId, empNo, name: name || empNo,
    });
    return { success: true, uid: userRecord.uid };
  } catch (e) {
    if (e.code === "auth/email-already-exists") {
      try {
        const existing = await admin.auth().getUserByEmail(email);
        await admin.firestore()
          .collection("companies").doc(companyId).collection("drivers").doc(driverId)
          .update({ uid: existing.uid });
        await admin.auth().updateUser(existing.uid, { password: pin });
        return { success: true, uid: existing.uid };
      } catch (inner) {
        throw new HttpsError("internal", inner.message);
      }
    }
    throw new HttpsError("internal", e.message);
  }
});
