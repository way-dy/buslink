// 노선명 형태 실측 — 2026-08-25 최우석 "조기출근 같은 특이사항을 진하게" 요청 설계용.
//   node scripts/inspect_route_name_shapes.cjs [거래처이름일부]
// 읽기 전용(prod 쓰기 0). 보는 것: ` - ` 뒤 꼬리표가 실제로 "특이사항"인지, 아니면 지명인지.
const path = require("path");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
const sa = require(path.join(ROOT, "key", kf));
if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치");
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const QUERY = process.argv[2] || "";

(async () => {
  const snap = await db.collection("companies").doc("dy001").collection("routes").get();
  const rows = [];
  snap.forEach((d) => {
    const r = d.data() || {};
    if (QUERY && !String(r.partnerName || "").includes(QUERY)) return;
    rows.push({ name: String(r.name || ""), partner: r.partnerName || "-", shift: r.shift || "", type: r.type || "" });
  });
  console.log(`\n노선 ${rows.length}개${QUERY ? ` (거래처 '${QUERY}')` : ""}`);

  // 후보 구분자별 적중 수 — 어느 규칙이 실제 데이터에 맞는지 센다.
  const RULES = [
    ["' - '(스페이스-하이픈-스페이스) 뒤", /^(.*)\s-\s([^-]+)$/],
    ["'-'(공백 없음) 뒤", /^(.*?)-([^-]+)$/],
    ["'/'(슬래시) 뒤 = 영문 병기", /^(.*?)\s*\/\s*(.+)$/],
  ];
  RULES.forEach(([label, re]) => {
    const hit = rows.filter((r) => re.test(r.name));
    console.log(`\n[${label}] ${hit.length}/${rows.length}건`);
    hit.slice(0, 12).forEach((r) => {
      const m = re.exec(r.name);
      console.log(`    ${r.name}`);
      console.log(`      → 앞 "${m[1].trim()}" · 뒤 "${m[2].trim()}"`);
    });
  });

  console.log("\n[전체 노선명]");
  rows.forEach((r) => console.log(`    ${r.partner.slice(0, 10).padEnd(12)} ${r.name}`));
  process.exit(0);
})();
