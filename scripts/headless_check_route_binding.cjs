// 승객앱 홈 — 보던 노선·내 정류장이 **탭 전환 후에도 유지되는가** (2026-09-01 조수빈 클레임).
//   node scripts/headless_check_route_binding.cjs
//   BASE=http://localhost:3000 node scripts/headless_check_route_binding.cjs
//
// 🔴 **옛 번들 대조군은 불가능하다**(2026-09-01 실측): Firebase Hosting 은 **현재 릴리스의
//    파일만** 서빙하고 없는 경로는 SPA rewrite 로 index.html 을 돌려준다 — 옛 `main.*.js` 를
//    요청하면 HTML 이 와서 `Unexpected token '<'` 로 죽는다(`/static/**` immutable 은 브라우저
//    캐시 이야기지 서버 보존이 아니다). 그래서 대조군을 쓰려면 **옛 코드를 로컬에 빌드해**
//    `BASE=http://localhost:3000` 으로 태워야 한다.
//
// 대조군 없이도 공허하지 않게 만드는 장치 = **옛 빌드에서는 성립할 수 없는 것**을 단언한다:
//   옛 코드에서 `session.routeId` 를 쓰는 곳은 «노선 변경» 모달(`chooseRoute`) 하나뿐이고,
//   즐겨찾기 자동 정착은 화면 state 만 바꿨다. 따라서 **모달을 열지 않았는데 세션이
//   배정값(갈현동)에서 즐겨찾기(광명)로 바뀌어 있다면 새 코드가 돈 것**이다.
//
// 대상 = 검토용 계정 `REVIEW`(신촌세브란스·PIN 112233). 🔴 **실제 사람 계정을 쓰지 않는다.**
//    신고자 모양으로 잠깐 맞췄다가 **끝나면 원복**한다(finally).
const fs = require("fs");
const path = require("path");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const CHROME = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const BASE = process.env.BASE || "https://p.buslink.co.kr";
const ROOT = path.join(__dirname, "..");
const COMPANY = "dy001";
const EMP = "REVIEW", PIN = "112233";
const GAL = "zQTlZxNdZzue5n4HkXb1";                                 // 07:19 갈현동(신촌세브란스 일괄 배정값)
const KM1 = "lDoCRWKIdl3REhy3CBh2", KM2 = "RBC64A7GtL1TRnXSySLk";   // 06:48 / 18:00 광명

const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
const sa = require(path.join(ROOT, "key", kf));
if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치: " + sa.project_id);
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const pRef = db.collection("companies").doc(COMPANY).collection("passengers").doc(EMP);
const tRef = db.collection("companies").doc(COMPANY).collection("fcmTokens").doc(EMP);

let fail = 0;
const ok = (n, c, x) => { console.log(`  ${c ? "✅" : "❌"} ${n}${!c && x !== undefined ? " → " + JSON.stringify(x) : ""}`); if (!c) fail++; };

async function closeOverlays(page) {
  for (const label of ["확인했습니다", "나중에", "✕"]) {
    for (let i = 0; i < 4; i++) {
      const b = page.locator(`button:has-text("${label}")`).first();
      if (await b.count() && await b.isVisible().catch(() => false)) {
        await b.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(400);
      } else break;
    }
  }
}

const readState = (page) => page.evaluate(() => {
  let s = null;
  try { s = JSON.parse(localStorage.getItem("buslink_employee") || "null"); } catch { /* */ }
  const strip = document.querySelector("[data-route-strip]");
  return {
    sessionRouteId: s ? s.routeId || null : null,
    routePinned: s ? !!s.routePinned : false,
    text: document.body.innerText.replace(/\s+/g, " "),
    stripText: strip ? strip.innerText.replace(/\s+/g, " ") : null,
    myStopMark: /내 정류장/.test(document.body.innerText),
  };
});

