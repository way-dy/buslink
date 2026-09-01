// 「내 정류장이 자꾸 풀린다 + 탑승 시 이 노선이 아니라고 한다」 실측 (읽기 전용) — 2026-09-01.
//   node scripts/inspect_mystop_route_mismatch.cjs [이름]
//
// 가설: 홈에서 보는 노선(`activeRouteId`)과 스캐너가 서버에 보내는 노선(`session.routeId`)이
// 서로 다른 값이라, 즐겨찾기(또는 노선 칩)로 노선을 바꾼 사람은
//   ① 홈이 다시 그려질 때마다 activeRouteId 가 session.routeId 로 되돌아가 '내 정류장' 복원 실패
//   ② 스캔 시 session.routeId 로 배차 매칭 → "선택한 노선의 차량이 아닙니다"
// 를 동시에 겪는다. 그 조건(즐겨찾기 ⊅ 배정노선)에 실제로 몇 명이 걸리는지 센다.
const fs = require("fs");
const path = require("path");
const admin = require(path.join(__dirname, "..", "functions", "node_modules", "firebase-admin"));

const NAME = process.argv[2] || null;
const kd = path.join(__dirname, "..", "key");
const kf = fs.existsSync(kd) && fs.readdirSync(kd).find((f) => f.endsWith(".json"));
if (!kf) { console.error("❌ key/*.json 없음"); process.exit(1); }
const key = require(path.join(kd, kf));
if (key.project_id !== "buslink-prod") { console.error(`❌ project_id 불일치: ${key.project_id}`); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();

const cid = "dy001";
(async () => {
  const routesSnap = await db.collection("companies").doc(cid).collection("routes").get();
  const routeName = new Map(routesSnap.docs.map((d) => [d.id, (d.data() || {}).name || d.id]));

  const psnap = await db.collection("companies").doc(cid).collection("passengers").get();
  let total = 0, withFav = 0, mismatch = 0;
  const rows = [];
  for (const d of psnap.docs) {
    const v = d.data() || {};
    total++;
    const favs = Array.isArray(v.favorites) ? v.favorites.filter(Boolean) : [];
    if (favs.length === 0) continue;
    withFav++;
    // 홈 목록 = 즐겨찾기(있으면 배정 무시). 배정 노선이 그 안에 없으면 activeRouteId 가 튄다.
    const bounces = !!v.routeId && !favs.includes(v.routeId);
    const noAssign = !v.routeId;
    if (bounces || noAssign) {
      mismatch++;
      rows.push({ empNo: d.id, name: v.name || "", partner: v.partnerName || v.partnerCode || "",
        assigned: v.routeId ? routeName.get(v.routeId) || v.routeId : "(배정없음)",
        favs: favs.map((f) => routeName.get(f) || f).join(" / ") });
    }
  }
  console.log(`승객 ${total}명 · 즐겨찾기 보유 ${withFav}명 · **홈 노선이 배정노선과 갈라지는 사람 ${mismatch}명**\n`);
  for (const r of rows.slice(0, 40)) {
    console.log(`  ${r.empNo} ${r.name} [${r.partner}] 배정=${r.assigned} · 즐겨찾기=${r.favs}`);
  }
  if (rows.length > 40) console.log(`  … 외 ${rows.length - 40}명`);

  if (NAME) {
    console.log(`\n── 신고자 조회: ${NAME} ──`);
    const hits = psnap.docs.filter((d) => ((d.data() || {}).name || "") === NAME);
    if (!hits.length) console.log("  명부에 없음");
    for (const d of hits) {
      const v = d.data() || {};
      const favs = Array.isArray(v.favorites) ? v.favorites : [];
      console.log(`  사번 ${d.id} · ${v.name} · 거래처 ${v.partnerName || v.partnerCode || "-"}`);
      console.log(`   배정노선 routeId = ${v.routeId || "(없음)"} ${v.routeId ? `(${routeName.get(v.routeId) || "?"})` : ""}`);
      console.log(`   즐겨찾기 = ${favs.length ? favs.map((f) => `${f}(${routeName.get(f) || "?"})`).join(", ") : "(없음)"}`);
      const t = await db.collection("companies").doc(cid).collection("fcmTokens").doc(d.id).get();
      const tv = t.exists ? t.data() : null;
      console.log(`   fcmTokens 내정류장 = routeId ${tv?.routeId || "null"} ${tv?.routeId ? `(${routeName.get(tv.routeId) || "?"})` : ""} · stopId ${tv?.stopId || "null"} · 갱신 ${tv?.myStopUpdatedAt?.toDate?.().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) || "-"}`);
      console.log(`   → 홈이 보여줄 노선 = ${favs.length ? `${favs[0]}(${routeName.get(favs[0]) || "?"})` : v.routeId || "-"} · 스캐너가 보내는 노선 = ${v.routeId || "null"}`);
      // 오늘 탑승 시도 기록
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
      const b = await db.collection("companies").doc(cid).collection("boardings")
        .where("empNo", "==", d.id).where("date", "==", day).get().catch(() => ({ docs: [] }));
      console.log(`   오늘(${day}) 탑승 적재 ${b.docs.length}건` + b.docs.map((x) => ` · ${(x.data().routeName || x.data().routeId)}`).join(""));
    }
  }
  process.exit(0);
})();
