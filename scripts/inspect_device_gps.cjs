// buslink 단말(유비칸) GPS 관제 점검 (읽기 전용) — "단말 차량이 관제에 안 뜬다" 신고 진단용.
//
//   pollDeviceVehicleGps(functions/index.js) 가 좌표를 쓰기까지 통과해야 하는 관문이 5개다.
//   어느 관문에서 막혔는지 사람이 코드를 읽지 않고도 알 수 있게, CF 와 **같은 판정**을 그대로
//   미러해 관문별로 통과/차단을 찍는다:
//     ① vehicles.gpsSource === "device" 이고 carId 가 있는가
//     ② 오늘(KST) 그 차량 배차가 있는가            (없으면 gps 문서 삭제 후 skip)
//     ③ 지금이 노선 운행 시간 창 안인가            (밖이면 gps 문서 삭제 후 skip)
//     ④ busin 이 오늘 좌표를 주는가                (0건이면 skip)
//     ⑤ 최신 좌표가 15분 이내인가                  (초과면 skip = 주차·미운행)
//   ⚠ 판정 상수(30/30/120·15분)는 CF 와 같은 값을 여기 복제한다. CF 를 고치면 여기도 같이.
//
// 사용:
//   node scripts/inspect_device_gps.cjs                  — 전 회사 device 차량 전수 점검
//   node scripts/inspect_device_gps.cjs 7026             — 차량번호/차량ID 에 검색어가 든 것만
//   node scripts/inspect_device_gps.cjs --carid 4964     — busin carId 직접 조회(등록 전 차량도 가능)
//   node scripts/inspect_device_gps.cjs 7026 --date 2026-07-31
//
// 안전: 읽기 전용(Firestore write 없음·busin GET 만). project_id 를 buslink-prod 로 검증.
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
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

// ── CF 미러 상수 (functions/index.js) ──
const GPS_WINDOW_PRE_MIN = 30;
const GPS_WINDOW_POST_MIN = 30;
const GPS_WINDOW_DEFAULT_DURATION_MIN = 120;
const COORD_FRESH_MIN = 15; // 최신 좌표 신선도 가드

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};
const onlyCarId = flag("--carid");
const dateArg = flag("--date");
const q = argv.filter((a) => !a.startsWith("--") && a !== onlyCarId && a !== dateArg).join(" ").trim();

const kstToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const today = dateArg || kstToday();
const nowKst = new Date(Date.now() + 9 * 3600 * 1000);
const nowMin = nowKst.getUTCHours() * 60 + nowKst.getUTCMinutes();
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

// ── busin 조회 (CF fetchBusinHTML/parseBusinTable/fetchVehicleLocations 미러) ──
function fetchBusinHTML(urlStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "GET",
        timeout: 15000,
        rejectUnauthorized: false,
        headers: { "User-Agent": "Mozilla/5.0 (BuslinkOps inspect)", Accept: "text/html,application/xhtml+xml" },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}
