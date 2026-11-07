/*
 * VPS Yamaha stock count - staff app (one static page, no build step, no secrets).
 *
 * Part 1 (StockLib) is pure: no DOM, no network, no storage objects of its own. web-test.js loads it in Node, and the page uses the same code.
 * Part 2 is the page itself (PIN pad, lists, cards, camera, save queue); it only runs where `document` exists.
 *
 * The link is  <this page>#x=<execId>&t=<token>  : everything after # stays on the phone (GitHub never sees it).
 * The app talks to the Apps Script web app (/exec) with POST + text/plain (a CORS "simple request": no preflight).
 */
var StockLib = (function () {
  'use strict';
  var L = {};
  function str(v) { return v === null || v === undefined ? '' : String(v); }
  function copy(o) { var r = {}; Object.keys(o).forEach(function (k) { r[k] = o[k]; }); return r; }

  /* ---- code rules: IDENTICAL to Logic.normScan / Logic.scanDecision on the server (a test keeps them the same) ---- */
  L.normScan = function (s) {
    return str(s).replace(/[\u0000-\u001f\u007f​-‍⁠﻿]/g, '').trim()
      .replace(/^['‘’ʼ`]+/, '').replace(/[\s\xa0]+/g, '').replace(/[\-‐-―−﹘﹣－]/g, '').toUpperCase();
  };
  L.scanDecision = function (codes, lock, scanned) {
    var n = L.normScan(scanned);
    if (!n) return { action: 'ignore', lock: lock || '' };
    if (lock) return { action: n === lock ? 'count' : 'wrong', lock: lock };
    if (!codes || !codes.length || codes.indexOf(n) >= 0) return { action: 'count', lock: n };
    return { action: 'wrong', lock: '' };
  };
  L.normId = function (s) { return str(s).trim().toUpperCase(); };

  /* ---- the link ---- */
  /** "#x=<execId>&t=<token>" -> {x, t}, or null when either is missing / not plain letters, digits, - and _. */
  L.parseHash = function (h) {
    var out = {};
    str(h).replace(/^#/, '').split('&').forEach(function (kv) {
      var i = kv.indexOf('=');
      if (i > 0) { try { out[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)); } catch (e) { /* skip a damaged pair */ } }
    });
    if (!/^[A-Za-z0-9_-]{3,200}$/.test(out.x || '') || !/^[A-Za-z0-9_-]{1,100}$/.test(out.t || '')) return null;
    return { x: out.x, t: out.t };
  };
  L.execUrl = function (x) { return 'https://script.google.com/macros/s/' + x + '/exec'; };

  /* ---- requests ---- */
  /** {api:1, action, token, pin?, ...extra}; pin is left out when null (a probe / a person with no PIN). */
  L.makeRequest = function (token, pin, action, extra) {
    var b = { api: 1, action: action, token: token };
    if (pin !== null && pin !== undefined) b.pin = String(pin);
    Object.keys(extra || {}).forEach(function (k) { b[k] = extra[k]; });
    return b;
  };
  L.parseResponse = function (text) {
    var r = null;
    try { r = JSON.parse(text); } catch (e) { r = null; }
    if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, code: 'FAULT', error: 'ได้รับคำตอบที่อ่านไม่ได้ กรุณาลองใหม่' };
    return r;
  };
  /** 'ok' | 'pin' (ask for the PIN again, keep the queue) | 'retry' (try again later) | 'mode' (the server switched mode) | 'refused' (a real no) */
  L.classify = function (res) {
    if (!res || typeof res !== 'object') return 'retry';
    if (res.ok === true) return 'ok';
    switch (res.code) {
      case 'PIN': case 'LOCK': return 'pin';
      case 'BUSY': case 'FAULT': case 'NET': return 'retry';
      case 'ALREADY': return 'ok';          // already saved (by an earlier try): the same as success
      case 'MODE': case 'ENDED': return 'mode';
      default: return 'refused';
    }
  };
  L.makeRid = function (cryptoObj, rnd) {
    try { if (cryptoObj && typeof cryptoObj.randomUUID === 'function') return cryptoObj.randomUUID(); } catch (e) { /* fall through */ }
    var hex = '', i;
    try { if (cryptoObj && cryptoObj.getRandomValues) { var a = new Uint8Array(16); cryptoObj.getRandomValues(a); for (i = 0; i < 16; i++) hex += ('0' + a[i].toString(16)).slice(-2); return hex; } } catch (e2) { /* fall through */ }
    rnd = rnd || Math.random;
    for (i = 0; i < 32; i++) hex += Math.floor(rnd() * 16).toString(16);
    return hex;
  };

  /* ---- storage (every access guarded: the app works without it) ---- */
  L.storeKey = function (kind, token) { return 'sc5.' + kind + '.' + token; };
  L.makeStore = function (getLs) {
    function ls() { try { return getLs(); } catch (e) { return null; } }
    return {
      get: function (k) { try { var s = ls(); return s ? s.getItem(k) : null; } catch (e) { return null; } },
      set: function (k, v) { try { var s = ls(); if (!s) return false; s.setItem(k, v); return true; } catch (e) { return false; } },
      del: function (k) { try { var s = ls(); if (s) s.removeItem(k); } catch (e) { /* ignore */ }
      }
    };
  };

  /* ---- the full-count model (from the boot payload: column arrays) ---- */
  L.makeModel = function (b) {
    var m = { mode: 'fullcount', v: str(b.v), counter: str(b.counter), dateText: str(b.dateText), state: str(b.state), message: str(b.message), secondMessage: str(b.secondMessage),
      progress: copy(b.progress || { done: 0, total: 0, pct: 0, mine: 0, second: 0 }), parts: [], idIndex: Object.create(null), m2: Object.create(null), m1: Object.create(null),
      items: [], second: [], byPart: [], locked: Object.create(null), cards: Object.create(null) };
    var P = b.parts || {}, ids = P.id || [], i;
    for (i = 0; i < ids.length; i++) {
      var part = { id: ids[i], code2: str(P.code2[i]), name: str(P.name[i]), c1: str(P.c1[i]), codes: [] }, n2 = L.normScan(part.code2), n1 = L.normScan(part.c1);
      if (n2) part.codes.push(n2);
      if (n1 && part.codes.indexOf(n1) < 0) part.codes.push(n1);
      m.parts.push(part); m.idIndex[part.id] = i; m.byPart.push([]);
      if (n2 && !(n2 in m.m2)) m.m2[n2] = i;
      if (n1 && !(n1 in m.m1)) m.m1[n1] = i;
    }
    function cols(c, into, perPart) {
      c = c || {};
      var p = c.p || [];
      for (var j = 0; j < p.length; j++) { var it = { p: p[j], shelf: str(c.shelf[j]), done: !!c.done[j], on: str(c.on[j]), by: str(c.by[j]) }; into.push(it); if (perPart) m.byPart[it.p].push(it); }
    }
    cols(b.items, m.items, true);
    cols(b.second, m.second, false);
    (b.locked || []).forEach(function (p) { m.locked[p] = true; });
    (b.cards || []).forEach(function (c) { m.cards[c.p] = (c.shelves || []).map(function (s) { return { shelf: str(s.shelf), done: !!s.done, doneOn: str(s.doneOn), doneBy: str(s.doneBy) }; }); });
    return m;
  };

  /** The part a scanned / typed code belongs to (index into m.parts) or -1: code2 first, then code1, first match wins - the server's findByCode. */
  L.findPart = function (m, text) {
    var n = L.normScan(text);
    if (!n) return -1;
    if (n in m.m2) return m.m2[n];
    if (n in m.m1) return m.m1[n];
    return -1;
  };

  /**
   * The part card, the same data the old lookup gave: a part this person must count blind opens as that count (blind cards), otherwise
   * every DMS shelf with its counted info; `locked` = a blind recount exists, so the first count cannot be redone by staff.
   * forceFirst = a tap on a row of the first list (the old page opened that as a plain first count).
   */
  L.cardOf = function (m, p, forceFirst) {
    var part = m.parts[p], base = { p: p, id: part.id, code2: part.code2, name: part.name, codes: part.codes.slice() };
    if (!forceFirst && m.cards[p]) { base.second = true; base.locked = false; base.shelves = m.cards[p].map(function (s) { return copy(s); }); return base; }
    base.second = false; base.locked = !!m.locked[p];
    base.shelves = m.byPart[p].map(function (it) { return { shelf: it.shelf, done: it.done, doneOn: it.on, doneBy: it.by }; });
    return base;
  };
  /** The card of a row of the second list (blind count): the blind card when the server sent one, else the shelves of that part in the list. */
  L.cardOfSecondRow = function (m, p) {
    if (m.cards[p]) return L.cardOf(m, p, false);
    var part = m.parts[p];
    return { p: p, id: part.id, code2: part.code2, name: part.name, codes: part.codes.slice(), second: true, locked: false,
      shelves: m.second.filter(function (x) { return x.p === p; }).map(function (it) { return { shelf: it.shelf, done: it.done, doneOn: it.on, doneBy: it.by }; }) };
  };

  /** Items of a list that pass the filter (the old page's rules); at most f.max rows, `hidden` = how many more matched. */
  L.filterItems = function (m, list, f) {
    var qn = L.normScan(f.q), raw = str(f.q).trim().toLowerCase(), rows = [], hidden = 0, max = f.max || 150;
    for (var i = 0; i < list.length; i++) {
      var it = list[i], part = m.parts[it.p];
      if (it.done && !f.showDone) continue;
      if (f.shelf && it.shelf !== f.shelf) continue;
      if (raw && L.normScan(part.code2).indexOf(qn) < 0 && part.name.toLowerCase().indexOf(raw) < 0) continue;
      if (rows.length >= max) { hidden++; continue; }
      rows.push(it);
    }
    return { rows: rows, hidden: hidden };
  };
  L.shelvesOf = function (m, list) {
    var seen = Object.create(null), out = [];
    list.forEach(function (it) { if (!seen[it.shelf]) { seen[it.shelf] = true; out.push(it.shelf); } });
    return out;
  };

  /** The request body of a full-count save (the same fields the old page sent). */
  L.fcBody = function (card, qty, mode) {
    var b = { id: card.id, qty: String(qty), mode: mode === 'scan' ? 'scan' : 'type' };
    if (card.second) b.second = true;
    if (card.other) b.otherShelf = card.shelf; else b.shelf = card.shelf;
    return b;
  };
  L.unknownBody = function (code, shelf, qty) { return { unknown: true, unknownCode: code, unknownShelf: shelf, qty: String(qty), mode: 'type' }; };

  function sameShelf(a, b) {
    var x = str(a).trim().toLowerCase(), y = str(b).trim().toLowerCase();
    return x === y || (L.normScan(a) !== '' && L.normScan(a) === L.normScan(b));
  }
  function pct(p) { p.pct = p.total ? Math.round(p.done / p.total * 100) : 0; }

  /**
   * The optimistic effect of a queued save on the lists: the item turns "counted" (so it leaves the open list) and the progress moves.
   * Returns an undo record (or null when there is nothing to change). who = this counter, today = the Thai date text.
   */
  L.applySave = function (m, body, who, today) {
    if (!m || !body || body.unknown) return null;
    var p = m.idIndex[L.normId(body.id)];
    if (p === undefined) return null;
    var want = body.otherShelf !== undefined && str(body.otherShelf).trim() ? body.otherShelf : body.shelf, list = body.second ? m.second : m.byPart[p], hit = null;
    for (var i = 0; i < list.length; i++) { if (list[i].p === p && sameShelf(list[i].shelf, want)) { hit = list[i]; break; } }
    var undo = { item: hit, done: hit ? hit.done : false, on: hit ? hit.on : '', by: hit ? hit.by : '', progress: copy(m.progress), card: null };
    if (body.second && m.cards[p]) {   // the blind card shows the shelf as counted too
      m.cards[p].forEach(function (s) { if (sameShelf(s.shelf, want)) { undo.card = { s: s, done: s.done, on: s.doneOn, by: s.doneBy }; s.done = true; s.doneOn = today; s.doneBy = who; } });
    }
    if (hit) {
      var mineAlready = hit.done && hit.by === who && hit.on === today;
      if (!body.second && !hit.done) m.progress.done++;
      if (!mineAlready) m.progress.mine++;
      hit.done = true; hit.on = today; hit.by = who;
    } else if (!body.second) { m.progress.mine++; }   // an extra (typed) shelf: counts as my work only
    if (body.second) m.progress.second = m.second.filter(function (x) { return !x.done; }).length;
    pct(m.progress);
    return undo;
  };
  L.revertSave = function (m, undo) {
    if (!m || !undo) return;
    if (undo.item) { undo.item.done = undo.done; undo.item.on = undo.on; undo.item.by = undo.by; }
    if (undo.card) { undo.card.s.done = undo.card.done; undo.card.s.doneOn = undo.card.on; undo.card.s.doneBy = undo.card.by; }
    m.progress = copy(undo.progress);
  };
  L.secondLeft = function (m) { return m.second.filter(function (x) { return !x.done; }).length; };

  /* ---- the save queue (a plain array, oldest first; one request in flight at a time so saves keep their order) ---- */
  var BACKOFF = [1500, 3000, 6000, 12000, 24000, 48000, 60000];
  L.backoffMs = function (tries) { return BACKOFF[Math.min(Math.max(tries, 1), BACKOFF.length) - 1]; };
  /** tok = the link token the save was made under: it is sent with THIS token, never with another person's */
  L.newEntry = function (kind, rid, body, label, now, tok) { return { rid: rid, kind: kind, body: body, label: str(label), tries: 0, next: 0, born: now || 0, tok: str(tok) }; };
  L.qAdd = function (q, e) { q.push(e); return q; };
  /** The entry to send now (the oldest, when its retry time has come) or null. */
  L.qDue = function (q, now) { return q.length && q[0].next <= now ? q[0] : null; };
  L.qIndex = function (q, rid) { for (var i = 0; i < q.length; i++) if (q[i].rid === rid) return i; return -1; };
  L.qRetry = function (q, rid, now) { var i = L.qIndex(q, rid); if (i < 0) return null; q[i].tries++; q[i].next = now + L.backoffMs(q[i].tries); return q[i]; };
  L.qDrop = function (q, rid) { var i = L.qIndex(q, rid); if (i >= 0) q.splice(i, 1); return q; };
  L.qFailing = function (q) { return q.length > 0 && q[0].tries >= 2; };
  L.qSerialize = function (q, withPhoto) {
    return JSON.stringify(q.map(function (e) {
      var c = copy(e); c.next = 0;
      if (!withPhoto && c.body && c.body.photo) { c.body = copy(c.body); c.body.photo = ''; c.lostPhoto = true; }
      return c;
    }));
  };
  /**
   * Reads a stored queue back (never throws). Damaged lines and entries made under ANOTHER token are dropped. An entry whose photo had to be left out
   * (phone storage too small) comes back with lostPhoto:true: the app shows it as "ต้องถ่ายรูปใหม่", it is never sent without its photo.
   */
  L.qParse = function (text, token) {
    var a = null;
    try { a = JSON.parse(text); } catch (e) { a = null; }
    if (!Array.isArray(a)) return [];
    return a.filter(function (e) { return e && typeof e === 'object' && typeof e.rid === 'string' && (e.kind === 'fc' || e.kind === 'daily') && e.body && typeof e.body === 'object' && (token === undefined || !e.tok || e.tok === token); })
      .map(function (e) { var o = { rid: e.rid, kind: e.kind, body: e.body, label: str(e.label), tries: 0, next: 0, born: Number(e.born) || 0, tok: str(e.tok) || str(token) }; if (e.lostPhoto) o.lostPhoto = true; return o; });
  };

  /* ---- camera: when does the SAME barcode count again? ---- */
  /**
   * The re-arm gate of piece scanning. A code in view counts once; it counts again only after it has been out of view long enough. "Out of view" =
   * N consecutive decode callbacks with nothing, where N follows the measured callback rate (about floorMs worth of callbacks, 2..12), AND at least floorMs
   * since the code was last seen. So a slow decoder (one callback per second) and a fast one (every 100 ms) both need about 0.7 s of real absence, and a
   * single missed frame while the barcode is still in view never re-arms. feed(text, nowMs) -> true when this read must be counted.
   */
  L.makeGate = function (floorMs) {
    floorMs = floorMs || 700;
    var g = { armed: true, lastSeen: 0, empties: 0, lastCb: 0, avg: 0 };
    g.need = function () { return g.avg > 0 ? Math.min(12, Math.max(2, Math.ceil(floorMs / g.avg))) : 3; };
    g.feed = function (text, now) {
      if (g.lastCb) { var d = now - g.lastCb; g.avg = g.avg ? g.avg * 0.7 + d * 0.3 : d; }
      g.lastCb = now;
      if (text) { g.lastSeen = now; g.empties = 0; if (g.armed) { g.armed = false; return true; } return false; }
      g.empties++;
      if (!g.armed && g.empties >= g.need() && now - g.lastSeen >= floorMs) g.armed = true;
      return false;
    };
    return g;
  };

  /* ---- the link / the browser ---- */
  /** LINE's in-app browser (UA contains " Line/") has no camera: the app tells the person to open it in the phone's browser */
  L.isLineBrowser = function (ua) { return /\sLine\//.test(str(ua)); };
  /** remembered = the deployment id this phone used before ('' = none): 'new' | 'same' | 'differs' */
  L.checkExec = function (remembered, x) { if (!remembered) return 'new'; return remembered === x ? 'same' : 'differs'; };
  var PHOTO_RE = /ถ่ายรูปใหม่|รูปใหญ่|ไฟล์รูป/;
  /** What a daily refusal says on the phone: a photo problem (too old, or the retry came 10+ minutes after the photo) becomes the plain 10-minute message. */
  L.dailyRefusal = function (reason, ageMs) {
    var r = str(reason);
    if (PHOTO_RE.test(r) && (/ตอนนี้/.test(r) || ageMs > 10 * 60 * 1000 || /เวลาในมือถือ/.test(r) && ageMs > 10 * 60 * 1000)) return { text: 'รูปเก่าเกิน 10 นาที กรุณาถ่ายรูปใหม่', needPhoto: true };
    return { text: r, needPhoto: PHOTO_RE.test(r) };
  };

  /* ---- the daily count page ---- */
  var PHOTO_MAX_AGE = 10 * 60 * 1000;
  L.PHOTO_MAX_AGE = PHOTO_MAX_AGE;
  L.photoTooOld = function (lastModified, now) { return !lastModified || (now - lastModified) > PHOTO_MAX_AGE; };
  /** Checks one daily card before it is queued (the same messages as the old page). d: {bulk, qty, crates, per, loose, foundAt, photo, lastModified, now} */
  L.dailyCheck = function (d) {
    var answer, pieces;
    if (d.bulk) {
      if (str(d.crates) === '' && str(d.per) === '' && str(d.loose) === '') return { ok: false, error: 'กรุณากรอกจำนวนที่นับได้' };
      answer = { crates: str(d.crates), perCrate: str(d.per), loose: str(d.loose) };
      pieces = (+d.crates || 0) * (+d.per || 0) + (+d.loose || 0);
    } else {
      if (str(d.qty) === '') return { ok: false, error: 'กรุณากรอกจำนวนที่นับได้ (ไม่มีให้ใส่ 0)' };
      answer = { qty: str(d.qty) };
      pieces = +d.qty || 0;
    }
    if (pieces > 0 && !str(d.foundAt).trim()) return { ok: false, error: 'กรุณาพิมพ์ว่าเจอที่ไหนบ้าง' };
    if (!d.photo) return { ok: false, error: 'กรุณาถ่ายรูปรายการนี้' };
    if (L.photoTooOld(d.lastModified, d.now)) return { ok: false, error: 'ถ่ายรูปใหม่ตอนนี้', resetPhoto: true };
    return { ok: true, answer: answer, pieces: pieces };
  };
  L.dailyBody = function (id, answer, foundAt, photo, lastModified, now) { return { id: id, answer: answer, foundAt: str(foundAt), photo: photo, lastModified: lastModified, clientNow: now }; };

  return L;
})();
if (typeof module !== 'undefined' && module.exports) module.exports = StockLib;

