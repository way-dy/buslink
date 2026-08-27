// 문서·데모용 **샘플 거래처** 생성/삭제 — 2026-08-27 카카오 톤 안내서 캡처용.
//
//   node scripts/seed_sample_partner.cjs                 (현황만 · 쓰기 0)
//   node scripts/seed_sample_partner.cjs --apply         (생성)
//   node scripts/seed_sample_partner.cjs --remove --apply(전부 삭제)
//
// 🔴 이건 **실제 고객 데이터가 아니다.** 안내서 스크린샷을 찍으려면 테마를 켠 거래처와
//    그 거래처의 노선·정류장·승객이 있어야 하는데, 실고객 설정을 건드리지 않기 위해
//    별도로 만든다. 이름에 `(샘플)` 을 박아 운영 화면에서 바로 구분되게 한다.
// 🔴 승객은 **로그인할 수 없는 계정**이다 — `pinHash` 를 넣지 않으므로 PIN 대조가 통과할
//    수 없다. 캡처 하네스는 승계표를 서버에 직접 만들어 들어가므로 PIN 이 필요 없다.
//    (실제 사람 계정을 문서용으로 쓰지 않기 위한 것이다.)
// ⚠ 다 쓰고 나면 `--remove --apply` 로 지울 것. 남겨 두면 협력사 관리 목록에 계속 뜬다.
const path = require("path");
const fs = require("fs");
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
const CODE = "DY001-삼성전자샘플-2026-SMPL";
const NAME = "삼성전자 (샘플)";
const EMP = "SAMPLE-SEC";

// 노선 3개 — 출근 2 · 퇴근 1. 정류장은 실제 좌표(기흥·동탄 일대)라 지도가 정상으로 그려진다.
const ROUTES = [
  { id: "sample-sec-01", name: "[기흥] 출근 / To Work (Mon–Fri)", code: "S1", type: "출근", shift: null,
    departTime: "07:10", seats: 45,
    stops: [
      { name: "기흥역 5번출구", lat: 37.27546, lng: 127.11594, offsetMin: 0 },
      { name: "신갈오거리 정류장", lat: 37.28497, lng: 127.11090, offsetMin: 9 },
      { name: "삼성전자 기흥캠퍼스 정문", lat: 37.22884, lng: 127.05316, offsetMin: 34 },
    ] },
  { id: "sample-sec-02", name: "[동탄] 출근 / To Work (Mon–Fri)", code: "S2", type: "출근", shift: null,
    departTime: "07:00", seats: 45,
    stops: [
      { name: "동탄역 3번출구", lat: 37.20140, lng: 127.09750, offsetMin: 0 },
      { name: "능동사거리 버스정류장", lat: 37.20821, lng: 127.07240, offsetMin: 11 },
      { name: "삼성전자 기흥캠퍼스 정문", lat: 37.22884, lng: 127.05316, offsetMin: 28 },
    ] },
  { id: "sample-sec-03", name: "[기흥] 퇴근 / To Home (Mon–Fri)", code: "S3", type: "퇴근", shift: null,
    departTime: "18:20", seats: 45,
    stops: [
      { name: "삼성전자 기흥캠퍼스 정문", lat: 37.22884, lng: 127.05316, offsetMin: 0 },
      { name: "신갈오거리 정류장", lat: 37.28497, lng: 127.11090, offsetMin: 22 },
      { name: "기흥역 5번출구", lat: 37.27546, lng: 127.11594, offsetMin: 31 },
    ] },
];

const routeRef = (id) => db.collection("companies").doc(CID).collection("routes").doc(id);

(async () => {
  if (REMOVE) {
    console.log(`\n삭제 대상: ${CODE}\n`);
    if (!APPLY) { console.log("(dry-run — --apply 를 붙이면 지운다)"); return; }
    for (const r of ROUTES) {
      const stops = await routeRef(r.id).collection("stops").get();
      for (const s of stops.docs) await s.ref.delete();
      await routeRef(r.id).delete();
      console.log("  노선 삭제", r.id);
    }
    await db.collection("companies").doc(CID).collection("passengers").doc(EMP).delete();
    await db.collection("partnerCodes").doc(CODE).delete();
    console.log("  승객·거래처 삭제\n완료");
    return;
  }

  const exists = (await db.collection("partnerCodes").doc(CODE).get()).exists;
  console.log(`\n거래처 ${CODE} — ${exists ? "이미 있음(덮어씀)" : "신규"}`);
  console.log(`노선 ${ROUTES.length}개 · 정류장 ${ROUTES.reduce((n, r) => n + r.stops.length, 0)}개 · 승객 1명(${EMP})`);
  console.log(`테마 = kakao 프리셋`);
  if (!APPLY) { console.log("\n(dry-run — 아무것도 쓰지 않았다. --apply 를 붙일 것)"); return; }

  const now = admin.firestore.FieldValue.serverTimestamp();
  await db.collection("partnerCodes").doc(CODE).set({
    companyId: CID, partnerName: NAME, active: true, createdAt: now,
    expiresAt: null, opsControlEnabled: true,
    theme: { preset: "kakao" },
    branding: { primaryColor: null, logo: null, logoHeight: 28 },
  }, { merge: true });
  console.log("  거래처 생성 (테마 kakao)");

  for (const [i, r] of ROUTES.entries()) {
    await routeRef(r.id).set({
      companyId: CID, partnerCode: CODE, name: r.name, code: r.code, type: r.type,
      shift: r.shift, departTime: r.departTime, seats: r.seats, order: i + 1, active: true,
    }, { merge: true });
    for (const [j, s] of r.stops.entries()) {
      await routeRef(r.id).collection("stops").doc(`s${j + 1}`).set({
        name: s.name, lat: s.lat, lng: s.lng, order: j + 1, offsetMin: s.offsetMin,
      }, { merge: true });
    }
    console.log(`  노선 ${r.name} (정류장 ${r.stops.length})`);
  }

  // 🔴 `pinHash` 없음 = 로그인 불가 계정. 문서 캡처는 승계표로 들어간다.
  await db.collection("companies").doc(CID).collection("passengers").doc(EMP).set({
    companyId: CID, partnerCode: CODE, partnerName: NAME,
    name: "김샘플", dept: "반도체연구소", routeId: ROUTES[0].id,
    active: true, pinInitial: false, pinLocked: false,
    lastLoginAt: now, note: "문서 캡처용 샘플 — 실제 사람 아님",
  }, { merge: true });
  console.log(`  승객 ${EMP} (김샘플 · 반도체연구소 · 기흥 출근)`);
  console.log("\n완료 — 다 쓰고 나면 `--remove --apply` 로 지울 것");
})().then(() => process.exit(0)).catch((e) => { console.error("실패:", e.message || e); process.exit(1); });