function parseBusinTable(html) {
  if (!html) return [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const trList = [];
  let m;
  while ((m = trRe.exec(html)) !== null) trList.push(m[1]);
  if (!trList.length) return [];
  const stripHTML = (s) => String(s || "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  const cells = (tr, tag) => {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
    const out = [];
    let x;
    while ((x = re.exec(tr)) !== null) out.push(x[1]);
    return out;
  };
  let headers = cells(trList[0], "th").map(stripHTML);
  let start = 1;
  if (!headers.length) { headers = cells(trList[0], "td").map(stripHTML); start = 1; }
  const rows = [];
  for (let i = start; i < trList.length; i++) {
    const tds = cells(trList[i], "td");
    if (!tds.length) continue;
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = idx < tds.length ? stripHTML(tds[idx]) : ""; });
    rows.push(obj);
  }
  return rows;
}
async function fetchVehicleLocations(carId, dateStr) {
  const html = await fetchBusinHTML(
    `https://dr.busin.co.kr/api/CarLocationAll.aspx?carid=${encodeURIComponent(carId)}&date=${encodeURIComponent(dateStr)}`
  );
  const rows = parseBusinTable(html);
  const out = [];
  rows.forEach((r) => {
    const t = r["일시"] || r["시각"] || r["기준일시"] || "";
    const lat = parseFloat(r["위도"] || r["lat"] || "0");
    const lng = parseFloat(r["경도"] || r["lng"] || "0");
    if (!t || !lat || !lng) return;
    out.push({ time: t.trim(), lat, lng });
  });
  out.sort((a, b) => a.time.localeCompare(b.time));
  return { rows: out, raw: rows.length };
}
function extractHHMM(timeStr) {
  if (!timeStr) return "";
  const s = String(timeStr);
  const k = s.match(/(오전|오후)\s*(\d{1,2}):(\d{2})/);
  if (k) {
    let h = parseInt(k[2], 10);
    if (k[1] === "오전") { if (h === 12) h = 0; } else if (h !== 12) h += 12;
    return `${String(h).padStart(2, "0")}:${k[3]}`;
  }
  const m = s.match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : "";
}
const hhmmToMinutes = (v) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v || "");
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
};
function computeGpsWindow(departTime, stops) {
  const dep = hhmmToMinutes(departTime);
  if (dep === null) return null;
  let maxOffset = 0;
  for (const st of stops || []) {
    if (typeof st.offsetMin === "number" && isFinite(st.offsetMin) && st.offsetMin > maxOffset) maxOffset = st.offsetMin;
  }
  const span = maxOffset > 0 ? maxOffset : GPS_WINDOW_DEFAULT_DURATION_MIN;
  return { startMin: Math.max(0, dep - GPS_WINDOW_PRE_MIN), endMin: Math.min(1439, dep + span + GPS_WINDOW_POST_MIN), maxOffset };
}

async function reportBusin(carId) {
  try {
    const { rows, raw } = await fetchVehicleLocations(carId, today);
    if (!rows.length) {
      console.log(`  ④ busin 좌표: ❌ 0건 (표 행 ${raw}개 — 단말이 오늘 신호를 안 보냄 or carId 불일치)`);
      return null;
    }
    const latest = rows[rows.length - 1];
    const coordMin = hhmmToMinutes(extractHHMM(latest.time));
    const ageMin = coordMin === null ? null : nowMin - coordMin;
    console.log(`  ④ busin 좌표: ✅ ${rows.length}건 · 최초 ${rows[0].time} · 최신 ${latest.time} (${latest.lat}, ${latest.lng})`);
    if (ageMin === null) console.log("  ⑤ 신선도: ⚠ 시각 파싱 실패 → CF 는 skip");
    else if (ageMin > COORD_FRESH_MIN) console.log(`  ⑤ 신선도: ❌ ${ageMin}분 전 (${COORD_FRESH_MIN}분 초과 → skip)`);
    else console.log(`  ⑤ 신선도: ✅ ${ageMin}분 전`);
    return { rows, latest, ageMin };
  } catch (e) {
    console.log(`  ④ busin 좌표: ❌ 조회 실패 — ${e.message}`);
    return null;
  }
}

