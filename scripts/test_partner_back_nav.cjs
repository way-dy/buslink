// 협력사 포털 — 뒤로가기 + 인증 유지 격리 검증 (2026-09-02 way)
//   node scripts/test_partner_back_nav.cjs
//
// 🔴 Firebase 접속 0 · 브라우저 0. 정본 두 모듈을 **베끼지 않고 그대로 vm 에 태운다**(재구현 0).
// 🔴 재는 것 = "뒤로가기를 눌렀을 때 사이트를 떠나는가": 가짜 window 가 history 항목을
//    실제로 세고, 들어온 사이트로 넘어가면 `left` 를 세운다. 그래야 «앱 안에서 되돌아왔다»와
//    «나갔다»가 구별된다(둘 다 popstate 라서 이벤트만 세면 아무것도 증명 못 한다).
// 🔴 [1] 은 **양성 대조** — 발판이 없으면 첫 뒤로가기에 곧장 나간다(=고치기 전 동작).
//    그게 재현되지 않으면 이 하네스는 무엇도 증명하지 않는다.
const path = require("path");
const fs = require("fs");
const vm = require("vm");
const ROOT = path.join(__dirname, "..");

// ESM 소스에서 `export ` 만 떼어 컨텍스트에 태운다(두 모듈 다 순수 — import 0).
function loadPure(rel, names) {
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/^export /gm, "");
  const ctx = { console, setTimeout, Date, JSON, String, Number, window: undefined };
  vm.createContext(ctx);
  vm.runInContext(src + "\n;" + names.map((n) => `this.${n}=${n};`).join(""), ctx);
  return ctx;
}

const bn = loadPure("src/lib/backNav.js", ["createBackNav"]);
const ps = loadPure("src/lib/partnerSession.js",
  ["savePartnerSession", "loadPartnerSession", "clearPartnerSession", "PARTNER_SESSION_KEY", "PARTNER_SESSION_TTL_MS"]);

const partnerSrc = fs.readFileSync(path.join(ROOT, "src/pages/PartnerApp.js"), "utf8");

let n = 0, fail = 0;
const ok = (name, cond, got) => {
  n++;
  console.log(`  ${cond ? "✓" : "✗"} ${name}${!cond && got !== undefined ? " → " + JSON.stringify(got) : ""}`);
  if (!cond) fail++;
};

// ── 가짜 브라우저 ───────────────────────────────────────────────────────────
// 항목 구조: [들어온 사이트] [포털 진입] [우리가 push 한 것들…]
function makeWin() {
  const entries = ["prev-site", "portal"];
  const states = [null, null];   // history.state — 새로고침 복구가 이 값을 읽는다
  let idx = 1;                 // 지금은 포털 진입 항목 위
  const listeners = {};
  let left = false;            // 사이트를 실제로 떠났는가
  const fire = (type) => (listeners[type] || []).slice().forEach((fn) => fn({ type }));
  const win = {
    location: { href: "https://p.buslink.co.kr/partner" },
    history: {
      pushState(state) {
        entries.length = idx + 1;      // 앞으로 갈 항목은 사라진다(브라우저와 같다)
        states.length = idx + 1;
        entries.push("app"); states.push(state);
        idx = entries.length - 1;
      },
      get state() { return states[idx]; },
      back() { win.history.go(-1); },
      go(delta) {
        const target = idx + delta;
        if (target < 0) return;        // 되돌아갈 항목이 없다 = 무효(새 탭 첫 진입)
        idx = target;
        // 다른 문서로 넘어가면 그 페이지는 언로드된다 — popstate 는 발화하지 않는다.
        if (entries[idx] === "prev-site") { left = true; return; }
        fire("popstate");
      },
    },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { listeners[t] = (listeners[t] || []).filter((f) => f !== fn); },
    setTimeout(fn) { return 0; },      // leaving 해제 타이머는 이 검사에서 안 돌린다
    // 검사용 관측창
    get _left() { return left; },
    get _idx() { return idx; },
    get _entries() { return entries.slice(); },
    _gesture() { fire("pointerdown"); },
  };
  return win;
}

