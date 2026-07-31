// 길안내 지도 회전 실증 (읽기 전용) — 2026-07-31.
//   node scripts/headless_check_navguide.cjs
//
// 확인 대상은 **위험한 것 하나**다: 지도 판을 CSS 로 돌렸을 때
//   ① 타일이 정상 렌더되는가(회전 후 빈 화면·잘림 없음)
//   ② 카카오 로고·축척 표시가 **여전히 보이고 세워져 있는가**(가리면 이용약관 위반)
//   ③ 표시물(정류장 번호)이 판과 같이 기울지 않는가
// DriverNavGuide 는 컴포넌트라 직접 못 띄우므로 같은 구조를 재현해 검증하고,
// 소스에 그 구조가 남아 있는지는 scripts/test_nav_guide.cjs 의 회귀 가드가 본다.
//
// 사전 조건: localhost:3000 에 buslink 가 떠 있어야 한다(카카오 도메인 등록 통과용).
//   없으면  npx serve -s build -l 3000  또는  npm start
const path = require("path");
const fs = require("fs");
const os = require("os");
const ROOT = path.join(__dirname, "..");
const { chromium } = require(path.join(ROOT, "docs", "manual", "node_modules", "playwright-core"));

const env = fs.readFileSync(path.join(ROOT, ".env.local"), "utf8");
const KEY = (env.match(/^REACT_APP_KAKAO_MAP_KEY=(.+)$/m) || [])[1].trim();
const OUT = path.join(os.tmpdir(), "buslink-navguide");
fs.mkdirSync(OUT, { recursive: true });

const page_html = (rotDeg) => `<!doctype html><html><head><meta charset="utf-8">
<script src="//dapi.kakao.com/v2/maps/sdk.js?appkey=${KEY}&autoload=false"></script>
<style>body{margin:0;font-family:sans-serif;background:#fff}
#clip{position:relative;width:390px;height:520px;overflow:hidden;background:#eef1f6}
#stage{position:absolute;left:50%;top:50%;transform-origin:50% 50%}
.chip{position:absolute;left:10px;top:10px;background:rgba(255,255,255,.93);border-radius:10px;padding:7px 11px;z-index:4}
</style></head><body>
<div id="clip"><div id="stage"><div id="map" style="width:100%;height:100%"></div></div>
<div class="chip">다음 · 판교역 · 400m</div></div>
<script>
var ROT = ${rotDeg};
var clip = document.getElementById('clip'), stage = document.getElementById('stage');
var r = clip.getBoundingClientRect();
var size = ROT ? Math.ceil(Math.hypot(r.width, r.height)) : 0;
stage.style.width = size ? size + 'px' : '100%';
stage.style.height = size ? size + 'px' : '100%';
stage.style.transform = 'translate(-50%,-50%) rotate(' + ROT + 'deg)';
kakao.maps.load(function(){
  var m = new kakao.maps.Map(document.getElementById('map'), {center:new kakao.maps.LatLng(37.3948,127.1112), level:3});
  // 정류장 번호 마커 — 판이 돌아도 세워 둔다(반대 회전)
  var ov = new kakao.maps.CustomOverlay({
    position: new kakao.maps.LatLng(37.3948,127.1112),
    content: '<div id="stopbadge" style="width:24px;height:24px;border-radius:12px;background:#0066FF;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:11px;transform:rotate(' + (-ROT) + 'deg)">3</div>',
    yAnchor: 0.5,
  });
  ov.setMap(m);
  // ── 검증 대상: 로고·축척을 회전 밖으로 옮겨 세운다 ──
  setTimeout(function(){
    var node = stage.firstElementChild;
    var link = node && node.querySelector('a[href*="map.kakao.com"]');
    if (link) {
      var box = link;
      while (box.parentElement && box.parentElement !== node) box = box.parentElement;
      if (box.parentElement === node) {
        box.style.position='absolute'; box.style.left='6px'; box.style.right='auto';
        box.style.top='auto'; box.style.bottom='4px'; box.style.zIndex='3';
        clip.appendChild(box);
        window.__lifted = true;
      }
    }
    m.relayout();
    setTimeout(function(){ window.__ready = true; }, 1200);
  }, 600);
});
</script></body></html>`;

(async () => {
  const browser = await chromium.launch({
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: true,
  });
  let bad = 0;
  for (const rot of [0, -40, -140]) {
    const page = await browser.newPage({ viewport: { width: 420, height: 620 } });
    const errs = [];
    page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
    page.on("pageerror", (e) => errs.push(String(e)));
    await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded" });
    await page.setContent(page_html(rot), { waitUntil: "networkidle" });
    try { await page.waitForFunction("window.__ready === true", { timeout: 20000 }); }
    catch { console.log(`  ⚠ rot=${rot}: 지도 준비 대기 실패`); bad++; }

    const r = await page.evaluate(() => {
      const clip = document.getElementById("clip");
      const cb = clip.getBoundingClientRect();
      const link = document.querySelector('a[href*="map.kakao.com"]');
      const badge = document.getElementById("stopbadge");
      const imgs = document.querySelectorAll("#map img");
      let tiles = 0;
      imgs.forEach((im) => { if (im.naturalWidth > 0) tiles++; });
      const box = link ? link.getBoundingClientRect() : null;
      // 화면상 실제 기울기 = 누적 변환 행렬에서 각도 추출
      const angleOf = (el) => {
        if (!el) return null;
        const m = new DOMMatrix(getComputedStyle(el).transform);
        // 부모 누적까지 보려면 getBoundingClientRect 로는 부족 → 조상 transform 을 곱한다
        let cur = el.parentElement, acc = m;
        while (cur && cur !== document.body) {
          const t = getComputedStyle(cur).transform;
          if (t && t !== "none") acc = new DOMMatrix(t).multiply(acc);
          cur = cur.parentElement;
        }
        return Math.round(Math.atan2(acc.b, acc.a) * 180 / Math.PI);
      };
      return {
        lifted: !!window.__lifted,
        tiles,
        logoVisible: !!(box && box.width > 0 && box.left >= cb.left - 1 && box.right <= cb.right + 1 &&
          box.top >= cb.top - 1 && box.bottom <= cb.bottom + 1),
        logoAngle: angleOf(link),
        badgeAngle: angleOf(badge),
        logoInClip: !!(link && clip.contains(link) && !document.getElementById("map").contains(link)),
      };
    });

    const png = path.join(OUT, `navguide-rot${rot}.png`);
    await page.screenshot({ path: png });
    const okTiles = r.tiles >= 4;
    const okLogo = r.logoVisible && Math.abs(r.logoAngle || 0) <= 1;
    const okBadge = Math.abs(r.badgeAngle || 0) <= 1;
    if (!okTiles || !okLogo || !okBadge || errs.length) bad++;
    console.log(`rot=${String(rot).padStart(4)}°  타일 ${String(r.tiles).padStart(2)}장 ${okTiles ? "✅" : "❌"} · ` +
      `로고 ${r.logoInClip ? "밖으로옮김" : "지도안"} 보임=${r.logoVisible} 기울기=${r.logoAngle}° ${okLogo ? "✅" : "❌"} · ` +
      `정류장번호 기울기=${r.badgeAngle}° ${okBadge ? "✅" : "❌"}` + (errs.length ? ` · 콘솔오류 ${errs.length}` : ""));
    if (errs.length) console.log("   ", errs.slice(0, 3));
    await page.close();
  }
  await browser.close();
  console.log(`\n스크린샷: ${OUT}`);
  console.log(bad ? `❌ 확인 필요 ${bad}건` : "✅ 회전 후에도 타일·로고·표시물 모두 정상");
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
