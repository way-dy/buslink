// 설치 유도 팝업이 거래처 표기·아이콘을 따르는가 (2026-08-30)
//   1) node docs/manual/_serve_build.mjs   (별도 터미널)
//   2) node scripts/headless_check_install_prompt_brand.cjs
//      BASE=https://p.buslink.co.kr node scripts/headless_check_install_prompt_brand.cjs
//
// 🔴 왜: <head> 파비콘·애플터치·매니페스트는 이미 거래처 테마를 따라가는데(applyAppManifest)
//    **설치 팝업만** 앱 고정 매핑(resolveAppIcons)을 봐서, 카카오 톤 화면 위에 파란 BusLink
//    아이콘과 "홈 화면에 BusLink 를 추가하세요" 가 떴다. 그 회귀를 픽셀·문자열로 잠근다.
// 🔴 비카카오 거래처도 함께 잰다 — 이 변경의 계약은 «부재=현행» 이므로 한쪽만 재면 절반이다.
// 팝업 띄우는 법: 안드로이드 크롬 UA 로 열면 BIP 없이 3초 뒤 `android-manual` 로 뜬다.
const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const ROOT = path.join(__dirname, "..");
const { chromium } = require(path.join(ROOT, "docs", "manual", "node_modules", "playwright-core"));

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.BASE || "http://localhost:3000";
const COMPANY = "dy001";
const UA_ANDROID = "Mozilla/5.0 (Linux; Android 13; SM-S911N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

function loadAdmin() {
  const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
  const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
  const sa = require(path.join(ROOT, "key", kf));
  if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치");
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(sa) });
  return admin;
}

