// 관리자 매뉴얼 PPT 빌더 (Buslink AdminApp `/`)
// 실행: node build-admin.js
const PptxGenJS = require("pptxgenjs");
const path = require("path");
const fs = require("fs");
const T = require("./theme");
const H = require("./helpers");

const pptx = new PptxGenJS();
pptx.layout = "LAYOUT_WIDE";
pptx.title = "Buslink 관리자 매뉴얼";
pptx.author = "동영관광";

const ADMIN_RATIO = 1440 / 900;

const LEFT_X = 0.5;
const LEFT_W = 6.0;
const SHOT_X = 6.8;
const SHOT_Y = 1.55;
const SHOT_W = 6.05;
const SHOT_H = 5.4;

function leftTitle(s, title, sub) {
  s.addText(title, {
    x: LEFT_X, y: 1.55, w: LEFT_W, h: 0.5,
    fontFace: T.fontBold, fontSize: 20, color: T.t1, bold: true,
  });
  if (sub) {
    s.addText(sub, {
      x: LEFT_X, y: 2.0, w: LEFT_W, h: 0.4,
      fontFace: T.font, fontSize: 12, color: T.t3,
    });
  }
}

const TOTAL = 14;

// 1. 표지
H.cover(pptx, {
  label: "BUSLINK · ADMIN",
  title: "관리자 매뉴얼",
  subtitle: "통근버스 관제 담당자를 위한 사용 안내",
  meta: "동영관광 · Buslink",
});

// 2. 시스템 소개
{
  const s = pptx.addSlide();
  H.header(s, "이 시스템이 뭐예요?", "통근버스 배차·운행·탑승을 한곳에서 관리");
  H.pointCards(s, [
    { icon: "🗺", color: "brand", title: "실시간 관제",
      body: "지도/노선도 뷰로 모든\n차량 위치를 한눈에" },
    { icon: "📅", color: "green", title: "배차·일정",
      body: "단일 배차 + 반복 패턴.\n매일 새벽 자동 펼침" },
    { icon: "📊", color: "orange", title: "통계·이력",
      body: "탑승 현황·운행 이력·\n정류장별 매핑" },
  ], { top: 1.7, height: 2.4 });
  H.calloutBox(s, {
    x: 0.5, y: 4.3, w: 12.3, h: 1.3, color: "brand", icon: "🌐",
    title: "접속 주소: buslink-prod.web.app",
    body: "PC Chrome 권장. 설치 불필요. 모바일에서도 동작하지만 12개 탭 사용성은 PC가 우월.",
  });
  H.calloutBox(s, {
    x: 0.5, y: 5.8, w: 12.3, h: 1.1, color: "grey", icon: "🔐",
    title: "Firebase Email/Password 로그인 (@dongyeongtour.co.kr)",
    body: "",
  });
  H.footer(s, 2, TOTAL);
}

// 3. 로그인
{
  const s = pptx.addSlide();
  H.header(s, "로그인", "회사 이메일과 비밀번호로 입장");
  leftTitle(s, "이렇게 생긴 화면이 떠요", "");
  H.numberedList(s, [
    { n: 1, title: "Buslink 로고", body: "상단 중앙. 로딩 완료 후 표시" },
    { n: 2, title: "이메일 입력", body: "@dongyeongtour.co.kr 회사 메일" },
    { n: 3, title: "비밀번호 입력 + 로그인", body: "관리자 권한 계정만 접속 가능" },
  ], { y: 2.5, rowH: 0.95 });
  H.calloutBox(s, {
    x: LEFT_X, y: 5.5, w: LEFT_W, h: 1.5, color: "red", icon: "⚠",
    title: "권한이 없으면 로그인 후 다른 화면으로 이동",
    body: "관리자/슈퍼관리자만 이 화면. 기사 계정은 자동으로 /driver, 직원 계정은 /p로 이동.",
  });
  H.shotOrPlaceholder(s, "admin", "01-login.png", {
    x: SHOT_X, y: SHOT_Y, w: SHOT_W, h: SHOT_H,
    imgRatio: ADMIN_RATIO,
    markers: [
      { rx: 0.50, ry: 0.30, n: 1 },
      { rx: 0.50, ry: 0.45, n: 2 },
      { rx: 0.50, ry: 0.55, n: 3 },
    ],
    caption: "관리자 로그인 화면",
  });
  H.footer(s, 3, TOTAL);
}

