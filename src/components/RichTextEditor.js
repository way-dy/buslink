// 경량 contentEditable 리치 텍스트 에디터 (2026-07-13, 개선 요청 게시판용)
//
// 순수 프레젠테이션 — Firebase import 금지. 서드파티 에디터 라이브러리 금지(YDYOPS 패턴).
// 본문에 이미지 붙여넣기(Ctrl+V) → 압축 data URI <img> 인라인 삽입 + 평문 붙여넣기.
// 서식 툴바 없음(이미지 인라인 + 평문이 목적·최소 구현).
//
// - uncontrolled: 마운트 1회만 innerHTML=value 주입(initializedRef). 외부 값 변경은 부모가 key remount.
// - onInput 디바운스(200ms) onChange, blur 즉시 flush.
// - onPaste: 이미지 있으면 preventDefault → 각 파일 await compressImageFile → 삽입(동기 흐름·race 없음·placeholder 없음)
//   → 같은 클립보드 text/plain 도 이어서 삽입(텍스트+이미지 혼합 유실 방지).
//   이미지 없으면 preventDefault + execCommand insertText(서식 폭주 차단·개행 보존).

import { useRef, useState, useEffect, useCallback } from "react";
import { compressImageFile } from "../lib/image";  // 순수 canvas 압축(Firebase 아님)

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export default function RichTextEditor({
  value = "",
  onChange,
  placeholder = "",
  onImageError,
  maxImages = 8,
  disabled = false,
}) {
  const ref = useRef(null);
  const initializedRef = useRef(false);
  const debounceRef = useRef(null);
  const [isEmpty, setIsEmpty] = useState(true);

  // 마운트 1회만 초기 HTML 주입(uncontrolled). 이후 부모가 값 바꾸려면 key remount.
  useEffect(() => {
    if (ref.current && !initializedRef.current) {
      ref.current.innerHTML = value || "";
      initializedRef.current = true;
      refreshEmpty();
    }
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshEmpty = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const hasText = (el.textContent || "").trim().length > 0;
    const hasImg = !!el.querySelector("img");
    setIsEmpty(!hasText && !hasImg);
  }, []);

  const emitChange = useCallback(() => {
    if (ref.current && onChange) onChange(ref.current.innerHTML);
    refreshEmpty();
  }, [onChange, refreshEmpty]);

  const onInput = useCallback(() => {
    refreshEmpty();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (ref.current && onChange) onChange(ref.current.innerHTML);
    }, 200);
  }, [onChange, refreshEmpty]);

  const onBlur = useCallback(() => {
    if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
    emitChange();
  }, [emitChange]);

  // Selection/Range 기반 caret 삽입. 에디터 밖 caret 이면 끝에 append.
  const insertHtmlAtCaret = useCallback((html) => {
    const editor = ref.current;
    if (!editor) return;
    editor.focus();
    const sel = window.getSelection();
    let range;
    if (sel && sel.rangeCount > 0 && editor.contains(sel.anchorNode)) {
      range = sel.getRangeAt(0);
      range.deleteContents();
    } else {
      range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);   // 끝으로
    }
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    const frag = document.createDocumentFragment();
    let node, lastNode = null;
    while ((node = tmp.firstChild)) { lastNode = frag.appendChild(node); }
    range.insertNode(frag);
    if (lastNode && sel) {
      const after = document.createRange();
      after.setStartAfter(lastNode);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
    }
  }, []);

  const insertTextAtCaret = useCallback((text) => {
    if (!text) return;
    insertHtmlAtCaret(escapeHtml(text).replace(/\n/g, "<br>"));
  }, [insertHtmlAtCaret]);

  const onPaste = useCallback(async (e) => {
    if (disabled) return;
    const cd = e.clipboardData;
    if (!cd) return;
    const imageFiles = Array.from(cd.items || [])
      .filter(it => it.kind === "file" && it.type && it.type.startsWith("image/"))
      .map(it => it.getAsFile())
      .filter(Boolean);
    const plain = cd.getData("text/plain");

    if (imageFiles.length > 0) {
      e.preventDefault();
      const existing = ref.current ? ref.current.querySelectorAll("img").length : 0;
      let room = Math.max(0, maxImages - existing);
      if (imageFiles.length > room && onImageError) {
        onImageError(`이미지는 최대 ${maxImages}장까지 삽입할 수 있습니다`);
      }
      for (const file of imageFiles) {
        if (room <= 0) break;   // 초과분 skip
        try {
          const { dataUri } = await compressImageFile(file);   // 동기 대기 = race 없음
          insertHtmlAtCaret('<img src="' + dataUri + '" alt="첨부 이미지">');
          room -= 1;
        } catch (ex) {
          if (onImageError) onImageError(ex.message || "이미지 처리 실패");
        }
      }
      // 텍스트+이미지 혼합 붙여넣기 텍스트 유실 방지 — 이미지 처리 후 평문도 이어서 삽입.
      if (plain) insertTextAtCaret(plain);
      emitChange();
      return;
    }

    // 이미지 없음 — 서식 폭주 차단 + 개행 보존(평문만 삽입).
    e.preventDefault();
    let ok = false;
    try { ok = document.execCommand("insertText", false, plain || ""); } catch (ex) { ok = false; }
    if (!ok) insertTextAtCaret(plain || "");
    emitChange();
  }, [disabled, maxImages, onImageError, insertHtmlAtCaret, insertTextAtCaret, emitChange]);

  return (
    <div style={{ position: "relative" }}>
      <div
        ref={ref}
        className="rte-editor"
        contentEditable={!disabled}
        suppressContentEditableWarning
        onInput={onInput}
        onBlur={onBlur}
        onPaste={onPaste}
        style={{
          minHeight: 120,
          border: "1px solid var(--color-line)",
          borderRadius: 10,
          padding: "10px 12px",
          fontSize: 13,
          lineHeight: 1.6,
          color: "var(--color-label)",
          background: disabled ? "var(--color-bg-soft)" : "var(--color-bg)",
          outline: "none",
          overflowY: "auto",
          maxHeight: 320,
          wordBreak: "break-word",
          fontFamily: "inherit",
        }}
      />
      {isEmpty && placeholder && (
        <div style={{
          position: "absolute", top: 10, left: 12, right: 12,
          color: "var(--color-label-alt)", fontSize: 13, lineHeight: 1.6,
          pointerEvents: "none", userSelect: "none",
        }}>
          {placeholder}
        </div>
      )}
    </div>
  );
}
