// Buslink 매뉴얼 PPT — 모노디자인 빌딩 블록
// "한 화면 = 한 슬라이드". 무채색(검정/회색) + 단일 포인트색 #0066FF 만.
// 콘텐츠 정본 = docs/manual/{ADMIN,DRIVER,EMPLOYEE}_GUIDE.md (그대로 옮김, 새로 쓰지 않음).
// 스크린샷 = assets/{admin,driver,employee}/*.png (이미 캡처+PII 마스킹 완료, 그대로 임베드만).
const fs = require("fs");
const path = require("path");

// ── 모노 팔레트 ─────────────────────────────────────────
const C = {
  accent:   "0066FF",   // 단일 포인트색 (제목 강조선·단계 번호·핵심 버튼명)
  accentBg: "EAF2FE",   // 표지·핵심 강조 옅은 파랑
  bg:       "FFFFFF",
  panel:    "F5F6F7",   // 주의/팁 회색 박스
  panelLine:"E3E5E8",
  line:     "E5E7EB",
  hair:     "F1F2F4",
  t1:       "1A1A1A",   // 제목
  t2:       "3C3C3C",   // 본문
  t3:       "707070",   // 보조
  t4:       "9AA0A6",   // 캡션
  white:    "FFFFFF",
};
const FONT = "맑은 고딕";

// 16:9 = 13.333 x 7.5 inch
const PAGE_W = 13.333;
const PAGE_H = 7.5;

// ── PNG 차원 자동 감지 (IHDR, 외부 의존 0) ──────────────
function getPngSize(file) {
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(24);
    fs.readSync(fd, buf, 0, 24, 0);
    fs.closeSync(fd);
    if (buf[0] !== 0x89 || buf[1] !== 0x50) return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  } catch (e) { return null; }
}

// ── 표지 (제목 + 부제 + 흰 룰) ───────────────────────────
function cover(pptx, opts) {
  const s = pptx.addSlide();
  s.background = { color: C.accent };
  // 좌상단 라벨
  s.addText(opts.label || "BUSLINK", {
    x: 0.7, y: 0.7, w: 11, h: 0.5,
    fontFace: FONT, fontSize: 15, color: C.white, charSpacing: 2, transparency: 25,
  });
  // 제목
  s.addText(opts.title, {
    x: 0.7, y: 2.5, w: 12, h: 1.5,
    fontFace: FONT, fontSize: 54, color: C.white, bold: true,
  });
  // 흰 룰
  s.addShape("rect", { x: 0.75, y: 4.15, w: 3.2, h: 0.05, fill: { color: C.white }, line: { color: C.white } });
  // 부제
  if (opts.subtitle) {
    s.addText(opts.subtitle, {
      x: 0.7, y: 4.4, w: 12, h: 0.7,
      fontFace: FONT, fontSize: 20, color: C.white, transparency: 12,
    });
  }
  s.addText(opts.meta || "동영관광 · BusLink", {
    x: 0.7, y: 6.7, w: 12, h: 0.4,
    fontFace: FONT, fontSize: 12, color: C.white, transparency: 30,
  });
  return s;
}

// ── 콘텐츠 슬라이드 헤더 (제목 + #0066FF 강조선) ─────────
function header(s, idx, total, title, sub, brand) {
  s.background = { color: C.bg };
  // 상단 얇은 액센트 바
  s.addShape("rect", { x: 0, y: 0, w: PAGE_W, h: 0.06, fill: { color: C.accent }, line: { color: C.accent } });
  // 번호 칩 (#0066FF)
  s.addShape("roundRect", {
    x: 0.5, y: 0.42, w: 0.62, h: 0.62, rectRadius: 0.1,
    fill: { color: C.accent }, line: { color: C.accent },
  });
  s.addText(String(idx), {
    x: 0.5, y: 0.42, w: 0.62, h: 0.62,
    fontFace: FONT, fontSize: 22, color: C.white, bold: true, align: "center", valign: "middle",
  });
  // 제목
  s.addText(title, {
    x: 1.28, y: 0.4, w: 11.5, h: 0.55,
    fontFace: FONT, fontSize: 26, color: C.t1, bold: true, valign: "middle",
  });
  if (sub) {
    s.addText(sub, {
      x: 1.3, y: 0.96, w: 11.5, h: 0.34,
      fontFace: FONT, fontSize: 13, color: C.t3,
    });
  }
  // 헤더 하단 헤어라인
  s.addShape("rect", { x: 0.5, y: 1.42, w: 12.33, h: 0.018, fill: { color: C.line }, line: { color: C.line } });
  // 푸터
  s.addText(brand || "BusLink · 동영관광", {
    x: 0.5, y: 7.16, w: 7, h: 0.25, fontFace: FONT, fontSize: 9, color: C.t4,
  });
  s.addText(`${idx} / ${total}`, {
    x: 6.8, y: 7.16, w: 6.03, h: 0.25, fontFace: FONT, fontSize: 9, color: C.t4, align: "right",
  });
}

