// 문서·데모용 **샘플 거래처** 생성/삭제 — 2026-08-27 카카오 톤 안내서 캡처용.
//
//   node scripts/seed_sample_partner.cjs                 (현황만 · 쓰기 0)
//   node scripts/seed_sample_partner.cjs --apply         (생성)
//   node scripts/seed_sample_partner.cjs --remove --apply(전부 삭제)
//
// 🔴 이건 **실제 고객 데이터가 아니다.** 안내서 스크린샷을 찍으려면 테마를 켠 거래처와
//    그 거래처의 노선·정류장·승객이 있어야 하는데, 실고객 설정을 건드리지 않기 위해
//    별도로 만든다. 이름에 `(샘플)` 을 박아 운영 화면에서 바로 구분되게 한다.
// 🔴 승객 `SAMPLE-SEC` 은 **실제로 로그인되는 계정**이다(PIN = `SAMPLE_PIN`). 시연·검토용으로
//    쓰라고 넣었다 — 실제 사람 계정을 문서·데모에 쓰지 않기 위한 것이다.
//    ⚠ 그러므로 **아무나 보는 문서에 사번·PIN 을 적지 말 것.** 데모가 끝나면 지운다.
// 🔴 **지금은 지우지 말 것 — 2026-09 첫째 주 삼성전자 시연까지 유지**(2026-08-27 way 결정).
//    협력사 관리 목록에 `삼성전자 (샘플)` 이 떠 있는 건 의도된 상태다. "정리 안 된 테스트
//    데이터"로 보고 치우지 말 것.
// ⚠ 시연이 끝나면 `--remove --apply` 로 지운다. 남겨 두면 로그인되는 계정이 하나 계속
//    살아 있는 셈이 된다. 실제 계약이 되면 정식 업체코드로 새로 발급할 것.
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
const CODE = "DY001-삼성전자샘플-2026-SMPL";
const NAME = "삼성전자 (샘플)";
const EMP = "SAMPLE-SEC";
const SAMPLE_PIN = "112233";   // 샘플 전용 — 실제 승객 PIN 아님

// 정류장 좌표 — 지도에 좌표 격자를 얹어 **실제 지도에서 읽은 값**이다(눈대중 지명 좌표는
// 크게 빗나간다: 처음 넣은 삼성전자 기흥캠퍼스가 3km 서쪽이었다).
const P = {
  기흥역:   { lat: 37.27546, lng: 127.11594 },
  청명역:   { lat: 37.26086, lng: 127.09153 },
  캠퍼스:   { lat: 37.22925, lng: 127.08675 },
  동탄역:   { lat: 37.19981, lng: 127.09674 },
  기흥동탄: { lat: 37.21543, lng: 127.09692 },
};

// 🔴 `routePath` = 운영자가 관리자에서 **직접 그리는** 폴리라인이다. 여기 값은 카카오 길찾기
//    응답이 아니라 **지도를 보고 도로 위 좌표를 읽어 찍은 것**이다 — 카카오모빌리티 길찾기
//    응답은 "자체 DB 저장·재사용 금지"(카카오 공식 답변)라 저장할 수 없다(issues.md 길안내 항목).
// ⚠ 샘플이라 도로를 **근사**한다(정확도 ±100m 수준). 실고객 노선은 관리자에서 직접 그린다.
const PATH_기흥 = [
  { lat: 37.27546, lng: 127.11594 }, { lat: 37.27274, lng: 127.11088 }, { lat: 37.26986, lng: 127.10548 },
  { lat: 37.26734, lng: 127.10008 }, { lat: 37.26590, lng: 127.09468 }, { lat: 37.26374, lng: 127.09288 },
  { lat: 37.26086, lng: 127.09153 }, { lat: 37.25654, lng: 127.09108 }, { lat: 37.25366, lng: 127.09288 },
  { lat: 37.24790, lng: 127.09198 }, { lat: 37.24214, lng: 127.09108 }, { lat: 37.23638, lng: 127.09018 },
  { lat: 37.23062, lng: 127.08910 }, { lat: 37.22925, lng: 127.08675 },
];
const PATH_동탄 = [
  { lat: 37.19981, lng: 127.09674 }, { lat: 37.20535, lng: 127.09692 }, { lat: 37.21039, lng: 127.09719 },
  { lat: 37.21543, lng: 127.09692 }, { lat: 37.21903, lng: 127.09467 }, { lat: 37.22191, lng: 127.09242 },
  { lat: 37.22515, lng: 127.08972 }, { lat: 37.22767, lng: 127.08792 }, { lat: 37.22925, lng: 127.08675 },
];

