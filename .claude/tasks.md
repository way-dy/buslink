# Tasks

> 작업 시작/완료 시 이 파일만 수정. 체크박스 관리. 어느 PC든 이어작업용.

## 현재 상태 (2026-05-18 — 배포 완료·prod 지도 정상 사용자 확인)
> 이 저장소가 작업 정본. **어느 PC든** `git pull` + `.env.local`(↓부트스트랩)이면 빌드·배포 가능.
> prod 라이브 = `main.3b72f336.js`(리디자인 0~6 + 노선경로 + 권한·설치 게이트 + `/p` 지도 흰화면 fix).

### git 원격
- `origin/main` = 로컬 정본(2026-05-18 force-align 완료). 3월 폐갈래는 `origin/archive/remote-march-2026`(`f63321c`)에 영구 백업.

### 새 PC 부트스트랩 (이어작업 1회)
- `git pull` → `npm install` (functions 쓰면 `cd functions && npm install`).
- `.env.local` 생성: `.env.example` 참고, 값은 사용자 보유분. ⚠ `REACT_APP_KAKAO_MAP_KEY`=운영 공유키 `58bf34…`(`d464b4…` 아님 — prod 지도 사망).

### 배포 절차 (지도 안나옴/느림 방지)
1. `.env.local` 카카오 키 `58bf34…` 확인.
2. `npm run build` → `npm start` → localhost `/p`·`/bus` 지도 확인.
3. `firebase deploy --only hosting`(프론트 전용). 배포 후 prod 재확인.
4. 회귀 시 가설-재배포 금지 → 콘솔 Hosting 롤백 먼저, 재현은 localhost.
- ※ Firebase Auth 승인 도메인은 기본 자동등록 — 조치 불필요(지난 "문제 A" 오진, issues.md).

## 백로그 / 검토 후보
- [ ] `src/firestore.rules` ↔ 루트 `firestore.rules` 일원화(src 사본 삭제 검토)
- [ ] `src/firestore.rules` `passengers` write 제약 — PartnerApp 익명화+규칙 재설계 동반(issues.md `[보류]`). 배포본 vs 정본 차이 먼저 확인
- [ ] `firebase-messaging-sw.js` 설정 env 주입 검토(현재 하드코딩)
- [ ] 🔑 카카오 비즈앱 심사 통과 후 전용키 `d464b4…` 복구 + 전용앱 Web 도메인 등록 + 재빌드(현재 callcenter 키 임시공유·일일한도 공유)
- [ ] ⏳ Node.js 20→22 (데드라인 2026-10-30 decommission) — `firebase.json`+`functions/package.json` `nodejs22` + `firebase-functions@latest`(breaking 검토) 후 재배포
- [ ] PassengerApp `ARRIVING_M` 미사용 — `/bus` 도착판정 경로거리 임계 미반영(회귀 아님·완결성 다듬기)
- [ ] (선택) 운영 노선에 `routePath` 실제 그리기 — 안 그린 노선은 stops 직선 폴백(정상 동작)

## 기획 대비 기능 갭 (docs/PLANNING.md, 2026-05-16 검증)
> MVP 1단계(기사 로그인→배차→운행→GPS / 관제 / 승객 실시간) 전부 동작. 아래는 2~3단계 확장.
- [ ] ⭐ #12 고객사 담당자 운영 포털 — 자사 실시간 버스·탑승현황·공지수신 (SaaS 최우선 갭)
- [ ] #9 탑승객 분석 / #8 운행일지 정주행 비교 / #11 푸시 타게팅 / #4 노선 보강(요일스케줄·엑셀) / #14-C 정류장 엑셀일괄 / #15 첫로그인 PIN 강제변경
- [ ] (보류·SaaS) #17 슈퍼관리자·빌링 / #16 멀티테넌트(dy001 하드코딩) / #15 SMS인증 — PLANNING §7·§8. (폐기) #10 예약관리(통근 확정)

## 완료 (요약 — 상세는 issues.md 패턴 / redesign-log.md)
- [x] **노선 사전경로+실시간 진행 시각화·정밀 도착판정 / GPS 콜드스타트 / 권한·PWA설치 게이트 / `/p` 지도 흰화면 근본해결** + 배포·검증 (2026-05-18) — 신규 `lib/routeProgress.js`·`lib/usePermissions.js`·`components/PermissionGate.js`·`.env.example`. `routes/{id}.routePath`(미설정=stops 직선 폴백). 흰화면=flex/dvh 0px init→`<Map> onCreate relayout`. 패턴 상세 issues.md.
- [x] 리디자인 0~6단계 전체 (2026-05-16~) — 라이트 테마 전면 리스킨, 2026-05-18 배포로 라이브. 상세 redesign.md/redesign-log.md.
- [x] 2026-05-18 prod 장애→롤백→실원인(카카오 키) 확정·재발방지 체크리스트 확립 (issues.md `[패턴] 배포 안전 절차`)
- [x] 정류장 사진+설명·클립보드·#14-B 주소검색→핀·직원앱 노선변경·승객앱 노선선택 (2026-05-17, 다수 라이브)
- [x] QA 안정화 4건+런타임 정렬 배포 / PLANNING.md 정본화 / CLAUDE.md `.claude/` 분리 (2026-05-16)
