// 격리 테스트 — 초기 PIN 이 **클라·서버·안내문구 세 곳에서 같은 값**인가 (2026-09-01 사고).
//   node scripts/test_initial_pin_parity.cjs
//
// 사고 요약: 2026-08-25 way 결정(「초기 PIN 000000 고정」)을 **클라에만** 반영하고
// 서버 `generateInitialPinAdmin` 을 랜덤 그대로 뒀다. 2026-08-28 P3-a 로 등록·재발급이
// CF 로 이관되면서 **실제로 도는 것이 서버**가 되어, 그 뒤 신규·재발급된 사람은
// 로그인 화면 안내(「초기 비밀번호는 000000」)대로 넣어도 로그인이 안 됐고,
// PIN 설정 화면에 닿지 못해 **스스로 회복할 방법이 없었다**(재발급도 랜덤이라 같은 벽).
// prod 에서 2명이 실제로 갇혀 있었다.
//
// 🔴 이 테스트가 지키는 불변식 = **세 곳이 같은 값을 말한다.** 하나만 고치면 여기서 빨개진다.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${x !== undefined ? " — " + JSON.stringify(x) : ""}`); } };
const eq = (n, a, b) => ok(n, a === b, { actual: a, expected: b });

// ── 클라 정본 (순수 모듈이라 그대로 태운다) ──
const clientSrc = read("src/lib/accountCards.js");
const ctx = vm.createContext({ console, crypto: require("crypto"), window: undefined });
vm.runInContext(clientSrc.replace(/^export\s+function\s+/gm, "function ").replace(/^export\s+const\s+/gm, "var "), ctx);
const clientPin = ctx.generateInitialPin();

// ── 서버 (index.js 는 defineSecret 이라 통째로 못 태운다 → 함수 본문만 뽑아 평가) ──
const serverSrc = read("functions/index.js");
const genBody = (serverSrc.match(/function generateInitialPinAdmin\(\)\s*\{([\s\S]*?)\n\}/) || [])[1];
ok("서버 발급 함수를 소스에서 찾았다(신호 유무)", !!genBody, genBody);
const sctx = vm.createContext({ crypto: require("crypto") });
vm.runInContext(`function generateInitialPinAdmin(){${genBody}\n}`, sctx);
const serverPin = sctx.generateInitialPinAdmin();

console.log("\n[1] 🔴 클라와 서버가 같은 초기 PIN 을 낸다");
console.log(`    클라 = "${clientPin}" · 서버 = "${serverPin}"`);
eq("두 값이 같다", serverPin, clientPin);
ok("발급값이 6자리 숫자다", /^\d{6}$/.test(serverPin), serverPin);
// 랜덤으로 되돌아가면 두 번 호출한 값이 갈린다 — 고정값 계약을 직접 잠근다.
eq("서버 발급은 호출마다 같다(고정값 계약)", sctx.generateInitialPinAdmin(), serverPin);

console.log("\n[2] 🔴 지정 초기 PIN 검사가 기본값을 거부하지 않는다");
// 거부하면 담당자가 엑셀에 기본값을 적는 순간 그 행만 조용히 실패한다.
const valBody = (serverSrc.match(/function isValidInitialPinAdmin\(v\)\s*\{([\s\S]*?)\n\}/) || [])[1];
ok("서버 검사 함수를 찾았다(신호 유무)", !!valBody);
vm.runInContext(`function isValidInitialPinAdmin(v){${valBody}\n}`, sctx);
ok(`기본값 "${serverPin}" 을 유효로 본다`, sctx.isValidInitialPinAdmin(serverPin) === true);
ok("숫자 아닌 값은 거부", sctx.isValidInitialPinAdmin("abc") === false);
ok("빈 값 거부", sctx.isValidInitialPinAdmin("") === false && sctx.isValidInitialPinAdmin(null) === false);

console.log("\n[3] 🔴 화면 안내가 그 값과 같은 말을 한다");
const emp = read("src/pages/EmployeeApp.js");
ok("로그인 화면이 초기 비밀번호를 그 값으로 안내한다",
  new RegExp(`초기 비밀번호는[\\s\\S]{0,120}${serverPin}`).test(emp), serverPin);
ok("도움말이 «재발급하면 그 값으로 돌아간다» 고 안내한다",
  new RegExp(`재발급하면[\\s\\S]{0,160}${serverPin}[\\s\\S]{0,60}돌아가`).test(emp));

console.log("\n[4] 새 비밀번호로는 그 값을 못 쓰게 막는다(«바꿨는데 그대로» 방지)");
// 🔴 [2] 와 헷갈리지 말 것 — 발급값으로는 유효하지만, **본인이 정하는 새 번호**로는 거부다.
ok("클라 FirstPinSetup 이 거부한다", new RegExp(`newPin === "${serverPin}"`).test(emp));
ok("서버 passengerSetPin 도 거부한다",
  new RegExp(`String\\(newPin\\) === "${serverPin}"`).test(serverSrc));

console.log(`\n${fail === 0 ? "✅ 전부 통과" : "❌ 실패 있음"} — ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