// PartnerApp 이 하는 일(뷰 스택)을 최소로 흉내낸다 — 판정 로직은 전부 정본 모듈 것이다.
function makeApp() {
  const win = makeWin();
  const stack = [];
  let view = "main:register";
  let exitAsks = 0;
  const nav = bn.createBackNav({
    win,
    onPop: () => { if (stack.length === 0) return false; view = stack.pop(); return true; },
    onExitAsk: () => { exitAsks++; },
  });
  nav.start();
  return {
    win, nav,
    goto(next) { win._gesture(); stack.push(view); nav.pushView(); view = next; },
    back() { win.history.go(-1); },     // 물리 뒤로가기
    get view() { return view; },
    get exitAsks() { return exitAsks; },
    get depth() { return nav.depth(); },
  };
}

console.log("\n[1] 양성 대조 — 발판이 없으면 첫 뒤로가기에 곧장 나간다(고치기 전 동작)");
{
  const win = makeWin();
  win._gesture();
  win.history.go(-1);
  ok("아무 발판도 없으면 사이트를 떠난다", win._left === true, { left: win._left });
}

console.log("\n[2] 발판 — 첫 사용자 제스처에 딱 하나만 놓인다");
{
  const app = makeApp();
  ok("제스처 전에는 항목을 만들지 않는다", app.depth === 0, { depth: app.depth });
  app.win._gesture();
  ok("제스처 직후 발판 1개", app.depth === 1, { depth: app.depth });
  app.win._gesture(); app.win._gesture();
  // 🔴 발판이 2개면 "나가기"를 눌러도 앱에 남는다 — 이 단언이 그 사고를 막는다.
  ok("제스처를 여러 번 해도 발판은 1개", app.depth === 1, { depth: app.depth });
}

console.log("\n[3] 앱 안 이동 — 뒤로가기가 이전 화면으로 되돌린다(사이트를 안 떠난다)");
{
  const app = makeApp();
  app.goto("main:manage");
  app.goto("main:stats");
  ok("두 번 이동하면 항목이 3개(발판+2)", app.depth === 3, { depth: app.depth });
  app.back();
  ok("한 번 뒤로 = 승객 관리", app.view === "main:manage", app.view);
  ok("아직 나가지 않았다", app.win._left === false);
  ok("나가기 확인도 안 물었다", app.exitAsks === 0, { asks: app.exitAsks });
  app.back();
  ok("또 한 번 뒤로 = 처음 화면", app.view === "main:register", app.view);
  ok("여전히 사이트 안", app.win._left === false);
  ok("여기까지 확인창 0회", app.exitAsks === 0, { asks: app.exitAsks });
}

console.log("\n[4] 뿌리 화면에서 뒤로 — 나가지 않고 확인부터 묻는다");
{
  const app = makeApp();
  app.goto("main:manage");
  app.back();                 // 앱 안 복귀
  app.back();                 // 더 되돌릴 화면 없음
  ok("확인창 1회", app.exitAsks === 1, { asks: app.exitAsks });
  ok("아직 사이트 안에 있다", app.win._left === false);
}

console.log("\n[5] 머무르기 — 발판이 되살아나 다음 뒤로가기도 잡는다");
{
  const app = makeApp();
  app.win._gesture();
  app.back();
  ok("확인창 1회", app.exitAsks === 1, { asks: app.exitAsks });
  app.nav.cancelExit();
  ok("발판 복구", app.depth === 1, { depth: app.depth });
  app.back();
  ok("다시 물어본다(2회)", app.exitAsks === 2, { asks: app.exitAsks });
  ok("두 번 다 사이트 안", app.win._left === false);
}

