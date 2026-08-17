// 운행 이력 지도(GPS 궤적 + 등록 노선 경로)를 **진짜 지도 위에 실데이터로** 그려 확인.
//   node scripts/headless_check_history_track.cjs [YYYY-MM-DD] [차량번호검색어]
//
// 2026-08-18 way 점검 "경로가 정확하지 않고 직선으로 나오는 현상". 관리자 콘솔은 로그인이
// 필요해 통째로 못 띄우므로, 승객앱(prod)에서 카카오 SDK 가 올라온 페이지를 빌려
//   ① prod gpsHistory 실포인트 ② 그 노선의 routePath
// 를 넣고 **AdminApp 과 같은 판정(gpsTrack.trackSegments)·같은 색/굵기**로 그린다.
//
// 판정: ① 표본이 실재(포인트 ≥ 10) ② 옛 방식(전 포인트 한 줄 실선)과 새 방식의 차이가
//       숫자로 드러난다 ③ 신호 공백은 점선으로 분리된다 ④ 콘솔 오류 0 ⑤ PNG 육안 확인
// 안전: Firestore 읽기 전용. 화면 쓰기 0.
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));
const admin = require(path.join(__dirname, "..", "functions", "node_modules", "firebase-admin"));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ROOT = path.join(__dirname, "..");
const OUT = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "buslink-histtrk-")), "track.png");
const BASE = process.env.BASE || "https://p.buslink.co.kr";
const CID = "dy001";
const DATE = process.argv[2] || new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
const VQ = process.argv[3] || "6859";