// 4. 화면 구성 (사이드바)
{
  const s = pptx.addSlide();
  H.header(s, "화면 구성", "왼쪽 사이드바에서 12개 메뉴 선택");
  leftTitle(s, "사이드바 영역", "");
  H.numberedList(s, [
    { n: 1, title: "Buslink 로고 + 관리자", body: "현재 로그인 정보" },
    { n: 2, title: "메뉴 12개", body: "대시보드·실시간 관제·배차·노선·기사·차량·시뮬레이터·운행 이력·탑승 통계·협력사·공지" },
    { n: 3, title: "활성 탭", body: "선택한 탭은 좌측 액센트 바 + 파란색" },
    { n: 4, title: "회사 ID + 로그아웃", body: "사이드바 하단" },
  ], { y: 2.5, rowH: 1.0 });
  H.shotOrPlaceholder(s, "admin", "02-sidebar.png", {
    x: SHOT_X, y: SHOT_Y, w: SHOT_W, h: SHOT_H,
    imgRatio: ADMIN_RATIO,
    markers: [
      { rx: 0.08, ry: 0.05, n: 1 },
      { rx: 0.08, ry: 0.35, n: 2 },
      { rx: 0.08, ry: 0.25, n: 3 },
      { rx: 0.08, ry: 0.95, n: 4 },
    ],
    caption: "사이드바 (PC)",
  });
  H.footer(s, 4, TOTAL);
}

// 5. 실시간 관제 — 지도/노선도 뷰
{
  const s = pptx.addSlide();
  H.header(s, "실시간 관제 — 지도 / 노선도 뷰", "📍 실시간 관제 탭. 운행 중 차량 위치 + 정류장 진행");
  leftTitle(s, "지도/노선도 두 뷰", "");
  H.numberedList(s, [
    { n: 1, title: "지도 뷰 / 노선도 뷰 토글", body: "상단 우측. 지도=카카오맵에 차량 핀, 노선도=정류장 타임라인" },
    { n: 2, title: "일자별 picker", body: "과거 데이터도 같은 화면에서 조회 (배너로 안내)" },
    { n: 3, title: "차량 마커 + 정류장 마커", body: "실시간 GPS로 자동 이동. 마커 클릭으로 정보 카드" },
    { n: 4, title: "노선 선택", body: "여러 노선 동시 표시 또는 한 노선 집중" },
  ], { y: 2.5, rowH: 0.95 });
  H.shotOrPlaceholder(s, "admin", "03-realtime.png", {
    x: SHOT_X, y: SHOT_Y, w: SHOT_W, h: SHOT_H,
    imgRatio: ADMIN_RATIO,
    markers: [
      { rx: 0.90, ry: 0.10, n: 1 },
      { rx: 0.50, ry: 0.10, n: 2 },
      { rx: 0.55, ry: 0.55, n: 3 },
      { rx: 0.20, ry: 0.30, n: 4 },
    ],
    caption: "실시간 관제 (지도 뷰)",
  });
  H.footer(s, 5, TOTAL);
}

// 6. 배차 관리 + 배차 일정
{
  const s = pptx.addSlide();
  H.header(s, "배차 관리 · 배차 일정", "단일 배차 + 반복 패턴 자동 펼침");
  leftTitle(s, "두 탭의 역할", "");
  H.numberedList(s, [
    { n: 1, title: "배차 관리 탭", body: "단일 일자의 배차 추가/수정. 노선·기사·차량·시각 선택" },
    { n: 2, title: "배차 일정 탭 (반복)", body: "요일 패턴 등록. CF가 매일 새벽 향후 7일치 자동 펼침" },
    { n: 3, title: "공휴일 제외 / 회사별 휴무", body: "한국 공휴일 또는 excludeDates로 특정 일자 제외" },
    { n: 4, title: "기존 일별 수정은 보존", body: "일정 변경해도 이미 펼친 미래 배차는 그대로" },
  ], { y: 2.5, rowH: 0.95 });
  H.calloutBox(s, {
    x: LEFT_X, y: 6.6, w: LEFT_W, h: 0.5, color: "yellow",
    title: "💡 일정 신규 등록 시 '지금 펼치기' 즉시 트리거 가능",
    body: "",
  });
  H.shotOrPlaceholder(s, "admin", "04-dispatch.png", {
    x: SHOT_X, y: SHOT_Y, w: SHOT_W, h: SHOT_H,
    imgRatio: ADMIN_RATIO,
    markers: [
      { rx: 0.20, ry: 0.10, n: 1 },
      { rx: 0.35, ry: 0.10, n: 2 },
      { rx: 0.50, ry: 0.30, n: 3 },
      { rx: 0.70, ry: 0.50, n: 4 },
    ],
    caption: "배차 일정 (반복 패턴)",
  });
  H.footer(s, 6, TOTAL);
}

