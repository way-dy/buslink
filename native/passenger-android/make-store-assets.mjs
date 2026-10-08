import sharp from 'sharp';
import fs from 'node:fs';
const ROOT = 'D:/dev-claude-config/app/buslink';
const OUT = `${ROOT}/native/passenger-android/store`;
fs.mkdirSync(OUT, { recursive: true });
// 폰 스크린샷: iOS 6.3"(1206×2622 = 2.17:1) → Play 상한 2:1 → 위(상태바 쪽)를 남기고 아래를 잘라 1206×2412
const SRC = `${ROOT}/docs/store/screenshots-6.3`;
for (const f of fs.readdirSync(SRC).filter(n => n.endsWith('.png') && !n.startsWith('1_'))) {
  const m = await sharp(`${SRC}/${f}`).metadata();
  const h = Math.min(m.height, m.width * 2);
  await sharp(`${SRC}/${f}`).extract({ left: 0, top: 0, width: m.width, height: h }).png().toFile(`${OUT}/phone-${f}`);
  console.log(f, m.width, m.height, '→', m.width, h);
}
// 그래픽 이미지 1024×500 — 파란 바탕 + 아이콘 + 이름
const icon = await sharp(`${ROOT}/public/icons/passenger.svg`, { density: 1024 }).resize(260, 260).png().toBuffer();
const text = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="500">
  <text x="380" y="235" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="76" font-weight="700" fill="#FFFFFF">BusLink 탑승</text>
  <text x="383" y="305" font-family="Malgun Gothic, Apple SD Gothic Neo, sans-serif" font-size="34" fill="#DCE8FF">통근버스 실시간 위치 · QR 탑승</text></svg>`);
await sharp({ create: { width: 1024, height: 500, channels: 3, background: '#0066FF' } })
  .composite([{ input: icon, left: 90, top: 120 }, { input: text, left: 0, top: 0 }]).png().toFile(`${OUT}/feature-1024x500.png`);
console.log('ok');
