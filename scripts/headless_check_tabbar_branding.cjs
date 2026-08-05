// 하단 탭바 거래처 브랜드 컬러 적용 검증 (2026-08-05 회의 #5).
//   1) node docs/manual/_serve_build.mjs   (별도 터미널·3000 포트)
//   2) node scripts/headless_check_tabbar_branding.cjs
//
// 배선만 보고 "적용됐다"고 말하지 않는다 — **실제 렌더된 색을 픽셀 값으로** 잰다.
// 이모지 아이콘은 폰트 글리프라 color 로 칠할 수 없었다(그래서 라벨만 브랜드 색이 되고
// 아이콘은 원색으로 남았다). 벡터 Icon(stroke=currentColor)으로 바꾼 게 이번 변경.
//
// ⚠ prod 실데이터 의존 — branding.primaryColor 를 설정한 거래처가 없으면 판정 불가(SKIP).
const path = require("path");
const os = require("os");
const fs = require("fs");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = "http://localhost:3000";
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
const hexToRgb = (h) => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(h).trim());
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
};
const parseRgb = (s) => {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(String(s));
  return m ? [+m[1], +m[2], +m[3]] : null;
};
const near = (a, b, tol = 6) => a && b && a.every((v, i) => Math.abs(v - b[i]) <= tol);

(async () => {
  let fail = 0;
  const ok = (n, c, x) => { console.log(`  ${c ? "✓" : "✗"} ${n}${!c && x !== undefined ? " → " + x : ""}`); if (!c) fail++; };

  const db = loadDb();
  const pcSnap = await db.collection("partnerCodes").where("companyId", "==", COMPANY).get();
  const branded = pcSnap.docs
    .map((d) => ({ code: d.id, ...(d.data() || {}) }))
    .filter((p) => p.branding && /^#[0-9a-fA-F]{6}$/.test(String(p.branding.primaryColor || "")));
  if (!branded.length) {
    console.log("\n⏭  SKIP — branding.primaryColor 를 설정한 거래처가 없다(설정 후 재실행).");
    process.exit(0);
  }
  // 인자로 거래처 이름 일부를 주면 그 거래처로(색 대비가 큰 곳으로 눈으로 보고 싶을 때)
  const q = process.argv[2];
  const target = (q && branded.find((p) => String(p.name || p.code).includes(q))) || branded[0];
  const want = hexToRgb(target.branding.primaryColor);
  console.log(`\n대상 거래처: ${target.name || target.code}  브랜드색 ${target.branding.primaryColor}`);

  // 그 거래처 소속 승객 한 명(노선 있는 사람)으로 세션을 심는다 — 로그인 폼은 안 태운다
  // (prod passengers.lastLoginAt 쓰기 회피).
  const psSnap = await db.collection("companies").doc(COMPANY).collection("passengers")
    .where("partnerCode", "==", target.code).limit(5).get();
  const passenger = psSnap.docs.map((d) => ({ empNo: d.id, ...(d.data() || {}) })).find((p) => p.routeId)
    || psSnap.docs.map((d) => ({ empNo: d.id, ...(d.data() || {}) }))[0];
  if (!passenger) { console.log("⏭  SKIP — 그 거래처 승객이 없다."); process.exit(0); }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "buslink-brand-"));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CHROME, headless: true, viewport: { width: 420, height: 900 }, deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const errs = [];
  const ignorable = (t) => /kakao|dapi|favicon|manifest|Failed to load resource|net::ERR/i.test(t);
  page.on("console", (m) => { if (m.type() === "error" && !ignorable(m.text())) errs.push(m.text()); });
  page.on("pageerror", (e) => { if (!ignorable(e.message)) errs.push("pageerror: " + e.message); });

  await page.addInitScript((s) => {
    window.localStorage.setItem("buslink_employee", JSON.stringify(s));
  }, { empNo: passenger.empNo, name: passenger.name || "검토", dept: "검토",
       routeId: passenger.routeId || null, partnerCode: target.code, companyId: COMPANY });

  await page.goto(`${BASE}/p?c=${COMPANY}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(9000);
  // 설치 유도 배너는 캡처 환경 방해물 — 닫아야 하단 탭바가 보인다
  for (const label of ["나중에", "닫기"]) {
    const btn = page.getByText(label, { exact: true }).first();
    if (await btn.count().catch(() => 0)) { await btn.click().catch(() => {}); await page.waitForTimeout(400); }
  }

  const probe = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    // 하단 탭바 = 마지막 버튼 묶음. 활성 탭(홈)의 버튼과 그 안 svg 를 찾는다.
    const btns = [...document.querySelectorAll("button")].filter((b) => /홈|노선|공지|탑승|설정/.test(b.textContent || ""));
    const home = btns.find((b) => (b.textContent || "").includes("홈"));
    const svg = home && home.querySelector("svg");
    return {
      cssPrimary: root.getPropertyValue("--color-primary").trim(),
      tabColor: home ? getComputedStyle(home).color : null,
      hasSvgIcon: !!svg,
      // 선택 탭은 채움(fill), 비선택은 라인(stroke) — 어느 쪽이든 "브랜드색으로 칠해졌나"를 본다
      svgFill: svg ? getComputedStyle(svg).fill : null,
      svgStroke: svg ? getComputedStyle(svg).stroke : null,
      pillBg: home ? getComputedStyle(home.querySelector("span")).backgroundColor : null,
      emojiInTabs: btns.map((b) => b.textContent).join("") ,
    };
  });

  console.log("\n[1] 거래처 브랜드 색이 CSS 변수에 적용됐나");
  ok("--color-primary 가 브랜드색으로 덮였다", near(parseRgb(`rgb(${hexToRgb(probe.cssPrimary) || ""})`) || hexToRgb(probe.cssPrimary), want)
    || String(probe.cssPrimary).toLowerCase() === String(target.branding.primaryColor).toLowerCase(),
    `--color-primary=${probe.cssPrimary}`);

  console.log("\n[2] 하단 탭 아이콘이 그 색을 실제로 입었나");
  ok("탭 아이콘이 벡터(svg)다 — 이모지는 색을 못 바꾼다", probe.hasSvgIcon, JSON.stringify(probe.emojiInTabs));
  ok("활성 탭 글자색 = 브랜드색", near(parseRgb(probe.tabColor), want), `color=${probe.tabColor} / want=${want}`);
  // 🔴 리터럴 속성(stroke)이 아니라 **관계**를 본다 — 라인이면 stroke, 채움이면 fill 로 칠해진다.
  //    2026-08-05 채움 아이콘 도입 때 stroke 만 보던 가드가 정확히 여기서 빨간불이 됐다.
  ok("활성 탭 아이콘이 브랜드색으로 칠해짐(fill 또는 stroke)",
    near(parseRgb(probe.svgFill), want) || near(parseRgb(probe.svgStroke), want),
    `fill=${probe.svgFill} stroke=${probe.svgStroke}`);
  ok("선택 탭 알약 배경이 칠해져 있다(브랜드 톤)",
    !!parseRgb(probe.pillBg) && !/rgba\(0, 0, 0, 0\)/.test(String(probe.pillBg)), `bg=${probe.pillBg}`);

  console.log("\n[3] 콘솔");
  ok("콘솔 오류 0", errs.length === 0, errs.join(" | "));

  const shot = path.join(os.tmpdir(), "buslink-tabbar.png");
  await page.screenshot({ path: shot });
  console.log(`\n스크린샷: ${shot}`);

  await ctx.close();
  console.log(`\n${fail === 0 ? "✅ 통과" : "❌ 실패"} (fail ${fail})`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("실행 오류:", e.message); process.exit(1); });
