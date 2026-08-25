// accountCards 순수 함수 격리 테스트 (2026-07-27)
//   node scripts/test_account_cards.cjs
// ESM 모듈이라 소스를 읽어 CJS 로 얕게 변환해 로드한다(빌드 없이 검증).
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "accountCards.js"), "utf8")
  .replace(/^export const /gm, "const ")
  .replace(/^export function /gm, "function ");
const exportNames = ["INITIAL_PIN_LENGTH", "DEFAULT_INITIAL_PIN", "generateInitialPin", "generateRandomPin", "isValidInitialPin", "buildPassengerLoginUrl", "buildAccountCardsHtml", "openPrintWindow"];
// window.crypto 를 실제 WebCrypto 로 채워 브라우저와 같은 경로를 태운다.
const sandbox = { module: { exports: {} }, window: { crypto: require("crypto").webcrypto, open: () => null }, Uint8Array, Math, JSON, String, Number, Array, RegExp, encodeURIComponent };
vm.createContext(sandbox);
vm.runInContext(src + "\nmodule.exports = {" + exportNames.join(",") + "};", sandbox);
const A = sandbox.module.exports;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? " → " + extra : ""}`); }
}

console.log("\n[1] generateInitialPin — 전원 공통 000000 (2026-08-25 way 결정)");
{
  // 🔴 예전 단언은 정반대였다("전부 같은 값이 아님"·"000000 고정이 아님"). way 가 배부·문의
  //    비용을 이유로 고정을 택했고, 노출 창은 **첫 로그인 강제 변경**이 좁힌다.
  //    되돌린다면 `accountCards.generateRandomPin` 이 옛 발급기 그대로 남아 있다.
  const pins = Array.from({ length: 500 }, () => A.generateInitialPin());
  ok("기본 6자리", pins.every(p => p.length === 6));
  ok("숫자만", pins.every(p => /^\d+$/.test(p)));
  ok("전원 공통 000000", pins.every(p => p === "000000"), `distinct=${new Set(pins).size}`);
  ok("상수와 일치", A.DEFAULT_INITIAL_PIN === "000000", A.DEFAULT_INITIAL_PIN);
  ok("길이 인자를 줘도 고정값(호출부 오해 방지)", A.generateInitialPin(4) === "000000");
  // 옛 발급기는 되돌리기용으로 살아 있어야 한다 — 지우면 복구 경로가 사라진다.
  ok("generateRandomPin 이 남아 있다", typeof A.generateRandomPin === "function");
  {
    const r = Array.from({ length: 500 }, () => A.generateRandomPin());
    ok("generateRandomPin 은 여전히 개인별로 다르다", new Set(r).size > 400, `distinct=${new Set(r).size}`);
    ok("generateRandomPin 길이 클램프", A.generateRandomPin(1).length === 4 && A.generateRandomPin(99).length === 6);
  }
}

console.log("\n[2] isValidInitialPin");
{
  const cases = [
    ["1234", true], ["123456", true], ["0000", true],
    ["123", false], ["1234567", false], ["12a4", false],
    ["", false], [null, false], [undefined, false], ["  1234  ", true],
  ];
  for (const [v, want] of cases) ok(`${JSON.stringify(v)} → ${want}`, A.isValidInitialPin(v) === want);
}

console.log("\n[3] buildPassengerLoginUrl");
{
  ok("partner 서브도메인 → p 서브도메인",
    A.buildPassengerLoginUrl({ origin: "https://partner.buslink.co.kr", empNo: "10001" }) === "https://p.buslink.co.kr/p?emp=10001",
    A.buildPassengerLoginUrl({ origin: "https://partner.buslink.co.kr", empNo: "10001" }));
  ok("web.app 은 그대로 + /p",
    A.buildPassengerLoginUrl({ origin: "https://buslink-prod.web.app", empNo: "10001" }) === "https://buslink-prod.web.app/p?emp=10001");
  ok("localhost 유지",
    A.buildPassengerLoginUrl({ origin: "http://localhost:3000", empNo: "A-1" }) === "http://localhost:3000/p?emp=A-1");
  ok("끝 슬래시 제거",
    A.buildPassengerLoginUrl({ origin: "https://partner.buslink.co.kr/", empNo: "1" }) === "https://p.buslink.co.kr/p?emp=1");
  ok("사번 URL 인코딩",
    A.buildPassengerLoginUrl({ origin: "https://p.buslink.co.kr", empNo: "가 나&1" }) === "https://p.buslink.co.kr/p?emp=" + encodeURIComponent("가 나&1"));
  ok("사번 없으면 쿼리 없음",
    A.buildPassengerLoginUrl({ origin: "https://p.buslink.co.kr" }) === "https://p.buslink.co.kr/p");
  ok("경로 안 partner 문자열은 안 건드림",
    A.buildPassengerLoginUrl({ origin: "https://x.co.kr/partner", empNo: "1" }) === "https://x.co.kr/partner/p?emp=1");
}

console.log("\n[4] buildAccountCardsHtml");
{
  const cards = [
    { empNo: "10001", name: "홍길동", dept: "3학년 2반", routeName: "한남1 등교", pin: "483712", loginUrl: "https://p.buslink.co.kr/p?emp=10001", qrDataUrl: "data:image/png;base64,AAA" },
    { empNo: "10002", name: "김철수", pin: "112233", loginUrl: "https://p.buslink.co.kr/p?emp=10002" },
  ];
  const html = A.buildAccountCardsHtml({ partnerName: "채드윅송도국제학교", cards });
  ok("카드 수만큼 렌더", (html.match(/class="card"/g) || []).length === 2);
  ok("이름 포함", html.includes("홍길동") && html.includes("김철수"));
  ok("사번 포함", html.includes("10001") && html.includes("10002"));
  ok("PIN 포함", html.includes("483712") && html.includes("112233"));
  ok("거래처명 포함", html.includes("채드윅송도국제학교"));
  ok("QR 있는 카드만 img", (html.match(/class="qr"/g) || []).length === 1);
  ok("부서 없는 카드는 dept 미출력", (html.match(/class="dept"/g) || []).length === 1);
  ok("A4 인쇄 설정", html.includes("@page") && html.includes("A4"));
  ok("카드 페이지 분할 방지", html.includes("page-break-inside: avoid"));
  ok("자동 인쇄", html.includes("window.print()"));

  // XSS/깨짐 방지 — 이름에 태그가 들어와도 마크업이 되면 안 된다.
  const evil = A.buildAccountCardsHtml({ partnerName: "A&B", cards: [{ empNo: "1", name: '<script>alert(1)</script>', pin: "1234" }] });
  ok("이름의 태그 이스케이프", !evil.includes("<script>alert(1)</script>") && evil.includes("&lt;script&gt;"));
  ok("앰퍼샌드 이스케이프", evil.includes("A&amp;B"));

  const empty = A.buildAccountCardsHtml({ partnerName: "X", cards: [] });
  ok("빈 목록도 throw 없이 렌더", typeof empty === "string" && !empty.includes('class="card"'));
  ok("인자 없어도 throw 없음", typeof A.buildAccountCardsHtml() === "string");
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
