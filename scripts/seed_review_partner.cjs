// App Store 심사·스토어 스크린샷용 **데모 거래처** 생성/삭제 — 2026-10-07 승객앱 iOS 제출.
//
//   node scripts/seed_review_partner.cjs                  (현황만 · 쓰기 0)
//   REVIEW_PIN=xxxxxx node scripts/seed_review_partner.cjs --apply   (생성 · PIN 은 환경변수로만)
//   node scripts/seed_review_partner.cjs --remove --apply (전부 삭제)
//
// 🔴 실제 고객 데이터가 아니다. 심사관이 로그인해 볼 화면·스크린샷에 **실고객 이름·노선·정류장이
//    나오지 않게** 가상 이름으로 만든다(way: «스크린샷은 핵심 서비스 화면정보가 안 나오게»).
// 🔴 테마 없음 = BusLink 기본 화면. 카카오 테마를 켜면 5.2(타사 상표) 반려 위험(seed_sample_partner 와 다른 점).
// 🔴 PIN 은 저장소에 적지 않는다 — 실제로 로그인되는 운영 계정이다. App Store Connect «앱 심사 정보»에만 넣는다.
// 🔴 `fcmQueue` 는 만들지 않는다(만들면 실제 푸시가 나간다). 공지는 `notices` 만.
// 🔴 심사가 끝나도 지우지 말 것 — 업데이트 심사 때마다 같은 계정을 쓴다. 지우면 다음 심사가 «로그인 불가» 로 반려된다.
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const ROOT = path.join(__dirname, "..");
const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
const sa = require(path.join(ROOT, "key", kf));
if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치: " + sa.project_id);
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const APPLY = process.argv.includes("--apply");
const REMOVE = process.argv.includes("--remove");
const CID = "dy001";
const CODE = "DY001-BUSLINKDEMO-2026-REVW";
const NAME = "BusLink 데모";
const EMP = "APPREVIEW";

// 좌표는 seed_sample_partner 에서 지도로 읽어 둔 값을 재사용한다(도로 위 근사). 이름만 가상.
const P = {
  a: { lat: 37.27546, lng: 127.11594 },
  b: { lat: 37.26086, lng: 127.09153 },
  c: { lat: 37.22925, lng: 127.08675 },
};
const PATH = [
  { lat: 37.27546, lng: 127.11594 }, { lat: 37.27274, lng: 127.11088 }, { lat: 37.26986, lng: 127.10548 },
  { lat: 37.26734, lng: 127.10008 }, { lat: 37.26590, lng: 127.09468 }, { lat: 37.26374, lng: 127.09288 },
  { lat: 37.26086, lng: 127.09153 }, { lat: 37.25654, lng: 127.09108 }, { lat: 37.25366, lng: 127.09288 },
  { lat: 37.24790, lng: 127.09198 }, { lat: 37.24214, lng: 127.09108 }, { lat: 37.23638, lng: 127.09018 },
  { lat: 37.23062, lng: 127.08910 }, { lat: 37.22925, lng: 127.08675 },
];
const ROUTES = [
  { id: "review-demo-01", name: "[A] 출근 노선", code: "D1", type: "출근", departTime: "07:30", routePath: PATH,
    stops: [
      { name: "A 정류장", ...P.a, offsetMin: 0 },
      { name: "B 정류장", ...P.b, offsetMin: 12 },
      { name: "회사 정문", ...P.c, offsetMin: 30 },
    ] },
  { id: "review-demo-02", name: "[A] 퇴근 노선", code: "D2", type: "퇴근", departTime: "18:10", routePath: [...PATH].reverse(),
    stops: [
      { name: "회사 정문", ...P.c, offsetMin: 0 },
      { name: "B 정류장", ...P.b, offsetMin: 18 },
      { name: "A 정류장", ...P.a, offsetMin: 30 },
    ] },
];
const NOTICES = [
  { id: "review-notice-1", title: "출근 노선 운행 시간 안내", body: "다음 주 월요일부터 [A] 출근 노선이 07:30에 출발합니다.\n이용에 참고해 주세요." },
  { id: "review-notice-2", title: "우천 시 지연 운행 안내", body: "비가 많이 오는 날에는 5~10분 늦게 도착할 수 있습니다." },
];

