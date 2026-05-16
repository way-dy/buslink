# Cloud Functions

`functions/index.js` — Firebase Functions **v2**, region `us-central1`, CommonJS. 독립 npm 패키지(`firebase-admin`, `firebase-functions`).

## 함수 목록
| 함수 | 트리거 | 역할 |
|---|---|---|
| `sendNoticeToCompany` | Firestore `onDocumentCreated("fcmQueue/{queueId}")` | 회사 `fcmTokens` 멀티캐스트, 500개 청크, 만료 토큰 자동 삭제 |
| `createDriver` | `onCall` | Auth 계정 + `users/{uid}` + `companies/.../drivers` 동시 생성 |
| `deleteDriver` | `onCall` | Auth/users/drivers 정합 삭제 |
| `updateDriverPassword` | `onCall` | 기사 비밀번호 변경(≥6자) |
| `createDriverAuth` | `onCall` | 기존 기사에 Auth 계정 부여(이메일 중복 시 복구) |

## 트리거 흐름 — 공지/FCM
AdminApp `sendNotice` → `companies/{cid}/notices` + 최상위 `fcmQueue` 문서 생성 → `sendNoticeToCompany`가 `companies/{cid}/fcmTokens` 토큰 수집 → `sendEachForMulticast` → `fcmQueue.status` 갱신(`sent`/`no_tokens`/`error`). 무효 토큰은 `fcmTokens`에서 자동 삭제.

## 주의사항
- onCall 함수는 모두 `request.auth` 필수(미인증 시 `unauthenticated`).
- 합성 이메일 규칙 `${empNo}@buslink.com` — 기사 생성/삭제 시 Auth·`users`·`drivers` 3곳 정합 유지가 핵심.
- `createDriverAuth`는 `auth/email-already-exists` 시 기존 계정 비밀번호 갱신으로 복구.
- 런타임 불일치·구버전 스니펫 등 함정은 @.claude/issues.md.
