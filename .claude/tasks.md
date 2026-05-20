# Tasks

> 작업 시작/완료 시 이 파일만 수정. 체크박스 관리. 어느 PC든 이어작업용.

## 현재 상태 (2026-05-20 세션 종료)
> 이 저장소가 작업 정본. **어느 PC든** `git pull` + `.env.local`(↓부트스트랩)이면 빌드·배포 가능.
> prod 라이브 = `main.f0dd8be3.js` (master HEAD `90e6a95`, 설치팝업 스누즈 3일 + 다중배차 모달 + 노선 그리기 편집 UX).

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
- [x] **2026-05-20** 정류장 진입시각 음수 자정 보정 버그 수정 (`main.bc5eccda.js`) — 1번 정류장(06:50) < 노선 departTime(06:55) → `-5분`이 자정 보정으로 `+1435분` 폭증(과천라인 실회귀). `offsetMinFromPlanTime` 자정 보정 폐기, 음수면 null 반환→저장 거부+명확한 알림. `openStopAdd`가 `stops.length===0` 시 `plannedTime`을 `route.departTime`으로 prefill(첫 정류장=0분 보장). 기존 잘못 저장된 데이터는 사용자가 정류장 시각=노선 출발시각으로 수정 또는 노선 departTime을 첫 정류장 시각으로 수정.
- [x] **2026-05-20** 정류장 진입시각 입력 UX — 오프셋(분) → **시각(HH:MM) 직접 입력**으로 변경 (`main.0a94e306.js`). AdminApp 정류장 폼: `type="time"` 입력칸 + 미리보기를 "→ 노선 출발 07:00 기준 +25분 후"로 반전(절대시각은 카드/승객앱에 이미 표시 중). 저장 시 `offsetMinFromPlanTime(departTime, plannedTime)` 헬퍼로 분 변환(자정 넘김 +24h 보정). 노선 `departTime` 미설정/형식오류 시 저장 거부. 편집 진입은 저장된 `offsetMin` → HH:MM 역변환 prefill. 스키마 무변경(`offsetMin`이 정본). 운영자가 시각표 형태로 직접 입력 가능.
- [x] **2026-05-20** 정류장 계획·예상시각 시스템 prod 배포 (`b122941`/`main.1cef341f.js` + `firestore.rules` 룰 동시 반영) — stops `offsetMin`(분) + `dispatches.stopArrivals` + `lib/stopSchedule.js`(공용 헬퍼). AdminApp 정류장 폼/카드에 오프셋 입력·계획시각 표시, EmployeeApp(/p) 홈 myStop 패널 + 노선 모달 정류장 목록 시간 표시, PassengerApp(/bus) 정류장 리스트 계획·예상·지연, DriverApp 히어로 다음정류장 배너 + 정류장 리스트 계획·도착·지연 라벨. 도착감지 시 dispatch `stopArrivals.{stopId}` 멱등 기록(기사). Firestore 규칙: dispatches update를 driver 본인+stopArrivals 필드 한정 update 허용으로 좁힘. 기존 데이터(offsetMin 미설정) 무파괴(calcETA/노선순서 폴백). curl 검증: 라이브 `appkey=58bf34`+`main.1cef341f.js` 200. 사용자 검증: 노선에 offsetMin 입력 후 GPS 100m 진입으로 `stopArrivals.{stopId}` 생성·DriverApp/Employee/Passenger 라벨 반영 + AdminApp 배차 CRUD 회귀 확인 잔여.
- [x] **2026-05-20** 설치팝업 스누즈 14→3일 단축 + DIAG-INSTALL 제거 (`da24224`/`main.f0dd8be3.js`) — 사용자 LS `dismissedAt` 14일 차단 확정·종결.
- [x] **2026-05-20** 기사앱 배차 선택 칩→모달(EmployeeApp 패턴) + DIAG-INSTALL 임시진단 (`e690b41`/`main.cb747e1c.js`).
- [x] **2026-05-20** 기사앱 설치 BIP 글로벌 stash + 다중 배차(`dispatches[]`·`activeDispatchId`·LS 영속) (`ac6fbf3`/`main.6c626f25.js`).
- [x] **2026-05-20** 노선 그리기 편집 UX — 중간 삽입(⊕)·앞에 추가·선택 삭제·3색 핀·번호 라벨 (`1849cce`/`main.7d89705e.js`).
- [x] **2026-05-20** main→master 머지 + prod 재배포 (`d06bb7f`/`main.dc99419e.js`) — 노선 그리기 회귀 복구. origin/main 4커밋 통합(`5fa0737`/`c970c07` 등). 흰화면 보강: autoload=false + onCreate 더블 relayout 공존.

## 저장소 메모
- `src.zip` git 추적되나 작업트리 삭제 상태(소스 백업, 빌드 미사용).
