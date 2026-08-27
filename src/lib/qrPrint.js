// 차량 부착용 QR 인쇄물 — **정본**(2026-08-27).
//
// 🔴 여기 한 곳에서만 만든다. 관리자 콘솔의 인쇄와 고객 안내서에 실리는 그림이 **같은
//    코드**를 써야 한다 — 안내서에만 예쁘게 그리면 고객이 받는 실물과 달라진다.
// 순수 함수(DOM·Firebase 접근 0) — 캡처 스크립트가 그대로 태울 수 있다.

/** 인쇄 톤. 부재·모르는 값 = `default`(예전 그대로). */
export const QR_TONES = {
  // 기존 인쇄물. 흰 종이에 검은 글씨 — 어느 고객사에나 무난하다.
  default: {
    label: "기본",
    page: "#FFFFFF", card: "#FFFFFF", cardLine: "#E6E9EF",
    plate: "#171719", title: "#171719", sub: "#555555",
    band: "#F2F2F3", bandFg: "#46474B", url: "#888888",
  },
  // 카카오 톤 — 상대 소개서의 QR 카드(노란 카드 · 흰 QR 타일 · 곤색 띠)를 따랐다.
  // 색은 그 PDF 를 렌더해 픽셀에서 읽은 값(`partnerBranding.THEME_PRESETS.kakao` 와 같은 계열).
  kakao: {
    label: "카카오 톤",
    page: "#FFFFFF", card: "#FFCD00", cardLine: "#F0BE00",
    plate: "#1E233D", title: "#1E233D", sub: "rgba(30,35,61,.72)",
    band: "#1E233D", bandFg: "#FFFFFF", url: "#8A8F9C",
  },
};

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * 인쇄용 전체 HTML 문서를 만든다.
 * @param {{plate:string, title:string, sub:string, img:string, url:string, tone?:string, bandText?:string}} o
 *   img = QR data URI. tone 은 `QR_TONES` 키(모르는 값이면 default).
 */
export function buildQrPrintHtml(o) {
  const t = QR_TONES[o.tone] || QR_TONES.default;
  const bandText = o.bandText || o.title;
  return '<!doctype html><html><head><meta charset="utf-8"><title>'
    + esc(o.plate) + " " + esc(o.title) + '</title>'
    + '<style>'
    + '@page{margin:12mm}'
    + 'body{margin:0;background:' + t.page + ';font-family:"Pretendard Variable",Pretendard,-apple-system,"Malgun Gothic",sans-serif;'
    + 'display:flex;align-items:center;justify-content:center;min-height:100vh;-webkit-print-color-adjust:exact;print-color-adjust:exact}'
    + '.card{width:420px;border:2px solid ' + t.cardLine + ';border-radius:28px;overflow:hidden;background:' + t.card + '}'
    + '.top{padding:26px 24px 18px;text-align:center}'
    + '.plate{font-size:30px;font-weight:800;letter-spacing:-.02em;color:' + t.plate + ';margin:0 0 6px}'
    + '.title{font-size:19px;font-weight:800;color:' + t.title + ';margin-bottom:4px}'
    + '.sub{font-size:14px;color:' + t.sub + '}'
    // 🔴 QR 은 반드시 **흰 타일** 위에 둔다 — 노란 배경에 QR 을 그대로 얹으면 대비가
    //    떨어져 인식률이 나빠진다(카카오 소개서의 카드도 흰 타일 안에 QR 이 있다).
    + '.tile{background:#fff;border-radius:18px;padding:16px;margin:0 24px 22px;display:flex;justify-content:center}'
    + '.tile img{width:320px;height:320px;display:block}'
    + '.band{background:' + t.band + ';color:' + t.bandFg + ';padding:14px 20px;text-align:center;'
    + 'font-size:15px;font-weight:800;letter-spacing:-.01em}'
    + '.url{font-size:11px;color:' + t.url + ';word-break:break-all;padding:10px 22px 16px;text-align:center;background:#fff}'
    + '</style></head>'
    + '<body' + (o.autoPrint === false ? "" : ' onload="window.print()"') + '>'
    + '<div class="card">'
    + '<div class="top"><div class="plate">' + esc(o.plate) + '</div>'
    + '<div class="title">' + esc(o.title) + '</div>'
    + '<div class="sub">' + esc(o.sub) + '</div></div>'
    + '<div class="tile"><img src="' + esc(o.img) + '" alt=""/></div>'
    + '<div class="band">' + esc(bandText) + '</div>'
    + '<div class="url">' + esc(o.url) + '</div>'
    + '</div></body></html>';
}
