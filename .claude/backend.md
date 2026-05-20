# Backend (Firestore)

멀티테넌트 구조지만 현재 단일 실테넌트(`dy001`).

## 컬렉션 구조
`companies/{companyId}/`:
- `routes/{routeId}` — `name/code/type/shift/seats/departTime/partnerCode…` + (선택) **`routePath: [{lat,lng}]`**(관리자가 수동으로 그린 경로 폴리라인, plain number·GeoPoint 아님. 빈배열/없음=미설정→승객앱 stops 직선 폴백)
- `routes/{routeId}/stops/{stopId}` — `name/address/lat/lng/order` + (선택) `photo`(클라 압축 JPEG data URI 문자열, Storage 미사용)·`description`(승객 안내문)·**`offsetMin`**(number, 노선 `departTime` 기준 진입 분 오프셋. null/없음=미설정→폴백)
- `dispatches/{date}/list/{dispatchId}` + (선택) **`stopArrivals: { [stopId]: { actualAt: serverTimestamp, plannedAt: "HH:MM"|null, delaySec: number|null } }`**(기사가 도착감지 시 기록, 첫 도착만 멱등 기록·덮어쓰기 금지) · CF가 펼친 분은 `scheduleId/source:"schedule"` 필드 추가
- **`dispatchSchedules/{scheduleId}`** — 반복 배차 패턴 정본(2026-05-20). `name/routeId/routeName/driverId/driverName/vehicleId/vehicleNo/departTime/startDate/endDate(null=무기한)/weekdays:number[](0=일~6=토)/excludeDates:string[]/excludeHolidays:boolean/active:boolean`. CF `expandDispatchSchedules`가 매일 새벽 향후 7일치 dispatches로 펼침(멱등 ID=`${scheduleId}_${day}`)
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
- `dispatches/{date}/list/{id}`: admin 전체 write. **기사 본인 dispatch 의 `stopArrivals` 필드만 update 가능**(`drivers/{dispatch.driverId}.uid == request.auth.uid` 검증·affectedKeys hasOnly `[stopArrivals]`. 운행 중 정류장 100m 진입 시 클라가 update). 멱등은 클라가 첫도착만 write로 가드(서버 룰은 필드 범위만 강제).
- `boardingTokens`/`partnerCodes`: read 공개(`true`), 소각/생성은 인증 사용자.
- `fcmQueue`: create만 인증, read/update는 `false`(CF 전용).
- ⚠️ `src/firestore.rules`는 **오래된 사본** — @.claude/issues.md.

## 인덱스
신규 복합 쿼리 추가 시 `firestore.indexes.json` 갱신. 현재: list(driverId+departTime, empNo+boardedAt), passengers(partnerCode+active), partnerCodes(companyId+createdAt), notices(active+createdAt).
