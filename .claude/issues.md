# Issues & 주의할 패턴

> 새 발견사항은 이 파일에만 추가. 형식: `[미해결]` / `[해결]` / `[패턴]`.

## 미해결 / 함정
- `[미해결]` **firestore.rules 이중화**: 배포 정본은 루트 `firestore.rules`(`firebase.json` 지목, fcmTokens/notices/fcmQueue 포함). `src/firestore.rules`는 오래된 사본 — 수정해도 효과 없음. 규칙 변경은 반드시 루트 파일에.
- `[해결]` 런타임 불일치: `firebase.json` `nodejs22` → `nodejs20`으로 정렬(`package.json` `engines.node:"20"`·실배포 런타임 기준 보수적 정렬, 2026-05-16). functions 코드는 표준 v2 API만 사용해 node20에서 문제 없음.
- `[미해결]` `public/firebase-messaging-sw.js` Firebase 설정이 **하드코딩**(env 아님). 프로젝트 변경 시 수동 동기화 필요. `notificationclick`에 `buslink-prod.web.app`·fallback `dy001` 하드코딩.
- `[미해결]` `companyId` 기본값 `dy001`이 App.js·DriverApp·PassengerApp·EmployeeApp·SW에 하드코딩. 신규 회사 추가 시 전부 추적.
- `[미해결]` `.env.example` 없음 — `REACT_APP_*` 값은 사용자에게 확인 필요.
- `[해결]` **partnerCodes 복합 인덱스 누락**: `firestore.indexes.json`에 `partnerCodes (companyId ASC + active ASC)` 추가(2026-05-16). 배포 필요: `firebase deploy --only firestore:indexes`(미배포 시 노선 관리 거래처 드롭다운 onSnapshot 실패 → 노선 신규 등록 차단 위험 유지).
- `[해결]` **기사 관리 onCall 4종 admin 역할 미검증**: `functions/index.js`에 `assertAdmin(request)` 헬퍼 추가 — `users/{request.auth.uid}.role∈{admin,superadmin}` 아니면 `HttpsError('permission-denied')`. `createDriver/deleteDriver/updateDriverPassword/createDriverAuth` 진입부 `if(!request.auth)` 대체(2026-05-16). 익명 인증(승객·직원) 토큰만으로는 차단됨. 배포 필요: `firebase deploy --only functions`.
- `[보류]` **firestore.rules `passengers` write 개방**: 현재 `allow write: if isAuth()`. PartnerApp은 App.js(L48-49)에서 `onAuthStateChanged` 구독을 건너뛰고 `signInAnonymously`도 호출 안 함 → **인증 컨텍스트 전무**(`request.auth==null`). 즉 `isAuth()`/`isAdmin()` 기반 어떤 좁히기도 PartnerApp 직원 등록·PIN초기화(`importEmployees`/`handleResetPin`)를 100% 차단. 안전한 제약엔 PartnerApp 익명 로그인화(프론트) + 규칙 재설계가 동반돼야 해 최소변경·운영보존 범위 초과 → 보류. ※ 현 규칙대로면 PartnerApp write가 거부돼야 하는데 운영 정본이라는 점에서 **배포된 실제 규칙이 저장소 정본과 다를 가능성**(별도 확인 필요). 재설계 전엔 규칙 변경 금지.
- `[미해결]` **Kakao 키 임시 공유**: 테스트 단계라 callcenter 앱 키 `58bf34…` 공유 사용(원 buslink 키 `d464b4…`는 `.env.local` 주석 보존). ⚠ Kakao 디벨로퍼에서 그 앱 Web 플랫폼에 buslink 도메인(`https://buslink-prod.web.app`·`https://buslink-prod.firebaseapp.com`, 로컬 `http://localhost:3000`) 등록해야 동작. Geocoder/Places **일일 한도 callcenter와 공유**(한쪽 급증=양쪽 장애). 비즈앱 심사 통과 후 전용 키 분리 → `tasks.md`. ⚠ 빌드 PC `.env.local` line7이 `58bf34…`(운영) 아닌 `d464b4…`면 prod 지도 전체 사망 — 빌드 전 필수 확인. 2026-05-18 d464b4 활성 상태로 재빌드·배포돼 실장애 발생, 콘솔 롤백으로 복구함.
- `[해결]` **`/p` EmployeeApp 지도 흰화면 = 카카오 SDK `autoload=false` 누락 + truthy 폴링**(2026-05-19, 코드수정·미배포): `public/index.html` SDK가 `autoload=false` 없이 `libraries=services` 로드 → `App.js`가 `window.kakao?.maps` 단순 truthy로 ready 판정. 이 조합에서 `window.kakao.maps`는 maps 엔진/`services` **초기화 완료 전** truthy → `<Map>`이 미완성 엔진에 `new kakao.maps.Map()` → 흰화면·콘솔 무에러·복구불가(#14-B services 추가 후 발현). 해결: ①SDK src `&autoload=false` ②App.js 게이팅을 `window.kakao.maps.load(cb)` 콜백 only(초기 state `false`) ③HomeTab `<Map onCreate={m=>setTimeout(()=>m.relayout(),0)}>` 0-size-init 방어. 미배포(이 PC 금지)·localhost 확인 대기, 진단오버레이 DIAG-B 제거 TODO(tasks.md).
- `[패턴]` **카카오 SDK는 `autoload=false`로 로드하고 `window.kakao.maps.load(cb)` 콜백에서만 ready 처리**: `autoload=false` 없으면(또는 truthy 폴링이면) `window.kakao.maps` 가 엔진/`services` 초기화 **전** truthy → `<Map>` 너무 일찍 생성 시 영구 흰화면(에러 0). `!!window.kakao?.maps` 로 ready 판정 금지 — `maps.load()` 콜백 또는 `window.kakao.maps.Map` 존재로만 판정. `react-kakao-maps-sdk <Map>` 흰화면 2대 원인 = ①이 게이팅 함정 ②컨테이너 0px init(`onCreate` relayout 방어). 둘 다 본 프로젝트에서 발현(전자 2026-05-19 해결, 후자 playbook L34).
- `[패턴]` **이 D: PC에서 buslink 빌드·배포 금지(2026-05-18 교훈)**: 이 PC에서 ce4c5b5(주말 리디자인) 기반 다회 hosting 배포가 prod를 연쇄로 깨뜨림 — 카카오 d464b4 오박힘 + Firestore `permission-denied`(공지구독·fcmToken·gps). **2026-05-18 localhost 재현으로 원인 확정·2분리**: ⓐ prod 전용 permission-denied = **Firebase Auth 승인 도메인에 `buslink-prod.web.app` 누락**(localhost는 기본 허용이라 `[FCM] Firestore 저장 완료 ✅` 정상). → 콘솔 Authentication→Settings→승인된 도메인에 `buslink-prod.web.app`·`buslink-prod.firebaseapp.com` 추가로 해결(코드·배포 무관, 즉시). ⓑ 진짜 "지도 안나옴"은 별개 = **ce4c5b5 EmployeeApp `/p` 카카오 `<Map>` 흰화면**(localhost도 재현, 내 커밋·auth 무관 — A/B로 입증). 상세·다음단계 → tasks.md 진행중 문제B. **정상 라이브 = 주말 PC가 만든 `main.d85ec794.js`**(콘솔 Hosting 롤백으로 복구, 카카오 58bf34). 규칙: buslink 빌드·배포는 **주말 작업 PC에서** 수행. 이 PC 불가피 시 `.env.local` 전체를 그 PC와 동일 동기화 + 배포 후 curl(카카오 도메인·Firebase 프로젝트) 검증. prod에 가설-배포 반복 절대 금지 — 회귀 시 콘솔 롤백 먼저, 재현은 localhost.

## 주의할 패턴
- `[패턴]` **"승객앱"=EmployeeApp(`/p`)**, PassengerApp(`/bus`) 아님. `/p`=사번+PIN·localStorage 세션·홈/노선/탑승/설정 탭(직원 실사용 앱). `/bus`=익명·URL 딥링크/QR 배포용 별개 앱. 사용자가 "승객앱" 기능 요청 시 기본 대상은 **`/p` EmployeeApp** — 2026-05-17 세션에서 노선선택을 `/bus`에 잘못 넣어 재작업 발생. 작업 전 화면/URL로 어느 앱인지 확인.
- `[패턴]` **정류장 사진은 Firestore 직저장**(Storage 미사용): `lib/image.js`가 긴변 1000px·JPEG q0.6→0.45→0.3 단계압축, base64 >700KB 거부(Firestore 1MB 문서 한도 여유). data URI가 stop 문서에 포함돼 노선 정류장 onSnapshot/getDocs 페이로드를 키움 — 정류장당 사진 1장 전제. 다수·고해상 추가 시 읽기 부하/문서한도 재검토(향후 필요시 Storage 전환).
- `[패턴]` `lib/notifications.js`는 `getToken` 전 기존 push subscription을 `unsubscribe` — VAPID 키 교체 충돌 방지(삭제 금지).
- `[패턴]` 루트 `CLOUD_FUNCTION_FCM.js`는 v1 문법 옛 참고 스니펫 — 실배포 코드 아님. 실제는 `functions/index.js`(v2).
- `[패턴]` `boardingTokens`/`partnerCodes`는 규칙상 read 공개(`true`) — 토큰 추측·코드 유출 주의.
- `[패턴]` 카카오 `services`(Geocoder/Places) 사용 시 `window.kakao?.maps?.services` + 콜백 `status` 가드 필수 — SDK 미로드/한도초과(공유 키 callcenter와 일일 한도 공유, `[미해결] Kakao 키 임시 공유`)면 우아 실패하고 수동 경로(지도선택/좌표직접/자유텍스트) 보존. RoutesTab 정류장 검색이 이 패턴(`handleAddrSearch`).
- `[패턴]` 실 테스트/별도 lint 없음 — 수동 검증. 배포는 사용자 명시 요청 시에만.

## 저장소 메모
- `src.zip` git 추적되나 작업트리 삭제 상태(소스 백업 산출물, 빌드 미사용).
