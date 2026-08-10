// 도움말 시트 · 시간표 보기 · 알림 설정 카드 실화면 점검 (2026-08-10)
//   1) node docs/manual/_serve_build.mjs      (별도 터미널·3000 포트)
//   2) node scripts/headless_check_help_and_timetable.cjs [거래처이름일부]
//
// prod 쓰기 0 — 세션은 localStorage 주입, 읽기만.
// ⚠ localhost 는 카카오 도메인 미등록이라 지도는 안 뜬다. 여기서 보는 세 화면
//   (노선 탭 시간표·설정 탭·도움말 시트)은 지도를 안 쓰므로 검증에 지장 없다.
const path = require("path");
const os = require("os");
const fs = require("fs");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
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
  const q = process.argv[2] || "다우디지털";   // 회차가 많은 거래처 = 시간표가 의미 있는 곳
  const pcSnap = await db.collection("partnerCodes").where("companyId", "==", COMPANY).get();
  const codes = pcSnap.docs.map((d) => ({ code: d.id, ...(d.data() || {}) }));
  const target = codes.find((c) => String(c.partnerName || "").includes(q)) || codes[0];
  if (!target) { console.log("⏭ SKIP — 거래처가 없다"); process.exit(0); }

  const psSnap = await db.collection("companies").doc(COMPANY).collection("passengers")
    .where("partnerCode", "==", target.code).limit(3).get();
  const p = psSnap.docs.map((d) => ({ empNo: d.id, ...(d.data() || {}) }))[0];
  if (!p) { console.log(`⏭ SKIP — ${target.partnerName} 승객이 없다`); process.exit(0); }
  console.log(`\n대상: ${target.partnerName} · 승객 ${p.empNo}`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "buslink-help-"));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CHROME, headless: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const errs = [];
  const ignorable = (t) => /kakao|dapi|favicon|manifest|Failed to load resource|net::ERR|firebase|Firestore/i.test(t);
  page.on("console", (m) => { if (m.type() === "error" && !ignorable(m.text())) errs.push(m.text()); });
  page.on("pageerror", (e) => { if (!ignorable(e.message)) errs.push("pageerror: " + e.message); });

  await page.addInitScript((s) => window.localStorage.setItem("buslink_employee", JSON.stringify(s)),
    { empNo: p.empNo, name: p.name || "검토", dept: "검토", routeId: p.routeId || null,
      partnerCode: target.code, partnerName: target.partnerName || null, companyId: COMPANY });

  await page.goto(`${BASE}/p?c=${COMPANY}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(6000);
  // 🔴 강제 공지 모달·설치 안내가 탭 클릭을 가로챈다 — 먼저 전부 닫는다.
  for (const label of ["확인했습니다", "나중에", "✕"]) {
    for (let i = 0; i < 3; i++) {
      const b = page.locator(`button:has-text("${label}")`).first();
      if (await b.count() && await b.isVisible().catch(() => false)) {
        await b.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(400);
      } else break;
    }
  }
  await page.waitForTimeout(500);

  // 🔴 시트가 열린 채로 다음 단계를 진행하면 클릭이 오버레이에 먹혀 **다음 검사들이
  //    조용히 0 을 반환한다**(첫 실행에서 실제로 그랬다). 매 단계 사이에 확실히 닫고,
  //    닫혔는지 z-index 오버레이 유무로 확인한다.
  const overlayCount = () => page.evaluate(() =>
    [...document.querySelectorAll("div")].filter((d) => {
      const cs = getComputedStyle(d);
      return cs.position === "fixed" && Number(cs.zIndex) >= 200 && d.getBoundingClientRect().height > 300;
    }).length);
  async function closeOverlays() {
    for (let i = 0; i < 5; i++) {
      if ((await overlayCount()) === 0) return true;
      const b = page.locator('button:has-text("닫기")').last();
      if (await b.count() && await b.isVisible().catch(() => false)) {
        await b.click({ timeout: 3000 }).catch(() => {});
      } else {
        await page.keyboard.press("Escape").catch(() => {});
      }
      await page.waitForTimeout(400);
    }
    return (await overlayCount()) === 0;
  }
  // 탭바 버튼 = 라벨이 정확히 일치하는 것만(‘노선 변경’ 같은 긴 버튼과 섞이면 좌표가 틀어진다)
  const tabBtn = (label) => page.locator("button").filter({ hasText: new RegExp(`^${label}$`) }).last();

  // ── ① 도움말 버튼이 모든 탭에서 보이고, 탭바를 가리지 않는가 ──────────
  console.log("\n[1] 도움말 버튼");
  const helpBtn = page.locator('button[aria-label="도움말"]');
  ok("홈 탭에 도움말 버튼이 있다", (await helpBtn.count()) > 0);
  const geo = await page.evaluate(() => {
    const b = document.querySelector('button[aria-label="도움말"]');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    // 탭바 = 화면 맨 아래 버튼 줄
    const LABELS = ["홈", "노선", "공지", "탑승", "설정", "문의"];
    const tabs = [...document.querySelectorAll("button")]
      .filter((x) => LABELS.includes((x.textContent || "").trim()));
    const top = Math.min(...tabs.map((t) => t.getBoundingClientRect().top).filter(Number.isFinite));
    return { bottom: Math.round(r.bottom), tabTop: Math.round(top), w: Math.round(r.width) };
  });
  console.log(`     버튼 아래끝 ${geo && geo.bottom}px · 탭바 윗변 ${geo && geo.tabTop}px`);
  ok("도움말 버튼이 하단 탭바를 덮지 않는다", !!geo && geo.bottom <= geo.tabTop + 1,
    geo ? `${geo.bottom} vs ${geo.tabTop}` : "측정 실패");

  await helpBtn.click({ timeout: 10000 });
  await page.waitForTimeout(700);
  const helpTxt = await page.evaluate(() => document.body.innerText);
  ok("도움말 시트가 열린다", helpTxt.includes("이럴 땐 어떻게 하나요"));
  ok("현재 탭(홈) 사용법이 함께 나온다", helpTxt.includes("도움말 · 홈 화면"));
  ok("'노선이 화면에 안 나와요' 항목이 있다", helpTxt.includes("노선이 화면에 안 나와요"));

  // 아코디언이 실제로 펼쳐지는지 — 접힌 채 통과시키면 안내가 도달하지 않는다
  await page.locator('div:has-text("노선이 화면에 안 나와요")').last().click({ timeout: 8000 });
  await page.waitForTimeout(500);
  const opened = await page.evaluate(() => document.body.innerText);
  ok("항목을 누르면 해결 방법이 펼쳐진다", opened.includes("표시 시간대"));
  await page.screenshot({ path: path.join(userDataDir, "help.png") });
  ok("도움말 시트가 닫힌다", await closeOverlays());

  // ── ② 노선 탭 시간표 ────────────────────────────────────────────
  console.log("\n[2] 노선 탭 · 시간표 보기");
  await tabBtn("노선").click({ timeout: 15000 });
  await page.waitForTimeout(2500);
  const ttBtn = page.locator('button:has-text("시간표")').first();
  // 🔴 존재가 아니라 **보이는지**를 본다 — 오버레이에 덮여 있으면 클릭이 안 먹고
  //    그 뒤 검사들이 전부 0 을 반환하며 조용히 통과한다.
  ok("카드/시간표 전환 버튼이 보인다", await ttBtn.isVisible().catch(() => false));
  const cardsTxt = await page.evaluate(() => document.body.innerText);
  await ttBtn.click({ timeout: 10000 });
  await page.waitForTimeout(1500);
  // 🔴 앱이 죽었는지 **즉시** 본다 — 첫 실행에서 `new Map()`(카카오 SDK 가 내장 Map 을
  //    가림) 때문에 화면이 통째로 빈 채로 뒤 검사들이 전부 0 을 반환했고, 진짜 원인은
  //    한참 뒤 타임아웃으로만 드러났다. 빈 화면은 여기서 끊는다.
  const alive = (await page.evaluate(() => document.body.innerText.trim().length)) > 50;
  ok("시간표 전환 후에도 앱이 살아 있다(런타임 오류 없음)", alive,
    alive ? undefined : "화면이 비었다 — pageerror 확인: " + (errs[0] || "(수집 안 됨)"));

  const tt = await page.evaluate(() => {
    // 시간표 행 = 좌측 52px 시각 칸(HH:MM)을 가진 줄
    const rows = [];
    for (const d of document.querySelectorAll("div")) {
      const t = (d.textContent || "").trim();
      if (d.children.length !== 0) continue;
      if (!/^\d{2}:\d{2}$/.test(t)) continue;
      const cs = getComputedStyle(d);
      if (parseFloat(cs.fontSize) < 14) continue;
      rows.push({ t, size: cs.fontSize, clipped: d.scrollWidth > d.clientWidth + 1 });
    }
    return rows;
  });
  console.log(`     시각 행 ${tt.length}개 · 예: ${tt.slice(0, 6).map((r) => r.t).join(", ")}`);
  ok("시간표에 출발 시각 행이 그려진다", tt.length > 0, String(tt.length));
  ok("시각이 잘리지 않는다", tt.every((r) => !r.clipped));
  const sorted = tt.map((r) => r.t);
  ok("시각이 오름차순으로 정렬된다(그룹 내)", (() => {
    // 그룹(출근/퇴근) 경계에서 한 번 되돌아가는 것은 정상 — 되돌아감이 2회 이상이면 실패
    let back = 0;
    for (let i = 1; i < sorted.length; i++) if (sorted[i] < sorted[i - 1]) back++;
    return back <= 1;
  })(), sorted.join(" "));

  // 모수 일치 — 카드에 있던 노선이 시간표에서 사라지면 안 된다
  const timeTxt = await page.evaluate(() => document.body.innerText);
  const countName = (txt, name) => (txt.split(name).length - 1);
  const sampleRoute = (cardsTxt.match(/\d{2}:\d{2} 판교역/) || [])[0];
  if (sampleRoute) {
    ok(`카드에 있던 노선이 시간표에도 있다 (${sampleRoute})`, countName(timeTxt, sampleRoute) > 0);
  }
  await page.screenshot({ path: path.join(userDataDir, "timetable.png") });

  // 행을 누르면 정류장 시트가 열리는가 — 시각 칸의 부모(행)를 눌러야 한다
  const clickedRow = await page.evaluate(() => {
    for (const d of document.querySelectorAll("div")) {
      if (d.children.length !== 0) continue;
      if (!/^\d{2}:\d{2}$/.test((d.textContent || "").trim())) continue;
      if (parseFloat(getComputedStyle(d).fontSize) < 14) continue;
      const row = d.parentElement;
      if (!row) return false;
      row.click();
      return true;
    }
    return false;
  });
  await page.waitForTimeout(1400);
  ok("시간표 행을 누르면 정류장 시트가 열린다",
    clickedRow && (await page.evaluate(() => document.body.innerText)).includes("정류장 목록"));
  ok("정류장 시트가 닫힌다", await closeOverlays());

  // ── ③ 설정 탭 · 알림 설정 카드 ──────────────────────────────────
  console.log("\n[3] 설정 탭 · 알림 설정");
  await tabBtn("설정").click({ timeout: 15000 });
  await page.waitForTimeout(2500);
  const setTxt = await page.evaluate(() => document.body.innerText);
  ok("알림 설정 카드가 있다", setTxt.includes("🔔 알림 설정"));
  ok("켜짐/꺼짐 상태를 말해 준다", /도착 임박 알림 (켜짐|꺼짐)/.test(setTxt),
    (setTxt.match(/도착 임박 알림 \S+/) || [])[0]);
  const off = setTxt.includes("도착 임박 알림 꺼짐");
  ok(off ? "꺼짐이면 '지정하러 가기' 버튼이 있다" : "켜짐이면 '해제' 버튼이 있다",
    off ? setTxt.includes("지정하러 가기") : setTxt.includes("해제"));
  ok("기존 알림 진단 카드가 그대로 있다(회귀 0)", setTxt.includes("🔔 알림 진단"));
  await page.screenshot({ path: path.join(userDataDir, "settings.png") });

  if (off) {
    await page.locator('button:has-text("지정하러 가기")').first().click({ timeout: 8000 });
    await page.waitForTimeout(1500);
    ok("'지정하러 가기'가 홈으로 보낸다",
      (await page.evaluate(() => document.body.innerText)).includes("노선 변경") ||
      (await page.evaluate(() => document.body.innerText)).includes("현재 노선"));
  }

  console.log(`\n콘솔 오류 ${errs.length}건`);
  errs.slice(0, 5).forEach((e) => console.log("   " + e));
  ok("콘솔 오류 0", errs.length === 0, errs[0]);

  console.log(`\n스크린샷: ${userDataDir}`);
  console.log(fail === 0 ? "\n✅ 전부 통과" : `\n❌ 실패 ${fail}건`);
  await ctx.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("실패:", e); process.exit(1); });
