// 승객 인증(2026-08-25 P1) 배포 전 확인 — 🔴 **읽기 전용**(prod 쓰기 0건).
//   node scripts/verify_passenger_auth.cjs
//
// ⚠ 이 파일은 **아무것도 쓰지 않는다**. 2026-08-25 에 "거부를 재는 호출이니 안전하다"고
//   넘겨짚고 하네스를 돌렸다가 prod 에 가짜 탑승 2건을 적재한 적이 있다. 여기서 하는 일은
//   ① 명부 문서 read ② 로컬 서명(createCustomToken) 뿐이고, 둘 다 Firestore 를 건드리지 않는다.
//   탑승 CF 를 실제로 호출해 거부를 재는 검사는 `scripts/test_board_static_auth.cjs` 쪽이며
//   그건 **배포 후에만** 돌린다.
//
// 보는 것:
//   ① 서버 해시식(hashPinAdmin)이 클라 해시식(hashPin)과 같은 값을 내는가
//   ② 그 식이 **실제 명부의 pinHash 와 맞는가** — 평문을 아는 검토용 계정(REVIEW/112233)으로 대조
//   ③ 로그인 실패 조건(명부 없음·비활성)에 걸리는 사람이 지금 몇 명인가 = 전환 회귀 표면
//   ④ createCustomToken 이 이 클레임 모양을 받아 주는가(예약 클레임·null 거부 확인)
// 🔴 ④ 는 **로컬 키로 서명**한 결과다 — 배포된 CF 는 런타임 서비스계정으로 서명하므로
//    `roles/iam.serviceAccountTokenCreator` 가 없으면 여기서 통과해도 배포 후 죽는다.
//    배포 후 첫 로그인 1건을 반드시 실측할 것.
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const ROOT = path.join(__dirname, "..");
const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
const sa = require(path.join(ROOT, "key", kf));
if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치");
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const COMPANY = "dy001";
const PIN_SALT = "buslink_salt_2026";
// functions/index.js `hashPinAdmin` 과 같아야 한다.
const hashPinAdmin = (pin) => crypto.createHash("sha256").update(String(pin) + PIN_SALT).digest("hex");
// src/lib/partner.js `hashPin` 과 같아야 한다(WebCrypto 경로 재현).
const hashPinClient = async (pin) => {
  const data = new TextEncoder().encode(pin + PIN_SALT);
  const buf = await crypto.webcrypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
};

// 평문을 아는 계정 — 대조군. 없으면 ② 는 건너뛴다(REVIEW 는 오픈 전 삭제 대상이라
// 언젠가 사라진다. 사라졌다고 실패로 보면 안 된다).
const KNOWN = [{ empNo: "REVIEW", pin: "112233" }];

let fail = 0;
const ok = (t) => console.log("  OK   " + t);
const bad = (t) => { fail++; console.log("  🔴   " + t); };

(async () => {
  // ── ① 해시식 일치 ──────────────────────────────────────────────────────
  console.log("\n① 서버/클라 해시식 일치");
  for (const pin of ["0000", "1234", "000000", "112233", "한글PIN"]) {
    const a = hashPinAdmin(pin), b = await hashPinClient(pin);
    if (a === b) ok(`pin=${JSON.stringify(pin)} → ${a.slice(0, 12)}…`);
    else bad(`pin=${JSON.stringify(pin)} 불일치 server=${a.slice(0, 12)} client=${b.slice(0, 12)}`);
  }

  const col = db.collection("companies").doc(COMPANY).collection("passengers");

  // ── ② 실제 명부와 대조 ────────────────────────────────────────────────
  console.log("\n② 실제 명부 pinHash 대조(평문 아는 계정)");
  let checked = 0;
  for (const k of KNOWN) {
    const snap = await col.doc(k.empNo).get();
    if (!snap.exists) { console.log(`  –    ${k.empNo} 없음(삭제됨) — 건너뜀`); continue; }
    checked++;
    const stored = (snap.data() || {}).pinHash;
    if (stored === hashPinAdmin(k.pin)) ok(`${k.empNo} 로그인 판정 통과`);
    else bad(`${k.empNo} pinHash 불일치 — 이 식으로는 로그인이 안 된다`);
  }
  if (!checked) console.log("  ⚠    대조군 0건 — ② 는 검증되지 않았다(①·④ 만으로는 부족)");

  // ── ③ 전환 회귀 표면 ──────────────────────────────────────────────────
  console.log("\n③ 전환 회귀 표면(로그인이 걸릴 수 있는 사람)");
  const all = await col.get();
  let noPin = 0, inactive = 0, noEmpNoField = 0, migratable = 0;
  all.forEach((d) => {
    const p = d.data() || {};
    if (!p.pinHash) noPin++;
    if (!p.active) inactive++;            // 🔴 `!active` — 기존 클라 로그인과 같은 판정
    if (!p.empNo) noEmpNoField++;
    if (p.lastLoginAt) migratable++;
  });
  console.log(`  명부 ${all.size}명`);
  (noPin ? bad : ok)(`pinHash 없음 ${noPin}명 (있으면 그 사람은 로그인 불가)`);
  (inactive ? bad : ok)(`!active ${inactive}명 (로그인 거부 대상)`);
  ok(`empNo 필드 없음 ${noEmpNoField}명 — 서버는 문서 ID 를 쓰므로 무해`);
  ok(`lastLoginAt 보유 ${migratable}명 = 승계(passengerMigrate) 대상 상한`);

  // ── ④ 커스텀 토큰 클레임 모양 ─────────────────────────────────────────
  console.log("\n④ createCustomToken 클레임 모양(로컬 키 서명)");
  try {
    const t = await admin.auth().createCustomToken(`passenger_${COMPANY}_TESTSHAPE`, {
      role: "passenger", companyId: COMPANY, empNo: "TESTSHAPE", partnerCode: "",
    });
    const claims = JSON.parse(Buffer.from(t.split(".")[1], "base64").toString()).claims;
    ok(`발급 성공 · claims=${JSON.stringify(claims)}`);
  } catch (e) {
    bad(`발급 실패: ${e.message}`);
  }
  console.log("  ⚠    배포된 CF 는 런타임 서비스계정으로 서명한다 —");
  console.log("       roles/iam.serviceAccountTokenCreator 없으면 배포 후 signBlob 거부로 죽는다.");

  console.log(fail ? `\n🔴 실패 ${fail}건 — 배포하지 말 것` : "\n전부 통과 — 배포 전 확인 완료(런타임 IAM 은 별도)");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
