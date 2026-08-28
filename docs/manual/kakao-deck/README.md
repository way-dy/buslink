# 고객사 전달용 이용 안내서 (16:9 슬라이드)

카카오모빌리티 삼성전자 통근 건(2026-08-27)으로 만든 **임직원 이용 안내서**.
판형·색을 상대가 준 `file/20260827/[카카오 T] 통근셔틀 서비스 소개서.pdf` 에 맞췄다.

## 만드는 법

```bash
# ① 화면 캡처 — 거래처 테마를 «화면에만» 입혀 찍는다(실고객 설정은 안 건드린다)
THEME=kakao node scripts/capture_passenger_screens.cjs docs/manual/kakao-deck/shots 채드윅
node scripts/capture_board_screen.cjs docs/manual/kakao-deck/shots/board.png kakao

# ② PDF (→ docs/manual/out/)
node docs/manual/kakao-deck/build.cjs
```

`shots/` 파일명이 곧 템플릿 자리다 — `login home routes scan board notices settings`.
캡처가 하나라도 없으면 build 가 **멈춘다**(빈 자리로 조용히 나가지 않게).

🔴 **로그인 전 화면(`login`·`board`)은 주소에 `pc` 가 없으면 워드마크가 `BusLink` 로 찍힌다** —
앱은 로그인 전에 거래처를 모른다(2026-08-27 `pc` 파라미터가 있는 이유). 그 두 장은 반드시
`/p?pc=<거래처코드>` · `/board?c=…&v=…&pc=<거래처코드>` 로 찍을 것. 로그인 뒤 화면은 세션의
`partnerCode` 로 저절로 걸린다. **같은 이유로 고객에게 보내는 링크에도 `?pc=` 가 있어야 한다** —
맨 `p.buslink.co.kr` 로 열면 첫 화면이 기본 브랜드다.

## 🔴 지켜야 할 것

- **워드마크 표기는 2026-08-28 에 뒤집혔다.** 2026-08-27 결정은 "색만"(상표 미사용)이었는데,
  카카오모빌리티 **윤지영 부장이 카톡으로 직접 요청**했고("저 링크에 카카오모빌리티를 넣을 수
  있을까요 버스링크에 / 카카오 T나") way 가 승낙했다. 그래서 지금 꼬리말은 `카카오 T` 다
  (`build.cjs` 의 `BRAND`). 🔴 **이건 상대가 지정한 표기지 우리가 고른 상표가 아니다** —
  다른 고객사 안내서에 복사하지 말고 `BRAND=…` 로 바꿔 쓸 것. **로고 이미지는 여전히 안 넣는다**
  (글자 표기만. 이미지 사용은 별도 승인 사안이고 아무도 승인한 적 없다).
  앱 화면 쪽 같은 표기는 `src/lib/partnerBranding.js` 의 `THEME_PRESETS.kakao.wordmark` —
  **둘 중 하나만 바꾸면 안내서와 실제 화면이 어긋난다.**
- 색은 짐작하지 말 것. 곤색 `#1E233D` · 옐로우 `#FFCD00` · CTA `#4088FE` 는 그 소개서를
  pdf.js 로 렌더해 **픽셀에서 읽은 값**이다. 카카오 **공식** 옐로우(`#FEE500`)가 아니다.
  값을 바꿀 땐 `src/lib/partnerBranding.js` 의 `THEME_PRESETS.kakao` 와 **함께** 고칠 것.
- 슬라이드는 `overflow:hidden` 이라 **내용이 넘쳐도 에러 없이 잘린 채 PDF 가 나온다.**
  build 의 넘침·겹침 검사를 지우지 말 것 — 실제로 두 번(팁 박스 잘림 · 설명이 팁을 덮음)
  이 검사가 아니었으면 그대로 고객에게 나갈 뻔했다.
- 캡처는 **채드윅 실계정**을 쓰므로 이름·노선이 그대로 찍힌다. 다른 고객사에 보낼 때는
  그 고객사 계정으로 다시 찍거나 마스킹할 것.

## 다른 고객사에 재사용할 때

`deck.tpl.html` 의 문구에서 고객사에 종속된 표현은 없다. 브랜드 표기는 `{{brand}}` 자리라
`BRAND="…" node docs/manual/kakao-deck/build.cjs` 로 갈아끼운다(기본값 `카카오 T`).
색을 그 고객사 톤으로 바꾸려면 `:root` 의 `--navy`/`--gold`/`--cta` 세 값만 갈아끼운다.
