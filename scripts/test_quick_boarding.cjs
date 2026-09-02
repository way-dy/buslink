// 격리 테스트 — QR 탑승 4단계 → 3단계 (2026-09-02 세브란스병원 총무팀 요청).
//   node scripts/test_quick_boarding.cjs
//
// 배경: "qr탑승 메뉴진입 > 카메라열기 > qr태깅 > 탑승확인터치 > 탑승완료" 를
//   "qr탑승 누르면 바로 카메라 open > qr태깅 > 탑승완료" 로 줄였다(신속한 탑승).
//
// 🔴 이 검사가 지키는 것은 «줄이면서 안전장치까지 같이 지우지 않았는가» 다.
//   확인 터치를 없앤 대가로 ⓐ 오탑승을 막는 서버 가드 ⓑ 완료 화면의 노선·차량 표시
//   ⓒ 자동 시작이 실패했을 때의 폴백 — 셋 중 하나라도 빠지면 이 변경은 개악이다.
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "src", "pages", "EmployeeApp.js"), "utf8");
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log("  ✅ " + n); } else { fail++; console.log("  ❌ " + n + (x !== undefined ? " — " + JSON.stringify(x) : "")); } };

// ── 대상 컴포넌트만 잘라낸다 ───────────────────────────────
// 🔴 파일 전체를 grep 하면 형제 컴포넌트(ScanTabPassengerQR·BoardingApp 류)에 걸려
//    «지웠는데 통과» 하거나 그 반대가 된다.
const START = "function ScanTabDriverQR({ companyId, session }) {";
const i0 = SRC.indexOf(START);
const i1 = SRC.indexOf("\nfunction ", i0 + START.length);
const BLOCK = i0 >= 0 ? SRC.slice(i0, i1 > 0 ? i1 : SRC.length) : "";
// 주석 줄은 판정에서 뺀다 — "이걸 하지 말 것" 이라 적어 둔 주석에 걸리면 거짓 결과가 난다
// (2026-09-01 test_login_help 에서 실제로 밟은 함정).
const CODE = BLOCK.split(/\r?\n/).filter((l) => !l.trim().startsWith("//")).join("\n");

console.log("\n[0] 신호 유무 — 대상 컴포넌트를 실제로 찾았는가");
ok("ScanTabDriverQR 블록을 잘라냈다", i0 >= 0 && BLOCK.length > 4000, BLOCK.length);
ok("형제 컴포넌트가 섞여 들어오지 않았다", !BLOCK.includes("function ScanTabPassengerQR"));

console.log("\n[1] 확인 단계가 사라졌는가 (4 → 3단계)");
ok("confirm 단계로 전이하는 코드가 없다", !/setStep\("confirm"\)/.test(CODE));
ok("confirm 렌더 블록이 없다", !/step === "confirm"/.test(CODE));
ok('"탑승 확인" 버튼이 없다', !/탑승 확인</.test(BLOCK));
ok("handleBoard 가 없다", !/handleBoard/.test(CODE));
ok("쓰이지 않게 된 state 를 정리했다(scannedToken·tokenData)", !/scannedToken|tokenData/.test(CODE));

console.log("\n[2] 마운트 자동 시작 + StrictMode 가드");
ok("마운트 effect 가 startScan 을 부른다", /useEffect\(\(\) => \{\s*\n\s*startScan\(\);/.test(CODE));
ok("그 effect 의 deps 가 비어 있다(1회)", /startScan\(\);[\s\S]{0,200}?\}, \[\]\);/.test(CODE));
ok("언마운트 정리(stopStream)를 유지한다",
  /return \(\) => \{ activeRef\.current = false; stopStream\(\); \};/.test(CODE));
// 🔴 개발 빌드(StrictMode)는 마운트 effect 를 두 번 돌린다 — await 뒤에 온 stream 이 주인
//    없이 남으면 카메라가 켜진 채 누수된다. 세대 번호로 뒤늦은 stream 을 스스로 끄게 한다.
ok("세대 ref 가 있다", /const scanGenRef = useRef\(0\);/.test(CODE));
ok("startScan 이 세대를 올려 잡는다", /const gen = \+\+scanGenRef\.current;/.test(CODE));
ok("뒤늦게 온 stream 을 스스로 정리한다",
  /if \(gen !== scanGenRef\.current\) \{ stream\.getTracks\(\)\.forEach\(t => t\.stop\(\)\); return; \}/.test(CODE));

