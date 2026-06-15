// 직원(승객앱) 매뉴얼 PPT (모노디자인) — "한 화면 = 한 슬라이드"
// 콘텐츠 정본 = docs/manual/EMPLOYEE_GUIDE.md (그대로 옮김). 스크린샷 = assets/employee/*.png (재사용).
// 실행: node build-employee.js
const PptxGenJS = require("pptxgenjs");
const path = require("path");
const fs = require("fs");
const M = require("./mono");

const pptx = new PptxGenJS();
pptx.layout = "LAYOUT_WIDE";
pptx.title = "BusLink 승객앱 매뉴얼";
pptx.author = "동영관광";

// 모바일 화면(1170x1992, 세로)
const LEFT_X = 0.5, LEFT_W = 8.5;
const SHOT_X = 9.35, SHOT_Y = 1.7, SHOT_W = 3.45, SHOT_H = 5.2;
const FULL_W = 9.0;

// 슬라이드 정의 — EMPLOYEE_GUIDE.md 의 ## 1~6.
// §1(로그인/앱설치)은 그림이 둘(로그인·설치)이라 2장으로 깔끔히 분할.
const SLIDES = [
  {
    title: "로그인", sub: "휴대폰에서 사용합니다",
    img: "01-login.png", caption: "직원 로그인 화면",
    blocks: [
      { type: "lead", text: "내 버스가 언제 오는지 확인하고, 탑승을 기록하고, 공지를 받는 앱입니다." },
      { type: "steps", items: [
        { n: 1, text: "휴대폰 브라우저에서 p.buslink.co.kr 에 접속합니다." },
        { n: 2, text: "‘사번’과 ‘PIN’을 입력하고 ‘로그인’을 누릅니다." },
        { n: 3, text: "한 번 로그인하면 다음부터 자동으로 로그인 상태가 유지됩니다." },
      ]},
      { type: "note", kind: "중요", text: "첫 로그인 PIN은 000000(0 여섯 개)입니다. 처음 로그인하면 PIN을 꼭 변경해 주세요." },
    ],
  },
  {
    title: "앱 설치 (홈 화면에 추가)", sub: "매번 주소를 입력하지 않도록 설치를 권장",
    img: "02-install-android.png", caption: "앱 설치 안내",
    blocks: [
      { type: "lead", text: "한 번 설치해 두면 홈 화면 아이콘으로 바로 실행할 수 있고, 알림도 더 잘 도착합니다." },
      { type: "bullets", items: [
        "아이폰: 사파리 아래 ‘공유’ 버튼 → ‘홈 화면에 추가’",
        "안드로이드: 브라우저 메뉴(⋮) → ‘앱 설치’ 또는 ‘홈 화면에 추가’",
      ]},
    ],
  },
  {
    title: "홈 — 내 버스 위치와 도착 시각", sub: "로그인하면 보이는 첫 화면",
    img: "05-mystop.png", caption: "직원 홈 화면",
    blocks: [
      { type: "lead", text: "‘내 정류장에 버스가 언제 오는지’와 ‘지도 위 버스 위치’를 보여줍니다." },
      { type: "bullets", items: [
        "화면 위에 내 이름·부서와 현재 노선이 표시됩니다.",
        "지도에서 버스가 실시간으로 움직이고, 정류장별 ‘예상 도착 시각’이 표시됩니다.",
        "노선을 바꾸려면 오른쪽 위 ‘노선 변경’을 누릅니다.",
      ]},
      { type: "note", kind: "안내", text: "화면 맨 위 파란 띠는 새로 온 ‘공지’입니다. 내용을 확인하면 닫힙니다." },
    ],
  },
  {
    title: "내 정류장 설정 — 도착 임박 알림", sub: "버스가 가까워질 때 알림을 받습니다", full: true,
    blocks: [
      { type: "lead", text: "내가 타는 정류장을 정해 두면, 버스가 가까워질 때 ‘도착 임박 알림’을 받습니다." },
      { type: "steps", items: [
        { n: 1, text: "홈 화면 아래 노선도에서 안내 문구 ‘아래 노선도에서 내 정류장을 클릭하세요’를 따라 내가 타는 정류장을 누릅니다." },
        { n: 2, text: "정류장이 선택되면, 버스가 1~2 정거장 전에 오면 휴대폰으로 알림이 옵니다." },
      ]},
      { type: "note", kind: "안내", text: "알림을 받으려면 앱에서 ‘알림을 허용’해야 합니다. 알림이 안 오면 ‘설정’의 알림 진단을 확인하세요." },
    ],
  },
  {
    title: "탑승 — QR로 탑승 기록", sub: "버스에 탈 때 QR로 탑승을 기록",
    img: "07-scan.png", caption: "탑승 QR 화면",
    blocks: [
      { type: "lead", text: "노선에 따라 두 방식 중 하나입니다." },
      { type: "bullets", items: [
        "내 QR을 보여주는 방식: 아래 메뉴 ‘탑승’을 누르면 내 탑승 QR이 나타납니다. 이 QR을 기사님께 보여주면 기록됩니다(2분마다 자동 갱신).",
        "기사님 QR을 찍는 방식: 카메라가 켜지면 기사님 휴대폰의 ‘탑승 QR’을 화면 안에 비춥니다. 인식되면 ‘탑승 완료’로 기록됩니다(처음 사용 시 카메라 권한 허용).",
      ]},
    ],
  },
  {
    title: "공지 — 안내 확인하기", sub: "회사·협력사에서 보낸 운행 관련 공지",
    img: "06-notices.png", caption: "공지 화면",
    blocks: [
      { type: "steps", items: [
        { n: 1, text: "아래 메뉴에서 ‘공지’를 누릅니다." },
        { n: 2, text: "공지 목록에서 제목을 눌러 내용을 확인합니다." },
        { n: 3, text: "안 읽은 공지가 있으면 메뉴에 ‘빨간 숫자 배지’가 표시됩니다." },
      ]},
      { type: "note", kind: "안내", text: "긴급 공지는 앱을 열 때 전체 화면으로 떠서 반드시 확인하게 됩니다. ‘확인했습니다’를 누르면 닫힙니다." },
    ],
  },
  {
    title: "설정 — 내 정보와 알림 진단", sub: "내 정보 확인, PIN 변경, 알림 점검, 앱 설치",
    img: "08-settings.png", caption: "직원 설정 화면",
    blocks: [
      { type: "steps", items: [
        { n: 1, text: "아래 메뉴에서 ‘설정’을 누릅니다." },
        { n: 2, text: "‘내 정보’에서 이름·사번·부서·배정 노선을 확인합니다." },
        { n: 3, text: "공지 알림이 안 오면 ‘알림 진단’의 ‘🔄 알림 재발급’을 누릅니다." },
        { n: 4, text: "권한 상태가 ‘거부됨’이면, 브라우저 주소창의 자물쇠 아이콘 → 알림 → ‘허용’으로 바꾼 뒤 다시 시도합니다." },
      ]},
      { type: "note", kind: "팁", text: "배터리 절전 예외 — 절전 기능이 앱을 잠재우면 공지 알림이 늦게 올 수 있습니다. 삼성 갤럭시는 설정 → 배터리 → 백그라운드 사용 제한에서 BusLink를 제외해 주세요. (아이폰은 별도 설정이 필요 없습니다.)" },
    ],
  },
];

