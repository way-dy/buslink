// 관리자 매뉴얼 PPT (모노디자인) — "한 화면 = 한 슬라이드"
// 콘텐츠 정본 = docs/manual/ADMIN_GUIDE.md (그대로 옮김). 스크린샷 = assets/admin/*.png (재사용).
// 실행: node build-admin.js
const PptxGenJS = require("pptxgenjs");
const path = require("path");
const fs = require("fs");
const M = require("./mono");

const pptx = new PptxGenJS();
pptx.layout = "LAYOUT_WIDE";
pptx.title = "BusLink 관리자 매뉴얼";
pptx.author = "동영관광";

// 데스크톱 화면(1440x900) — 좌측 텍스트 약간 좁게, 우측 스크린샷 크게
const LEFT_X = 0.5, LEFT_W = 6.0;
const SHOT_X = 6.85, SHOT_Y = 1.7, SHOT_W = 5.98, SHOT_H = 4.9;

// 섹션 정의 — ADMIN_GUIDE.md 의 ## 1~12 그대로
const SECTIONS = [
  {
    title: "로그인", sub: "관제 시스템에 들어가는 첫 화면",
    img: "01-login.png", caption: "관리자 로그인 화면",
    blocks: [
      { type: "lead", text: "관제 시스템에 들어가는 첫 화면입니다. PC(데스크톱) 웹 브라우저, 추천은 크롬(Chrome)입니다." },
      { type: "steps", items: [
        { n: 1, text: "브라우저 주소창에 admin.buslink.co.kr 을 입력합니다." },
        { n: 2, text: "‘사번’ 칸에 관리자 계정(회사 이메일, @dongyeongtour.co.kr)을 입력합니다." },
        { n: 3, text: "‘비밀번호’를 입력하고 ‘로그인’ 버튼을 누릅니다." },
      ]},
      { type: "note", kind: "안내", text: "비밀번호를 잊었으면 시스템 담당자에게 재설정을 요청하세요." },
    ],
  },
  {
    title: "대시보드 — 오늘 운행을 한눈에", sub: "로그인하면 가장 먼저 보이는 화면",
    img: "02-sidebar.png", caption: "대시보드 화면",
    blocks: [
      { type: "lead", text: "오늘 운행 상황을 한눈에 확인합니다." },
      { type: "bullets", items: [
        "상단 카드: 오늘 배차 노선 / 운행중 차량 / 오늘 탑승 인원 / 전체 기사 숫자",
        "‘오늘 배차 현황’ — 출발 시각·노선·기사 목록",
        "‘기사 현황’ — 기사별 차량·운행 상태",
        "‘실시간 GPS 수신 차량’ — 현재 위치를 보내고 있는 차량",
        "오른쪽 위 ‘실시간 관제 →’ 버튼을 누르면 지도로 바로 이동",
      ]},
      { type: "note", kind: "안내", text: "왼쪽 메뉴(사이드바)에서 모든 기능으로 이동합니다. 아래 설명은 메뉴 순서대로입니다." },
    ],
  },
  {
    title: "실시간 관제 — 지도에서 버스 위치", sub: "운행 중인 버스가 지금 어디 있는지 실시간으로",
    img: "03-realtime.png", caption: "실시간 관제 화면",
    blocks: [
      { type: "steps", items: [
        { n: 1, text: "왼쪽 메뉴에서 ‘실시간 관제’를 누릅니다." },
        { n: 2, text: "지도 위 파란 표시가 현재 버스 위치입니다." },
        { n: 3, text: "화면 위쪽에서 지도 / 노선도 보기를 바꿀 수 있고, 날짜를 골라 지난 운행도 볼 수 있습니다." },
      ]},
    ],
  },
  {
    title: "배차 일정 — 반복 배차 자동 등록", sub: "한 번만 등록하면 매일 자동으로 만들어집니다",
    img: "04-dispatch.png", caption: "배차 일정 화면",
    blocks: [
      { type: "lead", text: "매일 같은 시간·요일에 반복되는 출퇴근 배차를 한 번만 등록해 두면 자동으로 매일 만들어집니다." },
      { type: "steps", items: [
        { n: 1, text: "왼쪽 메뉴에서 ‘배차 일정’을 누릅니다." },
        { n: 2, text: "오른쪽 위 ‘+ 일정 등록’으로 노선·기사·차량·출발 시각·요일·기간을 정합니다." },
        { n: 3, text: "매일 새벽에 향후 7일치 배차가 자동으로 펼쳐집니다. 지금 바로 반영하려면 ‘지금 펼치기’를 누릅니다." },
      ]},
      { type: "note", kind: "팁", text: "특정 날짜만 바꾸고 싶을 때는 ‘배차 관리’에서 그 날짜의 배차를 직접 수정합니다. 수정한 내용은 자동 펼침에 덮어쓰이지 않습니다." },
    ],
  },
  {
    title: "배차 관리 — 그날그날 배차 등록·수정", sub: "특정 날짜에 임시 배차 추가 / 기사·차량 변경",
    img: "11-dispatch-manage.png", caption: "배차 관리 화면",
    blocks: [
      { type: "lead", text: "특정 날짜에 임시로 배차를 추가하거나, 자동으로 만들어진 배차에서 기사·차량만 바꿀 때 사용합니다." },
      { type: "steps", items: [
        { n: 1, text: "왼쪽 메뉴에서 ‘배차 관리’를 누릅니다." },
        { n: 2, text: "날짜를 고른 뒤 노선·기사·차량·출발 시각을 지정해 배차를 등록합니다." },
      ]},
    ],
  },
  {
    title: "노선 관리 — 노선·정류장 등록", sub: "노선·정류장 등록 + 도착 예정 시각·경로 설정",
    img: "05-routes.png", caption: "노선 관리 화면",
    blocks: [
      { type: "steps", items: [
        { n: 1, text: "왼쪽 메뉴에서 ‘노선 관리’를 누릅니다." },
        { n: 2, text: "오른쪽 위 ‘+ 노선 추가’로 노선명·코드·출발 시각·좌석 수를 등록합니다." },
        { n: 3, text: "각 노선의 ‘정류장 관리’에서 정류장을 추가하고, 정류장마다 ‘진입 시각’(버스가 그 정류장에 도착하는 예정 시각)을 입력합니다." },
        { n: 4, text: "‘경로 그리기’로 버스가 실제 다니는 길을 지도에 그려 두면 도착 예측이 더 정확해집니다." },
      ]},
      { type: "note", kind: "중요", text: "정류장 진입 시각을 꼭 입력하세요. 입력해 두면 직원·기사 앱에 ‘계획 대비 몇 분 지연’ 안내가 정확히 표시됩니다. 비워 두면 지연 안내가 제한됩니다." },
    ],
  },
  {
    title: "기사 관리 — 기사 계정 만들기", sub: "기사가 기사용 앱에 로그인할 계정(사번·PIN)",
    img: "06-drivers.png", caption: "기사 관리 화면",
    blocks: [
      { type: "steps", items: [
        { n: 1, text: "왼쪽 메뉴에서 ‘기사 관리’를 누릅니다." },
        { n: 2, text: "오른쪽 위 ‘+ 기사 등록’으로 사번·이름·연락처·차량을 입력해 계정을 만듭니다." },
        { n: 3, text: "비밀번호를 바꾸려면 해당 기사 줄의 ‘수정’을 누릅니다." },
      ]},
    ],
  },
  {
    title: "차량 관리 — 차량 등록", sub: "운행에 쓰는 차량을 등록",
    img: "12-vehicles.png", caption: "차량 관리 화면",
    blocks: [
      { type: "steps", items: [
        { n: 1, text: "왼쪽 메뉴에서 ‘차량 관리’를 누릅니다." },
        { n: 2, text: "차량 번호 등 정보를 입력해 차량을 등록합니다. 등록한 차량은 배차할 때 선택할 수 있습니다." },
      ]},
    ],
  },
  {
    title: "운행 이력 — 지난 운행 다시 보기", sub: "지난 운행의 GPS 경로·정류장 통과 기록",
    img: "09-history.png", caption: "운행 이력 화면",
    blocks: [
      { type: "steps", items: [
        { n: 1, text: "왼쪽 메뉴에서 ‘운행 이력’을 누릅니다." },
        { n: 2, text: "왼쪽 목록에서 운행(배차)을 고르면 지도에 그날의 이동 경로가 표시됩니다." },
        { n: 3, text: "정류장 100m 반경 원으로 어느 정류장을 통과했는지 한눈에 볼 수 있습니다." },
      ]},
    ],
  },
  {
    title: "탑승 통계 — QR 탑승 집계", sub: "직원이 QR로 탑승한 기록을 집계",
    img: "08-stats.png", caption: "탑승 통계 화면",
    blocks: [
      { type: "lead", text: "직원이 QR로 탑승한 기록을 날짜별·정류장별·협력사별로 집계해 봅니다." },
      { type: "steps", items: [
        { n: 1, text: "왼쪽 메뉴에서 ‘탑승 통계’를 누릅니다." },
        { n: 2, text: "오른쪽 위에서 날짜와 협력사를 선택합니다." },
        { n: 3, text: "총 탑승·고유 직원·노선별·차량별·시간대별 분포와 상세 기록을 확인합니다." },
      ]},
    ],
  },
  {
    title: "협력사 관리 — 업체코드 발급", sub: "협력사 직원이 사용할 업체코드를 발급",
    img: "10-partner.png", caption: "협력사 관리 화면",
    blocks: [
      { type: "lead", text: "협력사(자회사·고객사) 직원이 사용할 업체코드를 발급합니다. 코드는 발급일로부터 1년간 유효합니다." },
      { type: "steps", items: [
        { n: 1, text: "왼쪽 메뉴에서 ‘협력사 관리’를 누릅니다." },
        { n: 2, text: "오른쪽 위 ‘+ 업체코드 발급’으로 새 코드를 만듭니다." },
        { n: 3, text: "코드 옆 ‘복사’로 코드를 복사해 협력사 담당자에게 전달합니다." },
      ]},
    ],
  },
  {
    title: "공지 발송 — 직원에게 알림 보내기", sub: "전체 또는 특정 협력사 직원에게 공지(푸시 알림)",
    img: "07-notice.png", caption: "공지 발송 화면",
    blocks: [
      { type: "steps", items: [
        { n: 1, text: "왼쪽 메뉴에서 ‘공지 발송’을 누릅니다." },
        { n: 2, text: "일반 공지 / 긴급 공지 중 종류를 고릅니다." },
        { n: 3, text: "발송 대상 협력사를 선택합니다(전체 또는 특정 협력사)." },
        { n: 4, text: "제목과 내용을 입력하고 ‘📢 공지 발송’을 누릅니다." },
        { n: 5, text: "발송 직후 결과(받은 사람 수·성공/실패)가 표시되고, 아래 ‘발송 이력’에 쌓입니다." },
      ]},
      { type: "note", kind: "주의", text: "‘알림 수신 가능 직원 분포’에서 ‘0건(수신자 없음)’이면 그 대상에는 알림이 도착하지 않습니다. 해당 직원이 앱에서 알림을 허용했는지 확인하세요." },
    ],
  },
];

