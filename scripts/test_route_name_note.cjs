// @requires-credentials — firebase-admin/운영 데이터가 있어야 돈다(기본 게이트 제외, --live 로 실행)
// 노선명 특이사항 꼬리표 가르기 격리 테스트 — 2026-08-25 최우석 "조기출근 진하게".
//   node scripts/test_route_name_note.cjs
// 🔴 판정식을 베끼지 않고 `src/lib/routeKind.js` 소스를 그대로 vm 에 태운다(재구현 0).
// 🔴 **prod 실값 112개 전수로도 태운다** — 합성 픽스처만으로는 `[H1-1]` 오탐을 못 잡는다.
//    (키가 없으면 prod 단계는 SKIP 하고 합성 단언만 돌린다.)
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = path.join(__dirname, "..");

function load() {
  const src = fs.readFileSync(path.join(ROOT, "src/lib/routeKind.js"), "utf8")
    .replace(/^export const /gm, "const ")
    .replace(/^export function /gm, "function ");
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(src + "\n;this.__m = { splitRouteNameNote };", ctx);
  return ctx.__m;
}

(async () => {
  let fail = 0, n = 0;
  const ok = (name, cond, got) => {
    n++; console.log(`  ${cond ? "✓" : "✗"} ${name}${!cond && got !== undefined ? " → " + JSON.stringify(got) : ""}`);
    if (!cond) fail++;
  };
  const { splitRouteNameNote } = load();
  const S = (x) => splitRouteNameNote(x);

  console.log("\n[1] 요청 대상 — 특이사항 꼬리표를 가른다");
  ok("04:39 고양일산 - 조기출근", S("04:39 고양일산 - 조기출근").note === "조기출근", S("04:39 고양일산 - 조기출근"));
  ok("앞부분은 그대로", S("04:39 고양일산 - 조기출근").head === "04:39 고양일산");
  ok("05:45 군포 - 출근", S("05:45 군포 - 출근").note === "출근", S("05:45 군포 - 출근"));

  console.log("\n[2] 🔴 오탐 방지 — 가르면 안 되는 것");
  ok("[H1-1] 은 안 갈린다(공백 없는 하이픈)", S("[H1-1] 등교(월~수,금) / To School (Mon–Wed & Fri)").note === null,
    S("[H1-1] 등교(월~수,금) / To School (Mon–Wed & Fri)"));
  ok("영문 병기(/)는 꼬리표가 아니다", S("[P] 방과후하교 / Late Activity Bus").note === null);
  ok("요일 괄호만 있으면 안 갈린다", S("06:14 안산 (월)").note === null);
  ok("Mon–Wed 의 en dash 는 하이픈이 아니다", S("To School (Mon–Wed & Fri)").note === null);

  console.log("\n[3] 가장자리");
  ok("빈 값", S("").note === null && S("").head === "");
  ok("null", S(null).note === null);
  ok("꼬리표가 비면 안 가른다", S("이름 - ").note === null, S("이름 - "));
  ok("앞이 비면 안 가른다", S(" - 조기출근").note === null, S(" - 조기출근"));
  ok("여러 개면 마지막 것 기준", S("A - B - C").note === "C", S("A - B - C"));

  console.log("\n[4] prod 전수 — 갈리는 노선이 실제 특이사항인지");
  let db = null;
  try {
    const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
    const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
    const sa = require(path.join(ROOT, "key", kf));
    if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치");
    admin.initializeApp({ credential: admin.credential.cert(sa) });
    db = admin.firestore();
  } catch (e) { console.log(`  ⏭ SKIP prod 대조(키 없음: ${e.message})`); }

  if (db) {
    const snap = await db.collection("companies").doc("dy001").collection("routes").get();
    const split = [];
    snap.forEach((d) => {
      const nm = String((d.data() || {}).name || "");
      const r = splitRouteNameNote(nm);
      if (r.note) split.push(`${r.head} ⟦${r.note}⟧`);
    });
    console.log(`     ${snap.size}개 중 ${split.length}개가 갈린다`);
    split.forEach((s) => console.log(`       ${s}`));
    ok("갈리는 노선이 2개다(실측 기준선 — 늘면 규칙을 다시 볼 것)", split.length === 2, split.length);
    ok("갈린 꼬리표가 전부 근무 구분어다", split.every((s) => /⟦(조기출근|출근|퇴근|조기퇴근)⟧$/.test(s)), split);
  }

  console.log(`\n${fail === 0 ? "✅" : "❌"} ${n - fail}/${n} 통과`);
  process.exit(fail === 0 ? 0 : 1);
})();
