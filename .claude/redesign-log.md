# 리디자인 적용 — 완료 단계 아카이브 (0~4단계)

> `.claude/redesign.md` 50줄 cap 도달로 분리(2026-05-16, 6단계 작업 시).
> 완료·배포된 0~4단계 상세 보존용. 현재 진행/요약/인덱스는 `redesign.md`.
> 라이트 테마 전면 리스킨. 목업 정본 `design/src/`(읽기전용).

## 결정 이력
**확정**: 전 화면 라이트 테마 전면. 목업 1:1 4화면 + 디자인 토큰. **결정 변경(2026-05-16, 사용자 요청)**: AdminApp이 실시간관제 탭만 라이트라 상품성 저하 → 4화면→AdminApp 전체 라이트 통일로 확장(4단계). 공유 S는 1~3단계엔 동결, 4단계에서 토큰 기반 일괄 라이트 전환(전 탭 동시 전파).

## 완료 단계 상세
- [x] **0단계 — 기반 구축** (2026-05-16, 배포 안 함, 기존 화면 픽셀 변화 0)
  - 토큰: `src/styles/tokens.css`(`design/src/tokens.css` 1:1, CSS 변수 전부 보존), `src/index.js`에서 import
  - 폰트: **Pretendard self-host** = npm `pretendard@1.3.9`, `pretendard/dist/web/variable/pretendardvariable.css` import. 빌드 시 woff2 self-host(CDN 의존 0). `tokens.css`의 `html,body{font-family:var(--font-base)}`가 전역 폴백(`index.css`보다 뒤 import 순서로 우선)
  - UI 라이브러리: `src/components/ui/`(`BusLinkLogo/Pill/StatusDot/Btn/Avatar/Icon` + `tokens.js` JS 미러 + `index.js` 배럴). ESM, 순수 프레젠테이션. **0단계는 기존 페이지 미채택**
- [x] **1단계 — LoginApp 리스킨** (2026-05-16, 배포 안 함)
  - `src/pages/LoginApp.js` 라이트 split 2단(좌 480px 다크 그라데이션 브랜드 패널 + 우 라이트 폼 카드 max 380px). 목업 `design/src/screens-login.jsx` LoginAdmin 시각 언어만 차용
  - **로직 100% 불변**: state(empNo/pin/error/loading)·`handleLogin`·합성이메일 `${empNo}@buslink.com`·`signInWithEmailAndPassword`·Enter 제출·App.js `onAuthStateChanged` 분기 그대로. 마크업/`S` 객체만 교체. 미사용 import(`db`/firestore 7종)도 보존(빌드 경고는 기존 것, 신규 0)
  - 0단계 산출물 활용: `BusLinkLogo/Pill/StatusDot/Btn` 채택. `Btn.js` props 확장(`onClick/type/disabled/title` + disabled 시 opacity/cursor, 상단 주석 갱신). `blpulse` keyframes `tokens.css` 전역 추가(StatusDot pulse용)
  - 모바일 반응형: `index.css` `@media(max-width:767px)`에 `[data-login-brand]{display:none}` `[data-login-mobile-logo]{display:block}` — split→단일 컬럼 폴백(목업 LoginMobile 참조)
  - **의도적 제외**(로직 없는 장식): 역할 토글 RoleButton, 한/영 토글, 로그인 상태 유지 체크박스, 비밀번호 찾기 링크, 맵 실루엣(MapMock — 3단계 금지 대상). 좌 패널 Stat은 과장 수치 대신 정직한 브랜딩 문구("실시간/GPS/웹")
  - 변경 격리: `LoginApp.js`·`Btn.js`·`tokens.css`·`index.css`만. `App.js`·타 `src/pages/*` 무변경