console.log("\n[6] 나가기 — 들어온 페이지로 실제로 나간다");
{
  const app = makeApp();
  app.win._gesture();
  app.back();                 // 확인창
  app.nav.confirmExit();
  ok("들어온 사이트로 나갔다", app.win._left === true);
}
{
  // 확인창이 떠 있는 동안 사용자가 화면을 만져도 발판이 다시 깔리면 안 된다.
  // 🔴 깔리면 "나가기"가 그 발판만 소비해 **앱에 그대로 남는다**(옛 useExitConfirm 결함과 같은 계열).
  const app = makeApp();
  app.win._gesture();
  app.back();
  app.win._gesture(); app.win._gesture();
  ok("확인창 동안에는 발판을 다시 놓지 않는다", app.depth === 0, { depth: app.depth });
  app.nav.confirmExit();
  ok("그래도 나가기가 한 번에 먹는다", app.win._left === true);
}
{
  // 앱 안에서 여러 화면을 열어 둔 채 나가기 = 우리 항목을 전부 되짚어야 한다.
  const app = makeApp();
  app.goto("main:manage");
  app.goto("main:ops");
  app.nav.confirmExit();      // (뒤로가기 없이 바로 확인 — 항목 3개가 남아 있다)
  ok("우리 항목이 남아 있어도 한 번에 나간다", app.win._left === true);
}

console.log("\n[7] 새로고침 — history 는 남아 있으므로 우리 항목 수를 되찾는다");
{
  const app = makeApp();
  app.goto("main:manage");
  app.goto("main:ops");            // 우리 항목 3개(발판+2)
  app.nav.stop();                  // 새로고침 = 이 페이지 컨텍스트가 사라진다
  // 같은 win(=같은 history) 위에 새 인스턴스를 만든다. 앱 화면 스택은 복구할 수 없어 비어 있다.
  let asks = 0;
  const fresh = bn.createBackNav({ win: app.win, onPop: () => false, onExitAsk: () => { asks++; } });
  fresh.start();
  ok("새로고침 뒤에도 우리 항목 수를 안다", fresh.depth() === 3, { depth: fresh.depth() });
  app.win.history.go(-1);
  ok("첫 뒤로가기는 나가기 확인", asks === 1 && app.win._left === false, { asks, left: app.win._left });
  fresh.confirmExit();
  // 🔴 이 단언이 «새로고침하면 나가기가 안 먹는다» 를 잡는다(2026-09-02 실화면에서 밟은 결함).
  ok("나가기가 남은 항목을 전부 되짚어 실제로 나간다", app.win._left === true);
}

console.log("\n[8] 앱 안 '이전으로' 버튼 = 물리 뒤로가기와 같은 길");
{
  const app = makeApp();
  app.goto("done");
  app.nav.back();
  ok("nav.back() 도 스택을 되짚는다", app.view === "main:register", app.view);
  ok("항목도 함께 소비된다(발판만 남음)", app.depth === 1, { depth: app.depth });
  ok("사이트는 그대로", app.win._left === false);
}

console.log("\n[9] 인증 세션 — 코드만 남기고, 늙으면 스스로 버린다");
{
  const store = () => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
  };
  const NOW = 1_800_000_000_000;
  let s = store();
  ps.savePartnerSession("DY001-TEST-2026-A3F9", { now: NOW, storage: s });
  ok("저장한 코드를 그대로 돌려준다", ps.loadPartnerSession({ now: NOW, storage: s })?.code === "DY001-TEST-2026-A3F9");
  // 🔴 권한(회사·거래처명·허용노선)은 저장하지 않는다 — 복원 때 서버에 다시 물어야
  //    비활성·만료된 코드가 이 기기에서 영영 살아 있지 않는다.
  const raw = JSON.parse(s._m.get(ps.PARTNER_SESSION_KEY));
  ok("저장 필드는 코드와 시각뿐", Object.keys(raw).sort().join(",") === "code,savedAt", Object.keys(raw));
  ok("TTL 하루 전이면 유지", !!ps.loadPartnerSession({ now: NOW + ps.PARTNER_SESSION_TTL_MS - 86400000, storage: s }));
  ok("TTL 을 넘기면 버린다", ps.loadPartnerSession({ now: NOW + ps.PARTNER_SESSION_TTL_MS + 1, storage: s }) === null);
  ps.clearPartnerSession({ storage: s });
  ok("해제하면 남는 게 없다", ps.loadPartnerSession({ now: NOW, storage: s }) === null && s._m.size === 0);

  s = store();
  s.setItem(ps.PARTNER_SESSION_KEY, "{깨진 JSON");
  ok("깨진 값은 조용히 무시", ps.loadPartnerSession({ now: NOW, storage: s }) === null);
  s.setItem(ps.PARTNER_SESSION_KEY, JSON.stringify({ code: "  ", savedAt: NOW }));
  ok("빈 코드는 세션이 아니다", ps.loadPartnerSession({ now: NOW, storage: s }) === null);
  s.setItem(ps.PARTNER_SESSION_KEY, JSON.stringify({ code: "X" }));
  ok("시각이 없으면 신뢰하지 않는다", ps.loadPartnerSession({ now: NOW, storage: s }) === null);

  // Safari 프라이빗 모드 등 — 접근 자체가 throw 한다. 앱이 죽으면 안 된다.
  const boom = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  ok("저장소가 막혀도 던지지 않는다",
    ps.savePartnerSession("X", { storage: boom }) === false
    && ps.loadPartnerSession({ storage: boom }) === null
    && ps.clearPartnerSession({ storage: boom }) === false);
}

