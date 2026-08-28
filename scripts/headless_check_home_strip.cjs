// 홈 노선도 스트립 — 전 정류장 시각 표시 후 겹침·잘림 검사 (2026-08-11 최우석 요청)
//   1) node docs/manual/_serve_build.mjs   (별도 터미널)
//   2) node scripts/headless_check_home_strip.cjs [거래처이름일부]
//      BASE=https://p.buslink.co.kr node scripts/headless_check_home_strip.cjs
//
// 🔴 왜 필요한가: 소스에 **"시각을 전 정류장에 붙이면 글자가 뒤엉킨다"**(2026-06-26 #5)는
//    가드가 적혀 있었는데 이번 요청이 그걸 뒤집는다. 문구로 "이제 괜찮다"고 적는 대신
//    **겹치는지·잘리는지를 픽셀로 재서** 잠근다.
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const fs = require("fs");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.BASE || "http://localhost:3000";
const COMPANY = "dy001";
const ROOT = path.join(__dirname, "..");
const EMP = process.env.EMP || "SAMPLE-SEC";   // 기본은 샘플 거래처 승객 — 실제 사람 계정을 안 건드린다

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
  const ok = (n, c, x) => { console.log(`  ${c ? "✓" : "✗"} ${n}${!c && x !== undefined ? " → " + x : ""}`); if (!c) fail++; };

  // 🔴 2026-08-25 승객 인증 전환 이후 localStorage 세션만으로는 못 들어간다 — 부팅이 조용히
  //    로그인 화면으로 떨어져 이 검사가 통째로 죽어 있었다(2026-08-28 발견).
  //    capture_passenger_screens.cjs 와 같이 승계표(resumeToken)를 발급해 넣고 끝나면 지운다.
  const admin = loadAdmin();
  const db = admin.firestore();
  const pdoc = await db.collection("companies").doc(COMPANY).collection("passengers").doc(EMP).get();
  if (!pdoc.exists) { console.log("⏭ SKIP — 승객 " + EMP + " 없음"); process.exit(0); }
  const p = { empNo: pdoc.id, ...(pdoc.data() || {}) };
  const resumeToken = crypto.randomBytes(32).toString("hex");
  const sessRef = db.collection("companies").doc(COMPANY).collection("passengerSessions")
    .doc(crypto.createHash("sha256").update(resumeToken).digest("hex"));
  await sessRef.set({ companyId: COMPANY, empNo: p.empNo,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    lastUsedAt: admin.firestore.FieldValue.serverTimestamp() });
  process.on("exit", () => { sessRef.delete().catch(() => {}); });
  console.log(`\n대상: ${p.partnerName || p.partnerCode} · 승객 ${p.empNo} · ${BASE}`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strip-"));
  const ctx = await chromium.launchPersistentContext(dir, {
    executablePath: CHROME, headless: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.addInitScript((s) => localStorage.setItem("buslink_employee", JSON.stringify(s)),
    { empNo: p.empNo, name: p.name || "검토", dept: p.dept || "검토", routeId: p.routeId || null,
      partnerCode: p.partnerCode || null, partnerName: p.partnerName || null, companyId: COMPANY, resumeToken });
  await page.goto(`${BASE}/p?c=${COMPANY}`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(9000);
  for (const label of ["확인했습니다", "나중에", "✕"]) {
    for (let i = 0; i < 3; i++) {
      const b = page.locator(`button:has-text("${label}")`).first();
      if (await b.count() && await b.isVisible().catch(() => false)) { await b.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(400); } else break;
    }
  }
  await page.waitForTimeout(1500);

  const r = await page.evaluate(() => {
    const strip = document.querySelector("[data-route-strip]");
    if (!strip) return { found: false };
    // 구조: [data-route-strip] > flex컨테이너 > (정류장래퍼 > 컬럼 + 연결선)
    // 🔴 한 단계 얕게 잡으면 컬럼이 0개인데 아래 비교가 전부 0===0 으로 초록이 된다(실제로 그랬다).
    const cols = [...strip.querySelectorAll(":scope > div > div > div")].filter((d) => d.style.width === "86px");
    const read = (col) => {
      const kids = [...col.children];
      const box = (el) => { const r = el.getBoundingClientRect(); return { t: r.top, b: r.bottom, l: r.left, rt: r.right, h: r.height, w: r.width }; };
      // 🔴 정류장 이름 칸만 `-webkit-line-clamp:2` 다 — **2줄 넘는 이름은 말줄임이 설계**이고
      //    그 클램프가 걸린 요소는 scrollWidth 가 clientWidth 를 넘는다(세로 말줄임인데 가로로
      //    읽힌다). 그래서 이름 칸은 가로 잘림 판정에서 빼고 `clamped` 로 따로 센다 —
      //    가로 잘림 검사의 대상은 역할·시각·'내 정류장' 처럼 **온전해야만 하는 짧은 줄**이다.
      const texts = kids.filter((k) => (k.textContent || "").trim().length > 0).map((k) => {
        const clamp = getComputedStyle(k).webkitLineClamp;
        const clamped = clamp && clamp !== "none";
        return { txt: (k.textContent || "").trim().slice(0, 20), ...box(k),
          clamped: !!clamped,
          truncated: !!clamped && k.scrollHeight > k.clientHeight + 1,   // 실제로 3줄 이상이라 잘린 이름
          clippedX: !clamped && k.scrollWidth > k.clientWidth + 1 };
      });
      return texts;
    };
    const all = cols.map(read);
    // 세로 겹침: 같은 컬럼 안 인접 텍스트 줄이 서로 침범하는가
    let vOverlap = 0;
    all.forEach((rows) => {
      for (let i = 1; i < rows.length; i++) if (rows[i].t < rows[i - 1].b - 0.5) vOverlap++;
    });
    // 가로 겹침: 이웃 컬럼의 같은 줄끼리 침범하는가
    let hOverlap = 0;
    for (let c = 1; c < all.length; c++) {
      const a = all[c - 1], b = all[c];
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) if (b[i].l < a[i].rt - 0.5) hOverlap++;
    }
    const clipped = all.flat().filter((t) => t.clippedX).map((t) => t.txt);
    const clampedNames = all.flat().filter((t) => t.truncated).map((t) => t.txt);
    const timeRows = all.filter((rows) => rows.some((t) => /^\d{2}:\d{2}$/.test(t.txt))).length;
    const myStopRows = all.filter((rows) => rows.some((t) => t.txt === "내 정류장")).length;
    // 🔴 "한눈에 보인다"의 실제 합격 조건 — 노선도 맨 아랫줄('내 정류장')이 탭바에 안 가려야 한다.
    //    DOM 에 있는 것과 화면에 보이는 것은 다르다(2026-08-11 실측: 라벨 아래끝 800 vs 탭바 783).
    const LAB = ["홈", "노선", "공지", "탑승", "설정", "문의"];
    const tabs = [...document.querySelectorAll("button")].filter((b) => LAB.includes((b.textContent || "").trim()));
    const tabTop = tabs.length ? Math.min(...tabs.map((t) => t.getBoundingClientRect().top)) : window.innerHeight;
    const labels = [...document.querySelectorAll("div")].filter((d) => (d.textContent || "").trim() === "내 정류장");
    const labelBottom = labels.length ? Math.max(...labels.map((l) => l.getBoundingClientRect().bottom)) : null;
    return { found: true, cols: cols.length, vOverlap, hOverlap, clipped, timeRows, myStopRows,
      tabTop: Math.round(tabTop), labelBottom: labelBottom === null ? null : Math.round(labelBottom),
      clampedNames,
      headline: document.body.innerText.includes("탑승하실 정류장을 선택하시면 QR탑승 하실 수 있습니다.") };
  });

  console.log("\n[홈 노선도 스트립]");
  if (!r.found) { console.log("  ✗ 스트립을 못 찾음"); process.exit(1); }
  console.log(`  정류장 컬럼 ${r.cols}개 · 시각 표시 ${r.timeRows}개 · '내 정류장' 라벨 ${r.myStopRows}개`);
  // 🔴 판정 0번 = 신호 유무. 컬럼을 못 잡으면 아래 겹침 검사가 전부 `0 === 0` 으로 초록이 된다
  //    — 검증한 게 아니라 아무것도 못 본 것이다. 여기서 끊는다.
  ok("정류장 컬럼을 2개 이상 잡았다(검사 성립)", r.cols >= 2, `${r.cols}개 — 셀렉터 확인 필요`);
  if (r.cols < 2) { console.log("\n❌ 검증 불가 — 이하 결과는 의미 없음"); await ctx.close(); process.exit(1); }
  ok("안내 문구가 노선도 위에 있다", r.headline);
  ok("모든 정류장에 시각이 표시된다", r.timeRows === r.cols, `${r.timeRows}/${r.cols}`);
  ok("모든 정류장에 '내 정류장' 라벨이 있다", r.myStopRows === r.cols, `${r.myStopRows}/${r.cols}`);
  // 🔴 여기가 이 하네스의 존재 이유 — 소스의 옛 가드("글자가 뒤엉킨다")를 픽셀로 대신한다
  ok("같은 정류장 안에서 줄끼리 겹치지 않는다", r.vOverlap === 0, `겹침 ${r.vOverlap}건`);
  ok("이웃 정류장끼리 글자가 겹치지 않는다", r.hOverlap === 0, `겹침 ${r.hOverlap}건`);
  // 이름은 2줄까지 보여주고 그 이상만 말줄임한다(가로 잘림은 없어야 한다).
  // 시각·'내 정류장' 은 짧아서 어떤 경우에도 온전해야 한다.
  ok("가로로 잘린 글자가 없다(이름 2줄 말줄임 제외)", r.clipped.length === 0, r.clipped.join(" | "));
  if (r.clampedNames.length) console.log(`  · 2줄을 넘어 말줄임된 이름: ${r.clampedNames.join(" | ")} (설계상 허용)`);
  ok("시각·'내 정류장' 라벨은 온전하다",
    !r.clipped.some((t) => /^\d{2}:\d{2}$/.test(t) || t === "내 정류장"), r.clipped.join(" | "));
  console.log(`  '내 정류장' 아래끝 ${r.labelBottom}px · 탭바 윗변 ${r.tabTop}px`);
  ok("노선도 맨 아랫줄이 탭바에 가리지 않는다(스크롤 없이 보인다)",
    r.labelBottom !== null && r.labelBottom <= r.tabTop, `${r.labelBottom} > ${r.tabTop}`);
  ok("콘솔 런타임 오류 0", errs.length === 0, errs[0]);

  await page.screenshot({ path: path.join(dir, "home.png") });
  console.log(`\n스크린샷: ${dir}`);
  console.log(fail === 0 ? "\n✅ 전부 통과" : `\n❌ 실패 ${fail}건`);
  await ctx.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("실패:", e); process.exit(1); });
