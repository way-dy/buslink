# Issues Log (완결된 옛 이슈 아카이브)

> issues.md 에서 이관. @import 하지 않는다 — 회귀 가드가 살아 있는 항목은 issues.md 에 남겨 둔다.

## 2026-05~06 인프라 수정 (이관 2026-08-05)

## 매뉴얼 도구·권한 UI (이관 2026-08-06)

- `[해결]` **🟢 admin 협력사 권한 "전체 해제"가 저장 안 됨 + 회사관리 UX(2026-06-15, prod 배포 `main.9ee8690d.js` + `listCompanyAdmins` CF)**: 슈퍼관리자 회사관리 → 관리자 목록 → 권한 변경에서 **전체권한(*) 해제 후 저장해도 재오픈/재조회 시 다시 전체로 체크**되던 버그. 근인 = "필드 부재(레거시 admin)=전체"와 "빈 배열 `[]`(전체 해제·특정 0개)=전체 아님"을 **관리 UI 2곳이 `length>0` 검사로 혼동** → `[]`를 `["*"]`로 둔갑. ① CF `listCompanyAdmins`(functions/index.js) ② 클라 `EditAdminPermissionsModal` 초기값(AdminApp.js) 둘 다 `Array.isArray(v) ? v : ["*"]`(부재만 폴백·빈 배열 보존)로 교정 — `src/lib/partnerAccess.js resolveAllowed` 와 동일 규칙으로 통일(런타임 게이팅은 원래 정상이라 데이터는 잘 저장됐고 **표시/재조회만 깨졌던 것**). **둘 다 배포 필수**(CF가 readback 정규화하면 클라 수정만으론 무효). **회귀 가드(복원 금지)**: 두 지점에 `&& length>0` 재추가 금지 — 전체 해제가 전체로 되돌아가는 회귀. **UX**: ③ 회사관리 진입 시 자기 소속 회사 관리자 목록 **자동 펼침+선로드**(ref 가드 1회) — "매번 클릭해서 활성화+로드 대기" 제거 ④ PartnerPermissionPicker 에 "전체 해제+0개 선택 = 아무 협력사도 못 봄" 경고. 후속 후보: 행별 인라인 권한 편집(모달 왕복 제거).

- `[패턴]` **모노디자인 PDF 매뉴얼 신설(2026-06-12, `docs/manual/`)**: 기존 PPT 매뉴얼이 "직관 활용 어렵다" 피드백 → 사용법 위주·모노디자인(무채색+단일 포인트색 `#0066FF`=tokens.css `--color-primary`) A4 PDF 3종(관리자/기사/직원). **스택**=marked(MD→HTML) + playwright-core 시스템 Chrome(`C:\Program Files\Google\Chrome\Application\chrome.exe`, 브라우저 다운로드 0)으로 `page.pdf({format:"A4"})`. 빌드=`cd docs/manual && node _to_pdf.mjs`. **스크린샷 재캡처 0** — `../manual-ppt/assets/{admin,driver,employee}/*.png` 재사용(`rewriteImgSrc`가 `assets/...`→`file://` 치환). **PPT assets 라벨↔내용 불일치 주의**: admin/02-sidebar=실제 대시보드·04-dispatch=배차 일정(배차 관리 아님)·driver/01-login=관제 로그인 배지·employee/04~06-home=홈(공지 강제모달 오버레이)·07-scan=공지목록·08-settings=설정. **placeholder**(`<div class="ph">` 점선박스)=운영 중에만 뜨는 화면: 관리자 배차/차량 관리·기사 운행중/QR발급/운행종료·직원 QR스캔 카메라. **납품물 PII(외부 공개·모자이크 후보)**: admin/02·04·05·06·08 의 기사 실명(동영스)·사번·연락처(01066772542)·차량번호(동영12테1234)·직원명(용동영)·협력사 업체코드(DY001-…-NDW0 등)·07 공지 발송이력 테스트문구. driver/02·employee 05~08 동일 PII. **차단 아님·보고 사항**(playbook 원칙). PDF 라이브 검증=시스템 Chrome 으로 HTML 풀페이지 PNG 스크린샷 후 Read(pdftoppm 부재).

