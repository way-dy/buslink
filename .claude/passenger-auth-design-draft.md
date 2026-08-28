# 승객 인증 구조 — 설계 초안 (2026-08-25 미팅, way 검토용)

> 상태: **P0·P1·P2 배포 완료(2026-08-28 실측 확인) · P3 설계 완료·착수 전 · P4·P5 착수 전**(2026-08-28 갱신). 세 가지 요구가 **같은 뿌리** 하나에 걸려 있어 묶었다.
> ① 고정 QR 로그인 우회 차단(미팅 요청 · **1차 조치는 배포 대기**) ② 초기 PIN `000000` 통일 + 로그인
> 화면 안내(미팅 요청) ③ 명부 전체가 익명에게 열려 있음(작업 중 발견).

## 뿌리 — 승객에게는 신원이 없다
승객 로그인은 Firebase Auth 가 아니다. 앱이 `companies/{cid}/passengers/{empNo}` 를 **클라에서 직접
읽어** `pinHash` 를 비교하고, 결과를 `localStorage` 에 넣는 게 전부다. 모든 승객은 서버 입장에서
**익명 사용자 한 종류**다. 그래서:
- `firestore.rules` 의 `passengers` 가 `allow read: if isAuth()` 일 수밖에 없다 — 로그인하려면 그 문서를
  먼저 읽어야 하니까. 즉 **익명 인증만 받으면 누구나 명부 263건 전체**(이름·부서·거래처·사번·`pinHash`)를
  읽는다. `pinHash` 는 비밀이 아니다.
- 규칙으로 "본인 문서만"을 쓸 수가 없다 — 요청자를 특정할 값이 토큰에 없다.
- 그래서 ①의 1차 조치(`boardStatic` 이 `pinHash` 대조)는 **무작위 입력은 확실히 막지만** 명부를
  읽을 수 있는 사람까지는 못 막는다. 구조를 안 바꾸면 여기가 상한선이다.
- ②의 `000000` 은 이 상태에서 **명부에 있는 사람 전원의 계정을 여는 것**과 같다(사번은 명부에 있고
  초기 PIN 은 공지된 값). 지금 그대로 켜면 안 된다.

## 제안 — 승객에게 진짜 신원을 준다(커스텀 토큰)
1. **CF `passengerLogin({ companyId, empNo, pin })`** — Admin SDK 로 명부를 읽어 PIN 을 대조하고,
   통과하면 `createCustomToken(uid, { companyId, empNo, partnerCode })` 을 돌려준다.
   클라는 `signInWithCustomToken` → 이제 **승객마다 uid 와 클레임**이 생긴다.
2. **`boardStatic` 은 `pinHash` 를 안 받는다** — `request.auth.token.empNo` 를 쓴다. 위조 불가.
3. **rules 를 신원으로 좁힌다** — `passengers/{empNo}` read 를 `isAdmin() || isDriver() ||
   request.auth.token.empNo == empNo` 로. 명부 전체 열람이 닫힌다.
4. 그다음에야 **초기 PIN `000000` + 로그인 화면 안내**를 켠다(사번 목록을 못 얻으므로 위험이 내려간다).

## 걸림돌 — 명부를 읽는 곳이 승객앱만이 아니다
전수(`grep '"passengers"' src/`): **PartnerApp 이 최대 난관**이다. 협력사 포털은 Firebase Auth 가 아니라
**거래처 코드**로 들어오는 익명 화면인데 명부를 **읽고·수정하고·삭제**한다(`PartnerApp.js:611·783·822·841·1431·1750`).
승객 신원을 만들어도 이쪽은 안 풀린다 → **포털용 CF**(코드 검증 후 Admin SDK 대행)가 따로 필요하다.
나머지는 가볍다: AdminApp(관리자 Auth·그대로) · DriverApp(기사 Auth·`routeId` 명단) ·
EmployeeApp 본인 문서 read/update(즐겨찾기·PIN 변경 — 클레임으로 커버).

## 단계 (뒤 단계는 앞 단계 없이 못 간다)
| 단계 | 내용 | 크기 | 이 단계가 여는 것 |
|---|---|---|---|
| P0 | `boardStatic` 본인 확인 ✅**배포 완료** | 소 | 무작위 사번 탑승 차단 |
| P1 | CF `passengerLogin` + 커스텀 토큰 + 클라 전환 ✅**코드 완료·미배포** | 중 | 승객 신원 생성. **회귀 표면 = 258명 전원의 로그인**(실측 기준 명부 258명·로그인 이력 124명) |
| P2 | `boardStatic`·PIN 변경을 클레임 기준으로 ✅**코드 완료·미배포** | 소 | 세션에서 `pinHash` 제거(단, 명부 read 는 P4 까지 남는다) |
| P3 | PartnerApp 명부 CRUD 를 포털 CF 로 이관 → **a·b·c 로 쪼갬**(아래 절) | **대** | 익명 명부 접근의 마지막 경로 제거 |
| P4 | `passengers` rules 를 신원으로 좁힘 | 소 | **명부 전체 열람 차단** |
| P5 | 초기 PIN `000000` + 로그인 화면 안내 | 소 | 미팅 요청 ② 충족 |

