# Buslink 매뉴얼 PPT 생성기

동영관광 통근버스 관제 시스템(`buslink-prod`) 사용자 매뉴얼 3종을 편집 가능한 PowerPoint(.pptx)로 생성합니다.

## 산출물

- `out/Buslink_관리자매뉴얼.pptx` — AdminApp(`/`) 관리자용 12~15장
- `out/Buslink_기사앱매뉴얼.pptx` — DriverApp(`/driver`) 모바일 기사용 10~13장
- `out/Buslink_승객앱매뉴얼.pptx` — EmployeeApp(`/p`) 모바일 직원용 12~15장

## 설치 (최초 1회)

```bash
cd app/buslink/docs/manual-ppt
npm install
npx playwright install chromium
```

## 사용 흐름 (3단계)

### 1) placeholder 빌드 (캡처 없이 골격 확인)

```bash
npm run all
```

캡처 PNG가 없어도 `out/*.pptx` 3개가 생성됩니다. 슬라이드의 화면 영역은 점선 박스 + "📷 캡처 예정" 텍스트로 표시.

### 2) 실 화면 캡처 (역할별 1회씩)

각 명령은 Chromium 창을 열고 `https://buslink-prod.web.app`에 접속합니다. **사용자 부담 = 로그인 1회 + Enter 1회**.

```bash
# 관리자 — Firebase Email/Password (@dongyeongtour.co.kr) 로그인
node capture-admin.js

# 기사앱 — 사번 + PIN 로그인 (모바일 viewport, iPhone 14)
node capture-driver.js

# 승객앱 — 사번 + PIN 로그인 (모바일 viewport)
node capture-employee.js
```

캡처 산출물: `assets/<role>/*.png`.

### 3) 캡처 반영 빌드

```bash
npm run all   # 또는 npm run admin / driver / employee
```

## 마커 좌표 조정

번호 마커 위치를 맞추려면 그리드 가이드를 켜고 두 벌 동시 생성:

```bash
MARKER_GRID=1 npm run all
```

`out/*_GRID.pptx`(미구현 — 직접 grid 모드 빌드 후 파일명 변경)에서 정확한 `rx, ry`(0~1) 좌표를 읽어 `build-*.js`의 `markers` 배열을 수정.

## ⚠ 보안·개인정보 (납품 전 필수 점검)

매뉴얼은 외부 공개물입니다. 실 운영 화면 캡처에는 다음이 노출될 수 있습니다:

- 직원 실명 (관제 행 · 탑승 통계 · 채팅)
- 차량번호판 (배차/차량 관리)
- 실 전화번호 (기사 관리 · 비상연락처)
- 협력사 코드 (협력사 관리 — 1년 유효한 키)

**캡처 후 PowerPoint에서 모자이크/블러 처리**를 수동으로 진행하거나, 테스트 데이터로 다시 캡처하세요. `.gitignore`로 `assets/*/*.png`는 git 추적에서 자동 제외됩니다.

## 자동화 트랩 (buslink CRA SPA 한정)

- buslink는 CRA SPA — module 함수가 `window.fn`으로 노출되지 않음. Playwright `evaluate(()=>window.fn())` 의존 금지.
- 탭 전환은 `data-nav-item`(AdminApp) 또는 텍스트 셀렉터 element.click() 직접.
- 카카오맵 로드는 `window.kakao.maps.load(cb)` 콜백 only. `waitForFunction(() => window.kakao?.maps?.LatLng)` 대기 후 캡처(흰화면 캡처 방지).
- 캡처 검증: 1차 캡처 후 PNG 크기 변동 < 10%이면 동일 화면 N번 캡처 사고 의심 — 사용자 확인 요청.

## 알려진 한계 (조건부 화면)

- **기사앱 운행 화면**: 출발/정류장 진행/도착 감지 등은 실제 운행 중에만 노출. placeholder로 둠.
- **기사앱 QR 발급**: 운행 시작 후 활성화. 5분 만료라 캡처 타이밍 주의.
- **승객앱 ETA 카운트다운**: 실제 버스 GPS 송신 중인 차량이 있을 때만. 시뮬레이터 탭으로 보낼 수 있음.

## 파일 구조

```
docs/manual-ppt/
  theme.js              # 색·폰트 토큰 (brand #0066FF)
  helpers.js            # cover/section/header/pointCards/shotOrPlaceholder/numberedList/footer
  build-admin.js        # 관리자 매뉴얼 슬라이드 본문
  build-driver.js       # 기사앱 매뉴얼
  build-employee.js     # 승객(직원)앱 매뉴얼
  capture-admin.js      # 관리자 화면 자동 캡처 (1440x900)
  capture-driver.js     # 기사앱 자동 캡처 (390x844, iPhone 14)
  capture-employee.js   # 승객앱 자동 캡처 (390x844)
  assets/
    admin/              # 관리자 PNG
    driver/             # 기사앱 PNG
    employee/           # 승객앱 PNG
  out/                  # *.pptx (gitignore)
```
