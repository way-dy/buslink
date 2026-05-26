// 기사앱 매뉴얼 PPT 빌더 (Buslink DriverApp `/driver`, 모바일)
// 실행: node build-driver.js
const PptxGenJS = require("pptxgenjs");
const path = require("path");
const fs = require("fs");
const T = require("./theme");
const H = require("./helpers");

const pptx = new PptxGenJS();
pptx.layout = "LAYOUT_WIDE";
pptx.title = "Buslink 기사앱 매뉴얼";
pptx.author = "동영관광";

// iPhone 14 viewport (390 / 844)
const DRV_RATIO = 390 / 844;

const LEFT_X = 0.5;
const LEFT_W = 8.6;
const SHOT_X = 9.6;
const SHOT_Y = 1.4;
const SHOT_W = 3.2;
const SHOT_H = 5.8;

function leftTitle(s, title, sub) {
  s.addText(title, {
    x: LEFT_X, y: 1.5, w: LEFT_W, h: 0.5,
    fontFace: T.fontBold, fontSize: 22, color: T.t1, bold: true,
  });
  if (sub) {
    s.addText(sub, {
      x: LEFT_X, y: 2.0, w: LEFT_W, h: 0.4,
      fontFace: T.font, fontSize: 13, color: T.t3,
    });
  }
}

const TOTAL = 11;

// 1. 표지
H.cover(pptx, {
  label: "BUSLINK · DRIVER",
  title: "기사앱 사용 안내",
  subtitle: "통근버스 기사님을 위한 운행 안내",
  meta: "동영관광 · Buslink",
});

// 2. 앱 소개
{
  const s = pptx.addSlide();
  H.header(s, "이 앱은 뭐예요?", "운행 시작·정류장 도착·QR 발급을 한 화면에서");
  H.pointCards(s, [
    { icon: "🚌", color: "brand", title: "운행 시작/종료",
      body: "오늘 배차 선택 후\n‘운행 시작’ 큰 버튼 한 번" },
    { icon: "📍", color: "green", title: "GPS 자동 추적",
      body: "차량 위치를 5초마다\n관제·승객앱에 전송" },
    { icon: "🎫", color: "orange", title: "탑승 QR 발급",
      body: "직원이 폰 카메라로 스캔\n5분 만료 토큰" },
  ], { top: 1.8, height: 2.4 });
  H.calloutBox(s, {
    x: 0.5, y: 4.5, w: 12.3, h: 1.3, color: "brand", icon: "🌐",
    title: "앱 설치 안내 — buslink-prod.web.app/driver",
    body: "Chrome으로 접속 후 ‘홈 화면에 추가’ → 아이콘으로 실행. 별도 앱스토어 설치 없음.",
  });
  H.calloutBox(s, {
    x: 0.5, y: 6.0, w: 12.3, h: 1.0, color: "grey", icon: "🔐",
    title: "사번 + PIN으로 로그인",
    body: "",
  });
  H.footer(s, 2, TOTAL);
}

// 3. 로그인
{
  const s = pptx.addSlide();
  H.header(s, "처음 시작 — 로그인", "사번과 PIN으로 입장");
  leftTitle(s, "이 화면에서 할 일", "");
  H.numberedList(s, [
    { n: 1, title: "Buslink 로고 + 안내", body: "기사 전용 로그인 화면" },
    { n: 2, title: "사번 입력", body: "관리자가 등록한 본인 사번 (보통 4자리 숫자)" },
    { n: 3, title: "PIN 입력", body: "초기 PIN은 관리자에게 받음. 6자 이상" },
    { n: 4, title: "로그인 버튼", body: "탭 → 위치/알림 권한 허용 → 홈 화면" },
  ], { y: 2.5, rowH: 1.0, w: LEFT_W });
  H.calloutBox(s, {
    x: LEFT_X, y: 6.0, w: LEFT_W, h: 1.0, color: "red", icon: "⚠",
    title: "PIN 분실 시 관리자에게 요청 — 재설정 가능",
    body: "관리자 페이지의 ‘비밀번호 변경’ 버튼으로 즉시 재설정. 그 후 새 PIN으로 로그인.",
  });
  H.shotOrPlaceholder(s, "driver", "01-login.png", {
    x: SHOT_X, y: SHOT_Y, w: SHOT_W, h: SHOT_H,
    imgRatio: DRV_RATIO,
    markers: [
      { rx: 0.50, ry: 0.20, n: 1 },
      { rx: 0.50, ry: 0.40, n: 2 },
      { rx: 0.50, ry: 0.50, n: 3 },
      { rx: 0.50, ry: 0.62, n: 4 },
    ],
    caption: "로그인 화면",
  });
  H.footer(s, 3, TOTAL);
}

