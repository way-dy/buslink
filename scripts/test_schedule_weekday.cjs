// 배차 일정 요일 계산 격리 테스트 (2026-07-27)
//   node scripts/test_schedule_weekday.cjs
//
// 배경: "월요일 배차가 화요일로 밀린다"(배시현). Cloud Functions 서버는 **UTC** 로 돌고
//   `Date.getDay()` 는 **로컬 시간대**를 탄다 → KST 자정(=전날 15:00 UTC)의 요일을 물으면
//   하루 전 요일이 나온다. 그래서 화요일 배차가 "월요일"로 판정돼 월요일 일정이 화요일에 생긴다.
//
// 이 테스트는 서버와 같은 조건(TZ=UTC)에서 옛 구현이 틀리고 새 구현이 맞음을 직접 보인다.
const assert = require("assert");

// 옛 구현(버그) — 로컬 시간대 의존
const dowOld = (s) => new Date(`${s}T00:00:00+09:00`).getDay();
// 새 구현 — 달력 계산으로 고정(시간대 무관)
const dowNew = (s) => new Date(`${s}T00:00:00Z`).getUTCDay();

// 실제 소스에서 새 구현을 뽑아 대조(구현이 바뀌면 이 테스트가 같이 깨지도록).
const fs = require("fs"), path = require("path");
// 주석은 회귀 가드 설명으로 `getDay()` 를 언급하므로 **호출 형태**를 정확히 단언한다
// (주석 제거 방식은 인용부호·이모지가 섞이면 신뢰하기 어렵다).
const fnSrc = fs.readFileSync(path.join(__dirname, "..", "functions", "index.js"), "utf8");
const body = (fnSrc.match(/function dayOfWeekKST\s*\([\s\S]*?\n\}/) || [""])[0];
const usesUtcDay = /return\s+dt\.getUTCDay\(\)/.test(body);
const usesLocalDay = /return\s+dt\.getDay\(\)/.test(body);   // 옛 버그 코드의 정확한 형태

const NAMES = ["일", "월", "화", "수", "목", "금", "토"];
// 2026-07-27(월) ~ 2026-08-02(일)
const WEEK = [
  ["2026-07-27", 1], ["2026-07-28", 2], ["2026-07-29", 3], ["2026-07-30", 4],
  ["2026-07-31", 5], ["2026-08-01", 6], ["2026-08-02", 0],
];

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${x ? " → " + x : ""}`); } };

console.log(`\n현재 TZ = ${process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone}`);

console.log("\n[1] 새 구현은 달력 요일과 일치");
for (const [d, want] of WEEK) ok(`${d} → ${NAMES[want]}`, dowNew(d) === want, `${NAMES[dowNew(d)]}`);

console.log("\n[2] 서버(UTC)에서 옛 구현은 하루 밀린다 = 신고 증상 재현");
{
  process.env.TZ = "UTC"; // node 는 프로세스 중간 TZ 변경이 즉시 반영되지 않을 수 있어 아래는 오프셋으로 직접 판정
  // KST 자정의 UTC 요일 = 전날 요일. 로컬이 UTC 인 서버에서 getDay() 가 그 값을 준다.
  const asServer = (s) => new Date(`${s}T00:00:00+09:00`).getUTCDay();
  for (const [d, want] of WEEK) {
    const got = asServer(d);
    const expectedShift = (want + 6) % 7;
    ok(`${d}(${NAMES[want]}) 를 서버는 ${NAMES[expectedShift]} 로 본다`, got === expectedShift, `${NAMES[got]}`);
  }
  // 월요일(1) 일정이 화요일에 펼쳐지는지 직접 확인
  const scheduleWeekdays = [1]; // 월요일만
  const expandedDays = WEEK.filter(([d]) => scheduleWeekdays.includes(asServer(d))).map(([d]) => d);
  ok("월요일 일정이 화요일(07-28)에 생성됨 = 신고 그대로", expandedDays.length === 1 && expandedDays[0] === "2026-07-28", expandedDays.join(","));
  const fixedDays = WEEK.filter(([d]) => scheduleWeekdays.includes(dowNew(d))).map(([d]) => d);
  ok("수정 후에는 월요일(07-27)에 생성됨", fixedDays.length === 1 && fixedDays[0] === "2026-07-27", fixedDays.join(","));
}

console.log("\n[3] 실제 소스가 수정된 구현을 쓰는지");
ok("functions/index.js dayOfWeekKST 가 getUTCDay 사용", usesUtcDay);
ok("로컬 시간대 의존 getDay() 잔존 없음", !usesLocalDay);

console.log("\n[4] 연/월 경계·윤년");
{
  const edge = [["2026-01-01", 4], ["2025-12-31", 3], ["2024-02-29", 4], ["2026-03-01", 0]];
  for (const [d, want] of edge) ok(`${d} → ${NAMES[want]}`, dowNew(d) === want, NAMES[dowNew(d)]);
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
assert.ok(true);
process.exit(fail ? 1 : 0);
