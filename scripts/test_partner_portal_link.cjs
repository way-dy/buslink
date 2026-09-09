// 협력사 포털 바로가기 링크 격리 검증 (2026-09-09 way "관리자는 협력사 클릭하면 바로 협력사 페이지로")
//   node scripts/test_partner_portal_link.cjs
//
// 🔴 Firebase 접속 0 · 브라우저 0. 정본 모듈(`src/lib/partnerLink.js`)을 **베끼지 않고** vm 에
//    그대로 태운다(재구현 0 — test_partner_back_nav.cjs 와 같은 하네스).
// 🔴 재는 것 세 가지:
//    ① 링크가 «포털 URL 복사»와 **같은 주소**인가(호스트가 갈리면 관리자 세션 격리가 깨진다)
//    ② 포털이 그 링크를 읽고 **주소창에서 코드를 지우는가**, 그러면서 backNav 의
//       `history.state.__blNav` 를 **보존하는가**(덮으면 새로고침 뒤 '나가기'가 먹통)
//    ③ 링크가 **인증을 건너뛰지 않는가** — `authRequired` 를 켠 거래처는 비밀번호 화면에서 멈춘다
const path = require("path");
const fs = require("fs");
const vm = require("vm");
const ROOT = path.join(__dirname, "..");

// ESM 소스에서 `export ` 만 떼어 컨텍스트에 태운다(순수 모듈 — import 0).
function loadPure(rel, names) {
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/^export /gm, "");
  const ctx = { console, Date, JSON, String, Number, decodeURIComponent, encodeURIComponent, window: undefined };
  vm.createContext(ctx);
  vm.runInContext(src + "\n;" + names.map((n) => `this.${n}=${n};`).join(""), ctx);
  return ctx;
}

const pl = loadPure("src/lib/partnerLink.js",
  ["buildPartnerPortalUrl", "readPartnerCodeFromUrl", "stripPartnerCodeFromUrl", "PARTNER_LINK_PARAM"]);

const partnerSrc = fs.readFileSync(path.join(ROOT, "src/pages/PartnerApp.js"), "utf8");
const adminSrc = fs.readFileSync(path.join(ROOT, "src/pages/AdminApp.js"), "utf8");

let n = 0, fail = 0;
const ok = (name, cond, got) => {
  n++;
  console.log(`  ${cond ? "✓" : "✗"} ${name}${!cond && got !== undefined ? " → " + JSON.stringify(got) : ""}`);
  if (!cond) fail++;
};

const CODE = "DY001-신촌세브란스병원-2026-Y2VH";

// ── [1] 링크 만들기 ─────────────────────────────────────────────────────────
{
  console.log("\n[1] buildPartnerPortalUrl — «포털 URL 복사» 와 같은 주소 + 코드 한 개");
  const url = pl.buildPartnerPortalUrl({ origin: "https://admin.buslink.co.kr", code: CODE });
  ok("경로가 /partner 다", url.startsWith("https://admin.buslink.co.kr/partner?"), url);
  // 🔴 호스트를 partner. 로 바꾸지 않는다 — 바꾸면 origin 이 갈려 관리자 탭과 격리 규칙이 달라진다.
  ok("호스트를 partner. 로 바꾸지 않는다", !/partner\.buslink/.test(url), url);
  ok("코드가 인코딩돼 실린다", url.includes(`code=${encodeURIComponent(CODE)}`), url);
  ok("origin 끝 슬래시를 먹는다",
    pl.buildPartnerPortalUrl({ origin: "https://admin.buslink.co.kr/", code: "A" }) === "https://admin.buslink.co.kr/partner?code=A");
  // 코드가 없으면 예전 '포털 URL 복사' 와 글자 그대로 같아야 한다.
  ok("코드가 없으면 순수 포털 주소", pl.buildPartnerPortalUrl({ origin: "https://x.kr" }) === "https://x.kr/partner");
  ok("코드가 공백뿐이어도 순수 포털 주소", pl.buildPartnerPortalUrl({ origin: "https://x.kr", code: "   " }) === "https://x.kr/partner");
}

