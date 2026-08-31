#!/usr/bin/env node
'use strict';
// buslink — 격리 테스트 일괄 실행기 (배포 게이트)
//   node scripts/run-tests.cjs         # 부작용 없는 테스트 전부
//   node scripts/run-tests.cjs --list  # 실행하지 않고 대상만 보여준다
//   node scripts/run-tests.cjs --live  # + 자격증명/실발송이 필요한 것까지
//
// 왜 이제야 생겼나(2026-08-31 실측): `scripts/test_*.cjs` 가 **46개**인데 러너가 없어
//   한 번 쓰이고 다시 안 돌았다(30일 커밋 107건 — 이 저장소에서 가장 활발한데도).
//   실제로 **2건이 빨간 채 방치**돼 있었다: 홈페이지 탭 추가(2026-08-25)로 시그니처가 바뀌며
//   추출이 깨진 `test_inquiry_link`, 2열 드롭다운 제거(2026-08-26)로 지킬 대상이 사라진
//   `test_sidebar_scroll` ⑲. 둘 다 코드는 정상이었고 **테스트만 썩어 있었다** — 그 사이
//   진짜 회귀가 났어도 못 알아봤다. 러너가 그걸 막는다.
//
// 🔴 게이트 위치는 `firebase.json` hosting predeploy — 이 워크스페이스는
//    `firebase deploy --only hosting` 을 직접 치는 경로가 위임돼 있어 다른 곳에 걸면 빠져나간다.
//
// 🔴 제외는 휴리스틱이 아니라 **명시 표식**으로 한다(소스에 firebase-admin 이 보이면 제외 같은
//    추측으로 가르면 멀쩡한 회귀 가드가 조용히 게이트 밖에 남는다):
//      @requires-credentials … 실제 자격증명이 있어야 도는 것
//      @manual-only          … 돌리면 **바깥에 영향**을 준다(실제 알림톡 발송 등). 게이트 금지.
//
// 🔴 건너뛴 것은 개수와 이름을 반드시 찍는다(조용한 누락 금지).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = __dirname;
const ROOT = path.join(SCRIPTS, '..');
const SELF = path.basename(__filename);
const TIMEOUT_MS = Number(process.env.BL_TEST_TIMEOUT_MS || 120000);

const args = process.argv.slice(2);
const runLive = args.includes('--live');
const listOnly = args.includes('--list');

// 🔴 테스트가 두 곳에 흩어져 있다 — 한 곳만 훑으면 나머지가 조용히 게이트 밖에 남는다.
//    ① 프론트(admin/manager/driver.html) 검사 = `scripts/test-*.cjs` (접두)
//    ② 백엔드(Cloud Functions) 검사 = `functions/test/*.test.js` (접미)
//    ②도 러너 없이 방치돼 있었다(2026-08-31 실측 — 있는지도 모르고 지나칠 뻔했다).
const ROOTS = [
  // 이 저장소는 `test_*.cjs`(밑줄). 다른 프로젝트의 `test-*`·`*-test.cjs` 도 함께 받는다.
  { dir: SCRIPTS, match: (f) => f !== SELF && f.endsWith('.cjs') && (/^test[-_]/.test(f) || /-test\.cjs$/.test(f)) },
  { dir: path.join(ROOT, 'functions', 'test'), match: (f) => /\.test\.js$/.test(f) },
];

const all = [];
for (const r of ROOTS) {
  if (!fs.existsSync(r.dir)) continue;
  fs.readdirSync(r.dir).filter(r.match).sort()
    .forEach((f) => all.push({ file: path.join(r.dir, f), label: path.relative(ROOT, path.join(r.dir, f)).replace(/\\/g, '/') }));
}

const pure = [];
const live = [];
const manual = [];
for (const t of all) {
  const src = fs.readFileSync(t.file, 'utf8');
  if (/@manual-only/.test(src)) manual.push(t);
  else if (/@requires-credentials/.test(src)) live.push(t);
  else pure.push(t);
}

const targets = runLive ? [...pure, ...live] : pure;

if (listOnly) {
  console.log(`부작용 없음 ${pure.length}개:`);
  pure.forEach((t) => console.log("  " + t.label));
  console.log(`\n자격증명 필요 ${live.length}개 (--live 로만):`);
  live.forEach((t) => console.log("  " + t.label));
  console.log(`\n수동 전용 ${manual.length}개 (게이트에서 영구 제외 — 바깥에 영향):`);
  manual.forEach((t) => console.log("  " + t.label));
  process.exit(0);
}

if (!targets.length) {
  console.error('❌ 실행할 테스트가 없다 — scripts/test-*.cjs 가 사라졌는지 확인할 것');
  process.exit(1);
}

console.log(`▶ 격리 테스트 ${targets.length}개 실행${runLive ? ' (--live 포함)' : ''}`);
if (!runLive && live.length) console.log(`  (제외 ${live.length}개 · 자격증명 필요: ${live.map((t) => t.label).join(", ")})`);
if (manual.length) console.log(`  (제외 ${manual.length}개 · 수동 전용: ${manual.map((t) => t.label).join(", ")})`);
console.log('');

const failed = [];
for (const t of targets) {
  const r = spawnSync(process.execPath, [t.file], {
    encoding: 'utf8', timeout: TIMEOUT_MS, cwd: ROOT,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const timedOut = r.error && r.error.code === 'ETIMEDOUT';
  if (!timedOut && r.status === 0) {
    console.log(`✅ ${t.label}`);
  } else {
    failed.push(t.label);
    console.log(`❌ ${t.label}${timedOut ? ` (타임아웃 ${TIMEOUT_MS}ms)` : ''}`);
    out.trim().split('\n').slice(-12).forEach((l) => console.log('   ' + l));
  }
}

// 시행 기록 — "게이트가 실제로 뭘 잡나"를 나중에 사실로 답하기 위한 근거. 한 줄씩만 쌓는다.
function logRun(ok, failedList) {
  try {
    const head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', cwd: ROOT }).stdout.trim() || '-';
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    const logPath = path.join(SCRIPTS, 'gate-log.md');
    if (!fs.existsSync(logPath)) {
      fs.writeFileSync(logPath,
        '# 배포 게이트 시행 기록\n\n' +
        '> `run-tests.cjs` 가 실행마다 한 줄씩 append 한다(손으로 쓰지 말 것).\n' +
        '> `🔴 BLOCK` 줄이 나오면 그 밑에 원인 한 줄을 덧붙인다 — **진짜 회귀였나 / 낡은 테스트가 멀쩡한 변경을 막았나**.\n\n', 'utf8');
    }
    fs.appendFileSync(logPath,
      `- ${ts} | ${ok ? 'PASS' : '🔴 BLOCK'} ${targets.length - failedList.length}/${targets.length}` +
      `${ok ? '' : ' — ' + failedList.join(', ')} | ${head}\n`, 'utf8');
  } catch (e) {
    console.log('  (시행 기록 실패: ' + e.message + ')');
  }
}

console.log('');
if (failed.length) {
  logRun(false, failed);
  console.log(`❌ ${failed.length}/${targets.length} 실패: ${failed.join(', ')}`);
  console.log('   배포를 멈추고 원인을 먼저 가른다 — 내 변경이 만든 실패인지 `git stash` 로 베이스라인 대조.');
  console.log('   (원문을 grep 하는 테스트는 그 원문을 쪼개는 순간 빨개진다 — 파일 분리 커밋이었는지 먼저 볼 것.)');
  process.exit(1);
}
logRun(true, failed);
console.log(`✅ ${targets.length}/${targets.length} 통과`);