## 결정이 필요한 것 (내 추천을 적어 둔다)
1. **P5 를 P4 앞으로 당길지** — 신촌 세브란스가 이번 주 일괄 등록한다. 추천 = **당기지 않는다**.
   대신 P0 배포 후 **초기 PIN 을 거래처 단위로 지정**할 수 있게 해 `000000` 대신 거래처별 공통값을
   쓰게 하면 배부 편의는 얻고 전원 개방은 피한다(엑셀 `초기PIN` 컬럼이 이미 그 자리다).
2. ~~**P3 를 이번에 할지** — 크다. 추천 = **분리**. P4 를 `passengers` read 만 좁히고 PartnerApp 은
   당분간 예외로 두면 명부 노출은 "코드를 아는 사람"까지로 줄어든다(지금은 아무나).~~
   🔴 **2026-08-28 정정 — 이 추천의 전제가 틀렸다.** `partnerCodes` 의 read 규칙이 `true`(공개)라
   **업체코드 11개가 익명으로 전부 읽힌다**(문서 ID 가 곧 코드 · 실측). 즉 "코드를 아는 사람"은
   **아무나**이고, PartnerApp 을 예외로 둔 부분 P4 는 노출을 거의 못 줄인다. 코드를 비밀로 다루는
   설계는 전부 무효 — 포털에 **진짜 인증**(P3-b)이 필요하다.
3. **uid 규칙** — 추천 = `passenger_{companyId}_{empNo}`. 재로그인해도 같은 uid 라 토큰 추적이 쉽다.

## 하지 말 것
- 🔴 **P1 없이 rules 부터 좁히지 말 것** — 로그인이 그 문서를 읽어야 하므로 **전원 로그인 불가**가 된다.
- 🔴 `pinHash` 를 "비밀"처럼 다루지 말 것 — P4 전까지는 익명에게 열려 있다. 지금 `boardStatic` 이
  그걸 받는 건 **무작위 입력 차단용**이지 인증이 아니다.

---

## P3 설계 (2026-08-28 · way 승인 대기)

### 실측으로 바뀐 전제 3가지
이 문서를 처음 쓴 2026-08-25 이후 **세 가지가 달라졌다.** 전부 추정이 아니라 익명 클라이언트로
직접 재 본 값이다(`scripts/inspect_passenger_exposure.cjs` · 값은 안 찍고 건수·필드 이름만 센다).

| | 2026-08-25(문서 작성 시) | 2026-08-28(실측) |
|---|---|---|
| 명부 규모 | 258건 | **16,409건**(신촌세브란스 16,155) |
| 업체코드 | "코드를 아는 사람"으로 좁힐 수 있다고 가정 | 🔴 **`partnerCodes` read 가 공개** — 11개 전부 익명으로 읽힌다(문서 ID 가 곧 코드) |
| 노출 방향 | 읽기 문제로 다뤘다 | 🔴 **쓰기도 통과**(`allow write: if isAuth()` · 없는 사번 update 가 `permission-denied` 가 아니라 `not-found` 로 떨어짐 = 실재 사번이면 써진다) |

세 번째가 가장 무겁다. 익명 사용자가 명부를 **읽는** 데 그치지 않고 **고칠 수 있다**:
남의 `pinHash` 를 자기가 아는 값으로 덮어쓰면 그 계정으로 로그인되고, `active:false` 로 만들면
그 사람이 못 타고, 문서를 지우면 명부에서 사라진다. 그리고 지금 **미시작 16,141명**이 발급 PIN 으로
첫 로그인을 하는 국면이라 표면이 가장 넓다.

### P3 를 셋으로 쪼갠다 (각각 독립 배포 가능 · 앞에서 뒤로)

