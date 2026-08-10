// 가려진 전역 생성자 사용 검사 (2026-08-10 신설) — `node scripts/test_shadowed_globals.cjs`
//
// 🔴 왜 스크립트인가: 이 함정은 `.claude/issues-patterns.md` 에 **이미 세 번**(2026-05-21·05-26·07-09)
//    기록돼 있었는데 2026-08-10 에 **네 번째로 재발**했다. "grep 으로 점검할 것"이라고 적어 두는
//    방식은 지켜지지 않는다 — 검사기로 옮긴다([[enforce-repeated-rule-in-tooling]]).
//
// 무엇을 잡나:
//    `import { Map, MapMarker, ... } from "react-kakao-maps-sdk"` 처럼 **내장 전역과 같은 이름**을
//    바인딩한 파일 안에서 `new Map()` 을 쓰면, 번들 후 그 이름은 forwardRef 객체(비-생성자)라
//    런타임에 `X is not a constructor` 로 **컴포넌트가 통째로 죽는다.**
//    ⚠ `npm run build` 도 `node --check` 도 못 잡는다(구문은 유효하다). 그래서 이 검사가 필요하다.
//
// 해법 = `new window.Map()` 또는 import 에서 별칭(`Map as KakaoMap`).
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src");
// 내장 전역 중 라이브러리가 같은 이름으로 export 할 만한 것들
const GLOBALS = ["Map", "Set", "Promise", "Date", "Image", "Text", "Event", "Node", "Range", "Element"];

function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.jsx?$/.test(f)) out.push(p);
  }
  return out;
}

/**
 * 소스 한 벌을 검사해 위반 목록을 돌려준다(파일 IO 없음 — 양성 대조에 그대로 재사용).
 * @returns [{ name, line, text }]
 */
function findViolations(src) {
  // ① 이 파일이 바인딩한 이름 수집 — `import { Map, X } from "..."`.
  //    `Map as KakaoMap` 은 로컬 이름이 KakaoMap 이므로 가려지지 않는다(안전).
  const bound = new Set();
  const importRe = /import\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g;
  let m;
  while ((m = importRe.exec(src)) !== null) {
    m[1].split(",").forEach((part) => {
      const t = part.trim();
      if (!t) return;
      const asIdx = t.split(/\s+as\s+/);
      const local = (asIdx.length > 1 ? asIdx[1] : asIdx[0]).trim();
      if (GLOBALS.includes(local)) bound.add(local);
    });
  }
  // default import 도 같은 위험(`import Map from "..."`)
  const defRe = /import\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/g;
  while ((m = defRe.exec(src)) !== null) {
    if (GLOBALS.includes(m[1])) bound.add(m[1]);
  }
  if (bound.size === 0) return [];

  // ② 그 이름을 `new X(` 로 부르는 곳 — `new window.X(` 는 안전, 주석 줄은 제외
  const out = [];
  const lines = src.split(/\r?\n/);
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "");        // 줄 주석 제거
    if (/^\s*\*/.test(line)) return;                  // 블록 주석 본문
    for (const name of bound) {
      const re = new RegExp(`new\\s+${name}\\s*\\(`);
      if (re.test(code) && !new RegExp(`new\\s+(window|globalThis)\\.${name}`).test(code)) {
        out.push({ name, line: i + 1, text: line.trim().slice(0, 110) });
      }
    }
  });
  return out;
}

// ── 🔴 양성 대조 — 이 검사가 실제로 신호를 잡는지 먼저 증명한다.
//    (안 하면 "위반 0건"이 '깨끗하다'인지 '검사가 죽었다'인지 구분이 안 된다.)
const POSITIVE = `
import { Map, MapMarker } from "react-kakao-maps-sdk";
const orderById = new Map(rows.map((r, i) => [r.id, i]));
`;
const NEGATIVE = `
import { Map as KakaoMap, MapMarker } from "react-kakao-maps-sdk";
const a = new Map();
const b = new window.Map();
`;
const posHits = findViolations(POSITIVE);
const negHits = findViolations(NEGATIVE);
if (posHits.length !== 1) {
  console.error(`❌ 자체검사 실패 — 양성 대조에서 위반 1건이 나와야 하는데 ${posHits.length}건. 검사기가 고장났다.`);
  process.exit(2);
}
if (negHits.length !== 0) {
  console.error(`❌ 자체검사 실패 — 별칭/window 경로를 위반으로 잘못 잡았다(${negHits.length}건).`);
  process.exit(2);
}

const files = walk(SRC);
let total = 0;
const bad = [];
for (const f of files) {
  const v = findViolations(fs.readFileSync(f, "utf8"));
  total++;
  v.forEach((x) => bad.push({ file: path.relative(path.join(__dirname, ".."), f), ...x }));
}

console.log(`\n가려진 전역 생성자 검사 — 파일 ${total}개 (자체검사 통과: 양성 1 / 오탐 0)`);
if (bad.length === 0) {
  console.log("✅ 위반 0건");
  process.exit(0);
}
console.log(`\n🔴 위반 ${bad.length}건 — 이 줄은 런타임에 "X is not a constructor" 로 화면을 죽인다:`);
bad.forEach((b) => console.log(`   ${b.file}:${b.line}  [${b.name}]  ${b.text}`));
console.log(`\n고치는 법: \`new window.${bad[0].name}()\` 또는 import 에서 별칭(\`${bad[0].name} as Kakao${bad[0].name}\`).`);
process.exit(1);
