// 거래처별 UI 브랜딩 (2026-07-16 회의 #5) — partnerCodes/{code}.branding 적용 헬퍼.
// branding = { primaryColor?: "#RRGGBB", logo?: dataURI|null, logoHeight?: number }
// 색은 tokens.css CSS 변수 3종(--color-primary/-deep/-soft)을 :root 인라인으로 덮어써
// 앱 전역(버튼·칩·활성 상태)에 일괄 반영한다. 로고는 각 앱 헤더가 branding.logo 로 렌더.
// 순수 표시 계층 — rules/스키마 강제 없음. 잘못된 값이면 조용히 기본 테마 유지.
import { doc, getDoc } from "firebase/firestore";
import { db } from "../firebase";

const BRAND_VARS = [
  "--color-primary", "--color-primary-deep", "--color-primary-soft",
  // 2026-08-27 테마 확장분 — clear 에서 빠뜨리면 거래처를 옮겨도 색이 남는다.
  "--color-band", "--color-band-fg", "--color-accent", "--color-accent-soft",
];

export function isValidHexColor(s) {
  return typeof s === "string" && /^#[0-9a-fA-F]{6}$/.test(s.trim());
}

// ── 거래처 테마 (2026-08-27, 카카오 톤 요청에서 도출) ────────────────────────
// 여태 거래처가 정할 수 있는 색은 **하나**(primaryColor)뿐이었고 밴드·soft 는 거기서
// 파생(mixHex)했다. 그런데 카카오 톤앤매너는 **상단 밴드(곤색)와 주 버튼(파랑)이 서로 다른
// 색**이라 파생으로는 만들 수 없다 → 밴드·포인트를 독립 필드로 올린다.
//
// 🔴 **부재·모르는 값 = 현행**. theme 이 없으면 예전 `branding.primaryColor` 경로가 그대로
//    돌고, 그마저 없으면 기본 테마다. 이 폴백을 빼면 색을 설정해 둔 거래처가 한꺼번에 흔들린다.
// 🔴 값을 자유 입력이 아니라 **프리셋**으로 두는 이유 = 세 색이 서로 맞물려야 하고 한 칸만
//    어긋나면 오히려 조잡해 보인다. 개별 필드 덮어쓰기는 남겨 두되(예외 대응) 기본은 프리셋.
//
// theme = { preset?: "kakao", band?, accent?, accentSoft?, primary? }  (전부 "#RRGGBB")
export const THEME_PRESETS = {
  // 🔴 이 값들은 짐작이 아니라 카카오모빌리티 통근셔틀 소개서(`file/20260827/*.pdf`) 7쪽을
  //    렌더해 픽셀에서 읽은 것이다. 카카오 **공식** 옐로우(#FEE500)가 아니라 그 문서가
  //    실제로 쓰는 값(#FFCD00)을 따른다 — 상표가 아니라 톤을 맞추는 게 요청이었다.
  //
  // 🔴 워드마크(2026-08-28) — 2026-08-27 에는 **"색만, 상표는 넣지 않는다"** 였다(라이선스).
  //    그 결정을 뒤집는 근거는 고객 요청이다: 카카오모빌리티 윤지영 부장이 카톡으로
  //    "저 링크에 카카오모빌리티를 넣을 수 있을까요 버스링크에 / 카카오 T나" 라고 직접
  //    요청했고 way 가 승낙했다(2026-08-28). 그러니 이 값은 **우리가 고른 상표가 아니라
  //    상대가 지정한 표기**다. 다른 고객사에 임의로 복사하지 말 것.
  //    "카카오 T" 를 고른 이유 = 상대가 준 소개서 제목이 `[카카오 T] 통근셔틀 서비스 소개서`
  //    라 그쪽 서비스명이 그것이다. 회사명 표기를 원하면 이 한 줄만 "카카오모빌리티" 로 바꾼다.
  // 🔴 아이콘 3종(2026-08-28 way 승인 "아이콘도 사용해도 됨") — 파비콘·홈화면 아이콘·매니페스트.
  //    아이콘 도형은 짐작이 아니라 **고객이 준 소개서 7쪽의 앱 아이콘을 렌더해 노랑 픽셀 런을
  //    스캔한 좌표**로 다시 그린 벡터다(원본은 48px 남짓 래스터라 확대하면 뭉갠다).
  kakao: { band: "#1E233D", accent: "#FFCD00", accentSoft: "#FFF3C4", primary: "#4088FE",
           wordmark: "카카오 T", wordmarkSub: "통근셔틀",
           favicon: "/icons/kakao-t.svg", apple: "/icons/kakao-t-1024.png",
           manifest: "/manifest-kakao.json" },
};