// ── 좌측 본문 (리드 문장 + 단계 + 주의/팁 박스) ─────────
// blocks: [{type:'lead', text}, {type:'steps', items:[{n, text}]}, {type:'bullets', items:[...]},
//          {type:'note', kind:'주의'|'팁', text}]
function leftBody(s, blocks, opts) {
  const x = opts?.x ?? 0.5;
  const w = opts?.w ?? 8.5;
  let y = opts?.y ?? 1.75;

  for (const b of blocks) {
    if (b.type === "lead") {
      const h = estTextH(b.text, w, 14, 1.35);
      s.addText(b.text, {
        x, y, w, h,
        fontFace: FONT, fontSize: 14, color: C.t2, valign: "top", lineSpacingMultiple: 1.2,
      });
      y += h + 0.14;
    } else if (b.type === "steps") {
      for (const it of b.items) {
        const txtH = estTextH(it.text, w - 0.62, 13.5, 1.3);
        const rowH = Math.max(0.46, txtH);
        // 번호 원 (#0066FF)
        s.addShape("ellipse", {
          x, y: y + 0.02, w: 0.4, h: 0.4,
          fill: { color: C.accent }, line: { color: C.accent },
        });
        s.addText(String(it.n), {
          x, y: y + 0.02, w: 0.4, h: 0.4,
          fontFace: FONT, fontSize: 14, color: C.white, bold: true, align: "center", valign: "middle",
        });
        s.addText(it.text, {
          x: x + 0.58, y, w: w - 0.58, h: rowH,
          fontFace: FONT, fontSize: 13.5, color: C.t2, valign: "top", lineSpacingMultiple: 1.12,
        });
        y += rowH + 0.18;
      }
    } else if (b.type === "bullets") {
      for (const it of b.items) {
        const txtH = estTextH(it, w - 0.32, 13.5, 1.3);
        const rowH = Math.max(0.34, txtH);
        s.addShape("rect", {
          x: x + 0.04, y: y + 0.12, w: 0.11, h: 0.11,
          fill: { color: C.accent }, line: { color: C.accent },
        });
        s.addText(it, {
          x: x + 0.32, y, w: w - 0.32, h: rowH,
          fontFace: FONT, fontSize: 13.5, color: C.t2, valign: "top", lineSpacingMultiple: 1.12,
        });
        y += rowH + 0.14;
      }
    } else if (b.type === "note") {
      const innerW = w - 0.7;
      const txtH = estTextH(b.text, innerW, 12.5, 1.3);
      const boxH = Math.max(0.62, txtH + 0.34);
      s.addShape("roundRect", {
        x, y, w, h: boxH, rectRadius: 0.06,
        fill: { color: C.panel }, line: { color: C.panelLine, width: 0.75 },
      });
      s.addShape("rect", { x, y, w: 0.07, h: boxH, fill: { color: C.t3 }, line: { color: C.t3 } });
      s.addText(`${b.kind || "주의"}  ${b.text}`, {
        x: x + 0.24, y: y + 0.12, w: innerW, h: boxH - 0.24,
        fontFace: FONT, fontSize: 12.5, color: C.t2, valign: "middle", lineSpacingMultiple: 1.12,
      });
      y += boxH + 0.16;
    }
  }
  return y;
}

// 텍스트 높이 추정 (대략 — 슬라이드 넘침 방지용 보수적 산정)
// w(inch), fontSize(pt). 한글 폭을 넉넉히 잡아 wrap 줄 수 추정.
function estTextH(text, w, fontSize, lh) {
  const charsPerLine = Math.max(8, Math.floor((w * 72) / (fontSize * 0.92)));
  let lines = 0;
  for (const seg of String(text).split("\n")) {
    lines += Math.max(1, Math.ceil((seg.length || 1) / charsPerLine));
  }
  const lineH = (fontSize * (lh || 1.3)) / 72;
  return lines * lineH + 0.12;
}