- `[패턴]` **PPT 매뉴얼 도구 신설(2026-05-26~27, `docs/manual-ppt/`)**: callcenter 정본 복제 → 3 PPT(관리자·기사·승객). 관리자 10장 자동 캡처. 기사 03/04(운행 중 한정)·승객 02/03(설치 안내)·06(공지 탭, 자동화 실패)은 placeholder — 본인 폰 캡처해 `assets/<role>/NN.png`로 두면 다음 빌드 자동 반영. 자세한 자동화 트랩은 `.claude/agents/refs/manual-playbook.md` §PPT.


- `[해결]` **🟢 폰 최신빌드 미수신 블로커(2026-06-05 미해결 → 2026-06-09 해소)**: 진단 `appVersion`·화면 빌드뱃지 도입으로 옛/새 즉시 판별 가능해졌고, 이후 운행 진단 JSON 에 `appVersion` 정상 반환 = 폰이 신빌드 실행 입증. 캐시는 더 이상 블로커 아님. **교훈**: 진단으로 "데이터 없음"이 안 갈리면 진단 채널이 필드를 안 보여주는 것일 수 있다(아래 `[패턴] 도착 감지·표시 최종 구조` ① 참조).

- `[해결]` **🟢 도착 감지 작동 입증(2026-06-05 시크릿 운행)** + **첫 정류장 누락 근인**: 7정류장 `source:"actual"` 도착·실측지연(도착−계획, 예: +7분/+9분) 정확 기록·recordStopArrival 호출 확인 → 5일 추적한 "도착시간 안 찍힘" 해소(감지 로직 정상). **단 그 운행은 옛 캐시 번들(70e47fc7)** 이라 routePath 백필 OFF(경합) → 100m 직접감지만 작동 → **첫 정류장(출발지)만 누락**(출발지 좌표가 routePath에서 벗어나 100m 반경 밖). 그래서 "다음" 포인터가 stop0에 갇혀 지연이 누적되어 보임(사용자 호소). **downstream은 정상**(마지막 실제도착+계획 인터벌로 재계산: 데이터상 hUvsP 07:13 도착→다음 07:18=+5분 인터벌). **최신 빌드(ref-getter 백필)는 첫 정류장도 progress로 잡아** 누락·누적 둘 다 해소 — 폰이 최신 빌드 수신해야 발현(위 `[미해결]`).

- `[해결]` 런타임 정렬: `firebase.json` `nodejs22` → `nodejs20`(`package.json` `engines.node:"20"`, 2026-05-16). 데드라인 2026-10-30 전 22 재상향 필요(tasks.md 백로그).

- `[해결]` `companyId` 하드코딩 5지점 → **`src/lib/companyResolver.js` 통합(2026-05-28 SaaS Phase 1.1)**: `HOSTNAME_TO_COMPANY` 맵 + `resolveCompanyIdForAuth/Anon/resolveByHostname` 헬퍼. App.js Auth users 분기·DriverApp(2지점)·EmployeeApp·PassengerApp 모두 동적. SW(firebase-messaging-sw.js)는 build-time import 불가로 동일 맵 인라인 복제(동기화 필요 주석). dy001 폴백 유지 — 동영관광 운영 보호(명시 결정). 신규 회사 추가 시 HOSTNAME_TO_COMPANY 양쪽(js/SW) + companies/{cid} 도큐먼트(CF createCompany)만 갱신.

- `[해결]` `.env.example` 추가됨 (`5fa0737`, 2026-05-18) — 키 목록+가이드, 값은 .env.local에. 어느 PC든 부트스트랩 가능.

- `[해결]` **partnerCodes 복합 인덱스 누락**: `firestore.indexes.json`에 `partnerCodes (companyId ASC + active ASC)` 추가·배포(2026-05-16).

- `[해결]` **기사 onCall 4종 admin 역할 미검증**: `functions/index.js` `assertAdmin(request)` 헬퍼로 `users/{uid}.role∈{admin,superadmin}` 검증, 4종 진입부 적용·배포(2026-05-16). 익명 토큰만으로는 차단.