const THEME_KEYS = ["band", "accent", "accentSoft", "primary"];
// 색이 아니라 **글자**인 테마 필드. 위 THEME_KEYS 와 검증 방식이 다르므로 따로 둔다.
const TEXT_KEYS = ["wordmark", "wordmarkSub"];
// 파비콘·홈화면 아이콘·매니페스트 경로. 값의 성격이 또 달라(같은 오리진 경로) 검증도 따로다.
const ASSET_KEYS = ["favicon", "apple", "manifest"];

/** 기본 브랜드 표기. 테마가 없거나 워드마크를 안 준 거래처는 전부 이 값이다(부재=현행). */
export const DEFAULT_WORDMARK = "BusLink";

/**
 * 아이콘·매니페스트 경로 정리 — **같은 오리진의 절대경로만** 인정한다.
 * 🔴 정규식을 쓰지 않는 이유는 취향이 아니다: 이 값은 `<link href>` 로 그대로 들어가므로
 *    거래처 문서에 외부 URL(`https://…`)이나 `//evil.example` 을 넣으면 **남의 서버가 우리 앱
 *    아이콘을 정하게 된다**. 스킴(`:`)·프로토콜 상대경로(`//`)·상위 이동(`..`)을 전부 막는다.
 */
export function sanitizeAssetPath(s) {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (!t || t.length > 80) return null;
  if (t.charAt(0) !== "/") return null;
  if (t.indexOf("//") !== -1 || t.indexOf(":") !== -1 || t.indexOf("..") !== -1) return null;
  return t;
}

/**
 * 워드마크 문자열 정리 — 앞뒤 공백·연속 공백·꺾쇠 제거 후 24자 이내만 인정.
 * 🔴 거래처 문서는 관리자가 자유 입력하는 값이라 그대로 렌더하지 않는다. 꺾쇠를 지우는 건
 *    XSS 방어가 아니라(React 가 이미 이스케이프한다) **인쇄물·문서 템플릿**이 같은 값을
 *    HTML 로 끼워 넣기 때문이다. 못 쓰는 값이면 null → 호출부가 기본 브랜드로 내려간다.
 */
export function sanitizeWordmark(s) {
  if (typeof s !== "string") return null;
  const t = s.replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  return t && t.length <= 24 ? t : null;
}

/**
 * 화면에 쓸 브랜드 표기. `resolveTheme` 결과를 받아 `{name, sub, custom}` 을 돌려준다.
 * 🔴 **부재 = 현행**: 테마가 없거나 워드마크가 없으면 이름은 "BusLink" 이고 `custom` 은
 *    false 다 — 호출부는 이 플래그로 "기본이면 예전 화면 그대로" 를 지킨다.
 */
export function brandOf(theme) {
  const name = (theme && theme.wordmark) || DEFAULT_WORDMARK;
  return {
    name,
    sub: (theme && theme.wordmarkSub) || null,
    custom: name !== DEFAULT_WORDMARK,
    // 부재면 null — 호출부가 «그 앱의 기본 아이콘»으로 되돌린다(거래처를 옮겼을 때 남의 아이콘이
    // 남지 않게. 색을 지우는 clearPartnerBranding 과 같은 이유다).
    favicon: (theme && theme.favicon) || null,
    apple: (theme && theme.apple) || null,
    manifest: (theme && theme.manifest) || null,
  };
}

/**
 * partnerCodes/{code} 문서에서 테마를 해석한다. 프리셋을 바탕으로 유효한 개별 필드만 덮어쓴다.
 * 테마가 없거나 알아볼 수 없으면 **null**(= 호출부가 기존 branding 경로로 내려간다).
 * 순수 함수(DOM·Firebase 접근 0).
 */
