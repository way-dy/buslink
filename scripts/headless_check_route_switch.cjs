// 노선 변경 후 이전 노선 GPS 잔존 결함 — 실화면 검증 (2026-08-05)
//   1) node docs/manual/_serve_build.mjs   (별도 터미널·3000 포트)
//   2) node scripts/headless_check_route_switch.cjs
//
// 격리 테스트(scripts/test_animated_positions.cjs)가 훅 단위로 재현·검증하지만,
// "실제 화면에서 노선을 바꾸면 정말 사라지는가"는 앱을 태워 봐야 안다.
// 승객앱(/bus)은 익명 진입이라 로그인 없이 이 흐름을 그대로 태울 수 있고,
// 직원앱(/p)·관제·협력사 포털과 **같은 훅**을 쓴다.
//
// ⚠ prod 실데이터 의존 — 운행 중인 차량이 있는 노선이 하나도 없으면 판정 불가(SKIP).
const path = require("path");
const os = require("os");
const fs = require("fs");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = "http://localhost:3000";
const COMPANY = "dy001";

function loadDb() {
  const root = path.join(__dirname, "..");
  const admin = require(path.join(root, "functions", "node_modules", "firebase-admin"));
  const keyFile = fs.readdirSync(path.join(root, "key")).find((f) => f.endsWith(".json"));
  const sa = require(path.join(root, "key", keyFile));
  if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치: " + sa.project_id);
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  return admin.firestore();
}

(async () => {
  let fail = 0;
  const ok = (n, c, x) => { console.log(`  ${c ? "✓" : "✗"} ${n}${!c && x !== undefined ? " → " + x : ""}`); if (!c) fail++; };

  // ── prod 에서 "GPS 있는 노선" / "GPS 없는 노선" 한 쌍 고르기 ──────────
  const db = loadDb();
  const gpsSnap = await db.collection("gps").where("companyId", "==", COMPANY).get();
  const liveRouteIds = new Set();
  gpsSnap.forEach((d) => { if (d.data().routeId) liveRouteIds.add(d.data().routeId); });
  if (liveRouteIds.size === 0) {
    console.log("\n⏭  SKIP — 지금 운행 중인 차량이 없어 잔존 여부를 판정할 수 없다(운행 시간대에 재실행).");
    process.exit(0);
  }
  const routesSnap = await db.collection("companies").doc(COMPANY).collection("routes").get();
  const all = [];
  routesSnap.forEach((r) => all.push({ id: r.id, name: r.data().name || r.id }));
  const liveRoute = all.find((r) => liveRouteIds.has(r.id));
  const deadRoute = all.find((r) => !liveRouteIds.has(r.id));
  console.log(`\n운행 있는 노선: ${liveRoute.name} (${liveRoute.id})`);
  console.log(`운행 없는 노선: ${deadRoute.name} (${deadRoute.id})`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "buslink-rs-"));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CHROME, headless: true, viewport: { width: 420, height: 900 },
  });
  const page = await ctx.newPage();
  const errs = [];
  const ignorable = (t) => /kakao|dapi|favicon|manifest|Failed to load resource|net::ERR/i.test(t);
  page.on("console", (m) => { if (m.type() === "error" && !ignorable(m.text())) errs.push(m.text()); });
  page.on("pageerror", (e) => { if (!ignorable(e.message)) errs.push("pageerror: " + e.message); });

  // 운행 중인 노선으로 진입 — 배지가 "N대 운행" 이어야 판정이 성립한다
  await page.goto(`${BASE}/bus?c=${COMPANY}&r=${liveRoute.id}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(9000); // kakao 5초 대기 + gps onSnapshot 도달
  const before = await page.evaluate(() => document.body.innerText);
  const runningRe = /(\d+)대 운행/;
  console.log("\n[1] 운행 중인 노선 진입");
  ok("배지가 '운행' 상태", runningRe.test(before), JSON.stringify(before.slice(0, 160)));
  if (!runningRe.test(before)) {
    console.log("\n⏭  SKIP — 진입 시점에 화면이 운행 상태가 아니라 잔존 판정 불가.");
    await ctx.close(); process.exit(0);
  }

  // 노선 변경 → 운행 없는 노선 선택 (실제 사용자 조작과 동일 경로)
  console.log("\n[2] 노선 변경 → 운행 없는 노선");
  await page.getByText("노선 변경", { exact: false }).first().click();
  await page.waitForTimeout(800);
  await page.getByText(deadRoute.name, { exact: false }).first().click();
  await page.waitForTimeout(6000);
  const after = await page.evaluate(() => document.body.innerText);
  ok("이전 노선의 '운행 중' 표시가 사라진다", !runningRe.test(after), JSON.stringify(after.slice(0, 160)));
  ok("'운행 없음' 으로 바뀐다", /운행 없음/.test(after), JSON.stringify(after.slice(0, 160)));

  console.log("\n[3] 콘솔");
  ok("콘솔 오류 0", errs.length === 0, errs.join(" | "));

  await ctx.close();
  console.log(`\n${fail === 0 ? "✅ 통과" : "❌ 실패"} (fail ${fail})`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("실행 오류:", e.message); process.exit(1); });
