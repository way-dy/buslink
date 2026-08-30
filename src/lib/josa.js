// 브랜드 이름 뒤 목적격 조사(을/를) — 순수 모듈(DOM·Firebase import 0).
//
// 왜 필요한가: 안내 문구가 "홈 화면에 ○○ 를 추가하세요" 로 **조사를 하드코딩**하고 있었다.
// 기본 브랜드("BusLink" = 버스링크)와 "카카오 T"(카카오 티)는 둘 다 받침이 없어 우연히 맞았지만,
// 2026-08-30 way 요청으로 들어온 "카카오통근" 은 받침이 있어 **"카카오통근를"** 이 된다.
// 거래처가 이름을 자유 입력하는 값이므로, 한 번 틀리면 그 고객사 화면 전체에서 틀린다.
//
// 🔴 **한글 음절만 판정하고 나머지는 전부 "를"** 이다. 영문·숫자의 한국어 독음표를 만들지 않은 건
//    게으름이 아니라 «부재=현행» 이다 — 지금 쓰는 값(BusLink=버스링크·카카오 T=카카오 티)이
//    둘 다 무받침이라, 표를 넣으면 이득 없이 오판 가능성만 생긴다(예: 'T' 를 '트' 로 읽으면 틀린다).
//    영문 이름에 받침 조사가 필요한 거래처가 실제로 생기면 그때 그 값만 표에 넣는다.

const HANGUL_FIRST = 0xac00; // '가'
const HANGUL_LAST = 0xd7a3;  // '힣'

/** 마지막 글자에 받침이 있는가. 한글 음절이 아니면 false(= 무받침 취급). */
export function hasBatchim(word) {
  if (typeof word !== "string") return false;
  const t = word.trim();
  if (!t) return false;
  const code = t.charCodeAt(t.length - 1);
  if (code < HANGUL_FIRST || code > HANGUL_LAST) return false;
  // 한글 음절 = ((초성*21)+중성)*28 + 종성. 종성 0 이면 받침 없음.
  return (code - HANGUL_FIRST) % 28 !== 0;
}

/** "카카오통근" → "카카오통근을" · "BusLink" → "BusLink를" (앞에 공백 없이 붙인다). */
export function withEulReul(word) {
  return String(word == null ? "" : word) + (hasBatchim(word) ? "을" : "를");
}
