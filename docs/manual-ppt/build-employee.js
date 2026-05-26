// 승객(직원)앱 매뉴얼 PPT 빌더 (Buslink EmployeeApp `/p`, 모바일)
// 실행: node build-employee.js
const PptxGenJS = require("pptxgenjs");
const path = require("path");
const fs = require("fs");
const T = require("./theme");
const H = require("./helpers");

const pptx = new PptxGenJS();
pptx.layout = "LAYOUT_WIDE";
pptx.title = "Buslink 승객앱 매뉴얼";
pptx.author = "동영관광";

const EMP_RATIO = 390 / 844;

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

const TOTAL = 13;

// 1. 표지
H.cover(pptx, {
  label: "BUSLINK · EMPLOYEE",
  title: "승객앱 사용 안내",
  subtitle: "통근버스를 이용하는 직원을 위한 안내",
  meta: "동영관광 · Buslink",
});

// 2. 앱 소개
{
  const s = pptx.addSlide();
  H.header(s, "이 앱은 뭐예요?", "내 버스 위치 + 도착 시간 + 탑승 확인");
  H.pointCards(s, [
    { icon: "🗺", color: "brand", title: "지도 + 내 정류장",
      body: "버스 위치 실시간 + 내가\n탈 정류장 ETA 카운트다운" },
    { icon: "📢", color: "green", title: "공지 + 푸시 알림",
      body: "관리자 공지 즉시.\n버스 2/1정거장 전 푸시" },
    { icon: "🎫", color: "orange", title: "탑승 QR 스캔",
      body: "기사 화면 QR을\n폰 카메라로 스캔 = 탑승" },
  ], { top: 1.8, height: 2.4 });
  H.calloutBox(s, {
    x: 0.5, y: 4.5, w: 12.3, h: 1.3, color: "brand", icon: "🌐",
    title: "앱 설치 안내 — buslink-prod.web.app/p",
    body: "Chrome으로 접속 후 ‘홈 화면에 추가’ → 아이콘으로 실행. 별도 앱스토어 설치 없음.",
  });
  H.calloutBox(s, {
    x: 0.5, y: 6.0, w: 12.3, h: 1.0, color: "grey", icon: "🔐",
    title: "사번 + PIN으로 로그인",
    body: "",
  });
  H.footer(s, 2, TOTAL);
}

// 3. 로그인 + 노선 선택
{
  const s = pptx.addSlide();
  H.header(s, "로그인 + 노선 선택", "처음 한 번만");
  leftTitle(s, "절차", "");
  H.numberedList(s, [
    { n: 1, title: "사번 입력", body: "회사에서 받은 사번 (관리자가 직원 등록 시 부여)" },
    { n: 2, title: "PIN 입력", body: "초기 PIN은 관리자에게 받음. 처음 로그인 후 변경 권장" },
    { n: 3, title: "노선 선택", body: "본인이 평소 이용하는 통근버스 노선" },
    { n: 4, title: "로그인 완료", body: "다음 방문부터 자동 로그인 (localStorage 세션)" },
  ], { y: 2.5, rowH: 1.0, w: LEFT_W });
  H.calloutBox(s, {
    x: LEFT_X, y: 6.4, w: LEFT_W, h: 0.6, color: "yellow",
    title: "💡 노선은 나중에 ‘노선 변경’ 버튼으로 언제든 갱신",
    body: "",
  });
  H.shotOrPlaceholder(s, "employee", "01-login.png", {
    x: SHOT_X, y: SHOT_Y, w: SHOT_W, h: SHOT_H,
    imgRatio: EMP_RATIO,
    markers: [
      { rx: 0.50, ry: 0.30, n: 1 },
      { rx: 0.50, ry: 0.45, n: 2 },
      { rx: 0.50, ry: 0.60, n: 3 },
      { rx: 0.50, ry: 0.75, n: 4 },
    ],
    caption: "로그인 화면",
  });
  H.footer(s, 3, TOTAL);
}

