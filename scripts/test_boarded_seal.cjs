// 탑승 완료 «살아있는 화면» 검증 — 2026-09-14 (게시판 JZxawmQF · 캡처 부정승차 대응).
//   node scripts/test_boarded_seal.cjs      · prod 접근 0 · 네트워크 0 · 쓰기 0
//
// 재는 것 3가지:
//   [1] 순수 로직 — 경과 표시(formatElapsed)
//   [2] 소스 가드 — 흐르는 시계·마운트 시각 1회·세 완료 화면 배선·멈춘 시각 재도입 금지
//   [3] 실렌더 — 컴포넌트를 소스 그대로 SSR 해 tokens.css 와 함께 크롬에 올리고
//       ⓐ 고리·띠·체크 애니메이션이 **실제로 돌고 있는지**(getAnimations playState)
//       ⓑ 0.6초 간격 두 장의 픽셀이 **다른지**(멈춘 화면=캡처와 구별 불가를 직접 잰다)
//       ⓒ 🔴 대조군: 애니메이션을 끈 같은 화면은 두 장이 **같아야** 한다(검사가 공허하지 않다는 증거)
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let fail = 0, n = 0;
const ok = (name, cond, got) => {
  n++; console.log(`  ${cond ? "✓" : "✗"} ${name}${!cond && got !== undefined ? " → " + JSON.stringify(got) : ""}`);
  if (!cond) fail++;
};

const SRC = read("src/components/BoardedSeal.js");
const babel = require(path.join(ROOT, "node_modules", "@babel", "core"));
const compiled = babel.transformSync(SRC, {
  babelrc: false, configFile: false, filename: "BoardedSeal.js",
  presets: [[path.join(ROOT, "node_modules", "@babel", "preset-react"), { runtime: "automatic" }]],
  plugins: [path.join(ROOT, "node_modules", "@babel", "plugin-transform-modules-commonjs")],
}).code;

function loadModule() {
  const mod = { exports: {} };
  vm.runInNewContext(compiled, { module: mod, exports: mod.exports, require: (id) => require(require.resolve(id, { paths: [ROOT] })), Date, Math, setInterval, clearInterval }, { filename: "BoardedSeal.js" });
  return mod.exports;
}

(async () => {
  const M = loadModule();

  console.log("\n[1] 경과 표시");
  ok("0초", M.formatElapsed(0) === "0초", M.formatElapsed(0));
  ok("59.9초 → 59초", M.formatElapsed(59.9) === "59초", M.formatElapsed(59.9));
  ok("60초 → 1분 0초", M.formatElapsed(60) === "1분 0초", M.formatElapsed(60));
  ok("3725초 → 1시간 2분", M.formatElapsed(3725) === "1시간 2분", M.formatElapsed(3725));
  ok("음수는 0초(시계 역행)", M.formatElapsed(-5) === "0초", M.formatElapsed(-5));

  console.log("\n[2] 소스 가드");
  ok("시계가 주기적으로 갱신된다(setInterval)", /setInterval\(\s*\(\)\s*=>\s*setNow\(Date\.now\(\)\)/.test(SRC));
  ok("탑승 시각은 마운트 때 한 번(useState 초기값)", /const \[boardedAt\] = useState\(\(\) => Date\.now\(\)\)/.test(SRC));
  ok("언마운트 시 타이머 정리", /clearInterval\(id\)/.test(SRC));
  ok("reduced-motion 으로 끄지 않는다", !/prefers-reduced-motion/.test(SRC.replace(/^\s*\/\/.*$/gm, "")));
  const css = read("src/styles/tokens.css");
  ["blsealspin", "blsealsweep", "blsealbeat"].forEach((k) => ok(`키프레임 ${k} 정의`, new RegExp(`@keyframes ${k}\\b`).test(css)));
  const emp = read("src/pages/EmployeeApp.js");
  const brd = read("src/pages/BoardingApp.js");
  ok("직원앱: 컴포넌트 import", /import BoardedSeal from "\.\.\/components\/BoardedSeal"/.test(emp));
  ok("직원앱: 완료 화면 2곳 모두 사용", (emp.match(/<BoardedSeal\b/g) || []).length === 2, (emp.match(/<BoardedSeal\b/g) || []).length);
  ok("고정 QR 화면: 사용", /<BoardedSeal\b/.test(brd));
  // 🔴 멈춘 시각 한 줄 재도입 금지 — 캡처와 같은 화면이 된다
  ok("직원앱 완료 화면에 렌더 시점 시각 한 줄이 없다", !/fontSize:12, color:"var\(--color-label-mute\)" \}\}>\{new Date\(\)\.toLocaleTimeString\("ko-KR"\)\}/.test(emp));
  // 🔴 애니메이션 요소에 인라인 transform 금지(키프레임이 덮어써 조용히 사라진다)
  const animLines = SRC.split("\n").filter((l) => /animation: "blseal/.test(l));
  ok("애니메이션 요소에 인라인 transform 없음", animLines.length === 3 && animLines.every((l) => !/transform:/.test(l)), animLines.length);

  console.log("\n[3] 실렌더 — 움직이는가");
  const React = require(require.resolve("react", { paths: [ROOT] }));
  const { renderToStaticMarkup } = require(require.resolve("react-dom/server", { paths: [ROOT] }));
  const html = renderToStaticMarkup(React.createElement(M.default, { title: "탑승 완료!" }));
  ok("SSR 에 시계·경과가 들어 있다", /data-seal-clock/.test(html) && /경과/.test(html));

  const { chromium } = require(path.join(ROOT, "docs", "manual", "node_modules", "playwright-core"));
  const browser = await chromium.launch();
  try {
    const shoot = async (extraCss) => {
      const page = await browser.newPage({ viewport: { width: 360, height: 420 } });
      await page.setContent(`<!doctype html><html><head><style>${css}\n${extraCss}</style></head><body style="margin:0;display:flex;justify-content:center">${html}</body></html>`);
      await page.waitForTimeout(300);
      const anims = await page.evaluate(() => document.getAnimations().map((a) => [a.animationName, a.playState]));
      const a = await page.screenshot();
      await page.waitForTimeout(600);
      const b = await page.screenshot();
      await page.close();
      return { anims, same: Buffer.compare(a, b) === 0 };
    };
    const live = await shoot("");
    const names = live.anims.filter(([, s]) => s === "running").map(([k]) => k);
    ["blsealspin", "blsealsweep", "blsealbeat"].forEach((k) => ok(`${k} 실행 중`, names.includes(k), names));
    ok("0.6초 간격 두 장이 다르다(캡처와 구별된다)", live.same === false);
    const frozen = await shoot("*{animation:none!important}");
    ok("대조군: 애니메이션을 끄면 두 장이 같다(검사가 공허하지 않다)", frozen.same === true);
  } finally { await browser.close(); }

  console.log(`\n${n - fail}/${n} 통과`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
