// 승객앱 QR 탑승 «끈 거래처» 실화면 검증 (2026-09-04 게시판 ELDcdSFD…)
//   1) node docs/manual/_serve_build.mjs   (별도 터미널)
//   2) node scripts/headless_check_qr_boarding_hidden.cjs
//      BASE=https://p.buslink.co.kr node scripts/headless_check_qr_boarding_hidden.cjs
//
// 🔴 이 검사는 **거래처 문서를 잠깐 고친다**(`qrBoarding.visible`). 대상은 시연용 샘플 거래처
//    하나뿐이고, `finally` 에서 **원래 값으로 반드시 되돌린다**(중간에 죽어도 되돌린다).
//    실제 고객 거래처를 대상으로 돌리지 말 것 — 그 순간 그 회사 승객 화면에서 QR 탑승이 사라진다.
//
// 🔴 «끈 화면»만 재면 공허하다 — 켜진 화면을 **같은 잣대로** 다시 재서 탭·버튼이 돌아오는지까지
//    본다(양성 대조). 안 그러면 앱이 통째로 깨져 아무것도 안 보여도 초록이 된다.
const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.BASE || "http://localhost:3000";
const COMPANY = "dy001";
const EMP = process.env.EMP || "SAMPLE-SEC";
const ROOT = path.join(__dirname, "..");

function loadAdmin() {
  const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
  const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
  const sa = require(path.join(ROOT, "key", kf));
  if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치");
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(sa) });
  return admin;
}

// 화면에서 읽는 값 — 탭 라벨·QR 버튼·안내 문구·정류장 변경 버튼.
const MEASURE = () => {
  const LAB = ["홈", "노선", "공지", "탑승", "설정", "문의", "홈페이지"];
  const tabs = [...document.querySelectorAll("button")]
    .filter((b) => LAB.includes((b.textContent || "").trim()))
    .map((b) => ({ label: b.textContent.trim(), top: Math.round(b.getBoundingClientRect().top) }));
  const bottom = tabs.length ? Math.max(...tabs.map((t) => t.top)) : 0;
  const tabBar = tabs.filter((t) => t.top >= bottom - 8).map((t) => t.label);
  const qr = [...document.querySelectorAll("button")]
    .filter((b) => (b.textContent || "").replace(/\s+/g, "").includes("QR탑승"));
  const txt = document.body.innerText;
  return {
    tabBar,
    qrCount: qr.length,
    hintQr: txt.includes("QR탑승 하실 수 있습니다"),
    hintPlain: txt.includes("도착 시간을 안내해 드립니다"),
    hasChange: [...document.querySelectorAll("button")].some((b) => (b.textContent || "").trim() === "정류장 변경"),
    bodyLen: txt.length,
  };
};