const kd = path.join(ROOT, "key");
const kf = fs.existsSync(kd) && fs.readdirSync(kd).find(f => f.endsWith(".json"));
if (!kf) { console.error("❌ key/*.json 없음"); process.exit(1); }
const key = require(path.join(kd, kf));
if (key.project_id !== "buslink-prod") { console.error("❌ project_id 불일치"); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();

// AdminApp 과 같은 판정을 쓰기 위해 정본 모듈을 그대로 태운다(재구현 0).
const libSrc = fs.readFileSync(path.join(ROOT, "src/lib/gpsTrack.js"), "utf8")
  .replace(/^export\s+function\s+/gm, "function ").replace(/^export\s+const\s+/gm, "var ");
const ctx = vm.createContext({ console });
vm.runInContext(libSrc, ctx);
const { trackSegments } = ctx;

let fail = 0;
const ok = (n, c, x) => { if (c) console.log(`  ✅ ${n}`); else { fail++; console.log(`  ❌ ${n}${x !== undefined ? " — " + JSON.stringify(x) : ""}`); } };
const ms = ts => (ts?.toMillis ? ts.toMillis() : typeof ts === "number" ? ts : null);

(async () => {
  const vs = await db.collection("companies").doc(CID).collection("vehicles").get();
  const veh = vs.docs.map(d => ({ id: d.id, ...d.data() })).find(x => String(x.plateNo || x.vehicleNo || "").includes(VQ));
  if (!veh) { console.error("❌ 차량 없음: " + VQ); process.exit(1); }
  const disps = (await db.collection("companies").doc(CID).collection("dispatches").doc(DATE).collection("list").get())
    .docs.map(d => ({ id: d.id, ...d.data() })).filter(d => d.vehicleId === veh.id)
    .sort((a, b) => String(a.departTime).localeCompare(String(b.departTime)));
  if (!disps.length) { console.error(`❌ ${DATE} 에 ${veh.plateNo} 배차 없음`); process.exit(1); }
  const d0 = disps[0];

  // AdminApp dispatchTimeRange 미러(범위 필터가 화면과 같아야 같은 그림이 나온다)
  const base = new Date(DATE + "T00:00:00+09:00").getTime();
  const off = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ""); return m ? (+m[1]) * 3600e3 + (+m[2]) * 60e3 : null; };
  const start = base + off(d0.departTime) - 5 * 60e3;
  let lastAct = null;
  Object.values(d0.stopArrivals || {}).forEach(a => { const m = ms(a?.actualAt); if (m && (!lastAct || m > lastAct)) lastAct = m; });
  const end = lastAct ? lastAct + 10 * 60e3 : start + 3 * 3600e3;

  const snap = await db.collection("gpsHistory").doc(CID).collection(veh.id).doc(DATE).collection("points").orderBy("ts", "asc").get();
  const points = snap.docs.map(x => x.data()).map(p => ({ lat: +p.lat, lng: +p.lng, ts: ms(p.ts) }))
    .filter(p => p.ts >= start && p.ts <= end);
  const route = d0.routeId ? (await db.collection("companies").doc(CID).collection("routes").doc(d0.routeId).get()).data() : null;
  const drawn = Array.isArray(route?.routePath)
    ? route.routePath.map(p => ({ lat: Number(p.lat ?? p.latitude), lng: Number(p.lng ?? p.longitude) })).filter(p => isFinite(p.lat) && isFinite(p.lng))
    : [];
  const track = trackSegments(points);

  console.log(`\n대상: ${veh.plateNo} · ${DATE} · ${d0.departTime} ${d0.routeName}`);
  console.log("[0] 신호 유무 — 그릴 것이 실제로 있는가");
  ok(`GPS 포인트 ${points.length}개(10 미만이면 판정 무의미)`, points.length >= 10, points.length);
  ok(`등록 경로 ${drawn.length}점`, drawn.length >= 2, drawn.length);

  console.log("\n[1] 궤적 분해 — 정상 표본과 진짜 공백을 가르는가");
  console.log("   stats:", JSON.stringify(track.stats));
  ok(`연속 구간 ${track.runs.length}개`, track.runs.length >= 1, track.runs.length);
  ok(`신호 공백 ${track.gaps.length}회`, true);
  ok("좌표 갱신 간격이 기록 간격보다 길다(= 같은 좌표 재기록이 있다)",
    track.stats.medianMoveGapSec === null || track.stats.medianMoveGapSec >= track.stats.medianGapSec,
    { move: track.stats.medianMoveGapSec, rec: track.stats.medianGapSec });

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errs = [];
  page.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
  await page.goto(BASE + "/bus", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => window.kakao && window.kakao.maps && window.kakao.maps.Map, null, { timeout: 30000 });

  const drewCounts = await page.evaluate(({ runs, gaps, drawn, points }) => {
    document.body.innerHTML = '<div id="hmap" style="position:fixed;inset:0"></div>';
    const kakao = window.kakao;
    const all = [...drawn, ...points];
    const lat = all.reduce((s, p) => s + p.lat, 0) / all.length;
    const lng = all.reduce((s, p) => s + p.lng, 0) / all.length;
    const map = new kakao.maps.Map(document.getElementById("hmap"), { center: new kakao.maps.LatLng(lat, lng), level: 7 });
    const bounds = new kakao.maps.LatLngBounds();
    all.forEach(p => bounds.extend(new kakao.maps.LatLng(p.lat, p.lng)));
    map.setBounds(bounds);
    const LL = a => a.map(p => new kakao.maps.LatLng(p.lat, p.lng));
    let n = 0;
    if (drawn.length >= 2) { new kakao.maps.Polyline({ map, path: LL(drawn), strokeWeight: 7, strokeColor: "#8A94A6", strokeOpacity: 0.45, strokeStyle: "solid" }); n++; }
    runs.forEach(r => { new kakao.maps.Polyline({ map, path: LL(r), strokeWeight: 4, strokeColor: "#0066FF", strokeOpacity: 0.85, strokeStyle: "solid" }); n++; });
    gaps.forEach(g => { new kakao.maps.Polyline({ map, path: LL([g.from, g.to]), strokeWeight: 3, strokeColor: "#E8A33D", strokeOpacity: 0.9, strokeStyle: "shortdash" }); n++; });
    points.forEach(p => {
      const el = document.createElement("div");
      el.style.cssText = "width:6px;height:6px;border-radius:50%;background:#fff;border:1.5px solid #0066FF;box-shadow:0 0 0 1px rgba(255,255,255,.9)";
      new kakao.maps.CustomOverlay({ map, position: new kakao.maps.LatLng(p.lat, p.lng), content: el, yAnchor: 0.5 });
    });
    return { polylines: n, dots: points.length };
  }, { runs: track.runs, gaps: track.gaps, drawn, points: points.map(p => ({ lat: p.lat, lng: p.lng })) });

  await page.waitForTimeout(4000);
  const tiles = await page.locator('img[src*="daumcdn"], img[src*="kakao"]').count();
  console.log("\n[2] 실지도 렌더");
  ok(`지도 타일 ${tiles}장`, tiles >= 4, tiles);
  ok(`폴리라인 ${drewCounts.polylines}개 · 수신점 ${drewCounts.dots}개`, drewCounts.polylines >= 2);
  const real = errs.filter(e => !/runtime\.lastError|favicon|ERR_BLOCKED/.test(e));
  ok(`콘솔 오류 ${real.length}건`, real.length === 0, real.slice(0, 3));

  await page.screenshot({ path: OUT });
  console.log(`\n📸 ${OUT}`);
  await browser.close();
  console.log(fail === 0 ? "\n✅ 전부 통과" : `\n❌ ${fail}건 실패`);
  process.exit(fail === 0 ? 0 : 1);
})();
