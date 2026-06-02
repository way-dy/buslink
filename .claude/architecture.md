# Architecture

기술 아키타입 **C** — Create React App SPA(빌드 필요) + Firebase(Auth/Firestore/Hosting/Functions/FCM). Firebase 프로젝트 `buslink-prod`, Functions region `us-central1`. react-router 없음(경로 기반 수동 분기). **SaaS 멀티테넌트 Phase 1.1+1.2 (2026-05-28)**: `src/lib/companyResolver.js`(HOSTNAME_TO_COMPANY 맵 + resolveCompanyIdForAuth/Anon/resolveByHostname) — App.js·DriverApp·EmployeeApp·PassengerApp·SW 5지점 통합. dy001 폴백 유지(동영관광 보호). 슈퍼관리자 콘솔=AdminApp 12번째 탭(role==='superadmin'일 때만 노출) + 헤더 회사 전환 드롭다운 + CF 3종(createCompany/listCompanies/toggleCompanyActive). **Phase 1.3 협력사 운영 포털 (2026-05-28, `main.dd6a87da.js` 빌드)**: PartnerApp `mainTab="ops"` 4번째 탭(STEPS.MAIN 안 인라인 OperationsMode) — passengers(partnerCode·active)→자사 routeId 집합→dispatches/gps(routeId·vehicleId)·boardings(partnerCode)·notices(partnerCode null||==code) 4개 onSnapshot 구독. App.js `needsKakao` 에 `isPartnerRoute` 추가(카카오 로드 5초 대기). rules/indexes/CF 변경 0. **Phase 1.4 협력사 공지 발송 (2026-05-29, `main.7d984f96.js` 빌드 미배포)**: 신규 onCall `sendPartnerNotice` — partnerCodes 검증(exists+active+companyId 일치) + 서버측 rate-limit(`partnerCodes/{code}.recentNoticeTimestamps:number[]`, 1시간 5건) + title 50/body 500 trim + Admin SDK 로 notices(sender:"partner"/senderCode)+fcmQueue create(룰 우회). 기존 `sendNoticeToCompany` 트리거가 partnerCode 필터 발송 인프라 재사용. PartnerApp OperationsMode 섹션 C2 신설(섹션 D 공지 수신함 위) — 제목/본문/일반·긴급 라디오 + 글자수 카운터 + 인라인 컨펌 카드 + 성공/실패 결과 카드 + `partnerCodes/{code}` onSnapshot 으로 "시간당 남은 발송 N/5건" 실시간 표시. rules/indexes 변경 0(partnerCodes update 는 CF Admin SDK).

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
`lib/gps.js startGPS` = `watchPosition` + 5m/5초 스로틀 + 100m 정류장 도착 감지(routePath 주입 시 진행률 기반 통과 누락 백필 — GPS 끊김 회복, 2026-05-22) → `gps/{companyId}_{vehicleId}`(덮어쓰기) + `gpsHistory`(누적). PassengerApp/EmployeeApp/AdminApp이 `onSnapshot` 구독 → `lib/useAnimatedPositions.js`(rAF lerp)로 마커 보간. AdminApp 시뮬레이터 탭은 `sendGPS` 직접 호출. **콜드스타트**: 진입 시 `getCurrentPosition` 1회 선발행(출발 직후 공백 방지) + `onGpsError` 콜백(권한/TIMEOUT 상위 전파, DriverApp 안내). **통신 복구**(2026-05-28): `lib/useOnlineRecover.js`(`window.online` 이벤트 + 옵션 `forceFirestoreReconnect`로 `disableNetwork→enableNetwork`) tick을 DriverApp/PassengerApp/EmployeeApp HomeTab onSnapshot deps에 추가 → 오프라인→온라인 전이 시 stale 리스너 자동 재구독. DriverApp은 driving=true 시 `triggerHeartbeat(watchId)` 1회 호출(`gps.js` heartbeatRegistry에 캡쳐된 lastPos로 즉시 sendGPS) → 승객앱 마커 즉시 신선화.