// ── 우측 스크린샷 (비율 유지 contain, 잘림 0) ──────────────
// kind: 'admin'|'driver'|'employee', name: 파일명. opts.frame 박스 영역.
function shot(s, kind, name, opts) {
  const x = opts.x, y = opts.y, w = opts.w, h = opts.h;
  const imgPath = path.join(__dirname, "assets", kind, name);
  const exists = fs.existsSync(imgPath);
  const pad = 0.12;

  // 액자 (얇은 회색 보더)
  s.addShape("roundRect", {
    x, y, w, h, rectRadius: 0.07,
    fill: { color: exists ? C.white : C.panel },
    line: { color: C.line, width: 1 },
  });

  if (exists) {
    s.addImage({
      path: imgPath,
      x: x + pad, y: y + pad,
      w: w - pad * 2, h: h - pad * 2,
      sizing: { type: "contain", w: w - pad * 2, h: h - pad * 2 },
    });
  } else {
    s.addText("화면 캡처", {
      x, y, w, h, fontFace: FONT, fontSize: 13, color: C.t4,
      align: "center", valign: "middle",
    });
  }
  if (opts.caption) {
    s.addText(opts.caption, {
      x, y: y + h + 0.04, w, h: 0.28,
      fontFace: FONT, fontSize: 9.5, color: C.t4, align: "center",
    });
  }
}

// ── placeholder 슬라이드 본문 (운영 중 캡처 필요 — 점선 박스) ──
function placeholderBox(s, opts) {
  const x = opts.x, y = opts.y, w = opts.w, h = opts.h;
  s.addShape("roundRect", {
    x, y, w, h, rectRadius: 0.08,
    fill: { color: C.panel },
    line: { color: C.t4, width: 1.25, dashType: "dash" },
  });
  s.addText("📷", {
    x, y: y + h / 2 - 0.85, w, h: 0.7,
    fontFace: FONT, fontSize: 40, color: C.t4, align: "center", valign: "middle",
  });
  s.addText("운영 중 캡처 필요", {
    x, y: y + h / 2 - 0.12, w, h: 0.4,
    fontFace: FONT, fontSize: 16, color: C.t3, bold: true, align: "center", valign: "middle",
  });
  s.addText(opts.note || "운행 시간대에 본인 휴대폰에서 캡처해 넣어 주세요.", {
    x: x + 0.4, y: y + h / 2 + 0.34, w: w - 0.8, h: 0.7,
    fontFace: FONT, fontSize: 12, color: C.t4, align: "center", valign: "top", lineSpacingMultiple: 1.15,
  });
}

// ── 마무리 슬라이드 ──────────────────────────────────────
function closing(pptx, opts) {
  const s = pptx.addSlide();
  s.background = { color: C.bg };
  s.addShape("roundRect", {
    x: 1.4, y: 1.7, w: 10.53, h: 4.1, rectRadius: 0.12,
    fill: { color: C.accentBg }, line: { color: C.accent, width: 1.5 },
  });
  s.addText("🚌", {
    x: 1.4, y: 2.0, w: 10.53, h: 1.0,
    fontFace: FONT, fontSize: 50, color: C.accent, align: "center",
  });
  s.addText(opts.title || "감사합니다", {
    x: 1.4, y: 3.0, w: 10.53, h: 0.9,
    fontFace: FONT, fontSize: 30, color: C.t1, bold: true, align: "center",
  });
  if (opts.lines) {
    s.addText(opts.lines.map((l) => `• ${l}`).join("\n"), {
      x: 2.6, y: 3.95, w: 8.13, h: 1.7,
      fontFace: FONT, fontSize: 14, color: C.t2, valign: "top", lineSpacingMultiple: 1.35,
    });
  }
  s.addText("동영관광 · BusLink", {
    x: 0.5, y: 6.6, w: 12.33, h: 0.4,
    fontFace: FONT, fontSize: 11, color: C.t4, align: "center",
  });
  return s;
}

module.exports = {
  C, FONT, PAGE_W, PAGE_H,
  cover, header, leftBody, shot, placeholderBox, closing, getPngSize, estTextH,
};