(async () => {
  let fail = 0;
  const ok = (n, c, x) => { console.log("  " + (c ? "✓" : "✗") + " " + n + (!c && x !== undefined ? " → " + x : "")); if (!c) fail++; };

  const admin = loadAdmin();
  const db = admin.firestore();

  // 대상 2건 — 카카오 프리셋 거래처 1, 그 외 1(회귀). 승객은 그 거래처 아무나.
  const codes = await db.collection("partnerCodes").get();
  const kakao = codes.docs.find((d) => ((d.data() || {}).theme || {}).preset === "kakao" && d.id.indexOf("샘플") !== -1)
    || codes.docs.find((d) => ((d.data() || {}).theme || {}).preset === "kakao");
  const plains = codes.docs.filter((d) => { const v = d.data() || {}; return v.active !== false && !((v.theme || {}).preset); });
  if (!kakao || !plains.length) { console.log("⏭ SKIP — 대상 거래처를 못 찾음"); process.exit(0); }

  // 🔴 `pinInitial:true` 승객을 고르면 첫 PIN 설정 화면에서 멈춘다 — 그 화면엔 설치 팝업이
  //    없어서 «팝업이 안 뜬다» 로 잘못 실패한다(2026-08-30 에 한 번 밟음). 로그인 완료 상태만 고른다.
  const pick = async (code) => {
    const q = await db.collection("companies").doc(COMPANY).collection("passengers")
      .where("partnerCode", "==", code).limit(40).get();
    const d = q.docs.find((x) => (x.data() || {}).pinInitial !== true);
    return d ? { empNo: d.id, ...(d.data() || {}) } : null;
  };

  // 비카카오 대조군은 «첫 후보» 가 아니라 «로그인까지 가는 승객이 있는 첫 거래처» 다 —
  // 거래처에 승객이 0명이거나 전원 미개통(pinInitial)이면 대조가 조용히 SKIP 된다.
  let plain = null;
  for (const d of plains) { if (await pick(d.id)) { plain = d; break; } }
  if (!plain) { console.log("⏭ SKIP — 로그인 가능한 비카카오 승객을 못 찾음"); process.exit(0); }

  // 🔴 `wantText` 는 이름이 아니라 **조사까지 붙은 문장 조각**이다 — 「카카오통근를」 같은 오조사를
  //    이름만 검사하면 통과시킨다(2026-08-30 way 가 이름을 바꾸며 드러난 함정).
  // 🔴 홈 화면 아이콘 이름(`manifest.short_name`)은 앱 안 워드마크와 **일부러 다르다** —
  //    「카카오 T」 는 폰에 이미 깔린 카카오 T 앱과 겹친다. 둘을 같은 값으로 묶지 말 것.
  // 🔴 그리고 그 이름은 **프리셋이 아니라 거래처 문서**에 있다 — 같은 카카오 프리셋을 쓰는
  //    신촌세브란스는 예전 그대로여야 한다(way: 「거기는 거기만의 셋팅이 있어」). 아래 [대조군] 이 그것만 잰다.
  const CASES = [
    { label: "카카오 프리셋 · " + ((kakao.data() || {}).partnerName || kakao.id), code: kakao.id,
      wantIcon: "kakao-t.svg", wantText: "카카오통근을 추가", denyText: "BusLink",
      denyText2: "카카오통근를", wantShortName: "카카오통근", wantManifest: "/manifest-kakao-commute.json" },
    { label: "기본 테마 · " + ((plain.data() || {}).partnerName || plain.id), code: plain.id,
      wantIcon: "passenger.svg", wantText: "BusLink를 추가", denyText: null,
      denyText2: null, wantShortName: "BusLink 승객", wantManifest: "/manifest-employee.json" },
  ];

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "instbrand-"));
  const cleanup = [];
  try {
    // ── [대조군] 같은 프리셋을 쓰는 다른 거래처는 예전 그대로인가 ──────────────
    // 🔴 로그인하지 않는다 — 이 거래처 승객은 **실제 사람**이고, `?pc=` 만으로도 테마가 걸리므로
    //    승계표를 만들 이유가 없다(하네스가 남의 계정을 건드리지 않는 게 이 검사의 조건이다).
    const others = codes.docs.filter((d) => ((d.data() || {}).theme || {}).preset === "kakao"
      && d.id !== kakao.id && !((d.data() || {}).theme || {}).appName);
    for (const o of others) {
      const oname = (o.data() || {}).partnerName || o.id;
      console.log("\n[대조군 · " + oname + " — 프리셋만 쓰는 거래처]");
      const octx = await chromium.launchPersistentContext(path.join(dir, "ctl-" + o.id.slice(-4)), {
        executablePath: CHROME, headless: true, userAgent: UA_ANDROID,
        viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
      });
      const opage = await octx.newPage();
      await opage.goto(BASE + "/p?pc=" + encodeURIComponent(o.id), { waitUntil: "networkidle", timeout: 45000 });
      await opage.waitForTimeout(2500);
      const h = await opage.evaluate(async () => {
        const link = document.querySelector("link[rel='manifest']");
        const href = link ? link.getAttribute("href") : null;
        let shortName = null;
        try { if (href) shortName = (await (await fetch(href)).json()).short_name || null; } catch (_) {}
        const icon = document.querySelector("link[rel~='icon']");
        return { href, shortName, title: document.title,
                 icon: icon ? icon.getAttribute("href") : null };
      });
      console.log("    제목: " + h.title + " · 매니페스트: " + h.href + " · short_name: " + h.shortName);
      ok("🔴 홈 화면 이름이 예전 그대로(카카오 T)", h.shortName === "카카오 T", h.shortName);
      ok("🔴 매니페스트가 공용 /manifest-kakao.json 그대로", h.href === "/manifest-kakao.json", h.href);
      ok("🔴 탭 제목이 카카오 T 그대로", (h.title || "").indexOf("카카오 T") !== -1, h.title);
      ok("아이콘 그림은 공유(kakao-t.svg)", (h.icon || "").indexOf("kakao-t.svg") !== -1, h.icon);
      await octx.close();
    }

    for (const c of CASES) {
      const p = await pick(c.code);
      console.log("\n[" + c.label + "]");
      if (!p) { console.log("  ⏭ SKIP — 이 거래처 승객 0명"); continue; }

      const resumeToken = crypto.randomBytes(32).toString("hex");
      const sessRef = db.collection("companies").doc(COMPANY).collection("passengerSessions")
        .doc(crypto.createHash("sha256").update(resumeToken).digest("hex"));
      await sessRef.set({ companyId: COMPANY, empNo: p.empNo,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        lastUsedAt: admin.firestore.FieldValue.serverTimestamp() });
      cleanup.push(sessRef);

      const ctx = await chromium.launchPersistentContext(path.join(dir, c.code.slice(-4)), {
        executablePath: CHROME, headless: true, userAgent: UA_ANDROID,
        viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
      });
      const page = await ctx.newPage();
      const errs = [];
      page.on("pageerror", (e) => errs.push(e.message));
      await page.addInitScript((s) => window.localStorage.setItem("buslink_employee", JSON.stringify(s)),
        { empNo: p.empNo, name: p.name || "검토", dept: p.dept || "검토", routeId: p.routeId || null,
          partnerCode: p.partnerCode || null, partnerName: p.partnerName || null, companyId: COMPANY, resumeToken });
      await page.goto(BASE + "/p?c=" + COMPANY, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(11000); // 로그인 부팅 + 팝업 3초 폴백

      const r = await page.evaluate(async () => {
        // 실제로 걸려 있는 매니페스트를 받아 홈 화면 아이콘 이름을 읽는다(설정값이 아니라 결과를 본다).
        const link = document.querySelector("link[rel='manifest']");
        const manifestHref = link ? link.getAttribute("href") : null;
        let shortName = null;
        try {
          if (manifestHref) shortName = (await (await fetch(manifestHref)).json()).short_name || null;
        } catch (_) { shortName = null; }
        const dlg = document.querySelector('[role="dialog"][aria-label="앱 설치 안내"]');
        if (!dlg) return { found: false, shortName, manifestHref, body: document.body.innerText.slice(0, 160) };
        const img = dlg.querySelector("img");
        return { found: true, shortName, manifestHref, icon: img ? img.getAttribute("src") : null,
                 alt: img ? img.getAttribute("alt") : null, text: dlg.innerText.replace(/\s+/g, " ") };
      });
      await page.screenshot({ path: path.join(dir, "install-" + c.code.slice(-4) + ".png") });

      ok("설치 안내 팝업이 뜬다", r.found, r.body);
      console.log("    매니페스트: " + r.manifestHref + " · short_name: " + r.shortName);
      ok("홈 화면 아이콘 이름이 " + c.wantShortName, r.shortName === c.wantShortName, r.shortName);
      ok("매니페스트가 " + c.wantManifest, r.manifestHref === c.wantManifest, r.manifestHref);
      if (r.found) {
        console.log("    아이콘: " + r.icon + " · alt: " + r.alt);
        console.log("    문구: " + r.text.slice(0, 120));
        ok("아이콘이 " + c.wantIcon, (r.icon || "").indexOf(c.wantIcon) !== -1, r.icon);
        ok('문구에 "' + c.wantText + '"', r.text.indexOf(c.wantText) !== -1);
        if (c.denyText) ok('문구에 "' + c.denyText + '" 없음', r.text.indexOf(c.denyText) === -1, r.text.slice(0, 80));
        if (c.denyText2) ok('오조사 "' + c.denyText2 + '" 없음', r.text.indexOf(c.denyText2) === -1, r.text.slice(0, 80));
      }
      ok("콘솔 페이지오류 0", errs.length === 0, errs.join(" | "));
      await ctx.close();
    }
  } finally {
    for (const ref of cleanup) await ref.delete().catch(() => {});
  }
  console.log("\n스크린샷: " + dir);
  console.log(fail === 0 ? "\n✅ 전부 통과" : "\n❌ 실패 " + fail + "건");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("실패:", e.message); process.exit(1); });
