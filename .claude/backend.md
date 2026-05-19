# Backend (Firestore)

멀티테넌트 구조지만 현재 단일 실테넌트(`dy001`).

## 컬렉션 구조
`companies/{companyId}/`:
- `routes/{routeId}` — `name/code/type/shift/seats/departTime/partnerCode…` + (선택) **`routePath: [{lat,lng}]`**(관리자가 수동으로 그린 경로 폴리라인, plain number·GeoPoint 아님. 빈배열/없음=미설정→승객앱 stops 직선 폴백)
- `routes/{routeId}/stops/{stopId}` — `name/address/lat/lng/order` + (선택) `photo`(클라 압축 JPEG data URI 문자열, Storage 미사용)·`description`(승객 안내문)
- `dispatches/{date}/list/{dispatchId}`
- `drivers/{driverId}`, `vehicles/{vehicleId}`
- `passengers/{empNo}` (PIN 해시·노선 배정)
- `boardings/{date}/list/{boardingId}`
- `fcmTokens/{empNo}`, `notices/{noticeId}`

최상위:
- `users/{uid}` — **권한 게이트**(`role`+`companyId`). App.js·규칙·Functions가 함께 읽음.
- `gps/{companyId}_{vehicleId}` — 실시간 위치(덮어쓰기)
- `gpsHistory/{companyId}/{vehicleId}/{date}/points/{pointId}`
- `boardingTokens/{tokenId}` — 5분 만료·1회 소각(`used` 플래그)
- `partnerCodes/{code}` — 협력사 코드(1년 유효)
- `fcmQueue/{queueId}` — CF 트리거 큐(클라 write, CF read)

## 보안 규칙
배포 정본은 **루트 `firestore.rules`**(`firebase.json`이 지목). 헬퍼: `isAuth`/`isAdmin(companyId)`/`isSuperAdmin`/`isDriverOf(companyId)`.
- `users`: 본인 또는 superadmin만 read, write는 superadmin.
- `companies/**`: read는 인증 사용자, write는 해당 회사 admin.
- `drivers`: 기사 본인은 `status/uid/startedAt/endedAt`만 update.
- `boardingTokens`/`partnerCodes`: read 공개(`true`), 소각/생성은 인증 사용자.
- `fcmQueue`: create만 인증, read/update는 `false`(CF 전용).
- ⚠️ `src/firestore.rules`는 **오래된 사본** — @.claude/issues.md.

## 인덱스
신규 복합 쿼리 추가 시 `firestore.indexes.json` 갱신. 현재: list(driverId+departTime, empNo+boardedAt), passengers(partnerCode+active), partnerCodes(companyId+createdAt), notices(active+createdAt).
