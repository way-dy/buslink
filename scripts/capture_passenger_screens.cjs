// 승객앱 현재 화면 일괄 캡처 (읽기 전용·prod 쓰기 0) — 2026-08-10 디자인 검토용.
//   node scripts/capture_passenger_screens.cjs [출력폴더] [거래처이름일부]
//
// 대상은 `BASE` 로 바꾼다(기본 prod). **localhost 에서도 지도가 정상 렌더된다** —
// 2026-08-10 실측: `localhost:3000` 과 prod 가 타일 15장·200 응답으로 동일(localhost 는
// 카카오 콘솔에 등록돼 있다). 저장소 여러 곳에 "localhost 는 미등록이라 지도가 안 뜬다"고
// 적혀 있었으나 반증됐다 → 배포 전 시각 검토는 로컬 빌드로 끝낼 수 있다.
// ⚠ 단 지도가 필요한 화면을 검증할 땐 SDK 로드·타일 수를 **판정 0번 항목**으로 둘 것
//    (지도가 안 뜬 스크린샷으로 "디자인이 조잡한가"를 판단하면 엉뚱한 결론이 난다).
// ⚠ 세션 주입 방식(2026-08-27 교정) — 2026-08-25 승객 인증 전환(P1) 이후 부팅이
//    localStorage 의 `resumeToken` 으로 CF `passengerResume` 를 부른다. 예전처럼
//    empNo/name 만 넣으면 **조용히 로그인 화면에서 멈춘다**(그 상태로 찍은 5장이 전부
//    로그인 화면이었다). 그래서 여기서 **승계표를 서버에 직접 만들고**
//    (`companies/{cid}/passengerSessions/{sha256(resumeToken)}`) 그 토큰을 주입한다.
//    🔴 `passengerLogin`(사번+PIN)을 태우지 않는 이유 = 그쪽은 `lastLoginAt` 을 쓰고
//       협력사 포털의 "미시작" 집계를 오염시킨다. `passengerResume` 는 안 쓴다.
//    🔴 레거시 `pinHash` 승계(`passengerMigrate`)도 쓰지 않는다 — 서버가 2026-09-30 에
//       닫으므로 그날 이 도구가 같이 죽는다.
//    승계표는 캡처가 끝나면(실패해도) 지운다 → 남는 쓰기 0.
// ⚠ 화면을 눌러 '내 정류장'을 지정하지 않는다(fcmTokens write 방지).
const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.BASE || "https://p.buslink.co.kr";
const COMPANY = "dy001";
const ROOT = path.join(__dirname, "..");
const OUT = process.argv[2] || path.join(os.tmpdir(), "buslink-shots");
const QUERY = process.argv[3] || "채드윅";
// THEME=kakao 면 거래처 테마를 «화면에만» 입혀 찍는다(고객 문서용 시안).
// 🔴 거래처 문서를 켜서 찍는 게 아니라 앱이 켜졌을 때 세팅하는 것과 **같은 CSS 변수**를
//    주입한다 — 실고객 설정을 건드리지 않기 위해서다. 색 값은 `partnerBranding.THEME_PRESETS`
//    와 같아야 하므로 바꿀 때 두 곳을 함께 고칠 것.
const THEME = process.env.THEME || "";
const KAKAO = { band: "#1E233D", accent: "#FFCD00", accentSoft: "#FFF3C4", primary: "#4088FE" };

function loadAdmin() {
  return require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
}

// 캡처가 남긴 승계표를 지운다(성공·실패 공통). 발급 전이면 no-op.
let sessRefForCleanup = null;
async function cleanup() {
  if (!sessRefForCleanup) return;
  try { await sessRefForCleanup.delete(); console.log("승계표 삭제 완료"); }
  catch (e) { console.warn("🔴 승계표 삭제 실패 — 수동 정리 필요:", e.message); }
}

