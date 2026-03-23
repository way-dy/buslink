// public/firebase-messaging-sw.js
// 이 파일은 public/ 폴더에 위치해야 합니다

importScripts("https://www.gstatic.com/firebasejs/11.6.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/11.6.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyDewSUkYC2O0WZZ95HLepOuCcqVlwfdsPQ",
  authDomain: "buslink-prod.firebaseapp.com",
  projectId: "buslink-prod",
  storageBucket: "buslink-prod.firebasestorage.app",
  messagingSenderId: "1040702853398",
  appId: "1:1040702853398:web:95edd18fd3647ba07c4037"
});

const messaging = firebase.messaging();

// 백그라운드 메시지 처리 (data-only 메시지 대응)
messaging.onBackgroundMessage(payload => {
  // ★ data-only: data에서 먼저 추출, fallback으로 notification
  const title = payload.data?.title || payload.notification?.title || "BusLink 공지";
  const body  = payload.data?.body  || payload.notification?.body  || "";
  const type  = payload.data?.type  || "normal";

  self.registration.showNotification(title, {
    body: body,
    icon: "/logo192.png",
    badge: "/logo192.png",
    tag: "buslink-" + Date.now(),  // ★ 고유 tag — 알림 덮어쓰기 방지
    data: payload.data,
    vibrate: type === "emergency" ? [200, 100, 200, 100, 200] : [100],
    requireInteraction: type === "emergency",
  });
});

// 알림 클릭 시 앱으로 이동
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const companyId = event.notification.data?.companyId || "dy001";
  const targetUrl = "/p?c=" + companyId;

  event.waitUntil(
    // ★ includeUncontrolled: true — 도메인 하드코딩 제거
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if ("focus" in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
