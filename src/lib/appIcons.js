// 앱별 아이콘·매니페스트 매핑 (순수 모듈 — Firebase/로직 import 0).
//
// 호스트명(서브도메인) 우선 → 없으면 경로로 현재 앱을 판별한다. App.js HOST_APP 과
// 동일 규칙(2026-06, 앱별 도메인 분리). index.js(조기 <head> 교체)·InstallPrompt(설치
// 팝업 아이콘)가 공유 — 파비콘/애플터치/매니페스트/설치팝업 아이콘을 한 곳에서 결정.
//
// ⚠ 신규 앱·도메인 추가 시 App.js HOST_APP · companyResolver · SW 와 함께 갱신.

const ICONS = {
  admin:     { favicon: "/icons/admin.svg",     apple: "/icons/admin-1024.png",     manifest: "/manifest.json",          title: "BusLink 관제",   install: "/icons/admin.svg" },
  driver:    { favicon: "/icons/driver.svg",    apple: "/icons/driver-1024.png",    manifest: "/manifest-driver.json",   title: "BusLink 기사",   install: "/icons/driver.svg" },
  employee:  { favicon: "/icons/passenger.svg", apple: "/icons/passenger-1024.png", manifest: "/manifest-employee.json", title: "BusLink 승객",   install: "/icons/passenger.svg" },
  partner:   { favicon: "/icons/partner.svg",   apple: "/icons/passenger-1024.png", manifest: "/manifest-partner.json",  title: "BusLink 협력사", install: "/icons/partner.svg" },
  // 승객앱(/bus, 공용 딥링크) — passenger 아이콘 공유. 별도 매니페스트 없음 → 기본 사용.
  passenger: { favicon: "/icons/passenger.svg", apple: "/icons/passenger-1024.png", manifest: "/manifest.json",          title: "BusLink",        install: "/icons/passenger.svg" },
};

const HOST_APP = {
  "d.buslink.co.kr": "driver",
  "admin.buslink.co.kr": "admin",
  "p.buslink.co.kr": "employee",
  "partner.buslink.co.kr": "partner",
};

/** hostname + pathname → 앱 키. 호스트 매핑 우선, 없으면 경로 기반(App.js 규칙 일치). */
export function resolveAppKey(hostname, pathname) {
  const host = (hostname || "").toLowerCase();
  if (HOST_APP[host]) return HOST_APP[host];
  const p = pathname || "";
  if (p.startsWith("/partner")) return "partner";
  if (p.startsWith("/p")) return "employee";
  if (p.startsWith("/driver")) return "driver";
  if (p.startsWith("/bus")) return "passenger";
  return "admin"; // 루트(관제)·/board 등 그 외
}

/** {favicon, apple, manifest, title, install} 반환. */
export function resolveAppIcons(hostname, pathname) {
  return ICONS[resolveAppKey(hostname, pathname)] || ICONS.admin;
}
