// 정류장 로드뷰 실측 (읽기 전용·prod 쓰기 0) — 2026-08-10 경쟁사 대조에서 도출.
//   node scripts/measure_roadview_side.cjs [--radius 60] [--limit 0]
//
// 경쟁사(모빌리티지)가 "상·하행 혼동 없이 정확한 탑승 위치"를 내세워, 우리 로드뷰가
// 반대 차선을 보여주는지 재려고 만들었다. **먼저 소스를 읽어 확인한 것**:
//   react-kakao-maps-sdk `<Roadview position={{lat,lng,radius}}>` 는
//   `rv.setPanoId(panoId, 정류장좌표)` 를 호출한다 = 카카오가 **그 좌표를 바라보는 시점**으로 맞춘다.
//   → "카메라가 엉뚱한 데를 본다"는 원래 성립하지 않는다. 남은 질문은 두 가지뿐이다:
//     ① 파노라마가 아예 없는 정류장이 몇 개인가(폴백으로 떨어진다)
//     ② 잡힌 파노라마가 반대 차선인가(진행방향 기준 좌측 + 도로폭 이상 떨어짐)
//
// 🔴 반드시 **등록된 도메인**(p.buslink.co.kr)에서 돌려야 한다 — localhost 는 카카오 콘솔
//    미등록이라 SDK 가 통째로 안 뜨고, 그러면 "파노라마 0개"라는 거짓 결론이 나온다.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { chromium } = require(path.join(__dirname, "..", "docs", "manual", "node_modules", "playwright-core"));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.env.BASE || "https://p.buslink.co.kr";
const COMPANY = process.env.COMPANY || "dy001";
const ROOT = path.join(__dirname, "..");
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
const RADIUS = Number(arg("--radius", 60));
const LIMIT = Number(arg("--limit", 0));

function loadDb() {
  const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
  const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
  const sa = require(path.join(ROOT, "key", kf));
  if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치: " + sa.project_id);
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  return admin.firestore();
}

