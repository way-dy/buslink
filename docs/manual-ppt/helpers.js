// 슬라이드 공통 빌딩 블록 — callcenter 정본 패턴 그대로(검증된 마커/그리드/카드).
const T = require("./theme");
const fs = require("fs");
const path = require("path");

// PNG 차원 자동 감지 (IHDR chunk parse) — 외부 의존성 없음
function getPngSize(file) {
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(24);
    fs.readSync(fd, buf, 0, 24, 0);
    fs.closeSync(fd);
    if (buf[0] !== 0x89 || buf[1] !== 0x50) return null;
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    return { w, h };
  } catch (e) {
    return null;
  }
}

// 그리드 가이드 (MARKER_GRID=1 환경변수 시 캡처 위에 5% 격자 + 좌표 라벨)
const SHOW_GRID = process.env.MARKER_GRID === "1";

// 캡처 이미지 존재 시 슬라이드에 삽입, 없으면 placeholder 박스
// + 이미지 위에 번호 마커 핀 (markers: [{rx, ry, n}] — 비율 0~1)
// kind: 'admin' | 'driver' | 'employee', name: 파일명(확장자 포함)
function shotOrPlaceholder(s, kind, name, opts) {
  const x = opts.x ?? 6.8;
  const y = opts.y ?? 1.7;
  const w = opts.w ?? 6.2;
  const h = opts.h ?? 4.8;
  const imgPath = path.join(__dirname, "assets", kind, name);
  const exists = fs.existsSync(imgPath);
  const pad = 0.1;

  s.addShape("roundRect", {
    x, y, w, h,
    fill: { color: exists ? T.surface : T.surfaceAlt },
    line: { color: T.border, width: 1, ...(exists ? {} : { dashType: "dash" }) },
    rectRadius: 0.08,
  });

  if (exists) {
    const sz = getPngSize(imgPath);
    const imgRatio = sz ? (sz.w / sz.h) : (opts.imgRatio || 1.6);

    s.addImage({
      path: imgPath,
      x: x + pad, y: y + pad,
      w: w - pad * 2, h: h - pad * 2,
      sizing: { type: "contain", w: w - pad * 2, h: h - pad * 2 },
    });

    // contain 박스 안 실제 이미지가 그려지는 영역 계산
    const boxW = w - pad * 2;
    const boxH = h - pad * 2;
    const boxRatio = boxW / boxH;
    let imgW, imgH, imgX, imgY;
    if (imgRatio > boxRatio) {
      imgW = boxW; imgH = boxW / imgRatio;
      imgX = x + pad; imgY = y + pad + (boxH - imgH) / 2;
    } else {
      imgH = boxH; imgW = boxH * imgRatio;
      imgX = x + pad + (boxW - imgW) / 2; imgY = y + pad;
    }

    if (SHOW_GRID) {
      const gridStep = 0.05;
      for (let i = 1; i < 20; i++) {
        s.addShape("rect", {
          x: imgX + imgW * i * gridStep, y: imgY,
          w: 0.005, h: imgH,
          fill: { color: "FF0000" }, line: { color: "FF0000" },
          transparency: 60,
        });
        s.addShape("rect", {
          x: imgX, y: imgY + imgH * i * gridStep,
          w: imgW, h: 0.005,
          fill: { color: "FF0000" }, line: { color: "FF0000" },
          transparency: 60,
        });
      }
      for (let xi = 1; xi < 10; xi++) {
        for (let yi = 1; yi < 10; yi++) {
          const rx = xi * 0.1;
          const ry = yi * 0.1;
          s.addText(`${rx.toFixed(1)},${ry.toFixed(1)}`, {
            x: imgX + imgW * rx - 0.25,
            y: imgY + imgH * ry - 0.1,
            w: 0.5, h: 0.2,
            fontFace: T.font, fontSize: 7, color: "FF0000",
            align: "center", valign: "middle",
          });
        }
      }
    }

    // 번호 마커 — 속 비운 빨간 ring
    if (opts.markers && opts.markers.length) {
      const markerSize = 0.38;
      const innerPad = 0.09;
      opts.markers.forEach((m) => {
        const mx = imgX + imgW * m.rx - markerSize / 2;
        const my = imgY + imgH * m.ry - markerSize / 2;
        s.addShape("ellipse", {
          x: mx - 0.045, y: my - 0.045,
          w: markerSize + 0.09, h: markerSize + 0.09,
          fill: { color: T.white }, line: { color: T.white },
        });
        s.addShape("ellipse", {
          x: mx, y: my, w: markerSize, h: markerSize,
          fill: { type: "none" },
          line: { color: T.red, width: 3 },
        });
        s.addShape("ellipse", {
          x: mx + innerPad, y: my + innerPad,
          w: markerSize - innerPad * 2, h: markerSize - innerPad * 2,
          fill: { color: T.white }, line: { color: T.red, width: 0.5 },
        });
        s.addText(String(m.n), {
          x: mx, y: my, w: markerSize, h: markerSize,
          fontFace: T.fontBold, fontSize: 14, color: T.red, bold: true,
          align: "center", valign: "middle",
        });
      });
    }
  } else {
    s.addText(`📷 ${name}\n(캡처 예정)`, {
      x, y, w, h,
      fontFace: T.font, fontSize: 14, color: T.t4,
      align: "center", valign: "middle",
    });
  }

  if (opts.caption) {
    s.addText(opts.caption, {
      x, y: y + h + 0.05, w, h: 0.3,
      fontFace: T.font, fontSize: 10, color: T.t4, align: "center",
    });
  }
}

