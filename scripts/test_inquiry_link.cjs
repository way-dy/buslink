#!/usr/bin/env node
// 문의 게시판 연동 격리 테스트 (2026-08-06)
//
// 대상 = `src/lib/inquiry.js`(순수) + `EmployeeApp.js` 의 탭 삽입 함수 `visibleTabsFor`.
// 🔴 판정식을 **소스에서 그대로 뽑아** 태운다(재구현 금지 — 재구현하면 소스가 바뀌어도 초록이 된다).
//
// 실행: node scripts/test_inquiry_link.cjs

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
};
const eq = (name, actual, expected) =>
  ok(name, actual === expected, `기대 ${JSON.stringify(expected)} / 실제 ${JSON.stringify(actual)}`);

// ── 소스 로드 ───────────────────────────────────────────────
// inquiry.js 는 순수 ESM 이므로 `export` 만 걷어내 vm 에 그대로 태운다.
const inquirySrc = fs.readFileSync(path.join(ROOT, "src/lib/inquiry.js"), "utf8");
const ctx = { URLSearchParams, module: {}, exports: {} };
vm.createContext(ctx);
// ⚠ vm 에서 top-level `const` 는 컨텍스트 객체의 속성이 되지 않는다(function 선언만 올라온다)
//   → 같은 스크립트 끝에 수집 줄을 붙여 상수까지 꺼낸다.
vm.runInContext(
  inquirySrc.replace(/^export\s+/gm, "") + "\n;this.__exp = { INQUIRY_WIDGET_ORIGIN };",
  ctx,
);
const { resolveInquiryConfig, buildInquiryUrl, buildInquiryPreviewUrl, isValidTenantId } = ctx;
const { INQUIRY_WIDGET_ORIGIN } = ctx.__exp;

// EmployeeApp 의 탭 삽입 — TABS 배열 + visibleTabsFor 함수 원문만 발췌해 태운다.
const empSrc = fs.readFileSync(path.join(ROOT, "src/pages/EmployeeApp.js"), "utf8");
// 🔄 2026-08-31 갱신 — 2026-08-25 에 **홈페이지 탭**이 생기며 시그니처가 `(inquiryOn, homepageOn)`
//    으로 바뀌었는데 추출 정규식이 `(inquiryOn)` 에 고정돼 있어 그날부터 이 테스트가 통째로
//    죽어 있었다(러너가 없어 아무도 몰랐다). 인자 목록은 느슨하게 받되 **HOMEPAGE_TAB 은 필수**로
//    둔다 — 그 탭이 사라지면 아래 대체 규칙 단언이 의미를 잃으므로 그때는 시끄럽게 실패해야 한다.
const tabsBlock = empSrc.match(/const TABS = \[[\s\S]*?\n\];/);
const inqTabBlock = empSrc.match(/const INQUIRY_TAB = \{[^}]*\};/);
const homeTabBlock = empSrc.match(/const HOMEPAGE_TAB = \{[^}]*\};/);
const visFnBlock = empSrc.match(/function visibleTabsFor\([^)]*\) \{[\s\S]*?\n\}/);
if (!tabsBlock || !inqTabBlock || !homeTabBlock || !visFnBlock) {
  console.error("🔴 EmployeeApp.js 에서 TABS/INQUIRY_TAB/HOMEPAGE_TAB/visibleTabsFor 를 못 찾았습니다 (이름이 바뀌었나요?)");
  process.exit(1);
}
const tabCtx = {};
vm.createContext(tabCtx);
vm.runInContext([tabsBlock[0], inqTabBlock[0], homeTabBlock[0], visFnBlock[0]].join("\n"), tabCtx);
const { visibleTabsFor } = tabCtx;

console.log("\n[1] tenantId 형식 판정");
ok("영문 소문자 약칭 통과 (snu)", isValidTenantId("snu"));
ok("숫자·하이픈·언더바 통과", isValidTenantId("samsung-sds_2"));
ok("앞뒤 공백은 trim 후 판정", isValidTenantId("  snu  "));
ok("빈 문자열 거부", !isValidTenantId(""));
ok("공백 포함 거부 (내부 공백)", !isValidTenantId("서울 대"));
ok("한글 거부 — dycs docId 컨벤션 밖", !isValidTenantId("신촌세브란스"));
ok("경로문자 거부 (Firestore 경로 오염 차단)", !isValidTenantId("a/b"));
ok("쿼리문자 거부", !isValidTenantId("snu&tenant=hanwha"));
ok("null/undefined/숫자 거부", !isValidTenantId(null) && !isValidTenantId(undefined) && !isValidTenantId(3));
ok("64자 초과 거부", !isValidTenantId("a".repeat(65)));