const TOTAL = SECTIONS.length + 2; // 표지 + 섹션들 + 참고

// 표지
M.cover(pptx, {
  label: "BUSLINK · 관리자(관제)",
  title: "관리자 매뉴얼",
  subtitle: "통근버스 관제 시스템 사용 안내 (PC 웹 브라우저)",
  meta: "동영관광 · BusLink",
});

// 섹션 슬라이드
SECTIONS.forEach((sec, i) => {
  const s = pptx.addSlide();
  const idx = i + 2; // 표지가 1
  M.header(s, idx, TOTAL, `${i + 1}. ${sec.title}`, sec.sub);
  M.leftBody(s, sec.blocks, { x: LEFT_X, w: LEFT_W, y: 1.75 });
  M.shot(s, "admin", sec.img, { x: SHOT_X, y: SHOT_Y, w: SHOT_W, h: SHOT_H, caption: sec.caption });
});

// 참고 슬라이드 (슈퍼관리자 전용 화면 안내)
{
  const s = pptx.addSlide();
  M.header(s, TOTAL, TOTAL, "참고 · 슈퍼관리자 전용 화면", "");
  M.leftBody(s, [
    { type: "lead", text: "회사 자체를 만들고 관리하는 ‘회사 관리’ 메뉴는 슈퍼관리자 계정에서만 보입니다." },
    { type: "lead", text: "일반 관리자에게는 표시되지 않으므로 본 매뉴얼에서는 생략합니다. 필요 시 시스템 담당자에게 문의하세요." },
  ], { x: LEFT_X, w: 11.5, y: 2.0 });
}

const outPath = path.join(__dirname, "out", "BusLink_관리자매뉴얼.pptx");
if (!fs.existsSync(path.dirname(outPath))) fs.mkdirSync(path.dirname(outPath), { recursive: true });
pptx.writeFile({ fileName: outPath }).then((f) => {
  console.log("✅ 관리자 매뉴얼 생성:", f, `(${TOTAL} 슬라이드)`);
}).catch((e) => { console.error("❌", e); process.exit(1); });
