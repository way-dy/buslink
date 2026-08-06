// 문의 위젯 앱 내 임베드 실증 (2026-08-06)
//   node scripts/headless_check_inquiry_embed.cjs [tenantId]
//
// 배선만 보고 "임베드된다"고 말하지 않는다 — **실제 iframe 안이 그려지는지**를 본다.
// 임베드 차단은 헤더(X-Frame-Options / CSP frame-ancestors)로 조용히 일어나고,
// 그때 승객이 보는 건 빈 흰 화면뿐이라 "문의가 안 돼요" 로만 신고된다.
//
// 서버 불요(dycs 위젯 prod 를 직접 태운다). 결과 캡처는 콘솔에 경로로 출력.
const path = require("path");
const os = require("os");
const fs = require("fs");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const TENANT = process.argv[2] || "snu";
const WIDGET = `https://dycs-widget.web.app/?tenant=${encodeURIComponent(TENANT)}`;

(async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "buslink-inquiry-"));
  const host = path.join(outDir, "host.html");
  // 승객앱의 문의 탭과 같은 모양 — 상단 헤더 + 남은 높이 전부 iframe.
  fs.writeFileSync(host, `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;height:100%}#wrap{display:flex;flex-direction:column;height:100%}
#hd{flex:0 0 auto;padding:8px 12px;border-bottom:1px solid #E5E8EF;font:700 13px sans-serif}
iframe{flex:1;width:100%;border:none;display:block}</style>
<div id="wrap"><div id="hd">문의 · 분실물 접수</div>
<iframe src="${WIDGET}" title="문의 접수"></iframe></div>`);

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  console.log(`\n대상 위젯: ${WIDGET}`);
  await page.goto("file:///" + host.replace(/\\/g, "/"), { waitUntil: "load" });

  // 프레임이 실제로 붙고 그 안이 그려지는지 — 최대 20초.
  let frame = null, text = "", ok = false;
  for (let i = 0; i < 40; i++) {
    frame = page.frames().find((f) => f !== page.mainFrame() && /dycs-widget/.test(f.url()));
    if (frame) {
      try {
        text = (await frame.evaluate(() => document.body ? document.body.innerText : "")) || "";
        // "불러오는 중…" 만 잡고 통과시키면 **로딩 스피너를 성공으로 세는** 하네스가 된다
        //   (거래처 조회가 실패해도 그 화면은 똑같이 나온다) → 실제 내용이 올 때까지 기다린다.
        if (text.trim().length > 0 && !/^불러오는 중/.test(text.trim())) { ok = true; break; }
      } catch (_) { /* 아직 로드 중 */ }
    }
    await page.waitForTimeout(500);
  }

  const shot = path.join(outDir, `inquiry-${TENANT}.png`);
  await page.screenshot({ path: shot });

  console.log(`\n프레임 부착      : ${frame ? "예 (" + frame.url() + ")" : "🔴 아니오 — 임베드가 차단됐을 수 있습니다"}`);
  console.log(`프레임 내부 렌더 : ${ok ? "예" : "🔴 아니오 (빈 화면)"}`);
  if (ok) {
    const head = text.trim().split("\n").filter(Boolean).slice(0, 6).join(" / ");
    console.log(`본문 앞부분      : ${head}`);
  }
  console.log(`콘솔 오류        : ${errors.length}건`);
  errors.slice(0, 5).forEach((e) => console.log(`   - ${e.slice(0, 160)}`));
  console.log(`\n캡처: ${shot}`);

  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("🔴", e.message); process.exit(1); });
