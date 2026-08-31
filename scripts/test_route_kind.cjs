// @requires-credentials — firebase-admin/운영 데이터가 있어야 돈다(기본 게이트 제외, --live 로 실행)
// 노선 구분 판정(routeKind) 격리 테스트 — 2026-08-18 배시현 "등교/하교/방과후하교 필터".
//
//   node scripts/test_route_kind.cjs
//
// 🔴 판정식을 베끼지 않고 `src/lib/routeKind.js` 소스를 그대로 vm 에 태운다(재구현 0).
// 🔴 **prod 실값으로도 태운다** — 합성 픽스처만으로는 "shift 가 하교로 겹친다"는 이 요청의
//    핵심을 못 재현한다(그게 요청자가 말한 혼선이다).
// prod 쓰기 0.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = path.join(__dirname, "..");

function loadModule(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/^export const /gm, "const ")
    .replace(/^export function /gm, "function ");
  const ctx = { module: {}, exports: {}, console };
  vm.createContext(ctx);
  vm.runInContext(src + "\n;this.__m = { routeKind, availableRouteKinds, filterRoutesByKind, ROUTE_KIND_ORDER };", ctx);
  return ctx.__m;
}

(async () => {
  let fail = 0, n = 0;
  const ok = (name, cond, got) => { n++; console.log(`  ${cond ? "✓" : "✗"} ${name}${!cond && got !== undefined ? " → " + JSON.stringify(got) : ""}`); if (!cond) fail++; };
  const { routeKind, availableRouteKinds, filterRoutesByKind } = loadModule("src/lib/routeKind.js");

  console.log("\n[1] 판정 규칙");
  ok("방과후하교는 shift 가 '하교' 여도 방과후",
    routeKind({ name: "[A] 방과후하교 / Late Activity Bus", type: "퇴근", shift: "하교" }) === "방과후");
  ok("Late Activity 만 있어도 방과후(영문 표기)",
    routeKind({ name: "[S] Late Activity Bus", shift: "하교" }) === "방과후");
  ok("일반 하교는 하교", routeKind({ name: "[A] 하교 / Back Home", type: "퇴근", shift: "하교" }) === "하교");
  ok("등교는 등교", routeKind({ name: "[H1] 등교(목) / To School (Thu)", type: "출근", shift: "등교" }) === "등교");
  ok("shift 없으면 type 으로", routeKind({ name: "09:20 판교역", type: "출근", shift: "주간조" }) === "출근");
  ok("아무것도 없으면 null", routeKind({ name: "압구정 1호차" }) === null);
  ok("route 자체가 없으면 null", routeKind(null) === null);
  ok("이름에 '방과 후'(띄어쓰기)도 방과후", routeKind({ name: "[P] 방과 후 하교", shift: "하교" }) === "방과후");

  console.log("\n[2] 칩 목록");
  const cha = [
    { name: "[A] 등교(목)", shift: "등교", type: "출근" },
    { name: "[A] 하교 / Back Home", shift: "하교", type: "퇴근" },
    { name: "[A] 방과후하교 / Late Activity Bus", shift: "하교", type: "퇴근" },
  ];
  ok("등교→하교→방과후 순서", JSON.stringify(availableRouteKinds(cha)) === JSON.stringify(["등교", "하교", "방과후"]),
    availableRouteKinds(cha));
  ok("구분이 하나뿐이면 칩 없음(걸러 주는 게 없다)",
    availableRouteKinds([cha[0], { name: "[B] 등교", shift: "등교" }]).length === 0);
  ok("구분 없는 노선만이면 칩 없음", availableRouteKinds([{ name: "압구정 1호차" }]).length === 0);
  ok("빈 입력 안전", availableRouteKinds(null).length === 0);

  console.log("\n[3] 필터");
  ok("방과후만 고르면 1개", filterRoutesByKind(cha, "방과후").length === 1);
  ok("하교를 고르면 방과후는 안 섞인다(요청의 핵심)",
    filterRoutesByKind(cha, "하교").length === 1 && filterRoutesByKind(cha, "하교")[0].name === "[A] 하교 / Back Home");
  ok("null 이면 전체", filterRoutesByKind(cha, null).length === 3);

  // ── prod 실값 ──
  console.log("\n[4] prod 실값(채드윅)");
  const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
  const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
  const sa = require(path.join(ROOT, "key", kf));
  if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치");
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  const db = admin.firestore();
  const snap = await db.collection("companies").doc("dy001").collection("routes")
    .where("partnerCode", "==", "DY001-채드윅송도국제학-2026-LKO5").get();
  const routes = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
  const kinds = availableRouteKinds(routes);
  const byKind = {};
  routes.forEach((r) => { const k = routeKind(r) || "(구분없음)"; byKind[k] = (byKind[k] || 0) + 1; });
  console.log("   구분 분포:", JSON.stringify(byKind));
  ok("신호 있음 — 노선을 실제로 읽었다", routes.length > 0, routes.length);
  ok("칩 = 등교·하교·방과후", JSON.stringify(kinds) === JSON.stringify(["등교", "하교", "방과후"]), kinds);
  ok("구분 못 정한 노선 0개(29개 전부 판정)", !byKind["(구분없음)"], byKind["(구분없음)"]);
  ok("방과후 5개", byKind["방과후"] === 5, byKind["방과후"]);
  ok("하교(방과후 제외) 8개", byKind["하교"] === 8, byKind["하교"]);
  ok("세 구분 합 = 전체", (byKind["등교"] || 0) + (byKind["하교"] || 0) + (byKind["방과후"] || 0) === routes.length);
  // 🔴 옛 잣대(shift 만) 대조 — 방과후가 하교에 섞여 있었음을 재현
  const oldHagyo = routes.filter((r) => String(r.shift || "") === "하교").length;
  // 8(하교) + 5(방과후) = 13 — 옛 잣대로는 이 둘이 한 덩어리였다(= 요청자가 말한 혼선).
  ok(`옛 잣대(shift만)로는 하교 ${oldHagyo}개 = 하교 8 + 방과후 5 가 섞였다(대조군)`,
    oldHagyo === 13 && oldHagyo === (byKind["하교"] || 0) + (byKind["방과후"] || 0), oldHagyo);

  console.log("\n[5] 소스 가드");
  const src = fs.readFileSync(path.join(ROOT, "src/lib/routeKind.js"), "utf8");
  ok("방과후 판정이 shift 보다 먼저", src.indexOf("AFTER_SCHOOL.test") < src.indexOf("SHIFT_KINDS.includes"));
  ok("칩 2개 미만이면 빈 배열 규칙 유지", /list\.length >= 2 \? list : \[\]/.test(src));
  const pa = fs.readFileSync(path.join(ROOT, "src/pages/PartnerApp.js"), "utf8");
  ok("협력사 포털이 정본 헬퍼를 쓴다(재구현 금지)", /from "\.\.\/lib\/routeKind"/.test(pa));
  ok("구분 필터가 지도 버스에도 걸린다", /kindRouteIds\.has\(b\.routeId\)/.test(pa));

  console.log(`\n${fail === 0 ? `✅ ${n}단언 전부 통과` : `❌ ${fail}/${n} 실패`}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
