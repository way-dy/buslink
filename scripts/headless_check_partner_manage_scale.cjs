// 협력사 포털 승객 관리 — 명부가 만 명대여도 화면이 살아 있는가 (2026-08-28 게시판 m00ghlRl)
//   1) node docs/manual/_serve_build.mjs   (별도 터미널·3000 포트)
//   2) node scripts/headless_check_partner_manage_scale.cjs [거래처이름일부]
//      대조군(배포 전 번들) = BASE=https://partner.buslink.co.kr node scripts/...
//
// 🔴 왜 필요한가: 예전엔 걸러진 인원을 **전부** 카드로 그렸다. 신촌세브란스병원 명부가
//    16,155명이 되면서 카드 하나에 DOM 15개꼴이라 브라우저가 수십만 노드를 그리다 멈췄다
//    (「협력사페이지 느려짐」). 소스 단언이 아니라 **실제로 그려진 카드 수와 DOM 노드 수**를
//    재서, 표시 상한을 걷어내면 빨간불이 되게 잠근다.
// prod 쓰기 0 — 업체코드로 로그인만 한다.
const path = require("path");
const fs = require("fs");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.BASE || "http://localhost:3000";
const COMPANY = "dy001";
const ROOT = path.join(__dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 🔴 탭은 셸에 따라 태그가 다르다 — PC(2026-09-02 어드민형 셸)는 <nav><div onClick>, 모바일은 <button>.
//    `locator("button",{hasText})` 로 잡으면 1280px 에서 0개가 되어 하네스가 통째로 죽는다
//    (2026-09-04 실측: 포털 하네스 5개가 09-02 이래 전부 죽어 있었다). 태그가 아니라 **라벨**로 잡는다.
const tabByLabel = (page, label) => page.locator("nav div, button").filter({ hasText: label }).first();


function loadDb() {
  const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
  const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
  const sa = require(path.join(ROOT, "key", kf));
  if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치");
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(sa) });
  return admin.firestore();
}

(async () => {
  let fail = 0;
  const ok = (n, c, x) => { console.log(`  ${c ? "✓" : "✗"} ${n}${!c && x !== undefined ? " → " + x : ""}`); if (!c) fail++; };

  const db = loadDb();
  const q = process.argv[2] || "세브란스";
  const pcSnap = await db.collection("partnerCodes").where("companyId", "==", COMPANY).get();
  const target = pcSnap.docs.map((d) => ({ code: d.id, ...(d.data() || {}) }))
    .find((c) => String(c.partnerName || "").includes(q));
  if (!target) { console.log("⏭ SKIP — 그 거래처가 없다"); process.exit(0); }
  const total = (await db.collection("companies").doc(COMPANY).collection("passengers")
    .where("partnerCode", "==", target.code).count().get()).data().count;

  console.log(`\n대상: ${target.partnerName} · 명부 ${total.toLocaleString()}명 · BASE=${BASE}`);

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: "ko-KR", timezoneId: "Asia/Seoul" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("dialog", (d) => d.dismiss().catch(() => {}));

  await page.goto(`${BASE}/partner`, { waitUntil: "domcontentloaded" });
  await sleep(2500);
  await page.locator("input").first().fill(target.code);
  const btn = page.locator('button:has-text("확인"), button:has-text("인증"), button:has-text("다음")');
  if (await btn.count()) await btn.first().click().catch(() => {});
  await sleep(3500);

  const t0 = Date.now();
  await tabByLabel(page, "승객 관리").click({ timeout: 15000 });
  // 목록이 그려질 때까지 — '비밀번호 재발급' 버튼이 카드 1장당 하나씩 붙는다
  await page.waitForFunction(() => document.querySelectorAll("button").length > 20, null, { timeout: 120000 }).catch(() => {});
  await sleep(3000);
  const elapsed = Date.now() - t0;

  const r = await page.evaluate(() => {
    const cards = [...document.querySelectorAll("button")].filter((b) => (b.textContent || "").trim() === "비밀번호 재발급").length;
    const stat = [...document.querySelectorAll("div")]
      .filter((d) => (d.textContent || "").trim() === "전체")
      .map((d) => (d.previousElementSibling || {}).textContent)
      .filter(Boolean)[0] || null;
    // 🔴 가장 안쪽 요소를 잡는다 — 바깥 div 를 잡으면 화면 전체 글자가 딸려 온다.
    const more = [...document.querySelectorAll("div")]
      .filter((d) => d.children.length === 0 && /명 중 [\d,]+명 표시 중/.test(d.textContent || ""))
      .map((d) => (d.textContent || "").trim())[0] || null;
    return { cards, domNodes: document.getElementsByTagName("*").length, statTotal: stat, more };
  });

  console.log(`  탭 전환→목록 ${(elapsed / 1000).toFixed(1)}초 · 그려진 카드 ${r.cards}장 · DOM ${r.domNodes.toLocaleString()}노드`);
  if (r.more) console.log(`  안내: ${r.more}`);

  ok("[0] 신호 있음 — 카드가 1장 이상 그려졌다(로그인·목록 렌더 확인)", r.cards >= 1, r.cards);
  // 🔴 이 검사의 존재 이유 — 전부 그리면 만 명대에서 브라우저가 멈춘다.
  ok("[1] 명부가 커도 한 번에 그리는 카드는 200장 이하", r.cards <= 200, `${r.cards}장`);
  ok("[2] DOM 노드가 5만 개를 넘지 않는다", r.domNodes < 50000, r.domNodes);
  // 🔴 화면은 천단위 콤마로 그린다(`toLocaleString`) — 원시 숫자와 문자열 비교하면 명부가
  //    1,000명을 넘는 순간부터 **영원히 실패**한다(2026-09-04 실측: 16,158 vs 16158).
  //    지키려는 불변식은 «표시 상한 100 이 아니라 전체 인원을 보여주는가» 이므로 콤마만 걷어낸다.
  ok("[3] 집계 숫자는 전체 기준을 그대로 보여준다",
    String(r.statTotal).replace(/,/g, "") === String(total), `${r.statTotal} vs ${total}`);
  if (total > 100) ok("[4] '몇 명 중 몇 명 표시 중' 안내가 있다", !!r.more, "안내 없음");
  ok("[5] 목록이 30초 안에 그려진다", elapsed < 30000, `${(elapsed / 1000).toFixed(1)}초`);
  ok("[6] 콘솔 오류 0", errors.length === 0, errors[0]);

  const shot = path.join(require("os").tmpdir(), "partner_manage_scale.png");
  await page.screenshot({ path: shot });
  console.log(`  (캡처: ${shot})`);
  await browser.close();
  console.log(fail === 0 ? "\n✅ 통과" : `\n❌ 실패 ${fail}건`);
  process.exit(fail ? 1 : 0);
})();
