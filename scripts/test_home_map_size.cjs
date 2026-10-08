// 승객앱 홈 지도 크게 보기 스위치 격리 검증 (2026-10-01 채드윅 시스템 관련 미팅 — 지도 확대 온오프)
//   node scripts/test_home_map_size.cjs
// 🔴 Firebase 접속 0 · prod 읽기/쓰기 0. 판정식은 소스 모듈을 그대로 vm 으로 태운다.
//
// 잠그는 것: ① 부재 = 현행(작게) — qrBoarding·routePathDisplay 와 **반대** 폴러리티.
//              뒤집으면 배포 순간 세브란스 홈의 QR 버튼이 다시 접힘 아래로 밀린다(2026-08-28 요청).
//            ② `large === true` 하나만 켠다 — 문자열 "true"·1 로는 안 켜진다
//            ③ 꺼진 바닥값은 2026-08-28 픽셀 검사가 잠근 150 그대로
//            ④ 배선 — 앱 초기값 false · 거래처 없으면 false · HomeTab 지도 컨테이너가 판정값을 쓴다

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
};

const modSrc = fs.readFileSync(path.join(ROOT, "src/lib/homeMapSize.js"), "utf8").replace(/^export /gm, "");
const ctx = {};
vm.createContext(ctx);
vm.runInContext(modSrc + "\n;this.R=resolveHomeMapConfig;this.B=homeRouteListBounds;this.MIN=LIST_MIN_PX;this.MAX=LIST_MAX_PX;", ctx);
const R = ctx.R, B = ctx.B;

console.log("\n[A] 판정식 — 🔴 부재는 «작게(현행)»");
ok("필드 없으면 작게", R({}).large === false);
ok("null/undefined 문서도 작게", R(null).large === false && R(undefined).large === false);
ok("객체가 아니면 작게", R({ homeMap: true }).large === false && R({ homeMap: "large" }).large === false);
ok("빈 객체면 작게", R({ homeMap: {} }).large === false);
ok("기존 거래처 문서 모양(다른 옵션만 있음)은 작게",
  R({ partnerName: "신촌세브란스병원", qrBoarding: { visible: true }, routePathDisplay: { visible: false } }).large === false);

console.log("\n[B] 켜기 — large:true 하나만");
ok("large:true 면 크게", R({ homeMap: { large: true } }).large === true);
ok("large:false 면 작게", R({ homeMap: { large: false } }).large === false);
ok("문자열 \"true\"·1·null 로는 안 켜진다",
  R({ homeMap: { large: "true" } }).large === false &&
  R({ homeMap: { large: 1 } }).large === false &&
  R({ homeMap: { large: null } }).large === false);

console.log("\n[C] 노선도 높이 제약");
const off = B(false), on = B(true);
ok("꺼짐 = 현행 그대로(minHeight 0 · 상한 없음)", off.minHeight === 0 && off.maxHeight === undefined && Object.keys(off).length === 1);
ok("켜짐 = 상한이 있다(남는 칸을 지도가 가져간다)", typeof on.maxHeight === "number" && on.maxHeight > 0);
ok("🔴 켜짐에도 노선도가 0 이 되지 않는다(정류장을 골라야 QR 탑승이 나온다)", on.minHeight >= 80, String(on.minHeight));
ok("하한 ≤ 상한", on.minHeight <= on.maxHeight);

// ── 소스 가드 ───────────────────────────────────────────────
const stripComments = (s) => s.split("\n").filter((l) => !/^\s*(\/\/|\{\/\*|\*)/.test(l)).join("\n");
const emp = stripComments(fs.readFileSync(path.join(ROOT, "src/pages/EmployeeApp.js"), "utf8"));
const adm = stripComments(fs.readFileSync(path.join(ROOT, "src/pages/AdminApp.js"), "utf8"));

console.log("\n[D] 승객앱 배선");
ok("초기값이 false(현행 — 켠 거래처만 조회 후 커진다)", /const \[homeMapLarge, setHomeMapLarge\] = useState\(false\)/.test(emp));
ok("거래처 문서에서 판정식으로 읽는다", /setHomeMapLarge\(resolveHomeMapConfig\(d\)\.large\)/.test(emp));
ok("거래처 없으면 false 로 되돌린다", /setHomeMapLarge\(false\)/.test(emp));
ok("HomeTab 에 넘긴다", /<HomeTab[^>]*largeMap=\{homeMapLarge\}/.test(emp));
ok("prop 기본값이 false", /function HomeTab\(\{[^}]*largeMap = false[^}]*\}\)/.test(emp));
ok("지도 컨테이너는 현행 그대로(flex 1 1 0 · 바닥 150)",
  /<div style=\{\{ flex: '1 1 0', minHeight: 150, position: 'relative' \}\}>/.test(emp));
ok("노선도 스크롤 영역이 판정값을 쓴다", /flex: '0 1 auto', \.\.\.homeRouteListBounds\(largeMap\), overflowY: 'auto'/.test(emp));
ok("지도 컨테이너에 고정 % 가 재도입되지 않았다", !/flex: '0 0 [0-9]+%'/.test(emp));
// 2026-10-08 배시현 `IJ7EcMnj` — B안의 세 줄 안내(111px)가 지도 크게를 다시 줄였다 → 크게일 때만 두 줄(63px).
ok("지도 크게일 때 정류장 미선택 안내는 압축형", /largeMap \? \([\s\S]{0,400}?<div data-testid="home-stop-prompt-compact"/.test(emp));
ok("압축형 안내도 QR 탑승 끈 거래처 문구를 따로 둔다", /home-stop-prompt-compact[\s\S]{0,600}onScanTab \? '선택하시면 QR탑승 하실 수 있습니다\.' : '선택하시면 도착 시간을 안내해 드립니다\.'/.test(emp));
ok("꺼진 거래처는 원래 세 줄 안내 그대로", /fontSize: 18, fontWeight: 700, color: 'var\(--color-label\)' \}\}>아래에서 정류장을 눌러 주세요/.test(emp));

console.log("\n[E] 관리자 배선");
ok("폼 초기값이 false(저장만 눌러도 켜지지 않게)", /const \[pHomeMapLarge, setPHomeMapLarge\] = useState\(false\)/.test(adm));
ok("편집 열 때 판정식으로 읽는다", /setPHomeMapLarge\(resolveHomeMapConfig\(code\)\.large\)/.test(adm));
ok("저장 payload 에 homeMap.large", /homeMap: \{\s*large: pHomeMapLarge,?\s*\}/.test(adm));
ok("목록 배지는 켠 거래처만", /\{resolveHomeMapConfig\(c\)\.large && \(/.test(adm));

console.log(`\n${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