console.log("\n[10] 소스 회귀 가드 — 배선이 살아 있는가");
{
  ok("PartnerApp 이 뒤로가기 훅을 쓴다", /useBackNav\(\{/.test(partnerSrc));
  ok("인증 성공 시 세션을 남긴다", /savePartnerSession\(trimmed\)/.test(partnerSrc));
  ok("복원 때 서버에 다시 묻는다(캐시한 권한을 안 믿는다)",
    /loadPartnerSession\(\);[\s\S]{0,600}validatePartnerCode\(saved\.code\)/.test(partnerSrc));
  // 🔴 나가기 안내를 window.confirm 으로 되돌리지 말 것(2026-09-02 way "모달 팝업으로").
  ok("나가기 확인이 window.confirm 이 아니다", !/window\.confirm\([^)]*종료/.test(partnerSrc));
  ok("확인 모달 컴포넌트가 있다", /function ConfirmDialog\(/.test(partnerSrc));
  // 🔴 탭·서브탭 이동은 반드시 goto 를 타야 뒤로가기가 되돌릴 수 있다.
  ok("메인 탭 이동이 goto 를 탄다", /goto\(\{ mainTab: item\.key \}\)/.test(partnerSrc));
  ok("등록 서브탭 이동도 goto 를 탄다", /goto\(\{ regMode: mode \}\)/.test(partnerSrc));
  // 🔴 "추가 등록하기" 를 state 되돌리기로 바꾸면 history 항목이 하나 남아 다음 뒤로가기가 먹통이 된다.
  ok("추가 등록하기는 nav.back() 이다", /const registerMore = \(\) => \{ setError\(""\); nav\.back\(\); \};/.test(partnerSrc));
  ok("인증 해제 통로가 있다", /clearPartnerSession\(\);\s*\n\s*viewStack\.current = \[\];/.test(partnerSrc));
  // 🔴 노선·명부 read 는 `isAuth()` 라 익명 인증이 **먼저 끝나 있어야** 한다. 인증 화면은
  //    사람이 코드를 타이핑하는 동안 그 지연이 덮이지만 **복원 경로엔 그 시간이 없다**
  //    (2026-09-02 실측: `Missing or insufficient permissions` 로 조용히 실패했다).
  ok("노선 로드가 익명 인증을 기다린다",
    /async function fetchPartnerRoutes[\s\S]{0,160}await ensureAnonAuth\(\);/.test(partnerSrc));
  ok("익명 인증 프라미스를 재사용한다(중복 로그인 0)", /let anonAuthPromise = null;/.test(partnerSrc));
  // 🔴 통신이 잠깐 끊겼다고 저장분을 지우면 담당자가 20자짜리 코드를 다시 타이핑해야 한다.
  ok("죽은 코드일 때만 저장분을 지운다",
    /const dead = [\s\S]{0,80}\n\s*if \(dead\) clearPartnerSession\(\);/.test(partnerSrc));
  ok("복원 실패 시 다시 시도 통로가 있다", /저장된 업체코드로 다시 시도/.test(partnerSrc));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${n - fail}/${n} 통과`);
process.exit(fail === 0 ? 0 : 1);
