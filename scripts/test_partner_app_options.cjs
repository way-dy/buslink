// 거래처 승객앱 옵션 정본 격리 검증 — 홈페이지 연결 · 태깅 소리 (2026-08-25 미팅)
//   node scripts/test_partner_app_options.cjs
// 🔴 Firebase 접속 0 · prod 읽기/쓰기 0. 소스를 **베끼지 않고 그대로 vm 에 태운다**(재구현 0).
const path = require("path");
const fs = require("fs");
const vm = require("vm");
const ROOT = path.join(__dirname, "..");

// ESM 소스에서 `export ` 만 떼어 컨텍스트에 태운다(두 모듈 다 순수 — import 0).
function loadPure(rel, names) {
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/^export /gm, "");
  const ctx = { console, URL, localStorage: undefined, window: undefined };
  vm.createContext(ctx);
  vm.runInContext(src + "\n;" + names.map((n) => `this.${n}=${n};`).join(""), ctx);
  return ctx;
}

const hp = loadPure("src/lib/homepage.js", ["isValidHomepageUrl", "resolveHomepageConfig", "homepageDisplayHost"]);
const ts = loadPure("src/lib/tagSound.js", ["resolveTagSoundConfig"]);

let n = 0, fail = 0;
const ok = (name, cond, got) => {
  n++;
  console.log(`  ${cond ? "✓" : "✗"} ${name}${!cond && got !== undefined ? " → " + JSON.stringify(got) : ""}`);
  if (!cond) fail++;
};

// 실제로 쓰는 주소(신촌세브란스) — 퍼센트 인코딩된 한글 경로가 섞여 있다.
const REAL = "https://sites.google.com/dongyeongtour.co.kr/ssh/%ED%99%88";

console.log("\n[A] 주소 검증 — 무엇을 통과시키고 무엇을 막는가");
ok("실제 신촌세브란스 주소는 통과", hp.isValidHomepageUrl(REAL));
ok("http 통과", hp.isValidHomepageUrl("http://example.com"));
ok("앞뒤 공백은 허용(입력 실수)", hp.isValidHomepageUrl("  https://a.co  "));
// 🔴 여기가 이 모듈이 존재하는 이유다 — 관리자 입력이라도 스킴을 믿지 않는다.
ok("javascript: 는 막는다", !hp.isValidHomepageUrl("javascript:alert(1)"));
ok("data: 는 막는다", !hp.isValidHomepageUrl("data:text/html,<h1>x"));
ok("스킴 없는 주소는 막는다(www.a.co)", !hp.isValidHomepageUrl("www.a.co"));
ok("빈 문자열·null·숫자는 막는다",
  !hp.isValidHomepageUrl("") && !hp.isValidHomepageUrl(null) && !hp.isValidHomepageUrl(123));

console.log("\n[B] 홈페이지 설정 — 부재 = 꺼짐(기존 거래처 회귀 0)");
ok("문서에 homepage 가 없으면 꺼짐", hp.resolveHomepageConfig({}).enabled === false);
ok("null/undefined 문서도 꺼짐",
  hp.resolveHomepageConfig(null).enabled === false && hp.resolveHomepageConfig(undefined).enabled === false);
ok("homepage 가 객체가 아니면 꺼짐", hp.resolveHomepageConfig({ homepage: "https://a.co" }).enabled === false);
// 스위치만 켜고 주소가 없으면 승객에게 죽은 버튼이 열린다 → 탭 자체를 안 띄운다.
ok("스위치만 켜고 주소 없으면 꺼짐", hp.resolveHomepageConfig({ homepage: { enabled: true } }).enabled === false);
ok("스위치 켜고 주소 나쁘면 꺼짐",
  hp.resolveHomepageConfig({ homepage: { enabled: true, url: "javascript:1" } }).enabled === false);
ok("주소만 있고 스위치 꺼짐이면 꺼짐(주소는 보존)", (() => {
  const c = hp.resolveHomepageConfig({ homepage: { enabled: false, url: REAL } });
  return c.enabled === false && c.url === REAL;
})());
ok("스위치+주소 둘 다면 켜짐", (() => {
  const c = hp.resolveHomepageConfig({ homepage: { enabled: true, url: REAL } });
  return c.enabled === true && c.url === REAL;
})());
ok("enabled 는 true 만 인정(문자열 \"true\" 는 꺼짐)",
  hp.resolveHomepageConfig({ homepage: { enabled: "true", url: REAL } }).enabled === false);

console.log("\n[C] 표시용 호스트");
ok("긴 주소에서 호스트만 뽑는다", hp.homepageDisplayHost(REAL) === "sites.google.com", hp.homepageDisplayHost(REAL));
ok("파싱 실패해도 안 죽는다", typeof hp.homepageDisplayHost("nonsense") === "string");

console.log("\n[D] 태깅 소리 — 부재 = 강제 아님");
ok("문서에 tagSound 없으면 강제 아님", ts.resolveTagSoundConfig({}).forced === false);
ok("null 문서도 강제 아님", ts.resolveTagSoundConfig(null).forced === false);
ok("forced:true 만 강제", ts.resolveTagSoundConfig({ tagSound: { forced: true } }).forced === true);
ok("forced 가 문자열이면 강제 아님", ts.resolveTagSoundConfig({ tagSound: { forced: "true" } }).forced === false);

// 🔴 회귀 가드 — 홈페이지가 켜지면 문의 탭은 **사라져야 한다**(둘이 나란히 뜨면 승객이 갈린다).
//    판정식은 EmployeeApp `visibleTabsFor(inquiryOn, homepageOn)` 이므로 그 소스를 직접 읽어 확인한다.
console.log("\n[E] 탭 대체 규칙(소스 가드)");
const emp = fs.readFileSync(path.join(ROOT, "src/pages/EmployeeApp.js"), "utf8");
ok("visibleTabsFor 가 homepageOn 을 우선한다",
  /const extra = homepageOn \? HOMEPAGE_TAB : \(inquiryOn \? INQUIRY_TAB : null\);/.test(emp));
ok("홈페이지가 켜지면 문의 탭에 있던 사람도 홈으로 되돌린다",
  /if \(tab === "inquiry" && \(!inquiryOn \|\| homepageOn\)\) setTab\("home"\);/.test(emp));
ok("🔴 홈페이지를 iframe 으로 감싸지 않는다(임베드 차단 사이트)", !/HomepageTab[\s\S]{0,1200}<iframe/.test(emp));

console.log(`\n${fail === 0 ? "✅" : "❌"} ${n - fail}/${n} 통과`);
process.exit(fail === 0 ? 0 : 1);
