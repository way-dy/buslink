// 격리 테스트 — 로그인 화면 「비밀번호를 잊으셨나요」 안내 (2026-09-01 최우석 신고).
//   node scripts/test_login_help.cjs
//
// 배경: 신촌세브란스 오픈 첫날 «로그인이 안된다» 문의가 담당자에게 몰렸는데, 실측하면
// 로그인은 정상이었고(그 시각에도 시간당 수십 건 성공) 대부분 **이미 본인 번호로 바꾼
// 사람이 000000 을 넣는 경우**였다. 그런데 앱에는 회복 경로가 **아예 없었다**.
//
// 🔴 이 검사가 지키는 것은 «문구가 사실인가» 다 — 안내가 틀리면 없느니만 못하다.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const EMP = fs.readFileSync(path.join(__dirname, "..", "src", "pages", "EmployeeApp.js"), "utf8");
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${x !== undefined ? " — " + JSON.stringify(x) : ""}`); } };

console.log("\n[1] 진입 통로가 실제로 있는가");
ok("로그인 화면에 «비밀번호를 잊으셨나요» 가 있다", /비밀번호를 잊으셨나요/.test(EMP));
// 🔴 링크만 달아 두면 아무도 안 누른다 — 실패한 그 순간 펼쳐져야 한다.
ok("로그인 실패 시 자동으로 펼친다", /setError\(e\.message\);[\s\S]{0,320}?setHelpOpen\(true\)/.test(EMP));
ok("토글로 접을 수도 있다", /setHelpOpen\(v => !v\)/.test(EMP));

console.log("\n[2] 🔴 안내 문구가 prod 실측과 맞는가");
// 🔴 소스를 그대로 grep 하면 JSX 태그(`<b style=...>`)에 걸려 **문장이 멀쩡한데도 빨개진다**
//    (실제로 한 번 밟았다). 사용자가 읽는 것은 태그가 아니라 글자이므로,
//    태그·중괄호식을 걷어낸 **평문**으로 잰다.
const helpBlock = (EMP.match(/이렇게 확인해 보세요[\s\S]{0,2600}?재발급하면[\s\S]{0,600}?<\/div>/) || [""])[0];
const plain = helpBlock
  .replace(/<[^>]*>/g, "")          // 태그 제거
  .replace(/\{"\s*"\}/g, " ")       // {" "} → 공백
  .replace(/\{[^{}]*\}/g, "")       // 남은 중괄호식 제거
  .replace(/\s+/g, " ")
  .trim();
ok("안내 블록을 찾았다(신호 유무)", plain.length > 80, plain.slice(0, 60));
console.log(`    읽히는 문장: "${plain.slice(0, 150)}…"`);

// 초기 PIN 은 000000 — 2026-08-25 way 결정으로 고정값이고 신촌세브란스 15,109명이 이 해시다.
const h000 = crypto.createHash("sha256").update("000000buslink_salt_2026").digest("hex");
ok("초기 비밀번호 000000 을 안내한다", /000000/.test(plain));
ok("(대조) 000000 해시가 prod 명부 값 d05ab5… 와 같다", h000.startsWith("d05ab5dffb"), h000.slice(0, 12));
// 신촌세브란스 사번 16,150명이 0 으로 시작 — 앞의 0 을 빼면 «없는 사번» 이 된다.
ok("앞의 0 을 빼지 말라고 안내한다", /앞의\s*0\s*도\s*빼지 말고/.test(plain), plain.slice(0, 120));
// 한 번이라도 바꾸면 000000 은 안 된다(로그인한 1,066명 중 1,046명이 바꿨다).
ok("이미 바꿨으면 000000 이 안 된다고 알린다", /바꾸셨다면 000000으로는 들어갈 수 없습니다/.test(plain));
// 재발급은 000000 으로 되돌린다(2026-08-25 `generateInitialPin` 고정값).
ok("담당자 재발급 경로를 알린다", /담당자에게\s*비밀번호 재발급을 요청/.test(plain), plain.slice(-160));
ok("재발급 후 000000 으로 돌아간다고 알린다", /재발급하면\s*000000\s*으로 돌아가/.test(plain));

console.log("\n[2b] 🔴 카카오톡 문의 통로 (2026-09-01 회의 결정)");
// 「로그인이 안 되면 카톡으로 문의하라고」 — 로그인 못 한 사람에게 남은 유일한 통로다.
ok("고객 CS 채널 주소가 상수로 있다", /KAKAO_CS_CHANNEL_URL = "https:\/\/pf\.kakao\.com\/_gxlHfX"/.test(EMP));
// 🔴 도움말 안에만 두면 «비밀번호 문제»가 아닌 문의는 닿지 못한다 — 로그인 버튼 아래 상시 노출.
ok("로그인 화면에 상시 노출되는 «카카오톡 문의» 링크가 있다",
  /비밀번호를 잊으셨나요\?[\s\S]{0,700}?카카오톡 문의/.test(EMP));
ok("도움말 안에도 문의 버튼이 있다", /카카오톡으로 문의하기/.test(EMP));
// 외부 링크는 새 탭 + opener 차단.
ok("새 탭으로 열고 opener 를 끊는다",
  (EMP.match(/href=\{KAKAO_CS_CHANNEL_URL\} target="_blank" rel="noopener noreferrer"/g) || []).length >= 2);
// 🔴 기사 전용 채널로 바뀌면 승객 문의를 받을 사람이 없다.
//    ⚠ 「드라이버스」를 문자열로 찾으면 **그러지 말라고 적어 둔 주석**에 걸린다(실제로 밟았다).
//    실제로 링크되는 주소만 본다 — 파일 안의 pf.kakao.com 주소가 CS 채널 하나뿐인가.
{
  const urls = [...new Set(EMP.match(/https:\/\/pf\.kakao\.com\/[A-Za-z0-9_]+/g) || [])];
  ok("파일에 실린 카카오 채널 주소가 고객 CS 채널 하나뿐이다",
    urls.length === 1 && urls[0] === "https://pf.kakao.com/_gxlHfX", urls);
}

console.log("\n[3] 🔴 셀프 재설정을 만들지 않았는가 (P4 전까지 금지)");
// `passengers` read 가 isAuth() 라 사번·이름이 익명에게 다 열려 있다 — 그걸 본인 확인에
// 쓰면 아무나 남의 계정을 가져간다. 회복은 담당자 재발급뿐이어야 한다.
ok("로그인 화면에서 PIN 을 재설정하는 CF 를 부르지 않는다",
  !/passengerSetPin[\s\S]{0,200}LoginScreen/.test(EMP) && !/LoginScreen[\s\S]{0,3000}?passengerSetPin/.test(EMP));
ok("안내는 문구뿐 — 재설정 입력칸이 없다", !/새 비밀번호[\s\S]{0,200}비밀번호를 잊으셨나요/.test(EMP));

console.log(`\n${fail === 0 ? "✅ 전부 통과" : "❌ 실패 있음"} — ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
