// 거래처 테마(partnerBranding 확장) 격리 테스트 — 2026-08-27 카카오 톤 요청.
//
//   node scripts/test_partner_theme.cjs
//
// 🔴 판정식을 베끼지 않고 `src/lib/partnerBranding.js` 소스를 그대로 vm 에 태운다(재구현 0).
// 🔴 이 테스트의 존재 이유 = **"부재 = 현행"** 이다. 테마를 안 쓰는 거래처 8곳의 화면이
//    한 픽셀도 안 바뀌는지가 이 변경의 유일한 회귀 위험이고, 그건 눈으로 못 잡는다.
// 🔴 `document` 는 최소 스텁으로 흉내 낸다 — applyPartnerTheme 이 실제로 어떤 CSS 변수를
//    쓰고 지우는지까지 재야 의미가 있다(순수 함수만 재면 절반만 재는 것).
// prod 접근 0 · 쓰기 0.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = path.join(__dirname, "..");

// 스타일 선언을 기억하는 최소 document 스텁.
function makeDoc() {
  const props = new Map();
  return {
    props,
    documentElement: {
      style: {
        setProperty: (k, v) => props.set(k, v),
        removeProperty: (k) => props.delete(k),
      },
    },
  };
}

function loadModule(doc) {
  const src = fs.readFileSync(path.join(ROOT, "src/lib/partnerBranding.js"), "utf8")
    .split("\n")
    .filter((l) => !/^import\s/.test(l))          // firebase import 제거(순수·DOM 부분만 태운다)
    .join("\n")
    .replace(/^export const /gm, "const ")
    .replace(/^export function /gm, "function ")
    .replace(/^export async function /gm, "async function ");
  const ctx = { console, document: doc };
  vm.createContext(ctx);
  vm.runInContext(src + `
;this.__m = { THEME_PRESETS, resolveTheme, readableOn, brandBand, applyPartnerTheme,
              applyPartnerBranding, clearPartnerBranding, mixHex, relativeLuminance, isValidHexColor,
              brandOf, sanitizeWordmark, sanitizeAssetPath, DEFAULT_WORDMARK };`, ctx);
  return ctx.__m;
}

