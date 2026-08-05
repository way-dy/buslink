# Issues Log (완결된 옛 이슈 아카이브)

> issues.md 에서 이관. @import 하지 않는다 — 회귀 가드가 살아 있는 항목은 issues.md 에 남겨 둔다.

## 2026-05~06 인프라 수정 (이관 2026-08-05)

- `[해결]` **🟢 폰 최신빌드 미수신 블로커(2026-06-05 미해결 → 2026-06-09 해소)**: 진단 `appVersion`·화면 빌드뱃지 도입으로 옛/새 즉시 판별 가능해졌고, 이후 운행 진단 JSON 에 `appVersion` 정상 반환 = 폰이 신빌드 실행 입증. 캐시는 더 이상 블로커 아님. **교훈**: 진단으로 "데이터 없음"이 안 갈리면 진단 채널이 필드를 안 보여주는 것일 수 있다(아래 `[패턴] 도착 감지·표시 최종 구조` ① 참조).

- `[해결]` **🟢 도착 감지 작동 입증(2026-06-05 시크릿 운행)** + **첫 정류장 누락 근인**: 7정류장 `source:"actual"` 도착·실측지연(도착−계획, 예: +7분/+9분) 정확 기록·recordStopArrival 호출 확인 → 5일 추적한 "도착시간 안 찍힘" 해소(감지 로직 정상). **단 그 운행은 옛 캐시 번들(70e47fc7)** 이라 routePath 백필 OFF(경합) → 100m 직접감지만 작동 → **첫 정류장(출발지)만 누락**(출발지 좌표가 routePath에서 벗어나 100m 반경 밖). 그래서 "다음" 포인터가 stop0에 갇혀 지연이 누적되어 보임(사용자 호소). **downstream은 정상**(마지막 실제도착+계획 인터벌로 재계산: 데이터상 hUvsP 07:13 도착→다음 07:18=+5분 인터벌). **최신 빌드(ref-getter 백필)는 첫 정류장도 progress로 잡아** 누락·누적 둘 다 해소 — 폰이 최신 빌드 수신해야 발현(위 `[미해결]`).

- `[해결]` 런타임 정렬: `firebase.json` `nodejs22` → `nodejs20`(`package.json` `engines.node:"20"`, 2026-05-16). 데드라인 2026-10-30 전 22 재상향 필요(tasks.md 백로그).

- `[해결]` `companyId` 하드코딩 5지점 → **`src/lib/companyResolver.js` 통합(2026-05-28 SaaS Phase 1.1)**: `HOSTNAME_TO_COMPANY` 맵 + `resolveCompanyIdForAuth/Anon/resolveByHostname` 헬퍼. App.js Auth users 분기·DriverApp(2지점)·EmployeeApp·PassengerApp 모두 동적. SW(firebase-messaging-sw.js)는 build-time import 불가로 동일 맵 인라인 복제(동기화 필요 주석). dy001 폴백 유지 — 동영관광 운영 보호(명시 결정). 신규 회사 추가 시 HOSTNAME_TO_COMPANY 양쪽(js/SW) + companies/{cid} 도큐먼트(CF createCompany)만 갱신.

- `[해결]` `.env.example` 추가됨 (`5fa0737`, 2026-05-18) — 키 목록+가이드, 값은 .env.local에. 어느 PC든 부트스트랩 가능.

- `[해결]` **partnerCodes 복합 인덱스 누락**: `firestore.indexes.json`에 `partnerCodes (companyId ASC + active ASC)` 추가·배포(2026-05-16).

- `[해결]` **기사 onCall 4종 admin 역할 미검증**: `functions/index.js` `assertAdmin(request)` 헬퍼로 `users/{uid}.role∈{admin,superadmin}` 검증, 4종 진입부 적용·배포(2026-05-16). 익명 토큰만으로는 차단.
