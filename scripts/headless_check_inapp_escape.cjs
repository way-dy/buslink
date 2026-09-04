// 인앱 브라우저 탈출 안내 · «설치할 때까지 팝업» 실화면 검사 (2026-09-04)
//   1) node docs/manual/_serve_build.mjs        (별도 터미널 — 로컬 빌드 서빙)
//   2) node scripts/headless_check_inapp_escape.cjs
//      BASE=https://p.buslink.co.kr node scripts/headless_check_inapp_escape.cjs
//
// 🔴 왜: 거래처가 «어르신들이 홈 화면 설치를 못 한다» 고 알려 왔다. 실제 원인은 설치 버튼이
//    아니라 **카카오톡 인앱 브라우저**였다 — 거기선 beforeinstallprompt 가 발생하지 않고
//    isAndroidPwaCapable() 이 카톡을 UA 로 제외하므로 **설치 안내가 화면에 뜬 적이 없다**.
//    이 하네스는 그 사실 자체를 먼저 재고(=[1] 옛 동작 재현), 새 안내가 실제로 뜨는지 잰다.
//
// 🔴 로그인하지 않는다 — 탈출 안내는 **로그인 화면**에 뜨도록 만들었다(로그인 뒤에 옮기라고
//    하면 옮겨간 브라우저에서 또 로그인해야 한다). 그래서 이 검사는 실제 승객 계정을
//    건드리지 않는다. 자격증명·Firestore 접근 0.
//
// ⚠ 여기서 «인터넷 브라우저로 열기» 를 **누르지는 않는다** — 헤드리스 크롬에는 카카오톡이
//    없어 openExternalBrowser 를 해석해 줄 주체가 없고, intent: 는 아예 안 뜬다. 버튼이
//    들고 있는 **주소가 맞는지**를 DOM 에서 확인하는 데까지가 이 하네스의 사정거리다.
const path = require("path");
const os = require("os");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const { chromium } = require(path.join(ROOT, "docs", "manual", "node_modules", "playwright-core"));

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.BASE || "http://localhost:3000";

const UA = {
  kakao: "Mozilla/5.0 (Linux; Android 13; SM-S911N Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.0.0 Mobile Safari/537.36 KAKAOTALK 10.4.5",
  insta: "Mozilla/5.0 (Linux; Android 13; SM-S911N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36 Instagram 302.0.0.23.113 Android",
  chrome: "Mozilla/5.0 (Linux; Android 13; SM-S911N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
};

let fail = 0;
const ok = (n, c, x) => {
  console.log("  " + (c ? "✓" : "✗") + " " + n + (!c && x !== undefined ? " → " + x : ""));
  if (!c) fail++;
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inapp-esc-"));
const opened = [];

async function ctxFor(ua, tag) {
  const c = await chromium.launchPersistentContext(path.join(dir, tag), {
    executablePath: CHROME, headless: true, userAgent: ua,
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
  });
  opened.push(c);
  return c;
}

// 화면에서 «탈출 안내» 를 읽어낸다. 라벨이 아니라 **역할+내용**으로 잡는다
// (2026-09-02 «태그가 아니라 라벨로 잡아라» 교훈의 연장 — 여기선 aria-label 이 정본).
async function readEscape(page) {
  return page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return { present: false };
    const txt = dlg.innerText || "";
    const btns = Array.from(dlg.querySelectorAll("button")).map((b) => (b.innerText || "").trim()).filter(Boolean);
    return {
      present: true,
      ariaLabel: dlg.getAttribute("aria-label"),
      text: txt,
      buttons: btns,
    };
  });
}