// 좌측 번호 매칭 설명 (번호 마커 ①②③ ↔ 본문)
function numberedList(s, items, opts) {
  const x = opts?.x ?? 0.5;
  const y = opts?.y ?? 2.7;
  const w = opts?.w ?? 6.0;
  const rowH = opts?.rowH ?? 0.85;
  const markerSize = 0.4;

  items.forEach((it, i) => {
    const ry = y + i * rowH;
    s.addShape("ellipse", {
      x, y: ry + 0.05, w: markerSize, h: markerSize,
      fill: { color: T.red }, line: { color: T.red },
    });
    s.addText(String(it.n), {
      x, y: ry + 0.05, w: markerSize, h: markerSize,
      fontFace: T.fontBold, fontSize: 16, color: T.white, bold: true,
      align: "center", valign: "middle",
    });
    s.addText(it.title, {
      x: x + markerSize + 0.15, y: ry, w: w - markerSize - 0.15, h: 0.4,
      fontFace: T.fontBold, fontSize: 14, color: T.t1, bold: true,
    });
    s.addText(it.body, {
      x: x + markerSize + 0.15, y: ry + 0.36, w: w - markerSize - 0.15, h: rowH - 0.4,
      fontFace: T.font, fontSize: 12, color: T.t2,
    });
  });
}

// 표지 슬라이드
function cover(pptx, opts) {
  const s = pptx.addSlide();
  s.background = { color: T.brand };
  s.addText(opts.label || "Buslink", {
    x: 0.6, y: 0.6, w: 12, h: 0.5,
    fontFace: T.font, fontSize: 16, color: T.white, bold: false,
    transparency: 30,
  });
  s.addText(opts.title, {
    x: 0.6, y: 2.2, w: 12, h: 1.6,
    fontFace: T.fontBold, fontSize: 60, color: T.white, bold: true,
  });
  if (opts.subtitle) {
    s.addText(opts.subtitle, {
      x: 0.6, y: 3.9, w: 12, h: 0.8,
      fontFace: T.font, fontSize: 22, color: T.white, transparency: 15,
    });
  }
  s.addText(opts.meta || "동영관광 · 2026", {
    x: 0.6, y: 6.7, w: 12, h: 0.4,
    fontFace: T.font, fontSize: 13, color: T.white, transparency: 30,
  });
  return s;
}

// 섹션 구분 슬라이드
function section(pptx, num, title, subtitle) {
  const s = pptx.addSlide();
  s.background = { color: T.bg };
  s.addShape("rect", { x: 0, y: 0, w: 0.25, h: 7.5, fill: { color: T.brand }, line: { color: T.brand } });
  s.addText(`SECTION ${num}`, {
    x: 0.8, y: 2.7, w: 12, h: 0.5,
    fontFace: T.font, fontSize: 14, color: T.brand, bold: true,
  });
  s.addText(title, {
    x: 0.8, y: 3.2, w: 12, h: 1.4,
    fontFace: T.fontBold, fontSize: 48, color: T.t1, bold: true,
  });
  if (subtitle) {
    s.addText(subtitle, {
      x: 0.8, y: 4.7, w: 12, h: 0.8,
      fontFace: T.font, fontSize: 20, color: T.t3,
    });
  }
  return s;
}

// 일반 콘텐츠 슬라이드 헤더
function header(s, title, sub) {
  s.background = { color: T.surface };
  s.addShape("rect", { x: 0, y: 0, w: 13.333, h: 0.08, fill: { color: T.brand }, line: { color: T.brand } });
  s.addText(title, {
    x: 0.5, y: 0.35, w: 12.3, h: 0.7,
    fontFace: T.fontBold, fontSize: 28, color: T.t1, bold: true,
  });
  if (sub) {
    s.addText(sub, {
      x: 0.5, y: 1.05, w: 12.3, h: 0.45,
      fontFace: T.font, fontSize: 14, color: T.t3,
    });
  }
  s.addShape("rect", { x: 0.5, y: 7.15, w: 12.3, h: 0.02, fill: { color: T.hairline }, line: { color: T.hairline } });
}

