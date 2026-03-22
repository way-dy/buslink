// functions/index.js 에 추가하세요
// npm install firebase-admin firebase-functions 필요

const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

// fcmQueue 문서 생성 시 FCM 발송
exports.sendNoticeToCompany = functions.firestore
  .document("fcmQueue/{queueId}")
  .onCreate(async (snap) => {
    const { companyId, title, body, type } = snap.data();

    // 해당 회사의 FCM 토큰 전부 조회
    const tokensSnap = await admin.firestore()
      .collection("companies").doc(companyId)
      .collection("fcmTokens").get();

    const tokens = tokensSnap.docs.map(d => d.data().token).filter(Boolean);
    if (tokens.length === 0) {
      return snap.ref.update({ status: "no_tokens" });
    }

    // FCM 멀티캐스트 발송
    const message = {
      tokens,
      notification: { title, body },
      data: { type, companyId },
      android: { priority: type === "emergency" ? "high" : "normal" },
      apns: {
        payload: { aps: { sound: type === "emergency" ? "default" : "" } },
        headers: { "apns-priority": type === "emergency" ? "10" : "5" },
      },
    };

    const response = await admin.messaging().sendEachForMulticast(message);
    await snap.ref.update({
      status: "sent",
      successCount: response.successCount,
      failureCount: response.failureCount,
    });
    return null;
  });
