#!/usr/bin/env node
'use strict';
// firebase.json hosting.postdeploy → 배포 직후 운영 화면 점검.
// 본체는 설정 저장소 scripts/smoke/smoke.mjs(브라우저 의존성이 거기 있다). 위로 올라가며 찾고,
// 없으면(이 저장소만 따로 클론한 PC) 건너뛴다 — 점검 도구 부재가 배포 실패가 되면 안 된다.
// 출처: 설정 저장소 scripts/gate-template/ (2026-09-23 · Dune 강연 적용 ⑦).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let dir = ROOT;
let smoke = null;
for (let i = 0; i < 6; i++) {
  dir = path.dirname(dir);
  const p = path.join(dir, 'scripts', 'smoke', 'smoke.mjs');
  if (fs.existsSync(p)) { smoke = p; break; }
}
if (!smoke) {
  console.log('postdeploy-smoke: 설정 저장소 scripts/smoke 를 못 찾음 — 운영 점검 건너뜀');
  process.exit(0);
}
const r = spawnSync(process.execPath, [smoke, ROOT], { stdio: 'inherit', env: process.env });
process.exit(r.status == null ? 1 : r.status);
