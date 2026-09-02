// src/lib/backNav.js — 앱 안의 뒤로가기(순수 · import 0 · React 의존 없음)
// ---------------------------------------------------------------------------
// 고객 호소(2026-09-02 way, 협력사 포털): "뒤로가기하면 무조건 페이지를 빠져나온다.
//   ① 뒤로가기는 **앱 안의 이전 화면**으로 가고, ② 정말 나갈 때만 모달로 한 번 물어보고,
//   ③ 나가면 들어온 페이지(이전 사이트)로 돌아가라."
//
// `useExitConfirm` 과의 차이: 그쪽은 "나갈까요?"만 묻는다(화면 이동 개념이 없다).
// 여기는 **우리가 만든 history 항목의 개수(depth)** 를 세어 두 일을 가른다.
//   depth > 0 → 뒤로가기 = 앱 안 화면 이동(onPop 이 처리)
//   depth = 0 → 더 돌아갈 앱 화면이 없다 = 나가기 확인(onExitAsk)
//
// 항목 구조(왼쪽이 과거):
//   [들어온 사이트] [포털 진입] [발판] [화면1] [화면2] …
//                              └ depth=1 ┘ └ 2 ┘ └ 3 ┘
//
// ⚠ 왜 '발판'을 마운트 즉시가 아니라 **첫 사용자 제스처**에 놓는가:
//   안드로이드 크롬은 사용자 제스처 없이 push 된 history 항목을 뒤로가기 때 **건너뛴다**
//   (history manipulation intervention). 마운트 시점 push 는 그 대상이라 팝업이 아예 안 뜬다
//   — `useExitConfirm` 주석의 2026-07-21 재신고가 그 정체다. 같은 규칙을 그대로 따른다.
//
// ⚠ 확인창이 떠 있는 동안(asking)은 발판을 다시 놓지 않는다. 놓으면 "나가기"를 눌러도
//   그 발판만 소비되어 화면에 그대로 남는다(뒤로가기를 두 번 눌러야 하는 결함).
//   대신 그 사이 물리 뒤로가기를 또 누르면 그냥 나간다 — 두 번 눌렀으면 나갈 뜻이다.
//
// 한계: 설치형 PWA standalone 의 OS back 은 100% 강제 불가(브라우저 한계).
//       새 탭으로 처음 연 경우 '들어온 사이트'가 없어 나가기가 무효일 수 있다(탭을 닫아야 한다).
// ---------------------------------------------------------------------------

const GESTURE_EVENTS = ["pointerdown", "touchstart", "keydown"];

/**
 * @param {object}   o
 * @param {Window}   o.win        window 유사 객체(테스트에서 가짜 주입 — history/addEventListener/location/setTimeout)
 * @param {Function} o.onPop      () => boolean. 앱 안에서 한 화면 되돌렸으면 true, 더 없으면 false.
 * @param {Function} o.onExitAsk  () => void. 나가기 확인 UI 를 띄운다.
 * @returns {{start:Function, stop:Function, pushView:Function, back:Function,
 *            cancelExit:Function, confirmExit:Function, depth:Function, isAsking:Function}}
 */
export function createBackNav({ win, onPop, onExitAsk }) {
  // 우리가 쌓은 history 항목 수(발판 포함).
  // 🔴 새로고침해도 브라우저 history 는 남아 있다 — 그때 0 에서 다시 세면 "나가기"가
  //    남은 우리 항목 하나를 소비할 뿐 실제로 안 나간다(실측). 지금 항목에 우리가 찍어 둔
  //    번호(`__blNav`)가 곧 그 아래 쌓인 우리 항목 수이므로, 그것으로 복구한다.
  //    (앱 안 화면 스택은 복구할 수 없으므로 새로고침 뒤 첫 뒤로가기는 나가기 확인이다.)
  let depth = Number(win.history.state && win.history.state.__blNav) || 0;
  let asking = false; // 나가기 확인창이 떠 있다
  let leaving = false; // 실제 이탈 진행 중 — 그 사이 popstate 재진입 차단

  const later = (fn, ms) => (win.setTimeout ? win.setTimeout(fn, ms) : setTimeout(fn, ms));

  const push = () => {
    depth += 1;
    win.history.pushState({ __blNav: depth }, "", win.location.href);
  };

  // 발판 설치 — 항상 최대 1개. 여러 개면 "나가기"를 눌러도 안 나간다.
  const arm = () => { if (depth === 0 && !asking && !leaving) push(); };

  // 앱 안에서 화면을 하나 진입 — 호출자는 이 직전에 '지금 화면'을 자기 스택에 얹어 둔다.
  const pushView = () => { arm(); push(); };

  const onPopState = () => {
    if (leaving) return;
    if (depth > 0) depth -= 1;
    // 앱이 되돌릴 화면을 갖고 있으면 거기서 끝 — 브라우저는 이미 우리 항목 하나를 소비했다.
    if (onPop && onPop() === true) return;
    asking = true;
    if (onExitAsk) onExitAsk();
  };

  /** 확인창 "머무르기" — 발판을 되돌려 놓아 다음 뒤로가기도 잡는다. */
  const cancelExit = () => { asking = false; arm(); };

  /** 확인창 "나가기" — 우리 항목 전부 + 포털 진입 항목까지 되짚어 **들어온 페이지**로 나간다. */
  const confirmExit = () => {
    asking = false;
    leaving = true;
    const steps = depth + 1;   // 남은 우리 항목 + 포털 진입 항목 하나
    depth = 0;
    win.history.go(-steps);
    // 되돌아갈 항목이 없어 go 가 무효인 경우(새 탭 첫 진입) 다시 무장 가능하게 풀어 준다.
    later(() => { leaving = false; }, 1000);
  };

  /** 앱 안의 "이전으로" 버튼용 — 물리 뒤로가기와 **같은 경로**를 타게 한다(상태 어긋남 0). */
  const back = () => { win.history.back(); };

  const start = () => {
    GESTURE_EVENTS.forEach(t => win.addEventListener(t, arm, { passive: true }));
    win.addEventListener("popstate", onPopState);
  };
  const stop = () => {
    GESTURE_EVENTS.forEach(t => win.removeEventListener(t, arm));
    win.removeEventListener("popstate", onPopState);
  };

  return {
    start, stop, pushView, back, cancelExit, confirmExit,
    depth: () => depth,
    isAsking: () => asking,
  };
}