// 7. 노선 관리 — 경로 그리기
{
  const s = pptx.addSlide();
  H.header(s, "노선 관리 — 경로 그리기 + 정류장", "🗺 노선 관리 탭");
  leftTitle(s, "노선 한 개에 필요한 것", "");
  H.numberedList(s, [
    { n: 1, title: "노선 기본 정보", body: "이름·코드·출근/퇴근·교대조·좌석수·출발시각·협력사" },
    { n: 2, title: "경로 그리기 (routePath)", body: "지도에서 클릭으로 폴리라인 작성. 승객앱 진행률 시각화·정밀 도착판정" },
    { n: 3, title: "정류장 추가/수정", body: "이름·주소·위도/경도·진입 분 오프셋·사진·승객 안내문" },
    { n: 4, title: "정류장 순서 (order)", body: "오름차순. 첫 정류장 진입 분은 0 (노선 출발시각과 동일)" },
  ], { y: 2.5, rowH: 0.95 });
  H.calloutBox(s, {
    x: LEFT_X, y: 6.6, w: LEFT_W, h: 0.5, color: "brand",
    title: "💡 routePath 안 그려도 동작 — stops 직선 폴백 자동",
    body: "",
  });
  H.shotOrPlaceholder(s, "admin", "05-routes.png", {
    x: SHOT_X, y: SHOT_Y, w: SHOT_W, h: SHOT_H,
    imgRatio: ADMIN_RATIO,
    markers: [
      { rx: 0.20, ry: 0.20, n: 1 },
      { rx: 0.55, ry: 0.40, n: 2 },
      { rx: 0.25, ry: 0.60, n: 3 },
      { rx: 0.10, ry: 0.55, n: 4 },
    ],
    caption: "노선 관리 + 경로 그리기",
  });
  H.footer(s, 7, TOTAL);
}

// 8. 기사 관리 + 차량 관리
{
  const s = pptx.addSlide();
  H.header(s, "기사 관리 · 차량 관리", "👤 / 🚌 두 탭");
  H.pointCards(s, [
    { icon: "👤", color: "brand", title: "기사 관리",
      body: "기사 추가/수정/삭제.\n사번 + PIN으로 기사앱 로그인 계정 자동 생성\n(`createDriver` Cloud Function)" },
    { icon: "🚌", color: "green", title: "차량 관리",
      body: "차량 번호·차종·좌석수.\n배차에서 차량 선택 시 사용" },
  ], { top: 1.7, height: 2.8 });
  H.calloutBox(s, {
    x: 0.5, y: 4.8, w: 12.3, h: 1.2, color: "red", icon: "⚠",
    title: "기사 삭제는 비활성 상태에서만 허용 (안전장치)",
    body: "활성 기사를 실수로 삭제 방지. 비활성으로 전환 후 삭제 가능. 직원수 confirm 거쳐 영구 삭제.",
  });
  H.calloutBox(s, {
    x: 0.5, y: 6.1, w: 12.3, h: 0.9, color: "grey", icon: "🔑",
    title: "PIN 변경은 ‘비밀번호 변경’ 버튼 → updateDriverPassword CF",
    body: "",
  });
  H.shotOrPlaceholder(s, "admin", "06-drivers.png", {
    x: 6.8, y: 1.5, w: 0, h: 0,  // 이 슬라이드는 카드 위주 — 캡처 영역 0
    imgRatio: ADMIN_RATIO,
    caption: "",
  });
  H.footer(s, 8, TOTAL);
}

// 9. 공지 발송
{
  const s = pptx.addSlide();
  H.header(s, "공지 발송", "📢 공지 발송 탭 — 전체 또는 협력사 단위");
  leftTitle(s, "발송 순서", "");
  H.numberedList(s, [
    { n: 1, title: "협력사 필터 선택", body: "전체 / 특정 협력사. 미선택=전체 발송" },
    { n: 2, title: "제목 + 본문 + 유형", body: "유형: 안내/긴급/지연 등. 길이 제한 짧음" },
    { n: 3, title: "📡 알림받을 직원 N명 표시", body: "발송 폼 위에 미리 표시. 0명이면 발송 의미 X" },
    { n: 4, title: "발송 → 결과 카드", body: "pending → 완료(성공 N건/실패 M건) / 0건 / 오류 실시간 표시" },
  ], { y: 2.5, rowH: 0.95 });
  H.calloutBox(s, {
    x: LEFT_X, y: 6.5, w: LEFT_W, h: 0.6, color: "yellow",
    title: "💡 0건 = 직원이 알림 권한 안 줬거나 OEM 절전",
    body: "",
  });
  H.shotOrPlaceholder(s, "admin", "07-notice.png", {
    x: SHOT_X, y: SHOT_Y, w: SHOT_W, h: SHOT_H,
    imgRatio: ADMIN_RATIO,
    markers: [
      { rx: 0.30, ry: 0.20, n: 1 },
      { rx: 0.30, ry: 0.35, n: 2 },
      { rx: 0.30, ry: 0.55, n: 3 },
      { rx: 0.30, ry: 0.75, n: 4 },
    ],
    caption: "공지 발송",
  });
  H.footer(s, 9, TOTAL);
}