console.log("\n[3] 🔴 폴백이 남아 있는가 (자동 시작이 실패해도 길이 있어야 한다)");
ok("ready 화면이 남아 있다", /step === "ready"/.test(CODE));
ok('ready 에 "카메라 열기" 버튼이 있다', /카메라 열기/.test(BLOCK));
ok("그 버튼이 startScan 을 부른다", /onClick=\{startScan\}/.test(CODE));
ok("error 화면과 재시도 버튼이 남아 있다", /step === "error"/.test(CODE) && /다시 시도/.test(BLOCK));
// 오류는 사용자 제스처가 있으므로 ready 를 거치지 않고 곧바로 카메라를 연다.
ok("재시도는 reset 후 startScan 직행이다",
  /const retry = \(\) => \{ reset\(\); startScan\(\); \};/.test(CODE) && /onClick=\{retry\}/.test(CODE));
// 🔴 완료 후에는 자동 재시작 금지 — 나가려는 사람에게 카메라가 계속 켜진다.
ok("완료 화면 확인 버튼은 reset 만 한다(자동 재시작 아님)",
  /onClick=\{reset\}>확인</.test(BLOCK) && !/onClick=\{retry\}>확인</.test(BLOCK));
ok("권한 거부 안내 문구가 살아 있다", /카메라 권한을 허용해주세요/.test(BLOCK));

console.log("\n[4] 🔴 회귀 가드 3종 (오탑승·경로 파손·타사 QR)");
// ⓐ session.routeId 직송 금지 — 명부 배정값으로도 채워져 거짓 차단이 난다(2026-09-01).
ok("선택 노선 판정에 boardingRouteId 를 쓴다", /boardingRouteId\(\{/.test(CODE));
ok("session.routeId 를 서버로 직송하지 않는다", !/selectedRouteId: session\??\.routeId/.test(CODE));
// ⓑ Firestore 문서 ID 에 "/" 가 들어가면 doc() 가 죽는다.
ok('token.includes("/") 가드가 있다', /token\.includes\("\/"\)/.test(CODE));
ok("그 안내 문구가 보존됐다", /탑승용 QR코드가 아닙니다/.test(BLOCK));
// ⓒ 다른 회사 QR 은 클라에서 먼저 막는다.
ok("회사 불일치 차단이 있다",
  /if \(companyId && c !== companyId\) throw new Error\("다른 회사의 QR코드입니다"\)/.test(CODE));

console.log("\n[5] 서버 왕복을 줄였는가 (프리뷰·사전조회 제거)");
ok("정적 QR 경로가 resolveStaticDispatch 를 부르지 않는다", !/resolveStaticDispatch\(/.test(CODE));
ok("정적 QR 은 validateAndBoardStatic 하나로 끝낸다", /validateAndBoardStatic\(\{/.test(CODE));
ok("동적 토큰 경로가 boardingTokens 를 사전 조회하지 않는다", !/boardingTokens/.test(CODE));
ok("동적 토큰은 validateAndBoard 하나로 끝낸다", /validateAndBoard\(\{ tokenId: token/.test(CODE));
// 🔴 state 는 비동기 — 스캔 직후 setState 를 읽으면 늘 null 이다.
ok("runBoarding 은 인자로 받는다(화면 state 를 읽지 않는다)",
  /const runBoarding = async \(\{ staticQr = null, token = null \}\) =>/.test(CODE));

console.log("\n[6] 🔴 완료 화면이 «어느 버스에 탔는지» 를 보여주는가");
const SUCCESS = (BLOCK.match(/\{step === "success" &&[\s\S]*?\n        \)\}/) || [""])[0];
ok("완료 블록을 찾았다(신호 유무)", SUCCESS.length > 400, SUCCESS.length);
ok("노선을 표시한다", /result\?\.routeName/.test(SUCCESS));
ok("차량을 표시한다", /result\?\.vehicleNo/.test(SUCCESS));
ok("탑승자(이름·사번)를 표시한다", /session\.name[\s\S]{0,40}session\.empNo/.test(SUCCESS));
ok("부서를 표시한다", /session\.dept/.test(SUCCESS));
ok("고정 QR 뱃지가 남아 있다", /고정 QR/.test(SUCCESS));
ok("이미 탑승 처리됨 분기가 남아 있다", /alreadyBoarded \? "이미 탑승 처리됨"/.test(SUCCESS));
ok("탑승 시각 표시가 남아 있다", /toLocaleTimeString\("ko-KR"\)/.test(SUCCESS));

console.log("\n[7] 태깅 피드백(진동·소리)은 그대로인가");
ok("진동", /navigator\.vibrate\(\[100, 50, 100\]\)/.test(CODE));
ok("태깅음", /playTagBeep\(\)/.test(CODE));

console.log("\n" + (fail === 0 ? "✅ 전부 통과" : "❌ 실패 있음") + " — " + pass + " pass / " + fail + " fail");
process.exit(fail === 0 ? 0 : 1);
