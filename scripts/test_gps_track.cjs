// 격리 테스트 — 운행 이력 GPS 궤적 분해(src/lib/gpsTrack.js).
//   node scripts/test_gps_track.cjs
//
// 배경(2026-08-18 way 점검 "경로가 정확하지 않고 직선으로 나온다"):
//   prod 실측으로 확정된 것 — 신고 배차([한남1] 등교 · 서울72바6859 · 2026-08-18)의
//   45개 포인트는 **간격이 전부 50~74초, 3분 넘는 공백 0회**였고, 점간 거리는
//   `0,0,0,332,0,544,0,385,0,678,0,1302,…` 로 **정확히 한 칸 걸러 0** 이었다.
//   = 서버 폴러는 1분마다 도는데 단말 원천(busin)은 2분마다 좌표를 준다 → 같은 좌표를
//     두 번 기록하고, **좌표가 실제로 바뀌는 간격은 2분·그 사이 거리는 중앙 463m**.
//   그래서 지도의 선은 굽을 수가 없다(표본 간격 문제이지 그리기 결함이 아니다).
//
// 이 테스트가 지키는 계약 4가지:
//   ① 정상 단말 간격(50~120초)을 **공백으로 오판하지 않는다** — 오판하면 화면이 온통 점선이 된다.
//   ② 진짜 공백(3분 초과)은 구간을 끊고 점선 대상으로 분리한다.
//   ③ 통계는 **동일 좌표 재기록을 분리**한다 — 섞으면 점간 중앙이 0m 로 나와 화면이 거짓말을 한다.
//   ④ 빈 좌표를 (0,0) 으로 통과시키지 않는다(대서양 점).
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "src", "lib", "gpsTrack.js");
const raw = fs.readFileSync(SRC, "utf8");
const src = raw
  .replace(/^export\s+function\s+/gm, "function ")
  .replace(/^export\s+const\s+/gm, "var ");
