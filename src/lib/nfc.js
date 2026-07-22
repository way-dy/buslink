// NFC 태깅 공용 유틸 — 순수 함수 + 브라우저 API 판정만. Firebase import 금지.
//
// ⚠ UID 정규화 계약(정본) = **소문자 hex, 구분자 없음**. 예 "04:53:CE:9A" → "0453ce9a".
//   레거시 버스인3 탑승자등록은 대문자(`0453CE9A…`)로 보관했고 스위스관광 swstagsys 는
//   소문자였다. 한쪽으로 고정하지 않으면 등록값과 조회값이 어긋나 **전원 "미등록 카드"**
//   로 떨어진다(swstagsys issues.md 🔴 와 동일 함정). 저장(관리자 입력)·조회(기사 태깅)
//   **양쪽 모두** 이 함수를 통과시킬 것 — 한쪽만 정규화하면 같은 결함이 재발한다.
export function normalizeNfcUid(raw) {
  if (raw == null) return "";
  return String(raw).toLowerCase().replace(/[^0-9a-f]/g, "");
}

// 카드 UID 형식 검증 — NFC serial 은 4/7/10바이트(=8/14/20 hex 문자)가 일반적.
// 관리자 수기 입력 오타(자릿수 부족·홀수)를 등록 시점에 거른다. 길이 상한은 두지 않음
// (규격 외 카드 대비 — 너무 좁히면 정상 카드를 막는다).
export function isValidNfcUid(raw) {
  const u = normalizeNfcUid(raw);
  return u.length >= 8 && u.length % 2 === 0;
}

// 표시용 포맷 — 대문자 2자리씩 콜론 구분(`0453CE9A` → `04:53:CE:9A`).
// 저장은 항상 normalize 형태, 화면에만 이 형태를 쓴다.
export function formatNfcUid(raw) {
  const u = normalizeNfcUid(raw);
  if (!u) return "";
  return (u.match(/.{1,2}/g) || []).join(":").toUpperCase();
}

// Web NFC 지원 판정 — **Android Chrome + HTTPS 전용**.
// iOS Safari·데스크톱·http:// 에는 NDEFReader 자체가 없다. 미지원 단말에서는
// 기사에게 QR 탑승으로 폴백하도록 안내해야 한다(기능 은폐 금지 — 정직 안내).
export function isWebNfcSupported() {
  return typeof window !== "undefined" && "NDEFReader" in window;
}

// 같은 카드 연속 태깅 방지 쿨다운 팩토리.
// NFC 리더는 카드를 대고 있는 동안 onreading 을 여러 번 발화시킨다 → 쿨다운이 없으면
// 한 번 태깅에 탑승이 여러 건 적재된다(swstagsys TAG_COOLDOWN_MS=2000 선례).
// 서버측 멱등(`${empNo}__${vehicleId}`)이 최종 방어선이지만, 클라 쿨다운이 있어야
// 불필요한 CF 호출과 "이미 탑승" 깜빡임을 막는다.
export function createTagCooldown(ms = 2000) {
  const last = new Map();
  return function shouldAccept(uid) {
    const key = normalizeNfcUid(uid);
    if (!key) return false;
    const now = Date.now();
    const prev = last.get(key);
    if (prev != null && now - prev < ms) return false;
    last.set(key, now);
    return true;
  };
}