// 10. 탑승 통계
{
  const s = pptx.addSlide();
  H.header(s, "탑승 통계 — 정류장별 GPS 매핑", "📊 탑승 통계 탭");
  leftTitle(s, "통계 구성", "");
  H.numberedList(s, [
    { n: 1, title: "일자별 탑승자 수", body: "관제 화면 상단 카운터. 노선별 분리" },
    { n: 2, title: "정류장별 매핑", body: "QR 스캔 시점 차량 GPS와 정류장 좌표 매칭 (반경 300m)" },
    { n: 3, title: "협력사별 분리", body: "협력사 코드별 탑승 패턴 — KT·삼성 등" },
    { n: 4, title: "미지정 / GPS 없음", body: "협력사 미설정 직원이나 GPS 미수신은 별도 표시" },
  ], { y: 2.5, rowH: 0.95 });
  H.shotOrPlaceholder(s, "admin", "08-stats.png", {
    x: SHOT_X, y: SHOT_Y, w: SHOT_W, h: SHOT_H,
    imgRatio: ADMIN_RATIO,
    markers: [
      { rx: 0.25, ry: 0.20, n: 1 },
      { rx: 0.55, ry: 0.45, n: 2 },
      { rx: 0.85, ry: 0.20, n: 3 },
      { rx: 0.55, ry: 0.75, n: 4 },
    ],
    caption: "탑승 통계 (정류장별)",
  });
  H.footer(s, 10, TOTAL);
}

// 11. 운행 이력
{
  const s = pptx.addSlide();
  H.header(s, "운행 이력 — 노선별 그룹 + GPS 시간범위", "🕐 운행 이력 탭");
  leftTitle(s, "조회 방법", "");
  H.numberedList(s, [
    { n: 1, title: "일자 + 노선 선택", body: "과거 배차 목록을 노선별로 그룹화 표시" },
    { n: 2, title: "배차 클릭", body: "그 배차의 GPS 자동 로드. 같은 차량 여러 배차 시 시간범위 필터 자동 적용" },
    { n: 3, title: "지도에 경로 표시", body: "실제 운행 궤적 + 정류장 도착 시각" },
    { n: 4, title: "GPS 시간범위 안내", body: "선택 배차의 출발~종료 시각만 표시 (다른 배차 GPS 혼입 차단)" },
  ], { y: 2.5, rowH: 0.95 });
  H.shotOrPlaceholder(s, "admin", "09-history.png", {
    x: SHOT_X, y: SHOT_Y, w: SHOT_W, h: SHOT_H,
    imgRatio: ADMIN_RATIO,
    markers: [
      { rx: 0.20, ry: 0.10, n: 1 },
      { rx: 0.20, ry: 0.35, n: 2 },
      { rx: 0.60, ry: 0.50, n: 3 },
      { rx: 0.60, ry: 0.15, n: 4 },
    ],
    caption: "운행 이력",
  });
  H.footer(s, 11, TOTAL);
}

