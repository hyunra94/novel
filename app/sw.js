// 앱 화면 파일만 저장해 두고(오프라인에서도 열리게), 새 버전이 있으면 받아 둔다.
// 본문·음성은 앱이 Cache API(nr-data, nr-audio, nr-chunks)에 직접 저장한다.
const SHELL = "nr-shell-v22";
const FILES = ["./", "index.html", "style.css", "app.js", "mp3.js", "mock.js", "manifest.webmanifest", "icon.svg",
  "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k.startsWith("nr-shell-") && k !== SHELL).map(k => caches.delete(k)),
  )).then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.includes("/__")) return;
  // 네트워크 먼저, 안 되면 저장본
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) caches.open(SHELL).then(c => c.put(e.request, res.clone()));
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match("index.html"))),
  );
});