// 4. PWA 설치 — Android
{
  const s = pptx.addSlide();
  H.header(s, "Android — 홈 화면에 추가", "Chrome 브라우저 (Samsung Internet 동일)");
  leftTitle(s, "두 가지 방법", "");
  H.numberedList(s, [
    { n: 1, title: "방법 ①: 자동 안내 배너 탭", body: "처음 방문 시 하단에 ‘앱 설치하기’ 배너가 뜸 → 탭 → ‘설치’" },
    { n: 2, title: "방법 ②: 메뉴에서 직접", body: "Chrome 우측 메뉴 ⋮ → ‘홈 화면에 추가’ 또는 ‘앱 설치’" },
    { n: 3, title: "홈 화면 아이콘 생성", body: "‘BusLink’ 이름으로 아이콘 → 탭하면 풀스크린 실행" },
    { n: 4, title: "이후엔 아이콘으로", body: "Chrome 안 거치고 바로 앱처럼 실행" },
  ], { y: 2.5, rowH: 1.0, w: LEFT_W });
  H.calloutBox(s, {
    x: LEFT_X, y: 6.4, w: LEFT_W, h: 0.6, color: "brand",
    title: "💡 scope=/p — 승객앱 전용 아이콘 (기사앱과 별개)",
    body: "",
  });
  H.shotOrPlaceholder(s, "employee", "02-install-android.png", {
    x: SHOT_X, y: SHOT_Y, w: SHOT_W, h: SHOT_H,
    imgRatio: EMP_RATIO,
    caption: "설치 안내 배너",
  });
  H.footer(s, 4, TOTAL);
}

// 5. PWA 설치 — iOS
{
  const s = pptx.addSlide();
  H.header(s, "iOS — 홈 화면에 추가", "Safari 브라우저 (Chrome iOS는 불가)");
  leftTitle(s, "3단계", "");
  H.numberedList(s, [
    { n: 1, title: "Safari 하단 공유 버튼 탭", body: "사각형 + 위쪽 화살표 모양 아이콘 (하단 툴바)" },
    { n: 2, title: "‘홈 화면에 추가’ 선택", body: "공유 메뉴 스크롤 아래쪽" },
    { n: 3, title: "‘추가’ 탭 (우상단)", body: "이름 ‘BusLink’ 확인 후 추가 — 홈 화면 아이콘 생성" },
  ], { y: 2.5, rowH: 1.2, w: LEFT_W });
  H.calloutBox(s, {
    x: LEFT_X, y: 6.4, w: LEFT_W, h: 0.6, color: "red",
    title: "⚠ iOS는 standalone 실행에서만 알림 권한 가능",
    body: "",
  });
  H.shotOrPlaceholder(s, "employee", "03-install-ios.png", {
    x: SHOT_X, y: SHOT_Y, w: SHOT_W, h: SHOT_H,
    imgRatio: EMP_RATIO,
    caption: "Safari 공유 → 홈 화면 추가",
  });
  H.footer(s, 5, TOTAL);
}

// 6. 홈 — 지도 + 내 정류장
{
  const s = pptx.addSlide();
  H.header(s, "홈 — 지도 + 내 정류장 ETA", "첫 화면. 가장 자주 보는 화면");
  leftTitle(s, "화면 구성", "");
  H.numberedList(s, [
    { n: 1, title: "지도 (상단)", body: "버스 현재 위치 + 노선 경로 + 모든 정류장 마커" },
    { n: 2, title: "내 정류장 + ETA", body: "선택한 ‘내 정류장’ 도착 예정 시각 + N분 카운트다운" },
    { n: 3, title: "정류장 리스트 (하단)", body: "전 정류장 도착 시각. 통과한 정류장은 회색" },
    { n: 4, title: "노선 변경 / 새로고침", body: "헤더에서 다른 노선으로 빠른 전환" },
  ], { y: 2.5, rowH: 1.0, w: LEFT_W });
  H.calloutBox(s, {
    x: LEFT_X, y: 6.4, w: LEFT_W, h: 0.6, color: "green",
    title: "💡 정류장 마커 탭 = 정류장 정보 카드 (사진/안내문)",
    body: "",
  });
  H.shotOrPlaceholder(s, "employee", "04-home.png", {
    x: SHOT_X, y: SHOT_Y, w: SHOT_W, h: SHOT_H,
    imgRatio: EMP_RATIO,
    markers: [
      { rx: 0.50, ry: 0.30, n: 1 },
      { rx: 0.50, ry: 0.58, n: 2 },
      { rx: 0.50, ry: 0.78, n: 3 },
      { rx: 0.85, ry: 0.07, n: 4 },
    ],
    caption: "홈 화면",
  });
  H.footer(s, 6, TOTAL);
}

