// public/firebase-messaging-sw.js
// 이 파일은 public/ 폴더에 위치해야 합니다

importScripts("https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js");

// ⚠️ 아래 값을 실제 Firebase 설정으로 교체하세요
firebase.initializeApp({
  apiKey: "AIzaSyDewSUkYC2O0WZZ95HLepOuCcqVlwfdsPQ",
  authDomain: "buslink-prod.firebaseapp.com",
  projectId: "buslink-prod",
  storageBucket: "buslink-prod.firebasestorage.app",
  messagingSenderId: "1040702853398",
  appId: "1:1040702853398:web:95edd18fd3647ba07c4037"
});

const messaging = firebase.messaging();

// 백그라운드 메시지 처리
messaging.onBackgroundMessage(payload => {
  const { title, body } = payload.notification || {};
  const type = payload.data?.type || "normal";

  self.registration.showNotification(title || "BusLink 공지", {
    body: body || "",
    icon: "/logo192.png",
    badge: "/logo192.png",
    tag: "buslink-notice",
    data: payload.data,
    vibrate: type === "emergency" ? [200, 100, 200, 100, 200] : [100],
    requireInteraction: type === "emergency", // 긴급이면 수동으로 닫아야 함
  });
});

// 알림 클릭 시 앱으로 이동
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window" }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes("buslink-prod.web.app") && "focus" in client)
          return client.focus();
      }
      if (clients.openWindow) return clients.openWindow("/p?c=" + (event.notification.data?.companyId || "dy001"));
    })
  );
});