| 단계 | 하는 일 | 이 단계가 막는 것 | 화면·운영 영향 |
|---|---|---|---|
| **P3-a** | `pinHash` 를 `companies/{cid}/passengerSecrets/{empNo}`(rules `if false`)로 분리하고, 그 값을 쓰는 두 경로(`importEmployees`·`reissuePins`)를 포털 CF 로 이관 | **계정 탈취** — 명부가 열려 있어도 자격증명이 안 새고, 덮어쓸 수도 없다 | 포털 화면 **그대로**(호출 대상만 교체). 일괄등록은 서버 BulkWriter 라 오히려 더 빨라진다 |
| **P3-b** | 포털 인증 신설 — CF `partnerLogin({code, password})` → 커스텀 토큰(`role:'partner'`, `partnerCode`, `companyId`) + 승계표. **승객 P1 구조를 그대로 재사용** | **무인증 포털 진입**(지금은 공개된 코드만 알면 남의 거래처 포털에 들어간다) | 코드 입력 화면에 비밀번호 한 칸. 🔴 **운영 선행 = 담당자에게 초기 비밀번호 배부**(관리자 화면에서 발급 → 첫 로그인 시 변경 강제, 승객 `pinInitial` 과 같은 패턴) |
| **P3-c** | 나머지 명부 CRUD 를 포털 CF 로 — 목록(서버 페이지네이션·검색)·수정·삭제·노선별 집계 | 익명 명부 접근의 **마지막 경로** | 목록이 서버 검색으로 바뀐다. 16,155명이라 **어차피 필요한 변경**(오늘 넣은 100명 표시 상한의 정공법) |

그다음이 **P4**(rules 잠금):
- `passengers` read → `isAdmin(cid) || isDriverOf(cid) || (token.role=='passenger' && token.empNo==empNo && token.companyId==cid)`
- `passengers` write → **`false`**(전부 CF 경유)
- `partnerCodes` read → 공개 해제. 🔴 승객앱 `?pc=` 테마가 이 문서를 읽으므로 **공개해도 되는 필드만**
  `partnerPublic/{code}`(브랜딩·워드마크·아이콘)로 분리해야 한다 — 안 나누면 로그인 전 브랜딩이 죽는다
- `passengerLogin` **시도 제한** 추가(지금은 없다. "명부가 열려 있어 막아도 무의미"라 미뤘는데 P4 로 명부가
  닫히면 그 근거가 사라지므로 **같은 배포에 넣어야** 한다)

### 왜 P3-a 를 먼저 하나
비용 대비 방어가 가장 크다. **rules 를 안 건드려** 회귀 표면이 좁고(포털 화면 그대로), 가장 큰 피해인
계정 탈취를 먼저 끊는다. 게다가 옮길 대상이 **오늘 배치로 고친 그 함수**라 서버로 가면 클라 왕복이
0 이 되어 일괄등록이 한 번 더 빨라진다. P3-b 는 운영(비밀번호 배부)이 선행돼야 해서 일정이 걸린다.

### 하지 말 것 (기존 항목에 추가)
- 🔴 **"업체코드를 아니까 안전"으로 설계하지 말 것** — 코드는 공개다(실측). P3-b 전까지 포털 CF 는
  코드로 인증할 수밖에 없는데, 그건 **소속 강제와 감사 로그**를 얻는 것이지 인증이 아니다.
  `registerNfcCard` 의 partnerCode 경로가 이미 그 수준이다.
- 🔴 **P3-a 를 하면서 `pinHash` 를 명부에 남겨 두지 말 것**(양쪽에 두면 옛 값으로 로그인이 계속 된다).
  이관은 **복사 후 삭제**까지가 한 벌이고, 그 사이 `passengerLogin` 이 **두 곳을 다 보는 기간**이 필요하다
  (secrets 우선 → 없으면 명부 폴백 → 백필 완료 후 폴백 제거).
- 🔴 **P4 를 P3-c 없이 켜지 말 것** — 포털 목록·수정·삭제가 통째로 죽는다.

---

## P3-a 완료 기록 (2026-08-28 · prod 반영)

**한 일** — PIN 해시를 명부에서 떼어내 클라가 못 닿는 곳으로 옮겼다.
- 새 컬렉션 `companies/{cid}/passengerSecrets/{empNo}` · rules `allow read, write: if false`
- 서버 읽기 5곳을 `readPinHash`(**secrets 우선 → 명부 폴백**)로: `passengerLogin`·`passengerMigrate`·
  `passengerSetPin`·`boardStatic` 레거시 경로. 쓰기는 `writePinHash`(secrets 전용)
- 신규 CF **`partnerImportPassengers`** · **`partnerReissuePins`** — 포털이 하던 명부 쓰기를 서버가 대행
- 판정은 순수 모듈 **`functions/passengerRoster.js`** 로 분리(`index.js` 는 `defineSecret` 때문에
  격리 테스트로 못 태운다 — 아키타입 C playbook). **실행(getAll·BulkWriter)만 index.js**
- 클라 `partner.js` 의 `importEmployees`·`reissuePins` 는 CF 호출 껍데기로. 같은 날 오전에 넣었던
  클라측 배치(`documentId() in` + `writeBatch`)는 **통째로 사라졌다** — 서버가 왕복 없이 한다
- 클라에서 `hashPin`(WebCrypto)·`verifyPassenger`(호출부 0) 제거 = **클라에 해시 코드가 없다**

