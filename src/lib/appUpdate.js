// src/lib/appUpdate.js — 배포된 새 빌드를 감지해 조용히 새로고침 (2026-09-01)
// ---------------------------------------------------------------------------
// 왜 필요한가: 2026-09-01 긴급 수정을 배포했는데 **이미 열려 있는 앱에는 닿을 방법이 없었다**.
// HTML 은 no-cache 라 "다시 열면" 새 번들이 오지만, 켜 둔 채로는 옛 코드가 계속 돈다.
// 서비스워커는 FCM 전용(캐시·message 핸들러 없음)이고 버전 확인 로직도 없어서,
// 그날 할 수 있는 최선이 "앱을 껐다 켜 주세요" 안내뿐이었다(16,000명에게 할 수 없는 말이다).
//
// 🔴 이 모듈은 **그때 배포해도 소용없다** — 신호를 받을 코드가 이미 옛것이기 때문이다.
//    그래서 사고가 나기 **전에** 심어 두는 장치다. 지우면 다음 긴급 수정 때 같은 곳에 선다.
//
// 판정 = 지금 우리를 로드한 <script> 의 번들 URL ↔ 서버 index.html 의 번들 URL.
// 빌드 시각을 주입하지 않는다(빌드 설정 무변경) — 해시가 곧 버전이다.
//
// 순수 모듈: Firebase·React import 없음. 격리 테스트 `scripts/test_app_update.cjs`.
// ---------------------------------------------------------------------------

// 이 세션에서 이미 시도한 목표 해시를 기억하는 키.
// 🔴 무한 새로고침 방지의 핵심 — 새로고침했는데도 여전히 옛 번들이면(프록시·캐시 등)
//    같은 목표로 다시 시도하지 않는다. 한 번 실패하면 그 해시로는 영영 안 한다.
export const RELOAD_MARK_KEY = "buslink_app_update_tried";

// <script src="/static/js/main.abc123.js"> 에서 파일명만 뽑는다.
// 실패(못 찾음·형식 다름)는 전부 null — 모르면 아무것도 하지 않는다.
export function bundleNameFrom(html) {
  if (typeof html !== "string") return null;
  const m = html.match(/\/static\/js\/(main\.[A-Za-z0-9]+\.js)/);
  return m ? m[1] : null;
}

// 지금 실행 중인 번들 — 우리를 로드한 script 태그에서 읽는다.
// 🔴 빌드타임 상수로 박지 말 것. 그러면 그 값을 넣은 빌드부터만 동작하고,
//    빌드 설정(env 주입)까지 건드려야 해서 이 장치의 도입 비용이 커진다.
export function currentBundleName(doc) {
  const d = doc || (typeof document !== "undefined" ? document : null);
  if (!d || !d.querySelectorAll) return null;
  const els = d.querySelectorAll('script[src*="/static/js/main."]');
  for (const el of els) {
    const n = bundleNameFrom(el.getAttribute("src") || "");
    if (n) return n;
  }
  return null;
}

/**
 * 새로고침해야 하는가 — 순수 판정(부수효과 0).
 *
 * 🔴 «모르면 안 한다»가 이 함수의 원칙이다. 한쪽이라도 못 읽으면 false —
 *    잘못 새로고침하면 사용자가 하던 일이 날아가고, 최악은 무한 새로고침이다.
 *
 * @param current  지금 실행 중인 번들 파일명
 * @param deployed 서버 index.html 의 번들 파일명
 * @param tried    이 세션에서 이미 새로고침을 시도한 목표 파일명(sessionStorage)
 * @param busy     사용자가 건드리면 안 되는 흐름에 있는가(QR 스캔·탑승 처리 등)
 */
export function shouldReload({ current, deployed, tried = null, busy = false } = {}) {
  if (!current || !deployed) return false;   // 모르면 안 한다
  if (current === deployed) return false;    // 이미 최신
  if (busy) return false;                    // 🔴 하던 일을 끊지 않는다
  if (tried === deployed) return false;      // 🔴 같은 목표로 두 번 시도하지 않는다(루프 차단)
  return true;
}

// 서버가 지금 서빙하는 번들 파일명. 실패는 null(조용히 포기 — 통신 문제로 앱을 흔들지 않는다).
export async function fetchDeployedBundleName(fetchImpl) {
  const f = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  if (!f) return null;
  try {
    // 🔴 `cache: "no-store"` — 안 그러면 브라우저 캐시가 옛 index.html 을 돌려줘
    //    "새 빌드가 없다"고 잘못 판정한다(호스팅 헤더와 별개로 클라 캐시가 있다).
    const res = await f("/", { cache: "no-store", credentials: "same-origin" });
    if (!res || !res.ok) return null;
    return bundleNameFrom(await res.text());
  } catch {
    return null;
  }
}

/**
 * 감지 → 새로고침 1회 실행. 부수효과가 있는 유일한 자리.
 * 반환 true = 새로고침을 걸었다(호출부는 그 뒤 아무것도 하지 말 것).
 *
 * ⚠ 호출 시점은 **백그라운드에서 막 돌아왔을 때**여야 한다 — 그 순간 사용자는 아직
 *   아무것도 입력하지 않았고, 새로고침이 "앱이 열리는 것"과 구별되지 않는다.
 *   포그라운드에서 쓰고 있는 도중에 부르면 하던 조작이 끊긴다.
 */
export async function checkAndReload({ busy = false, storage, location: loc, fetchImpl } = {}) {
  const store = storage || (typeof sessionStorage !== "undefined" ? sessionStorage : null);
  const target = loc || (typeof window !== "undefined" ? window.location : null);
  if (!target) return false;

  const current = currentBundleName();
  if (!current) return false;                      // 우리 번들도 모르면 판정 불가
  const deployed = await fetchDeployedBundleName(fetchImpl);

  let tried = null;
  try { tried = store ? store.getItem(RELOAD_MARK_KEY) : null; } catch { /* 접근 거부 = 표시 없음 */ }

  if (!shouldReload({ current, deployed, tried, busy })) return false;

  // 🔴 표시를 **먼저** 남긴다 — 새로고침 후 여전히 옛 번들이어도 다시 안 돈다.
  try { if (store) store.setItem(RELOAD_MARK_KEY, deployed); } catch { /* 무시 */ }
  try { target.reload(); } catch { return false; }
  return true;
}
