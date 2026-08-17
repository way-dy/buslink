// 실시간 관제 차량 마커가 **진짜 지도 위에서** 어떻게 보이는지 (2026-08-18 way 요청 반영판).
//   node scripts/headless_check_map_markers.cjs
//
// 관리자 콘솔은 로그인이 필요해 그 화면을 통째로 헤드리스로 못 띄운다. 그래서
//   ① 진짜 카카오 지도를 **승객앱(prod `/bus`)에서 실제로 렌더**해 배경으로 쓰고
//   ② 그 위에 차량 마커를 **AdminApp 소스에서 뽑은 값 그대로** 얹는다.
// 🔴 손으로 옮겨 적은 숫자로 그리면 "예쁜 그림"만 보고 통과한다 — 크기·색은 소스에서 파싱한다.
//
// 판정: ① 마커 블록이 소스에 실재(신호 유무) ② 아이콘이 좌표 중심에 온다(핀처럼 위로 뜨지 않음)
//       ③ 정보 칩이 아이콘을 가리지 않는다 ④ 칩 글자가 잘리지 않는다 ⑤ 콘솔 오류 0
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ROOT = path.join(__dirname, "..");
const OUT = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "buslink-mapmk-")), "markers.png");
const BASE = process.env.BASE || "https://p.buslink.co.kr";

const admin = fs.readFileSync(path.join(ROOT, "src/pages/AdminApp.js"), "utf8");

// ── AdminApp 마커 블록 파싱 ────────────────────────────────
const bStart = admin.indexOf("{/* 차량 마커 — 기본 핀 대신 버스 아이콘");
const bEnd = admin.indexOf("</CustomOverlayMap>", bStart);
if (bStart < 0 || bEnd < 0) { console.error("🔴 차량 마커 블록을 못 찾음(설계가 바뀌었나?)"); process.exit(1); }
const block = admin.slice(bStart, bEnd);
const pick = (re, label, dflt) => {
  const m = block.match(re);
  if (!m) { if (dflt !== undefined) return dflt; console.error("🔴 " + label + " 파싱 실패"); process.exit(1); }
  return m[1];
};
const dotSize = +pick(/width:(\d+), height:\d+, cursor/, "마커 지름");
const iconSize = +pick(/<Icon name="bus" size=\{(\d+)\}/, "버스 아이콘 크기");
const chipTop = +pick(/position:"absolute", top:(\d+), left:"50%"/, "칩 위치");
const chipFont = +pick(/borderRadius:7, fontSize:([\d.]+)/, "칩 글자");
const usesPulse = /animation:"buspulse/.test(block);
const usesBusIcon = /<Icon name="bus"/.test(block);
const anchorHalf = /yAnchor=\{0\.5\}/.test(block);
console.log(`\n소스에서 읽은 값 — 마커 ${dotSize}px · 버스 아이콘 ${iconSize}px · 칩 top ${chipTop}px · 칩 글자 ${chipFont}px` +
  ` · 펄스 ${usesPulse ? "있음" : "없음"} · yAnchor 0.5 ${anchorHalf ? "예" : "아니오"}`);

let fail = 0;
const ok = (n, c, x) => { if (c) console.log(`  ✅ ${n}`); else { fail++; console.log(`  ❌ ${n}${x !== undefined ? " — " + JSON.stringify(x) : ""}`); } };

