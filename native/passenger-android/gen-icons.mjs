// 런처·알림·스플래시 아이콘을 승객앱 아이콘 원본(public/icons/passenger.svg — iOS 앱과 같은 그림)으로 굽는다.
//   npm run icons   (sharp)
import sharp from 'sharp';
import fs from 'node:fs';

const RES = 'android/app/src/main/res';
const FULL = fs.readFileSync('../../public/icons/passenger.svg');
const BLUE = '#0066FF';
// B 글자(100×100 viewBox · passenger.svg 와 같은 획) — 배경 없이
const B = (stroke = '#FFFFFF', dot = '#FFC233', ring = BLUE) =>
  `<path d="M35 25 V75 H57 A13 12.5 0 0 0 57 50 H35 M35 50 H54 A12 12.5 0 0 0 54 25 H35" fill="none" stroke="${stroke}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>` +
  `<circle cx="35" cy="50" r="7.5" fill="${dot}" stroke="${ring}" stroke-width="3"/>`;
// 적응형 전경: 108dp 중 가운데 72dp 만 보인다 → 100 단위 그림을 가운데 66% 크기로
const FG = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="-27 -27 154 154">${B()}</svg>`);
const SQ = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="${BLUE}"/>${B()}</svg>`);
// 알림 작은 아이콘 — 안드로이드는 흰색 실루엣만 쓴다
const STAT = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 10 80 80">${B('#FFFFFF', '#FFFFFF', '#FFFFFF')}</svg>`);

const LAUNCHER = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const FOREGROUND = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
const STATUS = { mdpi: 24, hdpi: 36, xhdpi: 48, xxhdpi: 72, xxxhdpi: 96 };

for (const [d, size] of Object.entries(LAUNCHER)) {
  await sharp(FULL, { density: 1024 }).resize(size, size).png().toFile(`${RES}/mipmap-${d}/ic_launcher.png`);
  const circle = Buffer.from(`<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}"/></svg>`);
  const sq = await sharp(SQ, { density: 1024 }).resize(size, size).png().toBuffer();
  await sharp(sq).composite([{ input: circle, blend: 'dest-in' }]).png().toFile(`${RES}/mipmap-${d}/ic_launcher_round.png`);
}
for (const [d, size] of Object.entries(FOREGROUND)) {
  await sharp(FG, { density: 1024 }).resize(size, size).png().toFile(`${RES}/mipmap-${d}/ic_launcher_foreground.png`);
}
for (const [d, size] of Object.entries(STATUS)) {
  fs.mkdirSync(`${RES}/drawable-${d}`, { recursive: true });
  await sharp(STAT, { density: 1024 }).resize(size, size).png().toFile(`${RES}/drawable-${d}/ic_stat_notify.png`);
}
// 적응형 배경색
const bgXml = `${RES}/values/ic_launcher_background.xml`;
if (fs.existsSync(bgXml)) fs.writeFileSync(bgXml, `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${BLUE}</color>\n</resources>\n`);
// 스플래시 — 파란 바탕 가운데 아이콘
for (const dir of fs.readdirSync(RES).filter((n) => n.startsWith('drawable'))) {
  const p = `${RES}/${dir}/splash.png`;
  if (!fs.existsSync(p)) continue;
  const { width, height } = await sharp(p).metadata();
  const icon = Math.round(Math.min(width, height) * 0.28);
  const logo = await sharp(FULL, { density: 1024 }).resize(icon, icon).png().toBuffer();
  await sharp({ create: { width, height, channels: 4, background: BLUE } })
    .composite([{ input: logo, gravity: 'center' }]).png().toFile(p + '.tmp');
  fs.renameSync(p + '.tmp', p);
}
// 플레이 스토어 등록용 512 — 정사각(Play 가 모서리를 깎는다 · 둥근 원본을 쓰면 두 번 깎인다)
fs.mkdirSync('store', { recursive: true });
await sharp(SQ, { density: 1024 }).resize(512, 512).png().toFile('store/icon-512.png');
console.log('icons generated');