(async () => {
  let fail = 0;
  const ok = (n, c, x) => { console.log(`  ${c ? "✓" : "✗"} ${n}${!c && x !== undefined ? " → " + x : ""}`); if (!c) fail++; };

  const admin = loadAdmin();
  const db = admin.firestore();

  const pdoc = await db.collection("companies").doc(COMPANY).collection("passengers").doc(EMP).get();
  if (!pdoc.exists) { console.log(`⏭ SKIP — 승객 ${EMP} 없음`); process.exit(0); }
  const p = { empNo: pdoc.id, ...(pdoc.data() || {}) };
  const code = p.partnerCode;
  if (!code) { console.log(`⏭ SKIP — 승객 ${EMP} 에 거래처가 없다(이 검사는 거래처 옵션을 잰다)`); process.exit(0); }
  // 🔴 실제 고객 거래처 보호 — 코드에 '샘플' 이 든 거래처에서만 돈다.
  if (!/샘플|SMPL|SAMPLE/i.test(code)) {
    console.log(`⏭ SKIP — ${code} 는 샘플 거래처가 아니다(고객 화면을 끄지 않는다)`);
    process.exit(0);
  }

  const cref = db.collection("partnerCodes").doc(code);
  const csnap = await cref.get();
  const before = csnap.exists ? (csnap.data() || {}).qrBoarding : undefined;
  console.log(`\n대상 거래처: ${(csnap.data() || {}).partnerName || code}`);
  console.log(`원래 값: qrBoarding = ${JSON.stringify(before)}   (끝나면 이 값으로 되돌린다)`);

  const resumeToken = crypto.randomBytes(32).toString("hex");
  const sessRef = db.collection("companies").doc(COMPANY).collection("passengerSessions")
    .doc(crypto.createHash("sha256").update(resumeToken).digest("hex"));
  await sessRef.set({
    companyId: COMPANY, empNo: p.empNo,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    lastUsedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qrhide-"));

  async function measureWith(label) {
    const ctx = await chromium.launchPersistentContext(path.join(dir, label), {
      executablePath: CHROME, headless: true,
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    await page.addInitScript((s) => window.localStorage.setItem("buslink_employee", JSON.stringify(s)),
      { empNo: p.empNo, name: p.name || "검토", dept: p.dept || "검토", routeId: p.routeId || null,
        partnerCode: p.partnerCode || null, partnerName: p.partnerName || null, companyId: COMPANY, resumeToken });
    await page.goto(`${BASE}/p?c=${COMPANY}`, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(9000);
    for (const l of ["확인했습니다", "나중에", "✕"]) {
      for (let i = 0; i < 3; i++) {
        const b = page.locator(`button:has-text("${l}")`).first();
        if (await b.count() && await b.isVisible().catch(() => false)) { await b.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(400); } else break;
      }
    }
    await page.waitForTimeout(1500);
    const r = await page.evaluate(MEASURE);
    await page.screenshot({ path: path.join(dir, `${label}.png`) });
    await ctx.close();
    return { ...r, errs };
  }

  try {
    // ── ① 끈 상태 ───────────────────────────────────────────
    await cref.set({ qrBoarding: { visible: false } }, { merge: true });
    await new Promise((r) => setTimeout(r, 1500));
    const off = await measureWith("off");
    console.log(`\n[끔] 탭바 [${off.tabBar.join(", ")}] · QR 버튼 ${off.qrCount}개 · 본문 ${off.bodyLen}자`);
    // 🔴 신호 유무 — 앱이 살아 있어야 나머지 판정이 의미가 있다(빈 화면도 "탭 없음"이다).
    ok("앱이 실제로 떴다(탭바·본문 존재)", off.tabBar.length >= 3 && off.bodyLen > 100,
      `탭 ${off.tabBar.length}개 · ${off.bodyLen}자`);
    ok("하단 탭바에 '탑승' 탭이 없다", !off.tabBar.includes("탑승"), off.tabBar.join(","));
    ok("홈에 QR 탑승 버튼이 없다", off.qrCount === 0, `${off.qrCount}개`);
    ok("나머지 탭은 그대로(홈·노선·공지·설정)",
      ["홈", "노선", "공지", "설정"].every((l) => off.tabBar.includes(l)), off.tabBar.join(","));
    ok("안내 문구가 QR 를 가리키지 않는다", !off.hintQr);
    ok("정류장 선택 유도는 남아 있다", off.hintPlain, "도착 시간 안내 문구 없음");
    ok("콘솔 런타임 오류 0", off.errs.length === 0, off.errs.join(" | "));

    // ── ② 켠 상태(양성 대조) ────────────────────────────────
    await cref.set({ qrBoarding: { visible: true } }, { merge: true });
    await new Promise((r) => setTimeout(r, 1500));
    const on = await measureWith("on");
    console.log(`\n[켬] 탭바 [${on.tabBar.join(", ")}] · QR 버튼 ${on.qrCount}개`);
    ok("다시 켜면 '탑승' 탭이 돌아온다", on.tabBar.includes("탑승"), on.tabBar.join(","));
    ok("다시 켜면 QR 탑승 버튼이 돌아온다", on.qrCount >= 1, `${on.qrCount}개`);
    ok("켠 화면의 안내 문구는 QR 를 가리킨다", on.hintQr);
    ok("콘솔 런타임 오류 0", on.errs.length === 0, on.errs.join(" | "));
  } finally {
    // 🔴 무슨 일이 있어도 되돌린다 — 안 되돌리면 시연용 거래처가 꺼진 채 남는다.
    if (before === undefined) await cref.update({ qrBoarding: admin.firestore.FieldValue.delete() }).catch(() => {});
    else await cref.set({ qrBoarding: before }, { merge: true });
    const after = (await cref.get()).data() || {};
    console.log(`\n원복 확인: qrBoarding = ${JSON.stringify(after.qrBoarding)}`);
    if (JSON.stringify(after.qrBoarding) !== JSON.stringify(before)) {
      console.log("🔴 원복 실패 — 거래처 문서를 직접 확인할 것");
      fail++;
    }
    await sessRef.delete().catch(() => {});
  }

  console.log(`\n스크린샷: ${dir}`);
  console.log(fail === 0 ? "\n✅ 전부 통과" : `\n❌ 실패 ${fail}건`);
  process.exit(fail === 0 ? 0 : 1);
})();
