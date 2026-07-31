// 격리 테스트 — 공지 발송 이력 목록의 노출·관리 권한 판정(AdminApp NoticeTab).
//   node scripts/test_notice_history.cjs
//
// 2026-07-31 배시현 개선요청 "과거 공지가 앱에 다 보인다 · 관리자가 정리하게 해달라".
// prod 실측 = dy001 공지 110건 중 101건 active, 그중 75건이 "전체" 발송인데 관리 화면은
// 최근 10건만 렌더 → 95건이 앱에는 보이고 관리 화면엔 없었다.
//
// 이 테스트가 지키는 계약 3가지:
//   ① "앱에 보이는가" = 소비측 쿼리와 동일한 `active === true` (느슨한 !==false 금지)
//   ② 제한 admin 은 "전체" 공지를 **볼 수는 있고 손댈 수는 없다**(way 결정)
//   ③ 타 거래처 공지는 여전히 목록에 안 뜬다(Phase B 격리 보존)
//
// 판정식은 AdminApp.js 소스에서 그대로 뽑아 평가한다 — 구현이 바뀌면 같이 깨져야 한다.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const adminSrc = fs.readFileSync(path.join(__dirname, "..", "src", "pages", "AdminApp.js"), "utf8");
const accessSrc = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "partnerAccess.js"), "utf8")
  .replace(/^export\s+function\s+/gm, "function ")
  .replace(/^export\s+const\s+/gm, "var ");

// vm 컨텍스트에 노출되도록 `const` → `var`(const 는 렉시컬 스코프라 ctx 에 안 붙는다).
const grab = (re, label) => {
  const m = adminSrc.match(re);
  if (!m) throw new Error(`${label} 판정식을 AdminApp.js 에서 못 찾음`);
  return m[0].replace(/^\s*const /, "var ");
};
const listedSrc = grab(/const listed = noticeRestricted[\s\S]*?: notices;/, "listed");
const canManageSrc = grab(/const canManage = \(n\) =>.*?;/, "canManage");
const isShownSrc = grab(/const isShown = \(n\) =>.*?;/, "isShown");
const matchedSrc = grab(/const matched = listed\.filter\([\s\S]*?\n {10}\}\);/, "matched");

const CHAD = "DY001-채드윅송도국제학-2026-LKO5";
const DAOU = "DY001-다우디지털스퀘어-2026-H1F4";

// prod 를 닮은 표본: 전체 발송 3건(1건 숨김·1건 필드부재) · 채드윅 2건 · 다우 1건
const NOTICES = [
  { id: "n1", title: "금일 출발 10분 지연됩니다", body: "", partnerCode: null, active: true },
  { id: "n2", title: "ㅅㄷㄴ", body: "테스트", partnerCode: null, active: false },
  { id: "n3", title: "레거시 공지", body: "", partnerCode: null },            // active 필드 부재
  { id: "n4", title: "채드윅 신규 학기를 환영합니다", body: "", partnerCode: CHAD, active: true },
  { id: "n5", title: "test1", body: "", partnerCode: CHAD, active: false },
  { id: "n6", title: "테스트 알림 입니다", body: "", partnerCode: DAOU, active: true },
];

