# Tasks

> 작업 시작/완료 시 이 파일만 수정. 체크박스 관리. 어느 PC든 이어작업용.

## 현재 상태 (2026-05-27 세션 종료)
> 이 저장소가 작업 정본. **어느 PC든** `git pull` + `.env.local`(↓부트스트랩)이면 빌드·배포 가능.
> prod 라이브 = `main.3c4d91c8.js` (코드 변경 없음). 2026-05-27 변천: 신규 별건 도구 `docs/manual-ppt/`(PPT 매뉴얼 3종, prod 캡처 일부 반영). prod 콘솔 권한 오류 1건 발견(EmployeeApp 내 정류장 복원, issues.md `[미해결]`).

### git 원격
- `origin/master` = 작업 정본. 3월 폐갈래는 `origin/archive/remote-march-2026`(`f63321c`) 영구 백업.

### 새 PC 부트스트랩 (이어작업 1회)
- `git pull` → `npm install` (functions 쓰면 `cd functions && npm install`).
- `.env.local` 생성: `.env.example` 참고, 값은 사용자 보유분. ⚠ `REACT_APP_KAKAO_MAP_KEY`=운영 공유키 `58bf34…`(`d464b4…`면 prod 지도 사망).

### 배포 절차
1. 앵커 grep: `grep -nE '^REACT_APP_KAKAO_MAP_KEY=' .env.local` → `58bf34` 시작 확인.
2. `CI=false npm run build` → `npm start` → localhost `/p`·`/bus` 지도·노선 그리기 확인.
3. `firebase deploy --only hosting` (rules 변경 시 `--only firestore:rules,hosting`) → curl 검증.
4. 회귀 시 가설-재배포 금지 → 콘솔 Hosting 롤백 먼저, 재현은 localhost.

## 다음 할 일
- [ ] **EmployeeApp 내 정류장 복원 권한 오류 진단**(prod 콘솔 발견 2026-05-27) — fcmTokens/{empNo} 또는 routes/{id}/stops 읽기 권한 확인. 비치명적이나 사용자 정류장 자동 복원 실패. issues.md `[미해결]` 참조.
- [ ] (선택) PPT 매뉴얼 06-notices·기사 03/04·승객 02/03 본인 폰 캡처해 `docs/manual-ppt/assets/<role>/`로 두고 `npm run all` 1회 — 매뉴얼 캡처 완전성.
- [ ] (선택) 운영 노선에 `routePath` 실제 그리기 — 안 그린 노선은 stops 직선 폴백(정상).
- [ ] (선택) gpsHistory TTL 정책 검토 — Firebase 콘솔에서 ts 필드 기준 90일 자동 삭제(저장 비용 작아도 운영 정리 측면).

## 백로그 / 검토 후보
- [ ] 📣 카카오 알림톡/SMS 병행 발송 — callcenter SENS 계정 재사용. 템플릿 심사 + Secret Manager 후 진행.
- [ ] 🗓 한국 공휴일 정적 갱신 — `functions/holidays.js` + `src/lib/holidays.js` 2028년 말 전 2029~ 추가.
- [ ] `src/firestore.rules` ↔ 루트 일원화(src 사본 삭제 검토).
- [ ] `firebase-messaging-sw.js` 설정 env 주입(현재 하드코딩).
- [ ] 🔑 카카오 비즈앱 심사 통과 후 전용키 `d464b4` 복구.
- [ ] ⏳ Node 20→22 (데드라인 2026-10-30 decommission).
- [ ] PassengerApp `ARRIVING_M` 미사용 — 완결성 다듬기.

## 기획 갭 (PLANNING.md 2026-05-16, MVP 1단계 전부 동작)
- [ ] ⭐ #12 고객사 담당자 운영 포털 — 자사 실시간 버스·탑승·공지수신 (SaaS 최우선)
- [ ] #9 분석 / #8 운행일지 / #11 푸시 타게팅 / #4 노선 보강(요일·엑셀) / #14-C 정류장 엑셀 / #15 PIN 강제변경
- [ ] (보류·SaaS) #17 슈퍼관리자·빌링 / #16 멀티테넌트(dy001 하드코딩) / #15 SMS. (폐기) #10 예약관리

## 사용자 검증 잔여 (2026-05-26 누적)
- [ ] **QR 탑승 통계 전체 흐름**: DriverApp QR 발급 → 모바일 스캔 → 사번 → "탑승 완료" → AdminApp 탑승 통계 + 협력사 포털 탑승 통계 양쪽 즉시 반영 → 정류장별 GPS 매핑(근접 거리 100m 이내 정상)
- [ ] **도착예정 알고리즘 4건**: ① 기사앱 unplanned 정류장도 "예상·지연" 표시 ② 도착지·전 정류장 distinct 시각(60초 이상) ③ 근접 정류장 ETA 1분 이상 차이 ④ 터널 ETA 점프 1/2 축소
- [ ] **실시간 관제 노선도 뷰**: 토글·정류장 타임라인·버스 위치 마커 / 일자별 picker 정상
- [ ] **운행 이력 노선별 그룹**: 배차 클릭 시 GPS 자동 로드·시간범위 필터 안내 라인
- [ ] **협력사 삭제·기사 삭제 팝업**: 비활성만 삭제 허용·직원수 confirm·성공 alert

