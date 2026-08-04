// 진척 요약바 "현재 위치" 마커 기하 검증 (2026-08-04 배시현 개선요청 8E6U4bwr5rSJyMRxvsEN)
//
// 무엇을 막는 테스트인가:
//   `buspulse` 키프레임은 transform(scale) 을 애니메이션한다. 그래서 같은 요소의 인라인
//   transform(translate 로 중앙 맞추기)은 **애니메이션이 도는 내내 통째로 무시**되고,
//   링이 점의 오른쪽 아래로 (width/2, height/2) 만큼 밀린다. 눈에는 "하이라이트가 아래로
//   내려가 있다"로 보인다. 2026-07-13 에 넣은 -4px 도 링에는 적용된 적이 없었다.
//
// 검증 방식(추측 금지):
//   ① EmployeeApp.js **소스에서** 링·점의 style 객체를 그대로 뽑아
//   ② tokens.css 의 실제 keyframes 와 함께 헤드리스 크롬에 렌더해
//   ③ 링 중심과 점 중심이 실제로 겹치는지 픽셀로 잰다.
//   ④ 옛 코드(transform 버전)를 같은 잣대로 재서 **그때는 어긋났음**을 단언(재현).
//   ⑤ 전 소스 스윕 — transform 을 애니메이션하는 키프레임과 인라인 transform 을
//      한 style 객체에 같이 쓴 곳이 또 있는지.
//
// 실행: node scripts/test_progress_marker.cjs
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const { chromium } = require(path.join(ROOT, "docs", "manual", "node_modules", "playwright-core"));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

let pass = 0;
const fails = [];
const ok = (cond, name, extra) => { if (cond) { pass++; } else { fails.push(name + (extra ? ` — ${extra}` : "")); } };

// ── 소스에서 style 객체 뽑기 ────────────────────────────────────────────────
// `style={{ ... }}` 의 균형 잡힌 본문을 문자열로. (문자열 안의 중괄호는 무시)
function styleObjectsIn(src) {
  const out = [];
  let i = 0;
  while ((i = src.indexOf("style={{", i)) !== -1) {
    const start = i + "style={".length; // 바깥 { 부터 = 객체 리터럴 시작
    let depth = 0, j = start, quote = null;
    for (; j < src.length; j++) {
      const c = src[j];
      if (quote) { if (c === "\\") j++; else if (c === quote) quote = null; continue; }
      if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) { j++; break; } }
    }
    out.push({ text: src.slice(start, j), index: start, line: src.slice(0, start).split("\n").length });
    i = j;
  }
  return out;
}

// 스텁 변수로 평가 — 소스의 조건식(n.current 등)을 "현재 노드" 상태로 확정한다.
function evalStyle(text) {
  const fn = new Function("n", "isReached", "j", "nodes", "leftOn", "rightOn", "nameColor", `return (${text});`);
  return fn({ current: true }, true, 0, [{}, {}], true, true, "#000");
}
const cssText = (o) => Object.entries(o)
  .filter(([, v]) => v !== undefined && v !== null)
  .map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}:${typeof v === "number" ? v + "px" : v}`)
  .join(";");

const employee = fs.readFileSync(path.join(ROOT, "src", "pages", "EmployeeApp.js"), "utf8");
const tokens = fs.readFileSync(path.join(ROOT, "src", "styles", "tokens.css"), "utf8");

// 요약 진척바의 링·점 = "4노드 가로 진척" 블록 안 buspulse 링과 그 바로 뒤 점
const barAt = employee.indexOf("4노드 가로 진척");
ok(barAt > 0, "요약 진척바 블록을 소스에서 찾음");
const objs = styleObjectsIn(employee).filter((o) => o.index > barAt && o.index < barAt + 6000);
const ringObj = objs.find((o) => /animation:\s*'buspulse/.test(o.text));
const dotObj = objs.find((o) => /boxShadow:\s*n\.current/.test(o.text));
ok(!!ringObj, "현재 마커(링) style 객체 추출");
ok(!!dotObj, "현재 마커(점) style 객체 추출");
if (!ringObj || !dotObj) { report(); process.exit(1); }

// ── 회귀 가드(소스 단언) ───────────────────────────────────────────────────
ok(!/transform:/.test(ringObj.text), "링 style 에 transform 없음(버스펄스가 덮어씀)", ringObj.text.match(/transform:[^,]*/)?.[0]);
ok(/left:\s*'calc\(50% - 11px\)'/.test(ringObj.text), "링 가로 중앙 = left calc(50% - 11px)");
ok(/top:\s*'calc\(50% - 15px\)'/.test(ringObj.text), "링 세로 = top calc(50% - 15px)  (중앙 −11 · 위로 −4)");
ok(/translateY\(-4px\)/.test(dotObj.text), "점은 -4px 유지(애니메이션 없어 transform 안전)");
ok(/@keyframes\s+buspulse[^}]*}[^}]*transform:/s.test(tokens) || /buspulse[\s\S]{0,200}transform:/.test(tokens),
  "buspulse 가 여전히 transform 을 애니메이션(이 규칙의 전제)");

// ── 전 소스 스윕: transform 애니메이션 + 인라인 transform 동거 금지 ────────
const kfTransform = new Set();
for (const m of tokens.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\}/g)) {
  if (/transform:/.test(m[2])) kfTransform.add(m[1]);
}
ok(kfTransform.has("buspulse") && kfTransform.has("blpulse"), "transform 애니메이션 키프레임 목록 파악", [...kfTransform].join(","));
const srcDir = path.join(ROOT, "src");
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(d, e.name)) : (/\.jsx?$/.test(e.name) ? [path.join(d, e.name)] : []));
const clashes = [];
for (const f of walk(srcDir)) {
  const s = fs.readFileSync(f, "utf8");
  for (const o of styleObjectsIn(s)) {
    const anim = o.text.match(/animation:\s*[`'"]\s*([\w-]+)/);
    if (!anim || !kfTransform.has(anim[1])) continue;
    if (/transform:/.test(o.text)) clashes.push(`${path.relative(ROOT, f)}:${o.line} (${anim[1]})`);
  }
}
ok(clashes.length === 0, "transform 애니메이션과 인라인 transform 을 같이 쓴 곳 없음", clashes.join(" · "));