// 7. 내 정류장 선택 + 도착 임박 푸시
{
  const s = pptx.addSlide();
  H.header(s, "내 정류장 선택 = 도착 임박 푸시 수신", "이게 핵심 기능");
  leftTitle(s, "사용 흐름", "");
  H.numberedList(s, [
    { n: 1, title: "정류장 마커 탭", body: "지도 또는 리스트에서 내가 탈 정류장 선택" },
    { n: 2, title: "‘내 정류장으로 설정’", body: "정보 카드 안 버튼" },
    { n: 3, title: "2정거장/1정거장 전 푸시", body: "버스가 내 정류장 2/1정거장 전 도착 = 폰 푸시" },
    { n: 4, title: "해제하려면 같은 자리 탭", body: "내 정류장 토글 (다른 정류장 선택 시 자동 해제)" },
  ], { y: 2.5, rowH: 1.0, w: LEFT_W });
  H.calloutBox(s, {
    x: LEFT_X, y: 6.4, w: LEFT_W, h: 0.6, color: "yellow",
    title: "💡 알림이 안 오면 설정 탭 → 🔔 알림 진단 → 토큰 재발급",
    body: "",
  });
  H.shotOrPlaceholder(s, "employee", "05-mystop.png", {
    x: SHOT_X, y: SHOT_Y, w: SHOT_W, h: SHOT_H,
    imgRatio: EMP_RATIO,
    markers: [
      { rx: 0.50, ry: 0.40, n: 1 },
      { rx: 0.50, ry: 0.65, n: 2 },
      { rx: 0.50, ry: 0.18, n: 3 },
      { rx: 0.85, ry: 0.65, n: 4 },
    ],
    caption: "내 정류장 정보 카드",
  });
  H.footer(s, 7, TOTAL);
}

// 8. 노선 변경
{
  const s = pptx.addSlide();
  H.header(s, "노선 변경", "다른 노선을 잠깐 보거나, 기준 노선 갱신");
  H.pointCards(s, [
    { icon: "🔄", color: "brand", title: "‘노선 변경’ 버튼",
      body: "헤더 우측 또는 정류장 탭에서.\n탭 → 노선 picker → 선택" },
    { icon: "📌", color: "green", title: "기준 노선 저장",
      body: "선택한 노선을 기준으로 저장.\n다음 방문 시 자동 복원" },
  ], { top: 1.7, height: 2.6 });
  H.calloutBox(s, {
    x: 0.5, y: 4.6, w: 12.3, h: 1.0, color: "yellow", icon: "💡",
    title: "기준 노선 ≠ 임시 조회",
    body: "임시 조회는 다른 노선을 잠깐만 보고 새로고침하면 다시 기준 노선으로. 영구 변경하려면 저장 확인.",
  });
  H.calloutBox(s, {
    x: 0.5, y: 5.8, w: 12.3, h: 1.2, color: "grey", icon: "✅",
    title: "노선 변경 시 내 정류장은 자동 해제 (새 노선엔 없으니까)",
    body: "",
  });
  H.footer(s, 8, TOTAL);
}

