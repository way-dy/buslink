// 격리 테스트 — 단말(유비칸) 차량 속도 계산(functions/index.js deviceSpeedKmh).
//   node scripts/test_device_speed.cjs
//
// 2026-10-08 배시현 `IZfJlQRn` «유비칸 연동 차량은 속도가 안 나온다» — busin 위치 API 에 속도 칸이 없어
// 늘 0 을 썼다. 이제 두 측정점으로 계산한다.
// 🔴 이 값은 승객앱 ETA(`speed > 5 ? speed : 30`)에도 들어간다 → 믿을 수 없는 경우는 전부 0(= 예전 동작)이어야 한다.
//    그래서 절반이 «0 을 돌려준다» 쪽 단언이다.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const raw = fs.readFileSync(path.join(__dirname, "..", "functions", "index.js"), "utf8");
const cut = (name) => {
  const i = raw.indexOf(`function ${name}(`);
  if (i < 0) { console.error(`🔴 ${name} 를 CF 소스에서 못 찾음`); process.exit(1); }
  return raw.slice(i, raw.indexOf("\n}\n", i) + 3);
};
const ctx = vm.createContext({ Math, Number });
vm.runInContext(cut("distMeters") + "\n" + cut("deviceSpeedKmh"), ctx);
const { deviceSpeedKmh, distMeters } = ctx;

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${x !== undefined ? " — " + JSON.stringify(x) : ""}`); } };

// 위도 0.01° ≈ 1,112m. 2분(120초)에 1,112m = 33.4 km/h.
const T0 = Date.UTC(2026, 9, 8, 0, 0, 0);
const p = (lat, lng, sec) => ({ lat, lng, ms: T0 + sec * 1000 });

console.log("\n[1] 정상 — 2분 간격 실제 이동");
ok("1.1km/2분 ≈ 33km/h", deviceSpeedKmh(p(37.50, 127.0, 0), p(37.51, 127.0, 120), T0 + 130e3) === 33, deviceSpeedKmh(p(37.50, 127.0, 0), p(37.51, 127.0, 120), T0 + 130e3));
ok("같은 자리(정차) = 0", deviceSpeedKmh(p(37.5, 127.0, 0), p(37.5, 127.0, 120), T0 + 130e3) === 0);
ok("정수로 반올림", Number.isInteger(deviceSpeedKmh(p(37.50, 127.0, 0), p(37.5037, 127.0, 60), T0 + 70e3)));
ok("1분 간격 단말도 계산", deviceSpeedKmh(p(37.50, 127.0, 0), p(37.505, 127.0, 60), T0 + 70e3) === 33);
ok("nowMs 생략(이력 행)도 계산", deviceSpeedKmh(p(37.50, 127.0, 0), p(37.51, 127.0, 120)) === 33);

console.log("\n[2] 믿을 수 없으면 0(= 예전 동작 · ETA 는 기본 30km/h)");
ok("앞 측정점 없음", deviceSpeedKmh(null, p(37.5, 127, 0), T0) === 0);
ok("간격 20초 미만(좌표 떨림이 속도로 부풀려진다)", deviceSpeedKmh(p(37.5, 127, 0), p(37.5005, 127, 10), T0 + 15e3) === 0);
ok("간격 5분 초과(그 사이 정차 여부 모름)", deviceSpeedKmh(p(37.50, 127, 0), p(37.51, 127, 301), T0 + 310e3) === 0);
ok("순서가 뒤집힘(음수 간격)", deviceSpeedKmh(p(37.51, 127, 120), p(37.50, 127, 0), T0 + 130e3) === 0);
ok("130km/h 초과 = 좌표 튐", deviceSpeedKmh(p(37.50, 127, 0), p(37.60, 127, 120), T0 + 130e3) === 0);
ok("최신 측정점이 5분 넘게 묵음", deviceSpeedKmh(p(37.50, 127, 0), p(37.51, 127, 120), T0 + 120e3 + 6 * 60e3) === 0);
ok("좌표가 숫자가 아님", deviceSpeedKmh({ lat: "x", lng: 127, ms: T0 }, p(37.5, 127, 120), T0 + 130e3) === 0);

console.log("\n[3] 경계");
ok("간격 정확히 20초는 계산", deviceSpeedKmh(p(37.50, 127, 0), p(37.501, 127, 20), T0 + 25e3) > 0);
ok("간격 정확히 300초는 계산", deviceSpeedKmh(p(37.50, 127, 0), p(37.51, 127, 300), T0 + 305e3) === 13);
ok("거리 함수 자체 감각(0.01°≈1.1km)", Math.round(distMeters(37.50, 127, 37.51, 127)) === 1112);

console.log("\n[4] 소스 가드 — 폴러가 실제로 쓴다");
ok("gps 문서 speed 가 계산값", /lat: latest\.lat, lng: latest\.lng, speed: latestSpeed,/.test(raw));
ok("이력 점 speed 도 계산값(앞 측정점 기준)", /speed: deviceSpeedKmh\(prevOf\.get\(r\), r\)/.test(raw));
ok("단말 경로에 speed: 0 하드코딩이 남지 않았다", !/source: "device"[\s\S]{0,40}speed: 0|speed: 0,[\s\S]{0,200}source: "device"/.test(raw));

console.log(`\n${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