function loadDb() {
  const admin = loadAdmin();
  const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
  const sa = require(path.join(ROOT, "key", kf));
  if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치: " + sa.project_id);
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  return admin.firestore();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const db = loadDb();
  const pcSnap = await db.collection("partnerCodes").where("companyId", "==", COMPANY).get();
  const codes = pcSnap.docs.map((d) => ({ code: d.id, ...(d.data() || {}) }));
  const target = codes.find((c) => String(c.partnerName || "").includes(QUERY)) || codes[0];
  // 🔴 `limit(N)` 으로 앞부분만 보지 말 것 — 문서 ID 순으로 잘리므로 **쓸 수 있는 계정이
  //    뒤에 있으면 "없다"고 잘못 판정한다**(2026-08-27 실측: 신촌세브란스는 승객 8,255명
  //    중 6명이 로그인 이력이 있는데 앞 80건에 하나도 없어 "캡처 불가"로 끝났다).
  //    쓸 수 있는 조건(`lastLoginAt` 보유)으로 **서버에서 걸러** 가져온다.
  //    `EMP=<사번>` 을 주면 그 사람으로 고정한다(검토용 계정 등).
  const EMP = process.env.EMP || "";
  const col = db.collection("companies").doc(COMPANY).collection("passengers");
  let docs;
  if (EMP) {
    const one = await col.doc(EMP).get();
    if (!one.exists) { console.log(`⏭ 승객 ${EMP} 없음`); process.exit(0); }
    docs = [one];
  } else {
    // `lastLoginAt` 이 있는 사람만 = 첫 PIN 설정 화면에 갇히지 않는 계정(내림차순 최근순).
    // 🔴 이 쿼리는 **복합 인덱스**(passengers: partnerCode ASC + lastLoginAt DESC)가 있어야 돈다.
    //    2026-08-27 에 이 줄을 넣고 인덱스를 안 만들어 prod 에서 계속 실패했고(`EMP=` 로 우회 중이었다),
    //    2026-08-28 에 `firestore.indexes.json` 에 추가·배포해 풀었다. 인덱스를 지우면 다시 죽는다.
    docs = (await col.where("partnerCode", "==", target.code)
      .orderBy("lastLoginAt", "desc").limit(20).get()).docs;
  }
  if (!docs.length) { console.log(`⏭ ${target.partnerName} — 로그인 이력이 있는 승객이 없다. 캡처 불가`); process.exit(0); }

  // 🔴 아무나 고르면 안 된다 — `pinInitial:true` 인 사람으로 들어가면 앱이 **첫 PIN 설정
  //    화면**(FirstPinSetup)에 가둬 탭바가 아예 안 뜬다(2026-08-27 실측). 그렇다고 여기서
  //    PIN 을 정해 주면 **실제 사람의 비밀번호를 바꾸는 것**이다 → 이미 본인 번호로 바꾼
  //    사람(또는 그 화면이 면제되는 공용계정 `pinLocked`)만 고른다.
  //    노선이 배정된 사람을 앞세운다 — 홈 화면이 비면 디자인 검토가 안 된다.
  const cands = docs.map((d) => ({ empNo: d.id, ...(d.data() || {}) }))
    .filter((x) => x.active !== false && (x.pinInitial !== true || x.pinLocked === true))
    .sort((a, b) => (b.routeId ? 1 : 0) - (a.routeId ? 1 : 0));
  if (!cands.length) {
    console.log(`⏭ ${target.partnerName} — 쓸 수 있는 승객이 없다(전원 pinInitial). 캡처 불가`);
    process.exit(0);
  }
  const p = cands[0];
  console.log(`대상: ${target.partnerName} · 승객 ${p.empNo}${p.routeId ? "" : " (배정 노선 없음)"} · ${BASE}`);

  // 승계표 발급 — 문서 ID 는 서버 `resumeDocId` 와 **글자 그대로 같은 식**이어야 한다
  // (functions/index.js `sha256(resumeToken)`). 어긋나면 부팅이 조용히 로그인으로 떨어진다.
  const admin = loadAdmin();
  const resumeToken = crypto.randomBytes(32).toString("hex");
  sessRefForCleanup = db.collection("companies").doc(COMPANY).collection("passengerSessions")
    .doc(crypto.createHash("sha256").update(resumeToken).digest("hex"));
  await sessRefForCleanup.set({
    companyId: COMPANY, empNo: p.empNo,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    lastUsedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log("승계표 발급 — 캡처 후 삭제");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "buslink-cap-"));
  const ctx = await chromium.launchPersistentContext(dir, {
    executablePath: CHROME, headless: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await page.addInitScript((s) => window.localStorage.setItem("buslink_employee", JSON.stringify(s)),
    { empNo: p.empNo, name: p.name || "검토", dept: p.dept || "검토", routeId: p.routeId || null,
      partnerCode: target.code, partnerName: target.partnerName || null, companyId: COMPANY,
      resumeToken });

  await page.goto(`${BASE}/p?c=${COMPANY}`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(9000);   // 지도 타일·GPS 구독이 붙을 시간
  for (const label of ["확인했습니다", "나중에", "✕"]) {
    for (let i = 0; i < 3; i++) {
      const b = page.locator(`button:has-text("${label}")`).first();
      if (await b.count() && await b.isVisible().catch(() => false)) {
        await b.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(400);
      } else break;
    }
  }
  await page.waitForTimeout(2500);

  // 🔴 신호 유무 검사 — 세션 복원이 깨지면 화면이 **로그인 폼**에서 멈추는데, 그대로 찍으면
  //    5장이 전부 같은 화면이고 아무도 실패인 줄 모른다(2026-08-27 실제로 그랬다).
  //    판정은 하단 탭바 존재로 한다 — 로그인 화면엔 탭이 없다.
  const tabCount = await page.locator("button")
    .filter({ hasText: /^(홈|노선|탑승|공지|설정)$/ }).count();
  if (tabCount < 4) {
    const seen = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 160));
    throw new Error(`세션 복원 실패 — 로그인 화면에서 멈췄다(탭 ${tabCount}개)\n화면: ${seen}`);
  }

  if (THEME === "kakao") {
    const painted = await page.evaluate((t) => {
      const r = document.documentElement.style;
      r.setProperty("--color-primary", t.primary);
      r.setProperty("--color-primary-soft", "#EAF1FE");
      r.setProperty("--color-primary-deep", "#2A6BE0");
      r.setProperty("--color-band", t.band);
      r.setProperty("--color-accent", t.accent);
      r.setProperty("--color-accent-soft", t.accentSoft);
      // 상단 밴드는 인라인 스타일이라 CSS 변수로 안 바뀐다 — 프리셋 값으로 직접 칠한다.
      // 🔴 기대 색을 적어 두고 찾지 말 것 — 밴드색은 거래처 색에서 파생(25% 어둡게)이라
      //    손으로 계산하면 반올림 한 자리로 빗나간다(실측: 예상 #0F213D, 실제 #0F213E →
      //    한 픽셀도 안 바뀌었는데 캡처는 성공한 것처럼 끝났다). **구조로 찾는다** =
      //    화면 맨 위에 붙은, 폭이 화면 전체인, 어두운 배경의 블록.
      const lum = (bg) => {
        const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg || "");
        if (!m) return 1;
        return (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255;
      };
      const band = [...document.querySelectorAll("div")].find((d) => {
        const r = d.getBoundingClientRect();
        return r.top <= 2 && r.width >= window.innerWidth - 2 && r.height > 40 && r.height < 260
          && lum(getComputedStyle(d).backgroundColor) < 0.28;
      });
      if (band) band.style.background = t.band;
      return !!band;                       // 못 찾으면 호출부가 멈춘다
    }, KAKAO);
    await page.waitForTimeout(600);
    // 🔴 신호 유무 — 밴드를 못 찾았는데 조용히 넘어가면 «톤을 입혔다»는 캡처가 거짓이 된다.
    if (!painted) throw new Error("상단 밴드를 못 찾았다 — 테마 캡처 중단(구조가 바뀌었는지 확인)");
    console.log("  (테마 주입: kakao · 밴드 페인트 확인)");
  }

  const tabBtn = (l) => page.locator("button").filter({ hasText: new RegExp(`^${l}$`) }).last();
  const shots = [["home", "홈"], ["routes", "노선"], ["notices", "공지"], ["scan", "탑승"], ["settings", "설정"]];
  for (const [file, label] of shots) {
    if (file !== "home") {
      await tabBtn(label).click({ timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2600);
    }
    await page.screenshot({ path: path.join(OUT, `${file}.png`) });
    console.log(`  캡처 ${file}.png`);
  }
  console.log(`\n출력: ${OUT}`);
  await ctx.close();
  await cleanup();
  process.exit(0);
})().catch(async (e) => { console.error("실패:", e.message || e); await cleanup(); process.exit(1); });