// 노선 3개 — 출근 2 · 퇴근 1.
const ROUTES = [
  { id: "sample-sec-01", name: "[기흥] 출근 / To Work (Mon–Fri)", code: "S1", type: "출근", shift: null,
    departTime: "07:10", seats: 45, routePath: PATH_기흥,
    stops: [
      { name: "기흥역 5번출구", ...P.기흥역, offsetMin: 0 },
      { name: "청명역 1번출구", ...P.청명역, offsetMin: 12 },
      { name: "삼성전자 기흥캠퍼스 정문", ...P.캠퍼스, offsetMin: 34 },
    ] },
  { id: "sample-sec-02", name: "[동탄] 출근 / To Work (Mon–Fri)", code: "S2", type: "출근", shift: null,
    departTime: "07:00", seats: 45, routePath: PATH_동탄,
    stops: [
      { name: "동탄역 3번출구", ...P.동탄역, offsetMin: 0 },
      { name: "기흥동탄IC 정류장", ...P.기흥동탄, offsetMin: 10 },
      { name: "삼성전자 기흥캠퍼스 정문", ...P.캠퍼스, offsetMin: 26 },
    ] },
  { id: "sample-sec-03", name: "[기흥] 퇴근 / To Home (Mon–Fri)", code: "S3", type: "퇴근", shift: null,
    departTime: "18:20", seats: 45, routePath: [...PATH_기흥].reverse(),
    stops: [
      { name: "삼성전자 기흥캠퍼스 정문", ...P.캠퍼스, offsetMin: 0 },
      { name: "청명역 1번출구", ...P.청명역, offsetMin: 20 },
      { name: "기흥역 5번출구", ...P.기흥역, offsetMin: 32 },
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
    for (const id of ["sample-notice-1", "sample-notice-2"]) {
      await db.collection("companies").doc(CID).collection("notices").doc(id).delete();
    }
    await db.collection("companies").doc(CID).collection("passengers").doc(EMP).delete();
    await db.collection("partnerCodes").doc(CODE).delete();
    console.log("  공지·승객·거래처 삭제\n완료");
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
      // 🔴 plain number 배열이어야 한다(GeoPoint 아님) — 소비측이 `p.lat`/`p.lng` 를 그대로 읽는다.
      routePath: r.routePath.map((p) => ({ lat: p.lat, lng: p.lng })),
    }, { merge: true });
    for (const [j, s] of r.stops.entries()) {
      await routeRef(r.id).collection("stops").doc(`s${j + 1}`).set({
        name: s.name, lat: s.lat, lng: s.lng, order: j + 1, offsetMin: s.offsetMin,
      }, { merge: true });
    }
    console.log(`  노선 ${r.name} (정류장 ${r.stops.length})`);
  }

  // 🔴 PIN 은 **샘플 전용 고정값**이다(`SAMPLE_PIN`). 실제 사람 계정을 문서·시연에 쓰지
  //    않으려고 만든 계정이고, 데모가 끝나면 `--remove --apply` 로 지운다.
  //    해시식은 클라 `lib/partner.js hashPin` 과 **같아야 한다**(SHA-256 · salt 고정).
  //    ⚠ 이 계정으로 로그인하면 실제 앱에 들어간다 — 아무나 보는 문서에 사번·PIN 을 적지 말 것.
  const pinHash = crypto.createHash("sha256").update(SAMPLE_PIN + "buslink_salt_2026").digest("hex");
  await db.collection("companies").doc(CID).collection("passengers").doc(EMP).set({
    companyId: CID, partnerCode: CODE, partnerName: NAME,
    name: "김샘플", dept: "반도체연구소", routeId: ROUTES[0].id,
    active: true, pinInitial: false, pinLocked: false, pinHash,
    lastLoginAt: now, note: "문서·시연용 샘플 — 실제 사람 아님",
  }, { merge: true });
  console.log(`  승객 ${EMP} (김샘플 · 반도체연구소 · 기흥 출근 · PIN ${SAMPLE_PIN})`);

  // 공지 2건 — 안내서의 «공지사항» 화면이 비어 있으면 아무것도 설명하지 못한다.
  // 🔴 `fcmQueue` 는 만들지 않는다 — 그걸 만들면 CF 트리거가 **실제로 푸시를 쏜다**
  //    (샘플이라도 발송은 발송이다). 화면에 보이는 것은 `notices` 구독만으로 충분하다.
  const NOTICES = [
    { id: "sample-notice-1", type: "normal",
      title: "[기흥] 출근 노선 정류장 추가 안내",
      body: "9월 1일(월)부터 [기흥] 출근 노선에 '신갈오거리 정류장'이 추가됩니다.\n출발 시각은 기존과 같습니다." },
    // 🔴 둘 다 일반 공지다 — `emergency` 는 앱을 열 때 5초 카운트다운 전체화면 모달을 띄워
    //    캡처가 그 모달만 찍고, 안내서에 «앱이 화면을 덮는다»는 인상을 준다(2026-08-27 way 지적).
    { id: "sample-notice-2", type: "normal",
      title: "폭우 예보에 따른 지연 운행 안내",
      body: "오늘 오전 수도권 폭우 예보로 전 노선이 10~15분 지연될 수 있습니다.\n여유 있게 준비해 주세요." },
  ];
  for (const n of NOTICES) {
    await db.collection("companies").doc(CID).collection("notices").doc(n.id).set({
      companyId: CID, partnerCode: CODE, title: n.title, body: n.body,
      type: n.type, active: true, createdAt: now,
    }, { merge: true });
  }
  console.log(`  공지 ${NOTICES.length}건`);
  console.log("\n완료 — 다 쓰고 나면 `--remove --apply` 로 지울 것");
})().then(() => process.exit(0)).catch((e) => { console.error("실패:", e.message || e); process.exit(1); });
