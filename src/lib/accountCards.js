// ════════════════════════════════════════════════════════════
// accountCards — 승객 계정 발급·배부(2026-07-27)
//
// 배경: 협력사 담당자가 명부 239~250명을 셋팅한 뒤 "각자에게 계정을 뿌리는 일"이
//   실제 병목이었다(가입 절차가 아니라). 자가가입은 호응이 없어 채택하지 않고,
//   관리자가 셋팅 → 개인별 안내문 인쇄 → 배부 흐름을 자동화한다.
//
// 여기 있는 것 두 가지:
//   ① 초기 PIN 개인별 발급  — 전원 `000000` 고정이면 사번(명부 순번)만 알면
//      남의 계정으로 들어가 그 사람 노선·정류장·공지를 본다. 인원이 늘수록 그대로 확대.
//   ② 계정 안내문 인쇄 HTML — 이름/ID/PIN/QR 카드. QR 은 사번이 프리필된
//      승객앱 링크라 "내 ID가 뭐냐" 문의와 오타가 사라진다.
//
// ⚠ 평문 PIN 은 **저장하지 않는다**(pinHash 만 저장). 그래서 안내문은 발급 직후
//   1회만 인쇄할 수 있고, 나중에 다시 뽑으려면 PIN 재발급을 거쳐야 한다.
//   이 제약은 의도적이다 — 평문을 문서에 남기면 명부 열람=전원 계정 탈취가 된다.
//
// 순수 모듈: Firebase import 0. 인쇄는 window API 만 사용.
// ════════════════════════════════════════════════════════════

/** 초기 PIN 자릿수 기본값(승객앱 로그인은 4~6자리 허용). */
export const INITIAL_PIN_LENGTH = 6;

/**
 * 초기 PIN 자동 생성 — 암호학적 난수 기반 숫자열.
 * `Math.random` 을 쓰면 같은 순간 대량 생성 시 예측 가능성이 생겨 crypto 사용.
 * 첫 자리 0 도 허용한다(문자열로 다루고 로그인 입력도 문자열 비교).
 */
export function generateInitialPin(len = INITIAL_PIN_LENGTH) {
  const n = Math.max(4, Math.min(6, Number(len) || INITIAL_PIN_LENGTH));
  const g = (typeof window !== "undefined" && window.crypto) || null;
  if (g && typeof g.getRandomValues === "function") {
    const buf = new Uint8Array(n);
    g.getRandomValues(buf);
    return Array.from(buf, b => String(b % 10)).join("");
  }
  // crypto 부재 환경(구형 브라우저·테스트 러너) 폴백 — 품질은 낮지만 동작은 보장.
  let out = "";
  for (let i = 0; i < n; i++) out += String(Math.floor(Math.random() * 10));
  return out;
}

/** 관리자가 엑셀·폼으로 지정한 초기 PIN 형식 검사(4~6자리 숫자). */
export function isValidInitialPin(v) {
  return /^\d{4,6}$/.test(String(v == null ? "" : v).trim());
}

/**
 * 승객앱 로그인 URL — 사번 프리필(`?emp=`) 포함.
 * 협력사 포털은 `partner.*` 에서 열리므로 승객앱 서브도메인(`p.*`)으로 치환한다.
 * 매핑이 없는 origin(web.app·localhost)은 그대로 두고 경로만 `/p` 를 붙인다.
 */
export function buildPassengerLoginUrl({ origin, empNo } = {}) {
  const base = String(origin || "").replace(/\/+$/, "");
  const passengerBase = base.replace(/:\/\/partner\./i, "://p.");
  const q = empNo ? `?emp=${encodeURIComponent(String(empNo))}` : "";
  return `${passengerBase}/p${q}`;
}

// HTML 이스케이프 — 이름·부서에 `<`, `&` 가 들어와도 인쇄물이 깨지지 않게.
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * 계정 안내문(A4 인쇄용) HTML 생성.
 * @param {object} p
 * @param {string} p.partnerName - 거래처명(카드 머리글)
 * @param {string} [p.notice] - 카드 하단 안내 문구(기본: 접속 방법)
 * @param {Array<{empNo:string,name:string,dept?:string,routeName?:string,pin:string,loginUrl?:string,qrDataUrl?:string}>} p.cards
 * @returns {string} 완결된 HTML 문서 문자열
 */
