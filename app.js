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
  /** 'ok' | 'pin' (ask for the PIN again - or to set it first when code is SETPIN - keep the queue) | 'retry' (try again later) | 'mode' (the server switched mode) | 'refused' (a real no) */
  L.classify = function (res) {
    if (!res || typeof res !== 'object') return 'retry';
    if (res.ok === true) return 'ok';
    switch (res.code) {
      case 'PIN': case 'LOCK': case 'SETPIN': return 'pin';   // SETPIN = a valid link whose PIN is not set yet: the pad opens in "choose your code" mode
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
      loc: str(b.loc), locs: (b.locs || []).map(str),
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
   * Suggestions while a code is typed. Returns { list, shown, total }: `list` = up to `max` (default 8) part indexes whose normalised code2 or code1 (part.codes, the data
   * findPart uses; every part, counted or not) START with the typed text first, then those that CONTAIN it; each group is in order of the code that matched (then file
   * order). `shown[i]` = the code that matched for list[i], as written in the data (what the row displays). `total` = how many parts match in all (more than the list when capped).
   * The text goes through normScan (dashes, spaces, case do not matter); fewer than 2 normalised characters -> nothing.
   */
  L.suggestMatches = function (m, text, max) {
    var n = L.normScan(text), lim = max === undefined ? 8 : max, starts = [], inside = [], i, j, none = { list: [], shown: [], total: 0 };
    if (n.length < 2 || !m || !m.parts) return none;
    for (i = 0; i < m.parts.length; i++) {
      var part = m.parts[i], codes = part.codes, hit = null, k;
      for (j = 0; j < codes.length; j++) {
        k = codes[j].indexOf(n);
        if (k === 0) { hit = { p: i, code: codes[j], at: 0 }; break; }
        if (k > 0 && !hit) hit = { p: i, code: codes[j], at: k };
      }
      if (hit) (hit.at === 0 ? starts : inside).push(hit);
    }
    function byCode(a, b) { return a.code < b.code ? -1 : a.code > b.code ? 1 : a.p - b.p; }
    var all = starts.sort(byCode).concat(inside.sort(byCode)), cut = lim > 0 ? all.slice(0, lim) : [];
    function written(h) {   // the matched code as the data spells it (code2, else code1 without its leading apostrophe)
      var pt = m.parts[h.p];
      return L.normScan(pt.code2) === h.code ? pt.code2 : str(pt.c1).replace(/^['\u2018\u2019\u02bc`]+/, '');
    }
    return { list: cut.map(function (h) { return h.p; }), shown: cut.map(written), total: all.length };
  };
  /** Just the part indexes of L.suggestMatches. */
  L.suggestCodes = function (m, text, max) { return L.suggestMatches(m, text, max).list; };

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
  L.fcBody = function (card, qty, mode, loc) {
    var b = { id: card.id, qty: String(qty), mode: mode === 'scan' ? 'scan' : 'type' };
    if (loc) b.loc = loc;   // a roaming person's chosen location (everybody else's is decided by the server)
    if (card.second) b.second = true;
    if (card.other) b.otherShelf = card.shelf; else b.shelf = card.shelf;
    return b;
  };
  L.unknownBody = function (code, shelf, qty, loc) { var b = { unknown: true, unknownCode: code, unknownShelf: shelf, qty: String(qty), mode: 'type' }; if (loc) b.loc = loc; return b; };
  /** The header text under the name: date, the mode, and the location the person counts at today ("สนง.ใหญ่", a branch). */
  L.headerSub = function (date, fullcount, loc) { return str(date) + (fullcount ? ' · นับครั้งแรก' : '') + (str(loc) ? ' · ' + str(loc) : ''); };
  /** The location list a roaming person may pick from, or [] when there is nothing to pick (fewer than 2). */
  L.locChoices = function (locs, current) {
    var out = (locs || []).map(str).filter(Boolean);
    if (current && out.indexOf(str(current)) < 0 && out.length) out.push(str(current));
    return out.length > 1 ? out : [];
  };

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

  /* ---- live scanning: only 1D barcodes, only plausible part codes ---- */
  // Yamalube labels carry a QR (a web link) next to the 1D barcode. The live camera reads ONLY the 1D formats; QR is allowed in the photo path alone.
  L.ONE_D_NATIVE = ['code_128', 'code_39', 'code_93', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf', 'codabar'];   // BarcodeDetector names
  L.ONE_D_ZX = ['CODE_128', 'CODE_39', 'CODE_93', 'EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'ITF', 'CODABAR'];       // ZXing BarcodeFormat names
  /** ZXing hints: 1D formats only (QR added only when withQr), TRY_HARDER on. ZX = the ZXing global. */
  L.zxHints = function (ZX, withQr) {
    var h = new Map(), F = ZX.BarcodeFormat, list = L.ONE_D_ZX.map(function (n) { return F[n]; });
    if (withQr) list.push(F.QR_CODE);
    h.set(ZX.DecodeHintType.POSSIBLE_FORMATS, list);
    h.set(ZX.DecodeHintType.TRY_HARDER, true);
    return h;
  };
  /** Decodes one luminance source (a canvas source in the page) with ZXing's MultiFormatReader: the text, or '' when nothing was found. */
  L.zxDecodeSource = function (ZX, source, hints) {
    try {
      var bitmap = new ZX.BinaryBitmap(new ZX.HybridBinarizer(source)), reader = new ZX.MultiFormatReader();
      return str(reader.decode(bitmap, hints).getText());
    } catch (e) { return ''; }
  };
  /** The part of the video that is decoded: a wide, short band in the middle (90% of the width x 35% of the height), at the video's full resolution. */
  L.bandRect = function (vw, vh) {
    var sw = Math.max(1, Math.round(vw * 0.9)), sh = Math.max(1, Math.round(vh * 0.35));
    return { sx: Math.round((vw - sw) / 2), sy: Math.round((vh - sh) / 2), sw: sw, sh: sh };
  };
  /** A native BarcodeDetector answer ([{rawValue, format}]) -> the first 1D read ('' when there is only a QR or nothing) */
  L.pickLive = function (results) {
    var r = (results || []).filter(function (x) { return x && x.rawValue && L.ONE_D_NATIVE.indexOf(x.format) >= 0; })[0];
    return r ? str(r.rawValue) : '';
  };
  /** Photo path: when a photo holds both a 1D barcode and a QR, the 1D one wins; a QR alone is still returned. */
  L.preferOneD = function (results) {
    var all = (results || []).filter(function (x) { return x && x.rawValue; });
    var one = all.filter(function (x) { return L.ONE_D_NATIVE.indexOf(x.format) >= 0; })[0] || all[0];
    return one ? str(one.rawValue) : '';
  };
  /** A read that can be a part code: no link, and after normScan only A-Z / 0-9, 5 to 20 characters. */
  L.isPlausibleCode = function (text) {
    var raw = str(text);
    if (/:\/\/|www\./i.test(raw)) return false;
    return /^[A-Z0-9]{5,20}$/.test(L.normScan(raw));
  };
  /** A typed code long enough to be a whole part code (a plausible code of 12+ normalised characters, e.g. 90793-AT479-00): if it is not in the list it is an unlisted product, not a half-typed search. */
  L.isFullCode = function (text) {
    return L.isPlausibleCode(text) && L.normScan(text).length >= 12;
  };
  /** 'empty' (nothing read) | 'ignored' (something read that is not a part code: silently dropped) | 'plausible' (+ n = its normalised text) */
  L.readClass = function (text) {
    if (!str(text)) return { kind: 'empty', n: '' };
    if (!L.isPlausibleCode(text)) return { kind: 'ignored', n: '' };
    return { kind: 'plausible', n: L.normScan(text) };
  };
  /** The "not found" card needs the same plausible code twice in a row (a different plausible code starts the count again; empty frames do not reset it). */
  L.makeConfirm = function () {
    var c = { last: '', n: 0 };
    c.add = function (norm) { if (norm === c.last) c.n++; else { c.last = norm; c.n = 1; } return c.n >= 2; };
    c.reset = function () { c.last = ''; c.n = 0; };
    return c;
  };
  /** After afterMs (4 s) of only ignored reads the viewfinder hint shows; a plausible read, or 2.5 s without any ignored read, hides it again. feed(kind, nowMs) -> show? */
  L.makeIgnoreHint = function (afterMs, quietMs) {
    afterMs = afterMs || 4000; quietMs = quietMs || 2500;
    var h = { since: 0, last: 0 };
    h.feed = function (kind, now) {
      if (kind === 'plausible') { h.since = 0; h.last = 0; return false; }
      if (kind === 'ignored') { if (!h.since || now - h.last > quietMs) h.since = now; h.last = now; }
      else if (h.since && now - h.last > quietMs) h.since = 0;
      return h.since > 0 && now - h.since >= afterMs;
    };
    return h;
  };
  /** Camera zoom: from the track capabilities ({zoom:{min,max,step}}) -> {min, max, def}; def = about 2x (or the maximum when it is lower). null when the camera cannot zoom. */
  L.zoomPlan = function (caps) {
    var z = caps && caps.zoom;
    if (!z || typeof z !== 'object' || !(Number(z.max) > Number(z.min))) return null;
    var min = Number(z.min) || 1, max = Number(z.max);
    return { min: min, max: max, def: Math.max(min, Math.min(2, max)) };
  };
  L.zoomLabel = function (z) { return (Math.round(z * 10) / 10) + '×'; };
  L.HINT_1D = 'เล็งที่บาร์โค้ดแท่ง (เส้นขาวดำ) ไม่ใช่ QR';

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
  /** Checks one daily card before it is queued (the same messages as the old page). d: {crates, per, loose, foundAt, photo, lastModified, now} (qty only for a plain entry) */
  L.dailyCheck = function (d) {
    var answer, pieces;
    if (d.qty === undefined || d.qty === null || d.crates !== undefined || d.per !== undefined || d.loose !== undefined) {   // the page always sends the crates x per-crate + loose entry (the plain qty form is only kept for the checks)
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
  var ST = { q: '', shelf: '', showDone: false, tab: 'first', expanded: false };
  var card = null, notes = [], prefill = {}, loadedAt = 0, noStore = false, offline = false, reloadWhenEmpty = false, lostList = [], offTimer = null;
  var KX = 'sc5.x';                  // the deployment id (execId) this phone has used successfully

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  /** a Lucide icon from the sprite in index.html (decorative); a plain <i> where SVG is not available */
  function ic(name, cls) {
    var NS = 'http://www.w3.org/2000/svg';
    if (!document.createElementNS) return el('i', 'ic' + (cls ? ' ' + cls : ''));
    var s = document.createElementNS(NS, 'svg'), u = document.createElementNS(NS, 'use');
    s.setAttribute('class', 'ic' + (cls ? ' ' + cls : '')); s.setAttribute('aria-hidden', 'true');
    u.setAttribute('href', '#i-' + name); s.appendChild(u); return s;
  }
  function btn(cls, text) { var b = el('button', cls, text); b.type = 'button'; return b; }
  /** an outlined field with a floating label around an existing input */
  function ofield(id, label, input) {
    var d = el('div', 'of'), l = el('label', '', label); l.setAttribute('for', id); input.id = id;
    d.appendChild(l); d.appendChild(input); return d;
  }
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
  var pickLoc = '';   // v7: the location a roaming person picked (empty = the server decides)
  function api(action, extra, cb, timeoutMs, token) {
    if (pickLoc && (action === 'boot' || action === 'sync' || action === 'daily')) { var ex = {}; Object.keys(extra || {}).forEach(function (k) { ex[k] = extra[k]; }); ex.loc = pickLoc; extra = ex; }
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
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'ลบ'].forEach(function (d) {
      var b = el('button', '', d); b.type = 'button';
      if (d === '') { b.disabled = true; b.style.visibility = 'hidden'; }
      else if (d === 'ลบ') { b.className = 'del'; b.setAttribute('aria-label', 'ลบ'); b.addEventListener('click', function () { padBuf = padBuf.slice(0, -1); drawDots(); }); }
      else b.addEventListener('click', function () { padPress(d); });
      k.appendChild(b);
    });
  }
  function drawDots() { var d = $('dots').children; for (var i = 0; i < d.length; i++) d[i].className = i < padBuf.length ? 'on' : ''; }
  function lockKeys(on) { var b = $('keys').querySelectorAll('button'); for (var i = 0; i < b.length; i++) if (b[i].textContent !== '') b[i].disabled = on; }
  /** Shows the pad (wrong PIN / lock / first open). The queue and the lists stay in memory: nothing is lost. */
  var setMode = '', firstPin = '';   // setMode: '' = ordinary PIN pad, 'enter' = choose a code, 'confirm' = type it again (the first one stays in memory only, like the PIN)
  var SET_TXT = { '': 'ใส่รหัส PIN 4 หลัก', enter: 'ตั้งรหัส 4 หลัก', confirm: 'ยืนยันรหัสอีกครั้ง' };
  function drawSetMode() { $('padSub').textContent = SET_TXT[setMode]; $('padBack').hidden = setMode !== 'confirm'; }
  function showPad(msg, locked, set) {
    camStop(); PIN = null; padBuf = ''; padBusy = false; verified = false; drawDots();
    setMode = set ? 'enter' : ''; firstPin = ''; drawSetMode();
    $('app').hidden = true; $('scan').hidden = true; $('pad').hidden = false;
    $('padMsg').textContent = msg || ''; lockKeys(!!locked);
    clearTimeout(syncTimer); clearTimeout(lockTimer);
    if (locked) lockTimer = setTimeout(function () { lockKeys(false); $('padMsg').textContent = ''; }, 15 * 60 * 1000 + 3000);
  }
  function padPress(d) {
    if (padBusy || padBuf.length >= 4) return;
    padBuf += d; drawDots();
    if (padBuf.length === 4 && setMode) { setPress(padBuf); return; }
    if (padBuf.length === 4) {
      var typed = padBuf;
      if (probing) { pendingPin = typed; $('padMsg').textContent = 'กำลังตรวจรหัส…'; padBusy = true; return; }   // the "does this link need a PIN" probe is still out
      submitPin(typed);
    }
  }
  /** Four digits typed while choosing a code: remember them, ask again; if the two differ start over; if they match save them and go straight in. */
  function setPress(typed) {
    if (setMode === 'enter') {
      firstPin = typed; setMode = 'confirm'; padBuf = ''; drawDots(); drawSetMode(); $('padMsg').textContent = ''; return;
    }
    if (typed !== firstPin) {
      firstPin = ''; setMode = 'enter'; padBuf = ''; drawDots(); drawSetMode(); $('padMsg').textContent = 'รหัสไม่ตรงกัน ลองใหม่'; return;
    }
    padBusy = true; PIN = typed; $('padMsg').textContent = 'กำลังบันทึกรหัส…';
    api('setpin', {}, function (res) {
      if (res && res.ok === true) { setMode = ''; firstPin = ''; drawSetMode(); padBuf = ''; drawDots(); submitPin(typed); return; }   // saved: boot as logged in with it
      if (res && (res.code === 'BAD' || res.code === 'SETPIN')) { PIN = null; firstPin = ''; setMode = 'enter'; padBuf = ''; drawDots(); drawSetMode(); padBusy = false; $('padMsg').textContent = res.error || 'บันทึกรหัสไม่สำเร็จ ลองใหม่'; return; }   // a plain no: choose again
      // the reply was lost (network / timeout / busy) or says PIN needed (the save may have landed, or another phone set one): try to go in with the code just typed first
      setMode = ''; firstPin = ''; drawSetMode(); $('padMsg').textContent = 'กำลังตรวจรหัส…';
      api('boot', {}, function (r) {
        var c = L.classify(r);
        if (c === 'ok') { padBusy = false; padBuf = ''; drawDots(); acceptBoot(r, false); return; }
        if (c === 'pin' && r.code === 'LOCK') { showPad(r.error, true); return; }
        if (c === 'pin' && r.code === 'SETPIN') { showPad('บันทึกรหัสไม่สำเร็จ ลองใหม่', false, true); return; }   // nothing was saved: choose again
        if (c === 'pin') { showPad('รหัสถูกตั้งไว้แล้ว ใส่รหัสที่ตั้งไว้', false); return; }   // someone set another code: the ordinary pad
        showPad(r.error || NET.error, false, true);   // still no signal: back to choosing (the server decides again on the next try)
      });
    });
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
      if (res.code === 'SETPIN') { pendingPin = null; showPad('', false, true); return; }   // choose a code first (nothing was typed wrong)
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
    api('boot', {}, function (res) { var c = L.classify(res); if (c === 'ok') acceptBoot(res, false); else if (c === 'pin') showPad(res.error, res.code === 'LOCK', res.code === 'SETPIN'); else offTimer = setTimeout(retryOnline, 15000); });
  }
  function probe() {
    probing = true;
    api('boot', {}, function (res) {
      probing = false;
      var c = L.classify(res);
      if (c === 'ok') { pendingPin = null; padBusy = false; acceptBoot(res, false); return; }   // a link with no PIN
      if (res && res.code === 'LOCK') { showPad(res.error, true); return; }
      if (res && res.code === 'SETPIN') { pendingPin = null; padBusy = false; showPad('', false, true); return; }   // a valid link with no PIN yet: choose one first
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
  function reboot() { api('boot', {}, function (res) { var c = L.classify(res); if (c === 'ok') acceptBoot(res, false); else if (c === 'pin') showPad(res.error, res.code === 'LOCK', res.code === 'SETPIN'); }); }

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
      else if (c === 'pin') { showPad(res.error, res.code === 'LOCK', res.code === 'SETPIN'); return; }
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
      paused = true;
      if (!(res.code === 'SETPIN' && setMode && !$('pad').hidden)) showPad(res.error || '', res.code === 'LOCK', res.code === 'SETPIN');   // (a pad already in set mode keeps the digits being typed)
      renderBadge(); return;   // the queue stays; after the PIN it goes on
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
  /** a banner (amber) or error (red) box: icon, text, and an optional text button under it */
  function noteBox(cls, icon, text, button) {
    var d = el('div', cls), g = el('div', 'grow', text);
    d.appendChild(ic(icon));
    if (button) { g.appendChild(el('br')); g.appendChild(button); }
    d.appendChild(g); return d;
  }
  function renderNotes() {
    var box = $('notes'); clear(box);
    if (offline) {
      var again = btn('tbtn', 'ลองเชื่อมต่อใหม่'); again.addEventListener('click', retryOnline);
      box.appendChild(noteBox('banner', 'wifi-off', 'ออฟไลน์ ดูรายการได้อย่างเดียว ยังบันทึกไม่ได้ จนกว่าจะเชื่อมต่อและระบบตรวจรหัสผ่าน', again));
    }
    if (Q.length && L.qFailing(Q)) box.appendChild(noteBox('refused', 'triangle-alert', 'ส่งไม่สำเร็จ ระบบจะลองส่งซ้ำเอง กรุณาเปิดหน้านี้ค้างไว้จนกว่าจะส่งครบ' + (noStore ? ' (เครื่องนี้เก็บคิวไม่ได้ ถ้าปิดหน้านี้รายการจะหาย)' : '')));
    else if (Q.length && noStore) box.appendChild(noteBox('banner', 'info', 'เครื่องนี้เก็บคิวไว้ไม่ได้ กรุณาเปิดหน้านี้ค้างไว้จนกว่า "กำลังส่ง" จะหมด'));
    notes.forEach(function (n) {
      var x = btn('tbtn', 'ปิด');
      x.addEventListener('click', function () { notes = notes.filter(function (y) { return y !== n; }); renderNotes(); });
      box.appendChild(noteBox(n.kind === 'err' ? 'refused' : 'banner', n.kind === 'err' ? 'triangle-alert' : 'info', n.text, x));
    });
  }

  /* ---------------- rendering: shell ---------------- */
  function render() {
    $('who').textContent = 'สวัสดี ' + who();
    $('sub').textContent = L.headerSub(today(), !!M, (M || D || {}).loc);
    renderLocBar();
    renderBadge(); renderNotes();
    $('fcHome').hidden = !M; $('dailyHome').hidden = !D;
    if (M) renderFc(); else if (D) renderDaily();
  }

  /** v7: a roaming person's location picker (only shown when there is more than one place to go). */
  function renderLocBar() {
    var bar = $('locBar'), src = M || D || {}, choices = L.locChoices(src.locs, src.loc), sel = $('locPick');
    if (!choices.length) { bar.hidden = true; return; }
    bar.hidden = false; clear(sel);
    choices.forEach(function (n) { var o = el('option', '', n); o.value = n; if (n === src.loc) o.selected = true; sel.appendChild(o); });
  }

  /* ---------------- rendering: full count home ---------------- */
  function renderFc() {
    renderProg();
    $('prog').hidden = false;
    if (M.state !== 'open') { var b = $('blocked'); b.textContent = M.message || 'ยังนับไม่ได้'; b.hidden = false; $('tools').hidden = true; return; }
    $('blocked').hidden = true; $('tools').hidden = false;
    if (!card) { renderChips(); renderList(); renderSug(); }   // the suggestion rows (shelf chip, นับแล้ว) follow the fresh data
  }
  function renderProg() {
    if (!M) return;
    var box = $('prog'), P = M.progress; clear(box);
    var r1 = el('div', 'r1'), left = el('div'), num = el('div', 'num', fmt(P.done) + ' / ' + fmt(P.total));
    left.appendChild(el('div', 'plbl', 'นับแล้ว '));
    num.appendChild(el('small', '', ' รายการ'));
    left.appendChild(num); r1.appendChild(left); r1.appendChild(el('span', 'pct', P.pct + '%')); box.appendChild(r1);
    var bar = el('div', 'bar'), i = el('i'); i.style.width = Math.min(100, P.pct) + '%'; bar.appendChild(i); box.appendChild(bar);
    box.appendChild(el('div', 'sub', 'วันนี้ฉันนับ ' + fmt(P.mine) + ' รายการ'));
  }
  function curList() { return ST.tab === 'second' ? M.second : M.items; }
  function renderTabs() {
    $('tabFirst').setAttribute('aria-selected', ST.tab === 'first' ? 'true' : 'false');
    var t = $('tabSecond'), n = L.secondLeft(M), bd = $('tabSecondN');
    bd.textContent = fmt(n); bd.className = 'badge' + (n ? '' : ' zero');
    t.setAttribute('aria-selected', ST.tab === 'second' ? 'true' : 'false');
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
    var src = curList(), second = ST.tab === 'second', panel = $('listPanel'), head = $('uncHead');
    var forced = !!(ST.q.trim() || ST.shelf), open = ST.expanded || forced;   // a search or a shelf filter always shows the results (presentation only)
    head.hidden = second;
    if (second) {
      panel.className = 'panel bare'; $('vwrap').hidden = false;
      if (!src.length) { box.appendChild(el('div', 'msg ok', M.secondMessage || 'ตอนนี้ไม่มีรายการให้คุณนับซ้ำ')); return; }
      box.appendChild(el('div', 'caption', 'ต้องนับซ้ำ: นับให้ตรงตามที่เห็นจริง (เรียงตามความสำคัญ)'));
    }
    var f = L.filterItems(M, src, { q: ST.q, shelf: ST.shelf, showDone: ST.showDone, max: 150 });
    if (!second) {
      $('uncLbl').textContent = ST.showDone ? 'ทุกรายการ' : 'ยังไม่ได้นับ';
      $('uncCnt').textContent = fmt(f.rows.length + f.hidden);
      head.setAttribute('aria-expanded', open ? 'true' : 'false'); head.disabled = forced; head.setAttribute('aria-disabled', forced ? 'true' : 'false');
      $('vwrap').hidden = !open;
      panel.className = 'panel';
      if (!open) return;
      box.appendChild(el('div', 'sub', ST.showDone ? 'ทุกรายการ (เรียงตามชั้นวาง แล้วตามรหัส)' : 'ยังไม่ได้นับ (เรียงตามชั้นวาง แล้วตามรหัส)'));
    }
    var grp = el('div', second ? 'group' : '');
    f.rows.forEach(function (it) { grp.appendChild(rowOf(it)); });
    if (f.rows.length) box.appendChild(grp);
    if (f.hidden) box.appendChild(el('div', 'empty', 'ยังมีอีก ' + fmt(f.hidden) + ' รายการ - พิมพ์ค้นหาหรือเลือกชั้นวางให้แคบลง'));
    if (!f.rows.length) box.appendChild(el('div', second ? 'msg ok' : 'empty', (ST.q.trim() || ST.shelf) ? 'ไม่มีรายการที่ตรงกับตัวกรอง' : (second ? 'ตอนนี้ไม่มีรายการให้คุณนับซ้ำ' : 'ไม่เหลือรายการที่ยังไม่ได้นับ')));
  }
  function rowOf(it) {
    var part = M.parts[it.p], second = ST.tab === 'second', b = btn('prow lrow' + (it.done ? ' done' : ''));
    var two = el('div', 'two'); two.appendChild(el('div', 'l1', part.name));
    var l2 = el('div', 'l2'); l2.appendChild(el('span', 'pn', part.code2));
    var sh = el('span', 'shelfchip'); sh.appendChild(ic('map-pin')); sh.appendChild(el('span', '', it.shelf)); l2.appendChild(sh);
    two.appendChild(l2);
    if (it.done) two.appendChild(el('div', 'l3', 'นับแล้ว ' + it.on + ' · ' + it.by));
    b.appendChild(two);
    if (second) { var dot = el('span', 'dot'); dot.setAttribute('role', 'img'); dot.setAttribute('aria-label', 'ต้องนับซ้ำ'); b.appendChild(dot); }
    else if (it.done) { var ck = ic('circle-check', 'chk'); ck.setAttribute('aria-hidden', 'false'); ck.setAttribute('role', 'img'); ck.setAttribute('aria-label', 'นับแล้ว'); b.appendChild(ck); }
    b.appendChild(ic('chevron-right', 'chev'));
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
    card.mode = 'type'; card.qty = 0; card.lock = ''; card.warn = ''; card.err = ''; card.camMsg = ''; card.leave = false; card.unknown = false;
    showCard(); focusQty();
  }
  /** the card opens in type mode: put the cursor in the quantity box (iOS may refuse to open the keyboard - harmless) */
  function focusQty() { try { var q = $('qtyIn'); if (q && card && card.mode === 'type') q.focus(); } catch (e) { /* ignore */ } }
  function openUnknown(code) { card = { unknown: true, ucode: code, qty: '', ushelf: '', err: '' }; showCard(); }
  function showCard() { hideSug(); closeScan(); $('home').hidden = true; $('card').hidden = false; drawCard(); window.scrollTo(0, 0); }
  function backHome() { camStop(); card = null; $('card').hidden = true; $('home').hidden = false; if (M) { renderProg(); renderChips(); renderList(); } else if (D) renderDaily(); renderNotes(); }
  function shelfInfo(name) { for (var i = 0; i < card.shelves.length; i++) if (card.shelves[i].shelf === name) return card.shelves[i]; return null; }

  function drawCard() {
    camStop();
    var box = $('card'); clear(box);
    var nav = el('div', 'nav'), back = btn('navback');
    back.appendChild(ic('chevron-left')); back.appendChild(el('span', '', card.leave ? 'ยังไม่ได้บันทึก กดอีกครั้งเพื่อกลับ' : 'กลับ'));
    back.addEventListener('click', function () {
      if (!card.unknown && card.mode === 'scan' && card.qty > 0 && !card.leave) { card.leave = true; drawCard(); return; }
      backHome();
    });
    nav.appendChild(back); box.appendChild(nav);
    if (card.unknown) { drawUnknown(box); return; }

    var head = el('div', 'phead'), tile = el('div', 'tile'), ht = el('div', 'grow');
    tile.appendChild(ic('package')); head.appendChild(tile);
    ht.appendChild(el('div', 'pcode', card.code2)); ht.appendChild(el('h2', 'pname', card.name)); head.appendChild(ht);
    box.appendChild(head);

    var grp = null;
    if (card.shelf !== null) {
      grp = el('div', 'group'); var srow = el('div', 'item');
      srow.appendChild(ic('map-pin')); srow.appendChild(el('span', 'grow', 'ชั้น ' + card.shelf)); grp.appendChild(srow);
    }
    if (card.locked && !card.second) { if (grp) box.appendChild(grp); box.appendChild(el('div', 'msg err', 'รายการนี้อยู่ระหว่างนับซ้ำ แจ้งเจ้าของ')); return; }   // under blind recount: no Save button, the owner unlocks it
    if (card.shelf === null) { drawShelfPicker(box); return; }

    var chg = btn('item act'); chg.appendChild(el('span', 'grow', 'เปลี่ยนชั้นวาง'));
    chg.addEventListener('click', function () { card.shelf = null; card.other = false; card.qty = 0; card.lock = ''; card.warn = ''; drawCard(); });
    grp.appendChild(chg); box.appendChild(grp);
    var info = card.other ? null : shelfInfo(card.shelf);
    if (info && info.done) box.appendChild(noteBox('note', 'info', 'นับแล้ว ' + info.doneOn + ' โดย ' + info.doneBy + ' — นับใหม่จะแทนที่ค่าเดิม'));

    var tabs = el('div', 'seg'); tabs.setAttribute('role', 'tablist');
    [['type', 'พิมพ์จำนวน'], ['scan', 'สแกนทีละชิ้น']].forEach(function (m) {
      var b = btn('segb'); b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', card.mode === m[0] ? 'true' : 'false');
      b.appendChild(ic('check', 'segck')); b.appendChild(el('span', 'lb', m[1]));
      b.addEventListener('click', function () { card.mode = m[0]; card.warn = ''; card.err = ''; card.camMsg = ''; card.leave = false; drawCard(); });
      tabs.appendChild(b);
    });
    box.appendChild(tabs);

    var pn = el('div', 'card');
    if (card.mode === 'scan') drawScanMode(pn); else drawTypeMode(pn);
    box.appendChild(pn);

    var err = el('div', card.err ? 'msg err' : ''); err.id = 'cardErr'; err.textContent = card.err || ''; box.appendChild(err);
    var save = btn('pbtn', 'บันทึก'); save.id = 'saveBtn';
    save.addEventListener('click', function () { doSave(readQty()); }); box.appendChild(save);
    var zero = btn('tbtn c', 'ไม่พบเลย (0)');
    zero.addEventListener('click', function () { doSave(0); }); box.appendChild(zero);
    if (card.mode === 'scan') startPieceCamera();
  }

  function drawShelfPicker(box) {
    box.appendChild(el('div', 'caption', 'เลือกชั้นวาง'));
    var grp = el('div', 'group');
    card.shelves.forEach(function (s) {
      var b = btn('shelfpick item'), two = el('div', 'two');
      two.appendChild(el('div', 'l1', s.shelf)); two.appendChild(el('div', 'l2', s.done ? 'นับแล้ว ' + s.doneOn + ' โดย ' + s.doneBy : 'ยังไม่ได้นับ'));
      b.appendChild(two); b.appendChild(ic('chevron-right'));
      b.addEventListener('click', function () { card.shelf = s.shelf; card.other = false; card.err = ''; drawCard(); });
      grp.appendChild(b);
    });
    var o = btn('shelfpick item'), ot = el('div', 'two');
    ot.appendChild(el('div', 'l1', 'ชั้นอื่น (ไม่มีในรายการ)')); ot.appendChild(el('div', 'l2', 'ต้องพิมพ์ชื่อชั้นวาง')); o.appendChild(ot);
    var form = el('div', 'panel fldwrap'); form.hidden = !card.otherOpen;
    var inp = el('input'); inp.type = 'text'; inp.maxLength = 40; inp.placeholder = 'เช่น A-05';
    o.addEventListener('click', function () { card.otherOpen = true; form.hidden = false; inp.focus(); });
    grp.appendChild(o); box.appendChild(grp);
    form.appendChild(ofield('otherShelf', 'ชื่อชั้นวาง', inp));
    var msg = el('div'); msg.id = 'otherErr'; form.appendChild(msg);
    var ok = btn('pbtn spaced', 'ใช้ชั้นนี้');
    ok.addEventListener('click', function () {
      var v = inp.value.trim();
      if (!v) { msg.className = 'msg err spaced'; msg.textContent = 'กรุณาพิมพ์ชื่อชั้นวาง'; return; }
      card.shelf = v; card.other = true; card.err = ''; drawCard();
    });
    form.appendChild(ok); box.appendChild(form);
  }

  function drawTypeMode(box) {
    var lab = el('label', 'lbl', 'จำนวนชิ้นที่นับได้ (เป็นชิ้น ไม่ใช่ถุง/แพ็ค)'); lab.setAttribute('for', 'qtyIn'); box.appendChild(lab);
    var row = el('div', 'stepper');
    var minus = btn('step'); minus.appendChild(ic('minus')); minus.setAttribute('aria-label', 'ลด');
    var inp = el('input'); inp.type = 'number'; inp.inputMode = 'numeric'; inp.min = '0'; inp.step = '1'; inp.id = 'qtyIn'; inp.placeholder = '0'; inp.value = card.qty ? String(card.qty) : '';
    var plus = btn('step'); plus.appendChild(ic('plus')); plus.setAttribute('aria-label', 'เพิ่ม');
    minus.addEventListener('click', function () { inp.value = String(Math.max(0, (parseInt(inp.value, 10) || 0) - 1)); card.qty = +inp.value; });
    plus.addEventListener('click', function () { inp.value = String((parseInt(inp.value, 10) || 0) + 1); card.qty = +inp.value; });
    inp.addEventListener('input', function () { card.qty = Math.max(0, parseInt(inp.value, 10) || 0); });
    var ow = el('div', 'of'); ow.appendChild(inp);
    row.appendChild(minus); row.appendChild(ow); row.appendChild(plus); box.appendChild(row);
  }
  function readQty() {
    if (card.mode === 'type') { var v = $('qtyIn').value; return v === '' ? null : v; }
    return card.qty;
  }

  function drawScanMode(box) {
    box.appendChild(el('div', 'lbl', 'ชิ้นที่นับได้ (สแกนบาร์โค้ดทีละชิ้น)'));
    var big = el('div', 'bigq', String(card.qty)); big.id = 'bigqty'; big.setAttribute('aria-live', 'polite'); box.appendChild(big);
    var warn = el('div', card.warn ? 'msg err' : ''); warn.id = 'pieceWarn'; warn.textContent = card.warn; box.appendChild(warn);
    var vf = el('div', 'vf'); vf.id = 'pieceVf'; var video = el('video'); video.id = 'pieceVideo'; video.setAttribute('playsinline', ''); video.setAttribute('autoplay', ''); video.muted = true; vf.appendChild(video); vf.appendChild(el('div', 'frame')); vf.appendChild(el('div', 'line'));
    var torch = btn('torch'); torch.id = 'pieceTorch'; torch.setAttribute('aria-label', 'ไฟฉาย'); torch.appendChild(ic('flashlight')); torch.hidden = true; vf.appendChild(torch);
    var zoom = btn('zoom', '2×'); zoom.id = 'pieceZoom'; zoom.hidden = true; vf.appendChild(zoom);
    vf.hidden = !!card.camMsg; box.appendChild(vf);
    var ph = el('div', 'msg err', L.HINT_1D); ph.id = 'pieceHint'; ph.hidden = true; box.appendChild(ph);
    var cm = el('div', card.camMsg ? 'msg err' : ''); cm.id = 'camMsg'; cm.textContent = card.camMsg; box.appendChild(cm);
    if (card.camMsg) {
      var lab = el('label', 'fbtn tint wide', ''); lab.style.marginTop = '10px'; lab.appendChild(ic('camera')); lab.appendChild(el('span', '', 'ถ่ายรูปบาร์โค้ด นับ 1 ชิ้น'));
      var f = el('input'); f.type = 'file'; f.accept = 'image/*'; f.setAttribute('capture', 'environment'); f.style.cssText = 'position:absolute;left:-9999px';
      f.addEventListener('change', function () { var file = f.files && f.files[0]; f.value = ''; if (file) decodePhoto(file, function (text, why) { if (text && !L.isPlausibleCode(text)) pieceWarn(NOT_A_PART); else if (text) onPiece(text); else pieceWarn(why || 'อ่านบาร์โค้ดจากรูปไม่ได้'); }); });
      lab.appendChild(f); box.appendChild(lab);
    }
    var g = el('div', 'rowbtns');
    var m = btn('fbtn'); m.appendChild(ic('minus')); m.appendChild(document.createTextNode('1')); m.setAttribute('aria-label', 'ลดหนึ่งชิ้น'); m.addEventListener('click', function () { card.qty = Math.max(0, card.qty - 1); card.warn = ''; setBig(); });
    var r = btn('fbtn', 'ล้าง'); r.addEventListener('click', function () { card.qty = 0; card.lock = ''; card.warn = ''; setBig(); });
    g.appendChild(m); g.appendChild(r); box.appendChild(g);
  }
  function setBig() { var b = $('bigqty'); if (b) b.textContent = String(card.qty); var w = $('pieceWarn'); if (w) { w.textContent = card.warn; w.className = card.warn ? 'msg err' : ''; } }
  function pieceWarn(t) { if (!card) return; card.warn = t; setBig(); }

  function startPieceCamera() {
    var v = $('pieceVideo'); if (!v || card.camMsg) return;
    var mine = card, hint = L.makeIgnoreHint(), hintEl = $('pieceHint');
    camStart(v, function (text) {
      var k = L.readClass(text), now = Date.now();
      if (hintEl) hintEl.hidden = !hint.feed(k.kind, now);
      // an implausible read (a QR link, junk) is just an empty frame: ignored silently, the piece gate keeps its own count of empty frames
      if (cam.gate.feed(k.kind === 'plausible' ? text : '', now)) onPiece(text);
    }, function (msg) { if (card === mine) { card.camMsg = msg; drawCard(); } }, { torch: $('pieceTorch'), zoom: $('pieceZoom'), frame: $('pieceVf') });
  }
  /** one scan in "scan each piece" mode: the same code adds 1 (once it left the view for ~0.7 s); a different code warns and does not count */
  function onPiece(text) {
    if (!card || card.unknown || card.mode !== 'scan') return;
    var d = L.scanDecision(card.codes, card.lock, text);
    if (d.action === 'count') { card.qty++; card.lock = d.lock; card.warn = ''; beep(); buzz(40); setBig(); }
    else if (d.action === 'wrong') { card.warn = 'บาร์โค้ดไม่ตรงกับชิ้นนี้ ไม่นับ'; beep(); buzz([80, 60, 80]); setBig(); }
  }

  /** A count at a branch needs no shelf name: the server uses the branch itself as the place (v7). The main shop still asks for one. */
  function needShelf() { return !(M && M.loc && M.loc !== 'สนง.ใหญ่'); }
  function drawUnknown(box) {
    box.appendChild(el('h2', 'pname', 'ไม่พบรหัสนี้'));
    var m = el('div', 'msg err'); m.id = 'unknownMsg'; m.appendChild(document.createTextNode('อ่านได้: ')); m.appendChild(el('span', 'code', card.ucode)); m.appendChild(document.createTextNode(' — ไม่มีในรายการอะไหล่')); box.appendChild(m);
    box.appendChild(el('div', 'caption', 'บันทึกเป็นรหัสไม่รู้จัก เพื่อให้เจ้าของตรวจสอบ'));
    var c = el('div', 'panel fldstack');
    var q = el('input'); q.type = 'number'; q.inputMode = 'numeric'; q.min = '0'; q.placeholder = '0'; q.value = card.qty; c.appendChild(ofield('uqty', 'จำนวนที่นับได้', q));
    var s = el('input'); s.type = 'text'; s.maxLength = 40; s.placeholder = needShelf() ? 'เช่น A-05' : 'ไม่ต้องกรอกก็ได้'; s.value = card.ushelf; c.appendChild(ofield('ushelf', needShelf() ? 'ชื่อชั้นวาง' : 'ชื่อชั้นวาง (ถ้ามี)', s));
    box.appendChild(c);
    if (card.err) { var e = el('div', 'msg err', card.err); e.setAttribute('role', 'alert'); box.appendChild(e); }
    var b = btn('pbtn', 'บันทึกเป็นรหัสไม่รู้จัก'); b.id = 'unknownSave';
    b.addEventListener('click', function () {
      card.qty = q.value; card.ushelf = s.value.trim();
      if (card.qty === '' || (needShelf() && !card.ushelf) || isNaN(Number(card.qty)) || Number(card.qty) < 0) { card.err = needShelf() ? 'กรุณาใส่จำนวนและชื่อชั้นวาง' : 'กรุณาใส่จำนวนที่นับได้'; drawCard(); return; }
      if (!verified) { toast('ยังบันทึกไม่ได้ รอให้ระบบตรวจรหัสก่อน'); return; }
      var code = card.ucode, shelf = card.ushelf, qty = card.qty;
      enqueue('fc', L.unknownBody(code, shelf, qty, pickLoc), 'รหัสไม่รู้จัก ' + code);
      toast('บันทึกแล้ว'); backHome();
    });
    box.appendChild(b);
  }

  /** Save = optimistic: the item leaves the list at once, the card closes, the request goes through the queue. */
  function doSave(q) {
    if (!verified) { toast('ยังบันทึกไม่ได้ รอให้ระบบตรวจรหัสก่อน'); return; }
    if (q === null || q === '' || isNaN(Number(q)) || Number(q) < 0) { card.err = 'กรุณาใส่จำนวนที่นับได้ (ไม่พบเลยให้กด "ไม่พบเลย")'; drawCard(); return; }
    var body = L.fcBody(card, q, card.mode, pickLoc);
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
    $('scan').hidden = false; $('scanNote').textContent = 'เล็งบาร์โค้ดให้อยู่ในกรอบ'; $('scanHint').hidden = true;
    var hint = L.makeIgnoreHint(), confirm = L.makeConfirm();
    camStart($('scanVideo'), function (text) {
      var k = L.readClass(text), now = Date.now();
      $('scanHint').hidden = !hint.feed(k.kind, now);
      if (k.kind !== 'plausible') return;                                   // empty or implausible (a QR link, junk): ignored silently, keep scanning
      var p = L.findPart(M, text);
      if (p >= 0) { camStop(); $('scan').hidden = true; beep(); buzz(40); lookup(text, true); return; }
      if (confirm.add(k.n)) { camStop(); $('scan').hidden = true; beep(); buzz(40); lookup(text, true); }   // a plausible code that is not in the list: only after the same code was read twice in a row
    }, function (msg) { $('scanNote').textContent = msg; }, { torch: $('scanTorch'), zoom: $('scanZoom'), frame: $('scanVf') });
  }
  function closeScan() { camStop(); $('scan').hidden = true; }
  function lookup(code, viaScan) {
    if (!verified) { toast('รอสักครู่ กำลังตรวจรหัส'); return; }
    homeMsg('', '');
    var p = L.findPart(M, code);
    if (p >= 0) { var c = L.cardOf(M, p, false); openCard(c, undefined, !!viaScan); }
    else openUnknown(String(code).trim());
  }
  /* ---- suggestions under the typed-code field (all DOM built with textContent) ---- */
  var sugHint = false;
  /** hide the list and the hint and clear the typed text (a card is opening, or a pick was made) */
  function hideSug() { sugHint = false; $('codeIn').value = ''; clear($('codeSug')); clear($('codeSugLive')); $('codeIn').setAttribute('aria-expanded', 'false'); }
  /** a tapped suggestion: the card of THAT part (by index, not by re-reading its code), the same card lookup() builds */
  function openPart(p) {
    if (!verified) { toast('รอสักครู่ กำลังตรวจรหัส'); return; }   // refused: the typed text and the list stay
    hideSug(); homeMsg('', '');
    openCard(L.cardOf(M, p, false), undefined, false);
  }
  /** the "not in the list" row / search with no exact match and no suggestions: the same unknown-code screen lookup() ends in */
  function openUnknownTyped(text) {
    if (!verified) { toast('รอสักครู่ กำลังตรวจรหัส'); return; }
    hideSug(); homeMsg('', '');
    openUnknown(text);
  }
  function renderSug() {
    var box = $('codeSug'), live = $('codeSugLive'), inp = $('codeIn'), text = inp.value; clear(box); clear(live);
    if (!M || L.normScan(text).length < 2) { sugHint = false; inp.setAttribute('aria-expanded', 'false'); return; }
    var r = L.suggestMatches(M, text, 8), typed = text.trim(), exact = L.findPart(M, text) >= 0;   // an exact code: just the matches (search opens it), no "unknown" row
    if (exact) sugHint = false;
    if (sugHint) box.appendChild(el('div', 'hint', 'ไม่ตรงกับรหัสใดพอดี เลือกจากรายการ หรือบันทึกเป็นรหัสไม่รู้จัก'));
    if (!r.list.length) box.appendChild(el('div', 'caption', 'ไม่พบรหัสนี้ในรายการ — กดค้นหาเพื่อบันทึกเป็นรหัสไม่รู้จัก'));
    var grp = el('div', 'panel group');
    r.list.forEach(function (p, i) {
      var part = M.parts[p], its = M.byPart[p], b = btn('srow'), two = el('div', 'two');
      two.appendChild(el('div', 'l1', part.name));
      var l2 = el('div', 'l2'); l2.appendChild(el('span', 'pn', r.shown[i]));
      if (its.length) {
        var sh = el('span', 'shelfchip'); sh.appendChild(ic('map-pin')); sh.appendChild(el('span', '', its[0].shelf + (its.length > 1 ? ' +' + (its.length - 1) : ''))); l2.appendChild(sh);
        if (its.every(function (x) { return x.done; })) l2.appendChild(el('span', 'donetag', 'นับแล้ว'));
      }
      two.appendChild(l2); b.appendChild(two); b.appendChild(ic('chevron-right', 'chev'));
      b.addEventListener('click', function () { openPart(p); });
      grp.appendChild(b);
    });
    if (r.total > r.list.length) grp.appendChild(el('div', 'sugmore', 'และอีก ' + fmt(r.total - r.list.length) + ' รายการ พิมพ์เพิ่มเพื่อให้แคบลง'));
    if (!exact) {
    var ub = btn('srow unk'); ub.appendChild(el('span', 'grow', 'ไม่มีในรายการ — บันทึก "' + typed + '" เป็นรหัสไม่รู้จัก'));
    ub.addEventListener('click', function () { openUnknownTyped(typed); });
    grp.appendChild(ub);
    }
    box.appendChild(grp);
    inp.setAttribute('aria-expanded', 'true');
    live.textContent = sugHint ? 'ไม่ตรงกับรหัสใดพอดี เลือกจากรายการ' : (r.list.length ? 'พบ ' + fmt(r.total) + ' รายการ' : 'ไม่พบรหัสนี้ในรายการ');
  }
  /** search / Enter: an exact code opens as always; anything else NEVER opens a part by itself - with suggestions the list stays (pick one or save as unknown), without any it is an unknown code */
  function goCode() {
    var v = $('codeIn').value; if (!v.trim()) return;
    if (M && L.findPart(M, v) < 0 && L.isFullCode(v)) { openUnknownTyped(v.trim()); return; }   // a whole code that is not listed: like a scan of an unlisted product (refused while not verified: the text stays)
    if (M && L.findPart(M, v) < 0 && L.suggestMatches(M, v, 1).total > 0) { sugHint = true; renderSug(); return; }
    if (!verified) { toast('รอสักครู่ กำลังตรวจรหัส'); return; }   // refused: keep the typed text
    hideSug(); lookup(v, false);
  }

  /* ---------------- camera (live) with photo fallback ---------------- */
  // Live mode reads 1D barcodes only (never QR), from a wide centre band of the video at full resolution. Every decode result (or "nothing") goes to
  // onFrame(text); the callers decide what counts (the piece gate, the twice-in-a-row rule). One loop, about 8-10 decodes a second.
  var cam = { stream: null, timer: null, gate: null, torch: false, zoom: 0 }, camRun = 0, zxLoading = null;
  function makeDetector(formats) {
    try {
      if (!('BarcodeDetector' in window)) return null;
      try { return new window.BarcodeDetector({ formats: formats }); } catch (e1) { return new window.BarcodeDetector(); }
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
  function camMessage(e) {
    var n = e && e.name ? e.name : '';
    if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError') return 'เปิดกล้องไม่ได้ (ยังไม่ได้อนุญาตกล้อง) กรุณาอนุญาตกล้องให้เว็บนี้ในการตั้งค่าของเบราว์เซอร์ หรือใช้ปุ่ม "ถ่ายรูปบาร์โค้ด" หรือพิมพ์รหัสแทน';
    if (n === 'NotFoundError' || n === 'DevicesNotFoundError') return 'ไม่พบกล้องในเครื่องนี้ ใช้ปุ่ม "ถ่ายรูปบาร์โค้ด" หรือพิมพ์รหัสแทน';
    if (e && e.message === 'nolib') return 'โหลดตัวอ่านบาร์โค้ดไม่ได้ (ตรวจอินเทอร์เน็ต) ใช้ปุ่ม "ถ่ายรูปบาร์โค้ด" หรือพิมพ์รหัสแทน';
    return 'เปิดกล้องสดไม่ได้ ใช้ปุ่ม "ถ่ายรูปบาร์โค้ด" หรือพิมพ์รหัสแทน';
  }
  function camStop() {
    camRun++;
    clearTimeout(cam.timer); cam.timer = null;
    try { if (cam.stream) cam.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ignore */ }
    cam.stream = null; cam.torch = false;
    var vs = document.querySelectorAll('video'); for (var i = 0; i < vs.length; i++) { try { vs[i].srcObject = null; } catch (e) { /* ignore */ } }
    var tb = document.querySelectorAll('.torch'); for (var j = 0; j < tb.length; j++) { tb[j].hidden = true; tb[j].classList.remove('on'); }
    var zb = document.querySelectorAll('.zoom'); for (var k = 0; k < zb.length; k++) zb[k].hidden = true;
  }
  /** Track extras: continuous focus, the torch button, and a zoom button (default about 2x so the phone can be held 15-25 cm away). */
  function setupTrack(stream, torchBtn, zoomBtn) {
    try {
      var track = stream.getVideoTracks()[0], caps = track && track.getCapabilities ? track.getCapabilities() : null;
      if (!caps) return;
      var apply = function (c) { try { var r = track.applyConstraints({ advanced: [c] }); if (r && r.catch) r.catch(function () { /* not supported: fine */ }); return r; } catch (e) { return null; } };
      if (caps.focusMode && caps.focusMode.indexOf && caps.focusMode.indexOf('continuous') >= 0) apply({ focusMode: 'continuous' });
      var zp = L.zoomPlan(caps);
      if (zp && zoomBtn) {
        cam.zoom = zp.def; apply({ zoom: zp.def });
        zoomBtn.hidden = false; zoomBtn.textContent = L.zoomLabel(zp.def);
        zoomBtn.onclick = function () { cam.zoom = cam.zoom > zp.min ? zp.min : zp.def; apply({ zoom: cam.zoom }); zoomBtn.textContent = L.zoomLabel(cam.zoom); };
      }
      if (torchBtn && caps.torch) {
        torchBtn.hidden = false;
        torchBtn.onclick = function () {
          cam.torch = !cam.torch;
          try { track.applyConstraints({ advanced: [{ torch: cam.torch }] }).then(function () { torchBtn.classList.toggle('on', cam.torch); }, function () { cam.torch = false; torchBtn.hidden = true; }); } catch (e) { cam.torch = false; torchBtn.hidden = true; }
        };
      }
    } catch (e) { /* no extras: fine */ }
  }
  /** onFrame(text) gets every decode result ('' = nothing). opts: {torch, zoom, frame (the viewfinder element: its shape follows the decoded band)} */
  function camStart(video, onFrame, onFail, opts) {
    opts = opts || {};
    camStop();
    var run = camRun;
    cam.gate = L.makeGate(700);
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('nocam');
      navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false }).then(function (stream) {
        if (run !== camRun) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
        cam.stream = stream; video.srcObject = stream; setupTrack(stream, opts.torch, opts.zoom);
        var p = video.play(); if (p && p.catch) p.catch(function () { /* autoplay refused: the stream still decodes */ });
        var det = makeDetector(L.ONE_D_NATIVE);
        if (det) { bandLoop(run, video, opts.frame, onFrame, function (canvas, cb) { try { det.detect(canvas).then(function (r) { cb(L.pickLive(r)); }, function () { cb(''); }); } catch (e) { cb(''); } }); return; }
        loadZXing(function (ok) {
          if (run !== camRun) return;
          if (!ok) { camStop(); onFail(camMessage(new Error('nolib'))); return; }
          var hints = L.zxHints(window.ZXing, false);
          bandLoop(run, video, opts.frame, onFrame, function (canvas, cb) { cb(L.zxDecodeSource(window.ZXing, new window.ZXing.HTMLCanvasElementLuminanceSource(canvas), hints)); });
        });
      }).catch(function (e) { if (run === camRun) { camStop(); onFail(camMessage(e)); } });
    } catch (e) { camStop(); onFail(camMessage(e)); }
  }
  /** The decode loop: copy the centre band of the video (full resolution) to a canvas, decode it, hand the result on, wait ~100 ms, repeat. */
  function bandLoop(run, video, frameEl, onFrame, decode) {
    var canvas = document.createElement('canvas'), ctx = null, shaped = false;
    (function tick() {
      if (run !== camRun) return;
      var again = function () { if (run === camRun) cam.timer = setTimeout(tick, 100); };
      var vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) { again(); return; }
      try {
        var r = L.bandRect(vw, vh);
        if (!ctx) { try { ctx = canvas.getContext('2d', { willReadFrequently: true }); } catch (e0) { ctx = canvas.getContext('2d'); } }
        if (canvas.width !== r.sw || canvas.height !== r.sh) { canvas.width = r.sw; canvas.height = r.sh; }
        if (!shaped && frameEl && frameEl.style) { shaped = true; frameEl.style.aspectRatio = r.sw + ' / ' + r.sh; }   // the viewfinder shows (about) the band that is decoded
        ctx.drawImage(video, r.sx, r.sy, r.sw, r.sh, 0, 0, r.sw, r.sh);
        decode(canvas, function (text) { if (run === camRun) { try { onFrame(text); } catch (e1) { /* ignore */ } } again(); });
      } catch (e) { again(); }
    })();
  }
  /** photo of a barcode -> text, decoded on the phone (cb(text) or cb('', thaiReason)). Here QR is allowed, and a 1D barcode wins when both are in the photo. */
  function decodePhoto(file, cb) {
    var url = URL.createObjectURL(file), img = new Image();
    img.onload = function () {
      try {
        var s = Math.min(1, 1600 / Math.max(img.width, img.height)), c = document.createElement('canvas');
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        var det = makeDetector(L.ONE_D_NATIVE.concat(['qr_code'])), viaZX = function () { photoZX(c, cb); };
        if (det) det.detect(c).then(function (r) { var t = L.preferOneD(r); if (t) cb(t); else viaZX(); }, viaZX);
        else viaZX();
      } catch (e) { cb('', 'อ่านรูปไม่ได้ ถ่ายใหม่หรือพิมพ์รหัสแทน'); }
    };
    img.onerror = function () { URL.revokeObjectURL(url); cb('', 'อ่านรูปไม่ได้ ถ่ายใหม่หรือพิมพ์รหัสแทน'); };
    img.src = url;
  }
  function photoZX(canvas, cb) {
    loadZXing(function (ok) {
      if (!ok) { cb('', 'โหลดตัวอ่านบาร์โค้ดไม่ได้ (ตรวจอินเทอร์เน็ต) พิมพ์รหัสแทน'); return; }
      var Z = window.ZXing, src = new Z.HTMLCanvasElementLuminanceSource(canvas);
      var t = L.zxDecodeSource(Z, src, L.zxHints(Z, false)) || L.zxDecodeSource(Z, src, L.zxHints(Z, true));   // 1D first, QR only when there is no 1D barcode
      if (t) cb(t); else cb('', 'อ่านบาร์โค้ดจากรูปไม่ได้ ถ่ายใหม่ให้ชัดขึ้น หรือพิมพ์รหัสแทน');
    });
  }
  var NOT_A_PART = 'อ่านได้ แต่ไม่ใช่รหัสอะไหล่ (เช่น QR / ลิงก์) ถ่ายให้เห็นบาร์โค้ดแท่ง หรือพิมพ์รหัสแทน';

  /* ---------------- daily random count (same app, same queue) ---------------- */
  function renderDaily() {
    var page = D, top = $('dTop'), list = $('dList'); clear(top); clear(list);
    $('sub').textContent = L.headerSub(page.dateText, false, page.loc) + (page.total ? ' · นับแล้ว ' + page.done + '/' + page.total : '');
    if (page.state !== 'open') {
      list.appendChild(el('div', 'big-msg', page.message || 'โหลดไม่สำเร็จ'));
      return;
    }
    if (page.message) top.appendChild(el('div', 'caption', page.message));
    var next = null;
    page.items.forEach(function (it) { var c = it.done ? dailyDone(it) : dailyCard(it); if (!it.done && !next) next = c; list.appendChild(c); });
    if (scrollNext && next && next.scrollIntoView) { scrollNext = false; next.scrollIntoView({ block: 'start' }); }
  }
  var scrollNext = false;
  function dailyDone(it) {
    var c = el('div', 'card done');
    c.appendChild(ic('circle-check'));
    c.appendChild(el('span', 'grow', it.shelf.split(' · ')[0] + ' · ' + it.name));
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
    var c = el('div', 'card stack', ''), st = { photo: null, lastModified: 0 }, pf = prefill[it.id] || {};
    c.appendChild(el('h2', 'pname', it.name));
    c.appendChild(el('div', 'pcode', it.code2));
    var sh = el('div', 'shelfchip'); sh.style.maxWidth = '100%'; sh.style.height = 'auto'; sh.style.padding = '4px 10px'; sh.style.alignSelf = 'flex-start';
    sh.appendChild(ic('map-pin')); sh.appendChild(el('span', '', 'ที่เก็บตามระบบ: ' + it.shelf)); c.appendChild(sh);
    if (it.seen && it.seen.length) c.appendChild(el('div', 'seen', 'เคยมีคนเจอที่: ' + it.seen.join(' · ')));
    var crates, per, loose, total;
    c.appendChild(el('div', 'hint', 'นับเป็นชิ้น ไม่ใช่ถุง/แพ็ค รวมทุกที่ที่เจอ'));
    // every item has the same entry (crates x pieces per crate + loose): nothing on the page says how big the stock is expected to be
    c.appendChild(el('div', 'hint', 'นับเป็นลัง×ชิ้นต่อลัง + เศษ (ไม่มีลังให้ใส่แค่ช่อง เศษ)'));
    var g = el('div', 'row3'); c.appendChild(g);
    [['ลัง', 'crates'], ['ชิ้น/ลัง', 'per'], ['เศษ', 'loose']].forEach(function (d) {
      var i = numInput('0'); i.className = 'qty'; i.setAttribute('aria-label', d[0]);
      var of = el('div', 'of'); of.appendChild(el('label', '', d[0])); of.appendChild(i); g.appendChild(of);
      if (d[1] === 'crates') crates = i; else if (d[1] === 'per') per = i; else loose = i;
    });
    if (pf.answer) { crates.value = pf.answer.crates || ''; per.value = pf.answer.perCrate || ''; loose.value = pf.answer.loose || (pf.answer.qty !== undefined ? pf.answer.qty : ''); }   // (an answer queued by the older page was a plain quantity)
    total = el('div', 'total', 'รวม 0 ชิ้น'); c.appendChild(total);
    var recalc = function () { total.textContent = 'รวม ' + ((+crates.value || 0) * (+per.value || 0) + (+loose.value || 0)) + ' ชิ้น'; };
    [crates, per, loose].forEach(function (i) { i.addEventListener('input', recalc); }); recalc();

    var fld = el('div', 'field'); c.appendChild(fld);
    var pick = el('label', 'fbtn tint wide', ''); pick.appendChild(ic('camera')); var pl = el('span', '', 'ถ่ายรูป'); pick.appendChild(pl); fld.appendChild(pick);
    var file = el('input'); file.type = 'file'; file.accept = 'image/*'; file.setAttribute('capture', 'environment'); file.style.position = 'absolute'; file.style.left = '-9999px'; pick.appendChild(file);
    var prev = el('img', 'photo-prev'); prev.alt = ''; fld.appendChild(prev);
    var foundAt = el('input'); foundAt.type = 'text'; foundAt.maxLength = 80; foundAt.value = pf.foundAt || '';
    foundAt.setAttribute('aria-label', 'เจอที่ไหนบ้าง');
    var fof = el('div', 'of'); fof.appendChild(foundAt); foundAt.placeholder = 'เจอที่ไหนบ้าง (จำเป็นถ้านับได้มากกว่า 0)'; c.appendChild(fof);
    var err = el('div', 'msg err'); err.hidden = true; c.appendChild(err);
    function showErr(t) { err.textContent = t; err.hidden = !t; }
    if (pf.err) showErr(pf.err);
    var send = btn('pbtn', 'ส่งรายการนี้'); c.appendChild(send);
    function resetPhoto() { st.photo = null; st.lastModified = 0; prev.style.display = 'none'; pl.textContent = 'ถ่ายรูป'; file.value = ''; }
    file.addEventListener('change', function () {
      showErr('');
      var f = file.files[0];
      if (!f) return;
      if (L.photoTooOld(f.lastModified, Date.now())) { resetPhoto(); showErr('ถ่ายรูปใหม่ตอนนี้'); return; }
      shrink(f, function (data) {
        if (!data) { resetPhoto(); showErr('อ่านรูปไม่ได้ ถ่ายรูปใหม่ตอนนี้'); return; }
        st.photo = data; st.lastModified = f.lastModified;
        prev.src = data; prev.style.display = 'block'; pl.textContent = 'ถ่ายใหม่';
      });
    });
    send.addEventListener('click', function () {
      if (!verified) { showErr('รอสักครู่ กำลังตรวจรหัส'); return; }
      showErr('');
      var now = Date.now();
      var chk = L.dailyCheck({ crates: crates.value, per: per.value, loose: loose.value, foundAt: foundAt.value, photo: st.photo, lastModified: st.lastModified, now: now });
      if (!chk.ok) { if (chk.resetPhoto) resetPhoto(); showErr(chk.error); return; }
      delete prefill[it.id];
      enqueue('daily', L.dailyBody(it.id, chk.answer, foundAt.value, st.photo, st.lastModified, now), it.name);
      scrollNext = true; toast('บันทึกแล้ว'); renderDaily();
    });
    return c;
  }

  /* ---------------- events ---------------- */
  function wire() {
    $('locPick').addEventListener('change', function () {   // v7: a roaming person goes to another location: a fresh list from the server for it
      pickLoc = this.value; ST.tab = 'first'; ST.shelf = '';
      if (card) backHome();
      reboot();
    });
    $('scanBtn').addEventListener('click', openScan);
    $('scanClose').addEventListener('click', closeScan);
    $('scanFile').addEventListener('change', function () {
      var f = this.files && this.files[0]; this.value = '';
      if (!f) return;
      $('scanNote').textContent = 'กำลังอ่านรูป…';
      decodePhoto(f, function (text, why) { if (text && !L.isPlausibleCode(text)) $('scanNote').textContent = NOT_A_PART; else if (text) { closeScan(); beep(); lookup(text, true); } else $('scanNote').textContent = why || 'อ่านบาร์โค้ดจากรูปไม่ได้'; });
    });
    $('tabFirst').addEventListener('click', function () { ST.tab = 'first'; ST.shelf = ''; renderChips(); renderList(); });
    $('tabSecond').addEventListener('click', function () { ST.tab = 'second'; ST.shelf = ''; renderChips(); renderList(); });
    $('scanBackdrop').addEventListener('click', closeScan);   // same as the X button
    $('uncHead').addEventListener('click', function () { ST.expanded = !ST.expanded; renderList(); });   // collapse / expand the uncounted list (presentation only)
    $('codeGo').addEventListener('click', goCode);
    $('codeIn').addEventListener('input', function () { sugHint = false; renderSug(); });
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

  /** Fonts load after the first paint (system fonts show at once, the web fonts swap in later); a failure just keeps the system fonts. */
  function loadFonts() {
    try {
      var l = document.createElement('link'); l.rel = 'stylesheet';
      l.href = 'https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@400;500;600&family=Roboto:wght@400;500&family=Roboto+Mono:wght@400&display=swap';
      document.head.appendChild(l);
    } catch (e) { /* system fonts: fine */ }
  }
  /** keep the page behind the scan sheet from scrolling while it is open */
  function watchSheet() {
    try {
      if (typeof MutationObserver === 'undefined') return;
      var sc = $('scan'), sync = function () { document.body.classList.toggle('sheet-open', !sc.hidden); };
      new MutationObserver(sync).observe(sc, { attributes: true, attributeFilter: ['hidden'] }); sync();
    } catch (e) { /* no scroll lock: fine */ }
  }
  function start() {
    loadFonts(); watchSheet();
    if (L.isLineBrowser(navigator.userAgent)) $('linebanner').hidden = false;   // LINE's in-app browser cannot use the camera
    if (!T) { $('nolink').hidden = false; return; }
    buildKeys(); wire();
    $('padBack').addEventListener('click', function () { if (setMode !== 'confirm') return; firstPin = ''; setMode = 'enter'; padBuf = ''; drawDots(); drawSetMode(); $('padMsg').textContent = ''; });
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