**데이터 이관** — 1단계(복사) 완료: 16,409건 → `passengerSecrets`(재실행 시 대상 0 = 멱등).
🔴 **2단계(명부에서 `pinHash` 걷어내기)는 대기 중** — `node scripts/backfill_passenger_secrets.cjs --strip --apply`.
대상 16,409건 전부 준비됐고(안 옮겨진 0), **이걸 해야 노출이 실제로 사라진다**. 1단계까지만 해도
*덮어쓰기 공격*은 막힌다(secrets 가 우선이라 명부의 해시를 고쳐도 로그인이 안 된다) — 남은 위험은
**값이 읽히는 것**(6자리라 오프라인 대입이 쉽다)이다.

**검증** — 격리 41단언(`test_passenger_roster.cjs` · 정본 모듈을 그대로 require) · **실호출 18단언**
(`test_partner_roster_live.cjs` · 🔴 익명 클라이언트로 부른다 — 서비스 계정은 게이트를 늘 통과한다.
샘플 거래처에 시험용 승객을 만들어 확인하고 **끝에 지운다**) · 규칙은 익명으로 재서 secrets 읽기·쓰기
모두 거부 확인(명부는 P4 전이라 열린 채가 정상) · 빌드 경고 24→**22**(신규 0).

**하지 말 것(추가)**
- 🔴 `readPinHash` 의 **명부 폴백을 2단계 전에 지우지 말 것** — 아직 안 옮겨진 사람이 로그인 불가가 된다.
  반대로 **2단계 뒤에는 지워야** 한다(폴백이 남아 있으면 명부에 해시를 다시 넣는 코드가 조용히 되살아난다).
- 🔴 클라에 해시 함수를 다시 만들지 말 것 — 두 벌이 되면 salt 가 갈리는 날 전원 로그인 불가다.

## P3-b 설계 (2026-08-28 · 착수 전 · 운영 선행 필요)

### 무엇을 고치나
협력사 포털은 지금 **업체코드만 알면 들어간다**. 그런데 그 코드는 `partnerCodes` read 가 공개라
**익명으로 11개 전부 읽힌다**(실측). 즉 인증이 없는 것과 같다. P3-a 로 자격증명은 지켰지만
**남의 거래처 명부를 보고 고치는 것**은 그대로다.

### 구조 — 승객 P1 을 그대로 복제한다
새로 발명하지 않는다. `passengerLogin`/`passengerResume`/`passengerLogout` 세 벌이 이미 돌고 있고,
포털도 **같은 모양**이면 유지보수가 한 벌로 끝난다.

| 승객(P1, 이미 있음) | 포털(P3-b, 신설) |
|---|---|
| `passengerLogin({companyId, empNo, pin})` | `partnerLogin({companyId, code, password})` |
| 커스텀 토큰 `{role:'passenger', empNo, partnerCode}` | 커스텀 토큰 `{role:'partner', partnerCode, companyId}` |
| `passengerSessions/{sha256(resumeToken)}` | `partnerSessions/{sha256(resumeToken)}` (rules `if false`) |
| `pinInitial` → 첫 로그인 시 변경 강제 | `passwordInitial` → 같은 패턴 |
| 해시 = `passengerSecrets` | 해시 = **`partnerSecrets/{code}`**(rules `if false`) |

- 🔴 **비밀번호를 `partnerCodes` 문서에 넣지 말 것** — 그 컬렉션은 read 가 공개다. P3-a 와 같은 이유로
  처음부터 별도 컬렉션에 둔다(나중에 옮기는 것보다 싸다).
- 🔴 **업체코드를 비밀번호로 쓰지 말 것**(현행) — 공개 값이다.
- 관리자 화면(협력사 관리)에 **초기 비밀번호 발급·재발급** 버튼. 평문은 발급 직후 1회만 보인다
  (승객 안내문과 같은 계약 — 저장하지 않는다).

### 운영이 선행이다 (way 일정)
담당자에게 초기 비밀번호를 **배부해야** 켤 수 있다. 대상은 활성 업체코드 11곳.
권장 순서 = ① 발급 화면부터 배포(끄고) → ② 거래처별로 비밀번호 전달 → ③ 거래처 단위로 켠다
(`partnerCodes.{code}.authRequired`) → ④ 전부 켜지면 코드-only 진입 경로 제거.
🔴 **한 번에 전 거래처를 켜지 말 것** — 못 받은 담당자가 그날 업무를 못 한다.

### 그다음(P3-c → P4)에 남는 것
- P3-c: 목록·수정·삭제·집계를 포털 CF 로(토큰이 생겼으니 인증이 진짜가 된다)
- P4: `passengers` read 를 신원으로 좁히고 **write 는 `false`** · `partnerCodes` 공개분을
  `partnerPublic/{code}`(브랜딩만)로 분리 · `passengerLogin` 시도 제한
