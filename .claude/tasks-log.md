# Tasks Log (옛 완료 누적·시간역순)

> tasks.md의 최근 7일을 제외한 누적 로그. 상세는 issues.md 패턴·redesign-log.md·git log.

## 2026-06-08~17 세션 누적 (tasks.md 에서 이관, 2026-07-09)
> **2026-06-17 세션 추가**: EmployeeApp(`/p`) 노선 변경 모달이 전 거래처 노선 노출 → 직원 partnerCode 필터(모달+홈 폴백). 상세 issues.md `[패턴]`.
> **2026-06-17 세션(prod 배포)**: 배차관리·배차일정·대시보드 기사현황에 createdBy 격리 확장(누락분) — 제한 admin(dy04)이 배차 안 보이던 것·대시보드에 회사 전체 기사 보이던 것 해소. canSeeDispatch/canSeeSchedule(노선 partnerCode∈allowed OR 노선/배차 createdBy===uid) + 신규/복사 createdBy 기록 + 폼 드롭다운 본인것만(전체권한 전체 유지). 마스터키=partnerCodes.createdBy(거래처에 createdBy만 있으면 전 탭 partnerCode 체인 자동노출). 레거시(채드윅 등) 거래처/기사는 슈퍼관리자 권한체크 or createdBy 백필 필요·신규는 자동. rules/indexes/CF 변경 0. 상세 issues.md `[패턴]`.
> **2026-06-16 세션 누적(전부 prod 배포·master 커밋)**: ① **정류장 주소검색 무반응** = 카카오 키(`58bf34`) 신규 서브도메인(`admin.buslink.co.kr` 등) 미등록 → 지도+검색 동시 사망. **사용자가 카카오 콘솔 4개 서브도메인 등록 완료(해결)** + 코드측 `handleAddrSearch` 8초 워치독(콜백 미응답 시 "검색 중" 영구정지 차단). ② **본인 등록 거래처 배차가 배차관리에서 안 보임** = createdBy 가시성을 대시보드·협력사관리만 적용했던 누락 → AdminApp 최상위에서 `allowed = rawAllowed∪(createdBy==uid 거래처)` 합쳐 **전 탭 동일 적용**. 사용자 결정 "각자 생성 거래처는 권한 무관 항상 노출". rules/indexes/CF 변경 0. 상세 issues.md `[패턴]` 2건.
> **2026-06-15 세션 누적(전부 prod 배포·master 커밋)**: ① admin 협력사 권한 "전체 해제" 저장 안 됨 수정(`listCompanyAdmins` CF + `EditAdminPermissionsModal`: 빈배열 `[]`≠`["*"]`, 부재만 폴백) + 회사관리 관리자목록 자동펼침·게시판형 카드 ② 신규 admin 기본 전체권한→전체해제 ③ 대시보드 **거래처 관리 현황**(거래처별 노선/배차/운행/탑승 + 업체코드·포털URL 열람) + `partnerCodes.createdBy` 로 본인 발급분 즉시 열람(가시범위 `allowed∪createdBy`) ④ 대시보드 거래처 등록·거래처별 노선관리 버튼 ⑤ 노선 저장 후 필터 초기화(안보임 해소)·기사 사번/PIN 안내+autofill 차단·**SearchableSelect**(기사/차량/노선 검색, 400+ 대비). **rules/indexes/CF 시그니처 변경 0**(listCompanyAdmins 내부 로직만)·클라 UI 중심. 상세 issues.md `[패턴]` 3건.
> **이전 2026-06-08~09 세션 누적(전부 prod 배포)**:
> **2026-06-08~09 세션 누적(전부 prod 배포)**:
> - **앱별 서브도메인 분리(Phase 1)**: `admin/d/p/partner.buslink.co.kr` — App.js `HOST_APP` 호스트명 라우팅(`src/App.js`)·companyResolver/SW 호스트맵 동기. **DNS = 카페24 [서버호스팅 DNS 관리](cns1/cns2.simplexi.com zone)에 CNAME `→buslink-prod.web.app` 추가**(도메인-DNS관리 ns1.cafe24.com zone 아님!) → 반영 후 Firebase 인증·SSL → 동작. (사용자 작업 대기/진행)
> - **앱별 아이콘**: `src/lib/appIcons.js`(호스트/경로→favicon/apple/manifest/title/install) — index.js 조기 swap·InstallPrompt 설치팝업·partner.svg/manifest-partner.json 신설. CRA 기본 favicon.ico(React 로고) 폴백 제거.
> - **Phase B 협력사 게이팅**: 로그인 admin `allowedPartnerCodes`로 AdminApp 8지점 데이터 필터(`src/lib/partnerAccess.js`)·"전체"여도 한정·공지 "전체" 차단. 클라만(rules 별도 후속).
> - **관리자 행 정보수정**: CF `updateCompanyAdminProfile`(uid 기준·role 가드·이름/이메일/비번만).
> - **도착 기록/ETA**: computeStopEstimates **GPS 진척률 통과 안전망**(busProgress→arrived·현실 지연, "24분 균일" 아티팩트 소멸) + DriverApp **실시간 자기 GPS onSnapshot(`liveVehiclePos`)** → computeStopEstimates 주입(표시 지연 ~30초→~5초) + **busProgress 통과 정류장 recordStopArrival 우회**(detectStops 미발화 근인 미해결이나 우회로 충족). 진단 CF `fetchEtaDiagnostic`에 appVersion/stopArrivalsLog/allStopProgress 반환 추가.
> - **로딩 화면**: `src/components/LoadingScreen.js`(밝은 브랜드·버스 스피너) — App.js 3 게이트 교체(다크 "지도 로딩 중" 제거).
> - **정류장 진입시각 인라인 편집**: RoutesTab 정류장 목록 행에서 `🕒 진입` 직접 입력→즉시 저장(`saveStopTime`). 폼 왕복 불필요.
> **🟢 캐시 블로커 해소 확정**(appVersion 반환되며 폰 새 빌드 입증). **도착 표시·지연 정상 작동 입증**(전 정류장 계획시각 있는 노선).
> **다음 검증(다른 PC/내일)**: ① 기사 운행 — 배지 `v2026-06-09-livegps`·도착 즉각(~5초)·재조회 JSON `stopArrivalsLog` `via:"liveGps" ok:true`·estimates `actual` ② Phase B — 제한 담당자 로그인 시 자기 협력사만 ③ 서브도메인 SSL 발급 후 4개 도메인 접속. **잔존**: unplanned 정류장 위주 노선 지연 라벨 제한(offsetMin 입력 보강)·detectStops 근인 미해결(우회 충족)·Phase B rules 강제(별도).


