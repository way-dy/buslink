// 격리 테스트 — 단말(유비칸) 차량 운행 이력 적재(functions/index.js
//   parseBusinFixMs · selectNewFixRows). node scripts/test_device_gps_history.cjs
//
// 2026-08-18 way 승인 건. 예전 폴러는 폴(1분)마다 **최신 1행만** `ts=폴 시각`으로 적재했다.
// 원천(busin)은 **2분에 한 번** 주므로 그 결과가 prod 실측으로 그대로 나왔다 —
//   [한남1] 등교 45점 중 **22개가 같은 좌표 재기록**, 기록 시각은 측정 시각과 최대 1분 어긋남,
//   폴이 밀리면 그 사이 원천 행은 유실(원천은 하루치를 다 주는데 마지막 것만 읽었다).
// 이 테스트가 지키는 계약:
//   ① 측정 시각을 초까지 정확히 KST 로 읽는다(오전 12시=자정 함정 포함)
//   ② 워터마크 이후 행만 적재 → **한 fix 당 정확히 1개**
//   ③ 워터마크가 없으면 최근 15분만(운행 창 밖 차고지 좌표를 통째 backfill 하지 않는다)
//   ④ 같은 초 중복·미래 시각 행을 버린다
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "functions", "index.js");
const raw = fs.readFileSync(SRC, "utf8");
// CF 전체는 firebase-functions 를 로드하므로 필요한 순수 함수만 오려서 태운다.
const cut = (name) => {
  const i = raw.indexOf(`function ${name}(`);
  if (i < 0) { console.error(`🔴 ${name} 를 CF 소스에서 못 찾음`); process.exit(1); }
  // 함수 끝 = 열 위치가 0 인 다음 `}` 줄
  const end = raw.indexOf("\n}\n", i);
  return raw.slice(i, end + 3);
};
const ctx = vm.createContext({ console });
vm.runInContext(cut("parseBusinFixMs") + "\n" + cut("selectNewFixRows"), ctx);
const { parseBusinFixMs, selectNewFixRows } = ctx;

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${x !== undefined ? " — " + JSON.stringify(x) : ""}`); } };
const KST = (y, mo, d, h, mi, s) => Date.UTC(y, mo - 1, d, h - 9, mi, s);

console.log("\n[1] parseBusinFixMs — prod 실제 문자열(오전/오후 12시간제)");
ok("오전 12:00:43 = 자정", parseBusinFixMs("2026-08-18 오전 12:00:43") === KST(2026, 8, 18, 0, 0, 43), parseBusinFixMs("2026-08-18 오전 12:00:43"));
ok("오전 5:10:43", parseBusinFixMs("2026-08-18 오전 5:10:43") === KST(2026, 8, 18, 5, 10, 43));
ok("오후 3:07:12 = 15:07:12", parseBusinFixMs("2026-08-18 오후 3:07:12") === KST(2026, 8, 18, 15, 7, 12));
ok("오후 12:30:00 = 정오", parseBusinFixMs("2026-08-18 오후 12:30:00") === KST(2026, 8, 18, 12, 30, 0));
ok("초가 없으면 0초", parseBusinFixMs("2026-08-18 오전 6:25") === KST(2026, 8, 18, 6, 25, 0));
ok("날짜 없으면 dateStr 보완", parseBusinFixMs("오전 7:03:05", "2026-08-18") === KST(2026, 8, 18, 7, 3, 5));
console.log("\n[1b] 24시간제 fallback — 🔴 날짜 숫자를 시각으로 오독하지 않는다");
ok("2026-08-18 14:05:09", parseBusinFixMs("2026-08-18 14:05:09") === KST(2026, 8, 18, 14, 5, 9), parseBusinFixMs("2026-08-18 14:05:09"));
ok("날짜만 있으면 null(시각 없음)", parseBusinFixMs("2026-08-18") === null, parseBusinFixMs("2026-08-18"));
console.log("\n[1c] 나쁜 입력");
ok("빈 문자열 null", parseBusinFixMs("") === null);
ok("null null", parseBusinFixMs(null) === null);
ok("쓰레기 null", parseBusinFixMs("아무거나") === null);
ok("범위 밖 시각 null", parseBusinFixMs("2026-08-18 오전 99:99:99") === null, parseBusinFixMs("2026-08-18 오전 99:99:99"));

// ── prod 실측 구조 재현: 원천 2분 간격, 폴러 1분 주기 ──
const T0 = KST(2026, 8, 18, 6, 25, 0);
const FIXES = Array.from({ length: 20 }, (_, i) => ({ ms: T0 + i * 120000, lat: 37.5 + i * 0.001, lng: 127 }));

console.log("\n[0] 신호 유무 — 표본이 실제로 '원천 2분 · 폴 1분' 인가");
ok("fix 20개·간격 120초", FIXES.length === 20 && FIXES[1].ms - FIXES[0].ms === 120000);

console.log("\n[2] 폴을 1분마다 40회 돌려도 fix 당 정확히 1개만 적재된다");
{
  let watermark = null, total = 0;
  const ids = new Set();
  for (let poll = 0; poll < 40; poll++) {
    const now = T0 + poll * 60000 + 30000;               // 매분 30초에 폴
    const rows = FIXES.filter(f => f.ms <= now);         // 원천은 그 시점까지 하루치를 준다
    if (!rows.length) continue;
    const picked = selectNewFixRows(rows, watermark, now);
    picked.forEach(r => ids.add(Math.floor(r.ms / 1000)));
    total += picked.length;
    watermark = rows[rows.length - 1].ms;                // 폴러가 gps 문서에 남기는 값
  }
  ok(`적재 ${total}개 = fix 20개(중복 0)`, total === 20, total);
  ok("문서 ID(초) distinct 20개", ids.size === 20, ids.size);
}

console.log("\n[2b] 대조 — 옛 방식(폴마다 최신 1행)은 같은 좌표를 2배로 쌓는다");
{
  let old = 0;
  for (let poll = 0; poll < 40; poll++) {
    const now = T0 + poll * 60000 + 30000;
    if (FIXES.some(f => f.ms <= now)) old++;
  }
  ok(`옛 방식 ${old}개(= 실측 45점 중 22개 중복의 정체)`, old > 30, old);
}

console.log("\n[3] 폴이 밀려도 그 사이 행이 유실되지 않는다");
{
  const now = T0 + 20 * 60000;
  const picked = selectNewFixRows(FIXES.filter(f => f.ms <= now), T0 + 2 * 120000, now);
  ok("워터마크 이후 전부 회수", picked.length === 8, picked.length);
  ok("시각 오름차순", picked.every((r, i) => i === 0 || r.ms > picked[i - 1].ms));
}

console.log("\n[4] 워터마크가 없으면 최근 15분만(차고지 좌표 통째 backfill 금지)");
{
  const now = T0 + 40 * 60000; // 운행 40분 경과 시점
  const picked = selectNewFixRows(FIXES.filter(f => f.ms <= now), null, now);
  ok(`${picked.length}개만(=15분치 이내)`, picked.length <= 8 && picked.length >= 6, picked.length);
  ok("15분보다 오래된 행은 제외", picked.every(r => r.ms > now - 15 * 60000));
}

console.log("\n[5] 같은 초 중복·미래 시각 행");
{
  const now = T0 + 600000;
  const rows = [
    { ms: T0 + 60000, lat: 1, lng: 1 },
    { ms: T0 + 60000, lat: 2, lng: 2 },            // 같은 초 중복
    { ms: now + 10 * 60000, lat: 3, lng: 3 },      // 미래(원천 오류)
    { ms: T0 + 120000, lat: 4, lng: 4 },
  ];
  const picked = selectNewFixRows(rows, T0, now);
  ok("같은 초는 1개", picked.filter(r => Math.floor(r.ms / 1000) === Math.floor((T0 + 60000) / 1000)).length === 1);
  ok("미래 행 제외", !picked.some(r => r.ms > now + 60000));
  ok("2개 남음", picked.length === 2, picked.length);
}
ok("빈 입력 throw 없음", selectNewFixRows(null, null, Date.now()).length === 0);
ok("ms 없는 행 제외", selectNewFixRows([{ lat: 1, lng: 1 }], null, Date.now()).length === 0);

console.log("\n[6] 소스 회귀 가드 — 복원 금지 규칙이 CF 에 실제로 있는가");
ok("최신 1행만 add 하던 옛 적재가 없다",
  !/collection\("points"\)\s*\n\s*\.add\(\{ lat: latest\.lat/.test(raw));
ok("문서 ID 가 측정 시각(초) — 멱등", /batch\.set\(pcol\.doc\(`fix_\$\{Math\.floor\(r\.ms \/ 1000\)\}`\)/.test(raw));
ok("ts 는 측정 시각(폴 시각 아님)", /ts: admin\.firestore\.Timestamp\.fromMillis\(r\.ms\)/.test(raw));
ok("워터마크 lastFixMs 를 gps 문서에 남긴다", /lastFixMs: latestMs/.test(raw));
ok("15분 신선도 가드 유지", /\(nowMin - coordMin\) > 15/.test(raw));
ok("운행 시간 창·잔존 문서 정리는 그대로", /cleanupDeviceGpsDoc\(db, cid, vehicleId\)/.test(raw));

console.log(`\n${fail === 0 ? "✅ 전부 통과" : "❌ 실패 있음"} — ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
