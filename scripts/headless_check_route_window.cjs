// 노선 표시 시간창 실화면 검증 (2026-08-05 회의 #2·#3).
//   1) node docs/manual/_serve_build.mjs   (별도 터미널·3000 포트)
//   2) node scripts/headless_check_route_window.cjs
//
// 격리 테스트(test_route_window.cjs / test_gps_window_server.cjs)가 판정을 검증하고,
// 여기서는 **실제 승객앱 화면**에서 창 밖 노선이 가려지고 그 이유가 보이는지 본다.
// prod 실데이터로 "지금 창이 닫힌 노선"과 "열린 노선"을 각각 골라 태운다.
const path = require("path");
const os = require("os");
const fs = require("fs");
const vm = require("vm");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = "http://localhost:3000";
const COMPANY = "dy001";
const root = path.join(__dirname, "..");

function loadWindowLib() {
  let src = fs.readFileSync(path.join(root, "src/lib/routeWindow.js"), "utf8")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["'][^"']+["'];?$/gm, "")
    .replace(/^export\s+function\s+/gm, "function ")
    .replace(/^export\s+const\s+/gm, "var ");
  const ctx = vm.createContext({ console, Intl, Date, Number, Math, String });
  vm.runInContext(src, ctx);
  return ctx;
}

function loadDb() {
  const admin = require(path.join(root, "functions", "node_modules", "firebase-admin"));
  const kf = fs.readdirSync(path.join(root, "key")).find((f) => f.endsWith(".json"));
  const sa = require(path.join(root, "key", kf));
  if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치: " + sa.project_id);
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  return admin.firestore();
}

(async () => {
  let fail = 0;
  const ok = (n, c, x) => { console.log(`  ${c ? "✓" : "✗"} ${n}${!c && x !== undefined ? " → " + x : ""}`); if (!c) fail++; };

  const W = loadWindowLib();
  const db = loadDb();
  const nowMin = W.nowMinutesKST();
  console.log(`\n지금(KST) ${String(Math.floor(nowMin / 60)).padStart(2, "0")}:${String(nowMin % 60).padStart(2, "0")}`);

  const compSnap = await db.collection("companies").doc(COMPANY).get();
  const opts = W.normalizeWindowOpts(compSnap.data());
  console.log(`회사 기본 표시 범위: 출발 ${opts.preMin}분 전 ~ 도착 ${opts.postMin}분 후`);

  // 창이 닫힌 노선 / 열린 노선 하나씩(정류장 2개 이상)
  const rs = await db.collection("companies").doc(COMPANY).collection("routes").get();
  let closed = null, open = null;
  for (const r of rs.docs) {
    if (closed && open) break;
    const st = await r.ref.collection("stops").get();
    if (st.size < 2) continue;
    const stops = st.docs.map((s) => s.data());
    const win = W.computeRouteWindow(r.data(), stops, opts);
    if (!win) continue;
    const inW = W.isWithinRouteWindow(win, nowMin);
    const row = { id: r.id, name: r.data().name, label: W.describeRouteWindow(win) };
    if (inW && !open) open = row;
    if (!inW && !closed) closed = row;
  }
  if (!closed) { console.log("\n⏭  SKIP — 지금 창이 닫힌 노선이 없다."); process.exit(0); }
  console.log(`창 닫힘: ${closed.name} (${closed.label})`);
  console.log(`창 열림: ${open ? `${open.name} (${open.label})` : "없음"}`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "buslink-win-"));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CHROME, headless: true, viewport: { width: 420, height: 900 },
  });

  const visit = async (routeId) => {
    const page = await ctx.newPage();
    const errs = [];
    const ignorable = (t) => /kakao|dapi|favicon|manifest|Failed to load resource|net::ERR/i.test(t);
    page.on("console", (m) => { if (m.type() === "error" && !ignorable(m.text())) errs.push(m.text()); });
    page.on("pageerror", (e) => { if (!ignorable(e.message)) errs.push("pageerror: " + e.message); });
    await page.addInitScript((rid) => {
      window.localStorage.setItem("buslink_employee", JSON.stringify({
        empNo: "CAPTURE", name: "화면검토", dept: "검토", routeId: rid, companyId: "dy001",
      }));
    }, routeId);
    await page.goto(`${BASE}/p?c=${COMPANY}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(9000);
    const text = await page.evaluate(() => document.body.innerText);
    await page.close();
    return { text, errs };
  };

  console.log("\n[1] 창이 닫힌 노선 — 차량이 가려지고 이유가 보인다");
  {
    const { text, errs } = await visit(closed.id);
    ok("'운행 없음' 상태", /운행 없음/.test(text), JSON.stringify(text.slice(0, 140)));
    ok("창 시간대 안내가 보인다", text.includes(`${closed.label} 에 운행 정보가 표시됩니다`),
      JSON.stringify(text.slice(0, 300)));
    ok("콘솔 오류 0", errs.length === 0, errs.join(" | "));
  }

  if (open) {
    console.log("\n[2] 창이 열린 노선 — 안내가 뜨지 않는다(정상 화면)");
    const { text, errs } = await visit(open.id);
    ok("창 안내 문구 없음", !/에 운행 정보가 표시됩니다/.test(text), JSON.stringify(text.slice(0, 200)));
    ok("콘솔 오류 0", errs.length === 0, errs.join(" | "));
  }

  await ctx.close();
  console.log(`\n${fail === 0 ? "✅ 통과" : "❌ 실패"} (fail ${fail})`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("실행 오류:", e.message); process.exit(1); });
