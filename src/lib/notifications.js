import { db, getMessagingInstance } from "../firebase";
import { doc, getDoc, setDoc, addDoc, collection, serverTimestamp } from "firebase/firestore";
import { hasNativePlugin, nativeCall } from "./nativeApp";

const VAPID_KEY = process.env.REACT_APP_VAPID_KEY || "";

// partnerCode 인자: 호출부(EmployeeApp)에서 session.partnerCode 전달. 미제공 시 passengers/{empNo}.partnerCode 자동 조회.
// 둘 다 없으면 null → 공지 발송 시 "전체 협력사" 대상에만 포함.
export async function initNotifications({ companyId, empNo, partnerCode }) {
  // iOS 앱(Capacitor) 안 — WKWebView 엔 웹 푸시가 없다. 앱 플러그인으로 FCM 토큰을 받아
  // **같은 문서**에 저장한다(발송 CF 가 이미 apns 블록을 실어 보낸다 → 서버 무변경).
  // 🔴 브라우저·PWA 는 hasNativePlugin 이 false 라 아래 기존 경로 그대로.
  if (hasNativePlugin("FirebaseMessaging")) {
    return initNativePush({ companyId, empNo, partnerCode });
  }
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
      // partnerCode 결정: 인자 우선 → passengers/{empNo} 조회 폴백 → null
      let resolvedPartnerCode = (partnerCode !== undefined) ? (partnerCode || null) : null;
      if (resolvedPartnerCode === null && partnerCode === undefined) {
        try {
          const psnap = await getDoc(doc(db, "companies", companyId, "passengers", empNo));
          if (psnap.exists()) resolvedPartnerCode = psnap.data().partnerCode || null;
        } catch (e) {
          console.warn("[FCM] passengers partnerCode 조회 실패(무시):", e.message);
        }
      }
      await setDoc(
        doc(db, "companies", companyId, "fcmTokens", empNo),
        { token, empNo, companyId, partnerCode: resolvedPartnerCode, updatedAt: serverTimestamp() },
        { merge: true }
      );
      console.log("[FCM] Firestore 저장 완료 ✅ partnerCode:", resolvedPartnerCode);
    }
    return { granted: true, token };
  } catch (e) {
    console.error("[FCM] 토큰 발급 오류:", e.message);
    return { granted: true, token: null, error: e.message };
  }
}

// 앱 푸시 토큰 저장. 알림을 거부해도 앱은 그대로 쓴다(오류를 던지지 않는다).
let nativeTokenListenerOn = false;
// 앱이 도는 OS("ios"|"android"). 브리지가 못 알려 주면 "ios"(2026-10-07 첫 앱이 iOS 였다 — 그때 값 유지).
function nativePlatform() {
  try {
    const p = window.Capacitor && typeof window.Capacitor.getPlatform === "function" && window.Capacitor.getPlatform();
    return p === "android" ? "android" : "ios";
  } catch (_) { return "ios"; }
}

async function initNativePush({ companyId, empNo, partnerCode }) {
  const platform = nativePlatform();
  const save = async (token) => {
    if (!token) return;
    await setDoc(
      doc(db, "companies", companyId, "fcmTokens", empNo),
      { token, empNo, companyId, partnerCode: partnerCode || null, platform, updatedAt: serverTimestamp() },
      { merge: true }
    );
  };
  try {
    const perm = await nativeCall("FirebaseMessaging", "requestPermissions");
    if (!perm || perm.receive !== "granted") return { supported: true, granted: false };
    // 안드로이드(8+)는 알림 채널이 있어야 소리·진동이 서버 설정대로 난다. 서버(sendNoticeToCompany·notifyPreArrival)가
    // `android.notification.channelId: "default"` 로 보내므로 같은 이름으로 만든다(있으면 덮어쓰기 = 멱등). 실패해도 진행.
    if (platform === "android") {
      try { await nativeCall("FirebaseMessaging", "createChannel", { id: "default", name: "공지·도착 알림", importance: 5, visibility: 1, vibration: true }); }
      catch (_) { /* 채널이 없어도 알림은 기본 채널로 온다 */ }
    }
    const res = await nativeCall("FirebaseMessaging", "getToken");
    const token = res && res.token;
    await save(token);
    // 토큰이 바뀌면(앱 재설치·APNs 갱신) 같은 문서를 다시 쓴다. 로그인마다 리스너가 쌓이지 않게 1회만.
    if (!nativeTokenListenerOn) {
      const FM = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.FirebaseMessaging;
      if (FM && typeof FM.addListener === "function") {
        nativeTokenListenerOn = true;
        FM.addListener("tokenReceived", (e) => { save(e && e.token).catch(() => {}); });
      }
    }
    return { supported: true, granted: true, token };
  } catch (e) {
    console.warn("[FCM] 앱 푸시 토큰 등록 실패(무시):", e && e.message);
    return { supported: true, granted: true, token: null, error: e && e.message };
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

// partnerCode: 협력사 코드 또는 "전체"/null → 전체 회사 발송.
// 반환: { noticeId, queueId } — 호출부에서 queueId 로 fcmQueue 결과 onSnapshot 구독 가능.
export async function sendNotice({ companyId, title, body, type, partnerCode }) {
  const code = (partnerCode && partnerCode !== "전체") ? partnerCode : null;
  const noticeRef = await addDoc(
    collection(db, "companies", companyId, "notices"),
    { title: title.trim(), body: body.trim(), type, companyId, partnerCode: code, active: true, createdAt: serverTimestamp() }
  );
  const queueRef = await addDoc(collection(db, "fcmQueue"), {
    companyId, noticeId: noticeRef.id,
    title: title.trim(), body: body.trim(), type,
    partnerCode: code,
    status: "pending", createdAt: serverTimestamp(),
  });
  return { noticeId: noticeRef.id, queueId: queueRef.id };
}
