// QR 태깅 소리 (2026-08-25 신규거래처 도입 미팅 — 신촌세브란스 "소리가 있었으면 좋겠다")
//
// 미팅 결정은 "기본 ON · 강제 재생은 하지 않고 사용자가 조절"이었고, 이후 way 지시로
// **거래처가 강제로 켤 수 있는 스위치**(`partnerCodes/{code}.tagSound.forced`)가 더해졌다.
// 그래서 판정은 두 겹이다: 거래처가 강제면 무조건 켜짐, 아니면 승객 개인 설정(기본 켜짐).
//
// 🔴 **음원 파일을 쓰지 않는다** — WebAudio 로 짧은 두 음을 합성한다. 번들 증가·네트워크 요청이
//    0이고 지하 정류장처럼 신호가 없는 곳에서도 난다(파일이면 캐시 미스 때 조용히 안 난다).
//
// ⚠ **"강제"라도 소리를 100% 보장할 수는 없다** — 웹이 못 이기는 것들이 있다:
//    ⓐ iOS 무음(진동) 스위치 ⓑ 미디어 볼륨 0 ⓒ 사용자 제스처 전에는 오디오가 잠긴다.
//    ⓒ 는 `unlockTagSound()` 를 앱 첫 터치에 걸어 푼다. ⓐⓑ 는 방법이 없다.
//    그래서 **진동은 그대로 둔다** — 소리가 실패해도 피드백이 사라지면 안 된다.

const LS_KEY = "buslink_tag_sound"; // 값 "off" 만 의미가 있다(부재 = 켜짐)

// 거래처 강제 스위치. `partnerBranding.applyPartnerBranding` 과 같은 패턴 —
// 거래처 문서를 읽는 곳이 한 군데(EmployeeApp)뿐이라 프롭을 여러 겹 내려보내지 않는다.
let forcedByPartner = false;

/**
 * `partnerCodes/{code}` 문서 → 소리 설정. **부재 = 강제 아님**(회귀 0).
 * @returns {{forced:boolean}}
 */
export function resolveTagSoundConfig(codeData) {
  const raw = codeData && typeof codeData === "object" ? codeData.tagSound : null;
  if (!raw || typeof raw !== "object") return { forced: false };
  return { forced: raw.forced === true };
}

/** 거래처 정책 적용(로그인·거래처 변경 시 1회). */
export function applyTagSoundPolicy(config) {
  forcedByPartner = !!(config && config.forced === true);
}
export function clearTagSoundPolicy() {
  forcedByPartner = false;
}
/** 설정 화면이 "이 거래처는 끌 수 없음"을 표시하는 데 쓴다. */
export function isTagSoundForced() {
  return forcedByPartner;
}

/** 지금 소리를 내야 하는가 = 거래처 강제 OR 개인 설정(기본 켜짐). */
export function isTagSoundOn() {
  if (forcedByPartner) return true;
  try { return localStorage.getItem(LS_KEY) !== "off"; } catch { return true; }
}

/** 개인 설정 변경. 강제 거래처에서는 호출부가 UI 를 잠그므로 여기선 막지 않는다. */
export function setTagSoundOn(on) {
  try {
    if (on) localStorage.removeItem(LS_KEY);
    else localStorage.setItem(LS_KEY, "off");
  } catch { /* 사파리 프라이빗 등 — 무해(기본 켜짐으로 동작) */ }
}

let ctx = null;
function getCtx() {
  if (typeof window === "undefined") return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!ctx) {
    try { ctx = new AC(); } catch { return null; }
  }
  return ctx;
}

/**
 * 앱 첫 터치에서 한 번 부른다. 브라우저는 사용자 제스처 없이 만들어진 오디오 컨텍스트를
 * `suspended` 로 두므로, 이걸 안 하면 **첫 태깅에서만 소리가 안 나는** 이상한 증상이 된다.
 */
export function unlockTagSound() {
  const c = getCtx();
  if (c && c.state === "suspended") c.resume().catch(() => {});
}

/**
 * 태깅 성공음 — 짧은 두 음 상승(마트 계산대 톤). 0.2초 안에 끝난다:
 * 길면 버스 안에서 거슬리고, 승객이 연달아 찍을 때 겹친다.
 */
export function playTagBeep() {
  if (!isTagSoundOn()) return;
  const c = getCtx();
  if (!c) return;
  try {
    if (c.state === "suspended") c.resume().catch(() => {});
    const t0 = c.currentTime;
    [[880, 0], [1320, 0.085]].forEach(([freq, at]) => {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = "square";
      osc.frequency.setValueAtTime(freq, t0 + at);
      // 🔴 exponentialRamp 는 0 을 못 받는다(0 을 주면 소리가 아예 안 난다) — 0.0001 로 시작·종료.
      gain.gain.setValueAtTime(0.0001, t0 + at);
      gain.gain.exponentialRampToValueAtTime(0.22, t0 + at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.075);
      osc.connect(gain);
      gain.connect(c.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + 0.09);
    });
  } catch { /* 오디오 불가 기기 — 진동이 대신한다 */ }
}