// 9. 공지함
{
  const s = pptx.addSlide();
  H.header(s, "공지 — 안 읽음 배지 + 도달 보장", "📢 공지 탭 (5번째)");
  leftTitle(s, "공지 두 채널", "");
  H.numberedList(s, [
    { n: 1, title: "공지 탭 + 안 읽음 배지", body: "관리자가 보낸 모든 공지가 최신순. 새 공지 있으면 빨간 숫자" },
    { n: 2, title: "푸시 알림 (즉시)", body: "공지 발송 즉시 폰 알림. OEM 절전으로 누락 가능 — 공지함이 폴백" },
    { n: 3, title: "공지 본문 확인", body: "탭 → 본문 전문 + 발송 시각" },
    { n: 4, title: "협력사별 분리 발송", body: "관리자가 협력사 단위로 보내면 해당 협력사만 표시" },
  ], { y: 2.5, rowH: 0.95, w: LEFT_W });
  H.calloutBox(s, {
    x: LEFT_X, y: 6.4, w: LEFT_W, h: 0.6, color: "brand",
    title: "💡 공지함 = 푸시 누락 보완 도달 보장 통로",
    body: "",
  });
  H.shotOrPlaceholder(s, "employee", "06-notices.png", {
    x: SHOT_X, y: SHOT_Y, w: SHOT_W, h: SHOT_H,
    imgRatio: EMP_RATIO,
    markers: [
      { rx: 0.65, ry: 0.95, n: 1 },
      { rx: 0.85, ry: 0.92, n: 2 },
      { rx: 0.50, ry: 0.35, n: 3 },
      { rx: 0.25, ry: 0.35, n: 4 },
    ],
    caption: "공지함",
  });
  H.footer(s, 9, TOTAL);
}

// 10. 탑승 QR 스캔
{
  const s = pptx.addSlide();
  H.header(s, "탑승 QR 스캔", "정류장에서 버스 탑승 시");
  leftTitle(s, "절차", "");
  H.numberedList(s, [
    { n: 1, title: "하단 ‘탑승’ 탭 (4번째)", body: "" },
    { n: 2, title: "카메라 권한 허용", body: "처음 한 번. 폰 카메라가 켜짐" },
    { n: 3, title: "기사 화면 QR 비추기", body: "기사 폰에 떠 있는 큰 QR을 본인 폰 카메라로" },
    { n: 4, title: "‘탑승 완료’ 표시", body: "성공 시 사번/이름/노선/시각 카드 표시 — 통계에 자동 누적" },
  ], { y: 2.5, rowH: 1.0, w: LEFT_W });
  H.calloutBox(s, {
    x: LEFT_X, y: 6.4, w: LEFT_W, h: 0.6, color: "red",
    title: "⚠ QR은 5분 만료 — 기사가 새로 발급해야 할 수 있음",
    body: "",
  });
  H.shotOrPlaceholder(s, "employee", "07-scan.png", {
    x: SHOT_X, y: SHOT_Y, w: SHOT_W, h: SHOT_H,
    imgRatio: EMP_RATIO,
    markers: [
      { rx: 0.65, ry: 0.95, n: 1 },
      { rx: 0.50, ry: 0.30, n: 2 },
      { rx: 0.50, ry: 0.50, n: 3 },
      { rx: 0.50, ry: 0.72, n: 4 },
    ],
    caption: "탑승 QR 스캔 화면",
  });
  H.footer(s, 10, TOTAL);
}

