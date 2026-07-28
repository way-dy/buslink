// 격리 테스트 — 도착 임박 알림 시간표 폴백 판정(functions/index.js `dueStopsBySchedule`).
//   node scripts/test_prearrival_schedule.cjs
//
// 이 함수가 잘못되면 **알림 폭탄**(과거분 대량 발송·매분 중복)이 나므로 경계를 촘촘히 본다.
// 실제 소스에서 함수를 뽑아 평가한다 — 구현이 바뀌면 이 테스트가 같이 깨져야 한다.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "functions", "index.js"), "utf8");
const grab = (name) => {
  const m = src.match(new RegExp(`function ${name}\\s*\\([\\s\\S]*?\\n\\}`));
  if (!m) throw new Error(`${name} 를 소스에서 못 찾음`);
  return m[0];
};
const constOf = (name) => {
  const m = src.match(new RegExp(`const ${name}\\s*=\\s*([0-9]+)`));
  return m ? Number(m[1]) : null;
};

const ctx = vm.createContext({ console });
vm.runInContext(grab("hhmmToMinutes"), ctx);
vm.runInContext(`var PRE_ARRIVAL_LEAD_MIN_DEFAULT = ${constOf("PRE_ARRIVAL_LEAD_MIN_DEFAULT")};`, ctx);
vm.runInContext(grab("dueStopsBySchedule"), ctx);
const { dueStopsBySchedule } = ctx;

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${x !== undefined ? " — " + JSON.stringify(x) : ""}`); } };
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b), { actual: a, expected: b });

// 07:00 출발, 정류장 4개(진입 +0 / +10 / +20 / +35분) → 예정 07:00·07:10·07:20·07:35
const STOPS = [
  { id: "s1", name: "출발지", offsetMin: 0 },
  { id: "s2", name: "판교역", offsetMin: 10 },
  { id: "s3", name: "강남역", offsetMin: 20 },
  { id: "s4", name: "회사", offsetMin: 35 },
];
const DEPART = "07:00";
const at = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const due = (hhmm, extra = {}) => dueStopsBySchedule({ stops: STOPS, departTime: DEPART, nowMin: at(hhmm), leadMin: 5, notified: [], ...extra });

console.log("\n[1] lead 창 안의 정류장만 잡는다(기본 5분)");
eq("06:56 → 출발지(4분 뒤)", due("06:56").map(d => d.stopId), ["s1"]);
eq("07:06 → 판교역(4분 뒤)", due("07:06").map(d => d.stopId), ["s2"]);
eq("07:00 정각(남은 0분) → 없음", due("07:00").map(d => d.stopId), []);
eq("07:03 → 아직 판교역까지 7분이라 없음", due("07:03").map(d => d.stopId), []);
eq("남은 분 계산", due("07:06")[0].minutesLeft, 4);
eq("정류장 이름 전달", due("07:06")[0].name, "판교역");

console.log("\n[2] 🔴 지난 정류장엔 절대 안 보낸다(배포 직후 과거분 대량 발송 차단)");
eq("07:30 시점 — 이미 지난 3곳 제외", due("07:30").map(d => d.stopId), ["s4"]);
eq("운행 한참 뒤(09:00) → 없음", due("09:00").map(d => d.stopId), []);
eq("전날 밤(23:50) → 없음", due("23:50").map(d => d.stopId), []);

console.log("\n[3] 경계 — lead 정확히 걸치는 값");
eq("정확히 5분 전은 포함", due("06:55").map(d => d.stopId), ["s1"]);
eq("6분 전은 제외", due("06:54").map(d => d.stopId), []);
eq("1분 전 포함", due("06:59").map(d => d.stopId), ["s1"]);

console.log("\n[4] 🔴 멱등 — 이미 보낸 마커는 다시 안 보낸다(매분 실행이라 이게 없으면 폭탄)");
eq("마커 있으면 제외", due("07:06", { notified: ["s2:pre1"] }).map(d => d.stopId), []);
eq("실측 경로가 남긴 마커도 존중", due("06:56", { notified: ["s1:pre1"] }).map(d => d.stopId), []);
ok("pre2 마커는 우리 판정과 무관(우리는 pre1 만 사용)", due("06:56", { notified: ["s1:pre2"] }).length === 1);
eq("마커 형식", due("06:56")[0].marker, "s1:pre1");

console.log("\n[5] lead 를 늘리면 더 일찍·여러 개도 잡힌다");
{
  const wide = due("06:55", { leadMin: 20 });
  eq("20분 창이면 출발지+판교역", wide.map(d => d.stopId), ["s1", "s2"]);
  ok("가까운 순 정렬", wide[0].minutesLeft < wide[1].minutesLeft, wide.map(d => d.minutesLeft));
  eq("leadMin 0·음수는 기본값으로", due("06:56", { leadMin: 0 }).map(d => d.stopId), ["s1"]);
  eq("leadMin 결측도 기본값", due("06:56", { leadMin: undefined }).map(d => d.stopId), ["s1"]);
}

console.log("\n[6] 시간표가 없는 정류장·노선은 건너뛴다(87%만 offsetMin 보유)");
{
  const mixed = [{ id: "a", name: "A", offsetMin: null }, { id: "b", name: "B", offsetMin: 10 }];
  eq("offsetMin 없는 정류장 제외", dueStopsBySchedule({ stops: mixed, departTime: DEPART, nowMin: at("07:06"), leadMin: 5, notified: [] }).map(d => d.stopId), ["b"]);
  eq("departTime 없으면 아무것도 안 함", dueStopsBySchedule({ stops: STOPS, departTime: null, nowMin: at("07:06"), leadMin: 5, notified: [] }), []);
  eq("departTime 형식 이상", dueStopsBySchedule({ stops: STOPS, departTime: "이상한값", nowMin: at("07:06"), leadMin: 5, notified: [] }), []);
  eq("offsetMin 이 문자열이면 제외", dueStopsBySchedule({ stops: [{ id: "x", offsetMin: "10" }], departTime: DEPART, nowMin: at("07:06"), leadMin: 5, notified: [] }), []);
}

console.log("\n[7] 결측 입력에 throw 하지 않는다");
eq("stops null", dueStopsBySchedule({ stops: null, departTime: DEPART, nowMin: 0, leadMin: 5, notified: [] }), []);
eq("notified null", due("06:56", { notified: null }).map(d => d.stopId), ["s1"]);
ok("빈 객체", Array.isArray(dueStopsBySchedule({})));

console.log("\n[8] 안전장치가 소스에 실제로 있는지(주석 아닌 코드로 단언)");
{
  const fn = src.match(/exports\.notifyPreArrivalBySchedule[\s\S]*?\n\);/)[0];
  ok("회사별 옵트인 게이트", /preArrivalScheduleFallback\s*!==\s*true/.test(fn));
  ok("GPS 신선하면 건너뜀", /freshVeh\.has\(dv\.vehicleId\)/.test(fn));
  ok("실측과 같은 마커 사용", /threshold:\s*"pre1"/.test(fn));
  ok("시간표 기반임을 메시지에 표시", /scheduleBased:\s*true/.test(fn));
  ok("대상 0명이면 마커 미기록", /tokens\.length === 0\) continue;/.test(fn));
  const msg = src.match(/function buildPreArrivalMessage[\s\S]*?\n\}/)[0];
  ok("문구가 예정 시각 기준임을 밝힘", /예정 시각 기준/.test(msg));
  ok("소비측 구분용 source 필드", /source:\s*scheduleBased/.test(msg));
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
