// 거래처 문의 게시판 켜기/끄기 (2026-08-06)
//   node scripts/set_inquiry_board.cjs                       — 현황만
//   node scripts/set_inquiry_board.cjs <거래처이름일부> <tenantId> [--token T] [--apply]
//   node scripts/set_inquiry_board.cjs <거래처이름일부> --off [--apply]
//
// dry-run 이 기본(쓰기 0). `--apply` 를 붙여야 실제로 쓴다.
// 관리자 화면(협력사 관리 ⚙️ 포탈 설정)에서도 똑같이 할 수 있다 — 이 스크립트는
// 현황 일람과 되돌리기용.
//
// 🔴 tenantId 는 **dycs `tenants/{id}`** 문서 ID 다(buslink 업체코드와 다른 체계).
//    실제로 그 거래처가 뜨는지 `node scripts/headless_check_inquiry_embed.cjs <tenantId>` 로 먼저 확인할 것.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const COMPANY = "dy001";

// 판정은 앱과 **같은 소스**를 쓴다(재구현 금지 — 여기서만 유효하다고 판정하면 앱에서 안 켜진다).
const inqCtx = { URLSearchParams };
vm.createContext(inqCtx);
vm.runInContext(
  fs.readFileSync(path.join(ROOT, "src/lib/inquiry.js"), "utf8").replace(/^export\s+/gm, ""),
  inqCtx,
);
const { resolveInquiryConfig, isValidTenantId, buildInquiryPreviewUrl } = inqCtx;

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const OFF = args.includes("--off");
const tokenIdx = args.indexOf("--token");
const TOKEN = tokenIdx >= 0 ? args[tokenIdx + 1] : null;
const positional = args.filter((a, i) =>
  !a.startsWith("--") && !(tokenIdx >= 0 && i === tokenIdx + 1));
const [QUERY, TENANT] = positional;

function loadDb() {
  const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
  const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
  const sa = require(path.join(ROOT, "key", kf));
  if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치: " + sa.project_id);
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  return admin.firestore();
}

(async () => {
  const db = loadDb();
  const snap = await db.collection("partnerCodes").where("companyId", "==", COMPANY).get();
  const codes = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));

  console.log("\n── 거래처별 문의 게시판 현황 ──");
  for (const c of codes) {
    const cfg = resolveInquiryConfig(c);
    console.log(`  ${cfg.enabled ? "🟢 켜짐" : "⚪ 꺼짐"}  ${String(c.partnerName || c.id).padEnd(20)}` +
      `${cfg.tenantId ? ` → dycs:${cfg.tenantId}` : ""}`);
  }

  if (!QUERY) {
    console.log("\n(현황만 표시. 변경하려면 거래처 이름 일부와 tenantId 를 주세요)");
    process.exit(0);
  }

  const matches = codes.filter((c) => String(c.partnerName || c.id).includes(QUERY));
  if (matches.length !== 1) {
    console.log(`\n🔴 '${QUERY}' 로 거래처가 ${matches.length}곳 잡힙니다` +
      (matches.length ? ` — ${matches.map((m) => m.partnerName).join(", ")}` : "") + ". 더 구체적으로 주세요.");
    process.exit(1);
  }
  const target = matches[0];

  let next;
  if (OFF) {
    next = { enabled: false, tenantId: target.inquiry?.tenantId || null, token: target.inquiry?.token || null };
  } else {
    if (!isValidTenantId(TENANT || "")) {
      console.log("\n🔴 dycs 거래처 ID 를 주세요(영문·숫자·- _). 예: node scripts/set_inquiry_board.cjs 신촌 sev --apply");
      process.exit(1);
    }
    next = { enabled: true, tenantId: TENANT.trim(), token: TOKEN ? TOKEN.trim() : (target.inquiry?.token || null) };
  }

  const before = resolveInquiryConfig(target);
  console.log(`\n대상: ${target.partnerName}  (${target.id})`);
  console.log(`  변경 전: ${before.enabled ? "켜짐" : "꺼짐"}${before.tenantId ? ` → ${before.tenantId}` : ""}`);
  console.log(`  변경 후: ${next.enabled ? "켜짐" : "꺼짐"}${next.tenantId ? ` → ${next.tenantId}` : ""}` +
    `${next.token ? " (토큰 있음)" : ""}`);
  if (next.enabled) console.log(`  위젯: ${buildInquiryPreviewUrl(next.tenantId, next.token)}`);

  if (!APPLY) { console.log("\n(dry-run — 쓰기 0. 실제로 바꾸려면 --apply)"); process.exit(0); }

  await db.collection("partnerCodes").doc(target.id).set({ inquiry: next }, { merge: true });
  const after = resolveInquiryConfig((await db.collection("partnerCodes").doc(target.id).get()).data());
  console.log(`\n✅ 저장 완료 — 재조회 결과: ${after.enabled ? "켜짐" : "꺼짐"}${after.tenantId ? ` → ${after.tenantId}` : ""}`);
  console.log("   승객 앱은 **다음 접속부터** 반영됩니다(앱이 로그인 시 거래처 문서를 1회 읽습니다).");
  process.exit(0);
})().catch((e) => { console.error("🔴", e.message); process.exit(1); });