(async () => {
  const snap = await pRef.get();
  if (!snap.exists) { console.error("❌ REVIEW 계정 없음"); process.exit(1); }
  const o = snap.data();
  const backup = { routeId: o.routeId ?? null, favorites: o.favorites ?? [] };
  console.log("REVIEW 원본 백업:", JSON.stringify(backup));

  let browser = null;
  try {
    await pRef.update({ routeId: GAL, favorites: [KM1, KM2] });
    await tRef.delete().catch(() => {});
    console.log("REVIEW → 신고자 모양: 배정=07:19 갈현동 · 즐겨찾기=06:48/18:00 광명\n");

    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errs = [];
    const ignorable = (t) => /kakao|dapi|favicon|manifest|Failed to load resource|net::ERR/i.test(t);
    page.on("pageerror", (e) => { if (!ignorable(e.message)) errs.push(e.message); });

    await page.goto(`${BASE}/p?c=${COMPANY}`, { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForTimeout(3000);
    const bundle = await page.evaluate(() =>
      ((document.querySelector('script[src*="/static/js/main."]') || {}).src || "").split("/").pop());
    console.log(`[0] 번들 = ${bundle}`);

    console.log("\n[1] 로그인 — 신촌세브란스 검토용 계정");
    await page.fill('input[placeholder="사번"]', EMP);
    await page.fill('input[placeholder="PIN (4~6자리)"]', PIN);
    await page.click('button:has-text("로그인")');
    await page.waitForTimeout(7000);
    await closeOverlays(page);
    await page.waitForTimeout(2000);
    const s1 = await readState(page);
    ok("홈 진입", /탑승|노선/.test(s1.text), s1.text.slice(0, 70));
    // 🔴 신호 유무 — 노선도가 그려져야 이 뒤 판정이 성립한다.
    ok("노선도 스트립이 그려졌다(신호 유무)", !!s1.stripText && s1.stripText.length > 5, s1.stripText);

    console.log(`\n[2] 🔴 홈이 정착한 노선이 **세션에 남았는가** (= 스캐너가 보낼 값)`);
    console.log(`    세션 routeId = ${s1.sessionRouteId} · pinned = ${s1.routePinned}`);
    // 옛 코드는 «노선 변경» 모달을 열어야만 세션을 썼다. 모달을 안 열었는데 값이 바뀌었다 = 새 코드.
    ok("🔴 배정값(갈현동) → 즐겨찾기(광명)로 정착 · 옛 빌드에선 불가능한 결과",
      s1.sessionRouteId === KM1 || s1.sessionRouteId === KM2, s1.sessionRouteId);
    ok("자동 정착이라 pinned 는 안 찍힌다(즐겨찾기 바뀌면 따라가야 하므로)", s1.routePinned === false, s1.routePinned);

    console.log("\n[3] 내 정류장 지정");
    // 🔴 정류장은 `<button>` 이 아니라 `<div onClick>` 이다 — 태그로 찾으면 0개가 나오고
    //    그 뒤 단언이 전부 «비교할 값이 없어서» 조용히 통과한다(실제로 한 번 밟았다).
    //    그래서 **Firestore 에서 실제 정류장 이름을 받아 그 글자를 누른다**.
    const stopsSnap = await db.collection("companies").doc(COMPANY)
      .collection("routes").doc(s1.sessionRouteId).collection("stops").orderBy("order", "asc").get();
    const stopNames = stopsSnap.docs.map((d) => (d.data() || {}).name).filter(Boolean);
    ok("정착한 노선의 정류장을 Firestore 에서 받았다(신호 유무)", stopNames.length >= 2, stopNames.slice(0, 3));
    const target = stopNames[1] || stopNames[0];
    console.log(`    누를 정류장 = «${target}»`);
    await page.locator("[data-route-strip]").getByText(target, { exact: false }).first()
      .click({ timeout: 10000 }).catch((e) => console.log("    클릭 실패:", e.message.split("\n")[0]));
    await page.waitForTimeout(3500);
    const t1 = (await tRef.get()).data() || {};
    console.log(`    fcmTokens = routeId ${t1.routeId} · stopId ${t1.stopId}`);
    // 🔴 여기서 멈춘다 — stopId 가 없으면 뒤 단언은 undefined 끼리 비교해 거짓 통과한다.
    ok("내 정류장이 서버에 저장됐다(이게 없으면 뒤 판정 무의미)", typeof t1.stopId === "string" && t1.stopId.length > 0, t1);
    if (!t1.stopId) throw new Error("내 정류장 저장 실패 — 이후 판정 불가(거짓 통과 방지)");
    ok("저장된 노선 = 화면이 보던 노선", t1.routeId === s1.sessionRouteId, { saved: t1.routeId, screen: s1.sessionRouteId });

    console.log("\n[4] 🔴 탭 왕복(홈 → 탑승 → 홈) — 신고자가 «QR 버튼 누르면 풀린다» 던 그 경로");
    await page.click('button:has-text("탑승")').catch(() => {});
    await page.waitForTimeout(3000);
    const scanText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 80));
    ok("탑승 탭으로 이동했다(신호 유무)", /탑승|QR|카메라|스캔/.test(scanText), scanText);
    await page.click('button:has-text("홈")').catch(() => {});
    await page.waitForTimeout(4000);
    await closeOverlays(page);
    const s2 = await readState(page);
    console.log(`    복귀 후 세션 routeId = ${s2.sessionRouteId} · 내 정류장 표시 = ${s2.myStopMark}`);
    ok("🔴 보던 노선이 그대로다(예전엔 여기서 튕겼다)", s2.sessionRouteId === s1.sessionRouteId,
      { before: s1.sessionRouteId, after: s2.sessionRouteId });
    const t2 = (await tRef.get()).data() || {};
    ok("🔴 내 정류장이 서버에 그대로 남아 있다",
      typeof t2.stopId === "string" && t2.stopId === t1.stopId, { before: t1.stopId, after: t2.stopId });
    // 🔴 `/내 정류장/` 만 보면 안 된다 — 미선택 안내문이 "아래 노선도에서 **내 정류장**을
    //    클릭하세요" 라서 **정류장이 안 잡혀 있어도 통과**한다(실제로 거짓 통과했다).
    //    복원됐다면 그 안내문이 **사라지고** 하단 카드에 «정류장 변경» 버튼이 떠 있어야 한다.
    // 복원은 Firestore 왕복 2회(정류장 목록 → fcmTokens)라 즉시가 아니다 —
    // «안 된다»와 «아직»을 가르려고 최대 20초까지 지켜본다(걸린 시간도 찍는다).
    let restored = { prompt: true, changeBtn: false }, waited = 0;
    for (; waited <= 20000; waited += 1000) {
      restored = await page.evaluate(() => {
        const t = document.body.innerText;
        return { prompt: /내 정류장을 클릭하세요|내 탑승 정류장을 클릭/.test(t), changeBtn: /정류장 변경/.test(t) };
      });
      if (!restored.prompt && restored.changeBtn) break;
      await page.waitForTimeout(1000);
    }
    console.log(`    미선택 안내문 = ${restored.prompt} · «정류장 변경» 버튼 = ${restored.changeBtn} · 대기 ${waited}ms`);
    ok("🔴 화면이 내 정류장을 다시 그렸다(미선택 안내문이 사라졌다)", restored.prompt === false, restored);
    ok("🔴 내 정류장 카드가 떠 있다(«정류장 변경» 버튼)", restored.changeBtn === true, restored);

    console.log("\n[5] 스캐너가 서버에 보낼 노선");
    const send = await page.evaluate(() => {
      let s = null; try { s = JSON.parse(localStorage.getItem("buslink_employee") || "null"); } catch { /* */ }
      if (!s || !s.routeId) return null;
      if (s.routePinned) return s.routeId;
      return Array.isArray(s.favorites) && s.favorites.includes(s.routeId) ? s.routeId : null;
    });
    console.log(`    boardingRouteId → ${send}`);
    ok("화면이 보던 노선을 그대로 보낸다(= 「이 노선이 아니다」 안 남)", send === s2.sessionRouteId,
      { send, screen: s2.sessionRouteId });

    ok("페이지 오류 0", errs.length === 0, errs.slice(0, 3));
  } finally {
    if (browser) await browser.close().catch(() => {});
    await pRef.update({ routeId: backup.routeId, favorites: backup.favorites });
    await tRef.delete().catch(() => {});
    console.log("\n♻ REVIEW 원복 완료 + 검사로 생긴 내 정류장 삭제");
  }
  console.log(`\n${fail === 0 ? "✅ 전부 통과" : `❌ ${fail}건 실패`}`);
  process.exit(fail === 0 ? 0 : 1);
})();
