/* Простой сервис-воркер: сайт открывается и без сети, запросы к /api не кэшируются. */
const CACHE = "kr-v1";
const SHELL = [
  "./", "index.html", "css/styles.css", "js/config.js", "js/app.js",
  "manifest.webmanifest", "assets/logo.png", "icons/icon-192.png", "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/admin")) return;

  // Страницы: сначала сеть, при ошибке кэш
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match("index.html")));
    return;
  }
  // Код и стили: сначала сеть (чтобы обновления доходили сразу), при ошибке кэш
  if (/\.(css|js)$/.test(url.pathname)) {
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }
  // Картинки и прочее: из кэша с фоновым обновлением
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
