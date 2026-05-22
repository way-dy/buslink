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
          // ★ 브랜드 아이콘 (Chrome 탭/PWA standalone 둘 다 적용): 알림 본문 옆 컬러 로고 + 상태바 배지.
          // 작은 OS 분류 아이콘은 Chrome 탭=Chrome / PWA standalone=BusLink (OS 정책). icon=본문 옆 표시용.
          notification: {
            icon: "https://buslink-prod.web.app/logo192.png",
            badge: "https://buslink-prod.web.app/logo192.png",
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
      notification: {
        icon: "https://buslink-prod.web.app/logo192.png",
        badge: "https://buslink-prod.web.app/logo192.png",
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