export function buildAccountCardsHtml({ partnerName, notice, cards } = {}) {
  const list = Array.isArray(cards) ? cards : [];
  const head = esc(partnerName || "통근버스");
  // 배부물은 학부모·직원이 읽는다 — "사번"·"PIN" 같은 내부 용어를 쓰지 않는다.
  const foot = esc(notice || "QR을 휴대폰 카메라로 찍으면 아이디가 자동으로 입력됩니다. 비밀번호는 첫 로그인 후 본인만 아는 번호로 바꾸게 됩니다.");

  const cardHtml = list.map(c => `
    <div class="card">
      <div class="ttl">${head}</div>
      <div class="who">
        <span class="nm">${esc(c.name)}</span>
        ${c.dept ? `<span class="dept">${esc(c.dept)}</span>` : ""}
      </div>
      ${c.routeName ? `<div class="route">${esc(c.routeName)}</div>` : ""}
      <div class="body">
        <div class="creds">
          <div class="row"><span class="k">아이디</span><span class="v">${esc(c.empNo)}</span></div>
          <div class="row"><span class="k">비밀번호</span><span class="v pin">${esc(c.pin)}</span></div>
        </div>
        ${c.qrDataUrl ? `<img class="qr" src="${esc(c.qrDataUrl)}" alt="접속 QR"/>` : ""}
      </div>
      <div class="url">${esc(c.loginUrl || "")}</div>
      <div class="note">${foot}</div>
    </div>`).join("");

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>${head} 버스 계정 안내문 (${list.length}명)</title>
<style>
  @page { size: A4; margin: 10mm; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: "Malgun Gothic", "맑은 고딕", sans-serif; color:#111; }
  .sheet { display:grid; grid-template-columns:1fr 1fr; gap:6mm; }
  .card {
    break-inside: avoid; page-break-inside: avoid;
    border:1.2px dashed #999; border-radius:3mm; padding:5mm 5mm 4mm;
    height:62mm; display:flex; flex-direction:column;
  }
  .ttl { font-size:9pt; color:#0066FF; font-weight:800; letter-spacing:-0.3px; }
  .who { margin-top:1.5mm; display:flex; align-items:baseline; gap:2.5mm; }
  .nm { font-size:15pt; font-weight:800; letter-spacing:-0.5px; }
  .dept { font-size:9.5pt; color:#555; }
  .route { font-size:8.5pt; color:#777; margin-top:0.6mm; }
  .body { display:flex; align-items:center; gap:4mm; margin-top:auto; }
  .creds { flex:1; min-width:0; }
  .row { display:flex; align-items:baseline; gap:3mm; padding:1.2mm 0; border-bottom:0.6px solid #e5e5e5; }
  .k { font-size:8.5pt; color:#666; width:14mm; flex:0 0 14mm; }
  .v { font-size:13pt; font-weight:800; font-family:"Consolas","Courier New",monospace; letter-spacing:0.5px; }
  .pin { color:#0066FF; }
  .qr { width:24mm; height:24mm; flex:0 0 24mm; }
  .url { font-size:7.5pt; color:#888; margin-top:2mm; word-break:break-all; }
  .note { font-size:7pt; color:#999; line-height:1.35; margin-top:1.2mm; }
  @media screen { body { background:#f4f4f4; padding:8mm; } .card { background:#fff; } }
</style></head>
<body onload="window.print()">
  <div class="sheet">${cardHtml}</div>
</body></html>`;
}

/**
 * 인쇄 창 열기. 팝업 차단 시 false 반환(호출부가 안내).
 */
export function openPrintWindow(html) {
  const w = typeof window !== "undefined" ? window.open("", "_blank") : null;
  if (!w) return false;
  w.document.write(html);
  w.document.close();
  return true;
}
