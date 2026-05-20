# Tasks

> 작업 시작/완료 시 이 파일만 수정. 체크박스 관리. 어느 PC든 이어작업용.

## 현재 상태 (2026-05-20 기사앱 배차 모달 + DIAG-INSTALL 진단 배포 완료)
> 이 저장소가 작업 정본. **어느 PC든** `git pull` + `.env.local`(↓부트스트랩)이면 빌드·배포 가능.
> prod 라이브 = `main.cb747e1c.js`(master HEAD `e690b41`, 기사앱 배차 선택 모달 + InstallPrompt DIAG-INSTALL 임시 진단).

### git 원격
- `origin/master` = 작업 정본(2026-05-20 main 4커밋 머지). 3월 폐갈래는 `origin/archive/remote-march-2026`(`f63321c`)에 영구 백업.

### 새 PC 부트스트랩 (이어작업 1회)
- `git pull` → `npm install` (functions 쓰면 `cd functions && npm install`).
- `.env.local` 생성: `.env.example` 참고, 값은 사용자 보유분. ⚠ `REACT_APP_KAKAO_MAP_KEY`=운영 공유키 `58bf34…`(`d464b4…` 아님 — prod 지도 사망).

### 배포 절차 (지도 안나옴/느림 방지)
1. **앵커 grep**: `grep -nE '^REACT_APP_KAKAO_MAP_KEY=' .env.local` → `58bf34` 시작 확인(주석 9번 d464b4는 비활성, STOP 아님).
2. `CI=false npm run build` → `npm start` → localhost `/p`·`/bus` 지도·노선 그리기 확인.
3. `firebase deploy --only hosting` → curl 검증(키·manifest·아이콘·번들해시).
4. 회귀 시 가설-재배포 금지 → 콘솔 Hosting 롤백 먼저, 재현은 localhost.
- ※ Firebase Auth 승인 도메인은 기본 자동등록 — 조치 불필요(지난 "문제 A" 오진, issues.md).

## 다음 할 일
- [x] **DIAG-INSTALL 진단 결과 확인 후 제거** (2026-05-20 완료) — 사용자 기기에서 설치팝업 미표시 원인 5후보(snoozed/standalone/engagement/in-app browser/SW idle) 확정 후 `grep "DIAG-INSTALL"` 로 InstallPrompt.js 통째 제거+재배포.
- [x] **노선 그리기 편집 UX 개선·배포** (2026-05-20, `1849cce`/`main.7d89705e.js`) — 중간 삽입(⊕)·앞에 추가 모드·선택 기반 삭제·출발/도착 색·번호 라벨.
- [x] **본 머지 prod 재배포** — 노선 그리기·routeProgress·PermissionGate·gps 콜드스타트 복구(2026-05-20 회귀 보고 → 머지로 복원). 이어그리기는 `openPathDraw`가 이미 `route.routePath`를 초기 로드해 자동 지원.
- [ ] (선택) 운영 노선에 `routePath` 실제 그리기 — 안 그린 노선은 stops 직선 폴백(정상).

## 백로그 / 검토 후보
- [ ] `src/firestore.rules` ↔ 루트 `firestore.rules` 일원화(src 사본 삭제 검토)
- [ ] `src/firestore.rules` `passengers` write 제약 — PartnerApp 익명화+규칙 재설계 동반(issues.md `[보류]`)
- [ ] `firebase-messaging-sw.js` 설정 env 주입 검토(현재 하드코딩)
- [ ] 🔑 카카오 비즈앱 심사 통과 후 전용키 `d464b4…` 복구 + 전용앱 Web 도메인 등록 + 재빌드
- [ ] ⏳ Node.js 20→22 (데드라인 2026-10-30 decommission) — `firebase.json`+`functions/package.json` `nodejs22` + `firebase-functions@latest`(breaking 검토) 후 재배포
- [ ] PassengerApp `ARRIVING_M` 미사용 — `/bus` 도착판정 경로거리 임계 미반영(회귀 아님·완결성)

