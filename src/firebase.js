import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { initializeAuth, indexedDBLocalPersistence, inMemoryPersistence } from "firebase/auth";

const firebaseConfig = {
  apiKey: process.env.REACT_APP_FIREBASE_API_KEY,
  authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID,
  storageBucket: process.env.REACT_APP_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.REACT_APP_FIREBASE_APP_ID,
};

export const app = initializeApp(firebaseConfig);
export const db  = getFirestore(app);

// ── Auth 지속성 라우트별 분리 (2026-07-09 웹 세션 충돌/튕김 수정) ────────────────
// 문제: 같은 origin(buslink-prod.web.app·localhost)에서 관리자/기사(이메일 로그인,
//   LOCAL 지속성=IndexedDB 공유) 탭과 승객/직원/협력사/탑승(익명 로그인) 탭을 동시에 열면,
//   익명 signInAnonymously 가 공유 IndexedDB auth 상태를 덮어써 다른 탭의 관리자 세션이
//   튕김(cross-tab clobber). 서브도메인(admin/d/p/partner.buslink.co.kr)은 origin 이 달라
//   이미 격리되나, 같은 origin 테스트/접속에선 충돌.
// 해법: 익명 앱 라우트는 auth 를 inMemoryPersistence 로 생성 → 공유 IndexedDB 를 아예
//   읽지도 쓰지도 않음 → 관리자 세션 무접촉 + 관리자 세션 상속도 안 함. 익명 앱은 원래
//   매 진입 시 signInAnonymously 재호출이라 지속성 없어도 무손실(기능 동일). 관리자/기사는
//   기존 IndexedDB LOCAL 유지(로그인 기억). App.js 라우트 판정과 동일 규칙(한 페이지 로드=한 앱).
const _path = (typeof window !== "undefined" && window.location) ? window.location.pathname : "";
const _host = (typeof window !== "undefined" && window.location) ? window.location.hostname.toLowerCase() : "";
const _HOST_APP = { "d.buslink.co.kr": "driver", "admin.buslink.co.kr": "admin", "p.buslink.co.kr": "employee", "partner.buslink.co.kr": "partner" };
const _hostApp = _HOST_APP[_host] || null;
const _pPartner  = _path.startsWith("/partner");
const _pEmployee = _path.startsWith("/p") && !_pPartner;
const _pDriver   = _path.startsWith("/driver");
const _pathSpecified = _path.startsWith("/bus") || _path.startsWith("/board") || _pPartner || _pEmployee || _pDriver;
// 익명 앱 = 승객(/bus)·탑승(/board)·협력사(/partner·partner.)·직원(/p·p.)  (App.js isXxxRoute 미러)
const _isAnonApp =
  _path.startsWith("/bus") || _path.startsWith("/board") || _pPartner || _pEmployee ||
  (!_pathSpecified && (_hostApp === "partner" || _hostApp === "employee"));

export const auth = initializeAuth(app, {
  persistence: _isAnonApp ? inMemoryPersistence : indexedDBLocalPersistence,
});

// FCM은 필요할 때 동적으로 가져옴 (비동기 race condition 방지)
export async function getMessagingInstance() {
  try {
    const { getMessaging, isSupported } = await import("firebase/messaging");
    const ok = await isSupported();
    if (!ok) return null;
    return getMessaging(app);
  } catch {
    return null;
  }
}
