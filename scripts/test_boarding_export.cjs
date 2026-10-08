// 격리 테스트 — 탑승 기록 엑셀 내려받기(src/lib/boardingExport.js · 2026-10-08 최우석 `XG6BMPAt`).
//   node scripts/test_boarding_export.cjs
// 🔴 지키는 계약: ① 화면과 같은 판정식으로 거른다(파일 건수 = 화면 건수) ② 승객이 고른 정류장이 정본,
//    추정은 «위치 추정» 으로 밝힌다 ③ 시각은 KST ④ 기간 상한 ⑤ 명부 전체를 읽지 않는다.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(root, "src/lib/boardingExport.js"), "utf8").replace(/^export (const|function)/gm, "$1");
const ctx = vm.createContext({ module: { exports: {} }, Date, Math, Number, String, Array, Object });
vm.runInContext(src + "\nmodule.exports = { EXPORT_MAX_DAYS, EXPORT_HEADER, viaLabel, exportDateRange, kstTime, buildBoardingRows, exportFileName };", ctx);
const M = ctx.module.exports;

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${x !== undefined ? " — " + JSON.stringify(x) : ""}`); } };
const ts = (iso) => ({ toMillis: () => Date.parse(iso) });

console.log("\n[1] 기간");
const r = M.exportDateRange("2026-09-29", "2026-10-02");
ok("4일(월말 넘김)", r.days && r.days.join() === "2026-09-29,2026-09-30,2026-10-01,2026-10-02", r);
ok("하루", M.exportDateRange("2026-10-08", "2026-10-08").days.length === 1);
ok("역순 거부", !!M.exportDateRange("2026-10-08", "2026-10-01").error);
ok("31일 허용", M.exportDateRange("2026-09-01", "2026-10-01").days.length === 31);
ok("32일 거부(상한)", !!M.exportDateRange("2026-09-01", "2026-10-02").error);
ok("형식 오류 거부", !!M.exportDateRange("2026-9-1", "2026-10-02").error && !!M.exportDateRange("", "").error);

console.log("\n[2] 행");
const items = [
  { day: "2026-10-02", b: { boardedAt: ts("2026-10-01T22:31:05Z"), partnerCode: "P1", routeName: "06:30 김포", stopName: "풍무역", name: "홍길동", empNo: "100", vehicleNo: "경기70사1", via: "static" } },
  { day: "2026-10-01", b: { boardedAt: ts("2026-09-30T23:10:00Z"), partnerCode: null, routeName: "R", name: "김", empNo: "200", vehicleNo: "V", vehicleLat: 1, vehicleLng: 1, routeId: "r" } },
  { day: "2026-10-02", b: { boardedAt: ts("2026-10-01T21:50:00Z"), partnerCode: "P1", routeName: "06:30 김포", name: "이", empNo: "300", via: "nfc" } },
];
const rows = M.buildBoardingRows(items, {
  partnerNameOf: (c) => ({ P1: "신촌세브란스병원" })[c],
  deptOf: (e) => ({ 100: "총무팀" })[e],
  estimateStop: (b) => (b.vehicleLat ? "구래동" : null),
});
ok("머리 줄 + 3행", rows.length === 4 && rows[0].join() === M.EXPORT_HEADER.join());
ok("날짜 → 시각 순", rows.slice(1).map(x => x[0] + " " + x[1]).join("|") === "2026-10-01 08:10:00|2026-10-02 06:50:00|2026-10-02 07:31:05", rows.slice(1).map(x => x[0] + " " + x[1]));
ok("시각은 KST(UTC 22:31 → 07:31)", rows[3][1] === "07:31:05");
ok("협력사 이름으로", rows[3][2] === "신촌세브란스병원");
ok("협력사 없음 = 미지정", rows[1][2] === "미지정");
ok("승객이 고른 정류장 = «승객 선택»", rows[3][4] === "풍무역" && rows[3][5] === "승객 선택");
ok("없으면 위치로 추정하고 «위치 추정» 이라 밝힌다", rows[1][4] === "구래동" && rows[1][5] === "위치 추정");
ok("둘 다 없으면 빈칸(지어내지 않는다)", rows[2][4] === "" && rows[2][5] === "");
ok("소속", rows[3][8] === "총무팀" && rows[2][8] === "");
ok("탑승 방식", rows[3][10] === "고정 QR" && rows[2][10] === "NFC 카드" && rows[1][10] === "QR");
ok("빈 입력이면 머리 줄만", M.buildBoardingRows([], {}).length === 1);
ok("시각 없는 기록도 죽지 않는다", M.kstTime(null) === "" && M.buildBoardingRows([{ day: "2026-10-01", b: {} }]).length === 2);

console.log("\n[3] 파일 이름");
ok("기간", M.exportFileName("2026-10-01", "2026-10-07", "신촌세브란스병원") === "BusLink_탑승기록_신촌세브란스병원_2026-10-01_2026-10-07.xlsx");
ok("하루면 날짜 하나", M.exportFileName("2026-10-08", "2026-10-08", "전체") === "BusLink_탑승기록_전체_2026-10-08.xlsx");
ok("파일 이름에 못 쓰는 글자 제거", !/[\\/:*?"<>|]/.test(M.exportFileName("2026-10-08", "2026-10-08", 'A/B:"C"')));

console.log("\n[4] 소스 가드 — AdminApp 탑승 통계");
const app = fs.readFileSync(path.join(root, "src/pages/AdminApp.js"), "utf8");
const tab = app.slice(app.indexOf("function BoardingStatsTab"));
const body = tab.slice(0, tab.indexOf("\nfunction ", 10));
ok("화면 목록과 내려받기가 같은 판정식", /const filtered = boardings\.filter\(passesFilter\)/.test(body) && /if \(passesFilter\(b\)\) items\.push/.test(body));
ok("소속은 사번 30개씩 — 명부 전체를 읽지 않는다", /where\(documentId\(\), "in", emps\.slice\(i, i \+ 30\)\)/.test(body) && !/getDocs\(collection\(db, "companies", companyId, "passengers"\)\)/.test(body));
ok("기간 판정은 순수 모듈", /exportDateRange\(exportFrom, exportTo\)/.test(body));
ok("카카오 Map 에 가려진 new Map( 을 쓰지 않는다", !/new Map\(/.test(body));
ok("다운로드 버튼이 있다", /data-testid="boarding-export-open"/.test(body));

console.log(`\n${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
