/* Minimal service worker: exists so Chrome offers a real install. It caches NOTHING (staff must never be stuck on an old version). */
'use strict';
var OFFLINE = '<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ไม่มีอินเทอร์เน็ต</title></head>' +
  '<body style="font-family:sans-serif;text-align:center;padding:48px 20px"><p style="font-size:22px">ไม่มีอินเทอร์เน็ต ลองใหม่อีกครั้ง</p>' +
  '<button onclick="location.reload()" style="font-size:20px;min-height:52px;padding:0 28px;border-radius:12px;border:0;background:#1a56db;color:#fff">ลองใหม่</button></body></html>';
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function (e) {
  var r = e.request;
  if (r.mode !== 'navigate') return;
  if (/(^|\.)script\.google(usercontent)?\.com$/.test(new URL(r.url).hostname)) return;
  e.respondWith(fetch(r).catch(function () { return new Response(OFFLINE, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }); }));
});
