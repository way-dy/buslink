// 운행 이력 → 🔍 노선 점검 실화면 검증. **쓰기 0**(읽기만 — 점검 버튼은 getDocs 만 한다).
//
//   node docs/manual/_serve_build.mjs           (별도 터미널 · build/ 를 localhost:3000 에)
//   BASE=http://localhost:3000 node scripts/headless_check_route_adherence.cjs [YYYY-MM-DD]
//
// 🔴 이 검사의 존재 이유 = 2026-09-21 도봉 사고(배차 차량 6626 ↔ 실 운행차 6623)를
//    관리자 화면이 **실제로 빨갛게 보여주는가**. 판정 로직은 격리 테스트가 잠갔지만
//    "화면에 뜨는가" 는 그걸로 못 잰다(2026-08-11 사이드바 스크롤과 같은 클래스).
// 🔴 신호 유무를 먼저 단언한다 — 결과 행이 0개인데 "이상 없음" 으로 통과하면
//    이 하네스는 아무것도 안 재는 것이다.
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const ROOT = path.join(__dirname, "..");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.BASE || "https://admin.buslink.co.kr";
const COMPANY = "dy001";
const DATE = process.argv[2] || new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

function firebaseConfig() {
  const t = fs.readFileSync(path.join(ROOT, ".env.local"), "utf8");
  const g = (k) => (t.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
  const cfg = {
    apiKey: g("REACT_APP_FIREBASE_API_KEY"), authDomain: g("REACT_APP_FIREBASE_AUTH_DOMAIN"),
    projectId: g("REACT_APP_FIREBASE_PROJECT_ID"), storageBucket: g("REACT_APP_FIREBASE_STORAGE_BUCKET"),
    messagingSenderId: g("REACT_APP_FIREBASE_MESSAGING_SENDER_ID"), appId: g("REACT_APP_FIREBASE_APP_ID"),
  };
  if (!cfg.apiKey) throw new Error(".env.local 에서 REACT_APP_FIREBASE_* 를 못 읽었다");
  return cfg;
}

(async () => {
  let fail = 0, n = 0;
  const ok = (name, cond, got) => {
    n++; console.log(`  ${cond ? "✓" : "✗"} ${name}${!cond && got !== undefined ? " → " + JSON.stringify(got) : ""}`);
    if (!cond) fail++;
  };

  const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
  const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
  const sa = require(path.join(ROOT, "key", kf));
  if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치: " + sa.project_id);
  admin.initializeApp({ credential: admin.credential.cert(sa) });

  const users = await admin.firestore().collection("users").where("companyId", "==", COMPANY).get();
  const target = users.docs.map((d) => ({ uid: d.id, ...(d.data() || {}) }))
    .find((u) => u.role === "admin" && Array.isArray(u.allowedPartnerCodes) && u.allowedPartnerCodes.includes("*"));
  if (!target) { console.log("⏭ 전체 권한 admin 이 없다 — 판정 불가"); process.exit(0); }
  const token = await admin.auth().createCustomToken(target.uid);
  console.log(`대상: ${target.name || target.uid} · ${BASE} · ${DATE}`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "buslink-adh-"));
  const ctx = await chromium.launchPersistentContext(dir, {
    executablePath: CHROME, headless: true, viewport: { width: 1440, height: 950 },
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });

  try {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(3000);
    await page.evaluate(async ({ cfg, tk }) => {
      const A = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js");
      const U = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js");
      const auth = U.getAuth(A.initializeApp(cfg));      // 🔴 기본 앱 이름(세션 키가 갈리면 로그인 화면에 머문다)
      await U.setPersistence(auth, U.indexedDBLocalPersistence);
      await U.signInWithCustomToken(auth, tk);
    }, { cfg: firebaseConfig(), tk: token });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(9000);
    for (const l of ["나중에", "✕"]) {
      const b = page.locator(`button:has-text("${l}")`).first();
      if (await b.count() && await b.isVisible().catch(() => false)) {
        await b.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(400);
      }
    }

    console.log("\n[0] 신호 유무 — 콘솔 진입·탭 이동");
    const menus = await page.locator("div").filter({ hasText: /^운행 이력$/ }).count();
    ok("관리자 콘솔이 떴다(실패면 이하 전부 무의미)", menus > 0, menus);
    if (!menus) throw new Error("콘솔 진입 실패");
    await page.locator("div").filter({ hasText: /^운행 이력$/ }).last().click({ timeout: 15000 });
    await page.waitForTimeout(3000);

    // 날짜 지정 — 기본은 오늘이지만 과거 검증도 가능하게
    const dateInput = page.locator('input[type="date"]').first();
    await dateInput.fill(DATE);
    await page.waitForTimeout(4000);

    const btn = page.locator("button").filter({ hasText: "노선 점검" }).first();
    ok("🔍 노선 점검 버튼이 있다", await btn.count() > 0);
    const label = (await btn.textContent().catch(() => "")) || "";
    const cnt = parseInt((label.match(/(\d+)건/) || [])[1] || "0", 10);
    ok(`그날 배차가 실제로 있다 (${label.trim()})`, cnt > 0, label);
    if (cnt === 0) throw new Error("배차 0건 — 판정 불가");

    console.log("\n[1] 점검 실행");
    await btn.click({ timeout: 15000 });
    await page.waitForFunction(() => !/점검 중/.test(document.body.innerText), null, { timeout: 120000 });
    await page.waitForTimeout(1200);

    const rows = await page.evaluate(() => {
      const head = [...document.querySelectorAll("div")]
        .find((d) => /^🔍 노선 점검/.test((d.textContent || "").trim()) && d.children.length <= 2);
      if (!head) return null;
      const panel = head.parentElement;
      const out = [];
      [...panel.children].forEach((c) => {
        const t = (c.textContent || "").trim();
        if (/다른 노선|판정 불가|✅ 정상/.test(t)) {
          out.push({
            text: t.replace(/\s+/g, " ").slice(0, 160),
            verdict: /🔴 다른 노선/.test(t) ? "offroute" : (/판정 불가/.test(t) ? "insufficient" : "ok"),
            border: getComputedStyle(c).borderColor,
          });
        }
      });
      return { summary: (head.textContent || "").trim().replace(/\s+/g, " "), rows: out };
    });

    ok("점검 결과 패널이 그려졌다", !!rows && rows.rows.length > 0, rows && rows.rows.length);
    if (!rows || !rows.rows.length) throw new Error("결과 패널 없음");
    console.log(`     요약: ${rows.summary}`);
    ok(`행 수가 배차 수 이하다 (${rows.rows.length}/${cnt})`, rows.rows.length > 0 && rows.rows.length <= cnt, { got: rows.rows.length, want: cnt });
    // 🔴 아직 출발 전인 회차(그날 퇴근 배차)는 목록에서 빠지고 건수만 알린다.
    const pendingNote = await page.evaluate(() => {
      const m = (document.body.innerText || "").match(/아직 출발 전인 회차\s*(\d+)건은 뺐습니다/);
      return m ? parseInt(m[1], 10) : 0;
    });
    ok(`운행 전 회차를 목록에서 뺐다는 안내가 있다 (${pendingNote}건)`,
      rows.rows.length === cnt ? true : pendingNote > 0, { shown: rows.rows.length, cnt, pendingNote });
    ok("숨긴 건수 + 보이는 건수 = 전체", rows.rows.length + pendingNote === cnt, { shown: rows.rows.length, pendingNote, cnt });
    ok("정상 판정 행이 다수다(전부 빨갛게 뜨면 임계값이 잘못된 것)",
      rows.rows.filter((r) => r.verdict === "ok").length >= Math.floor(rows.rows.length / 2),
      { ok: rows.rows.filter((r) => r.verdict === "ok").length, shown: rows.rows.length });

    console.log("\n[2] 🔴 사고 배차가 실제로 빨갛게 뜨는가");
    const bad = rows.rows.filter((r) => r.verdict === "offroute");
    console.log(bad.length ? bad.map((b) => "     · " + b.text).join("\n") : "     (이상 0건)");
    if (DATE === "2026-09-21" || DATE === "2026-09-18") {
      const dobong = rows.rows.find((r) => /도봉/.test(r.text));
      ok("도봉 배차 행이 있다", !!dobong, rows.rows.map((r) => r.text.slice(0, 30)));
      ok("🔴 도봉이 '다른 노선' 으로 표시된다", dobong && dobong.verdict === "offroute", dobong && dobong.text);
      ok("도봉 행에 안내 문구가 붙는다", dobong && /실제로 다른 차량이 운행 중인지 확인/.test(dobong.text));
      // 🔴 대조군은 **오전 회차**로 집는다 — 18:00 회차를 집으면 "아직 운행 전"이라
      //    판정 불가로 나와 검사가 엉뚱한 것을 재게 된다(2026-09-21 실측으로 한 번 밟음).
      const paju = rows.rows.find((r) => /파주운정교하/.test(r.text) && /^0[4-9]:/.test(r.text));
      ok("대조군: 파주운정교하(오전)는 정상으로 남는다 — 통과율만 보면 걸리는 노선",
        !!paju && paju.verdict === "ok", paju ? paju.text : rows.rows.filter((r) => /파주/.test(r.text)).map((r) => r.text.slice(0, 40)));
      // 🔴 김포는 날마다 단말 신호가 들쑥날쑥하다(9/21 궤적 19점 → 9/18 2점). 그래서
      //    "정상" 이 아니라 **"이상으로 오탐되지 않는다"** 를 잰다 — 근거가 모자란 날은
      //    "판정 불가" 가 정답이고, 그걸 빨갛게 띄우면 목록이 잡음이 된다.
      const gimpo = rows.rows.find((r) => /김포/.test(r.text) && /^0[4-9]:/.test(r.text));
      ok("대조군: 김포(오전·단말 신호 희박)가 '다른 노선' 으로 오탐되지 않는다",
        !gimpo || gimpo.verdict !== "offroute", gimpo && gimpo.text.slice(0, 80));
    } else {
      console.log("     (날짜가 사고일이 아니라 도봉 단언은 건너뜀)");
    }

    console.log("\n[3] 부작용 없음");
    ok("기존 '노선별 배차' 목록이 그대로 있다",
      (await page.locator("div").filter({ hasText: /^노선별 배차 · \d+건$/ }).count()) > 0);
    const appErrs = errs.filter((e) => !/favicon|manifest|kakao|net::ERR|chrome-extension/i.test(e));
    ok("페이지 콘솔 오류 0", appErrs.length === 0, appErrs.slice(0, 3));

  } catch (e) {
    fail++; console.log("  ✗ 예외:", e.message);
  } finally {
    await ctx.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n${fail === 0 ? "✅ 전부 통과" : "❌ 실패 있음"} — ${n - fail}/${n}`);
  process.exit(fail === 0 ? 0 : 1);
})();
