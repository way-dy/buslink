// 관리자 「📅 통합 운행일 설정」 실화면 검증. 🔴 **쓰기 0 — 「일괄 적용」을 누르지 않는다.**
//
//   node scripts/headless_check_bulk_operating_days.cjs            (prod)
//   BASE=http://localhost:3000 node scripts/headless_check_bulk_operating_days.cjs
//
// 🔴 왜 필요한가: 이 모달은 **한 번 누르면 수십 개 일정이 동시에 바뀐다**. 그리고 이 파일
//    (`AdminApp.js`)은 카카오 SDK 의 `Map` 을 import 해 내장 Map 이 가려지므로, `new Map()`
//    한 줄이면 모달을 여는 순간 콘솔이 통째로 죽는다(2026-08-10 에 이미 밟은 함정).
//    격리 테스트는 그걸 못 잡는다 — **실제로 열어 봐야** 안다.
// 🔴 로그인 통로는 `headless_check_portal_theme.cjs` 선례를 그대로 쓴다(커스텀 토큰 · 기본 앱 이름).
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const ROOT = path.join(__dirname, "..");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.BASE || "https://admin.buslink.co.kr";
const COMPANY = "dy001";

function firebaseConfig() {
  const t = fs.readFileSync(path.join(ROOT, ".env.local"), "utf8");
  const g = (k) => (t.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1]?.trim();
  const cfg = { apiKey: g("REACT_APP_FIREBASE_API_KEY"), authDomain: g("REACT_APP_FIREBASE_AUTH_DOMAIN"),
    projectId: g("REACT_APP_FIREBASE_PROJECT_ID"), storageBucket: g("REACT_APP_FIREBASE_STORAGE_BUCKET"),
    messagingSenderId: g("REACT_APP_FIREBASE_MESSAGING_SENDER_ID"), appId: g("REACT_APP_FIREBASE_APP_ID") };
  if (!cfg.apiKey) throw new Error(".env.local 에서 REACT_APP_FIREBASE_* 를 못 읽었다");
  return cfg;
}