// 11. 설정 + 알림 진단
{
  const s = pptx.addSlide();
  H.header(s, "설정 — 알림 진단 + OEM 절전 안내", "⚙ 설정 탭");
  leftTitle(s, "주요 메뉴", "");
  H.numberedList(s, [
    { n: 1, title: "🔔 알림 진단", body: "권한 상태(허용/거부) + 토큰 발급 여부 + 갱신 시각 + 🔄 재발급" },
    { n: 2, title: "🔋 배터리 절전 예외", body: "삼성 갤럭시·기타 Android — OEM 절전이 알림 누락 원인. 안내 카드" },
    { n: 3, title: "📲 앱 설치하기", body: "홈 화면 추가 안내 (안 했으면 여기서 다시)" },
    { n: 4, title: "PIN 변경 / 로그아웃", body: "보안 관리 + 다른 계정 전환" },
  ], { y: 2.5, rowH: 0.95, w: LEFT_W });
  H.calloutBox(s, {
    x: LEFT_X, y: 6.4, w: LEFT_W, h: 0.6, color: "yellow",
    title: "💡 알림 안 오면 → 알림 진단부터 (권한·토큰·OEM 절전 순서)",
    body: "",
  });
  H.shotOrPlaceholder(s, "employee", "08-settings.png", {
    x: SHOT_X, y: SHOT_Y, w: SHOT_W, h: SHOT_H,
    imgRatio: EMP_RATIO,
    markers: [
      { rx: 0.50, ry: 0.20, n: 1 },
      { rx: 0.50, ry: 0.40, n: 2 },
      { rx: 0.50, ry: 0.60, n: 3 },
      { rx: 0.50, ry: 0.80, n: 4 },
    ],
    caption: "설정 화면",
  });
  H.footer(s, 11, TOTAL);
}

// 12. FAQ
{
  const s = pptx.addSlide();
  H.header(s, "자주 묻는 질문", "");
  H.pointCards(s, [
    { icon: "❓", color: "grey", title: "버스 위치가 안 보여요",
      body: "1) 새로고침\n2) 노선 맞나 확인\n3) 운행 시간대 맞나\n4) 기사가 운행 시작했나" },
    { icon: "❓", color: "grey", title: "알림이 안 와요",
      body: "설정 → 🔔 알림 진단.\n권한·토큰 확인 후 재발급.\n삼성은 OEM 절전 예외 필수" },
    { icon: "❓", color: "grey", title: "QR 스캔이 안 돼요",
      body: "1) 카메라 권한?\n2) 기사 QR 5분 만료?\n3) 화면 밝기 ↑\n4) 기사에게 새 QR 요청" },
  ], { top: 1.7, height: 2.5 });
  H.pointCards(s, [
    { icon: "❓", color: "grey", title: "ETA가 갑자기 변해요",
      body: "터널/약전계 GPS 노이즈.\n‘약 N분’ 버킷 표시로\n안정화하지만 한계는 있음" },
    { icon: "❓", color: "grey", title: "다른 정류장 잠깐 보기",
      body: "지도에서 다른 정류장 탭.\n‘내 정류장’ 변경 안 함.\n새로고침=기준 노선 복원" },
    { icon: "❓", color: "grey", title: "사번/PIN 분실",
      body: "회사 인사담당자 또는\n관리자에게 재발급 요청" },
  ], { top: 4.4, height: 2.5 });
  H.footer(s, 12, TOTAL);
}

// 13. 마무리
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
  s.addText("편안한 출퇴근 되세요", {
    x: 1.5, y: 3.0, w: 10.3, h: 1.0,
    fontFace: T.fontBold, fontSize: 32, color: T.brandInk, bold: true, align: "center",
  });
  s.addText("• 처음 한 번 ‘홈 화면에 추가’ 권장 — 알림 도달률 ↑\n• 내 정류장 설정 = 도착 임박 푸시 자동\n• 새 공지는 공지 탭의 빨간 배지로\n• 탑승은 기사 QR 스캔 한 번",
    {
      x: 2.5, y: 4.0, w: 8.3, h: 1.7,
      fontFace: T.font, fontSize: 14, color: T.t2, valign: "top",
    });
  s.addText("동영관광 · Buslink", {
    x: 0.5, y: 6.5, w: 12.3, h: 0.4,
    fontFace: T.font, fontSize: 11, color: T.t4, align: "center",
  });
  H.footer(s, 13, TOTAL);
}

const outPath = path.join(__dirname, "out", "Buslink_승객앱매뉴얼.pptx");
const outDir = path.dirname(outPath);
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

pptx.writeFile({ fileName: outPath }).then((file) => {
  console.log("✅ 승객앱 매뉴얼 생성 완료:", file);
}).catch((err) => {
  console.error("❌ 생성 실패:", err);
  process.exit(1);
});
