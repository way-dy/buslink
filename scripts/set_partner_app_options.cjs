// 거래처 승객앱 옵션 설정 — 홈페이지 연결 · QR 태깅 소리 강제 (2026-08-25 미팅)
//
//   node scripts/set_partner_app_options.cjs                      (전 거래처 현황만 — 쓰기 0)
//   node scripts/set_partner_app_options.cjs <코드일부>            (그 거래처 dry-run — 쓰기 0)
//   node scripts/set_partner_app_options.cjs <코드일부> --homepage <URL> --sound-forced
//   node scripts/set_partner_app_options.cjs <코드일부> --theme kakao      (테마 프리셋 켜기)
//   node scripts/set_partner_app_options.cjs <코드일부> --theme-off        (기본 테마로 되돌리기)
//   node scripts/set_partner_app_options.cjs <코드일부> ... --apply   ← 이때만 실제로 쓴다
//
// 🔴 **`--apply` 없이는 아무것도 쓰지 않는다.** 관리자 화면(협력사 관리 → ⚙️ 포탈 설정)에서도
//    같은 값을 넣을 수 있다 — 이 스크립트는 배포 전에 값을 미리 심어 둘 때만 쓴다.
// ⚠ **홈페이지를 켜면 그 거래처의 '문의' 탭이 사라진다**(대체). 앱에서 접수되던 문의가
//    고객CS시스템(dycs)으로 더는 들어오지 않는다 — 켜기 전에 확인받을 것.
// ⚠ 값은 써 두더라도 **hosting 배포 전에는 화면에 반영되지 않는다**(옛 번들은 이 필드를 모른다).
const path = require("path");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
const admin = require(path.join(ROOT, "functions", "node_modules", "firebase-admin"));
const kf = fs.readdirSync(path.join(ROOT, "key")).find((f) => f.endsWith(".json"));
const sa = require(path.join(ROOT, "key", kf));
if (sa.project_id !== "buslink-prod") throw new Error("project_id 불일치");
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const SOUND_FORCED = argv.includes("--sound-forced");
const SOUND_FREE = argv.includes("--sound-free"); // 강제 해제
const hpIdx = argv.indexOf("--homepage");
const HOMEPAGE = hpIdx >= 0 ? argv[hpIdx + 1] : null;
const HOMEPAGE_OFF = argv.includes("--homepage-off");
// 거래처 테마(2026-08-27). 프리셋 이름만 받는다 — 자유 색 조합은 관리자 화면에서.
const THEME_PRESETS = ["kakao"];
const thIdx = argv.indexOf("--theme");
const THEME = thIdx >= 0 ? argv[thIdx + 1] : null;
const THEME_OFF = argv.includes("--theme-off");
const needle = argv.find((a) => !a.startsWith("--") && a !== HOMEPAGE && a !== THEME) || null;

function validUrl(v) {
  if (typeof v !== "string" || !v.trim()) return false;
  try {
    const u = new URL(v.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch { return false; }
}
const show = (d) => {
  const hp = d.homepage || {};
  const ts = d.tagSound || {};
  const inq = d.inquiry || {};
  const th = d.theme || {};
  const br = d.branding || {};
  return `홈페이지 ${hp.enabled === true ? "켜짐 · " + (hp.url || "(주소없음)") : "꺼짐"}`
    + ` | 소리강제 ${ts.forced === true ? "켜짐" : "꺼짐"}`
    + ` | 문의 ${inq.enabled === true ? "켜짐(" + (inq.tenantId || "?") + ")" : "꺼짐"}`
    + ` | 테마 ${th.preset ? th.preset : (br.primaryColor ? "색만(" + br.primaryColor + ")" : "기본")}`;
};

(async () => {
  const snap = await db.collection("partnerCodes").get();
  const rows = snap.docs.filter((d) => (d.data() || {}).active !== false);

  if (!needle) {
    console.log(`\n활성 거래처 ${rows.length}곳 (읽기 전용)\n`);
    rows.forEach((d) => {
      const v = d.data() || {};
      console.log(`  ${d.id}`);
      console.log(`    ${v.partnerName || "(이름없음)"} — ${show(v)}`);
    });
    console.log("\n대상을 지정하려면 코드 일부를 인자로 주세요.");
    return;
  }

  const hits = rows.filter((d) => d.id.includes(needle) || ((d.data() || {}).partnerName || "").includes(needle));
  if (hits.length !== 1) {
    console.log(`\n🔴 "${needle}" 로 ${hits.length}곳이 잡혔다 — 정확히 1곳이어야 한다.`);
    hits.forEach((d) => console.log(`    ${d.id} · ${(d.data() || {}).partnerName || ""}`));
    process.exit(1);
  }
  const ref = hits[0].ref;
  const before = hits[0].data() || {};

  const patch = {};
  if (HOMEPAGE_OFF) {
    patch.homepage = { enabled: false, url: (before.homepage || {}).url || null };
  } else if (HOMEPAGE != null) {
    if (!validUrl(HOMEPAGE)) {
      console.log(`\n🔴 주소가 http(s) 전체 주소가 아니다: ${HOMEPAGE}`);
      process.exit(1);
    }
    patch.homepage = { enabled: true, url: HOMEPAGE.trim() };
  }
  if (SOUND_FORCED) patch.tagSound = { forced: true };
  if (SOUND_FREE) patch.tagSound = { forced: false };

  // 🔴 테마를 끄는 것은 필드 삭제가 아니라 **빈 객체**다 — `resolveTheme` 이 preset 을 못 찾으면
  //    null 을 돌려주고 앱은 기존 `branding.primaryColor` 경로로 내려간다(그 거래처가 색을
  //    설정해 뒀다면 그 색이 그대로 살아난다). 필드를 지우면 되돌릴 때 흔적이 없다.
  if (THEME_OFF) {
    patch.theme = {};
  } else if (THEME != null) {
    if (!THEME_PRESETS.includes(THEME)) {
      console.log(`\n🔴 모르는 프리셋: ${THEME} — 가능한 값: ${THEME_PRESETS.join(", ")}`);
      process.exit(1);
    }
    patch.theme = { preset: THEME };
  }

  console.log(`\n대상: ${ref.id}`);
  console.log(`      ${before.partnerName || "(이름없음)"}`);
  console.log(`\n  지금 : ${show(before)}`);
  if (!Object.keys(patch).length) {
    console.log("\n바꿀 것이 지정되지 않았다(--homepage / --homepage-off / --sound-forced / --sound-free / --theme <프리셋> / --theme-off).");
    return;
  }
  console.log(`  바뀜 : ${show({ ...before, ...patch })}`);

  // 🔴 켜는 순간 문의 접수 경로가 끊긴다 — 조용히 지나가면 안 된다.
  if (patch.homepage && patch.homepage.enabled && (before.inquiry || {}).enabled === true) {
    console.log("\n  ⚠ 이 거래처는 지금 '문의' 탭이 켜져 있다. 홈페이지를 켜면 문의 탭이 **사라지고**");
    console.log("    앱에서 접수되던 문의가 고객CS시스템(dycs)으로 더는 들어오지 않는다.");
  }

  if (!APPLY) {
    console.log("\n(dry-run — 아무것도 쓰지 않았다. 적용하려면 --apply)");
    return;
  }
  await ref.update(patch);
  const after = (await ref.get()).data() || {};
  console.log(`\n  적용됨: ${show(after)}`);
  console.log("  ⚠ hosting 배포 전에는 승객 화면에 반영되지 않는다.");
})().catch((e) => { console.error(e); process.exit(1); });