// ── [2] 링크 읽기 ───────────────────────────────────────────────────────────
{
  console.log("\n[2] readPartnerCodeFromUrl — 왕복이 손실 없이 돌아온다");
  const url = pl.buildPartnerPortalUrl({ origin: "https://admin.buslink.co.kr", code: CODE });
  ok("왕복 무손실", pl.readPartnerCodeFromUrl(url.slice(url.indexOf("?"))) === CODE);
  ok("? 없이도 읽는다", pl.readPartnerCodeFromUrl("code=ABC") === "ABC");
  ok("다른 파라미터 사이에서도 찾는다", pl.readPartnerCodeFromUrl("?a=1&code=ABC&b=2") === "ABC");
  // 승객 안내문 QR 이 쓰는 `pc` 도 같은 값(거래처 코드)이라 함께 받는다.
  ok("pc= 도 받는다", pl.readPartnerCodeFromUrl("?pc=ABC") === "ABC");
  ok("없으면 null", pl.readPartnerCodeFromUrl("?a=1") === null);
  ok("빈 문자열이면 null", pl.readPartnerCodeFromUrl("") === null);
  ok("값이 비면 null", pl.readPartnerCodeFromUrl("?code=") === null);
  ok("값이 공백뿐이면 null", pl.readPartnerCodeFromUrl("?code=%20%20") === null);
  ok("망가진 인코딩에도 안 죽는다", pl.readPartnerCodeFromUrl("?code=%E0%A4%A") === "%E0%A4%A");
  // 🔴 접두가 같은 다른 파라미터를 코드로 오인하면 안 된다.
  ok("codex= 는 코드가 아니다", pl.readPartnerCodeFromUrl("?codex=ZZZ") === null);
}

// ── [3] 주소창에서 코드 지우기 ──────────────────────────────────────────────
{
  console.log("\n[3] stripPartnerCodeFromUrl — 코드만 지우고 history.state 는 보존");
  const makeWin = (search, state) => {
    const calls = [];
    return {
      calls,
      location: { pathname: "/partner", search, hash: "" },
      history: {
        state,
        replaceState(st, title, url) { calls.push({ st, url }); },
      },
    };
  };

  // 🔴 양성 대조 — 지우기 전에는 코드가 실제로 주소에 있다(하네스가 무엇도 증명 못 하는 상태 방지).
  ok("[대조] 지우기 전 주소에 코드가 있다", pl.readPartnerCodeFromUrl("?code=ABC") === "ABC");

  const w1 = makeWin("?code=ABC", { __blNav: 3 });
  const next1 = pl.stripPartnerCodeFromUrl(w1);
  ok("코드가 사라진다", next1 === "/partner" && pl.readPartnerCodeFromUrl(next1.slice(next1.indexOf("?") + 1)) === null, next1);
  ok("replaceState 를 한 번 부른다", w1.calls.length === 1, w1.calls);
  // 🔴 이걸 빈 객체로 덮으면 새로고침 뒤 backNav 가 깊이를 0 으로 다시 세어 '나가기'가 먹통이 된다.
  ok("history.state 를 그대로 되쓴다", w1.calls[0] && w1.calls[0].st && w1.calls[0].st.__blNav === 3, w1.calls[0]);

  const w2 = makeWin("?a=1&code=ABC&b=2", null);
  ok("다른 파라미터는 남는다", pl.stripPartnerCodeFromUrl(w2) === "/partner?a=1&b=2", w2.calls);

  const w3 = makeWin("", null);
  ok("지울 게 없으면 건드리지 않는다", pl.stripPartnerCodeFromUrl(w3) === null && w3.calls.length === 0);
  ok("window 가 없어도 안 죽는다", pl.stripPartnerCodeFromUrl(null) === null);
}

