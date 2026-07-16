// 거래처별 UI 브랜딩 (2026-07-16 회의 #5) — partnerCodes/{code}.branding 적용 헬퍼.
// branding = { primaryColor?: "#RRGGBB", logo?: dataURI|null, logoHeight?: number }
// 색은 tokens.css CSS 변수 3종(--color-primary/-deep/-soft)을 :root 인라인으로 덮어써
// 앱 전역(버튼·칩·활성 상태)에 일괄 반영한다. 로고는 각 앱 헤더가 branding.logo 로 렌더.
// 순수 표시 계층 — rules/스키마 강제 없음. 잘못된 값이면 조용히 기본 테마 유지.
import { doc, getDoc } from "firebase/firestore";
import { db } from "../firebase";

const BRAND_VARS = ["--color-primary", "--color-primary-deep", "--color-primary-soft"];

export function isValidHexColor(s) {
  return typeof s === "string" && /^#[0-9a-fA-F]{6}$/.test(s.trim());
}

// 두 hex 색을 ratio 비율로 혼합(0=hex 그대로, 1=target). deep/soft 파생용 순수 함수.
export function mixHex(hex, target, ratio) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [r1, g1, b1] = p(hex); const [r2, g2, b2] = p(target);
  const c = (a, b) => Math.round(a + (b - a) * ratio).toString(16).padStart(2, "0");
  return `#${c(r1, r2)}${c(g1, g2)}${c(b1, b2)}`;
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

export function clearPartnerBranding() {
  const root = document.documentElement;
  BRAND_VARS.forEach((v) => root.style.removeProperty(v));
}

// partnerCodes/{code}.branding 조회(read 규칙 공개) — 실패/부재는 null(기본 테마).
export async function fetchPartnerBranding(partnerCode) {
  if (!partnerCode) return null;
  try {
    const snap = await getDoc(doc(db, "partnerCodes", partnerCode));
    return snap.exists() ? (snap.data().branding || null) : null;
  } catch (_) {
    return null;
  }
}