## 완료 (최근·시간역순. 옛 누적은 @.claude/tasks-log.md)
- [x] **2026-05-27** 관제 AdminApp PWA 설치 안내(`main.<재배포>.js`) — `<InstallPrompt/>` 마운트 + `applyAppManifest({manifestHref:"/manifest.json", appleTouchHref:"/icons/admin-1024.png", title:"BusLink 관제"})` 호출. PC Chrome 자동 바텀시트·주소창 설치 아이콘 활성화. 모바일 관제 시 직원앱 `/p`와 scope `/` 중첩 잠재 충돌(issues.md). manifest.json은 이미 admin 아이콘 정본. issues.md `[패턴]` 등록.
- [x] **2026-05-27** 강제 공지 모달(`NoticeForceModal`, `main.00a13b12.js`) — PWA 푸시 OS 누락 대비 도달성 보장. EmployeeApp 마운트 시 `unreadCount > 0`이면 가장 최신 안 읽음 공지 풀스크린 자동 노출. 일반=즉시 닫기·긴급(type=emergency)=5초 카운트다운+진동. `notices`/`noticeReadAt`/`markNoticesRead` 인프라 재사용·신규 Firestore 구조 0. 사용자 "안 본 공지 못 지나가게" 명시 결정. issues.md `[패턴]` 등록.
- [x] **2026-05-27** 알림 아이콘 결함 fix(`main.7c7dff9b.js` + functions 재배포) — `public/logo192.png`가 CRA 기본 React 로고였음. `public/icons/notification-employee.png`(passenger-1024.png 사본) 신설 + CF `sendNoticeToCompany`·`buildPreArrivalMessage` `webpush.notification.icon`+`badge` 교체 + SW `firebase-messaging-sw.js` `showNotification` 교체 + `manifest-employee.json icons`에 192~512 사이즈 등록. 부수 발견: 안드로이드 알림 발신자 "Chrome <URL>" 형태 = WebAPK 미설치 진단 단서. issues.md `[패턴]` 등록.
- [x] **2026-05-27** ETA 산출 chain 우선 정책 전환(`src/lib/stopSchedule.js`, 빌드 `main.7c7dff9b.js` 미배포) — `computeStopEstimates` 후보 결합 max→chain 우선. upcoming: chainCandidate 채택·없으면 plan+delay fallback. next: chain·gps 0.7:0.3 가중. 출발 지연 시 누적지연이 모든 미래 정류장에 carry되던 결함 차단(사용자 의도=actual 기반 재추정). 단조증가/과거금지 보호장치·source enum 4종 호환·출력 계약 불변. 다운스트림 무영향. issues.md `[패턴]` 등록. 사용자 localhost 검증 후 `firebase deploy --only hosting`.
- [x] **2026-05-27** PPT 매뉴얼 3종 신설(`docs/manual-ppt/`) — callcenter 정본 복제, 관리자(15장)·기사(12장)·승객(14장). 관리자 10장 자동 캡처 성공, 모바일 2종은 일부 placeholder. 캡처 자동화 4단 트랩(텍스트→viewport→span→locator) 후 06-notices만 실패 → placeholder + 본인 폰 폴백. 자동화 교훈은 `.claude/agents/refs/manual-playbook.md` §PPT 보강. prod 코드/규칙 무변경. **별건 발견**: prod EmployeeApp `[내 정류장 복원 실패] Missing or insufficient permissions`(issues.md `[미해결]`).
- [x] **2026-05-26** BoardingApp 익명 인증 hotfix(`main.3c4d91c8.js`) — QR 탑승이 통계 안 잡힌 결함. `signInAnonymously` 마운트 호출 추가(EmployeeApp 패턴 일관). 이전 QR 탑승은 복구 불가(토큰 만료). issues.md `[해결]`.
- [x] **2026-05-26** 탑승 통계 — GPS 기반 정류장별 정밀 집계(`main.75f79871.js`) — 신규 `lib/stopMapping.js`(haversine 매핑·반경 300m), boarding.js 차량 GPS 캡처, AdminApp/PartnerApp 정류장별 패널.
- [x] **2026-05-26** QR 탑승 통계 — AdminApp 신규 탭 + PartnerApp 일자별 누적(`main.44de1aa0.js`) — boarding.js partnerCode denormalize·BoardingStatsTab(탭 9)·BoardingStatsMode(메인탭3)·PartnerApp 익명 인증·rules boardings read = isAuth().
- [x] **2026-05-26** 운행이력 — 배차별 GPS 시간범위 필터(`main.797cd3d4.js`) — `dispatchTimeRange(d, all)` 헬퍼, 같은 차량 여러 배차 시 GPS 동일 표시 결함 차단.
- [x] **2026-05-26** `Map` shadow hotfix + 실시간 관제 일자별 조회(`main.c2b238ce.js`) — HistoryTab `new window.Map()` 가드, 날짜 picker + 자동 노선도 전환 + 과거 데이터 배너.
- [x] **2026-05-26** AdminApp 실시간 관제 노선도 뷰 + 운행이력 노선별 그룹화(`main.60c54a0d.js`) — MapTab 지도/노선도 토글·RouteTimelineCard·dispatchGroups·차량 직접선택 보조.
- [x] **2026-05-26** 도착예정·지연 표시 4건 일괄 수정(`main.b5108380.js`) — MIN_STOP_GAP_SEC=60·DWELL_SEC=30·unplanned chain 전파+prevDelaySec carry·GPS 가중 0.85:0.15.
- [x] **2026-05-26** PartnerApp 라이트 리스킨 7단계(`main.371e3b15.js`) — tokens.css 전면 적용·BusLinkLogo+Pill 채택·로직 100% 보존.
- [x] **2026-05-26** 협력사 영구 삭제 + 기사 삭제 성공 팝업(`main.346b6b07.js` + rules) — 비활성만 삭제 허용·직원수 confirm·`partnerCodes.delete = isAdmin(resource.data.companyId)`.
> 그 이전 완료는 @.claude/tasks-log.md.

## 저장소 메모
- `src.zip` git 추적되나 작업트리 삭제 상태(소스 백업, 빌드 미사용).
