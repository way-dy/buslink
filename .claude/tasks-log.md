# Tasks Log (옛 완료 누적·시간역순)

> tasks.md의 최근 7일을 제외한 누적 로그. 상세는 issues.md 패턴·redesign-log.md·git log.

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