(async () => {
  let fail = 0, n = 0;
  const ok = (name, cond, got) => {
    n++; console.log(`  ${cond ? "✓" : "✗"} ${name}${!cond && got !== undefined ? " → " + JSON.stringify(got) : ""}`);
    if (!cond) fail++;
  };

  const doc = makeDoc();
  const M = loadModule(doc);
  const V = (k) => doc.props.get(k);

  // ── [0] 신호 유무 ──────────────────────────────────────────────
  // 프리셋이 실제로 실려 있는지 먼저 본다. 비어 있으면 아래 판정이 전부 공허하다.
  console.log("\n[0] 신호 유무");
  ok("kakao 프리셋이 실재한다", !!M.THEME_PRESETS.kakao);
  ok("프리셋 4색이 전부 유효한 hex",
    ["band", "accent", "accentSoft", "primary"].every((k) => M.isValidHexColor(M.THEME_PRESETS.kakao[k])),
    M.THEME_PRESETS.kakao);

  // ── [1] 부재 = 현행 (이 변경의 핵심 회귀 가드) ──────────────────
  console.log("\n[1] 부재 = 현행");
  ok("theme 없으면 resolveTheme=null", M.resolveTheme({}) === null);
  ok("문서 자체가 없어도 null", M.resolveTheme(null) === null);
  ok("theme 이 문자열이면 null(잘못된 값)", M.resolveTheme({ theme: "kakao" }) === null);
  ok("모르는 preset 이름은 null", M.resolveTheme({ theme: { preset: "toss" } }) === null);
  ok("primary 만 있는 theme 은 null(옛 branding 경로가 맞다)",
    M.resolveTheme({ theme: { primary: "#112233" } }) === null);

  doc.props.clear();
  const r1 = M.applyPartnerTheme({ branding: { primaryColor: "#142c52" } });
  ok("테마 없으면 applyPartnerTheme 은 null 을 돌려준다", r1 === null);
  ok("  그리고 옛 경로 그대로 primary 3종만 쓴다",
    V("--color-primary") === "#142c52" && !!V("--color-primary-deep") && !!V("--color-primary-soft")
    && doc.props.size === 3, [...doc.props.keys()]);
  ok("  밴드·포인트 변수는 건드리지 않는다(tokens.css 기본값이 살아 있어야 한다)",
    V("--color-band") === undefined && V("--color-accent") === undefined);

  doc.props.clear();
  ok("브랜딩도 테마도 없으면 아무 변수도 안 쓴다",
    M.applyPartnerTheme({}) === null && doc.props.size === 0, [...doc.props.keys()]);

  // ── [2] 카카오 프리셋 ──────────────────────────────────────────
  console.log("\n[2] 카카오 프리셋");
  const kakao = M.resolveTheme({ theme: { preset: "kakao" } });
  ok("밴드는 곤색", kakao.band === "#1E233D", kakao);
  ok("포인트는 옐로우", kakao.accent === "#FFCD00");
  ok("CTA 는 파랑", kakao.primary === "#4088FE");
  ok("🔴 밴드와 CTA 가 서로 다른 색이다(파생으로 못 만드는 이유)", kakao.band !== kakao.primary);
  ok("🔴 밴드가 primary 파생값과도 다르다", kakao.band !== M.mixHex(kakao.primary, "#000000", 0.25),
    { band: kakao.band, 파생: M.mixHex(kakao.primary, "#000000", 0.25) });

  doc.props.clear();
  const r2 = M.applyPartnerTheme({ theme: { preset: "kakao" } });
  ok("applyPartnerTheme 이 테마를 돌려준다(호출부가 brandBand 에 넘길 값)", r2 && r2.band === "#1E233D");
  ok("CSS 변수 7종을 쓴다", doc.props.size === 7, [...doc.props.keys()]);
  ok("  --color-band", V("--color-band") === "#1E233D");
  ok("  --color-accent", V("--color-accent") === "#FFCD00");
  ok("  --color-accent-soft", V("--color-accent-soft") === "#FFF3C4");
  ok("  --color-primary", V("--color-primary") === "#4088FE");
  ok("  곤색 밴드 위 글자는 흰색", V("--color-band-fg") === "#ffffff");

  // ── [3] 밴드 글자색은 휘도로 (하드코딩 금지 가드) ────────────────
  console.log("\n[3] 밴드 글자색은 휘도로");
  ok("어두운 밴드 → 흰 글씨", M.readableOn("#1E233D") === "#ffffff");
  ok("🔴 노랑을 밴드로 고르면 어두운 글씨", M.readableOn("#FFCD00") === "#0B1020");
  doc.props.clear();
  M.applyPartnerTheme({ theme: { preset: "kakao", band: "#FFCD00" } });
  ok("  적용에도 그대로 반영된다", V("--color-band-fg") === "#0B1020");

  // ── [4] brandBand — 테마가 오면 파생하지 않는다 ──────────────────
  console.log("\n[4] brandBand");
  const legacy = M.brandBand({ primaryColor: "#142c52" });
  ok("테마 없으면 예전과 같이 primary 를 25% 어둡게 파생",
    legacy.bg === M.mixHex("#142c52", "#000000", 0.25), legacy.bg);
  ok("branding 도 없으면 기본 #003DCC", M.brandBand(null).bg === "#003DCC");
  ok("🔴 인자 하나로 부르던 기존 호출부가 그대로 동작한다(시그니처 하위호환)",
    M.brandBand({ primaryColor: "#009944" }).bg === M.mixHex("#009944", "#000000", 0.25));
  const themed = M.brandBand({ primaryColor: "#142c52" }, kakao);
  ok("테마가 오면 밴드색을 파생하지 않고 그대로 쓴다", themed.bg === "#1E233D", themed.bg);
  ok("  글자색은 여전히 휘도로", themed.fg === "#ffffff");
  ok("  칩 색도 밴드 밝기에 맞춰 따라온다", themed.chipBg === "rgba(255,255,255,.16)");

  // ── [5] 개별 필드 덮어쓰기 ──────────────────────────────────────
  console.log("\n[5] 개별 필드 덮어쓰기");
  const mixd = M.resolveTheme({ theme: { preset: "kakao", primary: "#0066FF" } });
  ok("유효한 필드만 프리셋 위에 덮는다", mixd.primary === "#0066FF" && mixd.band === "#1E233D");
  const bad = M.resolveTheme({ theme: { preset: "kakao", primary: "파랑", accent: "#GGGGGG" } });
  ok("🔴 잘못된 값은 조용히 무시하고 프리셋 값을 지킨다(빈 색으로 떨어지지 않는다)",
    bad.primary === "#4088FE" && bad.accent === "#FFCD00", bad);
  const bandOnly = M.resolveTheme({ theme: { band: "#1E233D" } });
  ok("프리셋 없이 밴드만 줘도 테마로 인정하고 나머지를 채운다",
    bandOnly && bandOnly.band === "#1E233D" && M.isValidHexColor(bandOnly.accent)
    && M.isValidHexColor(bandOnly.accentSoft), bandOnly);

  // ── [6] 정리 — 거래처를 옮기면 색이 남지 않는다 ──────────────────
  console.log("\n[6] clearPartnerBranding");
  doc.props.clear();
  M.applyPartnerTheme({ theme: { preset: "kakao" } });
  const beforeClear = doc.props.size;
  M.clearPartnerBranding();
  ok("🔴 테마가 쓴 변수를 하나도 남기지 않는다(남으면 로그아웃 후 남의 색이 보인다)",
    beforeClear === 7 && doc.props.size === 0, [...doc.props.keys()]);

  // ── [7] 거래처 워드마크 (2026-08-28) ──────────────────────────
  // 🔴 여기서 재는 것 = "워드마크를 안 준 거래처는 여전히 BusLink 인가". 이름을 바꾸는 기능은
  //    켠 거래처 하나만 바꿔야 하고, 그게 새면 9개 고객사 화면의 제품명이 한꺼번에 바뀐다.
  console.log("");
  console.log("[7] 거래처 워드마크");
  const bDefault = M.brandOf(null);
  ok("🔴 테마가 없으면 BusLink 다(부재=현행)",
    bDefault.name === "BusLink" && bDefault.custom === false && bDefault.sub === null, bDefault);

  const bColorOnly = M.brandOf(M.resolveTheme({ theme: { band: "#003876" } }));
  ok("🔴 색만 쓰는 거래처도 이름은 그대로 BusLink",
    bColorOnly.name === "BusLink" && bColorOnly.custom === false, bColorOnly);

  const tKakao = M.resolveTheme({ theme: { preset: "kakao" } });
  const bKakao = M.brandOf(tKakao);
  ok("카카오 프리셋은 워드마크를 함께 싣는다",
    bKakao.name === "카카오 T" && bKakao.sub === "통근셔틀" && bKakao.custom === true, bKakao);

  const bOverride = M.brandOf(M.resolveTheme({ theme: { preset: "kakao", wordmark: "카카오모빌리티" } }));
  ok("거래처가 준 이름이 프리셋 기본값을 이긴다(회사명 표기 전환은 한 필드)",
    bOverride.name === "카카오모빌리티" && bOverride.sub === "통근셔틀", bOverride);

  const tOff = M.resolveTheme({ theme: { preset: "kakao", wordmark: "" } });
  ok("🔴 빈 문자열 = 상표만 빼고 색은 유지(2026-08-27 «색만» 상태로 되돌리는 통로)",
    M.brandOf(tOff).name === "BusLink" && tOff.band === "#1E233D" && tOff.accent === "#FFCD00", tOff);

  ok("워드마크만 있는 문서는 테마로 인정하지 않는다(밴드색이 조용히 바뀌는 것 차단)",
    M.resolveTheme({ theme: { wordmark: "아무개" } }) === null);

  ok("앞뒤·연속 공백을 정리한다", M.sanitizeWordmark("  카카오   T  ") === "카카오 T");
  ok("꺾쇠를 남기지 않는다(인쇄물·문서 템플릿이 같은 값을 HTML 로 끼운다)",
    (M.sanitizeWordmark("<b>카카오 T</b>") || "").indexOf("<") === -1);
  ok("문자열이 아니거나 너무 길면 null(호출부가 기본 브랜드로 내려간다)",
    M.sanitizeWordmark(123) === null && M.sanitizeWordmark("가".repeat(25)) === null
    && M.sanitizeWordmark("   ") === null);

  // 아이콘 3종(2026-08-28) — 파비콘·홈화면 아이콘·매니페스트도 테마에서 나온다.
  ok("기본 브랜드는 아이콘을 정하지 않는다(호출부가 앱 기본값으로 되돌린다)",
    bDefault.favicon === null && bDefault.apple === null && bDefault.manifest === null);
  ok("카카오 프리셋은 아이콘 3종을 함께 싣는다",
    bKakao.favicon === "/icons/kakao-t.svg" && bKakao.apple === "/icons/kakao-t-1024.png"
    && bKakao.manifest === "/manifest-kakao.json", bKakao);
  ok("🔴 외부 URL·프로토콜 상대경로·상위 이동은 아이콘 경로로 인정하지 않는다",
    M.sanitizeAssetPath("https://evil.example/x.svg") === null
    && M.sanitizeAssetPath("//evil.example/x.svg") === null
    && M.sanitizeAssetPath("/icons/../../x.svg") === null
    && M.sanitizeAssetPath("/icons/kakao-t.svg") === "/icons/kakao-t.svg");
  const bBadIcon = M.brandOf(M.resolveTheme({ theme: { preset: "kakao", favicon: "https://evil.example/x.svg" } }));
  ok("🔴 거래처가 못 쓰는 경로를 주면 프리셋 값을 쓰지 않고 앱 기본값으로 내려간다",
    bBadIcon.favicon === null && bBadIcon.name === "카카오 T", bBadIcon);

  // 실물 파일 — 경로만 맞고 파일이 없으면 화면에 깨진 아이콘이 나간다.
  ["public/icons/kakao-t.svg", "public/icons/kakao-t-1024.png",
   "public/manifest-kakao.json", "public/kakao.html"].forEach((f) => {
    ok("파일이 실재한다: " + f, fs.existsSync(path.join(ROOT, f)));
  });

  // 거래처 전용 진입 주소 — 카카오톡 링크 카드는 **이 파일의 정적 태그**에서만 나온다.
  const landing = fs.readFileSync(path.join(ROOT, "public/kakao.html"), "utf8");
  ok("랜딩 카드 제목이 워드마크와 어긋나지 않는다",
    landing.includes('property="og:title" content="카카오 T 통근셔틀"'));
  ok("🔴 meta refresh 를 쓰지 않는다(스크레이퍼가 따라가면 카드가 승객앱 것으로 잡힌다)",
    !landing.toLowerCase().includes("http-equiv=\"refresh\""));
  ok("랜딩이 거래처 코드를 실어 승객앱으로 보낸다",
    landing.includes("/p?pc=") && landing.includes("DY001-삼성전자샘플-2026-SMPL"));
  const fbase = fs.readFileSync(path.join(ROOT, "firebase.json"), "utf8");
  ok("🔴 호스팅 rewrite 가 캐치올보다 «먼저» /kakao 를 잡는다(순서가 뒤면 SPA 로 삼켜진다)",
    fbase.indexOf('"/kakao"') !== -1 && fbase.indexOf('"/kakao"') < fbase.indexOf('"**"'));

  const logoSrc = fs.readFileSync(path.join(ROOT, "src/components/ui/BusLinkLogo.js"), "utf8");
  ok("BusLinkLogo 가 name 을 받는다",
    logoSrc.includes("BusLinkLogo({ size = 22, color, sub, name })"));
  ok("🔴 name 을 안 주면 예전 Bus+Link 두 색 렌더 그대로",
    logoSrc.includes("{name ? name : <>Bus<span style={{ color: c }}>Link</span></>}"));

  // ── [8] 소스 가드 (복원 금지) ──────────────────────────────────
  console.log("\n[8] 소스 가드");
  const libSrc = fs.readFileSync(path.join(ROOT, "src/lib/partnerBranding.js"), "utf8");
  const cssSrc = fs.readFileSync(path.join(ROOT, "src/styles/tokens.css"), "utf8");
  ok("brandBand 가 theme 인자를 받는다", /function brandBand\(branding, theme\)/.test(libSrc));
  ok("BRAND_VARS 에 확장 변수 4종이 들어 있다",
    ["--color-band", "--color-band-fg", "--color-accent", "--color-accent-soft"]
      .every((v) => new RegExp(`"${v}"`).test(libSrc.split("export function isValidHexColor")[0])));
  ok("🔴 tokens.css 의 --color-accent 기본값이 primary 를 가리킨다(부재=현행)",
    /--color-accent:\s*var\(--color-primary\)/.test(cssSrc));
  ok("🔴 tokens.css 의 --color-accent-soft 기본값이 primary-soft 를 가리킨다",
    /--color-accent-soft:\s*var\(--color-primary-soft\)/.test(cssSrc));
  ok("applyPartnerTheme 이 테마 없을 때 옛 경로로 내려간다",
    /if \(!theme\) \{ applyPartnerBranding/.test(libSrc));

  // ── [9] 앱 이름(appName)·조사 (2026-08-30) ─────────────────────
  // 🔴 홈 화면 아이콘 이름은 앱 안 워드마크와 **일부러 다르다** — 「카카오 T」 는 폰에 이미
  //    깔린 카카오 T 앱과 이름이 겹친다(way 지적). 둘을 같은 값으로 묶으면 그 결정이 사라진다.
  console.log("\n[9] 앱 이름·조사");
  const josaSrc = fs.readFileSync(path.join(ROOT, "src/lib/josa.js"), "utf8")
    .replace(/^export const /gm, "const ")
    .replace(/^export function /gm, "function ");
  const jctx = { console };
  vm.createContext(jctx);
  vm.runInContext(josaSrc + "\n;this.__j = { hasBatchim, withEulReul };", jctx);
  const J = jctx.__j;
  ok("받침 있는 한글 → 을", J.withEulReul("카카오통근") === "카카오통근을", J.withEulReul("카카오통근"));
  ok("받침 없는 한글 → 를", J.withEulReul("버스") === "버스를", J.withEulReul("버스"));
  ok("🔴 영문은 무받침 취급 = 현행 유지", J.withEulReul("BusLink") === "BusLink를", J.withEulReul("BusLink"));
  ok("🔴 «카카오 T» 도 현행 그대로", J.withEulReul("카카오 T") === "카카오 T를", J.withEulReul("카카오 T"));
  ok("빈 값·null 이어도 던지지 않는다", J.withEulReul("") === "를" && J.withEulReul(null) === "를");
  ok("꼬리 공백은 무시한다", J.hasBatchim("카카오통근  ") === true);

  const kk = M.THEME_PRESETS.kakao;
  ok("카카오 프리셋 appName 이 «카카오통근»", kk.appName === "카카오통근", kk.appName);
  ok("🔴 앱 안 워드마크는 «카카오 T» 그대로(고객이 지정한 표기)", kk.wordmark === "카카오 T", kk.wordmark);
  ok("🔴 부재면 appName 이 워드마크로 폴백", M.brandOf({ wordmark: "가나다" }).appName === "가나다");
  ok("🔴 테마가 없으면 appName 도 BusLink", M.brandOf(null).appName === "BusLink");
  ok("appName 이 24자를 넘으면 무시되고 워드마크로 내려간다",
    M.brandOf(M.resolveTheme({ theme: { preset: "kakao", appName: "가".repeat(25) } })).appName === "카카오 T");
  ok("빈 문자열이면 appName 만 끄고 워드마크를 쓴다",
    M.brandOf(M.resolveTheme({ theme: { preset: "kakao", appName: "" } })).appName === "카카오 T");

  const kakaoManifest = JSON.parse(fs.readFileSync(path.join(ROOT, "public/manifest-kakao.json"), "utf8"));
  ok("🔴 매니페스트 short_name 이 프리셋 appName 과 같다(하나만 고치면 화면과 홈 아이콘이 갈린다)",
    kakaoManifest.short_name === kk.appName, kakaoManifest.short_name);
  const promptSrc = fs.readFileSync(path.join(ROOT, "src/components/InstallPrompt.js"), "utf8");
  ok("🔴 설치 팝업 문구가 조사 헬퍼를 쓴다(하드코딩 « 를 » 복원 금지)", promptSrc.includes("withEulReul(name)"));
  ok("🔴 brandName 기본값이 null 이다(«준 경우에만» 계약)",
    /InstallPrompt\(\{ brandName = null, iconHref = null \}\)/.test(promptSrc));
  ok("?install=1 로 스누즈를 건너뛸 수 있다",
    promptSrc.includes("isForcedByUrl") && promptSrc.includes("!forced && isSnoozed()"));
  ok("🔴 standalone 은 강제 노출로도 안 뚫는다", /if \(isStandalone\(\)\) return;/.test(promptSrc));
  const empSrc = fs.readFileSync(path.join(ROOT, "src/pages/EmployeeApp.js"), "utf8");
  ok("🔴 승객앱이 팝업에 appName 을 넘긴다(워드마크 아님)",
    empSrc.includes("brandName={brand.custom ? brand.appName : null}"));
  console.log(`\n${fail ? "✗ 실패 " + fail : "✓ 전부 통과"} (${n}단언)\n`);
  process.exit(fail ? 1 : 0);
})();
