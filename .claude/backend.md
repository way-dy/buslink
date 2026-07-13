# Backend (Firestore)

멀티테넌트 구조지만 현재 단일 실테넌트(`dy001`).

## 컬렉션 구조
`companies/{companyId}/`:
- `routes/{routeId}` — `name/code/type/shift/seats/departTime/partnerCode…` + (선택, 2026-07-10) **`order`**(number, 승객·직원앱 노선 목록 표시 순서. null/부재=맨 뒤. 정렬 규칙 정본=`src/lib/routeOrder.js compareRoutes`) + (선택) **`routePath: [{lat,lng}]`**(관리자가 수동으로 그린 경로 폴리라인, plain number·GeoPoint 아님. 빈배열/없음=미설정→승객앱 stops 직선 폴백)
- `routes/{routeId}/stops/{stopId}` — `name/address/lat/lng/order` + (선택) `photo`(클라 압축 JPEG data URI 문자열, Storage 미사용)·`description`(승객 안내문)·**`offsetMin`**(number, 노선 `departTime` 기준 진입 분 오프셋. null/없음=미설정→폴백)
- `dispatches/{date}/list/{dispatchId}` + (선택) **`stopArrivals: { [stopId]: { actualAt: serverTimestamp, plannedAt: "HH:MM"|null, delaySec: number|null, estimated: boolean } }`**(기사가 도착감지 시 기록, 첫 도착만 멱등 기록·덮어쓰기 금지. `estimated:true`=GPS 복구 진행률 백필로 회복한 통과 누락분, 2026-05-22) · (선택) **`preArrivalNotified: string[]`**(도착 임박 푸시 멱등 마커 `"{stopId}:pre1"`/`"pre2"`, CF `notifyPreArrival`가 `arrayUnion` 기록, 2026-05-22) · CF가 펼친 분은 `scheduleId/source:"schedule"` 필드 추가
- **`dispatchSchedules/{scheduleId}`** — 반복 배차 패턴 정본(2026-05-20). `name/routeId/routeName/driverId/driverName/vehicleId/vehicleNo/departTime/startDate/endDate(null=무기한)/weekdays:number[](0=일~6=토)/excludeDates:string[]/excludeHolidays:boolean/active:boolean`. CF `expandDispatchSchedules`가 매일 새벽 향후 7일치 dispatches로 펼침(멱등 ID=`${scheduleId}_${day}`)
- `drivers/{driverId}`, `vehicles/{vehicleId}` + (선택, 2026-07-08 RQ#2) **`gpsSource: "mobile"|"device"`**(부재=mobile — 클라 startGPS / device=GPS단말·서버 `pollDeviceVehicleGps` 폴링) · **`carId`**(device 일 때 busin 차량ID, `resolveBusinCarId` 로 번호→carId 조회 저장)
- `passengers/{empNo}` (PIN 해시·노선 배정)
- `boardings/{date}/list/{boardingId}` — `empNo/name/tokenId/companyId/routeId/routeName/vehicleId/vehicleNo/driverId/stopId/stopName/boardedAt` + **`partnerCode`**(null 가능, 2026-05-26 신규 — 직원의 passengers.partnerCode 자동 채움) + **`vehicleLat/vehicleLng/vehicleSpeed`**(null 가능, 2026-05-26 신규 — 탑승 시점 차량 GPS 캡처, 사후 정류장별 매핑용. `gps/{companyId}_{vehicleId}` 1회 getDoc). 둘 다 미수신/권한 오류 시 null, 통계에선 "미지정"/"GPS 없음"으로 분리
- `fcmTokens/{empNo}` — `token/empNo/companyId/partnerCode/updatedAt` + (선택) **`routeId/stopId/myStopUpdatedAt`**(도착 임박 푸시용 '내 정류장' denormalize, 2026-05-22. EmployeeApp `/p`에서 내 정류장 선택 시 `setDoc` merge, 해제·노선변경 시 null. CF `notifyPreArrival`가 where `routeId`+`stopId`로 대상 직원 검색). (partnerCode: 2026-05-21 추가, EmployeeApp 로그인 시 passengers.partnerCode 자동 sync, 없으면 null. CF 협력사 발송 시 where 필터)
- `notices/{noticeId}` — `title/body/type/companyId/partnerCode/active/createdAt` (partnerCode 2026-05-21 추가, null=전체) + (선택, 2026-05-29 Phase 1.4) **`sender:"partner"|undefined`**·**`senderCode:string|undefined`**(PartnerApp `sendPartnerNotice` 발송 분 식별용. admin 발송 분은 미존재 = "관리자". EmployeeApp NoticeTab·NoticesTab·NoticeForceModal·승객앱 공지배너는 옵셔널 필드 미사용 — read 호환 100%)

최상위:
- `users/{uid}` — **권한 게이트**(`role`+`companyId` + `name?`/`empNo?`/`email?`). App.js·규칙·Functions가 함께 읽음. (선택, 2026-05-29 Phase A) **`allowedPartnerCodes:string[]`** — admin 한정 협력사 권한 범위. `["*"]`=회사 본부(전체), `["code1","code2"]`=특정 협력사 한정. 필드 부재=기존 admin 호환(클라이언트 `?? ["*"]` 폴백·마이그 불필요). `createCompanyAdmin`/`updateCompanyAdminPermissions` 가 write, `listCompanyAdmins` 가 read 정규화. **Phase B(2026-06-08) 도입**: App.js→AdminApp prop→`src/lib/partnerAccess.js` 로 AdminApp 8지점이 read/표시 게이팅(클라만·rules 무변경). rules `users` write 는 여전히 superadmin 만 → 제한 admin self-update 불가(신규 발급 코드 자동 권한부여 안 됨·슈퍼관리자 부여 필요). 클라 필터는 우회 가능 → rules isAdmin 협력사 제약은 별도 후속.
- `gps/{companyId}_{vehicleId}` — 실시간 위치(덮어쓰기)
- `gpsHistory/{companyId}/{vehicleId}/{date}/points/{pointId}`
- `boardingTokens/{tokenId}` — 5분 만료·1회 소각(`used` 플래그)
- `partnerCodes/{code}` — 협력사 코드(1년 유효) + (선택, 2026-05-29 Phase 1.4) **`recentNoticeTimestamps:number[]`**(서버 시각 ms 배열, CF `sendPartnerNotice` 가 1시간 5건 rate-limit 용으로 옛 항목 정리 + now 추가. 부재=빈배열로 동작) + (선택, 2026-06-15) **`createdBy:uid`**(발급한 admin uid. `createPartnerCode` 가 기록 → 제한 admin 이 권한 부여 전에도 본인 생성 협력사 열람·관리. AdminApp PartnerTab·대시보드 가시범위 = `isAllAccess ? 전체 : allowed ∪ createdBy`. 부재=레거시, allowed 로만 노출)
- **`improvement_requests/{autoId}`** — 개선 요청 게시판(2026-07-13). `title/content(평문·개행 유지)/companyId/requesterUid/requesterName/requesterEmail/status('requested'|'reviewing'|'in_progress'|'done'|'rejected')/screenshots:[{dataUrl,name}](압축 data URI·Storage 미사용)/history:[{statusTo?,byUid,byName,at:Timestamp,comment?}]/resultNote?/createdAt/updatedAt`. **history 배열 요소는 serverTimestamp 불가 → `Timestamp.now()`**. 하위 컬렉션 없음(댓글=history arrayUnion). 회사 admin=자기 회사만, superadmin=전 회사. 정본 data-access=`src/lib/improvementRequests.js`. 인앱 안읽음=`src/lib/improvementSeen.js`(localStorage, 백엔드 변경 0).
- **`config/{docId}`** — 앱 설정(2026-07-13). `config/improvementBoard.gchatWebhookUrl`(개선 요청 구글챗 웹훅·시크릿 아님·슈퍼관리자 콘솔 입력·미설정이면 CF skip). read/write=superadmin만.
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
- `improvement_requests`(2026-07-13): read/create/update/delete = `isSuperAdmin() || isAdmin(companyId)`(create 는 request.resource.data.companyId, 나머지는 resource.data.companyId). `config/{docId}`: read/write=`isSuperAdmin()`. catch-all 없어 명시 블록 필수.
- ⚠️ `src/firestore.rules`는 **오래된 사본** — @.claude/issues.md.

## 인덱스
신규 복합 쿼리 추가 시 `firestore.indexes.json` 갱신. 현재: list(driverId+departTime, empNo+boardedAt), passengers(partnerCode+active), partnerCodes(companyId+createdAt), notices(active+createdAt), **improvement_requests(companyId+createdAt DESC)**(회사 admin 스코프 쿼리용·superadmin 은 orderBy createdAt 단일필드라 자동 인덱스).
