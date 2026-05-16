# Issues & 주의할 패턴

> 새 발견사항은 이 파일에만 추가. 형식: `[미해결]` / `[해결]` / `[패턴]`.

## 미해결 / 함정
- `[미해결]` **firestore.rules 이중화**: 배포 정본은 루트 `firestore.rules`(`firebase.json` 지목, fcmTokens/notices/fcmQueue 포함). `src/firestore.rules`는 오래된 사본 — 수정해도 효과 없음. 규칙 변경은 반드시 루트 파일에.
- `[미해결]` 런타임 불일치: `firebase.json` functions runtime `nodejs22` vs `functions/package.json` `engines.node:"20"`. Functions 손대기 전 정렬.
- `[미해결]` `public/firebase-messaging-sw.js` Firebase 설정이 **하드코딩**(env 아님). 프로젝트 변경 시 수동 동기화 필요. `notificationclick`에 `buslink-prod.web.app`·fallback `dy001` 하드코딩.
- `[미해결]` `companyId` 기본값 `dy001`이 App.js·DriverApp·PassengerApp·EmployeeApp·SW에 하드코딩. 신규 회사 추가 시 전부 추적.
- `[미해결]` `.env.example` 없음 — `REACT_APP_*` 값은 사용자에게 확인 필요.

## 주의할 패턴
- `[패턴]` `lib/notifications.js`는 `getToken` 전 기존 push subscription을 `unsubscribe` — VAPID 키 교체 충돌 방지(삭제 금지).
- `[패턴]` 루트 `CLOUD_FUNCTION_FCM.js`는 v1 문법 옛 참고 스니펫 — 실배포 코드 아님. 실제는 `functions/index.js`(v2).
- `[패턴]` `boardingTokens`/`partnerCodes`는 규칙상 read 공개(`true`) — 토큰 추측·코드 유출 주의.
- `[패턴]` 실 테스트/별도 lint 없음 — 수동 검증. 배포는 사용자 명시 요청 시에만.

## 저장소 메모
- `src.zip` git 추적되나 작업트리 삭제 상태(소스 백업 산출물, 빌드 미사용).