function evaluate({ allowed, histFilter = "전체", histQuery = "" }) {
  const ctx = vm.createContext({ console, notices: NOTICES, allowed, histFilter, histQuery });
  vm.runInContext(accessSrc, ctx);
  vm.runInContext(`var noticeRestricted = !isAllAccess(allowed);`, ctx);
  vm.runInContext(`${listedSrc}\n${canManageSrc}\n${isShownSrc}\nvar q = histQuery.trim().toLowerCase();\n${matchedSrc}`, ctx);
  return {
    listed: ctx.listed.map(n => n.id),
    matched: ctx.matched.map(n => n.id),
    manageable: ctx.listed.filter(ctx.canManage).map(n => n.id),
    shown: ctx.listed.filter(ctx.isShown).map(n => n.id),
  };
}

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${x !== undefined ? " — " + JSON.stringify(x) : ""}`); } };
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b), { actual: a, expected: b });

const ALL = ["*"];
const LIMITED = [CHAD];

console.log("\n[1] 🔴 '앱에 보이는가' 는 active === true — 소비측 where 절과 같은 정의");
eq("전체권한: 표시 중은 active:true 인 3건만", evaluate({ allowed: ALL }).shown, ["n1", "n4", "n6"]);
ok("active 필드가 없는 레거시(n3)는 '표시 중' 이 아니다(앱에서도 안 보인다)",
  !evaluate({ allowed: ALL }).shown.includes("n3"));
eq("'숨김' 필터에 레거시도 잡힌다(되돌리기로 복구 가능해야 함)",
  evaluate({ allowed: ALL, histFilter: "숨김" }).matched, ["n2", "n3", "n5"]);
eq("'표시중' 필터", evaluate({ allowed: ALL, histFilter: "표시중" }).matched, ["n1", "n4", "n6"]);

console.log("\n[2] 🔴 제한 admin — '전체' 공지는 보이되 손댈 수 없다(way 결정)");
const lim = evaluate({ allowed: LIMITED });
eq("목록: 전체 공지 3건 + 자기 거래처 2건", lim.listed, ["n1", "n2", "n3", "n4", "n5"]);
ok("타 거래처(다우 n6)는 여전히 안 보인다 — Phase B 격리 보존", !lim.listed.includes("n6"));
eq("관리 가능: 자기 거래처 것만", lim.manageable, ["n4", "n5"]);
ok("전체 공지 n1 은 읽기 전용", !lim.manageable.includes("n1"));

console.log("\n[3] 전체권한 admin 은 전부 관리 가능");
const full = evaluate({ allowed: ALL });
eq("목록 = 전건", full.listed, ["n1", "n2", "n3", "n4", "n5", "n6"]);
eq("관리 가능 = 전건", full.manageable, ["n1", "n2", "n3", "n4", "n5", "n6"]);
// NoticeTab 이 받는 allowed 는 항상 resolveAllowed 통과분(AdminApp.js:150) — 그 계약대로 모델링.
const legacyAllowed = (() => {
  const c = vm.createContext({ console });
  vm.runInContext(accessSrc, c);
  return c.resolveAllowed("admin", undefined); // 필드 부재 레거시 admin
})();
eq("권한 필드 부재(레거시 admin)는 ['*'] 폴백", legacyAllowed, ["*"]);
eq("따라서 전건 관리 가능(회귀 0)", evaluate({ allowed: legacyAllowed }).manageable.length, 6);
eq("빈 배열(담당 0개) admin 은 '전체' 공지만 읽기로 보인다",
  evaluate({ allowed: [] }).listed, ["n1", "n2", "n3"]);
eq("빈 배열 admin 은 아무것도 관리 못 한다", evaluate({ allowed: [] }).manageable, []);

console.log("\n[4] 검색 — 제목·내용 양쪽, 대소문자 무시");
eq("제목 검색", evaluate({ allowed: ALL, histQuery: "지연" }).matched, ["n1"]);
eq("내용 검색", evaluate({ allowed: ALL, histQuery: "테스트" }).matched, ["n2", "n6"]);
eq("대소문자 무시", evaluate({ allowed: ALL, histQuery: "TEST1" }).matched, ["n5"]);
eq("공백만 입력 = 필터 없음", evaluate({ allowed: ALL, histQuery: "   " }).matched.length, 6);
eq("검색 + 상태 필터 동시", evaluate({ allowed: ALL, histFilter: "표시중", histQuery: "테스트" }).matched, ["n6"]);
eq("일치 0건", evaluate({ allowed: ALL, histQuery: "없는말" }).matched, []);
eq("제한 admin 검색도 목록 범위 안에서만", evaluate({ allowed: LIMITED, histQuery: "테스트" }).matched, ["n2"]);

console.log("\n[5] 🔴 회귀 가드 — 소스에 안전장치가 실제로 있는가");
ok("목록 상한 slice(0,10) 하드코딩이 사라졌다(더보기 state 사용)",
  !/visibleNotices\.slice\(0,\s*10\)/.test(adminSrc) && /matched\.slice\(0, histLimit\)/.test(adminSrc));
ok("영구 삭제는 2단 확인을 거친다(confirmDelete 경유)",
  /setConfirmDelete\(n\.id\)/.test(adminSrc) && /confirmDelete === n\.id/.test(adminSrc));
ok("삭제 버튼이 canManage 안에 있다(읽기 전용은 버튼 자체가 없음)",
  /!canManage\(n\) \? \(/.test(adminSrc));
ok("숨긴 공지를 되돌리는 경로가 있다", /handleReactivate/.test(adminSrc) && /active: true/.test(adminSrc));
ok("isShown 이 느슨한 비교로 되돌아가지 않았다", /const isShown = \(n\) => n\.active === true;/.test(adminSrc));

console.log(`\n${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