console.log("\n[2] 설정 해석 — 🔴 부재·모르는 값 = 꺼짐(기존 거래처 회귀 0)");
eq("inquiry 필드 자체가 없는 레거시 문서 = 꺼짐",
  resolveInquiryConfig({ partnerName: "채드윅", active: true }).enabled, false);
eq("문서가 null 이어도 throw 없이 꺼짐", resolveInquiryConfig(null).enabled, false);
eq("undefined 도 꺼짐", resolveInquiryConfig(undefined).enabled, false);
eq("inquiry 가 객체가 아니면(문자열) 꺼짐", resolveInquiryConfig({ inquiry: "on" }).enabled, false);
eq("enabled 가 문자열 'true' 여도 꺼짐(=== true 만 인정)",
  resolveInquiryConfig({ inquiry: { enabled: "true", tenantId: "snu" } }).enabled, false);
eq("🔴 스위치만 켜고 거래처 ID 없음 = 꺼짐(빈 위젯 노출 차단)",
  resolveInquiryConfig({ inquiry: { enabled: true } }).enabled, false);
eq("🔴 거래처 ID 가 형식 위반이면 켜져도 꺼짐",
  resolveInquiryConfig({ inquiry: { enabled: true, tenantId: "신촌 세브란스" } }).enabled, false);
eq("거래처 ID 만 있고 스위치 꺼짐 = 꺼짐",
  resolveInquiryConfig({ inquiry: { enabled: false, tenantId: "snu" } }).enabled, false);
eq("둘 다 갖추면 켜짐", resolveInquiryConfig({ inquiry: { enabled: true, tenantId: "snu" } }).enabled, true);
eq("tenantId 는 trim 되어 나온다",
  resolveInquiryConfig({ inquiry: { enabled: true, tenantId: " snu " } }).tenantId, "snu");
eq("빈 토큰은 null 로 정규화",
  resolveInquiryConfig({ inquiry: { enabled: true, tenantId: "snu", token: "   " } }).token, null);
eq("토큰 보존", resolveInquiryConfig({ inquiry: { enabled: true, tenantId: "snu", token: "tok1" } }).token, "tok1");
eq("꺼진 설정도 tenantId 는 그대로 돌려준다(관리 화면 표시용)",
  resolveInquiryConfig({ inquiry: { enabled: false, tenantId: "snu" } }).tenantId, "snu");

console.log("\n[3] URL 조립 — dycs 위젯 계약(?tenant=·&token=·&intake=1)");
eq("기본 URL", buildInquiryUrl({ enabled: true, tenantId: "snu", token: null }),
  "https://dycs-widget.web.app/?tenant=snu");
eq("오리진 상수와 일치", INQUIRY_WIDGET_ORIGIN, "https://dycs-widget.web.app");
eq("토큰 포함", buildInquiryUrl({ enabled: true, tenantId: "snu", token: "t0k" }),
  "https://dycs-widget.web.app/?tenant=snu&token=t0k");
eq("intake=1 옵션", buildInquiryUrl({ enabled: true, tenantId: "snu", token: null }, { directIntake: true }),
  "https://dycs-widget.web.app/?tenant=snu&intake=1");
eq("꺼진 설정은 null(화면을 안 그린다)", buildInquiryUrl({ enabled: false, tenantId: "snu" }), null);
eq("설정 자체가 없으면 null", buildInquiryUrl(null), null);
eq("형식 위반 tenantId 는 null", buildInquiryUrl({ enabled: true, tenantId: "a b" }), null);
ok("🔴 tenantId 에 & 를 넣어도 파라미터 주입 불가(형식 검사에서 먼저 걸린다)",
  buildInquiryUrl({ enabled: true, tenantId: "snu&tenant=hanwha" }) === null);
eq("미리보기는 스위치와 무관하게 만들어진다(저장 전 확인용)",
  buildInquiryPreviewUrl("hanwha", ""), "https://dycs-widget.web.app/?tenant=hanwha");
eq("미리보기도 형식 위반이면 null", buildInquiryPreviewUrl("한화", ""), null);