// 4. PWA 설치
{
  const s = pptx.addSlide();
  H.header(s, "홈 화면에 추가 (앱 설치)", "한 번 추가하면 아이콘으로 빠르게 실행");
  H.pointCards(s, [
    { icon: "🤖", color: "brand", title: "Android Chrome",
      body: "주소창 우측 ‘설치’ 아이콘\n또는 우측 메뉴 ⋮ →\n‘홈 화면에 추가’" },
    { icon: "🍎", color: "grey", title: "iOS Safari",
      body: "하단 공유 버튼 → \n‘홈 화면에 추가’ → \n‘추가’" },
  ], { top: 1.7, height: 2.6 });
  H.calloutBox(s, {
    x: 0.5, y: 4.6, w: 12.3, h: 1.0, color: "yellow", icon: "💡",
    title: "scope=/driver — 기사앱 전용 아이콘 (직원앱 /p과 별개)",
    body: "",
  });
  H.calloutBox(s, {
    x: 0.5, y: 5.8, w: 12.3, h: 1.2, color: "green", icon: "✅",
    title: "홈 화면 실행 = 백그라운드 푸시 도달",
    body: "브라우저 탭은 백그라운드 폐기되지만 PWA 설치 후엔 별도 프로세스 유지 → 운행 종료/알림 푸시 도달.",
  });
  H.footer(s, 4, TOTAL);
}

// 5. 홈 화면 + 운행 시작
{
  const s = pptx.addSlide();
  H.header(s, "홈 화면 + 운행 시작", "오늘 배차 선택 → 큰 버튼 한 번");
  leftTitle(s, "위에서 아래로", "");
  H.numberedList(s, [
    { n: 1, title: "헤더 — 기사명 + 로그아웃", body: "" },
    { n: 2, title: "오늘 배차 선택", body: "‘배차 선택’ 버튼 탭 → 노선/시간 picker → 확인" },
    { n: 3, title: "▶ 운행 시작 큰 버튼", body: "배차 선택 후 활성화. 탭하면 GPS 권한 + 알림 권한 요청" },
    { n: 4, title: "정류장 리스트", body: "오늘 운행할 정류장이 순서대로 표시" },
  ], { y: 2.5, rowH: 1.0, w: LEFT_W });
  H.calloutBox(s, {
    x: LEFT_X, y: 6.3, w: LEFT_W, h: 0.7, color: "yellow",
    title: "💡 권한 두 종류 필수 — 위치 + 알림",
    body: "",
  });
  H.shotOrPlaceholder(s, "driver", "02-home.png", {
    x: SHOT_X, y: SHOT_Y, w: SHOT_W, h: SHOT_H,
    imgRatio: DRV_RATIO,
    markers: [
      { rx: 0.50, ry: 0.05, n: 1 },
      { rx: 0.50, ry: 0.18, n: 2 },
      { rx: 0.50, ry: 0.30, n: 3 },
      { rx: 0.50, ry: 0.60, n: 4 },
    ],
    caption: "홈 화면 (운행 시작 전)",
  });
  H.footer(s, 5, TOTAL);
}

// 6. 운행 중 — 정류장 진행
{
  const s = pptx.addSlide();
  H.header(s, "운행 중 — 정류장 진행", "GPS가 100m 반경 진입 시 자동 도착");
  leftTitle(s, "화면 영역", "");
  H.numberedList(s, [
    { n: 1, title: "현재 정류장 강조", body: "곧 도착할 정류장이 강조 표시. 통과한 정류장은 회색" },
    { n: 2, title: "통과 정류장 자동 마킹", body: "GPS 100m 반경 진입 → ‘도착’ 자동 기록 (멱등)" },
    { n: 3, title: "탑승 QR 탭", body: "정류장 도착 시점에 발급. 직원이 폰 카메라로 스캔" },
    { n: 4, title: "운행 / 탑승 QR 탭 전환", body: "상단 토글로 두 화면 왕복" },
  ], { y: 2.5, rowH: 1.0, w: LEFT_W });
  H.calloutBox(s, {
    x: LEFT_X, y: 6.3, w: LEFT_W, h: 0.7, color: "brand",
    title: "💡 GPS 끊김(터널·약전계) 복구 시 통과 누락 자동 백필",
    body: "",
  });
  H.shotOrPlaceholder(s, "driver", "03-driving.png", {
    x: SHOT_X, y: SHOT_Y, w: SHOT_W, h: SHOT_H,
    imgRatio: DRV_RATIO,
    markers: [
      { rx: 0.50, ry: 0.45, n: 1 },
      { rx: 0.50, ry: 0.65, n: 2 },
      { rx: 0.50, ry: 0.25, n: 3 },
      { rx: 0.50, ry: 0.18, n: 4 },
    ],
    caption: "운행 중 화면",
  });
  H.footer(s, 6, TOTAL);
}

