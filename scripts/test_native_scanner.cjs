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
  ok(m.hasNativePlugin("CapacitorBarcodeScanner") === false, "플러그인 없음으로 판정");
  const m2 = load({ Capacitor: { isNativePlatform: () => false, PluginHeaders: [{ name: "CapacitorBarcodeScanner" }] } });
  ok(m2.hasNativePlugin("CapacitorBarcodeScanner") === false, "웹용 Capacitor(isNativePlatform=false)여도 안 탄다");
}

console.log("[2] 플러그인 없는 옛 앱 빌드 — jsQR 로 떨어진다");
{
  const m = load({ Capacitor: { isNativePlatform: () => true, PluginHeaders: [{ name: "App" }] } });
  ok(m.isNativeApp() === true, "앱 안이다");
  ok(m.hasNativePlugin("CapacitorBarcodeScanner") === false, "스캐너 플러그인 없음 → false");
}

console.log("[3] 플러그인 있는 앱 — 네이티브 호출");
(async () => {
  const calls = [];
  const cap = {
    isNativePlatform: () => true,
    PluginHeaders: [{ name: "CapacitorBarcodeScanner" }],
    nativePromise: (p, mth, o) => { calls.push(`${p}.${mth}`); return Promise.resolve({ ok: true, o }); },
  };
  const m = load({ Capacitor: cap });
  ok(m.hasNativePlugin("CapacitorBarcodeScanner") === true, "PluginHeaders 로 판정");
  const r = await m.nativeCall("CapacitorBarcodeScanner", "scanBarcode", { hint: 0 });
  ok(calls[0] === "CapacitorBarcodeScanner.scanBarcode" && r.o.hint === 0, "nativePromise 로 전달");
  const m2 = load({ Capacitor: { isNativePlatform: () => true, isPluginAvailable: (n) => n === "CapacitorBarcodeScanner" } });
  ok(m2.hasNativePlugin("CapacitorBarcodeScanner") === true, "isPluginAvailable 로도 판정");
  let threw = false;
  try { await load({ Capacitor: { isNativePlatform: () => true } }).nativeCall("X", "y"); } catch { threw = true; }
  ok(threw, "브리지가 없으면 조용히 넘어가지 않고 거부");

  console.log("[4] 소스 가드 — ScanTabDriverQR");
  const start = appSrc.indexOf("function ScanTabDriverQR");
  const end = appSrc.indexOf("\nfunction ", start + 10);
  const block = appSrc.slice(start, end > 0 ? end : undefined);
  ok(/if \(hasNativePlugin\("CapacitorBarcodeScanner"\)\)/.test(block), "네이티브 분기가 플러그인 판정으로 게이트된다");
  ok(/getUserMedia/.test(block) && /jsQR\(/.test(block), "웹 jsQR 경로가 남아 있다");
  ok(/gen !== scanGenRef\.current/.test(block.slice(block.indexOf("startNativeScan"))), "네이티브 경로도 세대 가드를 쓴다");
  ok(/cancel/i.test(block) && /setStep\("ready"\)/.test(block), "닫기(취소)는 오류가 아니라 준비 화면으로");

  ok(["hint", "scanInstructions", "scanButton", "scanText", "cameraDirection", "scanOrientation"].every((k) => new RegExp(k + ":").test(block)),
    "iOS 스캐너에 6개 값을 모두 보낸다(빠지면 OS-PLUG-BARC-0008)");
  ok(/BusLink 탑승/.test(block) && !/BusLink 승객 →/.test(block), "권한 안내가 앱 이름 «BusLink 탑승» 을 가리킨다");

  console.log("[5] 앱 푸시 토큰 · 좌우 밀림 CSS — 웹은 그대로");
  const notiSrc = fs.readFileSync(path.join(root, "src/lib/notifications.js"), "utf8");
  ok(/if \(hasNativePlugin\("FirebaseMessaging"\)\)/.test(notiSrc), "앱 푸시는 플러그인 판정으로 게이트된다");
  ok(notiSrc.indexOf('hasNativePlugin("FirebaseMessaging")') < notiSrc.indexOf("Notification.requestPermission"), "네이티브 분기가 웹 푸시 경로보다 먼저");
  ok(/fcmTokens/.test(notiSrc.slice(notiSrc.indexOf("async function initNativePush"))), "앱 토큰도 같은 fcmTokens 문서에 저장");
  const css = fs.readFileSync(path.join(root, "src/index.css"), "utf8");
  const clipLines = css.split("\n").filter((l) => /overflow-x:\s*(hidden|clip)/.test(l) && /^\s*html/.test(l));
  ok(clipLines.length > 0 && clipLines.every((l) => /html\.native-app/.test(l)), "html/body 가로 잘라내기는 앱(native-app)에서만");

  console.log(fail ? `\n❌ ${fail} fail / ${pass} pass` : `\n✅ 전부 통과 — ${pass} pass / 0 fail`);
  process.exit(fail ? 1 : 0);
})();
