// 배차 일정 저장 직후 «그 일정만» 바로 펼친다 — 소스 가드(2026-09-28 개선요청 ZKe91r2YPz1QSmxvpErB 후속).
// 증상: 통합 운행일 「운행」·일정 저장 후 「지금 펼치기」를 또 눌러야 오늘 배차가 생겼다.
// 🔴 지키는 것: ① 저장·일괄 운행·활성 전환 세 경로가 펼침을 부른다 ② 반드시 scheduleIds 로 좁힌다
//    (회사 전체를 펼치면 오늘 손으로 지운 다른 일정의 배차가 되살아난다) ③ CF 는 scheduleIds 부재 시 기존 계약.
const fs = require("fs");
const path = require("path");
const app = fs.readFileSync(path.join(__dirname, "..", "src/pages/AdminApp.js"), "utf8");
const cf = fs.readFileSync(path.join(__dirname, "..", "functions/index.js"), "utf8");
let fail = 0;
const ok = (c, m) => { console.log(`${c ? "✅" : "❌"} ${m}`); if (!c) fail++; };

const helper = (app.match(/const expandSavedSchedules = async[\s\S]*?\n  };/) || [""])[0];
ok(helper.length > 0, "expandSavedSchedules 헬퍼가 있다");
ok(/scheduleIds:\s*list/.test(helper), "헬퍼가 scheduleIds 로 좁혀 호출한다");
ok(!/callable\(\{\s*companyId\s*\}\)/.test(helper), "헬퍼가 회사 전체 펼침을 부르지 않는다");
ok((app.match(/expandSavedSchedules\(/g) || []).length >= 4, "저장(수정·신규)·일괄 운행·활성 전환에서 부른다");
ok(/!isOff && done > 0\) tail = await expandSavedSchedules/.test(app), "일괄 「운행」이 적용 직후 펼친다");
ok(/if \(payload\.active\) \{ const msg = await expandSavedSchedules\(\[ref\.id\]\)/.test(app), "신규 일정은 활성일 때만 펼친다");
ok(!/다음 새벽 펼침부터 반영/.test(app), "옛 안내문(다음 새벽부터 반영)이 남아 있지 않다");

ok(/async function expandCompany\(companyId, onlyIds = null\)/.test(cf), "CF expandCompany 가 onlyIds 를 받는다");
ok(/if \(only && !only\.has\(sdoc\.id\)\) continue;/.test(cf), "CF 가 onlyIds 밖 일정을 건너뛴다");
ok(/if \(scheduleIds !== undefined\)/.test(cf), "CF 는 scheduleIds 부재 시 회사 전체(기존 「지금 펼치기」 계약)");

console.log(fail ? `\n❌ ${fail}건 실패` : "\n✅ 전부 통과");
process.exit(fail ? 1 : 0);
