# Tasks

> 작업 시작/완료 시 이 파일만 수정. 체크박스 관리. 어느 PC든 이어작업용.

## 현재 상태 (2026-05-20 세션 종료)
> 이 저장소가 작업 정본. **어느 PC든** `git pull` + `.env.local`(↓부트스트랩)이면 빌드·배포 가능.
> prod 라이브 = `main.d1013e16.js` (기사앱 현재 정류장 자동 스크롤(중앙) + 글로우/펄스 강조).

### git 원격
- `origin/master` = 작업 정본(2026-05-20 main→master 머지 완료). 3월 폐갈래는 `origin/archive/remote-march-2026`(`f63321c`) 영구 백업.

### 새 PC 부트스트랩 (이어작업 1회)
- `git pull` → `npm install` (functions 쓰면 `cd functions && npm install`).
- `.env.local` 생성: `.env.example` 참고, 값은 사용자 보유분. ⚠ `REACT_APP_KAKAO_MAP_KEY`=운영 공유키 `58bf34…`(`d464b4…`면 prod 지도 사망).

### 배포 절차
1. 앵커 grep: `grep -nE '^REACT_APP_KAKAO_MAP_KEY=' .env.local` → `58bf34` 시작 확인(주석 9번 d464b4는 비활성, STOP 아님).
2. `CI=false npm run build` → `npm start` → localhost `/p`·`/bus` 지도·노선 그리기 확인.
3. `firebase deploy --only hosting` → curl 검증(키·manifest·아이콘·번들해시).
4. 회귀 시 가설-재배포 금지 → 콘솔 Hosting 롤백 먼저, 재현은 localhost.
- ※ Firebase Auth 승인 도메인은 기본 자동등록 — 조치 불필요(지난 "문제 A" 오진, issues.md).

## 다음 할 일
- [ ] (선택) 운영 노선에 `routePath` 실제 그리기 — 안 그린 노선은 stops 직선 폴백(정상).

## 백로그 / 검토 후보
- [ ] 🗓 **한국 공휴일 정적 갱신** — `functions/holidays.js` + `src/lib/holidays.js` 2028년 말까지 작성됨. 2028 하반기 전 2029~ 추가 필요(양쪽 동기화, 음력 환산은 한국천문연구원 발표 기준)
- [ ] `src/firestore.rules` ↔ 루트 일원화(src 사본 삭제 검토)
- [ ] `passengers` write 제약 — PartnerApp 익명화+규칙 재설계 동반(issues.md `[보류]`)
- [ ] `firebase-messaging-sw.js` 설정 env 주입(현재 하드코딩)
- [ ] 🔑 카카오 비즈앱 심사 통과 후 전용키 `d464b4` 복구 + 전용앱 도메인 등록 + 재빌드
- [ ] ⏳ Node 20→22 (데드라인 2026-10-30 decommission) — `firebase.json`·`functions/package.json`·`firebase-functions@latest`
- [ ] PassengerApp `ARRIVING_M` 미사용 — 완결성 다듬기

## 기획 갭 (PLANNING.md 2026-05-16, MVP 1단계 전부 동작)
- [ ] ⭐ #12 고객사 담당자 운영 포털 — 자사 실시간 버스·탑승·공지수신 (SaaS 최우선)
- [ ] #9 분석 / #8 운행일지 / #11 푸시 타게팅 / #4 노선 보강(요일·엑셀) / #14-C 정류장 엑셀 / #15 PIN 강제변경
- [ ] (보류·SaaS) #17 슈퍼관리자·빌링 / #16 멀티테넌트(dy001 하드코딩) / #15 SMS. (폐기) #10 예약관리

