// 승객앱 노선 경로(파란 선) 노출 스위치 격리 검증 (2026-09-15 배시현 개선요청 `l0hDzQv1…`)
//   node scripts/test_route_path_display.cjs
// 🔴 Firebase 접속 0 · prod 읽기/쓰기 0. 판정식은 소스 모듈을 그대로 vm 으로 태운다.
//
// 잠그는 것: ① 부재 = 노출(QR 탑승과 같은 폴러리티 — 뒤집으면 전 거래처 지도에서 경로가 사라진다)
//            ② 끄면 지도 **세 곳 모두**(홈 분할선 2 + 단일선 1 · 노선 탭 모달 1)가 안 그린다
//            ③ 표시만 끈다 — 진행거리 계산(projectToPolyline)은 스위치에 걸리지 않는다

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
};

const modSrc = fs.readFileSync(path.join(ROOT, "src/lib/routePathDisplay.js"), "utf8").replace(/^export /gm, "");
const ctx = {};
vm.createContext(ctx);
vm.runInContext(modSrc + "\n;this.R=resolveRoutePathDisplayConfig;", ctx);
const R = ctx.R;

console.log("\n[A] 판정식 — 🔴 부재는 «노출»");
ok("필드 없으면 보임", R({}).visible === true);
ok("null/undefined 문서도 보임", R(null).visible === true && R(undefined).visible === true);
ok("객체가 아니면 보임", R({ routePathDisplay: false }).visible === true && R({ routePathDisplay: "off" }).visible === true);
ok("기존 거래처 문서 모양(다른 옵션만 있음)은 보임",
  R({ partnerName: "채드윅송도국제학교", qrBoarding: { visible: false }, inquiry: { enabled: true } }).visible === true);
ok("빈 객체면 보임", R({ routePathDisplay: {} }).visible === true);

console.log("\n[B] 끄기 — visible:false 하나만");
ok("visible:false 면 숨김", R({ routePathDisplay: { visible: false } }).visible === false);
ok("visible:true 면 보임", R({ routePathDisplay: { visible: true } }).visible === true);
ok("문자열 \"false\"·0·null 로는 안 숨는다",
  R({ routePathDisplay: { visible: "false" } }).visible === true &&
  R({ routePathDisplay: { visible: 0 } }).visible === true &&
  R({ routePathDisplay: { visible: null } }).visible === true);
ok("QR 탑승 필드와 섞이지 않는다", R({ qrBoarding: { visible: false } }).visible === true);

// ── 소스 가드 ───────────────────────────────────────────────
const stripComments = (s) => s.split("\n").filter((l) => !/^\s*(\/\/|\{\/\*|\*)/.test(l)).join("\n");
const emp = stripComments(fs.readFileSync(path.join(ROOT, "src/pages/EmployeeApp.js"), "utf8"));
const adm = stripComments(fs.readFileSync(path.join(ROOT, "src/pages/AdminApp.js"), "utf8"));

console.log("\n[C] 승객앱 배선");
ok("초기값이 true(깜빡임·회귀 방지)", /const \[routePathOn, setRoutePathOn\] = useState\(true\)/.test(emp));
ok("거래처 문서에서 판정식으로 읽는다", /setRoutePathOn\(resolveRoutePathDisplayConfig\(d\)\.visible\)/.test(emp));
ok("거래처 없으면 true 로 되돌린다", /setRoutePathOn\(true\)/.test(emp));
ok("HomeTab·RoutesTab 에 넘긴다",
  /<HomeTab[^>]*showRoutePath=\{routePathOn\}/.test(emp) && /<RoutesTab[^>]*showRoutePath=\{routePathOn\}/.test(emp));
ok("prop 기본값이 true(안 넘긴 호출부가 선을 잃지 않게)",
  /function HomeTab\(\{[^}]*showRoutePath = true[^}]*\}\)/.test(emp) && /function RoutesTab\(\{[^}]*showRoutePath = true[^}]*\}\)/.test(emp));

// 모든 <Polyline 이 스위치 뒤에 있는가 — 폴리라인 앞 600자 안에 showRoutePath 게이트가 있어야 한다
const polyIdx = [...emp.matchAll(/<Polyline/g)].map((m) => m.index);
ok("승객앱 폴리라인이 실제로 존재(신호 유무)", polyIdx.length >= 4, `found ${polyIdx.length}`);
const ungated = polyIdx.filter((i) => !/showRoutePath/.test(emp.slice(Math.max(0, i - 700), i)));
ok("모든 폴리라인이 showRoutePath 게이트 뒤에 있다", ungated.length === 0, `게이트 없는 위치 ${ungated.length}곳`);
ok("홈 지도: 끄면 null", /\{!showRoutePath \? null : routePath\.length >= 2/.test(emp));
ok("모달 지도: 끄면 안 그림", /\{showRoutePath && modalPath\.length >= 2 &&/.test(emp));
ok("🔴 계산은 스위치에 안 걸린다(usePathProgress 가 showRoutePath 를 안 봄)",
  /const usePathProgress = preDrawnPath\.length >= 2;/.test(emp));

console.log("\n[D] 관리자 설정");
ok("폼 초기값 true(저장만 눌러도 꺼지는 사고 방지)", /const \[pRoutePath, setPRoutePath\] = useState\(true\)/.test(adm));
ok("열 때 판정식으로 싣는다", /setPRoutePath\(resolveRoutePathDisplayConfig\(code\)\.visible\)/.test(adm));
ok("저장 payload 에 routePathDisplay.visible", /routePathDisplay:\s*\{\s*visible:\s*pRoutePath/.test(adm));
ok("배지는 끈 거래처만", /\{!resolveRoutePathDisplayConfig\(c\)\.visible && \(/.test(adm));
ok("체크박스가 상태에 묶여 있다", /checked=\{pRoutePath\} onChange=\{e => setPRoutePath\(e\.target\.checked\)\}/.test(adm));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