// ── 실제 렌더 측정(헤드리스 크롬) ──────────────────────────────────────────
const OLD_RING = "position:absolute;left:50%;top:50%;width:22px;height:22px;transform:translate(-50%,calc(-50% - 4px));border-radius:50%;background:#0066FF;opacity:.45;animation:buspulse 2s ease-out infinite";
const keyframes = (tokens.match(/@keyframes\s+buspulse\s*\{[\s\S]*?\n\}/) || [""])[0];

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: 400, height: 200 } });
  const ringCss = cssText(evalStyle(ringObj.text));
  const dotCss = cssText(evalStyle(dotObj.text));
  const row = "position:relative;width:200px;height:24px;display:flex;align-items:center;justify-content:center";
  await page.setContent(`<style>${keyframes}</style><body style="margin:0">
    <div id="row" style="${row}"><span id="ring" style="${ringCss}"></span><span id="dot" style="${dotCss}"></span></div>
    <div id="rowOld" style="${row}"><span id="ringOld" style="${OLD_RING}"></span><span id="dotOld" style="${dotCss}"></span></div>
  </body>`);

  const measure = () => page.evaluate(() => {
    const c = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
    const row = document.getElementById("row").getBoundingClientRect();
    return { ring: c("ring"), dot: c("dot"), ringOld: c("ringOld"), dotOld: c("dotOld"), rowMidY: row.y + row.height / 2 };
  });

  // 애니메이션이 도는 두 시점에서 재서 "겹침"이 우연이 아님을 확인
  for (const waitMs of [0, 700]) {
    if (waitMs) await page.waitForTimeout(waitMs);
    const m = await measure();
    ok(Math.abs(m.ring.x - m.dot.x) < 0.75, `링·점 가로 중심 일치(t=${waitMs}ms)`, `dx=${(m.ring.x - m.dot.x).toFixed(2)}px`);
    ok(Math.abs(m.ring.y - m.dot.y) < 0.75, `링·점 세로 중심 일치(t=${waitMs}ms)`, `dy=${(m.ring.y - m.dot.y).toFixed(2)}px`);
    ok(Math.abs((m.rowMidY - m.dot.y) - 4) < 0.75, `점이 연결선보다 4px 위(t=${waitMs}ms)`, `Δ=${(m.rowMidY - m.dot.y).toFixed(2)}px`);
    // 재현: 옛 코드(transform 버전)는 링이 점보다 오른쪽·아래로 밀렸다
    if (!waitMs) {
      ok(m.ringOld.x - m.dotOld.x > 8, "옛 코드 재현 — 링이 오른쪽으로 밀림", `dx=${(m.ringOld.x - m.dotOld.x).toFixed(2)}px`);
      ok(m.ringOld.y - m.dotOld.y > 8, "옛 코드 재현 — 링이 아래로 밀림(신고 증상)", `dy=${(m.ringOld.y - m.dotOld.y).toFixed(2)}px`);
    }
  }
  await browser.close();
  report();
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

function report() {
  console.log(`\n통과 ${pass} / 실패 ${fails.length}`);
  fails.forEach((f) => console.log(`  ❌ ${f}`));
  if (!fails.length) console.log("  ✅ 모두 통과");
}