/* ======================================================================== */
/* Part 2: the page                                                         */
/* ======================================================================== */
if (typeof document !== 'undefined') (function () {
  'use strict';
  var L = StockLib;
  var ZXING_URL = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';
  var ZXING_SRI = 'sha384-BzBxP10ZE72aitqj5UMmUsbKFliP/DZqA8Wq+BNNhlIJDGoEd1tpkMYXOg9+n6sB';
  var BAR_FORMATS = ['code_128', 'code_39', 'ean_13', 'qr_code'];
  var SYNC_MS = 90000, WAIT_POLL_MS = 25000;

  var T = L.parseHash(location.hash);
  var EXEC = T ? L.execUrl(T.x) : '';
  var store = L.makeStore(function () { return window.localStorage; });
  var KQ = T ? L.storeKey('q', T.t) : '', KL = T ? L.storeKey('l', T.t) : '';

  var PIN = null;                    // memory only, never stored. null = none typed (a probe / a person with no PIN)
  var M = null, D = null;            // full-count model / daily page
  var cachedBoot = null;             // the last list this phone kept for this link (shown right after the PIN is typed)
  var verified = false, probing = false, pendingPin = null, paused = false;
  var Q = [], inflight = false, pumpTimer = null, syncTimer = null, toastTimer = null, lockTimer = null, undoMap = {};
  var ST = { q: '', shelf: '', showDone: false, tab: 'first' };
  var card = null, notes = [], prefill = {}, loadedAt = 0, noStore = false, offline = false, reloadWhenEmpty = false, lostList = [], offTimer = null;
  var KX = 'sc5.x';                  // the deployment id (execId) this phone has used successfully

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function fmt(n) { return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function today() { return (M && M.dateText) || (D && D.dateText) || ''; }
  function who() { return (M && M.counter) || (D && D.counter) || ''; }

  /* ---------------- sound, vibration, toast ---------------- */
  var actx = null;
  function unlockAudio() {   // the first tap makes the audio context usable (iOS needs a user gesture)
    try {
      var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      if (!actx) actx = new AC();
      if (actx.state === 'suspended') actx.resume();
      var b = actx.createBuffer(1, 1, 22050), s = actx.createBufferSource(); s.buffer = b; s.connect(actx.destination); s.start(0);
    } catch (e) { /* no sound: fine */ }
  }
  document.addEventListener('pointerdown', unlockAudio, { once: true, passive: true });
  document.addEventListener('touchend', unlockAudio, { once: true, passive: true });
  document.addEventListener('click', unlockAudio, { once: true, passive: true });
  function beep() {
    try {
      if (!actx) unlockAudio();
      if (!actx) return;
      if (actx.state === 'suspended') actx.resume();
      var o = actx.createOscillator(), g = actx.createGain();
      o.type = 'square'; o.frequency.value = 1500; g.gain.value = 0.08;
      o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.09);
    } catch (e) { /* no sound: fine */ }
  }
  function buzz(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) { /* ignore */ } }
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 1800);
  }

  /* ---------------- network ---------------- */
  var NET = { ok: false, code: 'NET', error: 'เชื่อมต่อไม่ได้ ตรวจสอบสัญญาณแล้วลองใหม่' };
  function api(action, extra, cb, timeoutMs, token) {
    var body = L.makeRequest(token || T.t, PIN, action, extra), ctl = null, to = null, finished = false;
    function fin(res) { if (finished) return; finished = true; clearTimeout(to); cb(res); }
    try {
      if (typeof AbortController !== 'undefined') { ctl = new AbortController(); to = setTimeout(function () { try { ctl.abort(); } catch (e) { /* ignore */ } }, timeoutMs || 30000); }
      window.fetch(EXEC, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow', credentials: 'omit', cache: 'no-store', signal: ctl ? ctl.signal : undefined })
        .then(function (r) { return r.text(); })
        .then(function (t) { fin(L.parseResponse(t)); }, function () { fin(NET); });
    } catch (e) { fin(NET); }
  }

  /* ---------------- PIN pad ---------------- */
  var padBuf = '', padBusy = false;
  function buildKeys() {
    var k = $('keys');
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].forEach(function (d) {
      var b = el('button', '', d); b.type = 'button';
      if (d === '') { b.disabled = true; b.style.visibility = 'hidden'; }
      else if (d === '⌫') { b.setAttribute('aria-label', 'ลบ'); b.addEventListener('click', function () { padBuf = padBuf.slice(0, -1); drawDots(); }); }
      else b.addEventListener('click', function () { padPress(d); });
      k.appendChild(b);
    });
  }
  function drawDots() { var d = $('dots').children; for (var i = 0; i < d.length; i++) d[i].className = i < padBuf.length ? 'on' : ''; }
  function lockKeys(on) { var b = $('keys').querySelectorAll('button'); for (var i = 0; i < b.length; i++) if (b[i].textContent !== '') b[i].disabled = on; }
  /** Shows the pad (wrong PIN / lock / first open). The queue and the lists stay in memory: nothing is lost. */
  function showPad(msg, locked) {
    camStop(); PIN = null; padBuf = ''; padBusy = false; verified = false; drawDots();
    $('app').hidden = true; $('scan').hidden = true; $('pad').hidden = false;
    $('padMsg').textContent = msg || ''; lockKeys(!!locked);
    clearTimeout(syncTimer); clearTimeout(lockTimer);
    if (locked) lockTimer = setTimeout(function () { lockKeys(false); $('padMsg').textContent = ''; }, 15 * 60 * 1000 + 3000);
  }
  function padPress(d) {
    if (padBusy || padBuf.length >= 4) return;
    padBuf += d; drawDots();
    if (padBuf.length === 4) {
      var typed = padBuf;
      if (probing) { pendingPin = typed; $('padMsg').textContent = 'กำลังตรวจรหัส…'; padBusy = true; return; }   // the "does this link need a PIN" probe is still out
      submitPin(typed);
    }
  }
  function submitPin(typed) {
    padBusy = true; PIN = typed; $('padMsg').textContent = 'กำลังตรวจรหัส…';
    if (cachedBoot && !M && !D) { showCachedUnverified(); }   // the last list shows at once; it is only usable once the server accepts the PIN
    api('boot', {}, function (res) { padBusy = false; onBoot(res, true); });
  }

  /* ---------------- boot / sync ---------------- */
  function showCachedUnverified() {
    try { acceptBoot(cachedBoot, true); } catch (e) { /* a damaged cache is just ignored */ M = null; D = null; }
  }
  function onBoot(res, fromPad) {
    var c = L.classify(res);
    if (c === 'ok') { PIN = PIN === null || PIN === undefined ? null : PIN; acceptBoot(res, false); return; }
    if (c === 'pin') {
      var locked = res.code === 'LOCK';
      if (!fromPad && !locked && !pendingPin) { return; }   // the probe: stay on the pad, nothing to say
      showPad(res.error || (fromPad ? 'รหัสไม่ถูกต้อง' : ''), locked); return;
    }
    // network / server trouble (NET, BUSY, FAULT): the PIN was never checked, so NOTHING becomes "verified" here.
    // With a kept list the person can look at it (read-only: no card, no save, no queue send) until the server has accepted a PIN in this page load.
    if (fromPad && cachedBoot) { goOffline(res.error || NET.error); return; }
    if (fromPad) { $('padMsg').textContent = res.error || NET.error; PIN = null; padBuf = ''; drawDots(); padBusy = false; return; }
  }
  function goOffline(why) {
    verified = false; offline = true;
    try { acceptBoot(cachedBoot, true); } catch (e) { M = null; D = null; }
    $('pad').hidden = true; $('app').hidden = false; render();
    clearTimeout(offTimer); offTimer = setTimeout(retryOnline, 15000);
  }
  function retryOnline() {
    clearTimeout(offTimer);
    if (!offline || PIN === null) return;
    api('boot', {}, function (res) { var c = L.classify(res); if (c === 'ok') acceptBoot(res, false); else if (c === 'pin') showPad(res.error, res.code === 'LOCK'); else offTimer = setTimeout(retryOnline, 15000); });
  }
  function probe() {
    probing = true;
    api('boot', {}, function (res) {
      probing = false;
      var c = L.classify(res);
      if (c === 'ok') { pendingPin = null; padBusy = false; acceptBoot(res, false); return; }   // a link with no PIN
      if (res && res.code === 'LOCK') { showPad(res.error, true); return; }
      if (pendingPin) { var p = pendingPin; pendingPin = null; submitPin(p); }
    }, 25000);
  }

  /** A fresh list from the server (boot or sync): replaces the model, keeps what is still waiting in the queue marked as counted. */
  function acceptBoot(res, unverified) {
    if (res.mode === 'daily') { M = null; D = res; } else { D = null; M = L.makeModel(res); }
    undoMap = {};
    Q.forEach(function (e) { overlay(e); });
    if (lostList.length) {   // entries whose photo could not be kept: the card comes back asking for a new photo
      lostList.forEach(function (e) { prefill[e.body.id] = { answer: e.body.answer, foundAt: e.body.foundAt, err: 'ต้องถ่ายรูปใหม่' }; notes.push({ id: e.rid, kind: 'err', text: 'ต้องถ่ายรูปใหม่: ' + e.label + ' (รูปที่ถ่ายไว้หายไป กรอกและถ่ายรูปใหม่แล้วส่งอีกครั้ง)' }); });
      lostList = [];
    }
    if (!unverified) {
      verified = true; paused = false; offline = false; clearTimeout(offTimer); loadedAt = Date.now();
      store.set(KX, T.x);   // from now on a link to ANOTHER deployment gets the red warning
      var s = JSON.stringify(res); cachedBoot = res;
      if (!store.set(KL, s)) noStore = true;
    }
    $('pad').hidden = true; $('app').hidden = false;
    render();
    if (!unverified) { schedSync(); pump(); }
  }
  function overlay(e) {   // a queued (not yet confirmed) save shows as done
    if (e.kind === 'fc' && M) { var u = L.applySave(M, e.body, M.counter, M.dateText); if (u) undoMap[e.rid] = u; }
    if (e.kind === 'daily' && D && D.items) D.items.forEach(function (it) { if (it.id === e.body.id && !it.done) { it.done = true; D.done = (D.done || 0) + 1; undoMap[e.rid] = { daily: it }; } });
  }
  function reboot() { api('boot', {}, function (res) { var c = L.classify(res); if (c === 'ok') acceptBoot(res, false); else if (c === 'pin') showPad(res.error, res.code === 'LOCK'); }); }

  function schedSync() {
    clearTimeout(syncTimer);
    var waiting = (M && M.state !== 'open') || (D && D.state !== 'open');
    syncTimer = setTimeout(function () { doSync(); }, waiting ? WAIT_POLL_MS : SYNC_MS);
  }
  function doSync(manual) {
    if (!verified || document.hidden || card || inflight || (Q.length && !manual)) { schedSync(); return; }
    api('sync', { v: M ? M.v : '' }, function (res) {
      var c = L.classify(res);
      if (c === 'ok') { if (res.same) { loadedAt = Date.now(); if (manual) toast('รายการเป็นปัจจุบันแล้ว'); } else if (!card) acceptBoot(res, false); }
      else if (c === 'pin') { showPad(res.error, res.code === 'LOCK'); return; }
      else if (manual) toast(res.error || NET.error);
      schedSync();
    });
  }

  /* ---------------- queue ---------------- */
  function persistQ() {
    if (!KQ) return;
    if (!Q.length) { store.del(KQ); return; }
    if (store.set(KQ, L.qSerialize(Q, true))) { noStore = false; return; }
    if (!store.set(KQ, L.qSerialize(Q, false))) noStore = true;   // photos too big for the phone's storage, or no storage at all: keep the page open
  }
  function enqueue(kind, body, label) {
    if (!verified) { toast('ยังบันทึกไม่ได้ รอให้ระบบตรวจรหัสก่อน'); return null; }   // never queue (or send) before the server has accepted a PIN in this page load
    var e = L.newEntry(kind, L.makeRid(window.crypto, Math.random), body, label, Date.now(), T.t);
    L.qAdd(Q, e); persistQ(); overlay(e); renderBadge(); pump();
    return e;
  }
  function pump() {
    clearTimeout(pumpTimer);
    if (inflight || !Q.length || !verified || paused) return;
    var now = Date.now(), e = L.qDue(Q, now);
    if (!e) { pumpTimer = setTimeout(pump, Math.max(300, Q[0].next - now)); return; }
    if (e.tok && e.tok !== T.t) { L.qDrop(Q, e.rid); persistQ(); renderBadge(); pump(); return; }   // never send under another link's token
    inflight = true;
    var extra = e.kind === 'fc' ? { rid: e.rid, entry: e.body } : (function () { var x = { rid: e.rid }; Object.keys(e.body).forEach(function (k) { x[k] = e.body[k]; }); return x; })();
    api(e.kind === 'fc' ? 'save' : 'dailySave', extra, function (res) { inflight = false; sent(e, res); }, 45000, e.tok);
  }
  function sent(e, res) {
    var c = L.classify(res);
    if (c === 'ok') {
      L.qDrop(Q, e.rid); persistQ(); delete undoMap[e.rid];
      if (e.kind === 'fc' && M && res.progress && !Q.length) { M.progress.done = res.progress.done; M.progress.total = res.progress.total; M.progress.pct = res.progress.pct; M.progress.mine = res.progress.mine; if (!card && !$('app').hidden) renderProg(); }
      if (res.replacedOther) notes.push({ id: e.rid, kind: 'info', text: 'แทนที่การนับของ ' + res.replacedOther + ' วันนี้' });
      if (e.kind === 'fc' && e.body.second) setTimeout(function () { doSync(true); }, 400);   // others may have counted too
      renderNotes();
    } else if (c === 'retry') {
      L.qRetry(Q, e.rid, Date.now()); persistQ();
    } else if (c === 'pin') {
      paused = true; showPad(res.error || '', res.code === 'LOCK'); renderBadge(); return;   // the queue stays; after the PIN it goes on
    } else {   // refused (or the mode changed): the item comes back with the reason
      L.qDrop(Q, e.rid); persistQ(); giveBack(e, res.error || 'บันทึกไม่สำเร็จ');
      if (c === 'mode') reboot();
    }
    renderBadge(); pump();
    if (reloadWhenEmpty && !Q.length) location.reload();   // another link was opened while saves were waiting: now they are all sent, start over with it
  }
  function giveBack(e, reason) {
    var u = undoMap[e.rid]; delete undoMap[e.rid];
    if (e.kind === 'fc') {
      if (u) L.revertSave(M, u);
      notes.push({ id: e.rid, kind: 'err', text: 'ไม่ได้บันทึก ' + e.label + ' — ' + reason + ' (คืนรายการแล้ว นับใหม่ได้)' });
    } else {
      var why = L.dailyRefusal(reason, Date.now() - e.born);   // a photo refusal (too old, 10-minute rule) reads "รูปเก่าเกิน 10 นาที กรุณาถ่ายรูปใหม่"
      if (u && u.daily) { u.daily.done = false; if (D) D.done = Math.max(0, (D.done || 1) - 1); prefill[e.body.id] = { answer: e.body.answer, foundAt: e.body.foundAt, err: why.text }; scrollNext = true; }
      notes.push({ id: e.rid, kind: 'err', text: 'ไม่ได้ส่ง ' + e.label + ' — ' + why.text + (why.needPhoto ? '' : ' (คืนรายการแล้ว กรอกและถ่ายรูปใหม่ได้)') });
    }
    render();
  }
  function renderBadge() {
    var b = $('qbadge');
    if (!Q.length) b.hidden = true;
    else if (L.qFailing(Q)) { b.hidden = false; b.className = 'qbadge bad'; b.textContent = 'ส่งไม่สำเร็จ ' + Q.length + ' รายการ · ลองใหม่'; }
    else { b.hidden = false; b.className = 'qbadge'; b.textContent = 'กำลังส่ง ' + Q.length; }
    renderNotes();   // the "keep this page open" warning follows the queue
  }
  function renderNotes() {
    var box = $('notes'); clear(box);
    if (offline) {
      var off = el('div', 'refused', 'ออฟไลน์ ดูรายการได้อย่างเดียว ยังบันทึกไม่ได้ จนกว่าจะเชื่อมต่อและระบบตรวจรหัสผ่าน');
      var again = el('button', 'btn alt small', 'ลองเชื่อมต่อใหม่'); again.type = 'button'; again.addEventListener('click', retryOnline);
      off.appendChild(el('div')); off.appendChild(again); box.appendChild(off);
    }
    if (Q.length && L.qFailing(Q)) box.appendChild(el('div', 'refused', 'ส่งไม่สำเร็จ ระบบจะลองส่งซ้ำเอง กรุณาเปิดหน้านี้ค้างไว้จนกว่าจะส่งครบ' + (noStore ? ' (เครื่องนี้เก็บคิวไม่ได้ ถ้าปิดหน้านี้รายการจะหาย)' : '')));
    else if (Q.length && noStore) box.appendChild(el('div', 'banner', 'เครื่องนี้เก็บคิวไว้ไม่ได้ กรุณาเปิดหน้านี้ค้างไว้จนกว่า "กำลังส่ง" จะหมด'));
    notes.forEach(function (n) {
      var d = el('div', n.kind === 'err' ? 'refused' : 'banner', n.text);
      var x = el('button', 'btn alt small', 'ปิด'); x.type = 'button';
      x.addEventListener('click', function () { notes = notes.filter(function (y) { return y !== n; }); renderNotes(); });
      d.appendChild(el('div')); d.appendChild(x); box.appendChild(d);
    });
  }

  /* ---------------- rendering: shell ---------------- */
  function render() {
    $('who').textContent = 'สวัสดี ' + who();
    $('sub').textContent = today() + (M ? ' · นับครั้งแรก' : '');
    renderBadge(); renderNotes();
    $('fcHome').hidden = !M; $('dailyHome').hidden = !D;
    if (M) renderFc(); else if (D) renderDaily();
  }

  /* ---------------- rendering: full count home ---------------- */
  function renderFc() {
    renderProg();
    $('prog').hidden = false;
    if (M.state !== 'open') { var b = $('blocked'); b.textContent = M.message || 'ยังนับไม่ได้'; b.hidden = false; $('tools').hidden = true; return; }
    $('blocked').hidden = true; $('tools').hidden = false;
    if (!card) { renderChips(); renderList(); }
  }
  function renderProg() {
    if (!M) return;
    var box = $('prog'), P = M.progress; clear(box);
    box.appendChild(el('b', '', 'นับแล้ว ' + fmt(P.done) + ' / ' + fmt(P.total) + ' รายการ (' + P.pct + '%)'));
    var bar = el('div', 'bar'), i = el('i'); i.style.width = Math.min(100, P.pct) + '%'; bar.appendChild(i); box.appendChild(bar);
    box.appendChild(el('div', 'sub', 'วันนี้ฉันนับ ' + fmt(P.mine) + ' รายการ'));
  }
  function curList() { return ST.tab === 'second' ? M.second : M.items; }
  function renderTabs() {
    $('tabFirst').setAttribute('aria-selected', ST.tab === 'first' ? 'true' : 'false');
    var t = $('tabSecond'); t.textContent = 'ต้องนับซ้ำ (' + fmt(L.secondLeft(M)) + ')'; t.setAttribute('aria-selected', ST.tab === 'second' ? 'true' : 'false');
  }
  function renderChips() {
    var sel = $('shelfSel'), shelves = L.shelvesOf(M, curList()); clear(sel);
    var o = el('option', '', 'ทุกชั้น'); o.value = ''; sel.appendChild(o);
    shelves.forEach(function (s) { var x = el('option', '', s); x.value = s; sel.appendChild(x); });
    sel.value = shelves.indexOf(ST.shelf) >= 0 ? ST.shelf : ''; if (sel.value !== ST.shelf) ST.shelf = '';
  }
  function renderList() {
    if (!M || M.state !== 'open') return;
    var box = $('list'); clear(box); renderTabs();
    var src = curList();
    if (ST.tab === 'second') {
      if (!src.length) { box.appendChild(el('div', 'msg ok', M.secondMessage || 'ตอนนี้ไม่มีรายการให้คุณนับซ้ำ')); return; }
      box.appendChild(el('div', 'sub', 'ต้องนับซ้ำ: นับให้ตรงตามที่เห็นจริง (เรียงตามความสำคัญ)'));
    } else box.appendChild(el('div', 'sub', ST.showDone ? 'ทุกรายการ (เรียงตามชั้นวาง แล้วตามรหัส)' : 'ยังไม่ได้นับ (เรียงตามชั้นวาง แล้วตามรหัส)'));
    var f = L.filterItems(M, src, { q: ST.q, shelf: ST.shelf, showDone: ST.showDone, max: 150 });
    f.rows.forEach(function (it) { box.appendChild(rowOf(it)); });
    if (f.hidden) box.appendChild(el('div', 'sub', 'ยังมีอีก ' + fmt(f.hidden) + ' รายการ - พิมพ์ค้นหาหรือเลือกชั้นวางให้แคบลง'));
    if (!f.rows.length) box.appendChild(el('div', 'msg ok', (ST.q.trim() || ST.shelf) ? 'ไม่มีรายการที่ตรงกับตัวกรอง' : (ST.tab === 'second' ? 'ตอนนี้ไม่มีรายการให้คุณนับซ้ำ' : 'ไม่เหลือรายการที่ยังไม่ได้นับ')));
  }
  function rowOf(it) {
    var part = M.parts[it.p], b = el('button', 'prow' + (it.done ? ' done' : '')); b.type = 'button';
    b.appendChild(el('div', 'nm', part.name));
    var meta = el('div', 'meta'); meta.appendChild(el('span', 'code', part.code2)); meta.appendChild(el('span', 'shelfchip', it.shelf)); b.appendChild(meta);
    if (it.done) b.appendChild(el('div', 'sub', 'นับแล้ว ' + it.on + ' · ' + it.by));
    b.addEventListener('click', function () {
      if (!verified) { toast('รอสักครู่ กำลังตรวจรหัส'); return; }
      openCard(ST.tab === 'second' ? L.cardOfSecondRow(M, it.p) : L.cardOf(M, it.p, true), it.shelf, false);
    });
    return b;
  }

  /* ---------------- part card ---------------- */
  function openCard(c, shelf, viaScan) {
    card = c;
    card.shelf = shelf === undefined ? null : shelf; card.other = false;
    if (card.shelf === null && card.shelves.length === 1) card.shelf = card.shelves[0].shelf;
    card.mode = viaScan ? 'scan' : 'type'; card.qty = 0; card.lock = ''; card.warn = ''; card.err = ''; card.camMsg = ''; card.leave = false; card.unknown = false;
    showCard();
  }
  function openUnknown(code) { card = { unknown: true, ucode: code, qty: '', ushelf: '', err: '' }; showCard(); }
  function showCard() { closeScan(); $('home').hidden = true; $('card').hidden = false; drawCard(); window.scrollTo(0, 0); }
  function backHome() { camStop(); card = null; $('card').hidden = true; $('home').hidden = false; if (M) { renderProg(); renderChips(); renderList(); } else if (D) renderDaily(); renderNotes(); }
  function shelfInfo(name) { for (var i = 0; i < card.shelves.length; i++) if (card.shelves[i].shelf === name) return card.shelves[i]; return null; }

  function drawCard() {
    camStop();
    var box = $('card'); clear(box);
    var back = el('button', 'btn alt small', card.leave ? 'ยังไม่ได้บันทึก กดอีกครั้งเพื่อกลับ' : '‹ กลับ'); back.type = 'button';
    back.addEventListener('click', function () {
      if (!card.unknown && card.mode === 'scan' && card.qty > 0 && !card.leave) { card.leave = true; drawCard(); return; }
      backHome();
    });
    box.appendChild(back); box.appendChild(el('div')).style.height = '10px';
    if (card.unknown) { drawUnknown(box); return; }

    var head = el('div', 'card');
    head.appendChild(el('div', 'code', card.code2)); var nm = el('div', '', card.name); nm.style.cssText = 'font-size:22px;font-weight:700'; head.appendChild(nm);
    if (card.shelf !== null) head.appendChild(el('span', 'shelfchip', 'ชั้น ' + card.shelf));
    box.appendChild(head);

    if (card.locked && !card.second) { box.appendChild(el('div', 'msg err', 'รายการนี้อยู่ระหว่างนับซ้ำ แจ้งเจ้าของ')); return; }   // under blind recount: no Save button, the owner unlocks it
    if (card.shelf === null) { drawShelfPicker(box); return; }

    var info = card.other ? null : shelfInfo(card.shelf);
    if (info && info.done) box.appendChild(el('div', 'banner', 'นับแล้ว ' + info.doneOn + ' โดย ' + info.doneBy + ' — นับใหม่จะแทนที่ค่าเดิม'));
    var chg = el('button', 'linkbtn', 'เปลี่ยนชั้นวาง'); chg.type = 'button';
    chg.addEventListener('click', function () { card.shelf = null; card.other = false; card.qty = 0; card.lock = ''; card.warn = ''; drawCard(); });
    box.appendChild(chg);

    var tabs = el('div', 'tabs'); tabs.setAttribute('role', 'tablist');
    [['scan', 'สแกนทีละชิ้น'], ['type', 'พิมพ์จำนวน']].forEach(function (m) {
      var b = el('button', '', m[1]); b.type = 'button'; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', card.mode === m[0] ? 'true' : 'false');
      b.addEventListener('click', function () { card.mode = m[0]; card.warn = ''; card.err = ''; card.camMsg = ''; card.leave = false; drawCard(); });
      tabs.appendChild(b);
    });
    box.appendChild(tabs);

    if (card.mode === 'scan') drawScanMode(box); else drawTypeMode(box);

    var err = el('div', card.err ? 'msg err' : ''); err.id = 'cardErr'; err.textContent = card.err || ''; box.appendChild(err);
    box.appendChild(el('div')).style.height = '8px';
    var save = el('button', 'btn big', 'บันทึก'); save.type = 'button'; save.id = 'saveBtn';
    save.addEventListener('click', function () { doSave(readQty()); }); box.appendChild(save);
    box.appendChild(el('div')).style.height = '8px';
    var zero = el('button', 'btn alt', 'ไม่พบเลย (0)'); zero.type = 'button';
    zero.addEventListener('click', function () { doSave(0); }); box.appendChild(zero);
    if (card.mode === 'scan') startPieceCamera();
  }

  function drawShelfPicker(box) {
    box.appendChild(el('h2', '', 'เลือกชั้นวาง'));
    card.shelves.forEach(function (s) {
      var b = el('button', 'shelfpick', s.shelf); b.type = 'button';
      b.appendChild(el('small', '', s.done ? 'นับแล้ว ' + s.doneOn + ' โดย ' + s.doneBy : 'ยังไม่ได้นับ'));
      b.addEventListener('click', function () { card.shelf = s.shelf; card.other = false; card.err = ''; drawCard(); });
      box.appendChild(b);
    });
    var o = el('button', 'shelfpick', 'ชั้นอื่น (ไม่มีในรายการ)'); o.type = 'button'; o.appendChild(el('small', '', 'ต้องพิมพ์ชื่อชั้นวาง'));
    var form = el('div'); form.hidden = !card.otherOpen;
    var inp = el('input'); inp.type = 'text'; inp.maxLength = 40; inp.placeholder = 'เช่น A-05'; inp.id = 'otherShelf';
    o.addEventListener('click', function () { card.otherOpen = true; form.hidden = false; inp.focus(); });
    box.appendChild(o);
    form.appendChild(el('label', 'fl', 'ชื่อชั้นวาง')); form.appendChild(inp);
    var msg = el('div'); msg.id = 'otherErr'; form.appendChild(msg);
    var ok = el('button', 'btn', 'ใช้ชั้นนี้'); ok.type = 'button'; ok.style.marginTop = '10px';
    ok.addEventListener('click', function () {
      var v = inp.value.trim();
      if (!v) { msg.className = 'msg err'; msg.textContent = 'กรุณาพิมพ์ชื่อชั้นวาง'; return; }
      card.shelf = v; card.other = true; card.err = ''; drawCard();
    });
    form.appendChild(ok); box.appendChild(form);
  }

  function drawTypeMode(box) {
    box.appendChild(el('label', 'fl', 'จำนวนชิ้นที่นับได้ (เป็นชิ้น ไม่ใช่ถุง/แพ็ค)'));
    var row = el('div', 'qtyrow');
    var minus = el('button', 'step', '−'); minus.type = 'button'; minus.setAttribute('aria-label', 'ลด');
    var inp = el('input'); inp.type = 'number'; inp.inputMode = 'numeric'; inp.min = '0'; inp.step = '1'; inp.id = 'qtyIn'; inp.value = card.qty ? String(card.qty) : '';
    var plus = el('button', 'step', '+'); plus.type = 'button'; plus.setAttribute('aria-label', 'เพิ่ม');
    minus.addEventListener('click', function () { inp.value = String(Math.max(0, (parseInt(inp.value, 10) || 0) - 1)); card.qty = +inp.value; });
    plus.addEventListener('click', function () { inp.value = String((parseInt(inp.value, 10) || 0) + 1); card.qty = +inp.value; });
    inp.addEventListener('input', function () { card.qty = Math.max(0, parseInt(inp.value, 10) || 0); });
    row.appendChild(minus); row.appendChild(inp); row.appendChild(plus); box.appendChild(row);
  }
  function readQty() {
    if (card.mode === 'type') { var v = $('qtyIn').value; return v === '' ? null : v; }
    return card.qty;
  }

  function drawScanMode(box) {
    var big = el('div', 'bigq', String(card.qty)); big.id = 'bigqty'; big.setAttribute('aria-live', 'polite'); box.appendChild(big);
    box.appendChild(el('div', 'sub', 'ชิ้นที่นับได้ (สแกนบาร์โค้ดทีละชิ้น)')).style.textAlign = 'center';
    var warn = el('div', card.warn ? 'msg err' : ''); warn.id = 'pieceWarn'; warn.textContent = card.warn; box.appendChild(warn);
    var vf = el('div', 'vf'); var video = el('video'); video.id = 'pieceVideo'; video.setAttribute('playsinline', ''); video.setAttribute('autoplay', ''); video.muted = true; vf.appendChild(video); vf.appendChild(el('div', 'frame'));
    var torch = el('button', 'torch', 'ไฟฉาย'); torch.type = 'button'; torch.id = 'pieceTorch'; torch.hidden = true; vf.appendChild(torch);
    vf.hidden = !!card.camMsg; box.appendChild(vf);
    var cm = el('div', card.camMsg ? 'msg err' : ''); cm.id = 'camMsg'; cm.textContent = card.camMsg; box.appendChild(cm);
    if (card.camMsg) {
      var lab = el('label', 'btn alt', ''); lab.appendChild(el('span', '', 'ถ่ายรูปบาร์โค้ด นับ 1 ชิ้น'));
      var f = el('input'); f.type = 'file'; f.accept = 'image/*'; f.setAttribute('capture', 'environment'); f.style.cssText = 'position:absolute;left:-9999px';
      f.addEventListener('change', function () { var file = f.files && f.files[0]; f.value = ''; if (file) decodePhoto(file, function (text, why) { if (text) onPiece(text); else pieceWarn(why || 'อ่านบาร์โค้ดจากรูปไม่ได้'); }); });
      lab.appendChild(f); box.appendChild(lab);
    }
    var g = el('div', 'gap2');
    var m = el('button', 'btn alt small', '−1'); m.type = 'button'; m.addEventListener('click', function () { card.qty = Math.max(0, card.qty - 1); card.warn = ''; setBig(); });
    var r = el('button', 'btn alt small', 'ล้าง'); r.type = 'button'; r.addEventListener('click', function () { card.qty = 0; card.lock = ''; card.warn = ''; setBig(); });
    g.appendChild(m); g.appendChild(r); box.appendChild(g);
  }
  function setBig() { var b = $('bigqty'); if (b) b.textContent = String(card.qty); var w = $('pieceWarn'); if (w) { w.textContent = card.warn; w.className = card.warn ? 'msg err' : ''; } }
  function pieceWarn(t) { if (!card) return; card.warn = t; setBig(); }

  function startPieceCamera() {
    var v = $('pieceVideo'); if (!v || card.camMsg) return;
    var mine = card;
    camStart(v, onPiece, function (msg) { if (card === mine) { card.camMsg = msg; drawCard(); } }, 700, $('pieceTorch'));
  }
  /** one scan in "scan each piece" mode: the same code adds 1 (once it left the view for ~0.7 s); a different code warns and does not count */
  function onPiece(text) {
    if (!card || card.unknown || card.mode !== 'scan') return;
    var d = L.scanDecision(card.codes, card.lock, text);
    if (d.action === 'count') { card.qty++; card.lock = d.lock; card.warn = ''; beep(); buzz(40); setBig(); }
    else if (d.action === 'wrong') { card.warn = 'บาร์โค้ดไม่ตรงกับชิ้นนี้ ไม่นับ'; beep(); buzz([80, 60, 80]); setBig(); }
  }

  function drawUnknown(box) {
    box.appendChild(el('h2', '', 'ไม่พบรหัสนี้'));
    var m = el('div', 'msg err'); m.id = 'unknownMsg'; m.appendChild(document.createTextNode('อ่านได้: ')); m.appendChild(el('span', 'code', card.ucode)); m.appendChild(document.createTextNode(' — ไม่มีในรายการอะไหล่')); box.appendChild(m);
    var c = el('div', 'card'); c.appendChild(el('div', 'sub', 'บันทึกเป็นรหัสไม่รู้จัก เพื่อให้เจ้าของตรวจสอบ'));
    c.appendChild(el('label', 'fl', 'จำนวนที่นับได้'));
    var q = el('input'); q.type = 'number'; q.inputMode = 'numeric'; q.min = '0'; q.id = 'uqty'; q.value = card.qty; c.appendChild(q);
    c.appendChild(el('label', 'fl', 'ชื่อชั้นวาง'));
    var s = el('input'); s.type = 'text'; s.maxLength = 40; s.id = 'ushelf'; s.placeholder = 'เช่น A-05'; s.value = card.ushelf; c.appendChild(s);
    var e = el('div', card.err ? 'msg err' : ''); e.textContent = card.err; c.appendChild(e);
    var b = el('button', 'btn', 'บันทึกเป็นรหัสไม่รู้จัก'); b.type = 'button'; b.id = 'unknownSave'; b.style.marginTop = '12px';
    b.addEventListener('click', function () {
      card.qty = q.value; card.ushelf = s.value.trim();
      if (card.qty === '' || !card.ushelf || isNaN(Number(card.qty)) || Number(card.qty) < 0) { card.err = 'กรุณาใส่จำนวนและชื่อชั้นวาง'; drawCard(); return; }
      if (!verified) { toast('ยังบันทึกไม่ได้ รอให้ระบบตรวจรหัสก่อน'); return; }
      var code = card.ucode, shelf = card.ushelf, qty = card.qty;
      enqueue('fc', L.unknownBody(code, shelf, qty), 'รหัสไม่รู้จัก ' + code);
      toast('บันทึกแล้ว'); backHome();
    });
    c.appendChild(b); box.appendChild(c);
  }

  /** Save = optimistic: the item leaves the list at once, the card closes, the request goes through the queue. */
  function doSave(q) {
    if (!verified) { toast('ยังบันทึกไม่ได้ รอให้ระบบตรวจรหัสก่อน'); return; }
    if (q === null || q === '' || isNaN(Number(q)) || Number(q) < 0) { card.err = 'กรุณาใส่จำนวนที่นับได้ (ไม่พบเลยให้กด "ไม่พบเลย")'; drawCard(); return; }
    var body = L.fcBody(card, q, card.mode);
    enqueue('fc', body, card.name + ' ชั้น ' + card.shelf);
    toast('บันทึกแล้ว');
    backHome();
  }

  /* ---------------- scan overlay, typed code (local lookup: no server call) ---------------- */
  function homeNote(t) { var m = $('homeMsg'); clear(m); m.appendChild(el('div', 'banner', t)); }
  function homeMsg(t, kind) { var m = $('homeMsg'); clear(m); if (t) m.appendChild(el('div', 'msg ' + kind, t)); }
  function openScan() {
    if (!verified) { toast('รอสักครู่ กำลังตรวจรหัส'); return; }
    homeMsg('', '');
    $('scan').hidden = false; $('scanNote').textContent = 'เล็งบาร์โค้ดให้อยู่ในกรอบ';
    camStart($('scanVideo'), function (text) { camStop(); $('scan').hidden = true; beep(); buzz(40); lookup(text, true); },
      function (msg) { $('scanNote').textContent = msg; }, 700, $('scanTorch'));
  }
  function closeScan() { camStop(); $('scan').hidden = true; }
  function lookup(code, viaScan) {
    if (!verified) { toast('รอสักครู่ กำลังตรวจรหัส'); return; }
    homeMsg('', '');
    var p = L.findPart(M, code);
    if (p >= 0) { var c = L.cardOf(M, p, false); openCard(c, undefined, !!viaScan); }
    else openUnknown(String(code).trim());
  }
  function goCode() { var v = $('codeIn').value; if (!v.trim()) return; $('codeIn').value = ''; lookup(v, false); }

  /* ---------------- camera (live) with photo fallback ---------------- */
  var cam = { stream: null, timer: null, reader: null, gate: null, torch: false }, camRun = 0, zxLoading = null;
  function makeDetector() {
    try {
      if (!('BarcodeDetector' in window)) return null;
      try { return new window.BarcodeDetector({ formats: BAR_FORMATS }); } catch (e1) { return new window.BarcodeDetector(); }
    } catch (e) { return null; }
  }
  function loadZXing(cb) {
    if (window.ZXing) { cb(true); return; }
    if (zxLoading) { zxLoading.push(cb); return; }
    zxLoading = [cb];
    var done = function (ok) { var l = zxLoading; zxLoading = null; l.forEach(function (f) { f(ok); }); };
    try {
      var s = document.createElement('script');
      s.src = ZXING_URL; s.integrity = ZXING_SRI; s.crossOrigin = 'anonymous';
      s.onload = function () { done(!!window.ZXing); };
      s.onerror = function () { done(false); };
      document.head.appendChild(s);
    } catch (e) { done(false); }
  }
  function zxHints() {
    var h = new Map(), F = window.ZXing.BarcodeFormat;
    h.set(window.ZXing.DecodeHintType.POSSIBLE_FORMATS, [F.CODE_128, F.CODE_39, F.EAN_13, F.QR_CODE]);
    h.set(window.ZXing.DecodeHintType.TRY_HARDER, true);
    return h;
  }
  function camMessage(e) {
    var n = e && e.name ? e.name : '';
    if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError') return 'เปิดกล้องไม่ได้ (ยังไม่ได้อนุญาตกล้อง) กรุณาอนุญาตกล้องให้เว็บนี้ในการตั้งค่าของเบราว์เซอร์ หรือใช้ปุ่ม "ถ่ายรูปบาร์โค้ด" หรือพิมพ์รหัสแทน';
    if (n === 'NotFoundError' || n === 'DevicesNotFoundError') return 'ไม่พบกล้องในเครื่องนี้ ใช้ปุ่ม "ถ่ายรูปบาร์โค้ด" หรือพิมพ์รหัสแทน';
    if (e && e.message === 'nolib') return 'โหลดตัวอ่านบาร์โค้ดไม่ได้ (ตรวจอินเทอร์เน็ต) ใช้ปุ่ม "ถ่ายรูปบาร์โค้ด" หรือพิมพ์รหัสแทน';
    return 'เปิดกล้องสดไม่ได้ ใช้ปุ่ม "ถ่ายรูปบาร์โค้ด" หรือพิมพ์รหัสแทน';
  }
  /** one decode callback: text = the code in view ('' = nothing). StockLib.makeGate decides (consecutive empty callbacks AND a time floor) whether it counts. */
  function gate(text, onCode) {
    if (cam.gate && cam.gate.feed(text, Date.now())) { try { onCode(text); } catch (e) { /* ignore */ } }
  }
  function camStop() {
    camRun++;
    clearTimeout(cam.timer); cam.timer = null;
    try { if (cam.reader) cam.reader.reset(); } catch (e) { /* ignore */ }
    cam.reader = null;
    try { if (cam.stream) cam.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ignore */ }
    cam.stream = null; cam.torch = false;
    var vs = document.querySelectorAll('video'); for (var i = 0; i < vs.length; i++) { try { vs[i].srcObject = null; } catch (e) { /* ignore */ } }
    var tb = document.querySelectorAll('.torch'); for (var j = 0; j < tb.length; j++) { tb[j].hidden = true; tb[j].classList.remove('on'); }
  }
  /** shows the torch button only when the camera track can do it */
  function setupTorch(stream, btn) {
    if (!btn) return;
    try {
      var track = stream.getVideoTracks()[0], caps = track && track.getCapabilities ? track.getCapabilities() : null;
      if (!caps || !caps.torch) return;
      btn.hidden = false;
      btn.onclick = function () {
        cam.torch = !cam.torch;
        try { track.applyConstraints({ advanced: [{ torch: cam.torch }] }).then(function () { btn.classList.toggle('on', cam.torch); }, function () { cam.torch = false; btn.hidden = true; }); } catch (e) { cam.torch = false; btn.hidden = true; }
      };
    } catch (e) { /* no torch: fine */ }
  }
  function camStart(video, onCode, onFail, rearmMs, torchBtn) {
    camStop();
    var run = camRun;
    cam.gate = L.makeGate(rearmMs || 700);
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('nocam');
      navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false }).then(function (stream) {
        if (run !== camRun) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
        cam.stream = stream; video.srcObject = stream; setupTorch(stream, torchBtn);
        var p = video.play(); if (p && p.catch) p.catch(function () { /* autoplay refused: the stream still decodes */ });
        var det = makeDetector();
        if (det) { nativeLoop(det, video, run, onCode); return; }
        loadZXing(function (ok) {
          if (run !== camRun) return;
          if (!ok) { camStop(); onFail(camMessage(new Error('nolib'))); return; }
          try {
            cam.reader = new window.ZXing.BrowserMultiFormatReader(zxHints(), 300);
            // every callback (a read, or "nothing found") goes through the gate; there is NO separate timer deciding that the code left the view
            var pr = cam.reader.decodeFromStream(stream, video, function (res) { if (run === camRun) gate(res ? res.getText() : '', onCode); });
            if (pr && typeof pr.catch === 'function') pr.catch(function (e) { if (run === camRun) { camStop(); onFail(camMessage(e)); } });
          } catch (e) { camStop(); onFail(camMessage(e)); }
        });
      }).catch(function (e) { if (run === camRun) { camStop(); onFail(camMessage(e)); } });
    } catch (e) { camStop(); onFail(camMessage(e)); }
  }
  function nativeLoop(det, video, run, onCode) {
    (function tick() {
      if (run !== camRun) return;
      var next = function () { if (run === camRun) cam.timer = setTimeout(tick, 120); };
      try {
        det.detect(video).then(function (r) { if (run === camRun) gate(r && r.length ? r[0].rawValue : '', onCode); next(); }, next);
      } catch (e) { next(); }
    })();
  }
  /** photo of a barcode -> text, decoded on the phone (cb(text) or cb('', thaiReason)) */
  function decodePhoto(file, cb) {
    var url = URL.createObjectURL(file), img = new Image();
    img.onload = function () {
      try {
        var s = Math.min(1, 1600 / Math.max(img.width, img.height)), c = document.createElement('canvas');
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        var det = makeDetector(), viaZX = function () { photoZX(c, cb); };
        if (det) det.detect(c).then(function (r) { if (r && r.length && r[0].rawValue) cb(r[0].rawValue); else viaZX(); }, viaZX);
        else viaZX();
      } catch (e) { cb('', 'อ่านรูปไม่ได้ ถ่ายใหม่หรือพิมพ์รหัสแทน'); }
    };
    img.onerror = function () { URL.revokeObjectURL(url); cb('', 'อ่านรูปไม่ได้ ถ่ายใหม่หรือพิมพ์รหัสแทน'); };
    img.src = url;
  }
  function photoZX(canvas, cb) {
    loadZXing(function (ok) {
      if (!ok) { cb('', 'โหลดตัวอ่านบาร์โค้ดไม่ได้ (ตรวจอินเทอร์เน็ต) พิมพ์รหัสแทน'); return; }
      try {
        var reader = new window.ZXing.BrowserMultiFormatReader(zxHints());
        reader.decodeFromImageUrl(canvas.toDataURL('image/jpeg', 0.92)).then(function (r) { cb(r.getText()); }, function () { cb('', 'อ่านบาร์โค้ดจากรูปไม่ได้ ถ่ายใหม่ให้ชัดขึ้น หรือพิมพ์รหัสแทน'); });
      } catch (e) { cb('', 'อ่านบาร์โค้ดจากรูปไม่ได้ พิมพ์รหัสแทน'); }
    });
  }

  /* ---------------- daily random count (same app, same queue) ---------------- */
  function renderDaily() {
    var page = D, top = $('dTop'), list = $('dList'); clear(top); clear(list);
    $('sub').textContent = page.dateText + (page.total ? ' · นับแล้ว ' + page.done + '/' + page.total : '');
    if (page.state !== 'open') {
      list.appendChild(el('div', 'big-msg', page.message || 'โหลดไม่สำเร็จ'));
      return;
    }
    top.appendChild(el('div', 'sub', page.message));
    var next = null;
    page.items.forEach(function (it) { var c = it.done ? dailyDone(it) : dailyCard(it); if (!it.done && !next) next = c; list.appendChild(c); });
    if (scrollNext && next && next.scrollIntoView) { scrollNext = false; next.scrollIntoView({ block: 'start' }); }
  }
  var scrollNext = false;
  function dailyDone(it) {
    var c = el('div', 'card done');
    c.appendChild(el('span', 'tick', '✓'));
    c.appendChild(el('span', '', it.shelf.split(' · ')[0] + ' · ' + it.name));
    return c;
  }
  function numInput(ph) { var i = el('input'); i.type = 'number'; i.inputMode = 'numeric'; i.min = '0'; i.step = '1'; i.placeholder = ph || ''; return i; }
  // Resize to max 1024px JPEG (~0.7) so photos stay small on cheap phones.
  function shrink(file, cb) {
    var url = URL.createObjectURL(file), img = new Image();
    img.onload = function () {
      var s = Math.min(1, 1024 / Math.max(img.width, img.height)), c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      cb(c.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = function () { URL.revokeObjectURL(url); cb(null); };
    img.src = url;
  }
  function dailyCard(it) {
    var c = el('div', 'card'), st = { photo: null, lastModified: 0 }, pf = prefill[it.id] || {};
    c.appendChild(el('p', 'name', it.name));
    c.appendChild(el('div', 'code', it.code2));
    c.appendChild(el('div', 'shelf', 'ที่เก็บตามระบบ: ' + it.shelf));
    if (it.seen && it.seen.length) c.appendChild(el('div', 'seen', 'เคยมีคนเจอที่: ' + it.seen.join(' · ')));
    var qty, crates, per, loose, total;
    c.appendChild(el('div', 'hint', 'นับเป็นชิ้น ไม่ใช่ถุง/แพ็ค รวมทุกที่ที่เจอ'));
    if (it.bulk) {
      c.appendChild(el('div', 'hint', 'นับเป็นลัง×ชิ้นต่อลัง + เศษ'));
      var g = el('div', 'row3'); c.appendChild(g);
      [['ลัง', 'crates'], ['ชิ้น/ลัง', 'per'], ['เศษ', 'loose']].forEach(function (d) {
        var box = el('div'); box.appendChild(el('label', '', d[0]));
        var i = numInput('0'); i.className = 'qty'; box.appendChild(i); g.appendChild(box);
        if (d[1] === 'crates') crates = i; else if (d[1] === 'per') per = i; else loose = i;
      });
      if (pf.answer) { crates.value = pf.answer.crates || ''; per.value = pf.answer.perCrate || ''; loose.value = pf.answer.loose || ''; }
      total = el('div', 'total', 'รวม 0 ชิ้น'); c.appendChild(total);
      var recalc = function () { total.textContent = 'รวม ' + ((+crates.value || 0) * (+per.value || 0) + (+loose.value || 0)) + ' ชิ้น'; };
      [crates, per, loose].forEach(function (i) { i.addEventListener('input', recalc); }); recalc();
    } else {
      c.appendChild(el('label', 'sub', 'จำนวนชิ้นที่เจอทั้งหมด ในทุกที่ (ไม่เจอเลยให้ใส่ 0)'));
      qty = numInput('0'); qty.className = 'qty'; if (pf.answer && pf.answer.qty !== undefined) qty.value = pf.answer.qty; c.appendChild(qty);
    }
    var fld = el('div', 'field'); c.appendChild(fld);
    var pick = el('label', 'btn alt', ''); var pl = el('span', '', '📷 ถ่ายรูป'); pick.appendChild(pl); fld.appendChild(pick);
    var file = el('input'); file.type = 'file'; file.accept = 'image/*'; file.setAttribute('capture', 'environment'); file.style.position = 'absolute'; file.style.left = '-9999px'; pick.appendChild(file);
    var prev = el('img', 'photo-prev'); prev.alt = ''; fld.appendChild(prev);
    var foundAt = el('input'); foundAt.type = 'text'; foundAt.placeholder = 'เจอที่ไหนบ้าง (จำเป็นถ้านับได้มากกว่า 0)'; foundAt.maxLength = 80; foundAt.value = pf.foundAt || '';
    foundAt.setAttribute('aria-label', 'เจอที่ไหนบ้าง'); foundAt.style.marginTop = '12px'; c.appendChild(foundAt);
    var err = el('div', 'msg err'); err.hidden = true; c.appendChild(err);
    function showErr(t) { err.textContent = t; err.hidden = !t; }
    if (pf.err) showErr(pf.err);
    var send = el('button', 'btn', 'ส่งรายการนี้'); send.type = 'button'; send.style.marginTop = '12px'; c.appendChild(send);
    function resetPhoto() { st.photo = null; st.lastModified = 0; prev.style.display = 'none'; pl.textContent = '📷 ถ่ายรูป'; file.value = ''; }
    file.addEventListener('change', function () {
      showErr('');
      var f = file.files[0];
      if (!f) return;
      if (L.photoTooOld(f.lastModified, Date.now())) { resetPhoto(); showErr('ถ่ายรูปใหม่ตอนนี้'); return; }
      shrink(f, function (data) {
        if (!data) { resetPhoto(); showErr('อ่านรูปไม่ได้ ถ่ายรูปใหม่ตอนนี้'); return; }
        st.photo = data; st.lastModified = f.lastModified;
        prev.src = data; prev.style.display = 'block'; pl.textContent = '📷 ถ่ายใหม่';
      });
    });
    send.addEventListener('click', function () {
      if (!verified) { showErr('รอสักครู่ กำลังตรวจรหัส'); return; }
      showErr('');
      var now = Date.now();
      var chk = L.dailyCheck({ bulk: it.bulk, qty: qty && qty.value, crates: crates && crates.value, per: per && per.value, loose: loose && loose.value, foundAt: foundAt.value, photo: st.photo, lastModified: st.lastModified, now: now });
      if (!chk.ok) { if (chk.resetPhoto) resetPhoto(); showErr(chk.error); return; }
      delete prefill[it.id];
      enqueue('daily', L.dailyBody(it.id, chk.answer, foundAt.value, st.photo, st.lastModified, now), it.name);
      scrollNext = true; toast('บันทึกแล้ว'); renderDaily();
    });
    return c;
  }

  /* ---------------- events ---------------- */
  function wire() {
    $('scanBtn').addEventListener('click', openScan);
    $('scanClose').addEventListener('click', closeScan);
    $('scanFile').addEventListener('change', function () {
      var f = this.files && this.files[0]; this.value = '';
      if (!f) return;
      $('scanNote').textContent = 'กำลังอ่านรูป…';
      decodePhoto(f, function (text, why) { if (text) { closeScan(); beep(); lookup(text, true); } else $('scanNote').textContent = why || 'อ่านบาร์โค้ดจากรูปไม่ได้'; });
    });
    $('tabFirst').addEventListener('click', function () { ST.tab = 'first'; ST.shelf = ''; renderChips(); renderList(); });
    $('tabSecond').addEventListener('click', function () { ST.tab = 'second'; ST.shelf = ''; renderChips(); renderList(); });
    $('codeGo').addEventListener('click', goCode);
    $('codeIn').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); goCode(); } });
    $('shelfSel').addEventListener('change', function () { ST.shelf = this.value; renderList(); });
    $('q').addEventListener('input', function () { ST.q = this.value; renderList(); });
    $('showDone').addEventListener('change', function () { ST.showDone = this.checked; renderList(); });
    $('refresh').addEventListener('click', function () { if (!card) doSync(true); else toast('บันทึกหรือกลับก่อน แล้วค่อยรีเฟรช'); });
    $('qbadge').addEventListener('click', function () { if (Q.length) { Q.forEach(function (e) { e.next = 0; }); pump(); toast('กำลังลองส่งใหม่'); } });
    // the camera must never stay on: closed with the scan sheet, and whenever the page is hidden or left
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { camStop(); return; }
      if (card) { if (!card.unknown && card.mode === 'scan' && !card.camMsg && !card.locked) drawCard(); return; }
      if (verified && Date.now() - loadedAt > 60000) doSync(false);
      pump();
    });
    window.addEventListener('pagehide', camStop);
    // another link opened in this tab (a shared phone): ALWAYS start over with it. If the waiting saves exist only in memory (no storage), nothing may be lost:
    // the app is hidden ("รอส่งข้อมูลให้เสร็จก่อน") until they are sent, then the page reloads.
    window.addEventListener('hashchange', function () {
      if (noStore && Q.length) { reloadWhenEmpty = true; $('app').hidden = true; $('pad').hidden = true; $('xwarn').hidden = true; $('waitq').hidden = false; return; }
      location.reload();
    });
    window.addEventListener('online', function () { Q.forEach(function (e) { e.next = 0; }); pump(); });
    window.addEventListener('beforeunload', function (ev) { if (Q.length) { ev.preventDefault(); ev.returnValue = ''; return ''; } });
  }

  function start() {
    if (L.isLineBrowser(navigator.userAgent)) $('linebanner').hidden = false;   // LINE's in-app browser cannot use the camera
    if (!T) { $('nolink').hidden = false; return; }
    buildKeys(); wire();
    var all = L.qParse(store.get(KQ), T.t);
    lostList = all.filter(function (e) { return e.lostPhoto; });
    Q = all.filter(function (e) { return !e.lostPhoto; });
    if (lostList.length) persistQ();
    try { var raw = store.get(KL); cachedBoot = raw ? JSON.parse(raw) : null; } catch (e) { cachedBoot = null; }
    // a link to ANOTHER deployment than the one this phone used before: a red warning, no pad (nothing is sent), until a deliberate second tap
    if (L.checkExec(store.get(KX), T.x) === 'differs') {
      cachedBoot = null; $('xwarn').hidden = false;
      var go = $('xgo'), confirmed = false;
      go.addEventListener('click', function () {
        if (!confirmed) { confirmed = true; go.textContent = 'แตะอีกครั้งเฉพาะเมื่อเจ้าของส่งลิงก์นี้ให้คุณจริงๆ'; return; }
        $('xwarn').hidden = true; showPad('', false); probe();
      });
      return;
    }
    showPad('', false);
    probe();
  }
  start();
})();