- [x] **2단계 — DriverApp / PassengerApp 리스킨** (2026-05-16, 배포 안 함)
  - `DriverApp.js`: 헤더(BusLinkLogo sub="기사")→인사(오늘 날짜)→#0066FF→#003DCC 그라데이션 히어로 배차카드(운행 중일 때만 실제 currentStopIdx 기반 다음정류장 진행바)→MiniStat 3(상태/GPS/화면)→운행시작 primary→탭(운행/탑승 QR)→정류장 리스트→하단 fixed 검정 "운행 중 — 종료"(driving 시만). 로딩/에러도 라이트
  - `PassengerApp.js`: 풀스크린 카카오맵 + 부유 상단 상태바 카드 + 부유 ETA 카드(`calcETA` 출력에 56px 카운트다운 시각만)+ 정류장 진행바(실 myStopIdx)+ 하단 시트. 카카오 Map/Marker/Polyline/CustomOverlay 구조·마커이미지 URL 불변, 오버레이/마커 div 스타일만 라이트
  - **로직 100% 불변(HEAD diff 검증)**: DriverApp `startGPS/stopGPS/clearGPS/createBoardingToken/getBoardingUrl/QRCode.toDataURL/setInterval 5분/wakeLock/Notification/signOut/updateDoc/getDocs` 호출수 HEAD=현재. PassengerApp `signInAnonymously/useAnimatedPositions/onSnapshot/calcETA×2/getDoc×2/getDocs/Map/Polyline/MapMarker/CustomOverlayMap×2/getParam` 호출수 HEAD=현재
  - 0단계 산출물 활용: `BusLinkLogo/Pill/StatusDot/Icon` 채택(Btn은 두 페이지 미사용). `StatusDot pulse`는 `blpulse` 전역(1단계분) 재사용
  - **의도적 제외**: 목업 가짜 수치(속도 42·GPS ±4m·탑승 38/45 등), QR/전화 부유버튼, "다른 일정/퇴근편" 카드, MapMock/BusMarker SVG(카카오 유지), 알림 벨/Avatar 헤더 장식. `nextStopDist`/`boardingToken` 미사용 경고는 원본부터 존재(신규 0)
  - 변경 격리: `DriverApp.js`·`PassengerApp.js`만. `App.js` diff 0줄, EmployeeApp/PartnerApp diff 0줄
- [x] **3단계 — AdminApp 실시간관제 탭(MapTab) 리스킨** (2026-05-16, 배포 안 함, MapMock 미도입·카카오맵 유지)
  - 범위 = `AdminApp.js`의 `MapTab`(탭1) 단독. 나머지 9탭·전역 레이아웃 시각 무변경
  - 격리 전략: 공유 `S` 키는 직접 수정 금지 → MapTab 전용 `MS` 객체 신설, MapTab 마크업만 `MS` 참조. 기존 `S` 무손상
  - 시각: 맵 퍼스트(카카오 `<Map>` absolute 풀필) + 부유 글래스 탑바 + 좌 차량 레일 + 우 차량상세. tokens.css 변수·#0066FF 라이트
  - **보존 로직 HEAD=현재(diff 검증)**: `useAnimatedPositions/onSnapshot/setRawVehicles/setCenter/setSelected/setInterval/<Map/<MapMarker/<Polyline/<CustomOverlayMap/httpsCallable/sendGPS/isMobile` 전부 불변
  - **생략한 미구현 패널**: KPI 카드열·노선 필터 레일·우 패널 ETA/탑승인원/타임라인·하단 히트바·줌 컨트롤·검색바/알림벨/아바타(데이터 소스 없음·허위수치 금지). 실 바인딩만
  - 변경 격리: `AdminApp.js` 단독(import 2줄 + MapTab 헝크 + `MS` 객체). 신규 빌드 경고 0
- [x] **4단계 — AdminApp 전체 라이트 통일** (2026-05-16, 배포 완료, 결정 확장분)
  - 범위 = `AdminApp.js` 전 영역(전역 셸 + 9탭). MapTab(탭1)은 3단계 라이트 유지·토큰 정합 확인
  - 핵심: 공유 `S` 38키 전부 tokens.css 변수 라이트로 일괄 전환(키 이름·구조 100% 보존, 전 탭 동시 전파) + 마크업 인라인 다크 하드코딩 전면 토큰화. `'Noto Sans KR'`→`var(--font-base)`. `MS`(MapTab)는 무손상
  - 사이드바 로고 → `BusLinkLogo`. 셸/9탭 토큰화: 사이드바·헤더·모바일메뉴·뱃지·토글·정류장패널·지도피커모달·노선모달·결과메시지 전부 라이트. linear-gradient 버튼→primary 솔리드
  - **보존 로직 HEAD=NOW(정밀 카운트)**: onSnapshot16·httpsCallable5·sendGPS1·sendNotice1·createPartnerCode2·useAnimatedPositions2·isMobile4·signOut2·addDoc4·updateDoc9·deleteDoc5·setDoc1·getDocs1·<Map3·<MapMarker7·<Polyline1·<CustomOverlayMap1. 카카오 Polyline strokeColor는 SDK prop이라 토큰값 직접(`#0066FF`)
  - 변경 격리: `AdminApp.js` 단독. 신규 ESLint 경고 0(6종 HEAD 원본부터). 직전 QA `M`분(NoticeTab 문구 1줄) 미수정 보존
- [x] **배포** 1·2·3·4단계 + 직전 QA안정화 → `firebase deploy --only hosting` **buslink-prod 라이브**(2026-05-16, `main.28978312.js`). functions/rules/indexes 무관(프론트 전용)
