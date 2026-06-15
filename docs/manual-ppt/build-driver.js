// 기사 매뉴얼 PPT (모노디자인) — "한 화면 = 한 슬라이드"
// 콘텐츠 정본 = docs/manual/DRIVER_GUIDE.md (그대로 옮김). 스크린샷 = assets/driver/*.png (재사용).
// 운행 중에만 나타나는 화면(운행 중/QR 발급/운행 종료)은 placeholder 슬라이드.
// 실행: node build-driver.js
const PptxGenJS = require("pptxgenjs");
const path = require("path");
const fs = require("fs");
const M = require("./mono");

const pptx = new PptxGenJS();
pptx.layout = "LAYOUT_WIDE";
pptx.title = "BusLink 기사 매뉴얼";
pptx.author = "동영관광";

// 모바일 화면(1170x1992, 세로) — 우측에 세로로. 텍스트 영역 넓게.
const LEFT_X = 0.5, LEFT_W = 8.5;
const SHOT_X = 9.35, SHOT_Y = 1.7, SHOT_W = 3.45, SHOT_H = 5.2;
// 이미지 없는(또는 placeholder) 섹션은 텍스트 폭을 넓게
const FULL_W = 9.0;

// 섹션 정의 — DRIVER_GUIDE.md 의 ## 1~7 그대로
const SECTIONS = [
  {
    title: "로그인 / 앱 설치", sub: "휴대폰에서 사용합니다",
    img: "01-login.png", caption: "기사 로그인 화면",
    blocks: [
      { type: "lead", text: "하루 사용 흐름은 간단합니다: 로그인 → 운행 시작 → (자동 도착 감지) → 운행 종료." },
      { type: "steps", items: [
        { n: 1, text: "휴대폰 브라우저(크롬·사파리)에서 d.buslink.co.kr 에 접속합니다." },
        { n: 2, text: "‘사번’과 ‘PIN(비밀번호)’을 입력하고 ‘로그인’을 누릅니다." },
        { n: 3, text: "매번 주소를 입력하지 않도록 ‘홈 화면에 추가’해 두세요." },
      ]},
      { type: "bullets", items: [
        "안드로이드: 브라우저 메뉴(⋮) → ‘앱 설치’ 또는 ‘홈 화면에 추가’",
        "아이폰: 사파리 아래 ‘공유’ 버튼 → ‘홈 화면에 추가’",
      ]},
    ],
  },
  {
    title: "홈 — 오늘 내 배차 확인", sub: "로그인하면 오늘 내게 배정된 운행이 보입니다",
    img: "02-home.png", caption: "기사 홈 화면",
    blocks: [
      { type: "bullets", items: [
        "가운데 파란 카드에 ‘오늘 배차’ 노선·차량·출발 시각이 표시됩니다.",
        "배차가 2건 이상이면 ‘배차 변경’으로 다른 운행을 고릅니다.",
      ]},
      { type: "note", kind: "주의", text: "화면 위에 빨간 ‘알림(차단됨) 권한 필요’ 안내가 보이면 ‘설정 방법’을 눌러 위치·알림을 허용하세요. 허용하지 않으면 도착 감지와 실시간 위치가 동작하지 않습니다." },
    ],
  },
  {
    title: "운행 시작", sub: "출발할 때 버튼 하나만 누르면 됩니다", full: true,
    blocks: [
      { type: "steps", items: [
        { n: 1, text: "홈 화면 가운데 ‘▶ 운행 시작’ 버튼을 누릅니다." },
        { n: 2, text: "처음 누를 때 휴대폰이 ‘위치(GPS) 사용 권한’을 물어보면 ‘허용’을 누릅니다." },
        { n: 3, text: "운행이 시작되면 버스 위치가 직원·관제 화면에 실시간으로 전송됩니다." },
      ]},
      { type: "note", kind: "팁", text: "버튼이 ‘노선 불러오는 중…’으로 잠깐 비활성일 수 있습니다. 잠시 기다리면 ‘▶ 운행 시작’으로 바뀝니다. 바뀐 뒤 누르세요." },
    ],
  },
  {
    title: "운행 중 — 정류장 자동 진행", sub: "운행을 시작하면 ‘오늘 운행 정류장’ 목록이 나타납니다",
    placeholder: "운행 중 화면 — 정류장 자동 진행·도착 시각·지연 표시는 실제 운행 시간대에만 나타납니다. 운행 중 본인 휴대폰에서 캡처해 넣어 주세요.",
    blocks: [
      { type: "bullets", items: [
        "버스가 정류장에 가까워지면 ‘자동으로 도착이 감지’되어 다음 정류장으로 넘어갑니다.",
        "각 정류장에 ‘도착 시각’과 ‘계획 대비 지연(예: 지연 3분)’이 표시됩니다.",
        "운행 중에는 화면을 계속 켜 두어도 됩니다(운전 중에는 보지 마세요).",
      ]},
    ],
  },
  {
    title: "탑승 QR 발급", sub: "직원이 버스에 탈 때 QR 코드로 탑승을 기록",
    placeholder: "탑승 QR 화면 — 운행 중 QR 발급 화면을 캡처해 넣어 주세요.",
    blocks: [
      { type: "steps", items: [
        { n: 1, text: "화면 위쪽 ‘탑승 QR’을 누르면 QR 코드가 나타납니다." },
        { n: 2, text: "직원이 자기 휴대폰 카메라로 이 QR을 찍으면 탑승이 기록됩니다." },
        { n: 3, text: "QR은 ‘5분이 지나면 만료’되므로, 필요할 때 다시 발급하면 됩니다." },
      ]},
    ],
  },
  {
    title: "운행 종료", sub: "도착지에 도착하면 운행을 끝냅니다",
    placeholder: "운행 종료 버튼 화면 — 운행 중에만 나타나므로 운행 중 캡처해 넣어 주세요.",
    blocks: [
      { type: "steps", items: [
        { n: 1, text: "화면의 ‘운행 종료’ 버튼을 누릅니다." },
        { n: 2, text: "운행이 끝나면 위치 전송이 멈춥니다." },
      ]},
    ],
  },
  {
    title: "배터리 절전 예외 설정 (중요)", sub: "절전이 앱을 잠재우면 위치·알림이 끊길 수 있습니다", full: true,
    blocks: [
      { type: "lead", text: "휴대폰 ‘절전 기능’이 앱을 잠재우면 운행 중인데도 위치가 끊기거나 알림이 늦게 올 수 있습니다. 아래대로 ‘절전 예외’로 등록해 주세요." },
      { type: "bullets", items: [
        "삼성 갤럭시: 설정 → 배터리 → 백그라운드 사용 제한(앱 절전 관리) → BusLink 제외",
        "그 외 안드로이드: 설정 → 배터리/앱 → BusLink → 절전·백그라운드 제한 해제",
      ]},
      { type: "note", kind: "안내", text: "기종·버전마다 메뉴 이름이 조금씩 다를 수 있습니다. ‘배터리 / 절전 / 백그라운드’ 비슷한 항목을 찾아 BusLink를 예외로 두면 됩니다. (아이폰은 별도 설정이 필요 없습니다.)" },
    ],
  },
];

