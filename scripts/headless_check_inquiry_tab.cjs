// 승객앱 하단 '문의' 탭 실화면 확인 (2026-08-06)
//   1) node docs/manual/_serve_build.mjs   (별도 터미널·3000 포트)
//   2) node scripts/headless_check_inquiry_tab.cjs [거래처이름일부]
//
// 두 가지를 본다.
//  A. **회귀** — 문의를 안 켠 거래처(=지금 prod 전부)에서 하단 탭이 예전 그대로 5개인지.
//  B. **레이아웃 실측** — 탭이 6개가 됐을 때 폭이 좁아 라벨이 잘리지 않는지.
//     🔴 이건 실제 탭바 DOM 을 복제해 한 칸 늘려 재는 것이라 **레이아웃만** 증명한다.
//        기능(위젯이 열리는지)은 거래처에 옵션을 켠 뒤 실기기로 봐야 한다.
//
// prod 쓰기 0 — 세션은 localStorage 주입(로그인 폼을 안 태워 lastLoginAt 도 안 건드린다).
const path = require("path");
const os = require("os");
const fs = require("fs");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
// 기본은 로컬 build 서버. 배포 후 실물을 보려면 BASE=https://p.buslink.co.kr 로.
const BASE = process.env.BASE || "http://localhost:3000";
const COMPANY = "dy001";
const ROOT = path.join(__dirname, "..");

function loadDb() {
  const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
  const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
  const sa = require(path.join(ROOT, "key", kf));
  if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치: " + sa.project_id);
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  return admin.firestore();
}

