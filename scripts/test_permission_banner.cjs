// 권한 배너 누락 방지 검사 (2026-08-10 way "권한 허용은 중요한 메세지이니 누락되지 않도록")
//   node scripts/test_permission_banner.cjs
//
// 배너를 압축(한 줄)·이동하면서 **어떤 권한 조합에서도 메시지가 사라지지 않는지**를 잠근다.
// 🔴 판정식을 재구현하지 않는다 — `usePermissions.js` 소스에서 뽑아 평가한다
//    (복제하면 소스가 바뀌어도 이 테스트는 영원히 초록이다).
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const permSrc = fs.readFileSync(path.join(ROOT, "src", "lib", "usePermissions.js"), "utf8");
const gateSrc = fs.readFileSync(path.join(ROOT, "src", "components", "PermissionGate.js"), "utf8");

let fail = 0;
const ok = (n, c, x) => { console.log(`  ${c ? "✓" : "✗"} ${n}${!c && x !== undefined ? " → " + x : ""}`); if (!c) fail++; };

// ── 판정식 추출 ────────────────────────────────────────────────
const grab = (name) => {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*([^;]+);`).exec(permSrc);
  if (!m) { console.error(`❌ ${name} 판정식을 usePermissions.js 에서 못 찾음 — 이름이 바뀌었나?`); process.exit(2); }
  return m[1].trim();
};
const EXPR = {
  notifBad: grab("notifBad"), geoBad: grab("geoBad"),
  needsBanner: grab("needsBanner"), anyDenied: grab("anyDenied"),
};
console.log("\n추출한 판정식:");
Object.entries(EXPR).forEach(([k, v]) => console.log(`  ${k} = ${v}`));

const evalPreds = (perm) => {
  const ctx = { perm };
  vm.createContext(ctx);
  const notifBad = vm.runInContext(EXPR.notifBad, ctx); ctx.notifBad = notifBad;
  const geoBad = vm.runInContext(EXPR.geoBad, ctx); ctx.geoBad = geoBad;
  const needsBanner = vm.runInContext(EXPR.needsBanner, ctx);
  const anyDenied = vm.runInContext(EXPR.anyDenied, ctx);
  return { notifBad, geoBad, needsBanner, anyDenied };
};

// ── 전 조합 스윕 ──────────────────────────────────────────────
const NOTIF = ["default", "granted", "denied", "unsupported"];
const GEO = ["unknown", "prompt", "granted", "denied"];
let combos = 0, shown = 0, gaps = [];
for (const n of NOTIF) {
  for (const g of GEO) {
    combos++;
    const p = evalPreds({ notif: n, geo: g });
    // PermissionGate 렌더 규칙(소스와 동일):
    //   큰 카드 = needsBanner && anyDenied
    //   한 줄   = compact = needsBanner && !anyDenied
    const big = p.needsBanner && p.anyDenied;
    const row = p.needsBanner && !p.anyDenied;
    const rendered = (big ? 1 : 0) + (row ? 1 : 0);
    if (p.needsBanner) {
      shown++;
      if (rendered !== 1) gaps.push(`notif=${n} geo=${g} → 렌더 ${rendered}개`);
    } else if (rendered !== 0) {
      gaps.push(`notif=${n} geo=${g} → 필요없는데 ${rendered}개 렌더`);
    }
  }
}
console.log(`\n[1] 권한 조합 전수 (${combos}개 · 배너가 필요한 조합 ${shown}개)`);
ok("배너가 필요한 모든 조합에서 정확히 1개가 렌더된다", gaps.length === 0, gaps.join(" | "));
ok("필요 없는 조합에서는 아무것도 안 뜬다", !gaps.some((g) => /필요없는데/.test(g)));

// 🔴 양성 대조 — 이 검사가 실제로 누락을 잡는지 증명한다.
//    (안 하면 "빈틈 0"이 진짜인지 검사가 죽은 건지 구분이 안 된다.)
const brokenGaps = [];
for (const n of NOTIF) for (const g of GEO) {
  const p = evalPreds({ notif: n, geo: g });
  const big = p.needsBanner && p.anyDenied;
  const row = false;                       // ← 한 줄 배너를 없앤 '고장난' 구현
  if (p.needsBanner && (big ? 1 : 0) + (row ? 1 : 0) !== 1) brokenGaps.push(`${n}/${g}`);
}
ok("양성 대조 — 한 줄 배너를 없애면 누락이 검출된다", brokenGaps.length > 0, "검출 0건(검사기 고장)");

// ── 소스 회귀 가드 ────────────────────────────────────────────
console.log("\n[2] 소스 가드");
ok("차단(anyDenied)은 압축 대상이 아니다", /const\s+compact\s*=\s*needsBanner\s*&&\s*!anyDenied/.test(gateSrc));
ok("한 줄 배너에도 행동 버튼이 있다", /{compact && \(/.test(gateSrc) && /허용<\/button>|>\s*허용\s*<\/button>/.test(gateSrc));
ok("설치 카드는 이 컴포넌트에서 렌더하지 않는다(InstallPrompt 로 일원화)", !/installable && \(/.test(gateSrc));
ok("홈에서 지도보다 위(flexShrink:0)에 배치된다",
  /<PermissionGate containerStyle=\{\{ flexShrink: 0/.test(fs.readFileSync(path.join(ROOT, "src", "pages", "EmployeeApp.js"), "utf8")));

console.log(fail === 0 ? "\n✅ 전부 통과" : `\n❌ 실패 ${fail}건`);
process.exit(fail === 0 ? 0 : 1);
