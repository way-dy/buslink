const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const { HOLIDAY_SET } = require("./holidays");
admin.initializeApp();

// ════════════════════════════════════════════════════════
// FCM 푸시 발송 — fcmQueue 문서 생성 시 트리거 (v2)
// ════════════════════════════════════════════════════════
exports.sendNoticeToCompany = onDocumentCreated("fcmQueue/{queueId}", async (event) => {
  const data = event.data.data();
  const { companyId, title, body, type } = data;
  console.log("[FCM] 발송 시작:", { companyId, title, type });

  try {
    const tokensSnap = await admin.firestore()
      .collection("companies").doc(companyId)
      .collection("fcmTokens").get();

    const tokens = tokensSnap.docs.map(d => d.data().token).filter(Boolean);
    console.log("[FCM] 토큰 수:", tokens.length);

    if (tokens.length === 0) {
      await event.data.ref.update({ status: "no_tokens" });
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

    console.log("[FCM] 완료 — 성공:", totalSuccess, "실패:", totalFail);
    await event.data.ref.update({
      status: "sent",
      successCount: totalSuccess,
      failureCount: totalFail,
    });
  } catch (e) {
    console.error("[FCM] 오류:", e.message);
    await event.data.ref.update({ status: "error", error: e.message });
  }
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