const TOTAL = SLIDES.length + 1; // 표지 + 슬라이드들

M.cover(pptx, {
  label: "BUSLINK · 직원(승객)",
  title: "승객앱 매뉴얼",
  subtitle: "통근버스를 이용하는 직원을 위한 안내 (휴대폰)",
  meta: "동영관광 · BusLink",
});

SLIDES.forEach((sec, i) => {
  const s = pptx.addSlide();
  const idx = i + 2;
  M.header(s, idx, TOTAL, `${i + 1}. ${sec.title}`, sec.sub);
  if (sec.img) {
    M.leftBody(s, sec.blocks, { x: LEFT_X, w: LEFT_W, y: 1.75 });
    M.shot(s, "employee", sec.img, { x: SHOT_X, y: SHOT_Y, w: SHOT_W, h: SHOT_H, caption: sec.caption });
  } else {
    M.leftBody(s, sec.blocks, { x: LEFT_X, w: FULL_W, y: 1.85 });
  }
});

const outPath = path.join(__dirname, "out", "BusLink_승객앱매뉴얼.pptx");
if (!fs.existsSync(path.dirname(outPath))) fs.mkdirSync(path.dirname(outPath), { recursive: true });
pptx.writeFile({ fileName: outPath }).then((f) => {
  console.log("✅ 승객앱 매뉴얼 생성:", f, `(${TOTAL} 슬라이드)`);
}).catch((e) => { console.error("❌", e); process.exit(1); });