// ── [4] 포털 배선(PartnerApp) ───────────────────────────────────────────────
{
  console.log("\n[4] 포털 배선 — 링크가 «타이핑»만 대신하고 인증은 그대로다");
  ok("링크 파라미터를 읽는다", /readPartnerCodeFromUrl\(window\.location\.search\)/.test(partnerSrc));
  ok("읽자마자 주소창에서 지운다", /stripPartnerCodeFromUrl\(window\)/.test(partnerSrc));
  // 🔴 링크가 이 기기에 저장된 직전 거래처를 이겨야 한다 — 안 그러면 관리자가 A 를 눌렀는데 B 가 열린다.
  ok("저장된 세션보다 링크가 우선이다",
    /if \(urlCode\) return undefined;\s*\/\/[^\n]*\n\s*const saved = loadPartnerSession\(\);/.test(partnerSrc));
  // 🔴 인증 우회 금지 — 켠 거래처는 링크로 와도 비밀번호 화면에서 멈춘다.
  ok("authRequired 거래처는 비밀번호 화면에서 멈춘다",
    /const data = await validatePartnerCode\(urlCode\);[\s\S]{0,220}if \(isPartnerAuthRequired\(data\)\) \{ setAuthPending\(\{ code: urlCode, data \}\); return; \}/.test(partnerSrc));
  // 🔴 승계표는 URL 로 오가지 않는다(자격증명급 값).
  ok("승계표를 링크로 받지 않는다",
    /await enterPortal\(urlCode, data, null\)/.test(partnerSrc) && !/resumeToken[^\n]*readPartnerCodeFromUrl/.test(partnerSrc));
  // 🔴 링크의 코드가 죽었다고 이 기기의 저장분을 지우면 담당자 재타이핑이 되살아난다.
  ok("링크 실패가 저장된 세션을 지우지 않는다",
    /링크로 받은 업체코드로 들어가지 못했습니다/.test(partnerSrc)
    && !/링크로 받은 업체코드로 들어가지 못했습니다[\s\S]{0,200}clearPartnerSession/.test(partnerSrc));
  ok("링크 진입도 대기 화면을 쓴다", /urlCode \|\| loadPartnerSession\(\)/.test(partnerSrc));
}

// ── [5] 관리자 배선(AdminApp) ───────────────────────────────────────────────
{
  console.log("\n[5] 관리자 배선 — 업체명이 그 거래처 포털로 간다");
  // 🔴 `c.code || c.id` — `code` 필드가 빈 문서가 실제로 있다(시연용 샘플 거래처). 폴백을 빼면
  //    그 거래처만 «코드 없는 포털 주소»로 열린다(2026-09-09 실측: 12행 중 11개만 링크였다).
  ok("업체명이 링크다", /buildPartnerPortalUrl\(\{ origin: window\.location\.origin, code: c\.code \|\| c\.id \}\)/.test(adminSrc));
  ok("새 탭으로 연다", /buildPartnerPortalUrl[\s\S]{0,200}target="_blank"[\s\S]{0,60}rel="noopener noreferrer"/.test(adminSrc));
  // 🔴 행 클릭(승객 목록 펼치기)은 그대로 살아 있어야 한다 — 링크는 전파만 끊는다.
  ok("행 클릭 전파를 끊는다", /buildPartnerPortalUrl[\s\S]{0,300}onClick=\{e => e\.stopPropagation\(\)\}/.test(adminSrc));
  ok("승객 목록 토글이 살아 있다", /onClick=\{\(\) => setSelectedCode\(selectedCode === c\.id \? null : c\.id\)\}/.test(adminSrc));

  // 🔗 링크 복사(2026-09-09 way "복사하고 다시 업체코드 복사해야 하는 이슈") — 전달은 한 줄로 끝나야 한다.
  console.log("\n[6] 🔗 링크 복사 — 주소+업체코드를 한 번에");
  ok("링크 복사 함수가 있다", /const copyPortalLink = \(code\) => \{/.test(adminSrc));
  // 🔴 주소 형식을 두 벌로 두지 않는다(업체명 링크와 같은 정본 함수).
  ok("업체명 링크와 같은 함수를 쓴다",
    /copyPortalLink = \(code\) => \{[\s\S]{0,160}buildPartnerPortalUrl\(\{ origin: window\.location\.origin, code \}\)/.test(adminSrc));
  ok("버튼이 행마다 있다", /copyPortalLink\(c\.code \|\| c\.id\)/.test(adminSrc));
  // 🔴 코드 없는 공용 주소를 주는 상단 '포털 URL 복사' 는 그대로 둔다(안내문·게시용).
  ok("상단 '포털 URL 복사' 는 그대로다", /const copyUrl = \(\) => \{\s*\n\s*const url = `\$\{window\.location\.origin\}\/partner`;/.test(adminSrc));
  // 🔴 `code` 필드가 빈 문서(시연용 샘플)에서 코드 칸이 비고 `복사` 가 undefined 를 넣던 결함.
  ok("코드 칸·복사도 같은 폴백을 쓴다",
    /\{c\.code \|\| c\.id\}/.test(adminSrc) && /copyCode\(c\.code \|\| c\.id\)/.test(adminSrc));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${n - fail}/${n} 통과`);
process.exit(fail === 0 ? 0 : 1);
