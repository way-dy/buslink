# Cloud Functions

`functions/index.js` — Firebase Functions **v2**, region `us-central1`, CommonJS. 독립 npm 패키지(`firebase-admin`, `firebase-functions`).

## 함수 목록
| 함수 | 트리거 | 역할 |
|---|---|---|
| `sendNoticeToCompany` | Firestore `onDocumentCreated("fcmQueue/{queueId}")` | 회사 `fcmTokens` 멀티캐스트(2026-05-21: `partnerCode` 있으면 `.where("partnerCode","==",X)` 협력사 한정, 없으면 전체). 500개 청크, 만료 토큰 자동 삭제. 결과 `fcmQueue.status`(`sent`/`no_tokens`/`error`) + `totalTokens`/`successCount`/`failureCount` 기록 → AdminApp이 onSnapshot으로 실시간 표시 |
| `createDriver` | `onCall` | Auth 계정 + `users/{uid}` + `companies/.../drivers` 동시 생성 |
| `deleteDriver` | `onCall` | Auth/users/drivers 정합 삭제 |
| `updateDriverPassword` | `onCall` | 기사 비밀번호 변경(≥6자) |
| `createDriverAuth` | `onCall` | 기존 기사에 Auth 계정 부여(이메일 중복 시 복구) |
| `expandDispatchSchedules` | `onSchedule("30 0 * * *", Asia/Seoul)` | 매일 새벽 00:30 향후 7일치 dispatches 자동 펼침. companies 전체 순회 + dispatchSchedules where active==true |
| `expandDispatchSchedulesNow` | `onCall` | AdminApp "지금 펼치기" 즉시 트리거. 같은 companyId 한정. 멱등 `${scheduleId}_${day}` dispatch ID — 기존 일별 수동 수정 보존 |

## 트리거 흐름 — 공지/FCM
AdminApp `sendNotice({companyId, title, body, type, partnerCode?})` → `companies/{cid}/notices`(partnerCode 포함) + 최상위 `fcmQueue` 문서 생성 → `sendNoticeToCompany`가 partnerCode 있으면 `where("partnerCode","==",X)` 협력사 토큰만 수집(없으면 전체 — partnerCode 필드 누락한 기존 토큰도 포함) → `sendEachForMulticast` → `fcmQueue` 문서에 status(`sent`/`no_tokens`/`error`) + totalTokens/successCount/failureCount 갱신. NoticeTab은 발송 직후 `fcmQueue/{queueId}` 단일 doc onSnapshot 구독 → 결과 카드 실시간 표시(pending→완료/0건/오류). 무효 토큰은 `fcmTokens`에서 자동 삭제.

## 주의사항
- onCall 함수는 모두 `request.auth` 필수(미인증 시 `unauthenticated`).
- 합성 이메일 규칙 `${empNo}@buslink.com` — 기사 생성/삭제 시 Auth·`users`·`drivers` 3곳 정합 유지가 핵심.
- `createDriverAuth`는 `auth/email-already-exists` 시 기존 계정 비밀번호 갱신으로 복구.
- `expandDispatchSchedules*`: 한국 공휴일 정적 데이터 `functions/holidays.js` (클라 사본 `src/lib/holidays.js`). **2028년까지 작성, 2028 말 전 갱신 필요**(issues.md). 멱등 dispatchId=`${scheduleId}_${day}` — exists() skip → 일별 수동 수정/기사교체 보존. Cloud Scheduler API 첫 배포 시 자동 활성화됨(`cloudscheduler.googleapis.com`).
- 런타임 불일치·구버전 스니펫 등 함정은 @.claude/issues.md.