const ctx = vm.createContext({ console });
vm.runInContext(src, ctx);
const { trackSegments, formatDuration, TRACK_GAP_SEC, tsToMs, metersBetween } = ctx;

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${x !== undefined ? " — " + JSON.stringify(x) : ""}`); } };

// 좌표를 동/북으로 미터만큼 옮긴다(경도 1도 ≈ 88km @ 위도 37.5).
const MOVE = (base, m) => ({ lat: base.lat, lng: base.lng + m / 88000 });
const BASE = { lat: 37.5342, lng: 126.9946 };
const T0 = Date.UTC(2026, 7, 17, 21, 20, 0); // 2026-08-18 06:20 KST

/** 실측 재현 — 간격(초)·점간거리(m) 배열을 그대로 태워 포인트 열을 만든다. */
function buildTrack(gapSecs, stepMs) {
  const pts = [{ id: "p0", idx: 1, ...BASE, ts: T0 }];
  let t = T0, dist = 0;
  for (let i = 0; i < gapSecs.length; i++) {
    t += gapSecs[i] * 1000;
    dist += stepMs[i];
    pts.push({ id: `p${i + 1}`, idx: i + 2, ...MOVE(BASE, dist), ts: t });
  }
  return pts;
}

// ── prod 실측값(2026-08-18 [한남1] 등교 · 서울72바6859 · 화면 표시분 45점) ──
const REAL_GAPS = [50,63,57,57,71,52,66,55,69,64,48,69,53,58,74,44,60,60,68,57,54,74,49,58,71,50,71,58,57,56,57,60,66,63,53,61,61,60,58,72,46,62,66,60];
const REAL_STEPS = [0,0,0,332,0,544,0,385,0,678,0,1302,0,315,0,184,0,446,0,373,0,463,0,252,0,673,0,702,0,533,0,1381,0,800,0,281,0,4,0,2,0,2,1,1175];

console.log("\n[0] 신호 유무 검사 — 표본이 실제로 그 성질을 갖고 있는가");
ok("실측 표본 45점", REAL_GAPS.length + 1 === 45, REAL_GAPS.length + 1);
ok("실측에 동일 좌표(0m) 구간이 실재", REAL_STEPS.filter(s => s === 0).length === 22, REAL_STEPS.filter(s => s === 0).length);
ok("실측에 1km 넘는 직선 구간이 실재", REAL_STEPS.filter(s => s > 1000).length === 3, REAL_STEPS.filter(s => s > 1000).length);
ok("실측 간격은 전부 3분 이내(=공백 없음이 정답)", REAL_GAPS.every(g => g <= TRACK_GAP_SEC));

console.log("\n[1] 실측 재현 — 정상 표본을 공백으로 오판하지 않는다");
{
  const t = trackSegments(buildTrack(REAL_GAPS, REAL_STEPS));
  ok("공백 0회", t.gaps.length === 0, t.gaps.length);
  ok("연속 구간 1개(선이 끊기지 않는다)", t.runs.length === 1, t.runs.length);
  ok("구간에 45점 전부", t.runs[0].length === 45, t.runs[0].length);
  console.log("   stats:", JSON.stringify(t.stats));
  ok("기록 45개", t.stats.count === 45, t.stats.count);
  ok("동일 좌표 재기록 22개", t.stats.duplicates === 22, t.stats.duplicates);
  ok("기록 간격 중앙 ≈60초", t.stats.medianGapSec === 60, t.stats.medianGapSec);
  // 🔴 이 두 값이 이 테스트의 핵심 — 화면에 뜨는 숫자가 실제와 맞는가.
  ok("좌표 갱신 간격 중앙 ≈2분(폴링 1분과 다르다)", t.stats.medianMoveGapSec >= 110 && t.stats.medianMoveGapSec <= 130, t.stats.medianMoveGapSec);
  ok("점 사이 중앙 ≈463m(0m 섞으면 0 이 된다)", t.stats.medianStepM >= 350 && t.stats.medianStepM <= 500, t.stats.medianStepM);
  // 표본은 실측 거리 배열을 경도 근사(88km/도)로 재구성한 것이라 0.3% 오차가 있다.
  ok("최대 직선 ≈1381m", Math.abs(t.stats.maxStepM - 1381) <= 10, t.stats.maxStepM);
}

console.log("\n[1b] 대조 — 동일 좌표를 섞어 세면 점 사이 중앙이 사실상 0m 가 된다(옛 잣대 재현)");
{
  const allSteps = [...REAL_STEPS].sort((a, b) => a - b);
  const naive = allSteps[Math.floor(allSteps.length / 2)];
  ok("섞어 세면 ≤2m(=화면이 거짓말을 한다)", naive <= 2, naive);
  const moved = REAL_STEPS.filter(s => s > 0).sort((a, b) => a - b);
  ok("이동 구간만 세면 447m 대(실제)", moved[Math.floor(moved.length / 2)] >= 300, moved[Math.floor(moved.length / 2)]);
}

console.log("\n[2] 진짜 신호 공백 — 3분 초과만 끊는다");
{
  const t = trackSegments(buildTrack([60, 60, 361, 60, 60], [400, 400, 8200, 400, 400]));
  ok("공백 1회", t.gaps.length === 1, t.gaps.length);
  ok("공백 361초", t.gaps[0].sec === 361, t.gaps[0].sec);
  ok("공백 거리 8200m 근사", Math.abs(t.gaps[0].meters - 8200) < 20, t.gaps[0].meters);
  ok("연속 구간 2개로 분리", t.runs.length === 2, t.runs.map(r => r.length));
  ok("공백 구간이 실선 runs 에 포함되지 않음",
    !t.runs.some(r => r.some((p, i) => i > 0 && Math.abs(metersBetween(r[i - 1], p) - 8200) < 20)));
}
{
  const t = trackSegments(buildTrack([180, 181], [500, 500]));
  ok("정확히 180초는 공백 아님(경계)", t.gaps.length === 1 && t.gaps[0].sec === 181, t.gaps.map(g => g.sec));
}

console.log("\n[3] 좌표 위생 — 빈 값이 (0,0) 대서양 점이 되지 않는다");
{
  const t = trackSegments([
    { lat: 37.5, lng: 127.0, ts: T0 },
    { lat: "", lng: "", ts: T0 + 60000 },
    { lat: null, lng: 127.0, ts: T0 + 120000 },
    { lat: 37.51, lng: 127.0, ts: T0 + 180000 },
  ]);
  ok("유효 2점만 남음", t.stats.count === 2, t.stats.count);
  ok("(0,0) 점 없음", !t.runs.flat().some(p => p.lat === 0 && p.lng === 0));
}
ok("문자열 좌표는 숫자로 흡수", trackSegments([{ lat: "37.5", lng: "127.0", ts: T0 }, { lat: "37.6", lng: "127.0", ts: T0 + 60000 }]).stats.count === 2);

console.log("\n[4] 시각을 모르면 공백이라 하지 않는다(모르는 것을 지어내지 않음)");
{
  const t = trackSegments([
    { lat: 37.5, lng: 127.0, ts: null },
    { lat: 37.6, lng: 127.0, ts: null },
    { lat: 37.7, lng: 127.0, ts: null },
  ]);
  ok("공백 0회", t.gaps.length === 0, t.gaps.length);
  ok("한 구간으로 이어짐", t.runs.length === 1 && t.runs[0].length === 3);
  ok("간격 통계는 null", t.stats.medianGapSec === null, t.stats.medianGapSec);
}

console.log("\n[5] 빈 입력·1점");
ok("빈 배열", trackSegments([]).runs.length === 0);
ok("null 입력 throw 없음", trackSegments(null).stats.count === 0);
ok("1점이면 선 없음", trackSegments([{ lat: 37.5, lng: 127, ts: T0 }]).runs.length === 0);

console.log("\n[6] tsToMs — Firestore Timestamp / number / 문자열 / null");
ok("toMillis", tsToMs({ toMillis: () => 1234 }) === 1234);
ok("toDate", tsToMs({ toDate: () => new Date(5000) }) === 5000);
ok("number", tsToMs(777) === 777);
ok("ISO 문자열", tsToMs("2026-08-18T00:00:00Z") === Date.UTC(2026, 7, 18));
ok("null", tsToMs(null) === null);
ok("쓰레기 문자열", tsToMs("아무거나") === null);

console.log("\n[7] formatDuration");
ok("초", formatDuration(45) === "45초", formatDuration(45));
ok("분", formatDuration(120) === "2분", formatDuration(120));
ok("분+초", formatDuration(361) === "6분 1초", formatDuration(361));
ok("null", formatDuration(null) === "–");

console.log("\n[8] 소스 회귀 가드 — 복원 금지 규칙이 코드에 실제로 있는가");
{
  const admin = fs.readFileSync(path.join(__dirname, "..", "src", "pages", "AdminApp.js"), "utf8");
  ok("운행 이력이 전 포인트를 한 줄 실선으로 되돌리지 않음",
    !/const path = points\.map/.test(admin));
  ok("연속 구간을 track.runs 로 그린다", /track\.runs\.map/.test(admin));
  ok("공백은 점선(shortdash)", /track\.gaps\.map[\s\S]{0,400}shortdash/.test(admin));
  ok("등록 노선 경로(routePath) 밑선을 그린다", /drawnRoute\.length>=2&&<Polyline/.test(admin));
  ok("routePath 는 toLatLngPath 로 정규화", /toLatLngPath\(\s*\n?\s*routes\.find/.test(admin));
  ok("관제 차량 마커는 버스 아이콘", /<Icon name="bus"[\s\S]{0,200}/.test(admin));
  ok("관제 마커 신선도 임계는 5분(60초 아님)", /MARKER_STALE_MS = 5 \* 60 \* 1000/.test(admin));
  const lib = raw;
  ok("동일 좌표를 이동 통계에서 제외", /meters === 0/.test(lib) && /steps\.push\(meters\)/.test(lib));
}

console.log(`\n${fail === 0 ? "✅ 전부 통과" : "❌ 실패 있음"} — ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