console.log("\n[0] 신호 유무 — 검사 대상이 소스에 실재하는가");
ok("버스 아이콘 사용", usesBusIcon);
ok("좌표 중심 정렬(yAnchor 0.5)", anchorHalf);
ok("기본 핀(MapMarker)으로 되돌아가지 않음", !/\{\(selected \? vehicles[\s\S]{0,200}<MapMarker key=\{v\.id\}/.test(admin));

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = [];
  page.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
  await page.goto(BASE + "/bus", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(6000);
  // 노선 선택 화면이면 첫 노선을 눌러 지도까지 들어간다.
  const tiles = async () => page.locator('img[src*="daumcdn"], img[src*="kakao"]').count();
  // `/bus` 첫 화면은 노선 선택 목록이다 — 지도까지 들어가야 배경이 진짜 지도가 된다.
  for (let i = 0; i < 3 && (await tiles()) === 0; i++) {
    const card = page.getByText(/^(05:45 군포|과천라인|\[출근\]잠실노선)/).first();
    if (await card.count()) { await card.click({ timeout: 5000 }).catch(() => {}); }
    await page.waitForTimeout(4000);
  }
  const tileCount = await tiles();
  console.log("\n[1] 배경 — 진짜 카카오 지도인가");
  ok(`지도 타일 ${tileCount}장 렌더(0장이면 이 하네스 판정은 무의미)`, tileCount >= 4, tileCount);

  // ── 마커 3개를 지도 위 임의 지점에 얹는다(선택/미선택/신호지연) ──
  await page.evaluate(({ dotSize, iconSize, chipTop, chipFont }) => {
    const BUS = '<svg viewBox="0 0 24 24" width="' + iconSize + '" height="' + iconSize + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="12" rx="2.5"/><path d="M3 12h18"/><circle cx="8" cy="19" r="1.6"/><circle cx="16" cy="19" r="1.6"/></svg>';
    const mk = (x, y, plate, meta, on, stale) => {
      const tone = stale ? "#8A94A6" : "#0066FF";
      const el = document.createElement("div");
      el.className = "hcheck-marker";
      el.style.cssText = `position:fixed;left:${x}px;top:${y}px;transform:translate(-50%,-50%);z-index:99999;`;
      el.innerHTML =
        `<div data-mk style="position:relative;width:${dotSize}px;height:${dotSize}px;cursor:pointer">` +
          (stale ? "" : `<span style="position:absolute;inset:0;border-radius:50%;background:${tone};opacity:.45;animation:buspulse 2s ease-out infinite"></span>`) +
          `<div data-icon style="position:absolute;inset:0;background:${tone};border:3px solid #fff;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;box-shadow:${on ? "0 0 0 5px rgba(0,102,255,.28), 0 8px 24px rgba(16,24,40,.16)" : "0 8px 24px rgba(16,24,40,.16)"}">${BUS}</div>` +
          `<div style="position:absolute;top:${chipTop}px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:2px">` +
            `<div data-chip style="display:flex;align-items:center;gap:5px;white-space:nowrap;padding:2px 7px;border-radius:7px;font-size:${chipFont}px;line-height:1.3;background:${on ? tone : "rgba(255,255,255,.95)"};color:${on ? "#fff" : "#1B2430"};border:1px solid ${on ? tone : "#E3E8EF"};box-shadow:0 2px 8px rgba(16,24,40,.12)">` +
              `<span style="font-weight:700">${plate}</span><span style="font-weight:600;opacity:.75">${meta}</span></div>` +
            (on ? `<div data-sub style="max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:1px 6px;border-radius:6px;font-size:9.5px;font-weight:600;background:rgba(255,255,255,.95);color:#5A6472;border:1px solid #E3E8EF;box-shadow:0 2px 8px rgba(16,24,40,.12)">[한남1] 등교(월~수,금) · 장기환</div>` : "") +
          `</div>` +
        `</div>`;
      document.body.appendChild(el);
    };
    mk(420, 330, "경기79사9849", "0km/h", false, false);
    mk(700, 430, "서울72바6859", "42km/h", true, false);
    mk(960, 300, "경기76자3726", "12분 전", false, true);
  }, { dotSize, iconSize, chipTop, chipFont });
  await page.waitForTimeout(600);

  console.log("\n[2] 배치 — 아이콘이 좌표 위에 앉고 칩이 아이콘을 안 가리는가");
  const geo = await page.evaluate(() => [...document.querySelectorAll(".hcheck-marker")].map(el => {
    const icon = el.querySelector("[data-icon]").getBoundingClientRect();
    const chip = el.querySelector("[data-chip]");
    const c = chip.getBoundingClientRect();
    const sub = el.querySelector("[data-sub]");
    return {
      iconBottom: icon.bottom, chipTop: c.top, chipW: c.width, chipH: c.height,
      chipClipped: chip.scrollWidth > chip.clientWidth + 1 || chip.scrollHeight > chip.clientHeight + 1,
      subClipped: sub ? sub.scrollWidth > sub.clientWidth + 1 : false,
      anchorDy: (icon.top + icon.bottom) / 2 - parseFloat(el.style.top),
    };
  }));
  geo.forEach((g, i) => {
    ok(`#${i + 1} 칩이 아이콘 아래(겹침 0)`, g.chipTop >= g.iconBottom - 1, { chipTop: g.chipTop, iconBottom: g.iconBottom });
    ok(`#${i + 1} 칩 글자 잘림 없음`, !g.chipClipped);
    ok(`#${i + 1} 아이콘 중심이 좌표에 (오차 ${Math.abs(g.anchorDy).toFixed(1)}px)`, Math.abs(g.anchorDy) <= 1.5, g.anchorDy);
    ok(`#${i + 1} 칩 폭 ${Math.round(g.chipW)}px — 과하게 넓지 않음(≤170)`, g.chipW <= 170, g.chipW);
  });
  ok("선택 마커의 노선명 줄 잘림 없음", !geo[1].subClipped);

  console.log("\n[3] 콘솔 오류");
  const real = errs.filter(e => !/runtime\.lastError|favicon|ERR_BLOCKED/.test(e));
  ok(`오류 ${real.length}건`, real.length === 0, real.slice(0, 3));

  await page.screenshot({ path: OUT });
  console.log(`\n📸 ${OUT}`);
  await browser.close();
  console.log(fail === 0 ? "\n✅ 전부 통과" : `\n❌ ${fail}건 실패`);
  process.exit(fail === 0 ? 0 : 1);
})();