// 포인트 카드
function pointCards(s, items, opts) {
  const top = opts?.top || 1.7;
  const height = opts?.height || 2.2;
  const left = 0.5;
  const totalW = 12.3;
  const gap = 0.2;
  const cardW = (totalW - gap * (items.length - 1)) / items.length;

  const toneMap = {
    brand:  { bg: T.brandSubtle,  bar: T.brand,  ink: T.brandInk },
    red:    { bg: T.redSoft,      bar: T.red,    ink: T.redInk },
    orange: { bg: T.orangeSoft,   bar: T.orange, ink: T.orangeInk },
    yellow: { bg: T.yellowSoft,   bar: T.yellow, ink: T.yellowInk },
    green:  { bg: T.greenSoft,    bar: T.green,  ink: T.greenInk },
    grey:   { bg: T.surfaceAlt,   bar: T.t3,     ink: T.t2 },
  };

  items.forEach((it, i) => {
    const x = left + i * (cardW + gap);
    const tone = toneMap[it.color || "brand"];
    s.addShape("roundRect", {
      x, y: top, w: cardW, h: height,
      fill: { color: tone.bg }, line: { color: tone.bg },
      rectRadius: 0.1,
    });
    s.addShape("rect", {
      x, y: top, w: 0.08, h: height,
      fill: { color: tone.bar }, line: { color: tone.bar },
    });
    if (it.icon) {
      s.addText(it.icon, {
        x: x + 0.2, y: top + 0.15, w: 1.0, h: 0.7,
        fontFace: T.font, fontSize: 32, color: tone.ink,
      });
    }
    s.addText(it.title, {
      x: x + 0.25, y: top + 0.9, w: cardW - 0.4, h: 0.55,
      fontFace: T.fontBold, fontSize: 17, color: tone.ink, bold: true,
    });
    s.addText(it.body, {
      x: x + 0.25, y: top + 1.45, w: cardW - 0.4, h: height - 1.5,
      fontFace: T.font, fontSize: 13, color: T.t2,
      valign: "top",
    });
  });
}

// 큰 강조 박스
function calloutBox(s, opts) {
  const toneMap = {
    brand:  { bg: T.brandSubtle,  bar: T.brand,  ink: T.brandInk },
    red:    { bg: T.redSoft,      bar: T.red,    ink: T.redInk },
    orange: { bg: T.orangeSoft,   bar: T.orange, ink: T.orangeInk },
    yellow: { bg: T.yellowSoft,   bar: T.yellow, ink: T.yellowInk },
    green:  { bg: T.greenSoft,    bar: T.green,  ink: T.greenInk },
    grey:   { bg: T.surfaceAlt,   bar: T.t3,     ink: T.t2 },
  };
  const tone = toneMap[opts.color || "brand"];
  const x = opts.x ?? 0.5;
  const y = opts.y ?? 5.4;
  const w = opts.w ?? 12.3;
  const h = opts.h ?? 1.4;

  s.addShape("roundRect", {
    x, y, w, h,
    fill: { color: tone.bg }, line: { color: tone.bg },
    rectRadius: 0.1,
  });
  s.addShape("rect", {
    x, y, w: 0.1, h,
    fill: { color: tone.bar }, line: { color: tone.bar },
  });
  if (opts.icon) {
    s.addText(opts.icon, {
      x: x + 0.25, y: y + 0.15, w: 0.9, h: h - 0.3,
      fontFace: T.font, fontSize: 28, color: tone.ink,
      valign: "middle",
    });
  }
  s.addText(opts.title, {
    x: x + (opts.icon ? 1.2 : 0.3), y: y + 0.2, w: w - (opts.icon ? 1.4 : 0.5), h: 0.5,
    fontFace: T.fontBold, fontSize: 18, color: tone.ink, bold: true,
  });
  s.addText(opts.body, {
    x: x + (opts.icon ? 1.2 : 0.3), y: y + 0.7, w: w - (opts.icon ? 1.4 : 0.5), h: h - 0.8,
    fontFace: T.font, fontSize: 14, color: T.t2, valign: "top",
  });
}

// 페이지 푸터
function footer(s, page, total, brand) {
  s.addText(brand || "Buslink · 동영관광", {
    x: 0.5, y: 7.2, w: 6, h: 0.25,
    fontFace: T.font, fontSize: 10, color: T.t4,
  });
  s.addText(`${page} / ${total}`, {
    x: 6.8, y: 7.2, w: 6, h: 0.25,
    fontFace: T.font, fontSize: 10, color: T.t4, align: "right",
  });
}

module.exports = {
  cover, section, header, pointCards, calloutBox, footer,
  shotOrPlaceholder, numberedList,
};
