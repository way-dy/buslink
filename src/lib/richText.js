// 개선 요청 게시판 — 리치 텍스트(인라인 이미지) 정화·유틸 (2026-07-13)
//
// Buslink 는 Firebase Storage 미사용 → 붙여넣기 이미지를 압축 data URI 로
// content HTML 안에 인라인 저장한다(구조적으로 Storage 고아 0·비공개 게이트=doc read 규칙).
// 저장 시·표시 직전 모두 DOMPurify 로 재정화(XSS/L3 회피). style 속성은 미허용
// (인라인 img 크기는 .imp-content 컨테이너 CSS 로 제어).
//
// ⚠ 압축은 src/lib/image.js compressImageFile(file) → {dataUri, bytes} 재사용.
//   여기서 재구현 금지.

import DOMPurify from "dompurify";

// 허용 태그/속성 화이트리스트. style 미포함(FORBID_ATTR 로도 이중 차단).
// data:image base64 만 허용(svg 제외·javascript: 차단).
const CFG = {
  ALLOWED_TAGS: [
    "p", "br", "div", "span", "b", "strong", "i", "em", "u",
    "ul", "ol", "li", "a", "img", "h1", "h2", "h3", "blockquote",
  ],
  ALLOWED_ATTR: ["href", "src", "alt", "target", "rel", "width", "height", "class"],
  ALLOWED_URI_REGEXP: /^(https?:|data:image\/(png|jpeg|jpg|webp|gif);base64,)/i,
  FORBID_ATTR: ["style"],
};

// 허용 data: 이미지 형식(png/jpeg/webp/gif base64) — svg 등은 제외.
const ALLOWED_DATA_IMG = /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i;

// ⚠ DOMPurify 는 img 등 DATA_URI_TAGS 에 대해 ALLOWED_URI_REGEXP 를 우회해 임의 data:
//   URI(svg 포함)를 허용한다. 명시 요구(svg 제외·png/jpeg만)를 강제하려면 훅으로 직접 차단.
//   모듈 싱글턴이라 1회만 등록.
if (typeof DOMPurify.addHook === "function" && !DOMPurify.__buslinkImgHook) {
  DOMPurify.__buslinkImgHook = true;
  DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
    if (data.attrName === "src" || data.attrName === "href" || data.attrName === "xlink:href") {
      const v = (data.attrValue || "").trim();
      if (/^data:/i.test(v) && !ALLOWED_DATA_IMG.test(v)) {
        data.keepAttr = false;   // 허용 형식 아닌 data: URI 제거(svg·base64 아닌 것 등)
      }
    }
  });
}

/** HTML 문자열을 화이트리스트 기준으로 정화해 반환. 저장·표시 양쪽에서 호출. */
export function sanitizeContentHtml(html) {
  if (!html) return "";
  return DOMPurify.sanitize(String(html), CFG);
}

/** 문자열이 리치 HTML(허용 블록/인라인 태그 포함)로 보이는지. 레거시 평문과 분기용. */
export function looksLikeHtml(s) {
  if (!s || typeof s !== "string") return false;
  return /<(p|div|br|img|span|ul|ol|li|h[1-3]|blockquote|a|b|strong|em|i|u)\b/i.test(s);
}

/** 태그 제거 후 순수 텍스트. 작성 유효성 검사·미리보기용(DOMParser textContent). */
export function htmlToPlainText(html) {
  if (!html) return "";
  const s = String(html);
  // 브라우저 경로: DOMParser 로 안전하게 textContent 추출.
  if (typeof DOMParser !== "undefined") {
    try {
      const doc = new DOMParser().parseFromString(s, "text/html");
      return (doc.body.textContent || "").replace(/ /g, " ");
    } catch (e) { /* 폴백 */ }
  }
  // 비-DOM 환경 폴백(테스트 등): 태그 제거 후 공백 정리.
  return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/** UTF-8 바이트 크기(Firestore 1MB doc 한도 대비 총량 캡 산정용). */
export function htmlByteSize(html) {
  const s = html ? String(html) : "";
  if (typeof Blob !== "undefined") return new Blob([s]).size;
  // 비-Blob 환경 폴백(node 테스트).
  return new TextEncoder().encode(s).length;
}

/** content HTML 안에 인라인 이미지(<img>)가 있는지. 유효성 검사용(텍스트 없어도 이미지만이면 통과). */
export function contentHasImage(html) {
  return /<img\b/i.test(html || "");
}