// 7. 탑승 QR 발급
{
  const s = pptx.addSlide();
  H.header(s, "탑승 QR 발급", "정류장 도착 시 직원에게 보여주는 QR");
  leftTitle(s, "사용법", "");
  H.numberedList(s, [
    { n: 1, title: "상단 ‘탑승 QR’ 탭 선택", body: "운행 탭과 토글" },
    { n: 2, title: "QR 코드 큰 표시", body: "직원이 폰 카메라로 스캔" },
    { n: 3, title: "5분 만료 타이머", body: "5분 후 자동 만료 — 새로고침 버튼으로 갱신" },
    { n: 4, title: "1회 사용 후 소각", body: "한 직원이 스캔 = 토큰 소각. 다음 직원은 새 QR 필요" },
  ], { y: 2.5, rowH: 1.0, w: LEFT_W });
  H.calloutBox(s, {
    x: LEFT_X, y: 6.3, w: LEFT_W, h: 0.7, color: "yellow",
    title: "💡 QR 화면 캡처해 단톡방에 올리지 마세요 — 다른 사람이 스캔",
    body: "",
  });
  H.shotOrPlaceholder(s, "driver", "04-qr.png", {
    x: SHOT_X, y: SHOT_Y, w: SHOT_W, h: SHOT_H,
    imgRatio: DRV_RATIO,
    markers: [
      { rx: 0.70, ry: 0.18, n: 1 },
      { rx: 0.50, ry: 0.45, n: 2 },
      { rx: 0.50, ry: 0.75, n: 3 },
      { rx: 0.85, ry: 0.75, n: 4 },
    ],
    caption: "탑승 QR 화면",
  });
  H.footer(s, 7, TOTAL);
}

// 8. GPS 추적 + 통신장애 회복
{
  const s = pptx.addSlide();
  H.header(s, "GPS 추적 + 통신장애 회복", "운행 중 자동 — 별도 조작 불필요");
  H.pointCards(s, [
    { icon: "📡", color: "brand", title: "5초마다 GPS 전송",
      body: "관제·승객앱에 실시간 위치 표시.\n5m 이동 또는 5초 경과 시\n전송 (배터리 절약)" },
    { icon: "🔄", color: "green", title: "통신장애 복구 백필",
      body: "터널·약전계로 GPS 끊겨도\n복구 즉시 통과 누락\n정류장 자동 기록" },
  ], { top: 1.7, height: 2.7 });
  H.calloutBox(s, {
    x: 0.5, y: 5.0, w: 12.3, h: 1.0, color: "red", icon: "⚠",
    title: "위치 권한은 ‘항상 허용’ 필수",
    body: "‘앱 사용 중에만’이면 화면 끄면 GPS 멈춤 → 관제 ‘차량 사라짐’.",
  });
  H.calloutBox(s, {
    x: 0.5, y: 6.2, w: 12.3, h: 0.9, color: "grey", icon: "🔋",
    title: "운행 중에만 GPS 동작 — 운행 종료 후 자동 OFF (배터리)",
    body: "",
  });
  H.footer(s, 8, TOTAL);
}

