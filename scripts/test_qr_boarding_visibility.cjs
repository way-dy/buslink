// 승객앱 QR 탑승 노출 스위치 격리 검증 (2026-09-04 배시현 개선요청 `ELDcdSFD…`)
//   node scripts/test_qr_boarding_visibility.cjs
// 🔴 Firebase 접속 0 · prod 읽기/쓰기 0.
// 🔴 판정식을 **소스에서 그대로 뽑아** 태운다(재구현 금지 — 재구현하면 소스가 바뀌어도 초록이 된다).
//
// 이 테스트가 잠그는 것은 딱 하나다: **부재 = 노출**.
//   다른 거래처 옵션(homepage·tagSound·inquiry)은 전부 `부재 = 꺼짐`이라, 그 패턴을 베끼면
//   배포 순간 **전 거래처에서 QR 탑승이 사라진다.** 여기가 그 사고를 막는 자리다.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
};

// ── 순수 모듈 로드 ───────────────────────────────────────────
function loadPure(rel, names) {
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/^export /gm, "");
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(src + "\n;" + names.map((n) => `this.${n}=${n};`).join(""), ctx);
  return ctx;
}
const qb = loadPure("src/lib/qrBoarding.js", ["resolveQrBoardingConfig"]);
const R = qb.resolveQrBoardingConfig;

// ── EmployeeApp 의 탭 구성 원문 발췌 ─────────────────────────
const empSrc = fs.readFileSync(path.join(ROOT, "src/pages/EmployeeApp.js"), "utf8");
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
const ids = (arr) => arr.map((t) => t.id).join(",");

console.log("\n[A] 판정식 — 🔴 부재는 «노출»이다(다른 옵션들과 폴러리티가 반대)");
ok("문서에 qrBoarding 이 없으면 보임", R({}).visible === true);
ok("null/undefined 문서도 보임", R(null).visible === true && R(undefined).visible === true);
ok("qrBoarding 이 객체가 아니면 보임", R({ qrBoarding: true }).visible === true && R({ qrBoarding: "off" }).visible === true);
// 실제 prod 거래처 문서 모양 — 이 필드는 아무도 안 갖고 있다(전부 이 경로로 떨어진다).
ok("기존 거래처 문서(브랜딩·문의·소리만 있음)는 보임",
  R({ partnerName: "채드윅송도국제학교", branding: { primaryColor: "#0B2A5B" }, inquiry: { enabled: true }, tagSound: { forced: true } }).visible === true);

console.log("\n[B] 끄기 — visible:false 하나만 숨긴다");
ok("visible:false 면 숨김", R({ qrBoarding: { visible: false } }).visible === false);
ok("visible:true 면 보임", R({ qrBoarding: { visible: true } }).visible === true);
ok("빈 객체 { } 면 보임(스위치를 만든 적 없는 상태)", R({ qrBoarding: {} }).visible === true);
// 🔴 문자열 "false" 로 숨겨지면 안 된다 — 그러면 오타 한 번에 거래처 기능이 사라진다.
ok('문자열 "false" 는 숨기지 않는다', R({ qrBoarding: { visible: "false" } }).visible === true);
ok("0·null 도 숨기지 않는다",
  R({ qrBoarding: { visible: 0 } }).visible === true && R({ qrBoarding: { visible: null } }).visible === true);

console.log("\n[C] 탭바 — 끈 거래처는 '탑승' 탭이 사라지고 나머지 순서는 그대로");
ok("기본(전부 꺼짐)은 5탭 — 현행 그대로", ids(visibleTabsFor(false, false, true)) === "home,routes,notices,scan,settings");
// 🔴 인자를 안 넘긴 옛 호출부가 탭을 잃으면 안 된다(기본값 true).
ok("scanOn 인자를 생략해도 탑승 탭이 남는다", ids(visibleTabsFor(false, false)) === "home,routes,notices,scan,settings");
ok("scanOn=false 면 탑승 탭만 빠진다", ids(visibleTabsFor(false, false, false)) === "home,routes,notices,settings");
ok("문의 탭과 함께 — 문의는 설정 앞자리를 지킨다",
  ids(visibleTabsFor(true, false, false)) === "home,routes,notices,inquiry,settings");
