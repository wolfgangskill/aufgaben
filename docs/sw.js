// Service Worker: legt die App-Dateien im Gerät ab, damit die App schnell startet.
// Daten (Aufgaben) kommen immer frisch von Supabase und werden hier NICHT zwischengespeichert.
// Nach jeder Änderung an den App-Dateien die Zahl in CACHE erhöhen.
const CACHE = "aufgaben-v3";
const SHELL = [
  "./",
  "index.html",
  "style.css",
  "config.js",
  "app.js",
  "vendor/supabase.js",
  "manifest.webmanifest",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Gespeicherte Datei sofort liefern, im Hintergrund eine frische holen (beim nächsten Start aktuell).
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    const refresh = fetch(req)
      .then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      })
      .catch(() => null);
    if (hit) {
      event.waitUntil(refresh);
      return hit;
    }
    return (await refresh) || Response.error();
  })());
});