export function resolveTheme(codeData) {
  const t = codeData && codeData.theme;
  if (!t || typeof t !== "object") return null;
  const base = THEME_PRESETS[t.preset];
  // 프리셋도 없고 밴드·포인트도 없으면 테마라고 볼 근거가 없다(primary 하나면 옛 경로가 맞다).
  // 🔴 워드마크만 있는 문서도 여기서 걸러진다 — 일부러다. 테마로 인정하면 밴드색이
  //    기본 #003DCC 가 아니라 primary 파생(#004DBF)으로 «조용히» 바뀐다. 이름만 바꾸고
  //    싶은 거래처는 preset 이나 band 를 함께 지정해야 한다.
  if (!base && !isValidHexColor(t.band) && !isValidHexColor(t.accent)) return null;
  const out = { ...(base || {}) };
  THEME_KEYS.forEach((k) => { if (isValidHexColor(t[k])) out[k] = t[k].trim(); });
  // 글자 필드는 «준 경우에만» 손댄다. 빈 문자열은 "프리셋 워드마크를 끄겠다" 는 뜻으로 읽는다
  // (프리셋 색은 그대로 쓰되 상표만 빼고 싶은 거래처가 있을 수 있다 — 2026-08-27 이 그 상태였다).
  TEXT_KEYS.forEach((k) => {
    if (!(k in t)) return;
    const v = sanitizeWordmark(t[k]);
    if (v) out[k] = v; else delete out[k];
  });
  ASSET_KEYS.forEach((k) => {
    if (!(k in t)) return;
    const v = sanitizeAssetPath(t[k]);
    if (v) out[k] = v; else delete out[k];
  });
  if (!isValidHexColor(out.primary)) out.primary = "#0066FF";
  if (!isValidHexColor(out.band)) out.band = mixHex(out.primary, "#000000", 0.25);
  if (!isValidHexColor(out.accent)) out.accent = out.primary;
  if (!isValidHexColor(out.accentSoft)) out.accentSoft = mixHex(out.accent, "#ffffff", 0.86);
  return out;
}

/** 어떤 배경색 위에 글자를 얹을 때 흑/백 중 읽히는 쪽. 밴드·배지 공용. */
export function readableOn(hex) {
  // 0.45 = 흰 글씨가 편안한 경계(순수 노랑 #FFD400 도 여기서 어두운 글씨로 떨어진다)
  return relativeLuminance(hex) > 0.45 ? "#0B1020" : "#ffffff";
}

// 두 hex 색을 ratio 비율로 혼합(0=hex 그대로, 1=target). deep/soft 파생용 순수 함수.
export function mixHex(hex, target, ratio) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [r1, g1, b1] = p(hex); const [r2, g2, b2] = p(target);
  const c = (a, b) => Math.round(a + (b - a) * ratio).toString(16).padStart(2, "0");
  return `#${c(r1, r2)}${c(g1, g2)}${c(b1, b2)}`;
}

