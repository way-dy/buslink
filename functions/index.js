const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
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
        notification: { title: title || "BusLink 공지", body: body || "" },
        data: { type: type || "normal", companyId },
        android: { priority: type === "emergency" ? "high" : "normal" },
        apns: {
          headers: { "apns-priority": type === "emergency" ? "10" : "5" },
          payload: { aps: { sound: type === "emergency" ? "default" : "" } },
        },
        webpush: {
          headers: { Urgency: type === "emergency" ? "high" : "normal" },
          notification: {
            title: title || "BusLink 공지",
            body: body || "",
            icon: "/logo192.png",
            requireInteraction: type === "emergency",
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
// 기사 등록
// ════════════════════════════════════════════════════════
exports.createDriver = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "로그인이 필요합니다");
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
  if (!request.auth) throw new HttpsError("unauthenticated", "로그인이 필요합니다");
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
  if (!request.auth) throw new HttpsError("unauthenticated", "로그인이 필요합니다");
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
exports.createDriverAuth = onCall(async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "로그인이 필요합니다");
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
