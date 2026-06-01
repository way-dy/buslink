# Backend (Firestore)

멀티테넌트 구조지만 현재 단일 실테넌트(`dy001`).

## 컬렉션 구조
`companies/{companyId}/`:
- `routes/{routeId}` — `name/code/type/shift/seats/departTime/partnerCode…` + (선택) **`routePath: [{lat,lng}]`**(관리자가 수동으로 그린 경로 폴리라인, plain number·GeoPoint 아님. 빈배열/없음=미설정→승객앱 stops 직선 폴백)
- `routes/{routeId}/stops/{stopId}` — `name/address/lat/lng/order` + (선택) `photo`(클라 압축 JPEG data URI 문자열, Storage 미사용)·`description`(승객 안내문)·**`offsetMin`**(number, 노선 `departTime` 기준 진입 분 오프셋. null/없음=미설정→폴백)
- `dispatches/{date}/list/{dispatchId}` + (선택) **`stopArrivals: { [stopId]: { actualAt: serverTimestamp, plannedAt: "HH:MM"|null, delaySec: number|null, estimated: boolean } }`**(기사가 도착감지 시 기록, 첫 도착만 멱등 기록·덮어쓰기 금지. `estimated:true`=GPS 복구 진행률 백필로 회복한 통과 누락분, 2026-05-22) · (선택) **`preArrivalNotified: string[]`**(도착 임박 푸시 멱등 마커 `"{stopId}:pre1"`/`"pre2"`, CF `notifyPreArrival`가 `arrayUnion` 기록, 2026-05-22) · CF가 펼친 분은 `scheduleId/source:"schedule"` 필드 추가
- **`dispatchSchedules/{scheduleId}`** — 반복 배차 패턴 정본(2026-05-20). `name/routeId/routeName/driverId/driverName/vehicleId/vehicleNo/departTime/startDate/endDate(null=무기한)/weekdays:number[](0=일~6=토)/excludeDates:string[]/excludeHolidays:boolean/active:boolean`. CF `expandDispatchSchedules`가 매일 새벽 향후 7일치 dispatches로 펼침(멱등 ID=`${scheduleId}_${day}`)
- `drivers/{driverId}`, `vehicles/{vehicleId}`
- `passengers/{empNo}` (PIN 해시·노선 배정)
- `boardings/{date}/list/{boardingId}` — `empNo/name/tokenId/companyId/routeId/routeName/vehicleId/vehicleNo/driverId/stopId/stopName/boardedAt` + **`partnerCode`**(null 가능, 2026-05-26 신규 — 직원의 passengers.partnerCode 자동 채움) + **`vehicleLat/vehicleLng/vehicleSpeed`**(null 가능, 2026-05-26 신규 — 탑승 시점 차량 GPS 캡처, 사후 정류장별 매핑용. `gps/{companyId}_{vehicleId}` 1회 getDoc). 둘 다 미수신/권한 오류 시 null, 통계에선 "미지정"/"GPS 없음"으로 분리
- `fcmTokens/{empNo}` — `token/empNo/companyId/partnerCode/updatedAt` + (선택) **`routeId/stopId/myStopUpdatedAt`**(도착 임박 푸시용 '내 정류장' denormalize, 2026-05-22. EmployeeApp `/p`에서 내 정류장 선택 시 `setDoc` merge, 해제·노선변경 시 null. CF `notifyPreArrival`가 where `routeId`+`stopId`로 대상 직원 검색). (partnerCode: 2026-05-21 추가, EmployeeApp 로그인 시 passengers.partnerCode 자동 sync, 없으면 null. CF 협력사 발송 시 where 필터)
- `notices/{noticeId}` — `title/body/type/companyId/partnerCode/active/createdAt` (partnerCode 2026-05-21 추가, null=전체) + (선택, 2026-05-29 Phase 1.4) **`sender:"partner"|undefined`**·**`senderCode:string|undefined`**(PartnerApp `sendPartnerNotice` 발송 분 식별용. admin 발송 분은 미존재 = "관리자". EmployeeApp NoticeTab·NoticesTab·NoticeForceModal·승객앱 공지배너는 옵셔널 필드 미사용 — read 호환 100%)

