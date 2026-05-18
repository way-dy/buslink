# Tasks

> 작업 시작/완료 시 이 파일만 수정. 체크박스로 관리. 다른 PC 이어작업용.

## 리디자인 적용 (2026-05-16~)
> 상세·단계 체크박스는 분리: **@.claude/redesign.md** (50줄 규칙). 라이트 테마 전면 리스킨.
- [x] 0단계 — 기반 구축(토큰/폰트/UI 라이브러리)
- [x] 1단계 — LoginApp 라이트 split 리스킨 (2026-05-16, 배포 안 함)
- [x] 2단계 — DriverApp / PassengerApp 라이트 리스킨 (2026-05-16, 배포 안 함)
- [x] 3단계 — AdminApp 실시간관제 탭(MapTab) 라이트 리스킨 (2026-05-16, 배포 안 함, MapTab 단독·MS 격리)
- [x] 4단계 — AdminApp 전체 라이트 통일 (2026-05-16, 결정 확장·공유 S 토큰 일괄 전환·전 9탭+셸)
- [x] 배포 — 1·2·3·4단계 + QA안정화 buslink-prod 라이브 (2026-05-16, `main.28978312.js`, hosting 단독)
- [x] 5단계 — AdminApp 사이드바 메뉴 세련화 (2026-05-16, 배포 안 함 — 승인 대기)
- [x] 6단계 — EmployeeApp(`/p` 직원앱) 전면 라이트 리스킨 (2026-05-16, 배포 안 함 — 단독 격리, 로직 HEAD=NOW)
- [ ] 5·6단계 배포 — 사용자 승인 시 `firebase deploy --only hosting` 단독(프론트 전용)

## 현재 상태 + 배포 (2026-05-18 — "특정 PC만" 규율 폐기: 이 저장소가 작업 정본)
> **어느 PC든** `git pull` + `.env.local`(↓부트스트랩)만 맞추면 이어작업·빌드·배포 가능.
> prod 라이브 = 콘솔 롤백된 정상 빌드. 아래 미배포분을 빌드→localhost 확인→배포하면 끝.

### 새 PC 부트스트랩 (이어작업 시 1회)
- `git pull` → 프로젝트 폴더(`app/buslink`) 존재 확인 → `npm install` (functions 쓰면 `cd functions && npm install`).
- **`.env.local` 생성**: `.env.example` 키 목록 참고. 값(Firebase 6종·KAKAO·VAPID)은 사용자 보유분 입력. ⚠ `REACT_APP_KAKAO_MAP_KEY`=운영 공유키 `58bf34…`(`d464b4…` 아님).

### 배포 전 체크리스트 (지도 안나옴/느림 방지 — 순서대로)
1. `.env.local` 카카오 키 = `58bf34…` 확인(`d464b4…`면 prod 지도 전체 사망).
2. Firebase 콘솔 1회(코드무관, 미설정 시 prod `permission-denied`): Authentication→Settings→승인된 도메인에 `buslink-prod.web.app`·`buslink-prod.firebaseapp.com` 추가.
3. `npm run build` → `npm start` → localhost에서 `/p`·`/bus` 지도 표시 확인.
4. `firebase deploy --only hosting` (프론트 전용 — functions/rules/indexes 무관). 배포 후 prod `/p` 지도·GPS 재확인.
5. 회귀 시: **가설-재배포 금지** → 콘솔 Hosting에서 직전 정상 빌드로 즉시 롤백 후 localhost 재현.

### 미배포 (작업트리 — 위 체크리스트대로 빌드+배포 1회 필요)
- [ ] 노선경로 4건 + 지도 흰화면 fix + (옵션)5·6단계 리디자인 — 한 번의 `firebase deploy --only hosting`로 함께.