(async () => {
  let fail = 0;
  const ok = (name, cond, got) => {
    console.log(`  ${cond ? "✓" : "✗"} ${name}${!cond && got !== undefined ? " → " + JSON.stringify(got) : ""}`);
    if (!cond) fail++;
  };

  const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
  const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
  const sa = require(path.join(ROOT, "key", kf));
  if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치: " + sa.project_id);
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(sa) });

  const users = await admin.firestore().collection("users").where("companyId", "==", COMPANY).get();
  const target = users.docs.map((d) => ({ uid: d.id, ...(d.data() || {}) }))
    .find((u) => u.role === "admin" && Array.isArray(u.allowedPartnerCodes) && u.allowedPartnerCodes.includes("*"));
  if (!target) { console.log("⏭ 전체 권한 admin 이 없다 — 판정 불가"); process.exit(0); }
  const token = await admin.auth().createCustomToken(target.uid);
  console.log(`대상: ${target.name || target.uid} (전체 권한) · ${BASE}`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "buslink-bulk-"));
  const ctx = await chromium.launchPersistentContext(dir, { executablePath: CHROME, headless: true,
    viewport: { width: 1440, height: 950 }, deviceScaleFactor: 1.5 });
  const page = await ctx.newPage();
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  page.on("pageerror", (e) => errs.push("pageerror: " + e.message));

  try {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(3000);
    await page.evaluate(async ({ cfg, tk }) => {
      const A = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js");
      const U = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js");
      const auth = U.getAuth(A.initializeApp(cfg));      // 🔴 기본 앱 이름이어야 세션 키가 맞는다
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

    console.log("\n[0] 신호 유무 — 콘솔이 실제로 떴는가");
    const menus = await page.locator("div").filter({ hasText: /^배차 일정$/ }).count();
    ok("관리자 콘솔 진입(로그인 실패면 이하 전부 무의미)", menus > 0, menus);
    if (!menus) throw new Error("콘솔 진입 실패");

    await page.locator("div").filter({ hasText: /^배차 일정$/ }).last().click({ timeout: 15000 });
    await page.waitForTimeout(3500);
    const rows = await page.locator("table tbody tr").count();
    ok("배차 일정 목록이 떴다", rows > 0, rows);

    console.log("\n[1] 모달 열기 — 🔴 여기서 죽으면 `new Map()` 함정이다");
    const openBtn = page.locator("button").filter({ hasText: "통합 운행일 설정" });
    ok("「📅 통합 운행일 설정」 버튼이 있다", await openBtn.count() > 0);
    await openBtn.first().click({ timeout: 15000 });
    await page.waitForTimeout(1500);
    const title = await page.locator("div").filter({ hasText: /^📅 거래처 통합 운행일 설정$/ }).count();
    ok("모달이 열렸다", title > 0, title);
    // 🔴 이 단언이 Map 섀도잉을 잡는 자리다 — 죽으면 화면이 통째로 사라진다.
    ok("모달을 연 뒤에도 앱이 살아 있다", (await page.evaluate(() => document.body.innerText.length)) > 200);

    console.log("\n[2] 거래처 선택 — 「전체」 항목이 없어야 한다");
    const opts = await page.evaluate(() => {
      const sels = [...document.querySelectorAll("select")];
      const s = sels.find(x => [...x.options].some(o => /거래처를 선택하세요/.test(o.textContent)));
      return s ? [...s.options].map(o => ({ v: o.value, t: o.textContent.trim() })) : null;
    });
    ok("거래처 드롭다운이 있다", !!opts && opts.length > 1, opts && opts.length);
    // 🔴 「전체 거래처」를 허용하면 한 번의 실수로 회사 전 노선이 멈춘다.
    ok("🔴 «전체» 선택지가 없다", !!opts && !opts.some(o => /^전체/.test(o.t)), opts && opts.map(o => o.t));
    ok("첫 항목은 빈 값(고르기 전)", !!opts && opts[0].v === "");

    console.log("\n[3] 대상 집계 — 거래처·기간을 고르면 숫자가 살아 움직이는가");
    const readBox = () => page.evaluate(() => {
      const el = [...document.querySelectorAll("div")].find(d => /^적용 대상 배차 일정/.test((d.textContent || "").trim()));
      return el ? el.parentElement.innerText.replace(/\n/g, " / ") : null;
    });
    const before = await readBox();
    ok("고르기 전에도 요약 상자가 보인다", !!before, before);
    ok("고르기 전 대상은 0개", /배차 일정 0개/.test(before || ""), before);

    // 일정이 실제로 있는 거래처를 찾아 고른다(없는 거래처를 고르면 판정이 공허하다).
    let picked = null, boxAfter = null;
    for (const o of (opts || []).filter(x => x.v)) {
      await page.selectOption("select >> nth=" + (await page.evaluate(() => {
        const sels = [...document.querySelectorAll("select")];
        return sels.findIndex(x => [...x.options].some(op => /거래처를 선택하세요/.test(op.textContent)));
      })), o.v);
      await page.waitForTimeout(600);
      const txt = await readBox();
      const m = (txt || "").match(/적용 대상 배차 일정 (\d+)개/);
      if (m && Number(m[1]) > 0) { picked = o; boxAfter = txt; break; }
    }
    ok("🔴 일정이 있는 거래처를 찾았다(신호 유무)", !!picked, picked && picked.t);
    if (picked) console.log(`     고른 거래처: ${picked.t} · ${boxAfter}`);

    // 기간을 넣으면 «실제로 바뀔 일정» 이 계산된다.
    const dateInputs = page.locator('input[type="date"]');
    ok("적용 기간 입력칸 2개", await dateInputs.count() === 2, await dateInputs.count());
    await dateInputs.nth(0).fill("2027-01-11");   // 미래의 월~금 2주(공휴일 없음)
    await dateInputs.nth(1).fill("2027-01-22");
    await page.waitForTimeout(800);
    const boxRange = await readBox();
    console.log(`     기간 적용 후: ${boxRange}`);
    ok("선택 기간 일수가 표시된다(12일)", /선택 기간 12일/.test(boxRange || ""), boxRange);
    const chg = (boxRange || "").match(/실제로 바뀔 일정 (\d+)개/);
    ok("실제로 바뀔 일정이 1개 이상(= 계산이 돈다)", !!chg && Number(chg[1]) > 0, boxRange);

    // 🔴 위에서 고른 거래처는 구분(등교/하교/방과후)이 하나뿐일 수 있다 — 그러면 칩 경로가
    //    한 번도 안 태워진다. 요청자 거래처(구분이 여럿인 곳)를 따로 골라 그 경로를 잰다.
    console.log("\n[3b] 구분 칩 — 여러 구분이 있는 거래처에서만 뜬다");
    const selIdx = await page.evaluate(() => {
      const sels = [...document.querySelectorAll("select")];
      return sels.findIndex(x => [...x.options].some(op => /거래처를 선택하세요/.test(op.textContent)));
    });
    const multi = (opts || []).find(o => /채드윅/.test(o.t)) || (opts || []).filter(o => o.v).slice(-1)[0];
    if (multi) {
      await page.selectOption("select >> nth=" + selIdx, multi.v);
      await page.waitForTimeout(900);
      const chips = await page.evaluate(() => {
        const lab = [...document.querySelectorAll("label")].find(l => /^적용 대상$/.test((l.textContent || "").trim()));
        const box = lab && lab.nextElementSibling;
        return box ? [...box.querySelectorAll("button")].map(b => b.textContent.trim()) : [];
      });
      console.log(`     ${multi.t} · 칩 [${chips.join(", ")}]`);
      if (chips.length === 0) {
        console.log("  ⏭ 이 거래처는 구분이 하나뿐 — 칩 판정 건너뜀(기능 결함 아님)");
      } else {
        ok("칩 맨 앞은 «전체 노선»", chips[0] === "전체 노선", chips);
        ok("구분 칩이 1개 이상 함께 뜬다", chips.length >= 2, chips);
        await page.locator('input[type="date"]').nth(0).fill("2027-01-11");
        await page.locator('input[type="date"]').nth(1).fill("2027-01-22");
        await page.waitForTimeout(700);
        const allCnt = Number(((await readBox()) || "").match(/적용 대상 배차 일정 (\d+)개/)?.[1] || 0);
        // 구분 칩 하나를 누르면 대상이 줄어야 한다(안 줄면 필터가 안 걸린 것).
        await page.locator("button").filter({ hasText: new RegExp(`^${chips[1]}$`) }).first().click({ timeout: 10000 });
        await page.waitForTimeout(700);
        const oneCnt = Number(((await readBox()) || "").match(/적용 대상 배차 일정 (\d+)개/)?.[1] || 0);
        console.log(`     전체 ${allCnt}개 → «${chips[1]}» ${oneCnt}개`);
        ok("🔴 전체 대상이 1개 이상(신호 유무)", allCnt > 0, allCnt);
        ok("구분을 고르면 대상이 줄어든다", oneCnt > 0 && oneCnt < allCnt, { allCnt, oneCnt });
        await page.locator("button").filter({ hasText: /^전체 노선$/ }).first().click({ timeout: 10000 });
        await page.waitForTimeout(600);
        ok("«전체 노선» 으로 되돌리면 대상이 복구된다",
          Number(((await readBox()) || "").match(/적용 대상 배차 일정 (\d+)개/)?.[1] || 0) === allCnt);
      }
    }

    await page.screenshot({ path: path.join(dir, "bulk-modal-ok.png") }); // 정상 상태

    console.log("\n[4] 잘못된 기간 — 막히는가");
    await dateInputs.nth(0).fill("2027-03-01");
    await dateInputs.nth(1).fill("2027-01-01");   // 역순
    await page.waitForTimeout(700);
    const badTxt = await page.evaluate(() => document.body.innerText);
    ok("역순 기간이면 경고가 뜬다", /넘었습니다|늦거나/.test(badTxt));
    const applyDisabled = await page.locator("button").filter({ hasText: /^일괄 적용$/ }).first().isDisabled();
    ok("🔴 그때 「일괄 적용」이 눌리지 않는다", applyDisabled === true);

    console.log("\n[5] 운행 설정 · 마무리");
    const radios = await page.locator('input[type="radio"][name="bulkMode"]').count();
    ok("운행 설정 라디오 2개(운행 중지·운행)", radios === 2, radios);
    // 🔴 모형에 있던 「기존 설정 유지」는 일부러 안 만들었다 — 눌러도 아무 일도 안 일어나는 버튼이다.
    ok("🔴 «기존 설정 유지» 라디오는 없다", radios === 2 && !/기존 설정 유지/.test(badTxt));
    const offChecked = await page.locator('input[type="radio"][name="bulkMode"]').first().isChecked();
    ok("기본값이 «운행 중지»", offChecked === true);

    await page.screenshot({ path: path.join(dir, "bulk-modal.png"), fullPage: false });
    await page.locator("button").filter({ hasText: /^취소$/ }).first().click({ timeout: 10000 });
    await page.waitForTimeout(700);
    ok("취소하면 모달이 닫힌다",
      (await page.locator("div").filter({ hasText: /^📅 거래처 통합 운행일 설정$/ }).count()) === 0);

    const real = errs.filter(e => !/favicon|Failed to load resource|chrome-extension|net::ERR/.test(e));
    ok("콘솔 런타임 오류 0", real.length === 0, real.slice(0, 3));
  } catch (e) {
    console.log("  ✗ 예외: " + e.message);
    fail++;
  } finally {
    await ctx.close();
  }

  console.log(`\n스크린샷: ${dir}`);
  console.log(fail === 0 ? "\n✅ 전부 통과" : `\n❌ 실패 ${fail}건`);
  process.exit(fail === 0 ? 0 : 1);
})();
