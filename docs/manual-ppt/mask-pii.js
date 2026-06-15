// PII 마스킹 — 캡처 PNG의 개인정보(실명·사번·연락처·차량번호·협력사명/코드)를 검은 박스로 가림.
// Playwright/Chromium 만 사용. 이미지를 **base64 data URI** 로 임베드(file:// 로드 실패 회피) 후
// 정규화 좌표로 오버레이 div 를 그려 재스크린샷.
//
// 2단계(원본 보호):
//   node mask-pii.js           → assets/_verify/<role>__<name>.png 로만 출력(원본 미변경). 검증용.
//   node mask-pii.js --commit  → _verify 결과를 원본 위치로 복사(검증 후 확정).
// 가드: 이미지가 로드 안 되면(naturalWidth=0) 그 파일은 건너뜀(빈 이미지 덮어쓰기 방지).
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const ASSETS = path.join(__dirname, "assets");
const VERIFY = path.join(ASSETS, "_verify");
const COMMIT = process.argv.includes("--commit");

// [x1, y1, x2, y2] — 0~1 정규화 (이미지 좌상단 기준)
const MASKS = {
  "admin/02-sidebar.png": [
    [0.455, 0.344, 0.566, 0.494], // 오늘 배차 현황 — 기사 열
    [0.590, 0.342, 0.799, 0.417], // 기사 현황 — 이름·차량
    [0.198, 0.567, 0.361, 0.603], // 실시간 GPS 카드 — 차량번호·기사
  ],
  "admin/03-realtime.png": [[0.158, 0.045, 0.245, 0.115]], // 지도 좌상단 차량 패널
  "admin/04-dispatch.png": [
    [0.249, 0.111, 0.297, 0.239], // 협력사 칩
    [0.420, 0.111, 0.566, 0.239], // 기사·차량
  ],
  "admin/05-routes.png": [[0.231, 0.176, 0.319, 0.628]], // 거래처(고객사명) 열
  "admin/06-drivers.png": [[0.172, 0.111, 0.736, 0.191]], // 사번·이름·차량번호·연락처
  "admin/07-notice.png": [[0.299, 0.113, 0.858, 0.140]], // 상단 협력사명 칩
  "admin/09-history.png": [[0.163, 0.106, 0.292, 0.289]], // 좌측 운행 목록(기사명)
  "admin/10-partner.png": [[0.174, 0.107, 0.528, 0.347]], // 업체명 + 업체코드
  "admin/11-dispatch-manage.png": [
    [0.281, 0.114, 0.330, 0.294], // 협력사 칩
    [0.583, 0.114, 0.788, 0.294], // 차량번호·기사
  ],
  "admin/12-vehicles.png": [[0.290, 0.109, 0.403, 0.242]], // 차량번호(번호판)
  "employee/05-mystop.png": [[0.02, 0.245, 0.62, 0.30]], // 이름·부서
  "employee/07-scan.png": [[0.18, 0.165, 0.82, 0.225]], // 이름(전화번호) 헤더
  "employee/08-settings.png": [[0.55, 0.245, 0.96, 0.345]], // 내 정보 — 이름·사번
};

function dim(f) {
  const b = fs.readFileSync(f);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

(async () => {
  fs.mkdirSync(VERIFY, { recursive: true });

  if (COMMIT) {
    let n = 0;
    for (const rel of Object.keys(MASKS)) {
      const vf = path.join(VERIFY, rel.replace("/", "__"));
      const dst = path.join(ASSETS, rel);
      if (fs.existsSync(vf)) { fs.copyFileSync(vf, dst); console.log(`→ 확정 ${rel}`); n++; }
      else console.log(`⚠ 검증본 없음(건너뜀): ${rel}`);
    }
    console.log(`\n=== ${n}개 원본에 확정 반영 ===`);
    return;
  }

  const browser = await chromium.launch({ headless: true });
  let ok = 0, skip = 0;
  try {
    for (const [rel, boxes] of Object.entries(MASKS)) {
      const file = path.join(ASSETS, rel);
      if (!fs.existsSync(file)) { console.log(`⚠ 없음: ${rel}`); skip++; continue; }
      const [w, h] = dim(file);
      const b64 = fs.readFileSync(file).toString("base64");
      const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
      const overlays = boxes.map(([x1, y1, x2, y2]) =>
        `<div style="position:absolute;left:${x1 * w}px;top:${y1 * h}px;width:${(x2 - x1) * w}px;height:${(y2 - y1) * h}px;background:#111827;border-radius:4px"></div>`
      ).join("");
      await page.setContent(
        `<!doctype html><html><body style="margin:0;padding:0">` +
        `<img id="t" src="data:image/png;base64,${b64}" style="display:block;width:${w}px;height:${h}px">` +
        overlays + `</body></html>`,
        { waitUntil: "load" }
      );
      // 가드: 이미지 실제 로드 확인
      const loaded = await page.evaluate(() => {
        const i = document.getElementById("t");
        return !!(i && i.complete && i.naturalWidth > 0);
      });
      if (!loaded) { console.log(`❌ 이미지 로드 실패(건너뜀): ${rel}`); await page.close(); skip++; continue; }
      const out = path.join(VERIFY, rel.replace("/", "__"));
      await page.screenshot({ path: out, clip: { x: 0, y: 0, width: w, height: h } });
      await page.close();
      console.log(`✅ ${rel}  (${boxes.length}박스, ${w}x${h}) → _verify/${path.basename(out)}`);
      ok++;
    }
  } finally {
    await browser.close();
  }
  console.log(`\n=== 검증본 ${ok}개 생성 / ${skip}개 건너뜀 (원본 미변경) ===`);
  console.log("→ 검증 후 'node mask-pii.js --commit' 로 원본 반영");
})();