## 백로그 / 검토 후보 (issues.md 기반)
- [ ] `src/firestore.rules`와 루트 `firestore.rules` 일원화(중복 제거 또는 src 사본 삭제)
- [x] functions 런타임 정렬(`firebase.json` nodejs22 → nodejs20, 2026-05-16)
- [ ] `src/firestore.rules` `passengers` write 제약 — PartnerApp 익명 로그인화 + 규칙 재설계 동반 필요(issues.md `[보류]` 참고). 배포된 실제 규칙 vs 저장소 정본 차이 먼저 확인.
- [x] `.env.example` 추가 (2026-05-18, 키+가이드, 값 제외 — 어느 PC나 부트스트랩용)
- [ ] `firebase-messaging-sw.js` 설정 env 주입 방식 검토
- [ ] 🔑 **카카오맵 비즈앱 심사 통과 후 Kakao 키 분리** — `.env.local`을 buslink 전용 키 `d464b4…`(주석 보존)로 복구 + 전용 앱 Web 도메인 등록 + 재빌드·재배포. 현재 callcenter 키 `58bf34…` 임시 공유 중(issues.md, 일일 한도 공유).
- [ ] ⏳ **Node.js 20 → 22 업그레이드 (데드라인 2026-10-30)** — nodejs20은 2026-04-30 deprecated, 2026-10-30 decommission(이후 배포 불가). `firebase.json` runtime `nodejs22` + `functions/package.json` `engines.node:"22"` 동시 상향 + `firebase-functions@latest` 업그레이드(breaking 검토) 후 functions 재배포·동작 점검. 동결 정렬은 임시 — 데드라인 전 필수.

## 기획 대비 기능 갭 (docs/PLANNING.md 기준 — 2026-05-16 코드검증)
> MVP 1단계(기사 로그인→배차→운행→GPS / 관리자 실시간 관제 / 승객 실시간위치)는 전부 구현·동작. 아래는 2~3단계 확장 갭.
- [ ] ⭐ **#12 고객사 담당자 운영 포털** — PartnerApp은 직원명부 관리만. 자사 실시간 버스위치·탑승현황 대시보드·공지수신 미구현(SaaS 영업 최우선 갭)
- [ ] #9 탑승객 분석 탭 — 노선별 태깅 vs 수기, 태깅률 (현재 대시보드 단순 카운트만)
- [ ] #8 운행일지 정주행 비교 — 정류장별 도착예정 vs 실제·조출여부·승하차 인원 (현재 raw GPS 궤적만)
- [ ] #11 푸시 타게팅 — 기사/고객 분리·노선별·예약자·글자수 제한 (현재 회사 전체 일괄만)
- [ ] #4 노선 관리 보강 — 요일별 스케줄·탑승률 색강조·노선 엑셀 (정류장 2단계·출퇴근 필터는 됨)
- [ ] #14 정류장 입력 — **B(카카오 주소/키워드 검색) 완료**. C(엑셀 일괄)만 잔여
- [ ] #15 첫 로그인 PIN 강제변경 — 현재 soft 유도만, 기사앱은 흐름 자체 부재
- [ ] (의도적 보류·SaaS) #17 슈퍼관리자·빌링 / #16 멀티테넌트 실운영(dy001 하드코딩) / #15 휴대폰 SMS 선택인증 — PLANNING.md §7·§8 명시 보류, 갭 아님
- [ ] (폐기) #10 예약 정보 관리 — 통근형 확정으로 예약코드 폐기(PLANNING §4.6), 통근 모델 유지 시 개발 불필요