// ── 브랜드 밴드 대비 계산 (2026-08-10) ─────────────────────────────
// 홈 상단을 거래처 색으로 채우면 글자를 흰색으로 두는 게 보통이지만,
// 🔴 **밝은 브랜드색(노랑·라임 등)에서는 흰 글씨가 안 읽힌다.** 거래처가 색을 자유
// 입력하므로 흰색을 하드코딩하면 어느 고객사에서 반드시 깨진다 → 휘도로 정한다.
// 순수 함수(DOM·Firebase 접근 0) — 렌더 중 안전하게 호출 가능.
export function relativeLuminance(hex) {
  if (!isValidHexColor(hex)) return 0;
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/**
 * 홈 브랜드 밴드에 쓸 배경·전경색. branding 없으면 기본 테마(#003DCC).
 * `theme`(resolveTheme 결과)가 오면 **밴드색을 파생하지 않고 그 값을 그대로 쓴다** —
 * 밴드(곤색)와 CTA(파랑)가 다른 톤앤매너는 파생으로 만들 수 없다는 게 이 인자의 존재 이유다.
 * 🔴 글자색은 여전히 휘도로 정한다(하드코딩 금지) — 노랑을 밴드로 고른 거래처가 나오면
 *    흰 글씨가 안 읽힌다.
 */
export function brandBand(branding, theme) {
  const raw = branding && branding.primaryColor;
  const base = (theme && isValidHexColor(theme.band)) ? theme.band
    : (isValidHexColor(raw) ? mixHex(raw.trim(), "#000000", 0.25) : "#003DCC");
  const dark = relativeLuminance(base) > 0.45;
  return {
    bg: base,
    fg: dark ? "#0B1020" : "#ffffff",
    fgMute: dark ? "rgba(11,16,32,.66)" : "rgba(255,255,255,.78)",
    chipBg: dark ? "rgba(11,16,32,.10)" : "rgba(255,255,255,.16)",
    chipLine: dark ? "rgba(11,16,32,.22)" : "rgba(255,255,255,.34)",
  };
}

export function logoHeightOf(branding) {
  const h = Number(branding?.logoHeight);
  return isFinite(h) && h >= 20 && h <= 56 ? h : 28;
}

// 적용 — 유효한 primaryColor 있을 때만 덮어씀. 반환=적용 여부.
export function applyPartnerBranding(branding) {
  const root = document.documentElement;
  const raw = branding && branding.primaryColor;
  if (!isValidHexColor(raw)) { clearPartnerBranding(); return false; }
  const color = raw.trim();
  root.style.setProperty("--color-primary", color);
  root.style.setProperty("--color-primary-deep", mixHex(color, "#000000", 0.25));
  root.style.setProperty("--color-primary-soft", mixHex(color, "#ffffff", 0.9));
  return true;
}

/**
 * 거래처 문서 하나로 테마·브랜딩을 한 번에 적용하는 **정본 진입점**(2026-08-27).
 * 반환 = 적용된 테마 객체(없으면 null) — 호출부가 `brandBand(branding, theme)` 에 그대로 넘긴다.
 *
 * 🔴 테마가 없으면 기존 `applyPartnerBranding` 경로로 내려간다(현행 100% 보존).
 * 🔴 `--color-accent` 기본값은 tokens.css 에서 `var(--color-primary)` 다 — 즉 테마를 안 쓰는
 *    거래처에서는 accent 를 읽는 자리도 지금과 **같은 색**이 나온다. 이 기본값을 지우면
 *    설정 안 한 8개 거래처의 배지·칩이 한꺼번에 빈 색이 된다.
 */
export function applyPartnerTheme(codeData) {
  const theme = resolveTheme(codeData);
  if (!theme) { applyPartnerBranding(codeData && codeData.branding); return null; }
  const root = document.documentElement;
  root.style.setProperty("--color-primary", theme.primary);
  root.style.setProperty("--color-primary-deep", mixHex(theme.primary, "#000000", 0.25));
  root.style.setProperty("--color-primary-soft", mixHex(theme.primary, "#ffffff", 0.9));
  root.style.setProperty("--color-band", theme.band);
  root.style.setProperty("--color-band-fg", readableOn(theme.band));
  root.style.setProperty("--color-accent", theme.accent);
  root.style.setProperty("--color-accent-soft", theme.accentSoft);
  return theme;
}

export function clearPartnerBranding() {
  const root = document.documentElement;
  BRAND_VARS.forEach((v) => root.style.removeProperty(v));
}

// partnerCodes/{code} 원문 조회(read 규칙 공개) — 실패/부재는 null.
// 브랜딩·문의 등 승객앱 표시 옵션이 **한 문서**에서 나오므로 읽기는 여기 한 번만 하고
// 각 헬퍼가 필요한 필드만 뽑아 쓴다(옵션 하나 늘 때마다 getDoc 이 늘지 않게).
export async function fetchPartnerCodeData(partnerCode) {
  if (!partnerCode) return null;
  try {
    const snap = await getDoc(doc(db, "partnerCodes", partnerCode));
    return snap.exists() ? (snap.data() || null) : null;
  } catch (_) {
    return null;
  }
}

// partnerCodes/{code}.branding 조회 — 실패/부재는 null(기본 테마).
export async function fetchPartnerBranding(partnerCode) {
  const data = await fetchPartnerCodeData(partnerCode);
  return data ? (data.branding || null) : null;
}
