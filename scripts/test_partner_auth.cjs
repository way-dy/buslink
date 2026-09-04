// 격리 테스트 — 협력사 포털 인증(P3-b 1단계).  node scripts/test_partner_auth.cjs
//
// 무엇을 지키나:
//   ⓐ `authRequired` 를 **안 켠** 거래처는 비밀번호 없이 지금과 똑같이 통과한다(회귀 0이 이번 범위의 전부다)
//   ⓑ 켠 거래처는 비밀번호 없이는 거부된다
//   ⓒ 남의 `partnerCode` 토큰으로 다른 거래처 자원에 손대면 거부된다
//   ⓓ 평문 비밀번호가 **어디에도 저장되지 않는다**(발급 응답 1회만)
//   ⓔ 해시가 `partnerCodes`(read 공개) 문서에 들어가지 않는다
//   ⓕ 관리자가 아닌 호출자의 `partnerIssuePassword` 는 거부된다
//   + 초기 비밀번호 정책이 **서버·클라 양쪽에서 같은 값**이다(2026-09-01 승객 PIN 사고 재발 방지)
//
// 🔴 대조군(옛 동작)을 같은 잣대로 태워 실제로 빨개지는지 확인한다 — 안 그러면 이 파일 전체가
//    "지금 코드가 지금 코드와 같다"는 공허한 검사다. 실패 건수는 맨 아래에 찍는다.
//
// ⚠ 위임 프롬프트는 «순수 모듈을 vm 으로» 였으나 `functions/partnerAuth.js` 는 순수 CommonJS 라
//   **그대로 require** 한다(`test_passenger_roster.cjs` 가 정본 모듈을 require 하는 것과 같은 선례).
//   vm 은 그럴 수 없는 두 곳에만 쓴다 — ① ESM 인 클라 정책 모듈 ② `defineSecret` 때문에 통째로
//   못 태우는 `functions/index.js`(함수 본문만 뽑아 평가).
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log("  ✅ " + n); }
  else { fail++; console.log("  ❌ " + n + (x !== undefined ? " — " + JSON.stringify(x) : "")); }
};
const eq = (n, a, b) => ok(n, a === b, { actual: a, expected: b });

// ── 정본 모듈 ────────────────────────────────────────────
const S = require(path.join(ROOT, "functions", "partnerAuth.js"));

// 클라 정책(ESM) — export 를 벗겨 vm 에 태운다.
const clientSrc = read("src/lib/partnerAuthPolicy.js");
const cctx = vm.createContext({ console });
vm.runInContext(
  clientSrc.replace(/^export\s+function\s+/gm, "function ").replace(/^export\s+const\s+/gm, "var "),
  cctx
);

