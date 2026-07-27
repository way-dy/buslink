// buslink 기사 운행상태 점검 (읽기 전용) — "로그아웃했는데 계속 운행중" 신고 진단용.
//
//   drivers/{id}.status 가 "운행중" 인데 실제로는 운행이 끝난(또는 앱이 죽은) 기사를 찾는다.
//   판정에 쓰는 3가지: ① drivers.status/startedAt/endedAt ② gps/{cid}_{vid} 문서 존재·신선도
//   ③ 오늘 배차 유무. GPS 가 끊긴 지 오래인데 status 가 운행중이면 "잔존(stale)".
//
// 사용:
//   node scripts/inspect_driver_status.cjs            — 전 회사 기사 상태 요약
//   node scripts/inspect_driver_status.cjs <검색어>    — 이름/사번에 검색어가 든 기사만 상세
//
// 안전: 읽기 전용(write 없음). project_id 를 buslink-prod 로 검증.
const fs = require("fs");
const path = require("path");
const admin = require(path.join(__dirname, "..", "functions", "node_modules", "firebase-admin"));

const kd = path.join(__dirname, "..", "key");
const kf = fs.existsSync(kd) && fs.readdirSync(kd).find((f) => f.endsWith(".json"));
if (!kf) {
  console.error("❌ app/buslink/key/*.json 서비스 계정 키가 없습니다.");
  process.exit(1);
}
const key = require(path.join(kd, kf));
if (key.project_id !== "buslink-prod") {
  console.error(`❌ project_id 불일치: ${key.project_id} (buslink-prod 기대)`);
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();

const FRESH_SEC = 60; // AdminApp isGpsFresh 와 동일 기준
const q = (process.argv[2] || "").trim();

function kstDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function ms(ts) {
  if (!ts) return null;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}
function ago(msVal) {
  if (msVal == null) return "-";
  const s = Math.round((Date.now() - msVal) / 1000);
  if (s < 90) return `${s}초 전`;
  if (s < 5400) return `${Math.round(s / 60)}분 전`;
  return `${(s / 3600).toFixed(1)}시간 전`;
}

// --gps : 전체 gps 문서(=직원/승객앱 "운행중" 표시의 실제 근거) 신선도 목록
async function listGpsDocs() {
  const snap = await db.collection("gps").get();
  console.log(`\n=== gps 문서 ${snap.size}건 (직원·승객앱 노선/홈 탭 "운행중" 표시 근거) ===`);
  const rows = snap.docs.map((d) => {
    const v = d.data();
    const t = ms(v.updatedAt);
    return { id: d.id, source: v.source || "mobile", t, fresh: t != null && Date.now() - t <= FRESH_SEC * 1000, routeName: v.routeName || "-", driverName: v.driverName || "-" };
  }).sort((a, b) => (b.t || 0) - (a.t || 0));
  for (const r of rows) {
    // 이 gps 문서의 vehicleId 를 현재 배정받은 기사(= 강제 종료 시 상태를 되돌릴 대상) 조회
    const [cid, ...rest] = r.id.split("_");
    const vid = rest.join("_");
    let owner = "(배정 기사 없음 — 고아 신호)";
    try {
      const ds = await db.collection("companies").doc(cid).collection("drivers").where("vehicleId", "==", vid).get();
      if (!ds.empty) owner = ds.docs.map((d) => `${d.data().name}[${d.data().status || "-"}]`).join(", ");
    } catch {}
    console.log(`${r.fresh ? "🟢 신선" : "🔴 stale"} ${r.id} source=${r.source} 최종=${ago(r.t)} 노선=${r.routeName} 신호상 기사=${r.driverName}`);
    console.log(`      현재 이 차량 배정 기사: ${owner}`);
  }
  console.log(`\n신선 ${rows.filter((r) => r.fresh).length}건 / stale ${rows.filter((r) => !r.fresh).length}건`);
}

(async () => {
  if (q === "--gps") { await listGpsDocs(); process.exit(0); }
  const today = kstDate();
  const companies = await db.collection("companies").get();
  for (const c of companies.docs) {
    const cid = c.id;
    const drivers = await db.collection("companies").doc(cid).collection("drivers").get();
    if (drivers.empty) continue;

    // 오늘 배차: vehicleId / driverId 별 존재 여부
    const disp = await db.collection("companies").doc(cid).collection("dispatches").doc(today).collection("list").get();
    const dispDrivers = new Set(disp.docs.map((d) => d.data().driverId).filter(Boolean));

    const rows = [];
    for (const d of drivers.docs) {
      const v = d.data();
      const name = v.name || "(이름없음)";
      if (q && !`${name}${v.empNo || ""}${d.id}`.toLowerCase().includes(q.toLowerCase())) continue;

      let gps = null;
      if (v.vehicleId) {
        const g = await db.collection("gps").doc(`${cid}_${v.vehicleId}`).get();
        if (g.exists) gps = g.data();
      }
      const gpsMs = gps ? ms(gps.updatedAt) : null;
      const fresh = gpsMs != null && Date.now() - gpsMs <= FRESH_SEC * 1000;
      const driving = v.status === "운행중";
      const stale = driving && !fresh;
      rows.push({
        id: d.id, name, empNo: v.empNo || "-", status: v.status || "-",
        vehicleId: v.vehicleId || "-", vehicleNo: v.vehicleNo || "-",
        startedAt: v.startedAt || null, endedAt: v.endedAt || null,
        gpsExists: !!gps, gpsSource: gps?.source || "-", gpsMs, fresh,
        todayDispatch: dispDrivers.has(d.id), stale,
      });
    }
    if (!rows.length) continue;

    const drivingRows = rows.filter((r) => r.status === "운행중");
    const staleRows = rows.filter((r) => r.stale);
    console.log(`\n=== ${cid} (${c.data().name || "-"}) · 기사 ${rows.length}명 · 오늘(${today}) 배차 ${disp.size}건 ===`);
    console.log(`운행중 표시 ${drivingRows.length}명 / 그중 GPS 끊긴 잔존 의심 ${staleRows.length}명`);
    for (const r of rows) {
      if (!q && r.status !== "운행중") continue; // 검색어 없으면 운행중만 상세
      const mark = r.stale ? "🔴 잔존의심" : r.status === "운행중" ? "🟢 운행중" : "  ";
      console.log(
        `${mark} ${r.name}(${r.empNo}) id=${r.id}\n` +
        `      status=${r.status} startedAt=${r.startedAt || "-"} endedAt=${r.endedAt || "-"}\n` +
        `      차량=${r.vehicleNo}(${r.vehicleId}) 오늘배차=${r.todayDispatch ? "있음" : "없음"}\n` +
        `      gps문서=${r.gpsExists ? `있음(${r.gpsSource}) 최종 ${ago(r.gpsMs)}${r.fresh ? " · 신선" : " · stale"}` : "없음"}`
      );
    }
  }
  process.exit(0);
})().catch((e) => { console.error("실패:", e); process.exit(1); });
