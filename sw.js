"use strict";
const CACHE = "linenapp-v1";
const APP_SHELL = [
  "./index.html",
  "./scan.html",
  "./style.css",
  "./app.js",
  "./scan.js",
  "./db.js",
  "./manifest.json",
  "./icon.svg"
];
const CDN = [
  "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js",
  "https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js",
  "https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js"
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = e.request.url;
  // CDN: cache-first, cache on first hit
  if (CDN.some(u => url.startsWith(u.split("@")[0]))) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        });
      })
    );
    return;
  }
  // App shell: cache-first
  if (url.includes(self.location.origin) || APP_SHELL.some(p => url.endsWith(p.replace("./", "")))) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      }))
    );
    return;
  }
  // Supabase API: network-only (data handled by db.js / IndexedDB)
  // Everything else: network with cache fallback
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