console.log("\n[4] 하단 탭 구성 — 켠 거래처만 6탭");
const off = visibleTabsFor(false, false).map(t => t.id);
const on = visibleTabsFor(true, false).map(t => t.id);
eq("꺼짐 = 기존 5탭 그대로(회귀 0)", off.join(","), "home,routes,notices,scan,settings");
eq("켜짐 = 설정 왼쪽에 문의 삽입", on.join(","), "home,routes,notices,scan,inquiry,settings");
ok("🔴 설정은 언제나 맨 끝", on[on.length - 1] === "settings");
ok("기존 탭의 순서·id 는 그대로", on.filter(id => id !== "inquiry").join(",") === off.join(","));
ok("문의 탭에 아이콘·라벨이 있다",
  visibleTabsFor(true, false).some(t => t.id === "inquiry" && t.icon === "chat" && t.label === "문의"));

// 2026-08-25 미팅 결정 — 홈페이지 탭은 문의 탭과 **같은 자리**를 쓰고, 켜면 문의를 **대체**한다.
// (둘을 나란히 두면 승객이 어디로 문의해야 하는지 갈린다. ⚠ 대체되는 순간 그 거래처의
//  dycs 문의 위젯 유입은 끊긴다 — 이 규칙이 조용히 뒤집히면 유입 경로가 통째로 바뀐다.)
const hp = visibleTabsFor(false, true).map(t => t.id);
eq("홈페이지만 켬 = 설정 왼쪽에 홈페이지 삽입", hp.join(","), "home,routes,notices,scan,homepage,settings");
const both = visibleTabsFor(true, true).map(t => t.id);
eq("🔴 둘 다 켜면 홈페이지가 문의를 대체(나란히 두지 않는다)", both.join(","), hp.join(","));
ok("문의 탭은 그때 사라진다", !both.includes("inquiry"));
ok("홈페이지 탭에 아이콘·라벨이 있다",
  visibleTabsFor(false, true).some(t => t.id === "homepage" && t.icon === "globe" && t.label === "홈페이지"));

console.log("\n[5] 회귀 가드 — 소스에 실제로 남아 있는지 코드로 단언");
const inqLib = inquirySrc;
ok("resolveInquiryConfig 가 enabled === true 를 엄격 비교", /enabled\s*===\s*true/.test(inqLib));
ok("buildInquiryUrl 이 tenantId 형식을 재검사(호출부 신뢰 금지)",
  /buildInquiryUrl[\s\S]{0,300}isValidTenantId\(config\.tenantId\)/.test(inqLib));
ok("EmployeeApp 이 문의 탭을 enabled 로 게이팅",
  /const inquiryOn = !!\(inquiry && inquiry\.enabled\)/.test(empSrc));
// 🔄 2026-08-31 갱신 — 종전 단언은 `tab === "inquiry" && !inquiryOn) setTab("home")` 를 **글자 그대로**
//    찾았는데, 소스가 `(!inquiryOn || homepageOn)` 으로 **더 강해지면서**(홈페이지로 대체될 때도 탈출)
//    매칭이 깨졌다. 코드가 좋아졌는데 테스트가 빨개진 형태다 → 괄호·조건 추가에 견디게 느슨히 쓰되,
//    가드가 **사라지면** 반드시 빨개지도록 "탭 이름 → setTab(home)" 근접만 본다.
ok("🔴 꺼진 뒤 문의 탭에 갇히지 않게 홈으로 되돌리는 가드가 있다",
  /tab === "inquiry"[\s\S]{0,60}setTab\("home"\)/.test(empSrc));
ok("🔴 홈페이지 탭도 꺼지면 홈으로 되돌린다(같은 함정의 짝)",
  /tab === "homepage"[\s\S]{0,60}setTab\("home"\)/.test(empSrc));
ok("🔴 임베드 탈출구('새 창에서 열기')가 남아 있다", /새 창에서 열기/.test(empSrc));
ok("탭바가 visibleTabs 를 렌더(TABS 하드코딩으로 되돌아가지 않았다)",
  /\{visibleTabs\.map\(t =>/.test(empSrc));
const adminSrc = fs.readFileSync(path.join(ROOT, "src/pages/AdminApp.js"), "utf8");
ok("🔴 관리자 저장이 거래처 ID 없이 켜는 것을 막는다",
  /pInqOn && !isValidTenantId\(inqTenant\)/.test(adminSrc));
ok("포탈 설정이 inquiry 를 partnerCodes 에 저장", /inquiry:\s*\{[\s\S]{0,120}enabled: pInqOn/.test(adminSrc));

console.log(`\n${fail === 0 ? "✅" : "🔴"} ${pass}/${pass + fail} 통과`);
process.exit(fail === 0 ? 0 : 1);