// 좌표 4형식 흡수 (issues.md toLatLng 계약). Number("")===0 이므로 빈 값은 NaN 으로.
function ll(v) {
  const raw = (a, b, c) => (a !== undefined && a !== null && a !== "" ? a : b !== undefined && b !== null && b !== "" ? b : c);
  const la = Number(raw(v.lat, v.latitude, v.location && v.location.latitude));
  const lo = Number(raw(v.lng, v.longitude, v.location && v.location.longitude));
  if (!Number.isFinite(la) || !Number.isFinite(lo) || la === 0 || lo === 0) return null;
  return { lat: la, lng: lo };
}

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;
function distM(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
// 정북 0°, 시계방향
function bearing(a, b) {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (Math.atan2(y, x) * 180) / Math.PI;
}
const angDiff = (a, b) => { let d = ((a - b + 540) % 360) - 180; return d; };

// routePath 상에서 그 정류장 부근의 진행 방위각 — 없으면 null
function travelBearingAt(routePath, stop) {
  if (!Array.isArray(routePath) || routePath.length < 2) return null;
  let best = -1, bestD = Infinity;
  for (let i = 0; i < routePath.length; i++) {
    const p = ll(routePath[i]); if (!p) continue;
    const d = distM(p, stop);
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best < 0 || bestD > 200) return null; // 경로에서 너무 멀면 방향을 말할 수 없다
  const a = ll(routePath[Math.max(0, best - 1)]);
  const b = ll(routePath[Math.min(routePath.length - 1, best + 1)]);
  if (!a || !b || distM(a, b) < 3) return null;
  return bearing(a, b);
}

(async () => {
  const db = loadDb();
  const rSnap = await db.collection("companies").doc(COMPANY).collection("routes").get();
  const stops = [];
  for (const r of rSnap.docs) {
    const rd = r.data() || {};
    const rp = Array.isArray(rd.routePath) ? rd.routePath : [];
    const sSnap = await r.ref.collection("stops").orderBy("order", "asc").get();
    for (const s of sSnap.docs) {
      const sd = s.data() || {};
      const c = ll(sd);
      if (!c) continue;
      stops.push({
        routeName: rd.name || r.id, stopName: sd.name || s.id,
        lat: c.lat, lng: c.lng, hasPhoto: !!sd.photo,
        travel: travelBearingAt(rp, c),
      });
    }
  }
  const targets = LIMIT > 0 ? stops.slice(0, LIMIT) : stops;
  console.log(`\n대상 정류장 ${targets.length}개 (좌표 보유) · radius ${RADIUS}m · ${BASE}`);
  console.log(`  경로 방향을 알 수 있는 정류장: ${targets.filter((s) => s.travel !== null).length}개\n`);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "buslink-rv-"));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CHROME, headless: true, viewport: { width: 500, height: 400 },
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/bus`, { waitUntil: "domcontentloaded", timeout: 60000 });

  // 🔴 대조군: SDK 가 실제로 떴는지부터 확인한다. 안 떴는데 재면 전부 "없음"이 나온다.
  try {
    await page.waitForFunction(() => window.kakao && window.kakao.maps && window.kakao.maps.Roadview, { timeout: 30000 });
  } catch (e) {
    console.error("❌ 카카오 SDK 미로드 — 이 도메인이 콘솔에 등록돼 있는지 확인할 것. 측정 중단.");
    await ctx.close(); process.exit(1);
  }
  console.log("✓ 카카오 SDK 로드 확인\n");

  const results = [];
  const CHUNK = 20;
  for (let i = 0; i < targets.length; i += CHUNK) {
    const chunk = targets.slice(i, i + CHUNK);
    const out = await page.evaluate(async ({ items, radius }) => {
      const el = document.getElementById("__rvprobe") || (() => {
        const d = document.createElement("div");
        d.id = "__rvprobe";
        d.style.cssText = "position:fixed;left:-9999px;top:0;width:400px;height:300px;";
        document.body.appendChild(d); return d;
      })();
      const client = new window.kakao.maps.RoadviewClient();
      // 🔴 Roadview 인스턴스·리스너는 청크마다 새로 만들지 말고 재사용한다.
      //    그리고 `init` 은 **최초 1회만** 발화한다 — 이후 pano 교체는 `panoid_changed`.
      //    per-call 로 init 만 기다리면 첫 정류장 빼고 전부 타임아웃(=거짓 "파노라마 없음").
      if (!window.__rvProbe) {
        const rv0 = new window.kakao.maps.Roadview(el);
        const st = { rv: rv0, pending: null };
        const fire = () => { if (st.pending) { const f = st.pending; st.pending = null; f(); } };
        window.kakao.maps.event.addListener(rv0, "init", fire);
        window.kakao.maps.event.addListener(rv0, "panoid_changed", fire);
        window.__rvProbe = st;
      }
      const st = window.__rvProbe;
      const rv = st.rv;
      const res = [];
      for (const it of items) {
        const pos = new window.kakao.maps.LatLng(it.lat, it.lng);
        const panoId = await new Promise((ok) => {
          let done = false;
          const t = setTimeout(() => { if (!done) { done = true; ok(null); } }, 6000);
          client.getNearestPanoId(pos, radius, (id) => { if (!done) { done = true; clearTimeout(t); ok(id); } });
        });
        if (panoId === null || panoId === undefined) { res.push({ found: false }); continue; }
        // 앱과 동일하게 setPanoId(panoId, 정류장좌표) — 카카오가 그 좌표를 바라보게 맞춘다
        // 🔴 setPanoId 는 비동기다 — 직후에 getPosition() 을 읽으면 **이전 파노라마 좌표**가
        //    나온다(실측에서 8km·32km 짜리 거리가 그렇게 만들어졌다). 이벤트를 기다린 뒤에도
        //    getPanoId() 가 요청한 값이 될 때까지 폴링해서 확정한 다음 좌표를 읽는다.
        const changed = await new Promise((ok) => {
          let done = false;
          const t = setTimeout(() => { if (!done) { done = true; st.pending = null; ok(false); } }, 8000);
          st.pending = () => { if (!done) { done = true; clearTimeout(t); ok(true); } };
          rv.setPanoId(panoId, pos);
        });
        let info = null;
        if (changed) {
          for (let tries = 0; tries < 20; tries++) {
            if (rv.getPanoId && rv.getPanoId() === panoId) break;
            await new Promise((r) => setTimeout(r, 50));
          }
          try {
            const settled = !rv.getPanoId || rv.getPanoId() === panoId;
            const p = rv.getPosition(); const vp = rv.getViewpoint();
            info = settled ? { lat: p.getLat(), lng: p.getLng(), pan: vp && vp.pan } : null;
          } catch (e) { info = null; }
        }
        res.push(info ? { found: true, ...info } : { found: false, initTimeout: true });
      }
      return res;
    }, { items: chunk.map(({ lat, lng }) => ({ lat, lng })), radius: RADIUS });
    // 🔴 스프레드 순서 주의 — o 에도 lat/lng(파노라마 좌표)가 있어 그대로 펼치면
    //    정류장 좌표가 덮인다. 파노라마는 panoLat/panoLng 로 따로 담는다.
    out.forEach((o, k) => results.push({
      ...chunk[k],
      found: !!o.found,
      initTimeout: !!o.initTimeout,
      panoLat: o.found ? o.lat : null,
      panoLng: o.found ? o.lng : null,
      pan: o.found ? o.pan : null,
    }));
    process.stdout.write(`  ...${Math.min(i + CHUNK, targets.length)}/${targets.length}\r`);
  }
  await ctx.close();

  // ── 집계 ──────────────────────────────────────────────
  const found = results.filter((r) => r.found);
  const miss = results.filter((r) => !r.found);
  // 🔴 "파노라마 없음" 과 "init 미발화" 를 반드시 갈라서 센다 —
  //    한 통에 세면 하네스 자신의 결함을 데이터 결론으로 착각한다.
  const noPano = miss.filter((r) => !r.initTimeout);
  const timeout = miss.filter((r) => r.initTimeout);
  console.log(`\n\n[1] 파노라마 확보율`);
  console.log(`  있음 ${found.length}/${results.length} (${((found.length / results.length) * 100).toFixed(1)}%)`);
  console.log(`  파노라마 자체가 없음 ${noPano.length} — 앱에서 "거리뷰가 없습니다" + 사진 폴백`);
  console.log(`  init 미발화 ${timeout.length} — 파노라마는 있는데 하네스가 좌표를 못 읽음(측정 한계)`);
  const missNoPhoto = noPano.filter((r) => !r.hasPhoto);
  console.log(`    그중 사진도 없음: ${missNoPhoto.length}개 (탑승 위치 안내 수단이 0)`);

  console.log(`\n[2] 카메라 시점`);
  console.log(`  SDK 가 setPanoId(panoId, 정류장좌표) 로 호출 → 카카오가 그 좌표를 바라보게 초기 시점을 잡는다.`);
  console.log(`  = "엉뚱한 곳을 본다"는 구조적으로 성립하지 않는다(소스 확인).`);

  const sided = found.filter((r) => r.travel !== null);
  let left = 0, right = 0, farLeft = 0;
  const samples = [];
  for (const r of sided) {
    const stop = { lat: r.lat, lng: r.lng };
    const pano = { lat: r.panoLat, lng: r.panoLng };
    const d = distM(stop, pano);
    if (!Number.isFinite(d) || d > RADIUS + 60) continue; // 측정 오류분 제외
    const bStopToPano = bearing(stop, pano);
    const rel = angDiff(bStopToPano, r.travel); // +면 진행방향 오른쪽, -면 왼쪽
    const lateral = Math.abs(d * Math.sin(rad(rel)));
    if (rel < 0) { left++; if (lateral > 12) { farLeft++; samples.push({ ...r, d, lateral }); } } else right++;
  }
  console.log(`\n[3] 진행방향 기준 파노라마 위치 (경로 방향을 아는 ${sided.length}개)`);
  console.log(`  왼쪽 ${left} · 오른쪽 ${right}`);
  console.log(`  왼쪽이면서 측방 12m 초과(= 반대 차선 의심): ${farLeft}개`);
  if (samples.length) {
    console.log(`\n  의심 사례 상위 10:`);
    samples.sort((a, b) => b.lateral - a.lateral).slice(0, 10).forEach((s) => {
      console.log(`    ${s.routeName} / ${s.stopName} — 거리 ${s.d.toFixed(0)}m · 측방 ${s.lateral.toFixed(0)}m`);
    });
  }

  // 🔴 radius 밖 좌표는 데이터가 아니라 측정 오류다(파노라마는 정의상 radius 안에서 고른다).
  //    조용히 평균에 섞으면 결론이 통째로 틀어진다 → 세서 따로 보고한다.
  const bogus = found.filter((r) => distM({ lat: r.lat, lng: r.lng }, { lat: r.panoLat, lng: r.panoLng }) > RADIUS + 60);
  if (bogus.length) console.log(`\n⚠ radius 밖 좌표 ${bogus.length}건 — 측정 오류로 제외(집계에 넣지 않음)`);
  const ds = found
    .map((r) => distM({ lat: r.lat, lng: r.lng }, { lat: r.panoLat, lng: r.panoLng }))
    .filter((d) => Number.isFinite(d) && d <= RADIUS + 60)
    .sort((a, b) => a - b);
  if (ds.length) {
    const q = (p) => ds[Math.floor((ds.length - 1) * p)].toFixed(0);
    console.log(`\n[4] 정류장 ↔ 파노라마 거리: 중앙 ${q(0.5)}m · 90% ${q(0.9)}m · 최대 ${ds[ds.length - 1].toFixed(0)}m`);
  }
  console.log("");
  process.exit(0);
})().catch((e) => { console.error("실패:", e); process.exit(1); });
