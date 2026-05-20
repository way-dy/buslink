# Tasks

> 작업 시작/완료 시 이 파일만 수정. 체크박스 관리. 어느 PC든 이어작업용.

## 현재 상태 (2026-05-20 세션 종료)
> 이 저장소가 작업 정본. **어느 PC든** `git pull` + `.env.local`(↓부트스트랩)이면 빌드·배포 가능.
> prod 라이브 = `main.4d4a3650.js` (배차 일정 자동 펼침 + onSchedule cron + 한국 공휴일 정적).

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
- [x] **2026-05-20** **배차 일정 자동 펼침 시스템 prod 배포** (`main.4d4a3650.js` + functions/rules) — 매일 수동 배차 등록 비효율 해소. 신규 컬렉션 `companies/{cid}/dispatchSchedules`(name·routeId·driverId·departTime·startDate·endDate·weekdays·excludeDates·excludeHolidays·active) + CF `expandDispatchSchedules`(onSchedule `30 0 * * *` KST `us-central1`, 향후 7일치 멱등 펼침) + `expandDispatchSchedulesNow`(onCall, AdminApp "지금 펼치기"). 한국 공휴일=정적 배열 2026~2028(`functions/holidays.js` + `src/lib/holidays.js` 클라 사본). AdminApp 신규 탭 "배차 일정"(인덱스 3, 기존 노선 관리 4로 밀림 + DashboardTab onNav(4)→(5) 정정). 멱등 ID `${scheduleId}_${day}` — 일별 수동 수정 보존. 자연흐름: 일정 변경 시 이미 펼친 미래 dispatch는 보존, 다음 새벽이 보충. Cloud Scheduler API 자동 활성. **사용자 검증 잔여**: 새 탭에서 일정 생성→"지금 펼치기"→Firestore Console `dispatches/{today}/list/{schedId}_{date}` 생성 확인 + 다음 새벽 자동 펼침 + `firebase functions:log --only expandDispatchSchedules`.
- [x] **2026-05-20** 정류장 진입시각 음수 자정 보정 버그 수정 (`main.bc5eccda.js`) — 1번 정류장(06:50) < 노선 departTime(06:55) → `-5분`이 자정 보정으로 `+1435분` 폭증(과천라인 실회귀). `offsetMinFromPlanTime` 자정 보정 폐기, 음수면 null 반환→저장 거부+명확한 알림. `openStopAdd`가 `stops.length===0` 시 `plannedTime`을 `route.departTime`으로 prefill(첫 정류장=0분 보장). 기존 잘못 저장된 데이터는 사용자가 정류장 시각=노선 출발시각으로 수정 또는 노선 departTime을 첫 정류장 시각으로 수정.
- [x] **2026-05-20** 정류장 진입시각 입력 UX — 오프셋(분) → **시각(HH:MM) 직접 입력**으로 변경 (`main.0a94e306.js`). AdminApp 정류장 폼: `type="time"` 입력칸 + 미리보기를 "→ 노선 출발 07:00 기준 +25분 후"로 반전(절대시각은 카드/승객앱에 이미 표시 중). 저장 시 `offsetMinFromPlanTime(departTime, plannedTime)` 헬퍼로 분 변환(자정 넘김 +24h 보정). 노선 `departTime` 미설정/형식오류 시 저장 거부. 편집 진입은 저장된 `offsetMin` → HH:MM 역변환 prefill. 스키마 무변경(`offsetMin`이 정본). 운영자가 시각표 형태로 직접 입력 가능.
- [x] **2026-05-20** 정류장 계획·예상시각 시스템 prod 배포 (`b122941`/`main.1cef341f.js` + `firestore.rules` 룰 동시 반영) — stops `offsetMin`(분) + `dispatches.stopArrivals` + `lib/stopSchedule.js`(공용 헬퍼). AdminApp 정류장 폼/카드에 오프셋 입력·계획시각 표시, EmployeeApp(/p) 홈 myStop 패널 + 노선 모달 정류장 목록 시간 표시, PassengerApp(/bus) 정류장 리스트 계획·예상·지연, DriverApp 히어로 다음정류장 배너 + 정류장 리스트 계획·도착·지연 라벨. 도착감지 시 dispatch `stopArrivals.{stopId}` 멱등 기록(기사). Firestore 규칙: dispatches update를 driver 본인+stopArrivals 필드 한정 update 허용으로 좁힘. 기존 데이터(offsetMin 미설정) 무파괴(calcETA/노선순서 폴백). curl 검증: 라이브 `appkey=58bf34`+`main.1cef341f.js` 200. 사용자 검증: 노선에 offsetMin 입력 후 GPS 100m 진입으로 `stopArrivals.{stopId}` 생성·DriverApp/Employee/Passenger 라벨 반영 + AdminApp 배차 CRUD 회귀 확인 잔여.

## 저장소 메모
- `src.zip` git 추적되나 작업트리 삭제 상태(소스 백업, 빌드 미사용).
