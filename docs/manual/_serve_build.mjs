// build/ 정적 서빙 + SPA rewrite (매뉴얼 캡처용) — 반드시 3000 포트(카카오 키 도메인 등록: localhost:3000)
// 실행: node _serve_build.mjs   (중지: Ctrl+C)
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const BUILD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "build");
const PORT = 3000;
const MIME = { html: "text/html; charset=utf-8", js: "text/javascript", css: "text/css", json: "application/json", png: "image/png", svg: "image/svg+xml", ico: "image/x-icon", map: "application/json", txt: "text/plain", woff2: "font/woff2" };

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  let file = path.join(BUILD, urlPath.replace(/^\/+/, ""));
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(BUILD, "index.html"); // SPA rewrite
  const ext = path.extname(file).slice(1).toLowerCase();
  res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream", "cache-control": "no-cache" });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`serving ${BUILD} → http://localhost:${PORT}`));
