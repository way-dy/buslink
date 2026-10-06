// 승객앱 iOS 앱 — QR 네이티브 스캐너 분기 가드 (2026-10-06)
// 🔴 이 분기는 웹 사용자에게 아무것도 바꾸면 안 된다. 그래서 절반이 «안 탄다» 쪽 단언이다:
//    브라우저 · PWA · 플러그인 없는 옛 앱 빌드는 전부 jsQR 경로로 떨어져야 한다.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const libSrc = fs.readFileSync(path.join(root, "src/lib/nativeApp.js"), "utf8");
const appSrc = fs.readFileSync(path.join(root, "src/pages/EmployeeApp.js"), "utf8");

let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log("  ✅ " + label); } else { fail++; console.log("  ❌ " + label); } };

function load(windowObj) {
  const ctx = { window: windowObj, document: { querySelector: () => null, documentElement: { classList: { add() {} } } }, module: { exports: {} } };
  vm.createContext(ctx);
  const names = [...libSrc.matchAll(/^export function (\w+)/gm)].map((x) => x[1]);
  vm.runInContext(libSrc.replace(/^export function/gm, "function") + "\n" + names.map((n) => `module.exports.${n} = ${n};`).join("\n"), ctx);
  return ctx.module.exports;
}

console.log("[1] 브라우저·PWA — 네이티브 경로를 타지 않는다");
{
  const m = load({});
  ok(m.isNativeApp() === false, "window.Capacitor 없음 → isNativeApp false");
  ok(m.hasNativePlugin("BarcodeScanner") === false, "플러그인 없음으로 판정");
  const m2 = load({ Capacitor: { isNativePlatform: () => false, PluginHeaders: [{ name: "BarcodeScanner" }] } });
  ok(m2.hasNativePlugin("BarcodeScanner") === false, "웹용 Capacitor(isNativePlatform=false)여도 안 탄다");
}

console.log("[2] 플러그인 없는 옛 앱 빌드 — jsQR 로 떨어진다");
{
  const m = load({ Capacitor: { isNativePlatform: () => true, PluginHeaders: [{ name: "App" }] } });
  ok(m.isNativeApp() === true, "앱 안이다");
  ok(m.hasNativePlugin("BarcodeScanner") === false, "스캐너 플러그인 없음 → false");
}

console.log("[3] 플러그인 있는 앱 — 네이티브 호출");
(async () => {
  const calls = [];
  const cap = {
    isNativePlatform: () => true,
    PluginHeaders: [{ name: "BarcodeScanner" }],
    nativePromise: (p, mth, o) => { calls.push(`${p}.${mth}`); return Promise.resolve({ ok: true, o }); },
  };
  const m = load({ Capacitor: cap });
  ok(m.hasNativePlugin("BarcodeScanner") === true, "PluginHeaders 로 판정");
  const r = await m.nativeCall("BarcodeScanner", "scan", { formats: ["QR_CODE"] });
  ok(calls[0] === "BarcodeScanner.scan" && r.o.formats[0] === "QR_CODE", "nativePromise 로 전달");
  const m2 = load({ Capacitor: { isNativePlatform: () => true, isPluginAvailable: (n) => n === "BarcodeScanner" } });
  ok(m2.hasNativePlugin("BarcodeScanner") === true, "isPluginAvailable 로도 판정");
  let threw = false;
  try { await load({ Capacitor: { isNativePlatform: () => true } }).nativeCall("X", "y"); } catch { threw = true; }
  ok(threw, "브리지가 없으면 조용히 넘어가지 않고 거부");

  console.log("[4] 소스 가드 — ScanTabDriverQR");
  const start = appSrc.indexOf("function ScanTabDriverQR");
  const end = appSrc.indexOf("\nfunction ", start + 10);
  const block = appSrc.slice(start, end > 0 ? end : undefined);
  ok(/if \(hasNativePlugin\("BarcodeScanner"\)\)/.test(block), "네이티브 분기가 플러그인 판정으로 게이트된다");
  ok(/getUserMedia/.test(block) && /jsQR\(/.test(block), "웹 jsQR 경로가 남아 있다");
  ok(/gen !== scanGenRef\.current/.test(block.slice(block.indexOf("startNativeScan"))), "네이티브 경로도 세대 가드를 쓴다");
  ok(/cancel/i.test(block) && /setStep\("ready"\)/.test(block), "닫기(취소)는 오류가 아니라 준비 화면으로");

  console.log(fail ? `\n❌ ${fail} fail / ${pass} pass` : `\n✅ 전부 통과 — ${pass} pass / 0 fail`);
  process.exit(fail ? 1 : 0);
})();