## 데이터 흐름 — ETA 산출(chain plan-first + 진척률 안분, 2026-05-28~29)
`lib/stopSchedule.js computeStopEstimates`는 정류장 order 순회 + 단조증가 estMs 강제. **`segTravelMs(a,b)` = 계획 offsetMin 델타 우선** — 둘 다 offsetMin 있으면 `(offsetB-offsetA)*60*1000`(DWELL 가산 X — offsetMin 자체가 정차 포함된 진입시각 차이), 한쪽 누락 시 geometric(routePath/직선 + DWELL) 폴백. chain 전파 = `actualLast + Σ(plan 델타) = plannedMs[i] + (actualLast-plannedLast)` → "각 정류장 실 도착시간 기준으로 다음 정류장까지 미리 설정한 offsetMin만큼 더해 정밀 예측". next 정류장 GPS 가중 **완전 제거(0%)** — 터널·약전계 GPS 노이즈에서 ETA 출렁임 차단. **2026-05-29 routePath 진척률 안분(next 한정)**: routePath+busProgress 있으면 `actualProgress = (busProgress-stopProgress[i-1])/segDist`, `expectedProgressByTime = elapsed/expectedTotalMs`, `slowFactor=max(1, expectedByTime/actualProgress)`(빠른 방향 1 클램프 — "갑자기 곧 도착" 점프 차단), `remainingMs=(1-actualProgress)*expectedTotalMs*slowFactor`. actualProgress≥0.95=ARRIVING_BUFFER_SEC(45초)·≤0.05=노이즈 skip. source='gps'. 이전엔 chain 채택값이 정류장 사이에 정적이라 자연 감소만 일어나 도착 직전 큰 점프 → useSmoothedEta가 raw 채택 → "곧 도착" 도약 결함. **`delaySec`는 가드 적용 *전* raw 후보(chain→plan) 기준** — 단조증가/과거금지 가드가 음수(조기) 지연을 양수(지연)로 뒤집던 결함(사용자 호소 #1) 차단. **useSmoothedEta jumpThresholdSec 300→180**(진척률 안분으로 자연 변동 → 정류장 통과 시점만 즉시 raw). 단조증가(MIN_STOP_GAP_SEC=60)·과거금지(MIN_FUTURE_BUFFER_SEC=30)·MIN_EFFECTIVE_SPEED_KMH 보호장치 유지. 출력 계약(stopId/plannedAt/estimatedAt/delaySec/status/source) 절대 불변 → useSmoothedEta/formatPassengerEta/describeEtaSource/formatDelayLabel 호환.

## 경로 / 권한·설치 (2026-05-18)
- `lib/routeProgress.js` — 폴리라인 누적거리·점 투영. `routes/{id}.routePath`(수동 그린 경로) 기반 승객앱(`/p`·`/bus`) 진행 시각화·정밀 도착판정. **미설정 시 stops 직선 폴백**(하위호환). 상세 @.claude/issues.md.
- 권한·PWA설치: `lib/usePermissions.js` + `components/PermissionGate.js` + `components/InstallPrompt.js`(순수 브라우저 API, Firebase import 금지). `src/index.js`가 ①`firebase-messaging-sw.js` 1회 선등록(idempotent) ②`beforeinstallprompt` 글로벌 stash(`window.__buslinkDeferredBIP`, render 전) ③pathname `/p`·`/driver` 시 manifest `<link>` 조기 교체(마운트 useEffect 교체는 BIP 평가보다 늦을 수 있음).
- 앱별 PWA(3종, 단일 origin 다중 PWA — 각 고유 `id`+`scope` 필수): `manifest.json`(관제, id/start_url `/?app=admin`·scope `/`) + `manifest-driver.json`(기사, 전부 `/driver`) + `manifest-employee.json`(직원, 전부 `/p`, icons 192~512+1024). scope는 path 기반이라 경로 분리 필수(id만으론 Chrome scope dedupe 회피 불가 — 상세 @.claude/issues.md). `lib/pwaManifest.js applyAppManifest`를 EmployeeApp/DriverApp/AdminApp 모두 마운트 시 호출(2026-05-27 AdminApp 보강). `firebase.json` `headers` 3규칙(2026-06-02 교정): `**`=no-cache 캐치올(클린 URL `/driver`·`/p`·`/bus`·`/` rewrite HTML 포함 — `**/*.html` 패턴이 클린 URL 미적용해 stale 서빙되던 결함 교정) / `/static/**`=immutable 장기캐시(last-match 우선) / SW=no-cache. **알림 아이콘 정본**: `public/icons/notification-employee.png`(CRA `logo192.png`=React 로고라 사용 금지, 2026-05-27). CF `webpush.notification.icon`/`badge` + SW `showNotification` 모두 이 경로 참조.

## 데이터 흐름 — 탑승/통계 (2026-05-26)
- **QR 탑승**: DriverApp이 `boardingTokens` 생성(5분 만료, vehicleId/routeId/dispatchDate 포함) → 직원이 모바일 카메라로 QR 스캔 → `/board?t={tokenId}` BoardingApp 진입 → `signInAnonymously` 인증 → `validateAndBoard`(`lib/boarding.js`)로 토큰 검증·boarding 도큐먼트 생성. boarding 시 ①`passengers/{empNo}.partnerCode` getDoc → `partnerCode` denormalize(협력사별 통계용) ②`gps/{companyId}_{vehicleId}` getDoc → `vehicleLat/vehicleLng/vehicleSpeed` 캡처(정류장 매핑용). 둘 다 try/catch — 미수신 시 null(boarding 자체는 진행).
- **정류장별 GPS 매핑**: `lib/stopMapping.js`(순수 함수, routeProgress.haversine 재사용). `nearestStop(lat,lng,stops,maxMeters=300)` + `aggregateBoardingsByStop(boardings,stopsByRoute)` → boarding의 vehicleLat/Lng를 routeId의 stops 좌표와 비교, 반경 300m 이내 가장 가까운 stop으로 매핑. AdminApp `BoardingStatsTab`·PartnerApp `BoardingStatsMode` 양쪽에서 lazy stops fetch + 클라이언트 집계.

## 데이터 흐름 — 공지/FCM
- **공지**: AdminApp → `lib/notifications.js sendNotice` → `notices` + `fcmQueue` 생성 → CF `sendNoticeToCompany` 멀티캐스트. 직원앱 `/p` 공지 탭이 `notices`를 직접 구독(푸시 누락 대비 pull 폴백). **강제 공지 모달**(2026-05-27, `NoticeForceModal`): EmployeeApp 마운트 시 `unreadCount > 0`이면 가장 최신 안 읽음 공지를 풀스크린 모달로 자동 노출 — "확인했습니다" 클릭 시 `markNoticesRead` → `unreadCount=0` → 자동 사라짐. type='emergency'면 5초 카운트다운+진동. PWA 푸시 OS 누락(절전·Doze) 대비 도달성 보장 통로.
- **도착 임박**: 기사앱 도착 감지 → `dispatches/.../stopArrivals` 갱신 → CF `notifyPreArrival`이 내 정류장(`fcmTokens`에 routeId+stopId denormalize) 2/1정거장 전 직원에 FCM. 상세 @.claude/functions.md.