const TOTAL = SECTIONS.length + 1; // 표지 + 섹션들

M.cover(pptx, {
  label: "BUSLINK · 기사",
  title: "기사 매뉴얼",
  subtitle: "기사용 앱 사용 안내 (휴대폰)",
  meta: "동영관광 · BusLink",
});

SECTIONS.forEach((sec, i) => {
  const s = pptx.addSlide();
  const idx = i + 2;
  M.header(s, idx, TOTAL, `${i + 1}. ${sec.title}`, sec.sub);

  if (sec.placeholder) {
    // 좌측 본문 + 우측 placeholder 점선 박스
    M.leftBody(s, sec.blocks, { x: LEFT_X, w: LEFT_W, y: 1.75 });
    M.placeholderBox(s, { x: SHOT_X, y: SHOT_Y, w: SHOT_W, h: SHOT_H, note: sec.placeholder });
  } else if (sec.img) {
    M.leftBody(s, sec.blocks, { x: LEFT_X, w: LEFT_W, y: 1.75 });
    M.shot(s, "driver", sec.img, { x: SHOT_X, y: SHOT_Y, w: SHOT_W, h: SHOT_H, caption: sec.caption });
  } else {
    // 이미지 없는 섹션 — 텍스트 폭 넓게
    M.leftBody(s, sec.blocks, { x: LEFT_X, w: FULL_W, y: 1.85 });
  }
});

const outPath = path.join(__dirname, "out", "BusLink_기사매뉴얼.pptx");
if (!fs.existsSync(path.dirname(outPath))) fs.mkdirSync(path.dirname(outPath), { recursive: true });
pptx.writeFile({ fileName: outPath }).then((f) => {
  console.log("✅ 기사 매뉴얼 생성:", f, `(${TOTAL} 슬라이드)`);
}).catch((e) => { console.error("❌", e); process.exit(1); });
