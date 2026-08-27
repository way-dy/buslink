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
              applyPartnerBranding, clearPartnerBranding, mixHex, relativeLuminance, isValidHexColor };`, ctx);
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

  // ── [7] 소스 가드 (복원 금지) ──────────────────────────────────
  console.log("\n[7] 소스 가드");
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

  console.log(`\n${fail ? "✗ 실패 " + fail : "✓ 전부 통과"} (${n}단언)\n`);
  process.exit(fail ? 1 : 0);
})();