const co = db.collection("companies").doc(CID);
const routeRef = (id) => co.collection("routes").doc(id);

(async () => {
  if (REMOVE) {
    console.log(`삭제 대상: ${CODE}`);
    if (!APPLY) { console.log("(dry-run — --apply 를 붙이면 지운다)"); return; }
    for (const r of ROUTES) {
      for (const s of (await routeRef(r.id).collection("stops").get()).docs) await s.ref.delete();
      await routeRef(r.id).delete();
    }
    for (const n of NOTICES) await co.collection("notices").doc(n.id).delete();
    await co.collection("passengers").doc(EMP).delete();
    await co.collection("passengerSecrets").doc(EMP).delete();
    await co.collection("fcmTokens").doc(EMP).delete();
    for (const s of (await co.collection("passengerSessions").where("empNo", "==", EMP).get()).docs) await s.ref.delete();
    await db.collection("partnerCodes").doc(CODE).delete();
    console.log("삭제 완료");
    return;
  }

  const exists = (await db.collection("partnerCodes").doc(CODE).get()).exists;
  console.log(`거래처 ${NAME} (${CODE}) — ${exists ? "이미 있음(덮어씀)" : "신규"}`);
  console.log(`노선 ${ROUTES.length} · 정류장 ${ROUTES.reduce((n, r) => n + r.stops.length, 0)} · 공지 ${NOTICES.length} · 승객 1(${EMP}) · 테마 없음(BusLink 기본)`);
  if (!APPLY) { console.log("(dry-run — 아무것도 쓰지 않았다)"); return; }
  const PIN = process.env.REVIEW_PIN || "";
  if (!/^\d{6}$/.test(PIN) || PIN === "000000") throw new Error("REVIEW_PIN(숫자 6자리, 000000 제외)을 환경변수로 주세요");

  const now = admin.firestore.FieldValue.serverTimestamp();
  await db.collection("partnerCodes").doc(CODE).set({
    companyId: CID, code: CODE, partnerName: NAME, active: true, createdAt: now,
    expiresAt: null, opsControlEnabled: true, note: "App Store 심사·스크린샷용 데모 — 지우지 말 것",
  }, { merge: true });
  for (const [i, r] of ROUTES.entries()) {
    await routeRef(r.id).set({
      companyId: CID, partnerCode: CODE, name: r.name, code: r.code, type: r.type, shift: null,
      departTime: r.departTime, seats: 45, order: 900 + i, active: true,
      routePath: r.routePath.map((p) => ({ lat: p.lat, lng: p.lng })),
    }, { merge: true });
    for (const [j, s] of r.stops.entries()) {
      await routeRef(r.id).collection("stops").doc(`s${j + 1}`).set(
        { name: s.name, lat: s.lat, lng: s.lng, order: j + 1, offsetMin: s.offsetMin }, { merge: true });
    }
  }
  // 해시식 = 클라·서버 공통(SHA-256 · salt 고정). 명부에는 해시를 두지 않는다(P3-a).
  const pinHash = crypto.createHash("sha256").update(PIN + "buslink_salt_2026").digest("hex");
  await co.collection("passengers").doc(EMP).set({
    companyId: CID, partnerCode: CODE, partnerName: NAME, name: "심사용", dept: "데모",
    routeId: ROUTES[0].id, active: true, pinInitial: false, pinLocked: true,
    pinHash: admin.firestore.FieldValue.delete(), note: "App Store 심사용 — 실제 사람 아님",
  }, { merge: true });
  await co.collection("passengerSecrets").doc(EMP).set({ companyId: CID, empNo: EMP, pinHash, updatedAt: now }, { merge: true });
  for (const n of NOTICES) {
    await co.collection("notices").doc(n.id).set({
      companyId: CID, partnerCode: CODE, title: n.title, body: n.body, type: "normal", active: true, createdAt: now,
    }, { merge: true });
  }
  console.log("생성 완료 (PIN 은 출력하지 않는다)");
})().then(() => process.exit(0)).catch((e) => { console.error("실패:", e.message || e); process.exit(1); });
