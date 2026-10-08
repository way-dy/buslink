// 탑승 기록 엑셀 내려받기 — 행 만들기(순수 · Firebase import 0 · 2026-10-08 최우석 게시판 `XG6BMPAt`
// «QR 태깅 탑승 데이터를 버스인처럼 엑셀로 내려받아 한 번에 보고 싶다»).
//
// 🔴 화면의 탑승 통계와 같은 걸 내려야 한다 — 거래처 필터·권한(Phase B)·검색은 호출부가 화면과 **같은 판정식**으로
//    거른 배열을 넘긴다. 여기서 다시 거르면 «화면은 120건인데 파일은 135건» 이 된다.
// 🔴 정류장은 승객이 고른 정류장(`stopName`, 2026-09-18 이후)이 정본이고, 없을 때만 차량 위치로 추정한다.
//    추정이면 그렇다고 칸에 밝힌다 — 섞어 두면 «그 사람이 거기서 탔다» 는 사실처럼 읽힌다.
// 🔴 시각은 KST 로 고정한다(내려받는 PC 시간대와 무관).

export const EXPORT_MAX_DAYS = 31; // 한 번에 내려받는 기간 상한 — 날짜마다 조회 1회라 길면 오래 걸린다.

export const EXPORT_HEADER = ["날짜", "탑승 시각", "협력사", "노선", "정류장", "정류장 기준", "이름", "사번", "소속", "차량번호", "탑승 방식"];

const VIA_LABEL = { static: "고정 QR", nfc: "NFC 카드", qr: "QR", device: "QR" };

/** 탑승 방식 표기. 필드가 없는 옛 기록은 기사 폰 QR(동적 토큰) 경로다. */
export function viaLabel(via) {
  return VIA_LABEL[via] || "QR";
}

/** 'YYYY-MM-DD' from~to(포함) 날짜 배열. 잘못된 입력·역순·상한 초과는 { error } . */
export function exportDateRange(from, to, max = EXPORT_MAX_DAYS) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(from || "") || !re.test(to || "")) return { error: "날짜를 확인해 주세요" };
  const a = Date.parse(`${from}T00:00:00Z`), b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { error: "날짜를 확인해 주세요" };
  if (b < a) return { error: "끝 날짜가 시작 날짜보다 빠릅니다" };
  const n = Math.round((b - a) / 86400000) + 1;
  if (n > max) return { error: `한 번에 ${max}일까지 내려받을 수 있습니다` };
  const days = [];
  for (let i = 0; i < n; i++) days.push(new Date(a + i * 86400000).toISOString().slice(0, 10));
  return { days };
}

function tsMs(ts) {
  if (!ts) return null;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.seconds === "number") return ts.seconds * 1000;
  const n = typeof ts === "number" ? ts : Date.parse(ts);
  return Number.isFinite(n) ? n : null;
}

/** KST HH:MM:SS. */
export function kstTime(ts) {
  const ms = tsMs(ts);
  if (ms == null) return "";
  return new Date(ms + 9 * 3600000).toISOString().slice(11, 19);
}

/**
 * 탑승 기록 → 엑셀 행(머리 줄 포함). 날짜 → 시각 순.
 * @param {Array<{day:string, b:object}>} items  날짜를 붙인 탑승 기록
 * @param {object} o
 * @param {(code:string)=>string} o.partnerNameOf
 * @param {(empNo:string)=>string} o.deptOf
 * @param {(b:object)=>string|null} o.estimateStop  차량 위치로 고른 정류장 이름(없으면 null)
 */
export function buildBoardingRows(items, { partnerNameOf = (c) => c, deptOf = () => "", estimateStop = () => null } = {}) {
  const sorted = [...(items || [])].sort((x, y) =>
    x.day === y.day ? (tsMs(x.b.boardedAt) || 0) - (tsMs(y.b.boardedAt) || 0) : (x.day < y.day ? -1 : 1));
  const rows = [EXPORT_HEADER];
  for (const { day, b } of sorted) {
    let stop = b.stopName || "", basis = stop ? "승객 선택" : "";
    if (!stop) {
      const est = estimateStop(b);
      if (est) { stop = est; basis = "위치 추정"; }
    }
    rows.push([
      day,
      kstTime(b.boardedAt),
      b.partnerCode ? (partnerNameOf(b.partnerCode) || b.partnerCode) : "미지정",
      b.routeName || "",
      stop,
      basis,
      b.name || "",
      b.empNo || "",
      deptOf(b.empNo) || "",
      b.vehicleNo || "",
      viaLabel(b.via),
    ]);
  }
  return rows;
}

/** 파일 이름 — 기간·거래처가 이름에 보이게. 파일 이름에 못 쓰는 글자는 뺀다. */
export function exportFileName(from, to, partnerLabel) {
  const span = from === to ? from : `${from}_${to}`;
  const who = String(partnerLabel || "전체").replace(/[\\/:*?"<>|]/g, "").trim() || "전체";
  return `BusLink_탑승기록_${who}_${span}.xlsx`;
}
