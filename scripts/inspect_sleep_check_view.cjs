// 빈 차 확인 현황 탭이 **실제로 무엇을 그릴지** prod 데이터로 미리 본다(읽기 전용).
//   node scripts/inspect_sleep_check_view.cjs [YYYY-MM-DD]
//
// 🔴 관리자 화면은 Firebase Auth 로그인이 필요해 헤드리스로 못 연다. 그래서 탭이 쓰는
//    **같은 순수 함수에 같은 prod 문서를 태워** 배선(필드명·stopArrivals 모양·종점 판정)을
//    확인한다. 화면 레이아웃은 못 재지만, 실제 결함이 숨는 곳은 대개 이 배선 쪽이다.
// prod 쓰기 0.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = path.join(__dirname, "..");
const DATE = process.argv[2] || new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());

function load() {
  const src = fs.readFileSync(path.join(ROOT, "src/lib/sleepingCheck.js"), "utf8")
    .replace(/^export const /gm, "const ").replace(/^export function /gm, "function ");
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(src + `\n;this.__m = { sleepCheckRoutes, sleepCheckRows, sleepCheckedAtLabel,
    sleepCheckPlaceLabel, sleepCheckViaLabel, formatWaited, sleepCheckedAt };`, ctx);
  return ctx.__m;
}

const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
const sa = require(path.join(ROOT, "key", kf));
if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치");
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const COMPANY = "dy001";

(async () => {
  const M = load();
  const rsnap = await db.collection("companies").doc(COMPANY).collection("routes").get();
  const routes = rsnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const sel = M.sleepCheckRoutes(routes);
  console.log(`\n노선 ${routes.length}개 · 대상 ${sel.routes.length}개 · ${sel.pinned ? "지정됨" : "🔸 미지정(마지막 운행 노선으로 폴백)"}`);
  sel.routes.slice(0, 12).forEach((r) => console.log(`    ${r.name}`));
  if (sel.routes.length > 12) console.log(`    … 외 ${sel.routes.length - 12}개`);

  const targetIds = new Set(sel.routes.map((r) => r.id));
  const dsnap = await db.collection("companies").doc(COMPANY)
    .collection("dispatches").doc(DATE).collection("list").get();
  const all = dsnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  // 🔴 대상 노선 밖에서 찍힌 확인도 포함한다(탭과 같은 규칙) — 기록은 숨기지 않는다.
  const scoped = all.filter((d) => targetIds.has(d.routeId) || M.sleepCheckedAt(d));
  console.log(`\n${DATE} 배차 ${all.length}건 중 대상 노선 ${scoped.length}건`);

  const stopsBy = {};
  for (const rid of new Set(scoped.map((d) => d.routeId).filter(Boolean))) {
    const s = await db.collection("companies").doc(COMPANY).collection("routes").doc(rid)
      .collection("stops").orderBy("order", "asc").get();
    stopsBy[rid] = s.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  // 🔴 과거 날짜는 그 날 끝에 시계를 맞춘다(탭과 같은 규칙) — 안 그러면 "종점 뒤 21시간째"가 된다.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
  const isToday = DATE === today;
  const anchorNow = isToday ? Date.now() : new Date(`${DATE}T23:59:59+09:00`).getTime();
  const rows = M.sleepCheckRows(scoped, stopsBy, anchorNow);
  const c = { checked: 0, late: 0, waiting: 0, running: 0 };
  rows.forEach((r) => { c[r.state] = (c[r.state] || 0) + 1; });
  console.log(`\n화면 요약 → 확인 ${c.checked} · 미확인 ${c.late} · 대기 ${c.waiting} · 운행 전·중 ${c.running}`);

  console.log("\n[화면에 그려질 행]");
  const LABEL = { checked: "확인 완료", late: "미확인", waiting: "확인 대기", running: "운행 전·중" };
  rows.slice(0, 25).forEach(({ d, state, waitedMs }) => {
    const at = M.sleepCheckedAtLabel(d) || "-";
    const pl = M.sleepCheckPlaceLabel(d);
    const via = M.sleepCheckViaLabel(d) || "-";
    const waited = (waitedMs != null && isToday) ? ` (종점 뒤 ${M.formatWaited(waitedMs)})` : "";
    const off = targetIds.has(d.routeId) ? "" : " [대상 외]";
    console.log(`  ${LABEL[state].padEnd(7)}${waited.padEnd(20)} ${(String(d.routeName || d.routeId).slice(0, 22) + off).padEnd(32)} ${String(d.vehicleNo || "-").padEnd(12)} 확인 ${at} · ${pl.text || "-"} · ${via}`);
  });
  if (rows.length > 25) console.log(`  … 외 ${rows.length - 25}행`);

  // 🔴 배선이 살아 있나 — stopArrivals 를 하나라도 읽었는지(전부 running 이면 종점 판정이 죽은 것)
  const anyEnd = rows.some((r) => r.endMs != null);
  console.log(`\n종점 도착을 읽은 행: ${rows.filter((r) => r.endMs != null).length}/${rows.length} ${anyEnd ? "✓ 배선 정상" : "✗ 전부 running — stops/stopArrivals 배선 확인 필요"}`);
  process.exit(0);
})();