// 12. 협력사 관리
{
  const s = pptx.addSlide();
  H.header(s, "협력사 관리", "🤝 협력사 관리 탭 — 코드 발급/삭제");
  leftTitle(s, "기능", "");
  H.numberedList(s, [
    { n: 1, title: "협력사 목록", body: "이름·코드·활성 상태·생성일·유효기간(1년)" },
    { n: 2, title: "+ 협력사 코드 발급", body: "새 협력사 추가 시 자동 코드 생성. PartnerApp(`/partner`) 진입용" },
    { n: 3, title: "비활성 전환 후 삭제", body: "활성 코드는 삭제 불가 — 비활성으로 먼저. 직원수 confirm 거쳐 영구 삭제" },
    { n: 4, title: "탑승 통계와 연동", body: "직원 passengers.partnerCode → boardings.partnerCode 자동 denormalize" },
  ], { y: 2.5, rowH: 0.95 });
  H.calloutBox(s, {
    x: LEFT_X, y: 6.5, w: LEFT_W, h: 0.55, color: "red",
    title: "⚠ 협력사 코드는 read 공개 (URL에 그대로 노출 — 매뉴얼·문서 직접 노출 금지)",
    body: "",
  });
  H.shotOrPlaceholder(s, "admin", "10-partner.png", {
    x: SHOT_X, y: SHOT_Y, w: SHOT_W, h: SHOT_H,
    imgRatio: ADMIN_RATIO,
    markers: [
      { rx: 0.50, ry: 0.40, n: 1 },
      { rx: 0.90, ry: 0.10, n: 2 },
      { rx: 0.90, ry: 0.45, n: 3 },
      { rx: 0.30, ry: 0.70, n: 4 },
    ],
    caption: "협력사 관리",
  });
  H.footer(s, 12, TOTAL);
}

// 13. 대시보드 + 시뮬레이터
{
  const s = pptx.addSlide();
  H.header(s, "대시보드 · 시뮬레이터", "운영 현황 한눈 + 개발 도구");
  H.pointCards(s, [
    { icon: "📈", color: "brand", title: "대시보드 (탭 1)",
      body: "오늘 운행 카운트·기사·차량·노선 등록 수.\n다른 탭으로 빠른 이동 링크." },
    { icon: "🎮", color: "yellow", title: "시뮬레이터 (탭 8)",
      body: "GPS 직접 송신.\n실제 차량 GPS 없이 지도/노선도 동작 확인.\n운영 데이터에 영향 X." },
  ], { top: 1.7, height: 2.8 });
  H.calloutBox(s, {
    x: 0.5, y: 4.8, w: 12.3, h: 1.3, color: "grey", icon: "💡",
    title: "시뮬레이터는 차량을 임의로 움직여 직원앱·승객앱 동작 점검할 때 유용",
    body: "실 운영 시간대에는 실 차량 GPS와 충돌 가능 — 테스트 차량 ID 별도 사용 권장.",
  });
  H.calloutBox(s, {
    x: 0.5, y: 6.2, w: 12.3, h: 0.9, color: "green", icon: "✅",
    title: "대시보드는 첫 로그인 화면 — 매일 아침 운영 상태 빠른 확인",
    body: "",
  });
  H.footer(s, 13, TOTAL);
}

// 14. FAQ + 문제 해결
{
  const s = pptx.addSlide();
  H.header(s, "자주 묻는 질문 · 문제 해결", "");
  H.pointCards(s, [
    { icon: "❓", color: "grey", title: "차량이 안 보여요",
      body: "1) 운행 시작했나?\n2) GPS 권한 허용?\n3) 차량 GPS가 5초 안 송신 시\n   '–'로 표시 (정상)" },
    { icon: "❓", color: "grey", title: "공지 0건 발송",
      body: "직원이 알림 권한 안 줬거나\nOEM 절전이 SW 잠재움.\n공지함 탭 = 도달 보장 통로." },
    { icon: "❓", color: "grey", title: "ETA가 들쭉날쭉",
      body: "터널/약전계로 GPS 노이즈.\nplan+delay 70% + GPS 30%로\n안정화하지만 한계는 있음." },
  ], { top: 1.7, height: 2.5 });
  H.pointCards(s, [
    { icon: "❓", color: "grey", title: "기사가 출발 못 함",
      body: "기사앱 권한 (GPS+알림)\n허용 안 됨일 가능성.\n기사앱 매뉴얼 참고." },
    { icon: "❓", color: "grey", title: "노선 변경",
      body: "노선 관리 탭에서 routePath\n다시 그리고 정류장 갱신.\n진행 중 운행에는 즉시 반영." },
    { icon: "❓", color: "grey", title: "기술 지원 연락",
      body: "도메인 관리자에게\n로그인 권한·계정 발급\n문의." },
  ], { top: 4.4, height: 2.5 });
  H.footer(s, 14, TOTAL);
}

const outPath = path.join(__dirname, "out", "Buslink_관리자매뉴얼.pptx");
const outDir = path.dirname(outPath);
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

pptx.writeFile({ fileName: outPath }).then((file) => {
  console.log("✅ 관리자 매뉴얼 생성 완료:", file);
}).catch((err) => {
  console.error("❌ 생성 실패:", err);
  process.exit(1);
});