- [x] **2026-05-22** 기사앱·승객앱 도착시간 정밀화(`main.69bb5377.js`) — computeStopEstimates 단조증가 재설계·gps.js GPS 복구 정류장 백필·DriverApp routePath 주입. 단조증가 강제로 동일값/역전/과거 표시 차단.
- [x] **2026-05-22** PWA 설치 충돌 해소 — 기사앱 `/driver` 경로 분리(`main.8a33eceb.js`/`968c8f9`). manifest 3종 고유 id + scope 분리(/, /driver, /p) — Chrome scope dedupe 회피.
- [x] **2026-05-22** 공지 도달 보장 — `/p` 인앱 공지함 탭·삼성 배터리 안내·iOS 설치 가이드 바텀시트(`main.25b9e8df.js`/`2c1164e`). PWA 푸시 OEM 절전 누락 보정.
- [x] **2026-05-22** 내 정류장 도착 임박 푸시 신규 CF `notifyPreArrival` + `/p` 내 정류장 영속화(`main.08c0818a.js`/`5a9839c`). fcmTokens routeId+stopId denormalize·diff+멱등 마커.
- [x] **2026-05-21~22** 모바일 공지 푸시 정상화 5건 배포 — VAPID 키 1글자 오타 fix·SW 이중알림 가드·InstallPrompt 자동회복+안드로이드 폴백·FCM webpush 아이콘. 상세 issues.md.
- [x] **2026-05-21** 공지 발송 진단·복구 인프라 강화 배포(`main.903dd602.js`) — NoticeTab 결과 가시화·snapshotError·EmployeeApp 🔔 알림 진단 카드. CF 정상·근인=토큰 invalid 자동삭제.
- [x] **2026-05-21** 4건 묶음 hotfix 배포(`main.47396703.js`) — `new window.Map()`(카카오 SDK shadow)·DriverApp 리스트 내부 스크롤·`useWakeTick`(백그라운드 stale)·formatDelayLabel ±2분.
- [x] **2026-05-21** ErrorBoundary 11탭 도입 — 흰 화면 차단 hotfix (`54bcdab`/`main.25ea7440.js`). NoticeTab render throw → AdminApp까지 unmount(전체 흰 화면) → 각 탭을 ErrorBoundary로 격리.
- [x] **2026-05-21** 공지 발송 결함 진단·복구 + 협력사 단위 운영 통일 (`main.6431ecf5.js` + functions + rules). fcmTokens.partnerCode 필드·NoticeTab 진단 패널·PartnerFilter 공통 컴포넌트.
- [x] **2026-05-21** 승객앱 ETA 안정화 + 정밀 표현 (`main.dbeedce7.js`). GPS 가중 50:50→70:30·useSmoothedEta(EMA)·formatPassengerEta 버킷 라벨·describeEtaSource.
- [x] **2026-05-21** 기사앱 현재 정류장 자동 스크롤 + 강조 (`main.d1013e16.js`). `currentStopRowRef` + scrollIntoView.
- [x] **2026-05-21** 기사앱 어르신 가독성 강화 (`main.ec085ae6.js`). 정류장·시각·지연 글씨 키움·지연 칩화·도착 정류장 강조.
- [x] **2026-05-20** 기사앱 설치 카드/팝업 미표시 fix + 운행 전 지연 라벨 게이팅 (`eb1c2e7`/`main.ff93d91f.js`).
- [x] **2026-05-20** 승객앱(/p·/bus) UI 강화 3건 (`main.728aa7e6.js`) — 지도 정류장 시각·노선도 폰트·버스 마커 펄스.
- [x] **2026-05-20** 배차 일정 자동 펼침 시스템 (`main.4d4a3650.js` + functions/rules) — dispatchSchedules + expandDispatchSchedules cron.
- [x] **2026-05-20** 정류장 진입시각 음수 자정 보정 버그 fix (`main.bc5eccda.js`) — offsetMinFromPlanTime 자정 보정 폐기.
- [x] **2026-05-20** 정류장 진입시각 입력 UX — 오프셋(분)→시각(HH:MM) 직접 입력 (`main.0a94e306.js`).
- [x] **2026-05-20** 정류장 계획·예상시각 시스템 (`b122941`/`main.1cef341f.js` + rules) — stops offsetMin·stopArrivals·stopSchedule.js.
- [x] **2026-05-20** 설치팝업 스누즈 14→3일 + DIAG-INSTALL 제거 (`da24224`/`main.f0dd8be3.js`).
- [x] **2026-05-20** 기사앱 배차 선택 칩→모달 + DIAG-INSTALL (`e690b41`/`main.cb747e1c.js`).
- [x] **2026-05-20** 기사앱 설치 BIP 글로벌 stash + 다중 배차 LS 영속 (`ac6fbf3`/`main.6c626f25.js`).
- [x] **2026-05-20** 노선 그리기 편집 UX — ⊕삽입·앞에추가·선택삭제·3색핀·번호라벨 (`1849cce`/`main.7d89705e.js`).
- [x] **2026-05-20** main→master 머지 + prod 재배포 (`d06bb7f`/`main.dc99419e.js`) — 노선 그리기 회귀 복구. autoload=false + onCreate 더블 relayout 공존.
- [x] **2026-05-19** 앱별 PWA 아이콘 Route Family 적용·배포 (`8b3e37e`/`0095e16`) — manifest 3종 + icons 6 + 동적 교체.
- [x] **2026-05-19** prod 첫 새 배포 — master HEAD `f2aa1a2`/`main.1614fa6b.js` (롤백본 `d85ec794` 대체).
- [x] **2026-05-19** PWA 설치형 + 팝업 / 문제 B `/p` 흰화면 근본수정(`autoload=false`+`maps.load(cb)`) / ETA "목적지 도착" (`55112aa`·`1597097`·`f2aa1a2`).
- [x] **2026-05-18** 노선 사전경로 + routeProgress + 권한·설치 게이트 + gps 콜드스타트(`5fa0737`); prod 장애→롤백→실원인(카카오 키 단일) 확정·문제 A 오진 정정(`c970c07`).
- [x] **2026-05-17** 정류장 사진+설명·클립보드·#14-B 주소검색·핀 미세조정·앱 노선변경·승객 노선선택·재활성화 — 다수 라이브.
- [x] **2026-05-16** 리디자인 0~6단계 + QA 안정화 4건 + PLANNING.md 정본화 + `.claude/` 분리 — 라이트 테마 전면 리스킨.
