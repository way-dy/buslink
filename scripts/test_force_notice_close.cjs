// @requires-credentials — firebase-admin/운영 데이터가 있어야 돈다(기본 게이트 제외, --live 로 실행)
// 강제 공지 모달이 **항상 닫히는지** 검사 (2026-08-11 way 신고 회귀 가드)
//   1) node docs/manual/_serve_build.mjs   (별도 터미널·3000 포트)
//   2) node scripts/test_force_notice_close.cjs        # 로컬 빌드 검사
//      BASE=https://p.buslink.co.kr node scripts/test_force_notice_close.cjs   # prod 검사
//
// 🔴 왜 필요한가: 이 모달은 `inset:0 · z-index 99999` 로 **탭바까지 덮는다**. 닫히지 않으면
//    사용자는 앱에서 아무것도 못 한다 = 전체 장애다. 그런데 예전 구현은 닫힘이 전적으로
//    부모의 `markNoticesRead` **부수효과 성공**에 달려 있었고, 그 함수 첫 줄이
//    `if (!session?.empNo) return;` 이라 **세션에 empNo 가 없으면 조용히 아무 일도 안 했다.**
//    버튼은 눌리는데 화면이 그대로라 사용자에겐 "클릭 자체가 안 됨"으로 보인다(실제 신고 문구).
//
// 🔴 양성 대조가 핵심 — `empNo 없음` 조합을 **반드시** 포함한다. 정상 세션만 검사하면
//    이 결함이 있는 코드도 초록으로 통과한다(실제로 그랬다).
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
  if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치");
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  return admin.firestore();
}

(async () => {
  let fail = 0;
  const ok = (n, c, x) => { console.log(`  ${c ? "✓" : "✗"} ${n}${!c && x !== undefined ? " → " + x : ""}`); if (!c) fail++; };

  // ── 소스 가드 ────────────────────────────────────────────
  const src = fs.readFileSync(path.join(ROOT, "src", "pages", "EmployeeApp.js"), "utf8");
  console.log("\n[1] 소스 가드");
  ok("markNoticesRead 가 empNo 없다고 조기 return 하지 않는다",
    !/const markNoticesRead[\s\S]{0,220}?if \(!session\?\.empNo\) return;/.test(src));
  ok("읽음 시각은 empNo 유무와 무관하게 state 에 반영된다", /setNoticeReadAt\(now\);/.test(src));
  ok("모달이 로컬 dismissed 를 갖는다(부모 실패와 무관하게 닫힘)", /const \[dismissed, setDismissed\] = useState\(false\);/.test(src));
  ok("모달이 notice.id 로 keyed 되어 새 공지는 다시 뜬다", /<NoticeForceModal key=\{forceNotice\.id\}/.test(src));

  // ── 실화면: 세션 두 모양 ────────────────────────────────
  const db = loadDb();
  const pc = await db.collection("partnerCodes").where("companyId", "==", COMPANY).get();
  const codes = pc.docs.map((d) => ({ code: d.id, ...(d.data() || {}) }));
  // 공지가 있는 거래처를 고른다 — 없으면 모달이 안 떠서 검사가 vacuous 해진다
  const nSnap = await db.collection("companies").doc(COMPANY).collection("notices")
    .where("active", "==", true).orderBy("createdAt", "desc").limit(20).get();
  const codeWithNotice = nSnap.docs.map((d) => d.data().partnerCode).find(Boolean);
  const target = codes.find((c) => c.code === codeWithNotice) || codes[0];
  const ps = await db.collection("companies").doc(COMPANY).collection("passengers")
    .where("partnerCode", "==", target.code).limit(1).get();
  if (ps.empty) { console.log("⏭ SKIP — 그 거래처 승객이 없다"); process.exit(0); }
  const p = { empNo: ps.docs[0].id, ...ps.docs[0].data() };
  console.log(`\n[2] 실화면 (${target.partnerName} · ${BASE})`);

  for (const withEmp of [true, false]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fnc-"));
    const ctx = await chromium.launchPersistentContext(dir, {
      executablePath: CHROME, headless: true, viewport: { width: 1100, height: 900 },
    });
    const page = await ctx.newPage();
    const sess = { name: p.name || "검토", dept: p.dept || "검토", routeId: p.routeId || null,
      partnerCode: target.code, partnerName: target.partnerName || null, companyId: COMPANY };
    if (withEmp) sess.empNo = p.empNo;
    await page.addInitScript((s) => localStorage.setItem("buslink_employee", JSON.stringify(s)), sess);
    await page.goto(`${BASE}/p?c=${COMPANY}`, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(9000);

    const up = async () => page.evaluate(() => document.body.innerText.includes("확인했습니다"));
    const shown = await up();
    // 🔴 모달이 안 떴으면 이 케이스는 아무것도 검증하지 못한 것 — 통과로 세지 않는다
    ok(`[empNo ${withEmp ? "있음" : "없음"}] 강제 공지 모달이 실제로 떴다(검증 가능 상태)`, shown);
    if (shown) {
      await page.locator('button:has-text("확인했습니다")').first().click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(2500);
      ok(`[empNo ${withEmp ? "있음" : "없음"}] 클릭하면 모달이 닫힌다`, !(await up()));
      // 닫힌 뒤 앱을 쓸 수 있는가 — 탭바가 눌리는지
      const tabOk = await page.locator("button").filter({ hasText: /^노선$/ }).last()
        .isVisible().catch(() => false);
      ok(`[empNo ${withEmp ? "있음" : "없음"}] 닫힌 뒤 탭바를 쓸 수 있다`, tabOk);
    }
    await ctx.close();
  }

  console.log(fail === 0 ? "\n✅ 전부 통과" : `\n❌ 실패 ${fail}건`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("실패:", e); process.exit(1); });