(async () => {
  let fail = 0;
  const ok = (n, c, x) => { console.log(`  ${c ? "✓" : "✗"} ${n}${!c && x !== undefined ? " → " + x : ""}`); if (!c) fail++; };

  const db = loadDb();
  const pcSnap = await db.collection("partnerCodes").where("companyId", "==", COMPANY).get();
  const codes = pcSnap.docs.map((d) => ({ code: d.id, ...(d.data() || {}) }));
  const enabled = codes.filter((c) => c.inquiry && c.inquiry.enabled === true && c.inquiry.tenantId);
  console.log(`\nprod 거래처 ${codes.length}곳 · 문의 켜진 곳 ${enabled.length}곳` +
    (enabled.length ? ` (${enabled.map((c) => `${c.partnerName}→${c.inquiry.tenantId}`).join(", ")})` : ""));

  const q = process.argv[2];
  const target = (q && codes.find((c) => String(c.partnerName || c.code).includes(q))) || enabled[0] || codes[0];
  if (!target) { console.log("⏭  SKIP — 거래처가 없다."); process.exit(0); }
  const expectInquiry = !!(target.inquiry && target.inquiry.enabled === true && target.inquiry.tenantId);
  console.log(`대상 거래처: ${target.partnerName || target.code} — 문의 ${expectInquiry ? "켜짐" : "꺼짐"}`);

  const psSnap = await db.collection("companies").doc(COMPANY).collection("passengers")
    .where("partnerCode", "==", target.code).limit(5).get();
  const rows = psSnap.docs.map((d) => ({ empNo: d.id, ...(d.data() || {}) }));
  const passenger = rows.find((p) => p.routeId) || rows[0];
  if (!passenger) { console.log("⏭  SKIP — 그 거래처 승객이 없다."); process.exit(0); }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "buslink-inqtab-"));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CHROME, headless: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const errs = [];
  const ignorable = (t) => /kakao|dapi|favicon|manifest|Failed to load resource|net::ERR/i.test(t);
  page.on("console", (m) => { if (m.type() === "error" && !ignorable(m.text())) errs.push(m.text()); });
  page.on("pageerror", (e) => { if (!ignorable(e.message)) errs.push("pageerror: " + e.message); });

  await page.addInitScript((s) => {
    window.localStorage.setItem("buslink_employee", JSON.stringify(s));
  }, { empNo: passenger.empNo, name: passenger.name || "검토", dept: "검토",
       routeId: passenger.routeId || null, partnerCode: target.code,
       partnerName: target.partnerName || null, companyId: COMPANY });

  await page.goto(`${BASE}/p?c=${COMPANY}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(6000); // 거래처 문서 getDoc + 첫 스냅샷
  // 설치 안내 모달이 하단 탭바를 덮어 캡처가 안 보인다 — 닫고 본다(측정에는 영향 없음).
  for (const label of ["나중에", "✕"]) {
    const b = page.locator(`button:has-text("${label}")`).first();
    if (await b.count() && await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); }
  }
  await page.waitForTimeout(500);

  // ── A. 탭 구성 ────────────────────────────────────────────
  const tabs = await page.evaluate(() => {
    const bars = [...document.querySelectorAll("div")].filter((d) => {
      const s = getComputedStyle(d);
      return s.display === "flex" && s.borderTopWidth !== "0px" &&
        d.children.length >= 4 && [...d.children].every((c) => c.tagName === "BUTTON");
    });
    const bar = bars[bars.length - 1];
    if (!bar) return null;
    return [...bar.children].map((b) => ({
      label: b.innerText.trim(),
      w: Math.round(b.getBoundingClientRect().width),
      clipped: b.scrollWidth > b.clientWidth + 1,
    }));
  });
  ok("하단 탭바를 찾았다", !!tabs);
  if (tabs) {
    console.log(`  탭: ${tabs.map((t) => `${t.label}(${t.w}px)`).join(" · ")}`);
    ok(`문의 탭 ${expectInquiry ? "노출" : "미노출"}`,
      tabs.some((t) => t.label === "문의") === expectInquiry, tabs.map((t) => t.label).join(","));
    ok("설정이 맨 끝", tabs[tabs.length - 1].label === "설정", tabs[tabs.length - 1].label);
    ok("라벨 잘림 없음", tabs.every((t) => !t.clipped));
  }
  await page.screenshot({ path: path.join(userDataDir, "tabbar-real.png") });

  // ── B. 6탭 레이아웃 실측(탭바 DOM 복제 — 기능이 아니라 폭만 본다) ──
  // 아이콘은 **소스(Icon.js)의 chat 경로를 그대로 뽑아** 꽂는다(손으로 그리지 않는다).
  const iconSrc = fs.readFileSync(path.join(ROOT, "src/components/ui/Icon.js"), "utf8");
  const chatLine = (iconSrc.match(/\n\s*chat: <>([\s\S]*?)<\/>,/) || [])[1] || "";
  const chatPaths = [...chatLine.matchAll(/d="([^"]+)"/g)].map((m) => m[1]);

  const probe = await page.evaluate((paths) => {
    const bars = [...document.querySelectorAll("div")].filter((d) => {
      const s = getComputedStyle(d);
      return s.display === "flex" && s.borderTopWidth !== "0px" &&
        d.children.length >= 4 && [...d.children].every((c) => c.tagName === "BUTTON");
    });
    const bar = bars[bars.length - 1];
    if (!bar) return null;
    if (![...bar.children].some((b) => b.innerText.trim() === "문의")) {
      const clone = bar.children[bar.children.length - 1].cloneNode(true); // 설정 버튼 복제
      const spans = clone.querySelectorAll("span");
      spans[spans.length - 1].textContent = "문의";
      const svg = clone.querySelector("svg");
      if (svg && paths.length) {
        svg.innerHTML = paths.map((d) => `<path d="${d}"></path>`).join("");
      }
      bar.insertBefore(clone, bar.children[bar.children.length - 1]);
    }
    return [...bar.children].map((b) => ({
      label: b.innerText.trim(),
      w: Math.round(b.getBoundingClientRect().width),
      clipped: b.scrollWidth > b.clientWidth + 1,
    }));
  }, chatPaths);
  if (probe) {
    console.log(`\n  [6탭 폭 실측] ${probe.map((t) => `${t.label}(${t.w}px)`).join(" · ")}`);
    ok("6탭에서도 라벨 잘림 없음", probe.every((t) => !t.clipped));
    ok("탭 하나가 48px 이상(터치 타깃)", probe.every((t) => t.w >= 48), String(Math.min(...probe.map((t) => t.w))));
  }
  await page.screenshot({ path: path.join(userDataDir, "tabbar-6.png") });

  ok(`콘솔 오류 0건`, errs.length === 0, errs.slice(0, 3).join(" | "));
  console.log(`\n캡처: ${userDataDir}`);
  await ctx.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("🔴", e.message); process.exit(1); });
