# 리디자인 적용 (2026-05-16~)

> 라이트 테마 전면 리스킨 진행 기록. **완료된 0~4단계 상세 + 결정 이력은 분리: @.claude/redesign-log.md** (50줄 규칙, 6단계 작업 시 분리).
> 이 파일은 요약·인덱스 + 현재 진행 단계만 유지. 작업 시작/완료 시 갱신.

## 요약
- 기반(0단계): `src/styles/tokens.css`(CSS 변수 정본)·Pretendard self-host·`src/components/ui/`(`BusLinkLogo/Pill/StatusDot/Btn/Avatar/Icon`)·`blpulse` 전역.
- 색상 매핑(전 단계 공통): 다크(#0B1A2E/#112240/#1E3A5F/#00C2FF/#1A6BFF/#8896AA/#4A6FA5/#F0F4FF/#FF4D6A/#00C48C/#FF8C42/#FFD166) → tokens.css 변수 라이트. `'Noto Sans KR'`→`var(--font-base)`. 카카오 `<Polyline strokeColor>`는 SDK prop이라 토큰값 직접 `#0066FF`.
- 원칙: 시각만 교체, 로직 100% 보존(HEAD=NOW 호출수 diff 검증), 가짜수치·미구현 패널 미도입, 카카오맵 구조 유지(MapMock/BusMarker SVG 금지), 변경 화면 단독 격리.

## 단계 인덱스 (상세는 redesign-log.md)
- [x] 0단계 — 기반 구축 (배포 안 함, 픽셀 변화 0)
- [x] 1단계 — LoginApp 라이트 split 리스킨 (배포 완료)
- [x] 2단계 — DriverApp / PassengerApp 라이트 리스킨 (배포 완료)
- [x] 3단계 — AdminApp 실시간관제 탭(MapTab) 라이트 (배포 완료)
- [x] 4단계 — AdminApp 전체 라이트 통일 (배포 완료, 결정 확장분)
- [x] **배포** 1·2·3·4단계 + QA안정화 → buslink-prod 라이브 (2026-05-16, `main.28978312.js`)
- [x] 7단계 — PartnerApp(`/partner`) 라이트 리스킨 (2026-05-26, `main.371e3b15.js` 배포 완료, 누락 마지막 화면 통일). `BusLinkLogo+Pill` 채택, tokens.css 전면 적용, AdminApp 모달/통계 카드 패턴 차용, 로직 100% 보존(import HEAD=NOW, STEPS/REG_MODES/mainTab 분기 동일, hashPin dynamic import 유지). 상세 @.claude/tasks.md.

## 현재 진행 단계
- [x] **5단계 — 사이드바 메뉴 세련화** (2026-05-16, 사용자 지적: 메뉴바가 타 섹션 대비 덜 세련) — **배포 완료**(buslink-prod, `main.7e4fa34f.js`)
  - TABS 이모지 제거 + `TAB_ICONS`(grid/pin/flag/route/user/bus/play/clock/globe/bell) 디자인시스템 `Icon` 채택. 활성 항목 좌측 액센트 바(`S.navAccent`), 간격/타이포 정돈, 회사ID에 `StatusDot`. 호버: `index.css` `[data-nav-item]:hover`·`[data-logout]:hover`(기존 data-* 패턴 일관)
  - 모바일: 헤더 라벨 `.replace(/^\S+\s/,"")` 제거(이모지 없어져 두 단어 라벨 잘림 방지)+아이콘, 드롭다운 아이콘 추가
  - 로직 불변(`setTab/signOut/menuOpen`, TABS 10개 순서·인덱스 동일, `TAB_ICONS` 병렬 배열). 격리: `AdminApp.js`+`index.css`. 빌드 통과·신규 경고 0
- [x] **5단계 배포** — buslink-prod 라이브 (2026-05-16, `main.7e4fa34f.js` — 0~5단계+QA 누적 반영). ※ 라이브 반영됨 / git 미커밋(세션 누적)
- [x] **6단계 — EmployeeApp 라이트 리스킨** (2026-05-16, 배포 안 함, `/p` 직원앱 — 다크 잔존 제거·전면 라이트)
  - 범위 = `src/pages/EmployeeApp.js` 단독(로그인 + 홈/노선/탑승/설정 4탭 + 공지배너 + 바텀시트). 목업 1:1 없음 → 2단계 DriverApp/PassengerApp 모바일 시각 언어 준용(흰 배경·#0066FF·토큰 radius/shadow·Pretendard·큰 터치 타깃)
  - `S` 객체 13키 전부 tokens.css 변수 라이트(키 구조 보존, `logo/logoText/logoSub` 3키 제거 → 로그인 화면 `BusLinkLogo` 채택). 마크업 인라인 다크 하드코딩 전면 토큰화. import 1줄 추가(`BusLinkLogo, StatusDot` from `../components/ui`, 둘 다 실사용 → 미사용 경고 0). 헤더 운행상태에 `StatusDot pulse`(blpulse 전역 재사용)
  - 카카오 오버레이/마커 div 스타일만 라이트(PassengerApp 패턴 준용: 흰 배경+primary 보더). **마커 이미지 URL·`<Map>/<MapMarker>/<Polyline>/<CustomOverlayMap>` 구조·position·onClick 전부 불변**. `<Polyline strokeColor>` `#1A6BFF`→`#0066FF`(토큰값, SDK prop)
  - **의도적 검정 유지**: ScanTab 카메라 뷰파인더 video 컨테이너 `#000` + QR 영역 외 마스킹 `rgba(0,0,0,.6)`×4 — 라이트로 바꾸면 카메라 영상 위 QR 인식 가이드가 안 보임(시각=기능 본질, 2단계 원칙 일관)
  - **보존 로직 HEAD=NOW(34항목 정밀 카운트, DIFF 0)**: signInAnonymously2·hashPin4·localStorage5·onSnapshot5·jsQR3·getDoc8·getDocs5·updateDoc3·calcETA2·validateAndBoard2·initNotifications2·listenForegroundMessages2·`<Map`2·`<MapMarker`2·`<Polyline`2·`<CustomOverlayMap`5·getUserMedia1·requestAnimationFrame3·useAnimatedPositions3·setStep9·getParam2·save/load/clearSession·PIN변경·toggleFavorite·boardingTokens·pinHash/pinInitial 전부 불변. 사번+PIN 인증·SHA-256 salt·localStorage `buslink_employee`·App.js `/p` 분기 무손상
  - 변경 격리: **`EmployeeApp.js` 단독**(+162 −166). `App.js`·`components/ui`·`tokens.css`·`index.css` diff 0줄(Employee는 100dvh 풀스크린 단일컬럼이라 반응형 추가 불요). AdminApp/Driver/Passenger/Login/Boarding `M`은 1~5단계+QA 누적분(본작업 미수정·구분). 신규 ESLint 경고 0(`showBusBetween` 경고는 HEAD 원본부터, 줄번호 −1은 import/S 압축 영향)
- [x] **6단계 배포** — buslink-prod 라이브 (2026-05-16, `main.cff2f55c.js` — 0~6단계+QA 누적 반영). 프론트 전용, functions/rules/indexes 무관. ※ 라이브 반영 / git 미커밋(세션 누적)
