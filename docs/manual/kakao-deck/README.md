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

## 🔴 지켜야 할 것

- **카카오 로고·"카카오 T" 워드마크를 넣지 말 것.** 맞춘 것은 **색과 형태**지 상표가 아니다
  (2026-08-27 way 결정 "색만"). 상표를 쓰려면 카카오 측 **서면 승인**이 선행되어야 한다.
- 색은 짐작하지 말 것. 곤색 `#1E233D` · 옐로우 `#FFCD00` · CTA `#4088FE` 는 그 소개서를
  pdf.js 로 렌더해 **픽셀에서 읽은 값**이다. 카카오 **공식** 옐로우(`#FEE500`)가 아니다.
  값을 바꿀 땐 `src/lib/partnerBranding.js` 의 `THEME_PRESETS.kakao` 와 **함께** 고칠 것.
- 슬라이드는 `overflow:hidden` 이라 **내용이 넘쳐도 에러 없이 잘린 채 PDF 가 나온다.**
  build 의 넘침·겹침 검사를 지우지 말 것 — 실제로 두 번(팁 박스 잘림 · 설명이 팁을 덮음)
  이 검사가 아니었으면 그대로 고객에게 나갈 뻔했다.
- 캡처는 **채드윅 실계정**을 쓰므로 이름·노선이 그대로 찍힌다. 다른 고객사에 보낼 때는
  그 고객사 계정으로 다시 찍거나 마스킹할 것.

## 다른 고객사에 재사용할 때

`deck.tpl.html` 의 문구에서 고객사에 종속된 표현은 없다(브랜드 표기는 `BusLink · 동영관광`).
색을 그 고객사 톤으로 바꾸려면 `:root` 의 `--navy`/`--gold`/`--cta` 세 값만 갈아끼운다.