## 기획 대비 기능 갭 (PLANNING.md 2026-05-16)
> MVP 1단계(기사 로그인→배차→운행→GPS / 관제 / 승객 실시간) 전부 동작.
- [ ] ⭐ #12 고객사 담당자 운영 포털 — 자사 실시간 버스·탑승현황·공지수신 (SaaS 최우선 갭)
- [ ] #9 탑승객 분석 / #8 운행일지 정주행 비교 / #11 푸시 타게팅 / #4 노선 보강(요일·엑셀) / #14-C 정류장 엑셀일괄 / #15 첫로그인 PIN 강제변경
- [ ] (보류·SaaS) #17 슈퍼관리자·빌링 / #16 멀티테넌트(dy001 하드코딩) / #15 SMS인증 — PLANNING §7·§8. (폐기) #10 예약관리(통근 확정)

## 완료 (요약·시간역순, 상세는 issues.md 패턴·redesign-log.md)
- [x] **2026-05-20 InstallPrompt 스누즈 14→3일 + DIAG-INSTALL 진단 제거(임무 완료)** `da24224`/`main.f0dd8be3.js` — InstallPrompt.js 단독 +5/-23. 원인 종결: 사용자 LS `buslink_pwa_prompt = {dismissedAt}` 14일 차단 → 3일로 단축(차후 같은 함정 재발 시 사용자 재현 빠름). SNOOZE_DAYS 17행 14→3 + 코멘트 3곳 동기(파일 상단 10행·isSnoozed 위 44행·handleInstall 거절 160행). DIAG-INSTALL 박스 통째 제거(diagBox const + `return diagBox` → `return null` + 정상 렌더 `<>{diagBox}{UI}</>` fragment 풀기). isStandalone/isSnoozed/dismiss/onInstalled/BIP/appinstalled/iOS detection/window.__buslinkDeferredBIP 회수 0줄. curl ⓐ `appkey=58bf34`·`autoload=false`·`rel="manifest"` 유지 ⓑ 새 번들 ≠ 옛 7해시(cb747e1c/6c626f25/7d89705e/dc99419e/80d0f31e/1614fa6b/d85ec794) ⓒ `DIAG-INSTALL` 0건(제거 실증) / `__buslinkDeferredBIP` 6건(글로벌 stash 유지) / `pickerModal` 10건(어제 모달 유지) / `buslink_driver_active_dispatch_` 2건(다중배차 유지). parse-only OK. 신규 경고 0(잔존 PartnerApp/PassengerApp/AdminApp no-unused-vars만 HEAD 원본). 회귀 0.
- [x] **2026-05-20 기사앱 배차 선택 칩→모달(EmployeeApp 패턴) + DIAG-INSTALL 임시 진단** `e690b41`/`main.cb747e1c.js` — 2파일(+145/-44) src/pages/DriverApp.js·src/components/InstallPrompt.js. (1) DriverApp 가로 스크롤 칩 제거(스타일 8개 dispatchPicker/Label/Chips/Chip/ChipActive/ChipTime/ChipRoute/ChipVeh 전부 삭제), hero 카드 "오늘 배차" Pill 옆 작은 "🔄 배차 변경 (N건)" 버튼(>1 한정), 풀모달 오버레이 routePicker 패턴 차용(헤더·6초과 검색·카드 리스트·시간/구분/노선/차량/거래처/현재 뱃지·클릭=setActiveDispatchId+닫기). 신규 state pickerOpen/dispatchQuery + filteredDispatches derived. 신규 스타일 13키(dispatchChangeBtn + picker 12종). dispatches/activeDispatchId/loadDispatch/derived dispatch/loadStops/영속 useEffect/refreshToken/startGPS/createBoardingToken 0줄. 1건 이하 회귀 0. (2) InstallPrompt [DIAG-INSTALL] 임시 진단 박스(mode/BIP/standalone/snoozed/LS/SW/UA 7항목, 우상단 top:60·#0f0 mono·pointerEvents:none·zIndex 9999) — return null→return diagBox, 정상 렌더 `<>{diagBox}{기존UI}</>` 감쌈. 설치팝업 미표시 5후보(스누즈/standalone/engagement/인앱 브라우저/SW미등록) 한 번에 가시화. 다음 커밋에 grep 제거 예정. curl ⓐ `appkey=58bf34` ⓑ manifest/apple-meta/autoload=false 유지 ⓒ 새 번들 ≠ 옛 5해시(6c626f25/7d89705e/dc99419e/80d0f31e/1614fa6b/d85ec794) ⓓ 적용 실증: `DIAG-INSTALL` 1건 / `__buslinkDeferredBIP` 7건 / `buslink_driver_active_dispatch_` 2건 / `dispatchChipActive` 0건(옛 칩 제거) / `dispatchChangeBtn` 2건 / `pickerBack` 2건 / `pickerModal` 10건. parse-only OK. 신규 경고 0(boardingToken/nextStopDist L46/51은 HEAD 원본 잔존).
- [x] **2026-05-20 기사앱 설치 가이드 BIP 글로벌 stash + 다중 배차 선택 칩** `ac6fbf3`/`main.6c626f25.js` — 3파일(+97/-7) src/index.js·components/InstallPrompt.js·pages/DriverApp.js. (1) `beforeinstallprompt`는 페이지 로드 직후 한 번 발생 → `index.js`에 `window.__buslinkDeferredBIP` 글로벌 stash, `InstallPrompt` mount 시 회수+비움. DriverApp early-return(loading/error)에도 `<InstallPrompt/>` 추가(안전망). 기사앱 Firebase Auth+driver/dispatch 로드 동안 마운트 지연으로 BIP 미캐치 → EmployeeApp(`/p`) 익명로그인만 동작하던 원인 제거. (2) `loadDispatch` `snap.docs[0]` 단일 → `dispatches[]` + `activeDispatchId` 칩 선택, derived dispatch 로 기존 참조 100% 호환, localStorage `buslink_driver_active_dispatch_{today}` 영속(재진입 복원), 활성 변경 시 stops 재로드 useEffect. 배차 1건 이하 회귀 0(picker 미표시). curl ⓐ `appkey=58bf34` ⓑ manifest/apple-meta/autoload=false 유지 ⓒ 새 번들 ≠ 옛 5해시 ⓓ 적용 실증: `__buslinkDeferredBIP` 6건 / `\\uc624\\ub298 \\ubc30\\ucc28`(오늘 배차) 6건 / `\\ub178\\uc120`(노선) 68건 / `\\ub178\\uc120?` 1건 / `buslink_driver_active_dispatch_` 2건 / `dispatches` 7건 / `routeId` 46건. 신규 경고 0.
- [x] **2026-05-20 노선 그리기 편집 UX 개선·배포 — 중간 삽입(⊕)·앞에 추가·선택 삭제·3색 핀·번호 라벨** `1849cce`/`main.7d89705e.js` — AdminApp.js 단독 +78/-18(parse OK). 신규 state `selectedIdx`/`prependMode`, 신규 핸들러 `pathInsertPoint`/`pathPrependPoint`/`pathDeleteSelected`(기존 add/move/delete/undo/clear/seed/save 본체 불변). 정점 마커: 노란 별→SVG 핀 출발 `#00BF40`/도착 `#FF4D6A`/중간 `#0066FF`, 선택 시 검정 외곽선. CustomOverlayMap 번호/역할 라벨(출발/도착/#N). 세그먼트 중점 ⊕ 클릭=중간 삽입+자동 선택. 마커 onClick 즉시삭제→선택(오삭제 방지). curl ⓐ `appkey=58bf34` ⓑ manifest/apple-meta/autoload=false 유지 ⓒ 새 번들 ≠ 옛 4해시 ⓓ prod 번들에 색 코드 16건(`00BF40`×3+`FF4D6A`×13) 인라인 — 적용 실증. 신규 경고 0.
- [x] **2026-05-20 머지 prod 배포 — 노선 그리기 회귀 복구·번들해시·curl 6항목 실측** — master HEAD `d06bb7f` 배포(`main.dc99419e.js`). curl ⓐ `appkey=58bf34` ⓑ manifest/apple-meta/autoload=false 전부 유지 ⓒ manifest 3종 200·scope `/`·`/p`·`/` ⓓ 아이콘 6종 200/올바른 ct ⓔ 새 번들 ≠ 옛 3해시(`d85ec794`/`1614fa6b`/`80d0f31e`) ⓕ 머지 실증: `정류장 순서대로 자동 연결`(\\u esc) 1건·`routePath` 10건·`노선`(\\ub178\\uc120) 67건. 신규 경고 0(기존 LoginApp/PartnerApp/AdminApp/DriverApp/EmployeeApp no-unused-vars만). 회귀 0.
- [x] **2026-05-20 main→master 머지** — origin/main 4커밋(`5fa0737`·`2ec17c0`·`c970c07`·`0495924`) 통합: 노선 사전경로 그리기 UI + `lib/routeProgress.js` + `components/PermissionGate.js`·`lib/usePermissions.js` + gps 콜드스타트 + `.env.example` + 문제 A 오진 정정 docs. 코드 충돌 3건(EmployeeApp/DriverApp imports + EmployeeApp `<Map onCreate>` — main 더블 relayout 채택) + 문서 2건 해결. 흰화면 보강: 제 autoload=false(1597097) + main의 onCreate `relayout()+setTimeout 300ms` 공존 = 더 견고.
- [x] **2026-05-19 앱별 PWA 아이콘 (Route Family) 적용·배포** `8b3e37e`/`0095e16` — `public/icons/` 6종(승객/기사/관제 svg+1024png) + manifest 3종(기본·`-employee` scope `/p`·`-driver`) + `src/lib/pwaManifest.js applyAppManifest`(순수 DOM·idempotent) + EmployeeApp/DriverApp 마운트 1회 동적 교체. 로컬 래스터 도구 부재로 manifest 아이콘은 SVG(`sizes:"any"`) 정본 + 1024 PNG raster/iOS apple-touch fallback. purpose `any`만(maskable 미지정=Route 풀블리드 보존). curl 검증 통과.
- [x] **2026-05-19 prod 배포 — master HEAD `f2aa1a2` 라이브** `3032c6d` — 게이트 ⓑ(Kakao prod 도메인) 확인 후 `CI=false npm run build`→`firebase deploy --only hosting`(hosting 단독). 라이브=ETA 목적지도착(`55112aa`)·`/p` 지도 흰화면 근본수정(`1597097`)·정리(`82399d5`)·PWA(`f2aa1a2`) + 누적 GPS heartbeat(`2ad1a31`). 롤백본 `main.d85ec794.js` 대체, 번들 `main.1614fa6b.js`. curl 5항목 회귀 0.
- [x] **2026-05-19 PWA 설치형 앱 (`/p`·기사앱) + 설치유도 팝업** `f2aa1a2`/`82399d5` — iOS 메타·theme `#0066FF`·`firebase-messaging-sw.js` no-op `fetch`(캐시無), 신규 `components/InstallPrompt.js`(beforeinstallprompt 안드/iOS Safari 공유→홈추가 안내/standalone·appinstalled 영구비표시/localStorage 14일 스누즈), EmployeeApp/DriverApp SW 등록+InstallPrompt 마운트.
- [x] **2026-05-19 문제 B `/p` 지도 흰화면 근본수정 + DIAG-B 제거** `1597097`/`82399d5` — `public/index.html` `&autoload=false` + `App.js` 게이팅 `window.kakao.maps.load(cb)` 콜백 only + onCreate relayout. 사용자 localhost 육안확인(`Map=true mapBox=1920x436`).
- [x] **2026-05-19 ETA "목적지 도착" 류 대체 (`/p`·`/bus`)** `55112aa` — `isDestStop = stops.length>=2 && myStopIdx===stops.length-1` 게이트로 표시 문자열만 분기. 탑승자 없는 회사 종점 대응. 비-도착지 픽셀 동일(원본 리터럴 폴백).
- [x] **2026-05-18 노선 사전경로 + 실시간 진행 시각화 + 정밀 도착판정 + GPS 콜드스타트 + 권한·설치 게이트 + `/p` 흰화면 onCreate relayout** `5fa0737` — AdminApp RoutesTab "경로 그리기" 모달(`pathPoints`/Undo/Clear/SeedFromStops + 기존 routePath 초기 로드 = 이어그리기 자동), 신규 `lib/routeProgress.js`·`lib/usePermissions.js`·`components/PermissionGate.js`·`.env.example`. `routes/{id}.routePath`(미설정=stops 직선 폴백).
- [x] **2026-05-18 prod 장애→롤백→실원인(카카오 키 단일) 확정·재발방지 체크리스트** `c970c07` — 문제 A(Auth 도메인) 오진 정정.
- [x] **2026-05-17 정류장 사진+설명·클립보드·#14-B 주소검색→핀·직원앱 노선변경·승객앱 노선선택·재활성화 버튼** — 다수 라이브.
- [x] **2026-05-16 리디자인 0~6단계 + QA 안정화 4건 + PLANNING.md 정본화 + CLAUDE.md `.claude/` 분리** — 라이트 테마 전면 리스킨. 상세 redesign.md/redesign-log.md.

## 저장소 메모
- `src.zip` git 추적되나 작업트리 삭제 상태(소스 백업, 빌드 미사용).
