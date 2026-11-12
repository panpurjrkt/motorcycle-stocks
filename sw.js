/* Minimal service worker: exists so Chrome offers a real install. It caches NOTHING (staff must never be stuck on an old version); .js/.css/.webmanifest are re-validated with cache:'no-cache'. */
'use strict';
var OFFLINE = '<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ไม่มีอินเทอร์เน็ต</title></head>' +
  '<body style="font-family:sans-serif;text-align:center;padding:48px 20px"><p style="font-size:22px">ไม่มีอินเทอร์เน็ต ลองใหม่อีกครั้ง</p>' +
  '<button onclick="location.reload()" style="font-size:20px;min-height:52px;padding:0 28px;border-radius:12px;border:0;background:#1a56db;color:#fff">ลองใหม่</button></body></html>';
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function (e) {
  var r = e.request, u = new URL(r.url);
  if (r.method === 'GET' && u.origin === self.location.origin && /\.(js|css|webmanifest)$/.test(u.pathname)) {
    e.respondWith(fetch(r, { cache: 'no-cache' }).catch(function () { return fetch(r); })); // always revalidate; we cache nothing ourselves
    return;
  }
  if (r.mode !== 'navigate') return;
  if (/(^|\.)script\.google(usercontent)?\.com$/.test(u.hostname)) return;
  e.respondWith(fetch(new Request(r.url, { cache: 'no-cache', credentials: 'include' })).catch(function () { return new Response(OFFLINE, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }); }));
});