## 완료
- [x] **EmployeeApp `/p` 지도 흰화면 근본해결** (2026-05-18) — 원인 확정: `appWrap 100dvh→content flex:1→HomeTab flex:1→map flex:'0 0 55%'` 체인이라 카카오 맵 init 시점에 컨테이너 0px → 카카오는 CSS와 달리 자동 relayout 안 함 = **영구 흰화면**. `/bus`는 지도 컨테이너가 고정 `height:100vh`라 무관 → `/p`만 깨진 이유와 정확히 일치(이전 "구조상 정상·라이브 디버깅 필요"의 실제 결정타). 해법: `EmployeeApp.js` `<Map>` 2곳(HomeTab + 실시간 모달)에 `onCreate={map=>{map.relayout();setTimeout(()=>map.relayout(),300)}}` — 생성 직후 + 레이아웃 안정 후 1회씩(무위험·idempotent). 미배포(위 체크리스트로 함께 배포).
- [x] **노선 경로 사전그리기 + 실시간 경로진행 시각화/정밀판정 + GPS콜드스타트 + 권한·설치 게이트** (2026-05-18, 4건, 소스 구현·미배포) — ①AdminApp RoutesTab: 노선별 "🛣 경로 그리기" 모달(정류장관리 동급 진입). 지도클릭=정점추가/`MapMarker draggable onDragEnd`=이동/클릭=삭제/되돌리기·전체지우기·정류장순서 자동연결, `Polyline` 미리보기 → `routes/{id}.routePath`(stops처럼 plain number, 빈배열=미설정) `updateDoc`. 자동도로라우팅 미사용(수동). ②신규 `lib/routeProgress.js`(폴리라인 누적거리/점→폴리라인 투영/haversine/구간 slice). EmployeeApp(`/p`)+PassengerApp(`/bus`): `route.routePath` 있으면 사전경로, 없으면 `stops.map` 폴백(하위호환). 버스 GPS 투영 progress 기반 passed/arriving/approaching 재작성, 수직거리>70m 이탈좌표 제외(직전 progress 유지), 지나온경로 회색·남은 파랑 `Polyline` 2분할(폴백시 단일). 표시문구 불변. ③`lib/gps.js`: `startGPS` 즉시 `getCurrentPosition` 1회 선발행+watch옵션 완화(timeout 30s)+TIMEOUT 1회 재시작가드+`onGpsError` 콜백(하위호환). DriverApp `handleStart` 권한 사전점검+"GPS 신호 확보 중…/권한" 안내. ④신규 `lib/usePermissions.js`+`components/PermissionGate.js`(위치/알림 배너·차단안내 모달·`beforeinstallprompt` 설치버튼, 콜센터 driver.html 패턴 React화·라이트토큰). EmployeeApp홈·DriverApp 상단 적용. `index.js` SW 1회 선등록(idempotent). 보존 로직 HEAD=NOW(gps/Employee/Passenger/Driver/Admin 정밀 카운트, calcETA +1은 주석 단어매칭·실호출 동일, `<Polyline>` 증가는 분할 의도). 각 파일 babel parse OK·JSX균형. 미배포(주말 PC). 후속: routePath는 신규/편집 노선부터 점진(기존 노선 미설정=stops 폴백 자동).
- [x] **2026-05-18 prod 장애 → 콘솔 롤백 (이 D: PC 오늘 작업분 전량 비활성)** — 이 PC에서 ce4c5b5(주말 리디자인) 기반으로 GPS수정·main 3월 FCM/배차 이식(e522329/2ad1a31/78f95f5)·게이트/폰트 등 hosting 다회 배포 → 카카오 키(d464b4 오박힘) + 원인 미확정 Firestore `permission-denied`(익명토큰 200인데 isAuth 거부) 등 prod 연쇄 회귀. 콘솔 Hosting에서 주말 정상 빌드 **`main.d85ec794.js`로 롤백** → 라이브 복구·지도 정상(사용자 확인). 교훈: prod 가설-재배포 금지 — 빌드 전 카카오 키 확인 + localhost 검증 + 회귀 시 콘솔 롤백 우선(상세 → 위 "배포 전 체크리스트", issues.md `[패턴] 배포 안전 절차`).
- [x] **직원앱(`/p`) 노선 변경 + 지도 정류장 이름/클릭정보** (2026-05-17) — EmployeeApp HomeTab 한정 3건. ①헤더 "🔄 노선 변경" 모달(전체 노선=기존 `getDocs(routes)` 재사용, >6개 검색)→`chooseRoute`→`onSessionUpdate({routeId})`(부모 `saveSession` localStorage 영속=기준노선)→`session.routeId` effect가 `activeRouteId`/`myStopIdx` 재바인딩→정류장/지도/GPS 연쇄. RoutesTab은 기준노선 변경 미지원이라 HomeTab 신규 모달 구현(PassengerApp 톤 준용). ②지도 전 정류장 이름 라벨(출/도/내정류장 기존 강조 유지, 중간은 소형 흰라벨 `maxWidth:88` 말줄임·`yAnchor` 분리). ③마커/라벨 클릭→정류장 정보 바텀시트(주소/사진/설명/없을때 안내+"내 정류장 설정"). strip 클릭(내정류장 지정) 기존동작 무손상. 보존 로직 24항목 HEAD=NOW(`saveSession`만 HomeTab prop 배선+주석 +2 의도분), `EmployeeApp.js` 단독 격리, 빌드 `main.d85ec794.js` 통과·신규 경고 0(기존 8건 줄번호만 이동). 미배포(hosting 단독 대기)
- [x] **승객앱 노선 자가 선택 + 기준노선 localStorage** (2026-05-17) — PassengerApp `routeId` const→`selectedRouteId` state. 노선 결정 우선순위 ①URL `route`/`r`(딥링크 보존) ②localStorage `buslink_passenger_route_{companyId}` ③null(노선 선택 화면). `companies/{cid}/routes` onSnapshot 목록(클라 `departTime` 정렬, 복합인덱스 불요)→미선택 시 풀스크린 선택 화면(노선명·구분·출발시간·거래처, >6개 검색), 상단 카드 "노선 변경" 버튼→바텀시트 모달. 선택 시 localStorage 저장+노선/정류장/버스 재바인딩(effect 의존성 `selectedRouteId`). 보존 로직 HEAD=NOW(실호출 동일, 증가분은 헤더주석 단어매칭), `PassengerApp.js` 단독 격리, 빌드 `main.fe216510.js` 통과·신규 경고 0. 미배포(hosting 단독 대기)
- [x] **정류장 관리 패널 스크롤 버그 수정** (2026-05-17) — 패널 flex컬럼에서 목록div(자체스크롤)·폼div가 형제라 폼 길면 패널 밖 넘쳐 잘림. 헤더 `flexShrink:0` + 목록·폼을 단일 스크롤 영역(`flex:1,overflowY:auto,minHeight:0`)으로 래핑 → 저장버튼까지 스크롤 도달. div 3곳 조정, 로직 보존·JSX균형 통과·라이브 `main.b9ab2b18.js`
- [x] **정류장 사진 클립보드 붙여넣기** (2026-05-17) — 정류장 폼 열림 동안 `window` paste 리스너(이미지 클립보드만 가로챔, 텍스트 무영향) → `compressImageFile` 재사용 → `stopForm.photo`. 파일첨부 병행, 안내문구 추가. RoutesTab 격리·로직 보존·라이브 `main.7c0822f2.js`
- [x] **정류장 사진 + 설명** (2026-05-17) — Firestore 압축 저장 방식(Storage 미사용). 관리자 RoutesTab 정류장 폼에 사진 첨부(클라 canvas 리사이즈 긴변1000px·JPEG q0.6→0.45→0.3 단계압축, >700KB 거부)·삭제·미리보기 + 설명 textarea, `stops` 문서에 `photo`(data URI)·`description` 저장(`lib/image.js compressImageFile` 신규). 승객앱(`/bus`)·직원앱(`/p`) 정류장 목록에 썸네일→탭 라이트박스 확대·설명 표시(사진 없으면 미표시). `AdminApp/PassengerApp/EmployeeApp.js`+`lib/image.js` 격리, 보존 로직 HEAD=NOW, 빌드 통과·신규 경고 0. 미배포(hosting 단독 대기)
- [x] **#14-B 후속: 검색→지도 핀 미세조정** (2026-05-17) — `pickAddrResult`가 결과 선택 시 지도 picker 자동 오픈(결과 좌표 중심+핀), 모달 `MapMarker draggable+onDragEnd`(드래그로 pickerPin/Center 갱신)·기존 지도클릭 병행, 안내문구 갱신. "이 위치로 선택"으로 확정. RoutesTab 격리·로직 보존·라이브 `main.2baed4e1.js`
- [x] **#14-B 정류장 주소/장소 검색** (2026-05-17) — RoutesTab 정류장 추가/수정 폼에 카카오 `services.Geocoder.addressSearch`→`Places.keywordSearch` 폴백 검색(최대 5결과 드롭다운). 선택 시 주소/좌표(소수6자리)·`pickerPin/Center` 동기, name 비었을 때만 프리필. SDK/services 미로드·ZERO_RESULT·ERROR(한도초과) 우아한 실패+수동경로 안내. RoutesTab 지역 state 4개(`addrQuery/Results/Searching/Msg`)만 추가, 보존 로직 HEAD=NOW. `AdminApp.js` 단독 격리, 빌드 통과·신규 경고 0. 미배포(hosting 단독 대기)
- [x] 협력사 비활성 업체코드 **재활성화 버튼** 추가 + 배포 (2026-05-17) — qa 🟢 항목. PartnerTab `handleActivate`(updateDoc active:true) + `!c.active` 시 "활성화" 버튼(`S.actBtn` positive 토큰). 로직 보존·격리, 라이브 `main.9a8cdbea.js`
- [x] QA 안정화 결함 수정 4건 + 런타임 정렬 + **배포 완료** (2026-05-16) — partnerCodes 복합인덱스 / BoardingApp 재시도버튼 / 공지 문구 / onCall 4종 `assertAdmin` / `firebase.json` nodejs20. 배포: `firestore:indexes`+`hosting`+`functions`(5개 v2/nodejs20/us-central1 확인). `firestore:rules` 의도적 미배포(배포본≠저장소 정본 의심). 5번(passengers rules) 보류 — issues.md `[보류]`. ※ 운영 수동검증 남음: admin 기사 생성/삭제/비번변경, 테스트 공지 FCM.
- [x] docs/PLANNING.md 기획 정본 역추출·통합 + 기획 대비 갭 판정 (2026-05-16)
- [x] CLAUDE.md를 `.claude/` 기능별 MD로 분리·핸드오프 체계 구축 (2026-05-16)
