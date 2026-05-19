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
`lib/gps.js startGPS` = `watchPosition` + 5m/5초 스로틀 + 100m 정류장 도착 감지 → `gps/{companyId}_{vehicleId}`(덮어쓰기) + `gpsHistory`(누적). PassengerApp/EmployeeApp/AdminApp이 `onSnapshot` 구독 → `lib/useAnimatedPositions.js`(rAF lerp)로 마커 보간. AdminApp 시뮬레이터 탭은 `sendGPS` 직접 호출. **콜드스타트**: 진입 시 `getCurrentPosition` 1회 선발행(출발 직후 공백 방지) + `onGpsError` 콜백(권한/TIMEOUT 상위 전파, DriverApp 안내).

## 경로 / 권한·설치 (2026-05-18)
- `lib/routeProgress.js` — 폴리라인 누적거리·점 투영. `routes/{id}.routePath`(수동 그린 경로) 기반 승객앱(`/p`·`/bus`) 진행 시각화·정밀 도착판정. **미설정 시 stops 직선 폴백**(하위호환). 상세 @.claude/issues.md.
- 권한·PWA설치: `lib/usePermissions.js` + `components/PermissionGate.js`(순수 브라우저 API, Firebase import 금지 — `components/ui` 관례 일관). `index.js`가 `firebase-messaging-sw.js` 1회 선등록(`beforeinstallprompt` 활성화, idempotent).

## 데이터 흐름 — 공지/FCM
AdminApp → `lib/notifications.js sendNotice` → `notices` + `fcmQueue` 문서 생성 → CF `sendNoticeToCompany`가 멀티캐스트 발송. 상세 @.claude/functions.md.