// 9. 운행 종료
{
  const s = pptx.addSlide();
  H.header(s, "운행 종료", "모든 정류장 통과 후 ‘운행 종료’ 버튼");
  H.pointCards(s, [
    { icon: "🛑", color: "red", title: "운행 종료 버튼",
      body: "화면 하단에 표시.\n탭 → confirm → GPS 전송\n중지 + 상태 ‘완료’" },
    { icon: "📅", color: "brand", title: "다음 배차",
      body: "다음 배차 있으면 다시\n‘배차 선택’으로 진입 가능.\n없으면 로그아웃." },
  ], { top: 1.7, height: 2.7 });
  H.calloutBox(s, {
    x: 0.5, y: 5.0, w: 12.3, h: 1.0, color: "yellow", icon: "💡",
    title: "운행 종료 누락 시 GPS 계속 전송 — 배터리 소모 + 관제 혼란",
    body: "마지막 정류장 통과 직후 종료 권장.",
  });
  H.calloutBox(s, {
    x: 0.5, y: 6.2, w: 12.3, h: 0.9, color: "green", icon: "✅",
    title: "운행 종료 후 운행 이력에 자동 저장 — 관리자가 추후 조회",
    body: "",
  });
  H.footer(s, 9, TOTAL);
}

// 10. FAQ
{
  const s = pptx.addSlide();
  H.header(s, "자주 묻는 질문", "");
  H.pointCards(s, [
    { icon: "❓", color: "grey", title: "GPS가 안 잡혀요",
      body: "1) 위치 권한 ‘항상 허용’?\n2) 비행기 모드 OFF?\n3) 차량 시동 + 야외?\n   터널 입출 시 일시 끊김 정상" },
    { icon: "❓", color: "grey", title: "운행 시작이 안 눌려요",
      body: "오늘 배차 미선택 가능성.\n‘배차 선택’ 버튼으로\n먼저 노선/시간 고르기" },
    { icon: "❓", color: "grey", title: "QR이 갱신이 안 돼요",
      body: "새로고침 버튼 탭.\n5분 만료라 자동 갱신 X.\n네트워크 약하면 재시도" },
  ], { top: 1.7, height: 2.6 });
  H.pointCards(s, [
    { icon: "❓", color: "grey", title: "알림이 안 와요",
      body: "Android: 설정→앱→Buslink\n→알림 허용\niOS: 홈 화면 추가 후 standalone\n실행에서만 알림" },
    { icon: "❓", color: "grey", title: "다른 폰에서 로그인",
      body: "사번 + PIN 그대로\n새 폰에서 재로그인 OK.\n이전 폰은 자동 로그아웃" },
    { icon: "❓", color: "grey", title: "관제 직접 연락",
      body: "전화로 상황 공유.\n앱 채팅 기능은 별도 안내" },
  ], { top: 4.4, height: 2.6 });
  H.footer(s, 10, TOTAL);
}

// 11. 마무리
{
  const s = pptx.addSlide();
  s.background = { color: T.bg };
  s.addShape("roundRect", {
    x: 1.5, y: 1.8, w: 10.3, h: 4.0,
    fill: { color: T.brandSubtle }, line: { color: T.brand, width: 2 },
    rectRadius: 0.2,
  });
  s.addText("🚌", {
    x: 1.5, y: 2.0, w: 10.3, h: 1.0,
    fontFace: T.font, fontSize: 56, color: T.brand, align: "center",
  });
  s.addText("안전 운행 부탁드립니다", {
    x: 1.5, y: 3.0, w: 10.3, h: 1.0,
    fontFace: T.fontBold, fontSize: 32, color: T.brandInk, bold: true, align: "center",
  });
  s.addText("• 운행 시작 전 GPS·알림 권한 ‘항상 허용’\n• 정류장 도착은 자동 — 별도 조작 불필요\n• QR은 5분 만료 — 직원에게 빠르게 보여주기\n• 운행 종료는 꼭 마지막 정류장 후에",
    {
      x: 2.5, y: 4.0, w: 8.3, h: 1.7,
      fontFace: T.font, fontSize: 14, color: T.t2, valign: "top",
    });
  s.addText("동영관광 · Buslink", {
    x: 0.5, y: 6.5, w: 12.3, h: 0.4,
    fontFace: T.font, fontSize: 11, color: T.t4, align: "center",
  });
  H.footer(s, 11, TOTAL);
}

const outPath = path.join(__dirname, "out", "Buslink_기사앱매뉴얼.pptx");
const outDir = path.dirname(outPath);
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

pptx.writeFile({ fileName: outPath }).then((file) => {
  console.log("✅ 기사앱 매뉴얼 생성 완료:", file);
}).catch((err) => {
  console.error("❌ 생성 실패:", err);
  process.exit(1);
});