최상위:
- `users/{uid}` — **권한 게이트**(`role`+`companyId` + `name?`/`empNo?`/`email?`). App.js·규칙·Functions가 함께 읽음. (선택, 2026-05-29 Phase A) **`allowedPartnerCodes:string[]`** — admin 한정 협력사 권한 범위. `["*"]`=회사 본부(전체), `["code1","code2"]`=특정 협력사 한정. 필드 부재=기존 admin 호환(클라이언트 `?? ["*"]` 폴백·마이그 불필요). `createCompanyAdmin`/`updateCompanyAdminPermissions` 가 write, `listCompanyAdmins` 가 read 정규화. Phase B(AdminApp 협력사 필터 자동 적용) 미도입 — 데이터만 누적.
- `gps/{companyId}_{vehicleId}` — 실시간 위치(덮어쓰기)
- `gpsHistory/{companyId}/{vehicleId}/{date}/points/{pointId}`
- `boardingTokens/{tokenId}` — 5분 만료·1회 소각(`used` 플래그)
- `partnerCodes/{code}` — 협력사 코드(1년 유효) + (선택, 2026-05-29 Phase 1.4) **`recentNoticeTimestamps:number[]`**(서버 시각 ms 배열, CF `sendPartnerNotice` 가 1시간 5건 rate-limit 용으로 옛 항목 정리 + now 추가. 부재=빈배열로 동작)
- `fcmQueue/{queueId}` — CF 트리거 큐. `companyId/noticeId/title/body/type/partnerCode/status/totalTokens/successCount/failureCount/error`. status: pending→sent/no_tokens/error. admin은 자기회사 큐 read 가능(2026-05-21, 발송 결과 onSnapshot 구독용)

## 보안 규칙
배포 정본은 **루트 `firestore.rules`**(`firebase.json`이 지목). 헬퍼: `isAuth`/`isAdmin(companyId)`/`isSuperAdmin`/`isDriverOf(companyId)`.
- `users`: 본인 또는 superadmin만 read, write는 superadmin.
- `companies/**`: read는 인증 사용자, write는 해당 회사 admin.
- `drivers`: 기사 본인은 `status/uid/startedAt/endedAt`만 update.
- `dispatches/{date}/list/{id}`: admin 전체 write. **기사 본인 dispatch 의 `stopArrivals` 필드만 update 가능**(`drivers/{dispatch.driverId}.uid == request.auth.uid` 검증·affectedKeys hasOnly `[stopArrivals]`. 운행 중 정류장 100m 진입 시 클라가 update). 멱등은 클라가 첫도착만 write로 가드(서버 룰은 필드 범위만 강제).
- `boardingTokens`/`partnerCodes`: read 공개(`true`), 소각/생성은 인증 사용자.
- `boardings/{date}/list/{id}`: read·create = `isAuth()`(2026-05-26 완화 — 협력사 포털 통계 view 위해 admin→isAuth), update/delete는 admin. ⚠ BoardingApp·EmployeeApp·PassengerApp·PartnerApp·DriverApp 모든 진입점이 `signInAnonymously` 호출 필요(인증 누락 시 silent create 차단 → 통계 결측, 2026-05-26 BoardingApp 결함 사례 참조).
- `partnerCodes`: read 공개, create/update = `isAuth()`, delete = `isAdmin(resource.data.companyId)`(2026-05-26 — admin이 자기 회사 협력사 영구 삭제 가능, UI는 비활성 상태에서만 허용).
- `fcmQueue`: create만 인증, read는 admin(자기 회사 companyId 일치), update는 `false`(CF 전용). admin read 필요 이유=NoticeTab이 발송 결과(status/successCount/totalTokens) 실시간 onSnapshot 구독.
- ⚠️ `src/firestore.rules`는 **오래된 사본** — @.claude/issues.md.

## 인덱스
신규 복합 쿼리 추가 시 `firestore.indexes.json` 갱신. 현재: list(driverId+departTime, empNo+boardedAt), passengers(partnerCode+active), partnerCodes(companyId+createdAt), notices(active+createdAt).