ok("홈페이지 탭과 함께 — 홈페이지가 문의를 대체하는 규칙은 그대로",
  ids(visibleTabsFor(true, true, false)) === "home,routes,notices,homepage,settings");
ok("숨겨도 설정 탭은 언제나 맨 끝",
  visibleTabsFor(true, false, false).slice(-1)[0].id === "settings" &&
  visibleTabsFor(true, true, true).slice(-1)[0].id === "settings");

console.log("\n[D] 홈 화면 — 탭과 버튼이 «한 값»으로 묶여 있는가(반쪽 상태 금지)");
// 🔴 소스를 문자열로 잰다. 버튼을 탭과 따로 판정하면 «탭은 없는데 버튼은 남는» 상태가 생기고,
//    그게 이 요청이 다시 올라오는 경로다.
ok("HomeTab 에 onScanTab 을 조건부로 넘긴다(qrBoardingOn ? … : null)",
  /onScanTab=\{qrBoardingOn \? \(\) => setTab\("scan"\) : null\}/.test(empSrc));
const qrButtons = empSrc.match(/<button onClick=\{onScanTab\}/g) || [];
ok("홈의 QR 탑승 버튼은 2곳(내 정류장 있음/없음)", qrButtons.length === 2, `실제 ${qrButtons.length}곳`);
const guards = empSrc.match(/\{onScanTab && \(/g) || [];
ok("두 버튼 모두 onScanTab 가드 안에 있다", guards.length === 2, `가드 ${guards.length}개`);
// 노선도 위 안내 문구가 없는 버튼을 가리키면 안 된다.
ok("안내 문구가 QR 탑승 유무로 갈린다",
  /탑승하실 정류장을 선택하시면 QR탑승 하실 수 있습니다\./.test(empSrc) &&
  /탑승하실 정류장을 선택하시면 도착 시간을 안내해 드립니다\./.test(empSrc));
// 🔴 내 정류장 유도 자체는 남아야 한다 — 도착 안내·임박 알림의 전제다(문구를 지우면 지정률이 떨어진다).
ok("끈 거래처에서도 정류장 선택 유도는 남는다",
  /선택하시면 도착 시간을 안내해 드립니다/.test(empSrc));

console.log("\n[E] 관리자 화면 — 저장이 기존 거래처를 끄지 않는가");
const admSrc = fs.readFileSync(path.join(ROOT, "src/pages/AdminApp.js"), "utf8");
// 🔴 폼 초기값이 false 면 «저장만 눌러도 QR 탑승이 사라진다».
// ⚠ 소스가 없으면 `undefined.split` 로 죽는다 — 대조군에서 조용히 크래시하지 않도록 한 줄만 안전하게 꺼낸다.
const qrStateLine = (admSrc.split("const [pQrBoarding, setPQrBoarding] = ")[1] || "").split("\n")[0];
ok("폼 기본값이 켜짐", /^useState\(true\)/.test(qrStateLine), `실제 «${qrStateLine}»`);
ok("모달을 열 때 문서 값을 판정식으로 싣는다",
  /setPQrBoarding\(resolveQrBoardingConfig\(code\)\.visible\)/.test(admSrc));
ok("저장이 qrBoarding.visible 로 쓴다", /qrBoarding: \{\s*\n\s*visible: pQrBoarding,/.test(admSrc));
ok("판정식을 관리자 화면도 같은 모듈에서 가져온다(값 해석이 갈리지 않게)",
  /import \{ resolveQrBoardingConfig \} from "\.\.\/lib\/qrBoarding";/.test(admSrc));
// 목록 배지는 «끈 곳만» — 반대로 달면 전 거래처가 배지로 도배된다.
ok("목록 배지는 끈 거래처만 표시", /!resolveQrBoardingConfig\(c\)\.visible &&/.test(admSrc));

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass}/${pass + fail} 통과`);
process.exit(fail === 0 ? 0 : 1);
