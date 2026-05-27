# Architecture

기술 아키타입 **C** — Create React App SPA(빌드 필요) + Firebase(Auth/Firestore/Hosting/Functions/FCM). Firebase 프로젝트 `buslink-prod`, Functions region `us-central1`. react-router 없음(경로 기반 수동 분기).

## 명령어
- 개발: `npm start` (http://localhost:3000)
- 빌드: `npm run build` → `build/` (Hosting public 디렉터리)
- 테스트: `npm test` (CRA watch). **실 테스트 없음**(App.test.js 스텁). 별도 lint 단계 없음.
- 배포(**사용자 명시 요청 시에만**): `firebase deploy` = Hosting+Functions+Firestore rules/indexes 동시. Functions만: `cd functions && npm run deploy`. 에뮬레이터: `cd functions && npm run serve`.
- `functions/`는 독립 npm 패키지(CommonJS) — 루트와 별도 `npm install` 필요.

## 환경변수
`REACT_APP_*`는 `.env.local`(gitignore, 미커밋): `FIREBASE_*` 6종, `KAKAO_MAP_KEY`(운영 공유키 `58bf34…` — `d464b4…`면 prod 지도 사망), `VAPID_KEY`. 템플릿=**`.env.example`**(키+가이드, 값 제외 — 어느 PC나 부트스트랩). 빌드타임 치환 — 변경 시 재빌드 필수.

## 외부 SDK (npm 아님, `<script>` 주입)
- 카카오맵: `public/index.html`에서 `REACT_APP_KAKAO_MAP_KEY`로 로드. App.js가 `window.kakao` 5초 폴링 대기(실패해도 진행).
- SheetJS/XLSX: `PartnerApp`이 CDN 스크립트 주입, `lib/partner.js`가 `window.XLSX` 사용(엑셀 직원명부 파싱/샘플).

## 디자인 시스템 (2026-05-16 도입, 리디자인 0단계)
- 토큰 정본: `src/styles/tokens.css`(CSS 변수, `src/index.js` import). 폰트 Pretendard self-host = npm `pretendard` 패키지(`dist/web/variable/pretendardvariable.css`, CDN 미사용 — 빌드가 woff2 self-host). `html,body{font-family:var(--font-base)}`가 전역 폴백(`index.css`보다 뒤 import).
- 공통 UI 라이브러리: `src/components/ui/`(ESM 프리미티브 + `tokens.js` JS 미러 + 배럴). 순수 프레젠테이션, Firebase/로직 import 금지. 기존 페이지 인라인 S 객체와 점진 공존(화면별 단계에서 채택).

## 데이터 흐름 — GPS 파이프라인
`lib/gps.js startGPS` = `watchPosition` + 5m/5초 스로틀 + 100m 정류장 도착 감지(routePath 주입 시 진행률 기반 통과 누락 백필 — GPS 끊김 회복, 2026-05-22) → `gps/{companyId}_{vehicleId}`(덮어쓰기) + `gpsHistory`(누적). PassengerApp/EmployeeApp/AdminApp이 `onSnapshot` 구독 → `lib/useAnimatedPositions.js`(rAF lerp)로 마커 보간. AdminApp 시뮬레이터 탭은 `sendGPS` 직접 호출. **콜드스타트**: 진입 시 `getCurrentPosition` 1회 선발행(출발 직후 공백 방지) + `onGpsError` 콜백(권한/TIMEOUT 상위 전파, DriverApp 안내).

## 경로 / 권한·설치 (2026-05-18)
- `lib/routeProgress.js` — 폴리라인 누적거리·점 투영. `routes/{id}.routePath`(수동 그린 경로) 기반 승객앱(`/p`·`/bus`) 진행 시각화·정밀 도착판정. **미설정 시 stops 직선 폴백**(하위호환). 상세 @.claude/issues.md.
- 권한·PWA설치: `lib/usePermissions.js` + `components/PermissionGate.js` + `components/InstallPrompt.js`(순수 브라우저 API, Firebase import 금지). `src/index.js`가 ①`firebase-messaging-sw.js` 1회 선등록(idempotent) ②`beforeinstallprompt` 글로벌 stash(`window.__buslinkDeferredBIP`, render 전) ③pathname `/p`·`/driver` 시 manifest `<link>` 조기 교체(마운트 useEffect 교체는 BIP 평가보다 늦을 수 있음).
- 앱별 PWA(3종, 단일 origin 다중 PWA — 각 고유 `id`+`scope` 필수): `manifest.json`(관제, id/start_url `/?app=admin`·scope `/`) + `manifest-driver.json`(기사, 전부 `/driver`) + `manifest-employee.json`(직원, 전부 `/p`, icons 192~512+1024). scope는 path 기반이라 경로 분리 필수(id만으론 Chrome scope dedupe 회피 불가 — 상세 @.claude/issues.md). `lib/pwaManifest.js applyAppManifest`를 EmployeeApp/DriverApp/AdminApp 모두 마운트 시 호출(2026-05-27 AdminApp 보강). `firebase.json` `headers`로 html·manifest·sw `no-cache`. **알림 아이콘 정본**: `public/icons/notification-employee.png`(CRA `logo192.png`=React 로고라 사용 금지, 2026-05-27). CF `webpush.notification.icon`/`badge` + SW `showNotification` 모두 이 경로 참조.

## 데이터 흐름 — 탑승/통계 (2026-05-26)
- **QR 탑승**: DriverApp이 `boardingTokens` 생성(5분 만료, vehicleId/routeId/dispatchDate 포함) → 직원이 모바일 카메라로 QR 스캔 → `/board?t={tokenId}` BoardingApp 진입 → `signInAnonymously` 인증 → `validateAndBoard`(`lib/boarding.js`)로 토큰 검증·boarding 도큐먼트 생성. boarding 시 ①`passengers/{empNo}.partnerCode` getDoc → `partnerCode` denormalize(협력사별 통계용) ②`gps/{companyId}_{vehicleId}` getDoc → `vehicleLat/vehicleLng/vehicleSpeed` 캡처(정류장 매핑용). 둘 다 try/catch — 미수신 시 null(boarding 자체는 진행).
- **정류장별 GPS 매핑**: `lib/stopMapping.js`(순수 함수, routeProgress.haversine 재사용). `nearestStop(lat,lng,stops,maxMeters=300)` + `aggregateBoardingsByStop(boardings,stopsByRoute)` → boarding의 vehicleLat/Lng를 routeId의 stops 좌표와 비교, 반경 300m 이내 가장 가까운 stop으로 매핑. AdminApp `BoardingStatsTab`·PartnerApp `BoardingStatsMode` 양쪽에서 lazy stops fetch + 클라이언트 집계.

## 데이터 흐름 — 공지/FCM
- **공지**: AdminApp → `lib/notifications.js sendNotice` → `notices` + `fcmQueue` 생성 → CF `sendNoticeToCompany` 멀티캐스트. 직원앱 `/p` 공지 탭이 `notices`를 직접 구독(푸시 누락 대비 pull 폴백). **강제 공지 모달**(2026-05-27, `NoticeForceModal`): EmployeeApp 마운트 시 `unreadCount > 0`이면 가장 최신 안 읽음 공지를 풀스크린 모달로 자동 노출 — "확인했습니다" 클릭 시 `markNoticesRead` → `unreadCount=0` → 자동 사라짐. type='emergency'면 5초 카운트다운+진동. PWA 푸시 OS 누락(절전·Doze) 대비 도달성 보장 통로.
- **도착 임박**: 기사앱 도착 감지 → `dispatches/.../stopArrivals` 갱신 → CF `notifyPreArrival`이 내 정류장(`fcmTokens`에 routeId+stopId denormalize) 2/1정거장 전 직원에 FCM. 상세 @.claude/functions.md.
