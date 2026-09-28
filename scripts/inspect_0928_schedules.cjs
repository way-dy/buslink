// 읽기 전용 — 9/28 배차 미표시 후속(ZKe91r2Y [2]). 오늘 손댄 일정과 9/28 배차 대조.
const admin = require("../functions/node_modules/firebase-admin");
const path = require("path"); const fs = require("fs");
const keyDir = path.join(__dirname, "..", "key");
const key = JSON.parse(fs.readFileSync(path.join(keyDir, fs.readdirSync(keyDir).find(f => f.endsWith(".json")))));
if (key.project_id !== "buslink-prod") throw new Error("project mismatch");
admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();
const DAY = process.argv[2] || "2026-09-28";
(async () => {
  const cid = "dy001";
  const sch = await db.collection(`companies/${cid}/dispatchSchedules`).get();
  const disp = await db.collection(`companies/${cid}/dispatches/${DAY}/list`).get();
  const bySch = new Map(); disp.docs.forEach(d => { const s = d.data().scheduleId; if (s) bySch.set(s, d.id); });
  console.log(`${DAY} 배차 ${disp.size}건 (일정 산출 ${bySch.size})`);
  const t0 = new Date(DAY + "T00:00:00+09:00").getTime();
  const rows = [];
  sch.docs.forEach(d => {
    const s = d.data();
    const ts = x => x && x.toMillis ? x.toMillis() : 0;
    const touched = Math.max(ts(s.createdAt), ts(s.updatedAt));
    const inc = Array.isArray(s.includeDates) && s.includeDates.includes(DAY);
    if (touched >= t0 || inc) rows.push({ id: d.id, name: s.name || s.routeName, active: s.active, start: s.startDate, end: s.endDate, wd: (s.weekdays||[]).join(""), exH: s.excludeHolidays, inc, exc: (s.excludeDates||[]).includes(DAY), created: ts(s.createdAt) ? new Date(ts(s.createdAt)).toISOString() : "-", updated: ts(s.updatedAt) ? new Date(ts(s.updatedAt)).toISOString() : "-", disp: bySch.get(d.id) || "" });
  });
  console.log(`오늘 생성·수정 또는 includeDates 에 ${DAY}: ${rows.length}건`);
  rows.forEach(r => console.log(JSON.stringify(r)));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