(async () => {
  try {
    // ── [1] 카카오톡 인앱 — 로그인 화면에서 탈출 안내가 뜨는가 ────────────────
    console.log("\n[1] 카카오톡 인앱 브라우저 · 로그인 화면");
    {
      const ctx = await ctxFor(UA.kakao, "kakao");
      const page = await ctx.newPage();
      await page.goto(BASE + "/p?emp=99999", { waitUntil: "networkidle", timeout: 45000 });
      await page.waitForTimeout(2000);
      const e = await readEscape(page);
      ok("안내가 뜬다", e.present === true, JSON.stringify(e).slice(0, 200));
      ok("탈출 안내로 표시된다(설치 안내가 아니다)",
        e.ariaLabel === "인터넷 브라우저로 열기 안내", e.ariaLabel);
      ok("승객이 알아보는 앱 이름이 적힌다", (e.text || "").indexOf("카카오톡") !== -1, e.text);
      ok("«인터넷 브라우저로 열기» 버튼이 있다",
        (e.buttons || []).some((b) => b.indexOf("인터넷 브라우저로 열기") !== -1), JSON.stringify(e.buttons));
      // 🔴 설치가 불가능한 화면에서 «설치» 를 권하면 안 된다 — 누르면 아무 일도 안 일어난다.
      ok("🔴 «설치» 버튼은 없다", !(e.buttons || []).some((b) => b.trim() === "설치"), JSON.stringify(e.buttons));
      ok("🔴 «이미 설치했어요» 도 없다(인앱에선 성립하지 않는다)",
        !(e.buttons || []).some((b) => b.indexOf("이미 설치했어요") !== -1), JSON.stringify(e.buttons));
      // 🔴 자동 탈출이 안 먹는 기기가 실재한다(way 폰). 그때 화면에 손으로 하는 길이 없으면
      //    승객은 «눌렀는데 아무 일도 안 일어난다» 에서 멈춘다. 문구는 스크린샷 실측 기준이다.
      ok("🔴 손안내가 버튼과 함께 떠 있다", (e.text || "").indexOf("다른 브라우저로 열기") !== -1, e.text);
      ok("🔴 손안내가 «오른쪽 아래» 를 가리킨다(카톡 메뉴는 하단바에 있다)",
        (e.text || "").indexOf("오른쪽 아래") !== -1, e.text);

      // 🔴 여기서 재는 것은 **2단 폴백**이다(2026-09-04 실기기 실패로 설계가 바뀌었다).
      //    안드 카톡의 1단은 `intent://…com.android.chrome` 인데, 헤드리스 크롬에는 그 인텐트를
      //    받을 OS 가 없어 **조용히 무시된다** — 이는 실기기에서 «크롬이 없거나 제조사 웹뷰라
      //    intent 가 안 먹는» 경우와 같은 상황이다. 그러니 이 환경은 폴백을 재기에 딱 맞다:
      //    누른 뒤 1.2초가 지나면 파라미터 URL 로 한 번 더 이동해야 한다.
      //    ⚠ 1단(`intent:`) 자체가 실기기에서 크롬을 여는지는 **여기서 못 잰다**(미검증으로 남는다).
      const before = page.url();
      await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll('[role="dialog"] button'))
          .find((b) => (b.innerText || "").indexOf("인터넷 브라우저로 열기") !== -1);
        if (el) el.click();
      });
      await page.waitForTimeout(3000); // 폴백 타이머 1.2초 + 이동 여유
      const after = page.url();
      ok("🔴 1단이 무시되면 2단 폴백이 이어진다", after !== before, before + " → " + after);
      ok("폴백 주소에 openExternalBrowser=1 이 붙는다",
        after.indexOf("openExternalBrowser=1") !== -1, after);
      ok("폴백 주소가 사번 프리필을 유지한다(다시 안 친다)",
        after.indexOf("emp=99999") !== -1, after);
      await ctx.close();
      opened.pop();
    }

    // ── [2] 대조군: 일반 안드로이드 크롬 — 로그인 화면은 예전 그대로여야 한다 ──
    console.log("\n[2] 대조군 · 안드로이드 크롬 · 로그인 화면(회귀 0)");
    {
      const ctx = await ctxFor(UA.chrome, "chrome");
      const page = await ctx.newPage();
      await page.goto(BASE + "/p", { waitUntil: "networkidle", timeout: 45000 });
      // 설치 안내 타이머가 3초라 그보다 넉넉히 기다려 «안 뜬다» 를 확실히 잰다.
      await page.waitForTimeout(5000);
      const e = await readEscape(page);
      // 🔴 이게 무너지면 멀쩡한 승객 전원이 로그인 화면에서 배너를 맞는다.
      ok("🔴 로그인 화면에 팝업이 없다(escapeOnly 계약)", e.present === false, JSON.stringify(e).slice(0, 200));
      const hasLogin = await page.evaluate(() => document.querySelectorAll("input").length > 0);
      ok("로그인 화면 자체는 정상 렌더", hasLogin === true);
      await ctx.close();
      opened.pop();
    }

    // ── [3] 인스타 인앱(안드) — 카카오가 아닌 인앱도 잡히는가 ────────────────
    console.log("\n[3] 인스타그램 인앱(안드로이드) · intent 경로");
    {
      const ctx = await ctxFor(UA.insta, "insta");
      const page = await ctx.newPage();
      await page.goto(BASE + "/p", { waitUntil: "networkidle", timeout: 45000 });
      await page.waitForTimeout(2000);
      const e = await readEscape(page);
      ok("안내가 뜬다", e.present === true, JSON.stringify(e).slice(0, 160));
      ok("앱 이름이 인스타그램으로 적힌다", (e.text || "").indexOf("인스타그램") !== -1, e.text);
      await ctx.close();
      opened.pop();
    }

    // ── [4] «설치할 때까지» — 닫아도 다음 방문에 다시 뜨는가 ────────────────
    // 🔴 이 검사가 이번 변경의 핵심이다. 세션 안에서는 조용하고, 새 방문에서는 다시 떠야 한다.
    //    둘 중 하나만 맞으면 ⓐ 앱을 못 쓰거나 ⓑ 예전처럼 한 번 닫으면 끝이다.
    console.log("\n[4] «설치할 때까지 팝업» — 세션당 1회 · 방문마다 재노출");
    {
      const profile = path.join(dir, "nag");
      const open = async () => {
        const c = await chromium.launchPersistentContext(profile, {
          executablePath: CHROME, headless: true, userAgent: UA.kakao,
          viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
        });
        opened.push(c);
        const p = await c.newPage();
        await p.goto(BASE + "/p", { waitUntil: "networkidle", timeout: 45000 });
        await p.waitForTimeout(1800);
        return { c, p };
      };

      const a = await open();
      ok("첫 방문에 뜬다", (await readEscape(a.p)).present === true);
      await a.p.evaluate(() => {
        const b = Array.from(document.querySelectorAll('[role="dialog"] button'))
          .find((x) => (x.innerText || "").trim() === "나중에");
        if (b) b.click();
      });
      await a.p.waitForTimeout(400);
      ok("«나중에» 를 누르면 사라진다", (await readEscape(a.p)).present === false);

      // 같은 세션(같은 탭) 새로고침 — 다시 뜨면 앱을 쓸 수 없다.
      await a.p.reload({ waitUntil: "networkidle", timeout: 45000 });
      await a.p.waitForTimeout(1800);
      ok("🔴 같은 방문 안에서는 다시 뜨지 않는다(앱을 쓸 수 있어야 한다)",
        (await readEscape(a.p)).present === false);
      await a.c.close();
      opened.pop();

      // 브라우저를 완전히 닫았다 다시 연다 = 새 방문. sessionStorage 가 비므로 다시 떠야 한다.
      // localStorage(=프로필)는 그대로 남아 있으므로 «옛 3일 스누즈» 가 살아 있으면 여기서 빨간불.
      const b = await open();
      ok("🔴 다음 방문에는 다시 뜬다(«설치할 때까지»)",
        (await readEscape(b.p)).present === true,
        JSON.stringify(await readEscape(b.p)).slice(0, 160));
      await b.c.close();
      opened.pop();
    }
  } catch (err) {
    console.log("\n✗ 하네스 예외: " + (err && err.message ? err.message : String(err)));
    fail++;
  } finally {
    for (const c of opened) { try { await c.close(); } catch (_) {} }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }

  console.log("\n결과: " + (fail === 0 ? "전부 통과" : fail + "건 실패"));
  process.exit(fail === 0 ? 0 : 1);
})();