## 완료 (최근·시간역순. 옛 누적은 @.claude/tasks-log.md)
- [x] **2026-05-21** 기사앱 현재 정류장 자동 스크롤 + 강조 (`main.d1013e16.js`). `currentStopRowRef` + `useEffect([currentStopIdx])` → `scrollIntoView({behavior:'smooth', block:'center'})` 80ms 지연(카드 전환 후). 현재 정류장 강조: 글로우(`box-shadow 0 0 0 4px rgba(0,102,255,0.18)+0 4px 14px`), padding 18px(다른 row 14px), dot 14→18px + buspulse 펄스 ring(`absolute inset:-3`). 운행 시작 전(currentStopIdx<0)은 스크롤 skip. DriverApp.js 단독.
- [x] **2026-05-21** 기사앱 어르신 가독성 강화 (`main.ec085ae6.js`). 정류장 이름 14→18px·weight 800, 주소 11→13px, dot 10→14px(border 2→3), row padding 8→14px(터치영역). 시각·지연 줄 12→16px·시각 18px·weight 800. 지연 라벨이 텍스트 컬러→**칩 형태**(배경+border+padding). 현재/다음 태그 10→13px. 히어로 다음정류장 17→24px·시각 17→20px·지연 칩 12→15px. **도착 정류장 강조**: positive 톤 배경 카드(#F0FAF4+#B6E6C6 border) + 정류장 dot positive 색. opacity 분리(통과한 정류장은 이름만 0.55 흐림, 시각·지연은 항상 또렷 — 기사 본인 운행 평가에 중요). DriverApp.js 단독 변경, 로직 0 변경.
- [x] **2026-05-20** 기사앱 설치 카드/팝업 미표시 결함 수정 + 운행 시작 전 지연 라벨 게이팅 (`cac9f4b`→`eb1c2e7`/`main.ff93d91f.js`). ① **BIP 글로벌 stash 이중 소비자 결함**: `usePermissions`(PermissionGate "📲 홈 화면에 앱 추가" 카드)는 stash 회수 안 함 + `InstallPrompt`는 회수 후 null로 비움 → PermissionGate 카드 영구 미표시 + InstallPrompt 3일 스누즈 시 양쪽 다 비표시(과천라인 기사 보고). 수정: usePermissions에 stash 회수 + InstallPrompt가 비우지 않음(공유). PermissionGate 카드는 스누즈와 무관하게 살아있음 → 사용자 강제 진입 통로. ② **운행 시작 전 무의미 지연 라벨**: `!driving` 정류장 리스트에 "지연 866분" 등 — `(arrived || driving) && lab.label` 게이팅. 운행 전엔 "계획 HH:MM"만. ③ DIAG-INSTALL2 진단 박스 1회 사용 후 제거(STDLN:n BIP:y SW:ctrl iOS:n LS:dismissedAt 캡처로 결함 1 확정).
- [x] **2026-05-20** **승객앱(/p·/bus) UI 강화 3건 prod 배포** (`main.728aa7e6.js`, 프론트 단독·functions/rules 무관) — ① **지도 정류장 시각**: EmployeeApp/PassengerApp 지도 정류장 라벨에 `stopEstimates` 기반 시각 추가(arrived="도착 HH:MM" positive / next="예상 HH:MM" primary-deep / upcoming="HH:MM" mute / unplanned=미표시 폴백). 강조 라벨(출/도/내) 내부에서는 #fff 계열. ② **노선도 스트립 폰트 키움**: EmployeeApp 정류장 이름 9px→13px·fontWeight 500→700, 점 10/14/18→11/15/20, width 60→72, ellipsis nowrap·가로 스크롤 유지(`data-route-strip` 스크롤바 숨김). PassengerApp 정류장 카드 이름 14px→17px. ③ **버스 마커 펄스 강조**: 새 keyframes `buspulse`(tokens.css) — 지도 버스마커 외부 ring(2s 무한), 크기 키움(이모지 15→22px·vehicleNo 11→13px·padding 5/11→7/14·border 2→3px·shadow 0.28→0.45). EmployeeApp 노선도 스트립 버스 아이콘 16x16→24x24, 구간 버스 아이콘 10px→20x20 펄스. 정지(speed=0) 시에도 시인성. **격리**: 4파일 변경(EmployeeApp.js·PassengerApp.js·tokens.css·index.css). 카카오 SDK 컴포넌트 호출 개수 불변(`<Map>/<MapMarker>/<Polyline>/<CustomOverlayMap>`), props 시그니처·onClick·onSnapshot·routePath·stopArrivals 로직 100% 보존. DriverApp/AdminApp/Boarding/Partner 무영향. 신규 ESLint 경고 0. gzip +587B. curl `appkey=58bf34`+`main.728aa7e6.js`.
- [x] **2026-05-20** **배차 일정 자동 펼침 시스템 prod 배포** (`main.4d4a3650.js` + functions/rules) — 매일 수동 배차 등록 비효율 해소. 신규 컬렉션 `companies/{cid}/dispatchSchedules`(name·routeId·driverId·departTime·startDate·endDate·weekdays·excludeDates·excludeHolidays·active) + CF `expandDispatchSchedules`(onSchedule `30 0 * * *` KST `us-central1`, 향후 7일치 멱등 펼침) + `expandDispatchSchedulesNow`(onCall, AdminApp "지금 펼치기"). 한국 공휴일=정적 배열 2026~2028(`functions/holidays.js` + `src/lib/holidays.js` 클라 사본). AdminApp 신규 탭 "배차 일정"(인덱스 3, 기존 노선 관리 4로 밀림 + DashboardTab onNav(4)→(5) 정정). 멱등 ID `${scheduleId}_${day}` — 일별 수동 수정 보존. 자연흐름: 일정 변경 시 이미 펼친 미래 dispatch는 보존, 다음 새벽이 보충. Cloud Scheduler API 자동 활성. **사용자 검증 잔여**: 새 탭에서 일정 생성→"지금 펼치기"→Firestore Console `dispatches/{today}/list/{schedId}_{date}` 생성 확인 + 다음 새벽 자동 펼침 + `firebase functions:log --only expandDispatchSchedules`.
- [x] **2026-05-20** 정류장 진입시각 음수 자정 보정 버그 수정 (`main.bc5eccda.js`) — 1번 정류장(06:50) < 노선 departTime(06:55) → `-5분`이 자정 보정으로 `+1435분` 폭증(과천라인 실회귀). `offsetMinFromPlanTime` 자정 보정 폐기, 음수면 null 반환→저장 거부+명확한 알림. `openStopAdd`가 `stops.length===0` 시 `plannedTime`을 `route.departTime`으로 prefill(첫 정류장=0분 보장). 기존 잘못 저장된 데이터는 사용자가 정류장 시각=노선 출발시각으로 수정 또는 노선 departTime을 첫 정류장 시각으로 수정.
- [x] **2026-05-20** 정류장 진입시각 입력 UX — 오프셋(분) → **시각(HH:MM) 직접 입력**으로 변경 (`main.0a94e306.js`). AdminApp 정류장 폼: `type="time"` 입력칸 + 미리보기를 "→ 노선 출발 07:00 기준 +25분 후"로 반전(절대시각은 카드/승객앱에 이미 표시 중). 저장 시 `offsetMinFromPlanTime(departTime, plannedTime)` 헬퍼로 분 변환(자정 넘김 +24h 보정). 노선 `departTime` 미설정/형식오류 시 저장 거부. 편집 진입은 저장된 `offsetMin` → HH:MM 역변환 prefill. 스키마 무변경(`offsetMin`이 정본). 운영자가 시각표 형태로 직접 입력 가능.
- [x] **2026-05-20** 정류장 계획·예상시각 시스템 prod 배포 (`b122941`/`main.1cef341f.js` + `firestore.rules` 룰 동시 반영) — stops `offsetMin`(분) + `dispatches.stopArrivals` + `lib/stopSchedule.js`(공용 헬퍼). AdminApp 정류장 폼/카드에 오프셋 입력·계획시각 표시, EmployeeApp(/p) 홈 myStop 패널 + 노선 모달 정류장 목록 시간 표시, PassengerApp(/bus) 정류장 리스트 계획·예상·지연, DriverApp 히어로 다음정류장 배너 + 정류장 리스트 계획·도착·지연 라벨. 도착감지 시 dispatch `stopArrivals.{stopId}` 멱등 기록(기사). Firestore 규칙: dispatches update를 driver 본인+stopArrivals 필드 한정 update 허용으로 좁힘. 기존 데이터(offsetMin 미설정) 무파괴(calcETA/노선순서 폴백). curl 검증: 라이브 `appkey=58bf34`+`main.1cef341f.js` 200. 사용자 검증: 노선에 offsetMin 입력 후 GPS 100m 진입으로 `stopArrivals.{stopId}` 생성·DriverApp/Employee/Passenger 라벨 반영 + AdminApp 배차 CRUD 회귀 확인 잔여.

## 저장소 메모
- `src.zip` git 추적되나 작업트리 삭제 상태(소스 백업, 빌드 미사용).
