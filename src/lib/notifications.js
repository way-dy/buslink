import { db, getMessagingInstance } from "../firebase";
import { doc, setDoc, addDoc, collection, serverTimestamp } from "firebase/firestore";

const VAPID_KEY = process.env.REACT_APP_VAPID_KEY || "";

export async function initNotifications({ companyId, empNo }) {
  if (!("Notification" in window) || !("serviceWorker" in navigator)) {
    return { supported: false };
  }

  const permission = await Notification.requestPermission();
  console.log("[FCM] 권한 상태:", permission);
  if (permission !== "granted") return { granted: false };

  // 1. SW 먼저 등록
  let swReg = null;
  try {
    swReg = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
    await navigator.serviceWorker.ready;
    console.log("[FCM] SW 등록 완료");
  } catch (e) {
    console.warn("[FCM] SW 등록 실패:", e.message);
    return { granted: true, token: null, error: e.message };
  }

  // 2. ★ 핵심 — 기존 push subscription 해제 (VAPID 키 변경 시 충돌 방지)
  try {
    const existing = await swReg.pushManager.getSubscription();
    if (existing) {
      await existing.unsubscribe();
      console.log("[FCM] 기존 구독 해제 완료");
    }
  } catch (e) {
    console.warn("[FCM] 기존 구독 해제 실패 (무시):", e.message);
  }

  // 3. messaging 초기화
  const messaging = await getMessagingInstance();
  if (!messaging) {
    console.warn("[FCM] FCM 미지원 환경");
    return { granted: true, token: null, error: "FCM 미지원" };
  }

  // 4. 새 토큰 발급
  try {
    const { getToken } = await import("firebase/messaging");
    console.log("[FCM] VAPID_KEY:", VAPID_KEY ? VAPID_KEY.substring(0, 20) + "..." : "없음 ❌");

    const token = await getToken(messaging, {
      vapidKey: VAPID_KEY,
      serviceWorkerRegistration: swReg,
    });

    console.log("[FCM] 토큰:", token ? token.substring(0, 20) + "..." : "없음");

    if (token) {
      await setDoc(
        doc(db, "companies", companyId, "fcmTokens", empNo),
        { token, empNo, companyId, updatedAt: serverTimestamp() },
        { merge: true }
      );
      console.log("[FCM] Firestore 저장 완료 ✅");
    }
    return { granted: true, token };
  } catch (e) {
    console.error("[FCM] 토큰 발급 오류:", e.message);
    return { granted: true, token: null, error: e.message };
  }
}

export async function listenForegroundMessages(callback) {
  const messaging = await getMessagingInstance();
  if (!messaging) return () => {};
  const { onMessage } = await import("firebase/messaging");
  return onMessage(messaging, payload => {
    console.log("[FCM] 포그라운드 메시지:", payload);
    // ★ data-only 메시지 대응: data에서 먼저 추출
    callback({
      title: payload.data?.title || payload.notification?.title || "공지",
      body:  payload.data?.body  || payload.notification?.body  || "",
      type:  payload.data?.type  || "normal",
    });
  });
}

export async function sendNotice({ companyId, title, body, type }) {
  const noticeRef = await addDoc(
    collection(db, "companies", companyId, "notices"),
    { title: title.trim(), body: body.trim(), type, companyId, active: true, createdAt: serverTimestamp() }
  );
  await addDoc(collection(db, "fcmQueue"), {
    companyId, noticeId: noticeRef.id,
    title: title.trim(), body: body.trim(), type,
    status: "pending", createdAt: serverTimestamp(),
  });
  return noticeRef.id;
}
