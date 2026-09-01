// 격리 테스트 — 새 빌드 자동 반영(src/lib/appUpdate.js).
//   node scripts/test_app_update.cjs
//
// 2026-09-01 긴급 수정을 배포했을 때 **이미 열려 있는 앱에는 닿을 수단이 없었다** —
// 서비스워커는 FCM 전용(캐시·message 핸들러 없음), 앱에 버전 확인도 없어서
// 그날 할 수 있는 최선이 "앱을 껐다 켜 주세요" 안내뿐이었다(16,000명에게 할 수 없는 말이다).
// 이 모듈은 사고가 나기 **전에** 심어 두는 장치라, 잘못 돌면 피해가 즉시 전원에게 간다:
//   ⓐ 하던 조작이 끊긴다  ⓑ 최악은 **무한 새로고침**으로 앱을 아예 못 쓴다
// 그래서 이 테스트의 절반은 "새로고침하지 않는다"를 단언한다.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "src", "lib", "appUpdate.js");
const raw = fs.readFileSync(SRC, "utf8");
const ctx = vm.createContext({ console, fetch: undefined, document: undefined, sessionStorage: undefined });
vm.runInContext(
  raw.replace(/^export\s+(async\s+)?function\s+/gm, (m, a) => (a ? "async function " : "function "))
     .replace(/^export\s+const\s+/gm, "var "),
  ctx
);
const { bundleNameFrom, currentBundleName, shouldReload, fetchDeployedBundleName, checkAndReload, RELOAD_MARK_KEY } = ctx;

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${x !== undefined ? " — " + JSON.stringify(x) : ""}`); } };
const eq = (n, a, b) => ok(n, a === b, { actual: a, expected: b });

// prod 실물 형태(2026-09-01 배포분)
const HTML_OLD = `<!doctype html><html><head><title>BusLink</title></head><body><div id="root"></div><script defer="defer" src="/static/js/main.3c67131c.js"></script></body></html>`;
const HTML_NEW = HTML_OLD.replace("3c67131c", "27696bec");

console.log("\n[1] 번들 파일명 추출 — 못 읽으면 null(모르면 아무것도 안 한다)");
eq("실제 index.html 형태", bundleNameFrom(HTML_OLD), "main.3c67131c.js");
eq("script src 문자열 그대로", bundleNameFrom("/static/js/main.abc123.js"), "main.abc123.js");
eq("번들 없는 문서", bundleNameFrom("<html><body>hi</body></html>"), null);
eq("빈 문자열", bundleNameFrom(""), null);
eq("문자열이 아님", bundleNameFrom(null), null);
eq("청크는 집지 않는다", bundleNameFrom(`<script src="/static/js/453.89fc90a9.chunk.js"></script>`), null);

console.log("\n[2] 실행 중 번들 — 우리를 로드한 script 태그에서 읽는다");
{
  const fakeDoc = (srcs) => ({
    querySelectorAll: () => srcs.map((s) => ({ getAttribute: () => s })),
  });
  eq("script 하나", currentBundleName(fakeDoc(["/static/js/main.3c67131c.js"])), "main.3c67131c.js");
  // 셀렉터에 기대지 않고 정규식으로 한 번 더 거른다 — 청크가 섞여 들어와도 main 을 집는다.
  eq("청크가 섞여 있어도 main 을 고른다",
    currentBundleName(fakeDoc(["/static/js/453.89fc90a9.chunk.js", "/static/js/main.3c67131c.js"])), "main.3c67131c.js");
  eq("script 없음", currentBundleName(fakeDoc([])), null);
  eq("document 자체가 없음", currentBundleName(null), null);
}

console.log("\n[3] 🔴 새로고침하지 않는 조건 — 이쪽이 이 장치의 안전장치다");
eq("같은 빌드", shouldReload({ current: "main.a.js", deployed: "main.a.js" }), false);
eq("서버 응답을 못 읽음(통신 문제로 앱을 흔들지 않는다)",
  shouldReload({ current: "main.a.js", deployed: null }), false);
eq("우리 번들을 못 읽음", shouldReload({ current: null, deployed: "main.b.js" }), false);
eq("🔴 QR 스캔·탑승 처리 중(busy) — 하던 일을 끊지 않는다",
  shouldReload({ current: "main.a.js", deployed: "main.b.js", busy: true }), false);
eq("🔴 같은 목표로 이미 시도했다 — 무한 새로고침 차단",
  shouldReload({ current: "main.a.js", deployed: "main.b.js", tried: "main.b.js" }), false);
eq("인자 없음", shouldReload(), false);
eq("인자가 undefined", shouldReload(undefined), false);

console.log("\n[4] 새로고침하는 유일한 조건 — 새 빌드 + 한가함 + 첫 시도");
eq("새 빌드 감지", shouldReload({ current: "main.a.js", deployed: "main.b.js" }), true);
eq("다른 목표로 시도한 적은 있다(이번 것은 처음)",
  shouldReload({ current: "main.a.js", deployed: "main.c.js", tried: "main.b.js" }), true);

console.log("\n[5] 서버 조회 — 실패는 전부 null(조용히 포기)");
(async () => {
  eq("정상 응답", await fetchDeployedBundleName(async () => ({ ok: true, text: async () => HTML_NEW })), "main.27696bec.js");
  eq("HTTP 실패", await fetchDeployedBundleName(async () => ({ ok: false, text: async () => HTML_NEW })), null);
  eq("네트워크 예외", await fetchDeployedBundleName(async () => { throw new Error("offline"); }), null);
  eq("fetch 자체가 없음", await fetchDeployedBundleName(null), null);
  {
    let opts = null;
    await fetchDeployedBundleName(async (u, o) => { opts = o; return { ok: true, text: async () => HTML_NEW }; });
    // 🔴 브라우저 캐시가 옛 index.html 을 돌려주면 "새 빌드 없음"으로 잘못 판정한다.
    ok("no-store 로 받는다(클라 캐시가 판정을 오염시키지 않게)", opts && opts.cache === "no-store", opts);
  }

  console.log("\n[6] 전 과정 — 실제로 새로고침이 걸리는가 / 안 걸리는가");
  const makeEnv = (deployedHtml) => {
    const store = new Map();
    let reloads = 0;
    return {
      reloads: () => reloads,
      store: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) },
      loc: { reload: () => { reloads++; } },
      fetchImpl: async () => ({ ok: true, text: async () => deployedHtml }),
    };
  };
  // 실행 중 번들을 main.3c67131c.js 로 고정
  ctx.document = { querySelectorAll: () => [{ getAttribute: () => "/static/js/main.3c67131c.js" }] };

  {
    const e = makeEnv(HTML_NEW);
    const did = await checkAndReload({ busy: false, storage: e.store, location: e.loc, fetchImpl: e.fetchImpl });
    ok("새 빌드 → 새로고침 1회", did === true && e.reloads() === 1, e.reloads());
    eq("목표 해시를 표시로 남긴다", e.store.getItem(RELOAD_MARK_KEY), "main.27696bec.js");
    // 🔴 새로고침했는데도 여전히 옛 번들인 상황(프록시 캐시 등) — 두 번째는 돌면 안 된다.
    const again = await checkAndReload({ busy: false, storage: e.store, location: e.loc, fetchImpl: e.fetchImpl });
    ok("🔴 같은 목표 재시도 안 함 = 무한 새로고침 없음", again === false && e.reloads() === 1, e.reloads());
  }
  {
    const e = makeEnv(HTML_OLD);
    const did = await checkAndReload({ busy: false, storage: e.store, location: e.loc, fetchImpl: e.fetchImpl });
    ok("같은 빌드 → 새로고침 0회", did === false && e.reloads() === 0, e.reloads());
  }
  {
    const e = makeEnv(HTML_NEW);
    const did = await checkAndReload({ busy: true, storage: e.store, location: e.loc, fetchImpl: e.fetchImpl });
    ok("🔴 탑승 탭(busy) → 새로고침 0회", did === false && e.reloads() === 0, e.reloads());
    eq("표시도 안 남긴다(다음 wake 때 다시 판단해야 한다)", e.store.getItem(RELOAD_MARK_KEY), null);
  }
  {
    // sessionStorage 접근이 막힌 브라우저(시크릿·설정)에서도 던지지 않아야 한다.
    const e = makeEnv(HTML_NEW);
    const hostile = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    const did = await checkAndReload({ busy: false, storage: hostile, location: e.loc, fetchImpl: e.fetchImpl });
    ok("sessionStorage 가 던져도 죽지 않는다", did === true && e.reloads() === 1, e.reloads());
  }
  {
    ctx.document = { querySelectorAll: () => [] };
    const e = makeEnv(HTML_NEW);
    const did = await checkAndReload({ busy: false, storage: e.store, location: e.loc, fetchImpl: e.fetchImpl });
    ok("실행 중 번들을 못 읽으면 아무것도 안 한다", did === false && e.reloads() === 0, e.reloads());
  }

  console.log("\n[7] 배선 잠금 — wake 에서만·탑승 탭 제외");
  {
    const emp = fs.readFileSync(path.join(__dirname, "..", "src", "pages", "EmployeeApp.js"), "utf8");
    ok("EmployeeApp 이 checkAndReload 를 쓴다", /checkAndReload\(\{ busy: tab === "scan" \}\)/.test(emp));
    // 🔴 deps 에 wakeTick 이 있어야 «백그라운드 복귀 시점»이 된다. 타이머로 바꾸면
    //    쓰고 있는 도중에 새로고침이 걸린다.
    ok("wakeTick 전이에서만 돈다(타이머 아님)", /if \(!wakeTick\) return;[\s\S]{0,160}?\}, \[wakeTick, tab\]\)/.test(emp));
    ok("setInterval 로 폴링하지 않는다", !/setInterval\([^)]*checkAndReload/.test(emp));
  }

  console.log(`\n${fail === 0 ? "✅ 전부 통과" : "❌ 실패 있음"} — ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})();
