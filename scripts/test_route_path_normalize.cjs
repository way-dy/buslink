// toLatLngPath 격리 테스트 (2026-07-27)
//   node scripts/test_route_path_normalize.cjs
//
// 배경: "노선 탭 실시간 지도에서 경로가 직선으로 나온다" 신고 → 그 화면만 routePath 를
//   안 쓰고 정류장을 곧장 잇고 있었다. 고치면서 좌표 정규화를 공용 함수로 뺐다.
//   Firestore 좌표는 number 외 문자열·GeoPoint·중첩으로도 들어오므로(issues.md stops 항목)
//   엄격 필터로 경로가 통째로 사라지는 일이 없어야 한다.
const fs = require("fs"), path = require("path"), vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "routeProgress.js"), "utf8")
  .replace(/^export function /gm, "function ").replace(/^export const /gm, "const ");
const sb = { module: { exports: {} }, Math, Number, Array, JSON, isFinite };
vm.createContext(sb);
vm.runInContext(src + "\nmodule.exports = { toLatLngPath, haversine };", sb);
const { toLatLngPath } = sb.module.exports;

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${x !== undefined ? " → " + JSON.stringify(x) : ""}`); } };

console.log("\n[1] 정상 number 경로 (prod 50개 노선의 실제 형식)");
{
  const raw = [{ lat: 37.5, lng: 127.0 }, { lng: 127.1, lat: 37.6 }, { lat: 37.7, lng: 127.2 }];
  const out = toLatLngPath(raw);
  ok("3점 모두 유지", out.length === 3, out);
  ok("키 순서 뒤바뀐 점도 정상 처리", out[1].lat === 37.6 && out[1].lng === 127.1, out[1]);
}

console.log("\n[2] 다른 저장 형식도 살린다 (엄격 필터였다면 전멸)");
{
  ok("문자열 좌표", toLatLngPath([{ lat: "37.5", lng: "127.0" }, { lat: "37.6", lng: "127.1" }]).length === 2);
  ok("GeoPoint", toLatLngPath([{ latitude: 37.5, longitude: 127.0 }, { latitude: 37.6, longitude: 127.1 }]).length === 2);
  ok("중첩 location", toLatLngPath([{ location: { latitude: 37.5, longitude: 127.0 } }, { location: { latitude: 37.6, longitude: 127.1 } }]).length === 2);
  const mixed = toLatLngPath([{ lat: 37.5, lng: 127.0 }, { lat: "37.6", lng: "127.1" }, { latitude: 37.7, longitude: 127.2 }]);
  ok("혼합 형식 3점 전부 살림", mixed.length === 3, mixed);
  ok("숫자로 변환됨", mixed.every(p => typeof p.lat === "number" && typeof p.lng === "number"));
}

console.log("\n[3] 못 쓰는 입력은 빈 배열 → 호출부가 직선 폴백");
{
  ok("undefined", toLatLngPath(undefined).length === 0);
  ok("null", toLatLngPath(null).length === 0);
  ok("빈 배열", toLatLngPath([]).length === 0);
  ok("배열 아님", toLatLngPath({ lat: 1, lng: 2 }).length === 0);
  ok("점 1개(선 못 그림)", toLatLngPath([{ lat: 37.5, lng: 127 }]).length === 0);
  ok("유효점 1개 + 쓰레기", toLatLngPath([{ lat: 37.5, lng: 127 }, null, { lat: "x", lng: "y" }]).length === 0);
  ok("NaN 제거", toLatLngPath([{ lat: NaN, lng: 127 }, { lat: 37.5, lng: 127 }, { lat: 37.6, lng: 127.1 }]).length === 2);
  ok("Infinity 제거", toLatLngPath([{ lat: Infinity, lng: 127 }, { lat: 37.5, lng: 127 }, { lat: 37.6, lng: 127.1 }]).length === 2);
  // Number("")===0 · Number(null)===0 이라 걸러내지 않으면 (0,0) 대서양 점이 생긴다.
  ok("빈 문자열 제거", toLatLngPath([{ lat: "", lng: "" }, { lat: 37.5, lng: 127 }, { lat: 37.6, lng: 127.1 }]).length === 2);
  ok("공백 문자열 제거", toLatLngPath([{ lat: "  ", lng: "  " }, { lat: 37.5, lng: 127 }, { lat: 37.6, lng: 127.1 }]).length === 2);
  ok("null 좌표 제거", toLatLngPath([{ lat: null, lng: null }, { lat: 37.5, lng: 127 }, { lat: 37.6, lng: 127.1 }]).length === 2);
  ok("(0,0) 점이 생기지 않음", toLatLngPath([{ lat: "", lng: "" }, { lat: 37.5, lng: 127 }, { lat: 37.6, lng: 127.1 }]).every(p => p.lat !== 0));
}

console.log("\n[4] 호출부 연결 — 노선 탭 모달이 routePath 를 실제로 쓰는지");
{
  const emp = fs.readFileSync(path.join(__dirname, "..", "src", "pages", "EmployeeApp.js"), "utf8");
  ok("toLatLngPath import", /import \{[^}]*toLatLngPath[^}]*\} from "\.\.\/lib\/routeProgress"/.test(emp));
  ok("modalPath 가 stopModal.routePath 를 읽음", /toLatLngPath\(stopModal\?\.routePath\)/.test(emp));
  ok("모달 Polyline 이 modalPath 사용", /<Polyline\s+path=\{modalPath\}/.test(emp));
  ok("옛 직선 전용 코드 잔존 없음", !/path=\{modalStops\.map\(s=>\(\{ lat:s\.lat, lng:s\.lng \}\)\)\}/.test(emp));
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