(async () => {
  console.log(`기준: ${today} (KST) · 현재 ${hhmm(nowMin)}\n`);

  if (onlyCarId) {
    console.log(`■ busin carId=${onlyCarId} 직접 조회`);
    await reportBusin(onlyCarId);
    return;
  }

  const companies = await db.collection("companies").get();
  let found = 0;

  for (const c of companies.docs) {
    const cid = c.id;
    const vehSnap = await db.collection("companies").doc(cid).collection("vehicles").get();

    // 배차 1회 조회 (CF 와 동일)
    const dispByVehicle = {};
    const dispSnap = await db.collection("companies").doc(cid).collection("dispatches").doc(today).collection("list").get();
    dispSnap.docs.forEach((d) => {
      const v = d.data() || {};
      if (v.vehicleId) dispByVehicle[v.vehicleId] = { dispatchId: d.id, ...v };
    });

    for (const vdoc of vehSnap.docs) {
      const veh = vdoc.data() || {};
      const label = `${veh.plateNo || veh.vehicleNo || "(번호없음)"} / ${vdoc.id}`;
      const hay = `${veh.plateNo || ""} ${veh.vehicleNo || ""} ${vdoc.id} ${veh.carId || ""}`;
      if (q && !hay.includes(q)) continue;
      // 검색어 없으면 device 차량만 훑는다(mobile 은 이 스크립트 대상 아님)
      if (!q && veh.gpsSource !== "device") continue;
      found++;

      console.log(`■ [${cid}] ${label}`);
      // ① 등록
      if (veh.gpsSource !== "device") {
        console.log(`  ① 위치 소스: ❌ ${veh.gpsSource || "(미설정=mobile)"} — 단말 폴러 대상이 아님(차량관리에서 '단말' 선택 필요)`);
      } else if (!veh.carId) {
        console.log("  ① 위치 소스: ❌ device 인데 carId 없음 — 차량관리 'carId 조회' 필요");
      } else {
        console.log(`  ① 위치 소스: ✅ device · carId=${veh.carId}`);
      }

      // ② 오늘 배차
      const disp = dispByVehicle[vdoc.id];
      if (!disp) {
        console.log(`  ② 오늘 배차: ❌ 없음 → CF 가 gps 문서 삭제 후 skip (관제 표시 불가)`);
      } else {
        console.log(`  ② 오늘 배차: ✅ ${disp.routeName || disp.routeId} · ${disp.departTime || "-"} · 기사 ${disp.driverName || "-"}`);
      }

      // ③ 운행 시간 창
      if (disp && disp.routeId) {
        const rSnap = await db.collection("companies").doc(cid).collection("routes").doc(disp.routeId).get();
        const rv = rSnap.exists ? rSnap.data() || {} : {};
        const stopsSnap = await db
          .collection("companies").doc(cid).collection("routes").doc(disp.routeId)
          .collection("stops").orderBy("order").get();
        const stops = stopsSnap.docs.map((s) => ({ offsetMin: typeof (s.data() || {}).offsetMin === "number" ? s.data().offsetMin : null }));
        const win = computeGpsWindow(rv.departTime, stops);
        if (!win) {
          console.log(`  ③ 시간 창: ⚪ 게이트 없음 (노선 출발시각 미설정 — 24시간 허용)`);
        } else {
          const inWin = nowMin >= win.startMin && nowMin <= win.endMin;
          console.log(
            `  ③ 시간 창: ${inWin ? "✅ 안" : "❌ 밖"} ${hhmm(win.startMin)}~${hhmm(win.endMin)}` +
              ` (출발 ${rv.departTime} · 최대 offsetMin ${win.maxOffset || "없음→기본120분"})`
          );
          if (!inWin) console.log("     → CF 가 gps 문서 삭제 후 skip (관제에서 사라짐)");
        }
      }

      // ④⑤ busin
      if (veh.carId) await reportBusin(veh.carId);

      // 현재 gps 문서
      const g = await db.collection("gps").doc(`${cid}_${vdoc.id}`).get();
      if (!g.exists) console.log("  ▶ gps 문서: 없음 (관제·승객앱에 표시 안 됨)");
      else {
        const gd = g.data() || {};
        const t = gd.updatedAt && gd.updatedAt.toMillis ? gd.updatedAt.toMillis() : null;
        const age = t ? Math.round((Date.now() - t) / 1000) : null;
        console.log(`  ▶ gps 문서: 있음 · source=${gd.source || "-"} · ${age === null ? "시각없음" : age + "초 전"} · (${gd.lat}, ${gd.lng})`);
      }
      console.log("");
    }
  }

  if (!found) console.log(q ? `검색어 "${q}" 에 해당하는 차량이 없습니다.` : "device 차량이 없습니다.");
})().catch((e) => { console.error(e); process.exit(1); });
