const CACHE = "qrferry-shell-v4";
// Derive the deployment base from the worker's own scope so the shell caches
// correctly whether the app is served from the domain root or a subpath
// (e.g. GitHub Pages project sites).
const BASE = new URL("./", self.registration.scope).pathname;
const SHELL = [BASE, `${BASE}scan/`, `${BASE}manifest.webmanifest`, `${BASE}favicon.svg`];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() =>
        caches.match(event.request).then((cached) => cached || caches.match(`${BASE}scan/`)),
      ),
  );
});
