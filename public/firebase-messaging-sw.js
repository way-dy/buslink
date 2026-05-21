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

// ── 설치형 앱(PWA) 조건 충족용 no-op fetch 리스너 ──
// respondWith 없음 = 모든 요청을 네트워크로 그대로 통과시킴(캐시/오프라인/precache 일절 없음).
// 브라우저가 SW에 fetch 핸들러가 있어야 "설치 가능"으로 판정하므로 비어 있는 핸들러만 등록.
// ⚠ 여기에 캐시·respondWith·workbox 추가 금지 — stale shell 로 인한 prod 장애 방지.
self.addEventListener("fetch", () => {});

// 백그라운드 메시지 처리 (data-only 메시지 대응)
messaging.onBackgroundMessage(payload => {
  // ★ notification payload가 있으면 Firebase SDK 자동 알림에 위임 — 중복(이중 토스트) 방지
  // CF가 notification+data 둘 다 보내므로 이 가드 없으면 모바일에서 SDK 자동 + SW showNotification = 2회 표시 가능.
  // callcenter sw.js L23 검증 패턴 (callcenter-3ea4c prod 검증 완료).
  if (payload.notification) return;
  // 아래는 data-only 메시지(notification 페이로드 부재)일 때만 동작.
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
