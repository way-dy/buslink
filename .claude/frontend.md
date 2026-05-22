# Frontend

CRA 단일 SPA. 진입점 `src/index.js` → `src/App.js`. 페이지는 `src/pages/*`, 공용 로직은 `src/lib/*`. 전역 상태관리 라이브러리 없음 — React hooks + Firestore `onSnapshot` 실시간 구독.

## 라우팅 (react-router 없음)
`src/App.js`가 `window.location.pathname` 접두사로 분기. **검사 순서 = 우선순위**. `/p`가 `/partner`를 삼키므로 EmployeeApp 분기에서 `/partner` 명시 제외:
- `/` → Firebase Auth 로그인. `users/{uid}.role` admin/superadmin→`AdminApp`. **기사 역할은 `/driver`로 자동 리다이렉트**(`window.location.replace` — PWA scope 분리, 2026-05-22).
- `/driver*` → `DriverApp` (Auth 후. PWA scope `/driver` — 직원앱 `/p`와 scope 중첩 회피. `/`는 "그 외" 분기라 Auth·loading·kakao 로직 그대로 적용).
- `/bus*` → `PassengerApp` (익명. param `c`=companyId, `route`/`r`=routeId). 노선 결정 우선순위 **URL `route`/`r` > localStorage `buslink_passenger_route_{companyId}` > 노선 선택 화면**(미선택 시). 승객이 앱에서 선택하면 기준노선으로 localStorage 저장(다음 방문 자동), 상단 "노선 변경" 버튼으로 갱신.
- `/board*` → `BoardingApp` (QR 토큰 `t`로 탑승 확인)
- `/partner*` → `PartnerApp` (Firebase 로그인 없음 — 업체코드 기반)
- `/p*`(≠`/partner`) → `EmployeeApp` (익명 + localStorage 세션)

지도 화면(`/`,`/bus`,`/p`)은 `window.kakao` 로드 전 차단(5초 타임아웃 후 진행).

## 인증 모델 (두 갈래)
- **기사/관리자**: Firebase Email/Password. 이메일=합성값 `${empNo}@buslink.com`, PIN=비밀번호. 권한은 `users/{uid}`(`role`+`companyId`).
- **승객/직원/협력사**: `signInAnonymously` + 자체 검증. PIN은 `lib/partner.js hashPin`(SHA-256, salt `buslink_salt_2026`). 협력사는 `partnerCodes/{code}` 검증으로 진입.

## 상태/패턴
- 실시간 차량 위치: `onSnapshot` → `useAnimatedPositions`(rAF 보간) 훅 경유.
- EmployeeApp 세션: localStorage `buslink_employee` 키에 `{empNo,name,dept,routeId,...}` 저장/복원. `/p` 홈탭은 헤더 "노선 변경" 모달로 `routeId` 갱신(`onSessionUpdate`→`saveSession` 영속, 기준노선), 지도 전 정류장 이름 표시·마커/라벨 클릭 시 정류장 정보 카드(사진/설명).
- AdminApp: 관리자 기능은 `httpsCallable`로 Cloud Functions 호출(@.claude/functions.md).
- `companyId` 기본값 `dy001`이 다수 페이지에 하드코딩(@.claude/issues.md).
