// 승객앱 가독성 — 작은 글자 바닥값 올리기 (2026-10-01 way «DYOPS 왼쪽 메뉴 가독성처럼 전체 조정»)
//   node scripts/bump_passenger_font_floor.cjs           # dry-run: 바뀔 개수만
//   node scripts/bump_passenger_font_floor.cjs --apply
// 규칙(DYOPS 42bded9 의 xs 11→13 · sm 12.5→14.5 · base 14→15.5 와 같은 결):
//   10·10.5→12 · 11→12.5 · 11.5→13 · 12→13.5 · 12.5→14 · 13→14.5 · 14→15 · 14.5→15.5 · 그 외 그대로
// 🔴 제외: <CustomOverlayMap>…</CustomOverlayMap> 안(지도 위 버스 마커·정류장 라벨 — 키우면 지도를 가린다.
//    2026-08-18 «아이콘이 너무 크다» 로 줄인 자리) · fontSize 가 아닌 숫자.
// 🔴 멱등이 아니다 — 두 번 돌리면 두 번 커진다. 한 번만 돌리고 커밋한다(파일 머리 표식으로 막는다).
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
// 인자로 파일을 주면 그 파일만(2026-10-01 관리자 콘솔 2차: `-- src/pages/AdminApp.js`).
const argFiles = process.argv.slice(2).filter((a) => a.startsWith("src/"));
const FILES = argFiles.length ? argFiles
  : ["src/pages/EmployeeApp.js", "src/components/HelpSheet.js", "src/components/PermissionGate.js", "src/components/InstallPrompt.js"];
const MAP = { "10": "12", "10.5": "12", "11": "12.5", "11.5": "13", "12": "13.5", "12.5": "14", "13": "14.5", "14": "15", "14.5": "15.5" };
const MARK = "/* font-floor-2026-10-01 */";
const apply = process.argv.includes("--apply");
let total = 0;
for (const f of FILES) {
  const p = path.join(ROOT, f);
  const src = fs.readFileSync(p, "utf8");
  if (src.includes(MARK)) { console.log(`${f}: 이미 적용됨 — 건너뜀`); continue; }
  const lines = src.split("\n");
  let inOverlay = 0, n = 0;
  const out = lines.map((line) => {
    const opens = (line.match(/<CustomOverlayMap\b/g) || []).length;
    const closes = (line.match(/<\/CustomOverlayMap>/g) || []).length;
    const wasIn = inOverlay > 0 || opens > 0;
    inOverlay += opens;
    let res = line;
    if (!wasIn) {
      // fontSize: <값식> — 쉼표·닫는 중괄호 전까지의 숫자 리터럴만 바꾼다(삼항식 양쪽 포함)
      res = line.replace(/fontSize:\s*([^,}]+)/g, (m, expr) => {
        const e2 = expr.replace(/(?<![\w.])(\d+(?:\.\d+)?)(?![\w.%])/g, (num) => {
          if (MAP[num]) { n++; return MAP[num]; }
          return num;
        });
        return m.replace(expr, e2);
      });
    }
    inOverlay -= closes;
    if (inOverlay < 0) inOverlay = 0;
    return res;
  });
  console.log(`${f}: ${n}곳`);
  total += n;
  if (apply && n) fs.writeFileSync(p, MARK + "\n" + out.join("\n"));
}
console.log(`합계 ${total}곳${apply ? " 반영" : " (dry-run)"}`);