// 주석을 걷어낸 소스(문구 검사가 «하지 말 것» 주석에 걸리는 함정 — 2026-09-01 test_login_help 실측).
// ⚠ 두 가지를 실측으로 배웠다: ① `src/pages/PartnerApp.js` 는 **CRLF** 라 줄 끝에 `\r` 이 남고
//   `.` 는 `\r` 를 안 먹어서 `^\s*//.*$` 가 한 줄도 못 지운다 → 먼저 개행을 정규화한다
//   ② `/*…*/` 를 통째로 지우면 이 파일에서 13,500자가 사라졌다(문자열·정규식 안의 `*/` 때문).
//   그래서 **줄 주석만** 지우고, 블록 주석은 짧은 CF 본문에서만 따로 지운다.
function stripComments(src) {
  return src.split("\r\n").join("\n")
    .split("\n").map((l) => l.replace(/^\s*\/\/.*$/, "")).join("\n");
}
function stripBlockComments(src) {
  return stripComments(src).replace(/\/\*[\s\S]*?\*\//g, "");
}
/** `.set(...)` · `.update(...)` 의 인자 전체를 괄호 균형으로 뜯어낸다(= 문서에 실제로 쓰는 값). */
function writePayloads(body) {
  const out = [];
  const src = stripBlockComments(body);
  for (const kw of [".set(", ".update("]) {
    let i = src.indexOf(kw);
    while (i >= 0) {
      let depth = 0, j = i + kw.length - 1;
      for (; j < src.length; j++) {
        if (src[j] === "(") depth++;
        else if (src[j] === ")") { depth--; if (depth === 0) break; }
      }
      out.push(src.slice(i, j + 1));
      i = src.indexOf(kw, i + 1);
    }
  }
  return out;
}
/** index.js 의 onCall 본문만 뽑는다(defineSecret 때문에 파일을 통째로 못 태운다). */
function cfBody(src, name) {
  const head = "exports." + name + " = onCall(";
  const i = src.indexOf(head);
  if (i < 0) return null;
  const j = src.indexOf("\n});", i);
  return j < 0 ? null : src.slice(i, j);
}

const serverSrc = read("functions/index.js");
const rulesSrc = read("firestore.rules");

// ════════════════════════════════════════════════════════
// [1] 초기 비밀번호 정책 — 서버와 클라가 같은 값을 말한다
// ════════════════════════════════════════════════════════
console.log("\n[1] 초기 비밀번호 정책 — 서버·클라·화면이 한 상수를 본다");
eq("길이 상수 일치", cctx.PARTNER_PASSWORD_LENGTH, S.PARTNER_PASSWORD_LENGTH);
eq("글자 집합 일치", cctx.PARTNER_PASSWORD_ALPHABET, S.PARTNER_PASSWORD_ALPHABET);
eq("최소 길이 일치", cctx.PARTNER_PASSWORD_MIN_LEN, S.PARTNER_PASSWORD_MIN_LEN);
eq("최대 길이 일치", cctx.PARTNER_PASSWORD_MAX_LEN, S.PARTNER_PASSWORD_MAX_LEN);
eq("발급 안내 문구 일치", cctx.PARTNER_PASSWORD_ISSUE_NOTICE, S.PARTNER_PASSWORD_ISSUE_NOTICE);

const pw1 = S.generateInitialPartnerPassword();
const pw2 = S.generateInitialPartnerPassword();
eq("발급값 길이가 상수와 같다", pw1.length, S.PARTNER_PASSWORD_LENGTH);
ok("발급값이 정해진 글자 집합 안이다",
  pw1.split("").every((ch) => S.PARTNER_PASSWORD_ALPHABET.indexOf(ch) >= 0), pw1);
// 🔴 승객(고정 000000)과 **다른 정책**이라는 것을 직접 잠근다 — 고정값으로 되돌리면 여기가 빨개진다.
ok("호출마다 다른 값이다(랜덤 정책)", pw1 !== pw2, { pw1, pw2 });
ok("헷갈리는 글자(0 O o 1 l I)를 안 쓴다",
  !/[0Oo1lI]/.test(S.PARTNER_PASSWORD_ALPHABET), S.PARTNER_PASSWORD_ALPHABET);
ok("업체코드를 기본값으로 삼지 않는다(공개값)",
  !/000000/.test(S.PARTNER_PASSWORD_ISSUE_NOTICE));

// 새 비밀번호 검사 — 서버와 클라가 **같은 답**을 낸다
const CASES = [
  ["", false], ["abc", false], ["1234567", false], ["12345678", true],
  ["abcdefgh", true], ["abcd efgh", false], ["A".repeat(65), false], ["A".repeat(64), true],
];
let parityBad = 0;
for (const [v, want] of CASES) {
  const a = S.checkNewPartnerPassword(v).ok;
  const b = cctx.checkNewPartnerPassword(v).ok;
  if (a !== want || b !== want) parityBad++;
}
eq("새 비밀번호 판정이 서버·클라·기대값 모두 일치(" + CASES.length + "케이스)", parityBad, 0);
ok("업체코드와 같은 값은 거부(서버)",
  S.checkNewPartnerPassword("DY001-A-2026-XXXX", { currentCode: "dy001-a-2026-xxxx" }).ok === false);
ok("업체코드와 같은 값은 거부(클라)",
  cctx.checkNewPartnerPassword("DY001-A-2026-XXXX", { currentCode: "dy001-a-2026-xxxx" }).ok === false);

// ════════════════════════════════════════════════════════
// [2] uid·승계표 — 승객과 겹치지 않는다
// ════════════════════════════════════════════════════════
console.log("\n[2] uid·승계표");
eq("uid 규칙", S.partnerUidOf("dy001", "DY001-샘플-2026-SMPL"), "partner_dy001_DY001-샘플-2026-SMPL");
ok("승객 uid 접두와 겹치지 않는다",
  S.partnerUidOf("dy001", "X").indexOf("passenger_") !== 0);
ok("긴 업체코드는 128자 상한 안으로 접힌다",
  S.partnerUidOf("dy001", "가".repeat(300)).length <= 128,
  S.partnerUidOf("dy001", "가".repeat(300)).length);
ok("같은 코드는 늘 같은 uid(재로그인 추적 가능)",
  S.partnerUidOf("dy001", "A-1") === S.partnerUidOf("dy001", "A-1"));
ok("승계표 문서 ID 는 토큰 평문이 아니다",
  S.partnerSessionDocId("secret-token").indexOf("secret-token") < 0);
eq("승계표 문서 ID 는 sha256 hex 64자", S.partnerSessionDocId("t").length, 64);

// ════════════════════════════════════════════════════════
// [3] ⓐⓑ 로그인 판정 — 꺼진 곳은 현행, 켠 곳은 비밀번호 필수
// ════════════════════════════════════════════════════════
console.log("\n[3] ⓐ 꺼진 거래처 = 현행 통과 · ⓑ 켠 거래처 = 비밀번호 필수");
const CID = "dy001";
const OFF = { companyId: CID, partnerName: "채드윅", active: true };                    // authRequired 부재
const OFF2 = { companyId: CID, partnerName: "채드윅", active: true, authRequired: false };
const ON = { companyId: CID, partnerName: "신촌", active: true, authRequired: true };
const SECRET = { passwordHash: S.hashPartnerPassword("goodpass99"), passwordInitial: true };
const login = (a) => S.planPartnerLogin(Object.assign({ companyId: CID, nowMs: 1000, password: "", secret: null }, a));

ok("ⓐ 부재 = 비밀번호 없이 통과", login({ codeData: OFF }).ok === true);
ok("ⓐ false = 비밀번호 없이 통과", login({ codeData: OFF2 }).ok === true);
ok("ⓐ 꺼진 거래처는 비밀번호 변경 강제도 없다", login({ codeData: OFF }).passwordInitial === false);
ok("ⓐ 꺼진 거래처는 비밀번호가 발급돼 있어도 그냥 통과(현행 보존)",
  login({ codeData: OFF, secret: SECRET }).ok === true);
ok("ⓑ 켠 거래처 · 비밀번호 없음 = 거부",
  login({ codeData: ON, secret: SECRET }).ok === false);
eq("ⓑ 거부 사유가 «입력해주세요»", login({ codeData: ON, secret: SECRET }).message, "비밀번호를 입력해주세요");
ok("ⓑ 켠 거래처 · 틀린 비밀번호 = 거부",
  login({ codeData: ON, secret: SECRET, password: "wrongpass9" }).ok === false);
ok("ⓑ 켠 거래처 · 맞는 비밀번호 = 통과",
  login({ codeData: ON, secret: SECRET, password: "goodpass99" }).ok === true);
ok("ⓑ 첫 로그인이면 변경 강제 신호를 준다",
  login({ codeData: ON, secret: SECRET, password: "goodpass99" }).passwordInitial === true);
ok("ⓑ 변경을 마친 뒤에는 강제하지 않는다",
  login({ codeData: ON, secret: { passwordHash: SECRET.passwordHash, passwordInitial: false }, password: "goodpass99" }).passwordInitial === false);
ok("ⓑ 켜 두고 발급 안 한 상태는 «발급되지 않았습니다» 로 답한다",
  login({ codeData: ON, password: "goodpass99" }).status === "failed-precondition");
ok("비활성 코드는 거부", login({ codeData: { companyId: CID, active: false, authRequired: true }, password: "x" }).ok === false);
ok("다른 회사 코드는 거부", login({ codeData: { companyId: "other", active: true }, password: "x" }).ok === false);
ok("없는 코드는 거부", login({ codeData: null, password: "x" }).ok === false);
eq("«없는 코드»와 «다른 회사»가 같은 문구다(코드 목록 훑기 방지)",
  login({ codeData: null }).message, login({ codeData: { companyId: "other", active: true } }).message);
ok("만료된 코드는 거부",
  login({ codeData: ON, secret: SECRET, password: "goodpass99", nowMs: 3000, expiresAtMs: 2000 }).ok === false);
ok("만료일 부재 = 만료 없음(시연용 거래처가 못 들어오던 2026-09-02 결함 재발 방지)",
  login({ codeData: ON, secret: SECRET, password: "goodpass99", expiresAtMs: null }).ok === true);

console.log("\n[3-b] 승계(resume) — 비밀번호는 안 묻되 코드 상태는 다시 본다");
const resume = (a) => S.planPartnerResume(Object.assign({ companyId: CID, nowMs: 1000 }, a));
ok("켠 거래처 · 승계표 있으면 비밀번호 없이 통과", resume({ codeData: ON, secret: SECRET }).ok === true);
ok("비활성으로 바뀌면 승계 거부", resume({ codeData: { companyId: CID, active: false, authRequired: true }, secret: SECRET }).ok === false);
ok("발급이 취소되면 승계 거부", resume({ codeData: ON, secret: null }).ok === false);
ok("꺼진 거래처는 승계도 그냥 통과", resume({ codeData: OFF }).ok === true);

// ════════════════════════════════════════════════════════
// [4] ⓒ 남의 토큰으로 다른 거래처 자원 접근
// ════════════════════════════════════════════════════════
console.log("\n[4] ⓒ 토큰이 있으면 토큰이 정본 — 남의 거래처 자료 접근 거부");
const check = (a) => S.planPartnerCallerCheck(Object.assign({ companyId: CID }, a));
const MINE = "DY001-신촌-2026-AAAA";
const THEIRS = "DY001-채드윅-2026-BBBB";
const tok = (c, cid) => ({ role: "partner", companyId: cid || CID, partnerCode: c });

ok("ⓒ 내 토큰 + 내 코드 = 통과",
  check({ codeData: ON, requestedCode: MINE, claims: tok(MINE) }).ok === true);
ok("ⓒ 내 토큰 + 남의 코드 = 거부",
  check({ codeData: ON, requestedCode: THEIRS, claims: tok(MINE) }).ok === false);
eq("ⓒ 거부 문구가 «다른 거래처»를 말한다",
  check({ codeData: ON, requestedCode: THEIRS, claims: tok(MINE) }).message, "다른 거래처의 자료에는 접근할 수 없습니다");
ok("ⓒ 다른 회사 토큰 = 거부",
  check({ codeData: ON, requestedCode: MINE, claims: tok(MINE, "other") }).ok === false);
ok("ⓒ 꺼진 거래처라도 남의 토큰이면 거부(토큰이 있으면 토큰이 정본)",
  check({ codeData: OFF, requestedCode: THEIRS, claims: tok(MINE) }).ok === false);
ok("ⓑ 켠 거래처는 토큰 없는 호출을 거부",
  check({ codeData: ON, requestedCode: MINE, claims: {} }).ok === false);
eq("ⓑ 토큰 없는 거부는 unauthenticated(로그인하라는 뜻)",
  check({ codeData: ON, requestedCode: MINE, claims: {} }).status, "unauthenticated");
ok("ⓐ 꺼진 거래처 · 토큰 없음 = 현행 그대로 통과",
  check({ codeData: OFF, requestedCode: MINE, claims: {} }).ok === true);
ok("ⓐ 익명(role 없음) 호출도 꺼진 거래처에서는 통과",
  check({ codeData: OFF, requestedCode: MINE, claims: { role: undefined } }).ok === true);
ok("빈 업체코드는 거부", check({ codeData: OFF, requestedCode: "", claims: {} }).ok === false);
ok("코드 앞뒤 공백은 정규화해 같은 코드로 본다",
  check({ codeData: ON, requestedCode: MINE, claims: tok("  " + MINE + " ") }).ok === true);

// ════════════════════════════════════════════════════════
// [5] ⓓ 평문 비밀번호가 어디에도 저장되지 않는다
// ════════════════════════════════════════════════════════
console.log("\n[5] ⓓ 평문은 응답에만 — 어떤 문서에도 쓰지 않는다");
const issueBody = cfBody(serverSrc, "partnerIssuePassword");
ok("partnerIssuePassword 본문을 찾았다(신호 유무)", !!issueBody);
const setPwBody = cfBody(serverSrc, "partnerSetPassword");
ok("partnerSetPassword 본문을 찾았다(신호 유무)", !!setPwBody);

// 🔴 «문서에 실제로 쓰는 값» = 모든 `.set(`/`.update(` 인자. 거기에 평문 토큰이 남아 있으면
//    어딘가에 저장되고 있는 것이다. 해시로 감싼 사용처만 지우고, 남는 게 있으면 실패 —
//    새 사용처를 늘리려면 이 목록을 고쳐야 하고, 그 순간 사람이 «이게 저장되나» 를 다시 본다.
const ALLOWED = [
  "hashPartnerPassword(password)", "hashPartnerPassword(newPassword)",
  "passwordHash", "passwordInitial", "passwordIssuedAt",
];
function residue(body) {
  const hits = [];
  for (const w of writePayloads(body)) {
    let t = w;
    for (const a of ALLOWED) t = t.split(a).join("");
    (t.match(/password/gi) || []).forEach((h) => hits.push(w.slice(0, 60)));
  }
  return hits;
}
const issueWrites = writePayloads(issueBody);
const setPwWrites = writePayloads(setPwBody);
ok("ⓓ 발급 함수에서 문서 쓰기를 찾았다(신호 유무)", issueWrites.length >= 2, issueWrites.length);
ok("ⓓ 변경 함수에서 문서 쓰기를 찾았다(신호 유무)", setPwWrites.length >= 1, setPwWrites.length);
eq("ⓓ 발급이 문서에 쓰는 값에 평문 토큰 잔여 0", residue(issueBody).length, 0, residue(issueBody));
eq("ⓓ 변경이 문서에 쓰는 값에 평문 토큰 잔여 0", residue(setPwBody).length, 0, residue(setPwBody));
ok("ⓓ 발급 로그에 평문을 찍지 않는다",
  (stripBlockComments(issueBody).match(/console\.(log|warn|error)\([^\n]*\bpassword\b/g) || []).length === 0);
ok("ⓓ 발급 응답에는 평문이 1회 실린다(계약 확인)",
  /return \{[\s\S]*\bpassword,/.test(issueBody));
ok("ⓓ 비밀번호는 해시로만 저장된다",
  issueBody.indexOf("passwordHash: hashPartnerPassword(password)") > 0);
ok("ⓓ 변경도 해시로만 저장된다",
  setPwBody.indexOf("passwordHash: hashPartnerPassword(newPassword)") > 0);

// ════════════════════════════════════════════════════════
// [6] ⓔ 해시가 partnerCodes(공개 read)에 들어가지 않는다
// ════════════════════════════════════════════════════════
console.log("\n[6] ⓔ 해시는 partnerSecrets 에만 — partnerCodes 는 read 가 공개다");
ok("secret 참조가 partnerSecrets 컬렉션이다",
  /partnerSecretRef[\s\S]{0,220}collection\("partnerSecrets"\)/.test(serverSrc));
ok("승계표가 partnerSessions 컬렉션이다",
  /partnerSessionRef[\s\S]{0,260}collection\("partnerSessions"\)/.test(serverSrc));
// partnerCodes 문서에 쓰는 곳 주변에 해시가 없는지 근접 스캔
const clean = stripComments(serverSrc);
let proximityBad = 0;
let idx = clean.indexOf("partnerCodes");
while (idx >= 0) {
  const win = clean.slice(idx, idx + 260);
  if (/passwordHash/.test(win)) proximityBad++;
  idx = clean.indexOf("partnerCodes", idx + 1);
}
eq("ⓔ partnerCodes 근처에 passwordHash 가 없다", proximityBad, 0);
ok("ⓔ partnerCodes 에 쓰는 것은 발급 시각뿐이다",
  issueBody.indexOf("snap.ref.set({ passwordIssuedAt: now }") > 0);
ok("ⓔ 새 컬렉션 2종이 rules 로 완전 차단돼 있다",
  /match \/partnerSecrets\/\{code\} \{\s*\n\s*allow read, write: if false;/.test(rulesSrc)
  && /match \/partnerSessions\/\{tokenHash\} \{\s*\n\s*allow read, write: if false;/.test(rulesSrc));
// 🔴 P4 영역은 이번에 건드리지 않는다 — 건드리면 승객앱 `?pc=` 브랜딩이 죽는다.
ok("partnerCodes read 공개는 그대로다(P4 범위 · 이번에 건드리지 않았다)",
  /match \/partnerCodes\/\{code\} \{\s*\n\s*allow read:\s*if true;/.test(rulesSrc));

// ════════════════════════════════════════════════════════
// [7] ⓕ 관리자 아닌 호출자의 발급 거부 · 배선 잠금
// ════════════════════════════════════════════════════════
console.log("\n[7] ⓕ 발급은 관리자 전용 · 판정은 순수 모듈이 한다");
ok("ⓕ 발급 함수 첫 줄이 assertAdmin 이다",
  /onCall\(\{ invoker: "public" \}, async \(request\) => \{\s*\n\s*await assertAdmin\(request\);/.test(issueBody));
ok("ⓕ 회사 격리 — superadmin 이 아니면 자기 회사만",
  /me\.role !== "superadmin" && me\.companyId !== companyId/.test(issueBody));
ok("ⓕ 대상 코드가 그 회사 것인지도 확인한다",
  /cd\.companyId !== companyId/.test(issueBody));
ok("발급·로그인 onCall 에 invoker 가 명시돼 있다(IAM 401 과 우리 거부를 구분)",
  (serverSrc.match(/exports\.partner(Login|Resume|Logout|SetPassword|IssuePassword) = onCall\(\{ invoker: "public" \}/g) || []).length === 5);
ok("포털 CF 게이트가 순수 모듈 판정을 쓴다(로직 복제 금지)",
  /planPartnerCallerCheck\(\{/.test(serverSrc) && /async function assertPartnerCaller/.test(serverSrc));
ok("로그인 CF 가 순수 모듈 판정을 쓴다", /planPartnerLogin\(\{/.test(serverSrc));
ok("승계 CF 가 순수 모듈 판정을 쓴다", /planPartnerResume\(\{/.test(serverSrc));
ok("비밀번호 변경은 신원을 클레임에서만 읽는다(코드 인자 없음)",
  /claims\.role !== "partner"/.test(setPwBody) && !/request\.data[\s\S]{0,80}partnerCode/.test(setPwBody));
ok("승객 salt 와 다른 salt 를 쓴다",
  S.PARTNER_PASSWORD_SALT !== "buslink_salt_2026");

// ════════════════════════════════════════════════════════
// [8] 화면 배선 — 부재 = 현행 · 문구는 상수 하나에서
// ════════════════════════════════════════════════════════
console.log("\n[8] 화면 배선");
const partnerApp = stripComments(read("src/pages/PartnerApp.js"));
const adminApp = stripComments(read("src/pages/AdminApp.js"));
ok("포털이 authRequired 로 비밀번호 칸을 가른다", /isPartnerAuthRequired\(data\)/.test(partnerApp));
ok("포털이 켠 거래처에서만 partnerLogin 을 부른다",
  /isPartnerAuthRequired\(data\)[\s\S]{0,400}setAuthPending/.test(partnerApp));
ok("포털이 첫 로그인 시 변경 화면을 강제한다",
  /res\.passwordInitial\) setMustSetPassword\(true\)/.test(partnerApp) && /mustSetPassword && codeData/.test(partnerApp));
ok("변경 화면에 «건너뛰기» 가 없다",
  !/건너뛰기/.test(partnerApp));
ok("포털이 30일 세션(업체코드) 저장을 그대로 쓴다(2026-09-02 회귀 가드)",
  /savePartnerSession\(trimmed, rt \? \{ resumeToken: rt \} : undefined\)/.test(partnerApp));
ok("승계 실패가 저장된 업체코드를 지우지 않는다",
  /savePartnerSession\(saved\.code\);\s*$/m.test(partnerApp) || /savePartnerSession\(saved\.code\);/.test(partnerApp));
ok("로그아웃이 서버 승계표까지 끊는다", /partnerLogout\(\{ companyId: codeData\.companyId, resumeToken \}\)/.test(partnerApp));
// 🔴 문구를 화면에서 다시 타이핑하면 «평문을 저장하지 않는다» 는 계약과 갈린다.
ok("관리자 발급 모달이 안내 문구 상수를 그대로 쓴다",
  /\{PARTNER_PASSWORD_ISSUE_NOTICE\}/.test(adminApp));
ok("관리자 화면이 안내 문구를 리터럴로 복사하지 않았다",
  adminApp.indexOf(S.PARTNER_PASSWORD_ISSUE_NOTICE) < 0);
ok("켤 때 «오늘 업무를 못 한다» 확인 창을 띄운다",
  /오늘 업무를 할 수 없습니다/.test(adminApp) && /handleToggleAuthRequired/.test(adminApp));
ok("비밀번호를 발급하지 않은 거래처는 켤 수 없다",
  /!authEditTarget\.passwordIssuedAt && !authIssued/.test(adminApp));
ok("일괄로 전 거래처를 켜는 코드가 없다",
  !/authRequired: true[\s\S]{0,120}(forEach|for \(|map\()/.test(adminApp));

// ════════════════════════════════════════════════════════
// [9] 🔴 대조군 — 옛 동작을 같은 잣대로 태운다
// ════════════════════════════════════════════════════════
console.log("\n[9] 🔴 대조군(옛 동작)이 실제로 빨개지는가");
// 2026-09-04 이전의 `assertPartnerCaller` = «실재하는 활성 코드인가» 뿐이었다(토큰 개념 없음).
function legacyCallerCheck({ codeData, companyId, requestedCode }) {
  const code = String(requestedCode || "").trim();
  if (!code) return { ok: false };
  if (!codeData || codeData.active === false || codeData.companyId !== companyId) return { ok: false };
  return { ok: true };
}
// 옛 포털 로그인 = 업체코드만 맞으면 통과(비밀번호라는 개념이 없다).
function legacyLogin({ codeData, companyId }) {
  if (!codeData || codeData.active === false || codeData.companyId !== companyId) return { ok: false };
  return { ok: true, passwordInitial: false };
}
const control = [
  ["ⓑ 켠 거래처 · 비밀번호 없음 = 거부", () => legacyLogin({ codeData: ON, companyId: CID }).ok === false],
  ["ⓑ 켠 거래처 · 틀린 비밀번호 = 거부", () => legacyLogin({ codeData: ON, companyId: CID, password: "wrong" }).ok === false],
  ["ⓑ 켜 두고 발급 안 함 = 거부", () => legacyLogin({ codeData: ON, companyId: CID, password: "x" }).ok === false],
  ["ⓒ 내 토큰 + 남의 코드 = 거부", () => legacyCallerCheck({ codeData: ON, companyId: CID, requestedCode: THEIRS, claims: tok(MINE) }).ok === false],
  ["ⓒ 다른 회사 토큰 = 거부", () => legacyCallerCheck({ codeData: ON, companyId: CID, requestedCode: MINE, claims: tok(MINE, "other") }).ok === false],
  ["ⓒ 꺼진 거래처 + 남의 토큰 = 거부", () => legacyCallerCheck({ codeData: OFF, companyId: CID, requestedCode: THEIRS, claims: tok(MINE) }).ok === false],
  ["ⓑ 켠 거래처 · 토큰 없는 호출 = 거부", () => legacyCallerCheck({ codeData: ON, companyId: CID, requestedCode: MINE, claims: {} }).ok === false],
];
let controlFail = 0;
for (const [name, f] of control) {
  const passed = (() => { try { return !!f(); } catch { return false; } })();
  if (!passed) { controlFail++; console.log("  🔴 옛 동작 실패(기대함): " + name); }
  else console.log("  ⚠ 옛 동작도 통과함 — 이 단언은 공허할 수 있다: " + name);
}
// 대조군은 «반드시 빨개져야» 한다. 전부 통과하면 이 파일이 아무것도 안 지키고 있다는 뜻이다.
ok("대조군 " + control.length + "건이 전부 옛 동작에서 실패한다(공허하지 않음)",
  controlFail === control.length, { controlFail, total: control.length });
// 뒤집은 단언 — 판정을 뒤집으면 검사가 잡아내는가
ok("뒤집은 단언 검출: 켠 거래처를 통과로 바꾸면 잡힌다",
  S.planPartnerLogin({ codeData: ON, companyId: CID, password: "", secret: SECRET, nowMs: 1 }).ok !== true);

console.log("\n대조군 실패(기대) " + controlFail + "/" + control.length + "건");
console.log((fail === 0 ? "✅ 전부 통과" : "❌ 실패 있음") + " — " + pass + " pass / " + fail + " fail");
process.exit(fail === 0 ? 0 : 1);
