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
    if (lock) return { action: n === lock || (!!codes && codes.indexOf(n) >= 0) ? 'count' : 'wrong', lock: lock };
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
  /** The link to use: a valid hash always wins; else the saved one (JSON string {x,t} from localStorage, re-validated); else null. Never holds a PIN. */
  L.resolveLink = function (hash, saved) {
    var h = L.parseHash(hash);
    if (h) return h;
    var o = null;
    try { o = saved ? JSON.parse(saved) : null; } catch (e) { return null; }
    return o && typeof o === 'object' ? L.parseHash('#x=' + encodeURIComponent(str(o.x)) + '&t=' + encodeURIComponent(str(o.t))) : null;
  };
  /* ---- install help (Android): which browser / device the phone is, so the right hint shows ---- */
  L.isAndroid = function (ua) { return /Android/i.test(str(ua)); };
  L.isInAppBrowser = function (ua) { return /FBAN|FBAV|FB_IAB|Instagram|Messenger|\sLine\//.test(str(ua)); };
  L.isLineAndroid = function (ua) { return L.isAndroid(ua) && /\sLine\//.test(str(ua)); };
  L.isOemBrowser = function (ua) { return /MiuiBrowser|HeyTapBrowser|OppoBrowser/.test(str(ua)); };
  L.isOemDevice = function (ua) { return /Xiaomi|Redmi|POCO|OPPO|realme|CPH\d|RMX\d/i.test(str(ua)) || /\bMI /.test(str(ua)); };
  L.isSamsungBrowser = function (ua) { return /SamsungBrowser/.test(str(ua)); };
  /** Chrome on a Xiaomi / OPPO / realme phone: the "Home screen shortcuts" permission is often off, so the icon never appears. */
  L.showPermHint = function (ua) { return L.isAndroid(ua) && L.isOemDevice(ua) && !L.isInAppBrowser(ua) && !L.isOemBrowser(ua); };

  /* ---- install help (iPhone / iPad): which picture steps to show. Safari 26 moved the page menu into the bottom address pill, so the steps differ ---- */
  L.isIosUa = function (ua, touchPoints) { return /iPhone|iPad|iPod/.test(str(ua)) || (/Macintosh/.test(str(ua)) && Number(touchPoints) > 1); };   // iPadOS asks for the desktop site: a Mac UA with a touch screen
  /** '' (show nothing: not iOS / already installed / LINE has its own banner) | 's26' Safari 26+ (4 pictures) | 's18' Safari before 26 (3) | 'cr' Chrome (2) | 'ipad' Safari on iPad (text) | 'other' Firefox / Edge / other browsers (text: open in Safari) | 'inapp' Facebook / Instagram / Messenger (text: open in Safari) */
  L.iosInstallKind = function (ua, standalone, touchPoints) {
    ua = str(ua);
    if (standalone || !L.isIosUa(ua, touchPoints)) return '';
    if (/\sLine\//.test(ua)) return '';
    if (/FBAN|FBAV|FB_IAB|FBIOS|Instagram|Messenger/.test(ua)) return 'inapp';
    if (/CriOS/.test(ua)) return 'cr';
    if (/FxiOS|EdgiOS|OPiOS|OPT\/|DuckDuckGo|GSA\//.test(ua)) return 'other';
    var v = /Version\/(\d+)/.exec(ua);
    if (!v || !/Safari\//.test(ua)) return 'other';   // a web view with no Safari in its name (mail / chat apps): the way out is Safari
    if (!/iPhone|iPod/.test(ua)) return 'ipad';        // iPad (own UA or desktop-mode Mac UA): the share button is in the top bar
    return Number(v[1]) >= 26 ? 's26' : 's18';
  };
  /** Android: 'aone' (Chrome / Samsung offered the install: one big button) | 'achrome' (Chrome menu steps) | 'asamsung' (Samsung Internet menu steps) | 'aoem' (Mi / HeyTap / Firefox / Opera / Edge...: open it in Chrome) | 'ainapp' (Facebook / Instagram / Messenger: open it in Chrome) | '' (not Android, installed, or LINE: it already jumps to Chrome by itself). canPrompt = beforeinstallprompt arrived and is unused. */
  L.androidInstallKind = function (ua, standalone, canPrompt) {
    ua = str(ua);
    if (standalone || !L.isAndroid(ua) || /\sLine\//.test(ua)) return '';
    if (L.isInAppBrowser(ua) || /; wv\)/.test(ua)) return 'ainapp';   // Facebook / Instagram / Messenger, and any other app's web view (TikTok, Shopee, Lazada...: "; wv)")
    if (L.isSamsungBrowser(ua)) return canPrompt ? 'aone' : 'asamsung';
    if (L.isOemBrowser(ua) || /Firefox\/|OPR\/|EdgA|UCBrowser|DuckDuckGo|VivoBrowser|HuaweiBrowser|HONORBrowser/.test(ua)) return canPrompt ? 'aone' : 'aoem';
    return canPrompt ? 'aone' : 'achrome';
  };
  /** the pop-up card for any phone: the iOS kind, else the Android kind ('' = no card) */
  L.installCardKind = function (ua, standalone, touchPoints, canPrompt, androidInstalled) { return L.iosInstallKind(ua, standalone, touchPoints) || L.androidInstallKind(ua, standalone || !!androidInstalled, canPrompt); };   // androidInstalled = the remembered sc5.inst flag (an installed Android app shares its storage with Chrome, so the flag also tells a normal Chrome tab); never used for iOS
  /** the caption under each picture (one per frame), and the text-only kinds */
  L.A2HS_STEPS = {
    s26: ['กด ≡ ในช่องที่อยู่ด้านล่าง', 'กด แชร์', 'กด ⌄ ดูเพิ่มเติม', 'กด เพิ่มไปยังหน้าจอโฮม → กด เพิ่ม'],
    s18: ['กดปุ่มแชร์ ⬆ ที่แถบด้านล่าง', 'เลื่อนลง แล้วกด เพิ่มไปยังหน้าจอโฮม', 'กด เพิ่ม'],
    cr: ['กดปุ่มแชร์ ⬆ ทางขวาของแถบที่อยู่ด้านบน', 'กด เพิ่มไปยังหน้าจอโฮม → กด เพิ่ม'],
    achrome: ['กด ⋮ มุมขวาบน', 'กด เพิ่มลงในหน้าจอหลัก หรือ ติดตั้งแอป', 'กด ติดตั้ง'],
    asamsung: ['กด ≡ มุมขวาล่าง', 'กด เพิ่มหน้าไปที่', 'กด หน้าจอหลัก → เพิ่ม']
  };
  L.A2HS_TEXT = {
    other: 'เปิดลิงก์นี้ใน Safari แล้วเพิ่มลงหน้าจอโฮม',
    inapp: "กด ⋯ แล้วเลือก 'เปิดใน Safari'",
    ipad: "กดปุ่มแชร์ ⬆ ที่แถบด้านบน แล้วเลือก 'เพิ่มไปยังหน้าจอโฮม' → กด เพิ่ม",
    aoem: 'ให้เปิดลิงก์นี้ใน Chrome แล้วกดติดตั้ง',
    ainapp: "กด ⋮ แล้วเลือก 'เปิดใน Chrome'"
  };
  /** the card title: Android says หน้าจอหลัก, iPhone หน้าจอโฮม */
  L.A2HS_TITLE = { aone: 'ติดตั้งแอปลงหน้าจอ', achrome: 'เพิ่มแอปลงหน้าจอหลัก', asamsung: 'เพิ่มแอปลงหน้าจอหลัก', aoem: 'เพิ่มแอปลงหน้าจอหลัก', ainapp: 'เพิ่มแอปลงหน้าจอหลัก' };
  L.A2HS_TITLE_DEFAULT = 'เพิ่มแอปลงหน้าจอโฮม';

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

  /* ---- Face ID / fingerprint unlock: pure helpers (the WebAuthn calls themselves live in Part 2) ---- */
  var B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  /** bytes (Uint8Array / array of 0-255) -> base64url text without padding */
  L.b64uEnc = function (bytes) {
    var out = '', n = bytes ? bytes.length : 0, i, a, b, c;
    for (i = 0; i < n; i += 3) {
      a = bytes[i]; b = i + 1 < n ? bytes[i + 1] : 0; c = i + 2 < n ? bytes[i + 2] : 0;
      out += B64U.charAt(a >> 2) + B64U.charAt(((a & 3) << 4) | (b >> 4));
      if (i + 1 < n) out += B64U.charAt(((b & 15) << 2) | (c >> 6));
      if (i + 2 < n) out += B64U.charAt(c & 63);
    }
    return out;
  };
  /** base64url text -> Uint8Array, or null when it is not valid base64url */
  L.b64uDec = function (t) {
    t = str(t);
    if (!/^[A-Za-z0-9_-]*$/.test(t) || t.length % 4 === 1) return null;
    var out = [], acc = 0, bits = 0, i;
    for (i = 0; i < t.length; i++) { acc = (acc << 6) | B64U.indexOf(t.charAt(i)); bits += 6; if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); acc &= (1 << bits) - 1; } }
    return new Uint8Array(out);
  };
  /** the tokens (other than `token`) whose stored queue (sc5.q.<token>) still holds unsent entries; get(key) reads a stored value (without it, the key being there counts) */
  L.otherQueueTokens = function (keys, token, get) {
    var list = keys || [], out = [], i, m, v;
    for (i = 0; i < list.length; i++) {
      m = /^sc5\.q\.(.+)$/.exec(str(list[i]));
      if (!m || m[1] === token || out.indexOf(m[1]) >= 0) continue;
      if (typeof get === 'function') { v = get(list[i]); if (!(L.qParse(v).length > 0)) continue; }
      out.push(m[1]);
    }
    return out;
  };
  /** true when this phone's storage holds another person's UNSENT counts (sc5.q.<other>, not empty) or another person's scan record (sc5.bio.<other>): a shared phone - no biometrics there.
   *  Leftovers (a list cache, a declined mark, a draft of an old link) do not count: they are tidied by L.staleTokenKeys. */
  L.otherTokenData = function (keys, token, get) {
    var list = keys || [], i, m;
    for (i = 0; i < list.length; i++) { m = /^sc5\.bio\.(.+)$/.exec(str(list[i])); if (m && m[1] !== token) return true; }
    return L.otherQueueTokens(keys, token, get).length > 0;
  };
  /** the leftovers of OTHER links that can be deleted: list cache / declined mark / draft (and an empty queue key) of a token whose queue is empty. Never a scan record, never a non-empty queue. */
  L.staleTokenKeys = function (keys, token, get) {
    var list = keys || [], busy = L.otherQueueTokens(keys, token, get), out = [], i, m;
    for (i = 0; i < list.length; i++) {
      m = /^sc5\.(q|l|bioNo|ud)\.(.+)$/.exec(str(list[i]));
      if (m && m[2] !== token && busy.indexOf(m[2]) < 0) out.push(list[i]);
    }
    return out;
  };
  /** 'Face ID' for iPhone / iPad, otherwise the fingerprint (Android) */
  L.bioLabel = function (ua) { return /iPhone|iPad|iPod/.test(str(ua)) ? 'Face ID' : 'ลายนิ้วมือ'; };
  /** The stored unlock record (JSON text) -> {v:1,id,salt,iv,ct} (all base64url), or null when it is missing / damaged. Holds NO PIN: ct is the PIN encrypted with a key only the phone's scan can produce. */
  L.bioParse = function (text) {
    var o = null;
    try { o = text ? JSON.parse(text) : null; } catch (e) { return null; }
    if (!o || typeof o !== 'object' || Array.isArray(o) || o.v !== 1) return null;
    var f = ['id', 'salt', 'iv', 'ct'], k, len = {};
    for (k = 0; k < f.length; k++) {
      if (typeof o[f[k]] !== 'string') return null;
      var d = L.b64uDec(o[f[k]]); if (!d) return null; len[f[k]] = d.length;
    }
    if (len.id < 1 || len.id > 1024 || len.salt !== 32 || len.iv !== 12 || len.ct < 17 || len.ct > 128) return null;
    return { v: 1, id: o.id, salt: o.salt, iv: o.iv, ct: o.ct };
  };
  L.makeStore = function (getLs) {
    function ls() { try { return getLs(); } catch (e) { return null; } }
    return {
      get: function (k) { try { var s = ls(); return s ? s.getItem(k) : null; } catch (e) { return null; } },
      set: function (k, v) { try { var s = ls(); if (!s) return false; s.setItem(k, v); return true; } catch (e) { return false; } },
      del: function (k) { try { var s = ls(); if (s) s.removeItem(k); } catch (e) { /* ignore */ } },
      keys: function () { var out = []; try { var s = ls(); if (s && typeof s.length === 'number' && typeof s.key === 'function') for (var i = 0; i < s.length; i++) out.push(s.key(i)); } catch (e) { /* ignore */ } return out; }
    };
  };

  /** ใครนับแล้วบ้าง: the board rows from the boot payload (names, places, item counts only), or null. */
  L.cleanBoard = function (sb) {
    if (!sb || !Array.isArray(sb.rows)) return null;
    var me = sb.me && Number(sb.me.rank) > 0 ? { rank: Number(sb.me.rank), items: Number(sb.me.items) || 0 } : null;
    return { rows: sb.rows.map(function (x) { return { rank: Number(x.rank) || 0, name: str(x.name), items: Number(x.items) || 0, placesText: str(x.placesText) }; }), me: me };
  };
  /** The person's own place on the board, as the server worked it out: {rank, items} or null when they have not counted yet. */
  L.boardMe = function (sb) { return sb && sb.me ? { rank: sb.me.rank, items: sb.me.items } : null; };
  /** ใครนับแล้วบ้าง on the DAILY page: the daily boot reply's sb {mode:'daily', rows:[{rank,name,placesText,done,total}], me:{rank,done,total}|null} -> the same shape cleaned, or null when it is absent / not a daily board.
   *  Rows that are not objects are skipped; counts are clamped to whole numbers >= 0. The page hides the card when there are no rows. */
  L.cleanBoardDaily = function (sb) {
    if (!sb || typeof sb !== 'object' || sb.mode !== 'daily' || !Array.isArray(sb.rows)) return null;
    var cnt = function (v) { var n = Math.floor(Number(v)); return n > 0 && isFinite(n) ? n : 0; };
    var rows = sb.rows.filter(function (x) { return x && typeof x === 'object'; }).map(function (x) { return { rank: cnt(x.rank), name: str(x.name), placesText: str(x.placesText), done: cnt(x.done), total: cnt(x.total) }; });
    var me = sb.me && typeof sb.me === 'object' && cnt(sb.me.rank) > 0 ? { rank: cnt(sb.me.rank), done: cnt(sb.me.done), total: cnt(sb.me.total) } : null;
    return { mode: 'daily', rows: rows, me: me };
  };
  /** one daily row's count: done/total, or the green "✓ ครบ" once done >= total (never for a total of 0) */
  L.dailyCount = function (done, total) { return total > 0 && done >= total ? { full: true } : { full: false, done: done, total: total }; };

  /* ---- Settings page (the gear): pure helpers ---- */
  L.APP_VERSION = '2026111402';   // = the ?v= number on app.js in index.html (bump both together)
  /** '2026111302' -> '2026.11.13' (a 2nd, 3rd... release of the same day shows as '2026.11.13 (2)') */
  L.versionText = function (v) { var m = /^(\d{4})(\d{2})(\d{2})(\d{2})$/.exec(str(v)); if (!m) return str(v); var n = parseInt(m[4], 10); return m[1] + '.' + m[2] + '.' + m[3] + (n > 1 ? ' (' + n + ')' : ''); };
  /** The calendar day in Asia/Bangkok (UTC+7, no summer time) as 'YYYY-MM-DD' for a time in ms. */
  L.bkkDay = function (ms) { return new Date(Number(ms) + 7 * 3600000).toISOString().slice(0, 10); };
  /** The opening rainbow sweep plays on the first open of each Bangkok day per phone: lastDay is the stored 'sc5.sbday' ('' / null = never). */
  L.sbShouldShine = function (lastDay, nowMs) { return str(lastDay) !== L.bkkDay(nowMs); };
  /** The "about" line for the save queue (n = entries waiting, photos included). */
  L.queueText = function (n) { return n > 0 ? 'รอส่ง ' + n + ' รายการ' : 'ส่งครบแล้ว ✓'; };

  /* ---- the full-count model (from the boot payload: column arrays) ---- */
  L.makeModel = function (b) {
    var m = { mode: 'fullcount', v: str(b.v), counter: str(b.counter), dateText: str(b.dateText), state: str(b.state), message: str(b.message), secondMessage: str(b.secondMessage),
      loc: str(b.loc), locs: (b.locs || []).map(str),
      sb: L.cleanBoard(b.sb),
      progress: copy(b.progress || { done: 0, total: 0, pct: 0, mine: 0, second: 0 }), parts: [], idIndex: Object.create(null), m2: Object.create(null), m1: Object.create(null),
      items: [], second: [], byPart: [], locked: Object.create(null), cards: Object.create(null), e2: Object.create(null), e1: Object.create(null), nOwn: 0 };
    var P = b.parts || {}, ids = P.id || [], i;
    for (i = 0; i < ids.length; i++) {
      var part = { id: ids[i], code2: str(P.code2[i]), name: str(P.name[i]), c1: str(P.c1[i]), codes: [] }, n2 = L.normScan(part.code2), n1 = L.normScan(part.c1);
      if (n2) part.codes.push(n2);
      if (n1 && part.codes.indexOf(n1) < 0) part.codes.push(n1);
      m.parts.push(part); m.idIndex[part.id] = i; m.byPart.push([]);
      if (n2 && !(n2 in m.m2)) m.m2[n2] = i;
      if (n1 && !(n1 in m.m1)) m.m1[n1] = i;
    }
    m.nOwn = m.parts.length;
    // shop parts that are not on this location's list ([code2, code1, name]; "done" shows only from this phone's own saves): found by code like any part, counted here on an extra shelf (the save goes the unknown-code way)
    (b.ext || []).forEach(function (x) {
      var e = { id: '', code2: str(x[0]), name: str(x[2]), c1: str(x[1]), codes: [], ext: true, doneOn: '', doneBy: '' }, a2 = L.normScan(e.code2), a1 = L.normScan(e.c1), i2 = m.parts.length;
      if (!a2) return;
      e.codes.push(a2); if (a1 && a1 !== a2) e.codes.push(a1);
      m.parts.push(e); m.byPart.push([]);
      if (!(a2 in m.e2)) m.e2[a2] = i2;
      if (a1 && !(a1 in m.e1)) m.e1[a1] = i2;
    });
    function cols(c, into, perPart) {
      c = c || {};
      var p = c.p || [];
      for (var j = 0; j < p.length; j++) { var it = { p: p[j], shelf: str(c.shelf[j]), done: !!c.done[j], on: str(c.on[j]), by: str(c.by[j]) }; into.push(it); if (perPart) m.byPart[it.p].push(it); }
    }
    cols(b.items, m.items, true);
    cols(b.second, m.second, false);
    m.xs = Object.create(null);   // counted EXTRA shelves (typed shelves that are not DMS shelves of the part), per part: [{ shelf, done: true, on, by }] (an old server sends no xs)
    (function (c) {
      var xp = c.p || [];
      for (var j = 0; j < xp.length; j++) {
        var pi = xp[j], sh = str((c.shelf || [])[j]);
        if (m.byPart[pi] === undefined || !sh.trim()) continue;
        (m.xs[pi] = m.xs[pi] || []).push({ shelf: sh, done: true, on: str((c.on || [])[j]), by: str((c.by || [])[j]) });
      }
    })(b.xs || {});
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
    if (n in m.e2) return m.e2[n];   // a shop part from another location: only after the whole own list (the server looks at the own list first)
    if (n in m.e1) return m.e1[n];
    return -1;
  };
  /** Thai-made Yamaha labels: the label says BF6-E7632-00 but the barcode reads BF6E7632000 (11 chars). When the exact read is not a part, try: (1) padded with zeros to 12 chars (the DMS code1 form),
   *  (2) an 11-12 char read whose tail after char 10 is all zeros cut to its first 10 chars (the code2 form without dashes). Only an exact hit of the list counts; two variants that hit DIFFERENT parts = ambiguous = -1.
   *  Returns the part index or -1. An exact hit is NOT handled here (findPart does that first). */
  L.findPartVariant = function (m, text) {
    var n = L.normScan(text);
    if (!n || !/^[A-Z0-9]+$/.test(n) || L.findPart(m, n) >= 0) return -1;
    var hits = [], tryv = function (v) { var p = L.findPart(m, v); if (p >= 0 && hits.indexOf(p) < 0) hits.push(p); };
    if (n.length >= 10 && n.length < 12) { var pad = n; while (pad.length < 12) pad += '0'; tryv(pad); }
    if ((n.length === 11 || n.length === 12) && /^0+$/.test(n.slice(10))) tryv(n.slice(0, 10));   // only when everything dropped is zeros: 90793AT42220 (real part 90793-AT422-20) must never become 90793-AT422
    return hits.length === 1 ? hits[0] : -1;
  };
  /** findPart, then the label-variant rule above */
  L.findPartLoose = function (m, text) { var p = L.findPart(m, text); return p >= 0 ? p : L.findPartVariant(m, text); };


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
    if (part.ext) { base.ext = true; base.second = false; base.locked = false; base.shelves = []; base.extDone = part.doneOn ? { doneOn: part.doneOn, doneBy: part.doneBy } : null; return base; }
    if (!forceFirst && m.cards[p]) { base.second = true; base.locked = false; base.shelves = m.cards[p].map(function (s) { return copy(s); }); return base; }
    base.second = false; base.locked = !!m.locked[p];
    base.shelves = m.byPart[p].map(function (it) { return { shelf: it.shelf, done: it.done, doneOn: it.on, doneBy: it.by }; });
    ((m.xs && m.xs[p]) || []).forEach(function (x) {   // a typed shelf that was counted (not a DMS shelf of this part): its own row, marked extra so a pick saves as otherShelf
      if (base.shelves.some(function (s) { return sameShelf(s.shelf, x.shelf); })) return;   // it IS a DMS shelf of the part: dropped (the DMS shelf shows its own state; the server needs the count in the DMS slot itself)
      base.shelves.push({ shelf: x.shelf, done: true, doneOn: x.on, doneBy: x.by, extra: true });
    });
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
      rows.push(it);
    }
    // counted rows (green) go to the bottom of their own shelf group; the order inside each part stays (list is already sorted by shelf, then code)
    if (f.doneLast && f.showDone) {
      var out = [], run = [], dn = [], i2;
      for (i2 = 0; i2 <= rows.length; i2++) {
        if (i2 === rows.length || (run.length + dn.length && rows[i2].shelf !== (run.length ? run[0] : dn[0]).shelf)) { out = out.concat(run, dn); run = []; dn = []; }
        if (i2 < rows.length) (rows[i2].done ? dn : run).push(rows[i2]);
      }
      rows = out;
    }
    // the cap comes last, after uncounted-first ordering, so green counted rows never push uncounted ones into "ยังมีอีก N"
    if (rows.length > max) {
      var un = rows.filter(function (r) { return !r.done; }).length, quota = Math.max(0, max - un), cut = [], nu = 0;
      rows.forEach(function (r) { if (!r.done) { if (nu++ < max) cut.push(r); } else if (quota > 0) { quota--; cut.push(r); } });
      hidden = rows.length - cut.length; rows = cut;
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
  L.unknownBody = function (code, shelf, qty, loc, mode) { var b = { unknown: true, unknownCode: code, unknownShelf: shelf, qty: String(qty), mode: mode === 'scan' ? 'scan' : 'type' }; if (loc) b.loc = loc; return b; };
  /** The header text under the name: date, the mode, and the location the person counts at today ("สนง.ใหญ่", a branch). */
  L.headerSub = function (date, fullcount, loc) { return str(date) + (fullcount ? ' · นับครั้งแรก' : '') + (str(loc) ? ' · ' + str(loc) : ''); };
  /** The location list a roaming person may pick from, or [] when there is nothing to pick (fewer than 2). */
  L.locChoices = function (locs, current) {
    var out = (locs || []).map(str).filter(Boolean);
    if (current && out.indexOf(str(current)) < 0 && out.length) out.push(str(current));
    return out.length > 1 ? out : [];
  };

  /* ---- v9: photo of a product that is not in DMS ---- */
  L.PHOTO_PLANS = [[1280, 0.7], [1280, 0.55], [1024, 0.5], [800, 0.45]];   // [longest edge, JPEG quality] tried in turn until the picture is small enough
  L.PHOTO_MAX_CHARS = 340000;                                               // data-URL length of about 250 KB
  L.photoPlan = function (w, h, i) {
    var p = L.PHOTO_PLANS[Math.min(Math.max(i, 0), L.PHOTO_PLANS.length - 1)], big = Math.max(Number(w) || 0, Number(h) || 0, 1), s = Math.min(1, p[0] / big);
    return { w: Math.max(1, Math.round((Number(w) || 1) * s)), h: Math.max(1, Math.round((Number(h) || 1) * s)), q: p[1] };
  };
  /** The queue body of a photo (the picture itself is kept apart, in IndexedDB / memory, under the entry's request id). */
  L.photoBody = function (code, shelf, qty, loc, countRid) { var b = { code: str(code), shelf: str(shelf), qty: String(qty) }; if (loc) b.loc = loc; if (countRid) b.countRid = str(countRid); return b; };
  /** The body loc of a save: always the place of the list the item came from (m.loc), else the picked place; '' only when neither is known. The server accepts it only when it is the person's own place / a roaming pick. */
  L.saveLoc = function (m, pick) { return str(m && m.loc) || str(pick); };
  /** '' when an unknown code may be saved, else the Thai reason: quantity / shelf as before, and now the photo of the product. */
  L.unknownCheck = function (qty, shelf, needShelf, photo) {
    if (qty === '' || (needShelf && !str(shelf).trim()) || isNaN(Number(qty)) || Number(qty) < 0) return needShelf ? 'กรุณาใส่จำนวนและชื่อชั้นวาง' : 'กรุณาใส่จำนวนที่นับได้';
    if (!photo) return 'ต้องถ่ายรูปสินค้าก่อน จึงจะบันทึกได้';
    return '';
  };

  /* ---- v9: GPS pick of the location for a roaming counter ---- */
  L.GEO_RADIUS_M = 300; L.GEO_MAX_ACC_M = 200; L.GEO_MARGIN_M = 150;
  /** Distance in metres between two lat/lng points (haversine). */
  L.geoMeters = function (a, b, c, d) {
    var R = 6371000, r = Math.PI / 180, dLat = (c - a) * r, dLng = (d - b) * r;
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
  };
  /**
   * The place GPS names, or ''. geo = {name: [lat, lng]} of ALL active places. The nearest place overall must be one of `choices` (the person's selectable places),
   * distance + accuracy must be within the radius, and the second-nearest place must be at least `margin` metres farther. A broken or too-poor fix says nothing.
   */
  L.nearestLoc = function (fix, geo, choices, radius, maxAcc, margin) {
    radius = radius || L.GEO_RADIUS_M; maxAcc = maxAcc || L.GEO_MAX_ACC_M; margin = margin === undefined ? L.GEO_MARGIN_M : margin;
    if (!fix || !isFinite(fix.lat) || !isFinite(fix.lng) || Math.abs(fix.lat) > 90 || Math.abs(fix.lng) > 180) return '';
    var acc = 0;
    if (fix.acc !== undefined && fix.acc !== null) { acc = Number(fix.acc); if (!(acc <= maxAcc)) return ''; }
    var all = [];
    Object.keys(geo || {}).forEach(function (n) {
      var g = geo[n]; if (!g || !isFinite(g[0]) || !isFinite(g[1])) return;
      all.push({ n: n, d: L.geoMeters(fix.lat, fix.lng, Number(g[0]), Number(g[1])) });
    });
    all.sort(function (a, b) { return a.d - b.d; });
    if (!all.length) return '';
    var first = all[0];
    if ((choices || []).indexOf(first.n) < 0) return '';
    if (first.d + acc > radius) return '';
    if (all.length > 1 && all[1].d - first.d < margin) return '';
    return first.n;
  };
  /**
   * What a GPS reading means. prev = the place GPS named last time (''), current = the place the list is on now, near = the place named now ('' = none).
   * Switch only when GPS names a place that is not the current one AND is not the place it already named before (then the person chose the other one by hand, and that wins).
   * Returns {place (the new "last GPS place"), switchTo ('' = stay)}.
   */
  L.geoDecide = function (prev, current, near) {
    if (!near) return { place: '', switchTo: '' };
    if (near === current || near === prev) return { place: near, switchTo: '' };
    return { place: near, switchTo: near };
  };
  /** After a manual pick, GPS stays quiet until the phone is more than `radius` metres from where the pick happened (anchor = {lat, lng}). true = still held. */
  L.geoHeld = function (anchor, fix, radius) {
    if (!anchor || !fix || !isFinite(fix.lat) || !isFinite(fix.lng)) return !!anchor;
    return L.geoMeters(anchor.lat, anchor.lng, fix.lat, fix.lng) <= (radius || L.GEO_RADIUS_M);
  };

  function sameShelf(a, b) {
    var x = str(a).trim().toLowerCase(), y = str(b).trim().toLowerCase();
    return x === y || (L.normScan(a) !== '' && L.normScan(a) === L.normScan(b));
  }
  L.sameShelf = sameShelf;   // (the page's shelf picker uses the same rule)
  /** The server's shelf match: an EXACT name first (trim, case-insensitive), then the normalised sameShelf rule - so 'A-1' and 'A1' stay two shelves. arr = objects, key = the name field; returns the item or null. */
  L.findShelf = function (arr, key, want) {
    var w = str(want).trim().toLowerCase(), i;
    for (i = 0; i < arr.length; i++) if (str(arr[i][key]).trim().toLowerCase() === w) return arr[i];
    for (i = 0; i < arr.length; i++) if (sameShelf(arr[i][key], want)) return arr[i];
    return null;
  };
  function hidden(o, k, v) { Object.defineProperty(o, k, { value: v, writable: true, enumerable: false, configurable: true }); }   // bookkeeping that must not show in JSON / comparisons
  function pct(p) { p.pct = p.total ? Math.round(p.done / p.total * 100) : 0; }

  /**
   * The optimistic effect of a queued save on the lists: the item turns "counted" (so it leaves the open list) and the progress moves.
   * Returns an undo record (or null when there is nothing to change). who = this counter, today = the Thai date text.
   */
  L.applySave = function (m, body, who, today) {
    if (!m || !body) return null;
    if (body.unknown) {   // a count of a shop part from another location (the card of such a part): it shows as counted on the card; a truly unknown code changes nothing
      var xp = L.findPart(m, body.unknownCode);
      if (xp < 0 || !m.parts[xp].ext) return null;
      var xu = { ext: m.parts[xp], on: m.parts[xp].doneOn, by: m.parts[xp].doneBy };
      m.parts[xp].doneOn = today; m.parts[xp].doneBy = who;
      return xu;
    }
    var p = m.idIndex[L.normId(body.id)];
    if (p === undefined) return null;
    var want = body.otherShelf !== undefined && str(body.otherShelf).trim() ? body.otherShelf : body.shelf, list = body.second ? m.second : m.byPart[p], hit = null;
    hit = L.findShelf(list.filter(function (x) { return x.p === p; }), 'shelf', want);
    var undo = { item: hit, done: hit ? hit.done : false, on: hit ? hit.on : '', by: hit ? hit.by : '', progress: copy(m.progress), dDone: 0, dMine: 0, card: null };
    if (body.second && m.cards[p]) {   // the blind card shows the shelf as counted too
      var bs = L.findShelf(m.cards[p], 'shelf', want);
      m.cards[p].forEach(function (s) { if (s === bs) { undo.card = { s: s, done: s.done, on: s.doneOn, by: s.doneBy }; s.done = true; s.doneOn = today; s.doneBy = who; } });
    }
    if (hit) {
      var mineAlready = hit.done && hit.by === who && hit.on === today;
      if (!body.second && !hit.done) { m.progress.done++; undo.dDone = 1; }
      if (!mineAlready) { m.progress.mine++; undo.dMine = 1; }
      hit.done = true; hit.on = today; hit.by = who;
    } else if (!body.second) {   // an extra (typed) shelf: counts as my work only, and the card lists it as a counted shelf (m.xs)
      var xmine = false;   // (the same "my own count today again" rule as the DMS items)
      if (str(want).trim()) {
        m.xs = m.xs || Object.create(null);
        var xl = m.xs[p] = m.xs[p] || [], xh = null;
        xh = L.findShelf(xl, 'shelf', want);
        if (xh) xmine = xh.by === who && xh.on === today;
        else { xh = { shelf: str(want).trim(), done: true, on: today, by: who }; xl.push(xh); hidden(xh, '_base', null); hidden(xh, '_h', []); }
        if (!xh._h) { hidden(xh, '_base', { on: xh.on, by: xh.by }); hidden(xh, '_h', []); }
        var rec = { on: today, by: who }; xh._h.push(rec); xh.on = today; xh.by = who;   // each queued save leaves a record: a refusal drops only its own
        undo.xs = { list: xl, e: xh, rec: rec };
      }
      if (!xmine) { m.progress.mine++; undo.dMine = 1; }
    }
    if (body.second) m.progress.second = m.second.filter(function (x) { return !x.done; }).length;
    pct(m.progress);
    return undo;
  };
  L.revertSave = function (m, undo) {
    if (!m || !undo) return;
    if (undo.ext) { undo.ext.doneOn = undo.on; undo.ext.doneBy = undo.by; return; }
    if (undo.item) { undo.item.done = undo.done; undo.item.on = undo.on; undo.item.by = undo.by; }
    if (undo.xs) {   // drop this save's record; the entry shows the newest record left, else its boot values, else (created by a refused save alone) it goes away
      var xe2 = undo.xs.e, ri = xe2._h ? xe2._h.indexOf(undo.xs.rec) : -1;
      if (ri >= 0) {
        xe2._h.splice(ri, 1);
        if (xe2._h.length) { var last = xe2._h[xe2._h.length - 1]; xe2.on = last.on; xe2.by = last.by; }
        else if (xe2._base) { xe2.on = xe2._base.on; xe2.by = xe2._base.by; }
        else { var xi = undo.xs.list.indexOf(xe2); if (xi >= 0) undo.xs.list.splice(xi, 1); }
      }
    }
    if (undo.card) { undo.card.s.done = undo.card.done; undo.card.s.doneOn = undo.card.on; undo.card.s.doneBy = undo.card.by; }
    if (undo.dDone === undefined) { m.progress = copy(undo.progress); return; }   // (an old-style record: whole snapshot)
    m.progress.done = Math.max(0, m.progress.done - undo.dDone); m.progress.mine = Math.max(0, m.progress.mine - undo.dMine);   // only this save's own change: later queued saves keep theirs
    if (m.second) m.progress.second = m.second.filter(function (x) { return !x.done; }).length;
    pct(m.progress);
  };
  L.secondLeft = function (m) { return m.second.filter(function (x) { return !x.done; }).length; };

  /* ---- the save queue (a plain array, oldest first; one request in flight at a time so saves keep their order) ---- */
  var BACKOFF = [1500, 3000, 6000, 12000, 24000, 48000, 60000];
  L.GIVEUP_MS = 30 * 60 * 1000;   // a count/photo the server keeps answering FAULT/BUSY is given back after this long
  L.backoffMs = function (tries) { return BACKOFF[Math.min(Math.max(tries, 1), BACKOFF.length) - 1]; };
  /** tok = the link token the save was made under: it is sent with THIS token, never with another person's */
  L.newEntry = function (kind, rid, body, label, now, tok) { return { rid: rid, kind: kind, body: body, label: str(label), tries: 0, next: 0, born: now || 0, tok: str(tok) }; };
  L.qAdd = function (q, e) { q.push(e); return q; };
  /** The entry to send now (the oldest, when its retry time has come) or null. */
  L.qDue = function (q, now) {   // (a photo that waits for its retry never holds back the counts behind it; counts keep their order)
    var heldPart = {}, heldRid = {};   // a faulting head that is stepped over after GIVEUP_MS: a LATER entry for the same part (or the photo of that count) must never overtake it; other parts go on
    for (var i = 0; i < q.length; i++) {
      var e = q[i], pk = e.kind !== 'photo' && e.body ? e.kind + '|' + (e.body.id !== undefined && e.body.id !== '' ? String(e.body.id) : 'u:' + String(e.body.unknownCode) + '|' + String(e.body.loc || '')) : '';   // (an unknown-code save has no id: its code + place name the part)
      if ((pk && heldPart[pk]) || (e.kind === 'photo' && e.body && heldRid[e.body.countRid])) continue;
      if (e.next <= now) return e;
      if (e.kind !== 'photo') {
        if (!(e.lastFault && e.firstFail && now - e.firstFail >= L.GIVEUP_MS)) return null;
        heldPart[pk] = 1; heldRid[e.rid] = 1;
      }
    }
    return null;
  };
  L.qNextAt = function (q) { var m = Infinity; q.forEach(function (e) { if (e.next < m) m = e.next; }); return m; };
  L.qIndex = function (q, rid) { for (var i = 0; i < q.length; i++) if (q[i].rid === rid) return i; return -1; };
  L.qRetry = function (q, rid, now) { var i = L.qIndex(q, rid); if (i < 0) return null; q[i].tries++; q[i].next = now + L.backoffMs(q[i].tries); return q[i]; };
  L.qDrop = function (q, rid) { var i = L.qIndex(q, rid); if (i >= 0) q.splice(i, 1); return q; };
  /** the automatic list refresh waits while counts are waiting to be sent; a waiting (even failing) picture does not hold it back */
  L.syncHeld = function (q, manual) { return !manual && q.some(function (e) { return e.kind !== 'photo'; }); };
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
    return a.filter(function (e) { return e && typeof e === 'object' && typeof e.rid === 'string' && (e.kind === 'fc' || e.kind === 'daily' || e.kind === 'photo') && e.body && typeof e.body === 'object' && (token === undefined || !e.tok || e.tok === token); })
      .map(function (e) { var o = { rid: e.rid, kind: e.kind, body: e.body, label: str(e.label), tries: 0, next: 0, born: Number(e.born) || 0, tok: str(e.tok) || str(token) }; if (e.lostPhoto) o.lostPhoto = true; if (Number(e.firstFail) > 0) o.firstFail = Number(e.firstFail); if (e.lastFault === true) o.lastFault = true; return o; });
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
    if (withQr) { list.push(F.QR_CODE); if (F.DATA_MATRIX !== undefined) list.push(F.DATA_MATRIX); }
    h.set(ZX.DecodeHintType.POSSIBLE_FORMATS, list);
    h.set(ZX.DecodeHintType.TRY_HARDER, true);
    return h;
  };
  /** Decodes one luminance source (a canvas source in the page) with ZXing's MultiFormatReader: the text, or '' when nothing was found. */
  L.zxDecodeSource = function (ZX, source, hints, invert) {
    try {
      if (invert) { if (typeof ZX.InvertedLuminanceSource !== 'function') return ''; source = new ZX.InvertedLuminanceSource(source); }   // white-on-black labels
      try { source.isRotateSupported = function () { return false; }; } catch (eR) { /* ZXing 0.21.3: the canvas source's rotate() is broken (it keeps width/height), so TRY_HARDER's turned retry decoded garbage and doubled the cost; turning is done by our own rotated canvas */ }
      var bitmap = new ZX.BinaryBitmap(new ZX.HybridBinarizer(source)), reader = new ZX.MultiFormatReader();
      return str(reader.decode(bitmap, hints).getText());
    } catch (e) { return ''; }
  };
  /** The part of the video that is decoded: a wide, short band in the middle (90% of the width x 35% of the height), at the video's full resolution. */
  L.bandRect = function (vw, vh) {
    var sw = Math.max(1, Math.round(vw * 0.9)), sh = Math.max(1, Math.round(vh * 0.35));
    return { sx: Math.round((vw - sw) / 2), sy: Math.round((vh - sh) / 2), sw: sw, sh: sh };
  };
  /** Which view ZXing decodes on live frame n. Budget: the centre band (full resolution) gets at least 2 of every 3 frames; the third frame cycles whole frame (downscaled), inverted band, rotated strip, band. */
  L.zxVariant = function (n) { var m = ((n % 12) + 12) % 12; return m % 3 !== 2 ? 'band' : ['full', 'inv', 'rot', 'band'][(m - 2) / 3]; };
  L.LIVE_FULL_MAX = 960;   // the whole-frame live view is shrunk to this long edge before ZXing sees it (never a 1080x1920 decode on the main thread)
  /** Photo decode plan for a picture of iw x ih pixels: views in the order tried, each {tag, sx, sy, sw, sh (source rectangle, NATIVE pixels), dw, dh (drawn size), rot (0/90/270), inv}.
   *  Order: centre band (full width, 30% height, native), centre tile, whole picture (long edge <= 2000), centre vertical strip turned 90, the other 8 tiles of a 3x3 overlapping set (each <= 1600 px, native),
   *  whole turned 90 and 270, the band and the whole inverted. A small barcode (30% of a 4032 px picture) is only readable at native size, so the crops come before the shrunk whole view's rotations. */
  L.PHOTO_BUDGET_MS = 9000; L.PHOTO_WHOLE_MAX = 2000; L.PHOTO_TILE_MAX = 1600; L.PHOTO_BAND_MAX = 4200;
  L.photoViewPlan = function (iw, ih) {
    iw = Math.max(1, Math.round(Number(iw) || 0)); ih = Math.max(1, Math.round(Number(ih) || 0));
    var seen = {};
    var mk = function (tag, sx, sy, sw, sh, cap, rot, inv) {
      sw = Math.min(sw, iw); sh = Math.min(sh, ih); sx = Math.max(0, Math.min(iw - sw, sx)); sy = Math.max(0, Math.min(ih - sh, sy));
      var key = [sx, sy, sw, sh, rot, inv ? 1 : 0, cap].join(), k = Math.min(1, cap / Math.max(sw, sh));
      if (seen[key]) return null; seen[key] = 1;
      return { tag: tag, sx: sx, sy: sy, sw: sw, sh: sh, dw: Math.max(1, Math.round(sw * k)), dh: Math.max(1, Math.round(sh * k)), rot: rot || 0, inv: !!inv };
    };
    var out = [], push = function (v) { if (v) out.push(v); };
    var bh = Math.max(1, Math.round(ih * 0.3)), by = Math.round((ih - bh) / 2), vw = Math.max(1, Math.round(iw * 0.3));
    var tw = Math.min(L.PHOTO_TILE_MAX, iw), th = Math.min(L.PHOTO_TILE_MAX, ih), gx = Math.round((iw - tw) / 2), gy = Math.round((ih - th) / 2), tiles = [];
    if (tw * th < 0.85 * iw * ih) [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (o) { var v = mk('tile', gx + o[0] * gx, gy + o[1] * gy, tw, th, L.PHOTO_TILE_MAX, 0, false); if (v) tiles.push(v); });
    push(mk('band', 0, by, iw, bh, L.PHOTO_BAND_MAX, 0, false));
    if (tiles.length) push(tiles.shift());
    push(mk('whole', 0, 0, iw, ih, L.PHOTO_WHOLE_MAX, 0, false));
    push(mk('vband', Math.round((iw - vw) / 2), 0, vw, ih, L.PHOTO_BAND_MAX, 90, false));
    tiles.forEach(push);
    push(mk('rot90', 0, 0, iw, ih, L.PHOTO_WHOLE_MAX, 90, false)); push(mk('rot270', 0, 0, iw, ih, L.PHOTO_WHOLE_MAX, 270, false));
    push(mk('invband', 0, by, iw, bh, L.PHOTO_BAND_MAX, 0, true)); push(mk('inv', 0, 0, iw, ih, L.PHOTO_WHOLE_MAX, 0, true));
    return out;
  };
  /** Which engine the live scan starts with: 'native' only when getSupportedFormats() lists code_128 or code_39 (many Android builds expose a BarcodeDetector that supports nothing), else 'zxing'. */
  L.pickEngine = function (supported) {
    var ok = Array.isArray(supported) && supported.some(function (f) { return f === 'code_128' || f === 'code_39'; });
    return ok ? 'native' : 'zxing';
  };
  /** Android camera pick: devices = enumerateDevices() entries. Returns the deviceId of the main back camera (lowest camera2 index, no ultra/wide/tele/depth/macro lens) or '' (keep facingMode: iOS, unknown labels). */
  L.pickBackCamera = function (devices) {
    var BAD = /ultra|wide|tele|depth|macro/i, best = null;
    (devices || []).forEach(function (d) {
      if (!d || d.kind !== 'videoinput' || !d.deviceId) return;
      var lab = String(d.label || ''), m = /camera2?\s*(\d+)/i.exec(lab);
      if (!/camera2/i.test(lab) || !m || !/facing back/i.test(lab)) return;
      var c = { id: d.deviceId, idx: parseInt(m[1], 10), bad: BAD.test(lab) ? 1 : 0 };
      if (!best || c.bad < best.bad || (c.bad === best.bad && c.idx < best.idx)) best = c;
    });
    return best ? best.id : '';
  };
  /** All back cameras -> [{id, label}], main first: "camera2 N, facing back" labels (good lenses, lowest index first), else any label with back/rear/environment (Samsung Internet may not use camera2 labels). Android use. */
  L.backCameras = function (devices) {
    var BAD = /ultra|wide|tele|depth|macro/i, out = [];
    (devices || []).forEach(function (d) {
      if (!d || d.kind !== 'videoinput' || !d.deviceId) return;
      var lab = String(d.label || ''), m = /camera2?\s*(\d+)/i.exec(lab), c2 = /camera2/i.test(lab) && m && /facing back/i.test(lab);
      if (!c2 && !/back|rear|environment/i.test(lab)) return;
      out.push({ id: d.deviceId, label: lab, idx: c2 ? parseInt(m[1], 10) : (m ? 50 + parseInt(m[1], 10) : 99), bad: BAD.test(lab) ? 1 : 0, c2: c2 ? 0 : 1 });
    });
    out.sort(function (x, y) { return x.c2 - y.c2 || x.bad - y.bad || x.idx - y.idx; });
    return out.map(function (c) { return { id: c.id, label: c.label }; });
  };
  /** a stable name for a camera that survives page loads (Samsung Internet changes deviceIds): "camera2 N" when the label has it, else the whole label */
  L.camKey = function (label) { var m = /camera2?\s*(\d+)/i.exec(String(label || '')); return m ? 'camera2 ' + m[1] : String(label || ''); };
  /** the list entry whose label matches a stored camKey (or null) */
  L.matchCam = function (list, key) { if (!key) return null; for (var i = 0; i < (list || []).length; i++) if (L.camKey(list[i].label) === key) return list[i]; return null; };
  /** true when the lens cannot focus: focusMode offers neither continuous nor single-shot, or focusDistance has min === max. Unknown / missing capabilities = false. */
  L.fixedFocus = function (caps) {
    if (!caps) return false;
    var fm = caps.focusMode, fd = caps.focusDistance;
    if (Array.isArray(fm) && fm.indexOf('continuous') < 0 && fm.indexOf('single-shot') < 0) return true;
    if (fd && fd.min !== undefined && fd.max !== undefined && Number(fd.min) === Number(fd.max)) return true;
    return false;
  };
  /** the camera after cur in the list (wraps); '' when fewer than 2 */
  L.nextCam = function (list, cur) {
    if (!Array.isArray(list) || list.length < 2) return '';
    var i = list.indexOf(cur); return list[(i + 1) % list.length];
  };
  /** one diagnostic line for the owner's screenshot */
  L.diagLine = function (o) {
    o = o || {};
    return 'engine ' + (o.engine || '?') + ' | cam ' + (o.label || '?') + ' | ' + (o.w || 0) + 'x' + (o.h || 0) + ' | zoom ' + (o.zoom === undefined || o.zoom === '' ? '-' : o.zoom) + ' | focus ' + (o.focus || '-') + ' | ' + (Number(o.fps) || 0).toFixed(1) + ' fps | native ' + (o.natHits || 0) + '/' + (o.natCalls || 0) + ' | zx ' + (o.zxN || 0) + ' | samsung ' + (o.samsung ? 'yes' : 'no');
  };
  /** iPhone / iPad (also iPadOS posing as a Mac): the camera pick below is only for these. */
  L.isIOS = function (ua, platform, touchPoints) { return /iPad|iPhone|iPod/.test(str(ua)) || (str(platform) === 'MacIntel' && Number(touchPoints) > 1); };
  /** iOS camera pick (labels readable after permission): "Back Triple Camera", else "Back Dual Wide Camera" (both switch to the macro lens for close focus by themselves), else "Back Dual Camera".
   *  Returns {id, virtual: true} or null (keep facingMode environment). */
  L.pickIosCamera = function (devices) {
    var pats = [/back triple camera/i, /back dual wide camera/i, /back dual camera/i], list = (devices || []).filter(function (d) { return d && d.kind === 'videoinput' && d.deviceId; });
    for (var i = 0; i < pats.length; i++) for (var j = 0; j < list.length; j++) if (pats[i].test(String(list[j].label || ''))) return { id: list[j].deviceId, virtual: true, wide: i < 2 };   // wide: Triple / Dual Wide start on the wide lens (2x); plain Dual (wide + tele, no macro) must not get the 2x default: it lands on the telephoto
    return null;
  };
  /** A saved engine note ('zx:<ms>') is valid for 7 days; anything else (old 'zx', junk, expired) is ignored. */
  L.engineSavedValid = function (v, now) {
    var m = /^zx:(\d+)$/.exec(String(v || '')); if (!m) return false;
    var age = now - parseInt(m[1], 10); return age >= 0 && age < 7 * 86400000;
  };
  /** A native BarcodeDetector answer ([{rawValue, format}]) -> the first 1D read ('' when there is only a QR or nothing) */
  L.pickLive = function (results, m, opt) {
    opt = opt || {};
    var rs = (results || []).filter(function (x) { return x && x.rawValue && L.ONE_D_NATIVE.indexOf(x.format) >= 0; });
    if (!rs.length) return '';
    if (rs.length > 1) {   // several barcodes in one frame
      var prefer = opt.prefer || [];   // the open card's own codes (normalised): they win
      for (var q = 0; q < rs.length; q++) if (prefer.indexOf(L.normScan(rs[q].rawValue)) >= 0) return str(rs[q].rawValue);
      if (m && prefer.length) for (var q2 = 0; q2 < rs.length; q2++) {   // a variant label of the open card's part
        var pi = L.findPartLoose(m, rs[q2].rawValue), pp = pi >= 0 ? m.parts[pi] : null;
        if (pp && [pp.code2, pp.c1, pp.code1].some(function (c) { return c && prefer.indexOf(L.normScan(c)) >= 0; })) return str(rs[q2].rawValue);
      }
      var pool = rs;
      if (m) { var hits = rs.filter(function (x) { return L.findPartLoose(m, x.rawValue) >= 0; }); if (hits.length) pool = hits; }
      if (opt.cx !== undefined && opt.cy !== undefined && pool.length > 1 && pool.every(function (x) { return x.boundingBox; })) {   // nearest to the frame centre
        var bd = function (x) { var b = x.boundingBox; return Math.pow(b.x + b.width / 2 - opt.cx, 2) + Math.pow(b.y + b.height / 2 - opt.cy, 2); };
        var nb = pool[0]; pool.forEach(function (x) { if (bd(x) < bd(nb)) nb = x; });
        return str(nb.rawValue);
      }
      if (pool !== rs) return str(pool[0].rawValue);
      var best = rs[0], bl = -1;   // none is a part: the longest plausible one
      rs.forEach(function (x) { var l = L.isPlausibleCode(x.rawValue) ? L.normScan(x.rawValue).length : 0; if (l > bl) { best = x; bl = l; } });
      return str(best.rawValue);
    }
    return str(rs[0].rawValue);
  };
  /** The views whose reads are NOT trusted on one sighting (they see neighbours / other labels): the find-scan sheet wants them twice. */
  L.isWideView = function (v) { return v === 'full' || v === 'strip' || v === 'rot' || /^zx:/.test(String(v || '')); };   // 'zx:<view>' = any ZXing read (even its full-width band can hold two labels side by side and the left one may win): twice, like the wide views
  /** The native view for live frame n; centreOnly (piece counting) = always the centre band. */
  L.nativeViewFor = function (n, centreOnly) { return centreOnly ? 'band' : L.nativeView(n); };
  /** Which view the native detector gets on live frame n: the centre band (2 of 4), the WHOLE frame at native size, a wide short centre strip (full width, 20% height) at native size. */
  L.nativeView = function (n) { return ['band', 'full', 'band', 'strip'][((n % 4) + 4) % 4]; };
  /** Photo path: when a photo holds both a 1D barcode and a QR, the 1D one wins; a QR alone is still returned. */
  L.preferOneD = function (results) {
    var all = (results || []).filter(function (x) { return x && x.rawValue; });
    var one = all.filter(function (x) { return L.ONE_D_NATIVE.indexOf(x.format) >= 0; })[0] || all[0];
    return one ? str(one.rawValue) : '';
  };
  /** A read that can be a part code: no link, and after normScan only A-Z / 0-9, 5 to 20 characters (real DMS codes are at most 14, the longest is SUN4281061435T; the rest is slack for odd labels). */
  /** A camera open error that will not go away by itself (this camera cannot be used): only these mark a camera bad for the session. */
  L.camHardFail = function (err) { var n = err && err.name; return n === 'OverconstrainedError' || n === 'NotFoundError'; };
  L.isPlausibleCode = function (text) {
    var raw = str(text);
    if (/:\/\/|www\./i.test(raw)) return false;
    return /^[A-Z0-9]{5,20}$/.test(L.normScan(raw));
  };
  /** The usable codes in a read, best first: the read itself when it is plausible, then the part before a trailing quantity / lot suffix ("5TL-H1919-00/12", "...+3", "... 12", "....5"). [] = rejected. */
  L.readCandidates = function (text, m) {
    var raw = str(text), out = [];
    if (!raw || /:\/\/|www\./i.test(raw)) return out;
    if (L.isPlausibleCode(raw)) out.push(raw);
    var first = raw.replace(/^[\s'\u2018\u2019\u02bc`]+/, '').split(/[\/+.\s]/)[0];
    // the prefix is only used when it is an exact part of the list (m = the loaded list): a prefix-only read never makes an unknown card, unknown cards come from the raw read
    if (first && m && L.isPlausibleCode(first) && L.findPart(m, first) >= 0 && (!out.length || L.normScan(first) !== L.normScan(raw))) out.push(first);
    // label variant (BF6-E7632-00 printed, BF6E7632000 in the barcode): the matching part's own code is added after the raw read; the raw read stays first (an unknown card uses it)
    if (m && L.isPlausibleCode(raw) && L.findPart(m, raw) < 0) { var vp = L.findPartVariant(m, raw); if (vp >= 0) out.push(m.parts[vp].code2 || m.parts[vp].c1); }
    return out;
  };
  /** The short Thai note for a read that is not a part code (the raw text is shown, cut at 40 characters); '' for nothing. */
  L.rejectMsg = function (raw) {
    var t = str(raw).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    return 'อ่านได้: ' + (t.length > 40 ? t.slice(0, 40) + '…' : t) + ' — ไม่ใช่รหัสอะไหล่';
  };
  /** One note per distinct raw value: note(raw) returns the message the first time, '' afterwards (a scan session = one of these). */
  L.makeRejectNotes = function () {
    var seen = {}, n = 0;
    return { note: function (raw) {
      var m = L.rejectMsg(raw); if (!m) return '';
      var key = str(raw).trim(); if (seen[key]) return '';
      if (++n > 200) { seen = {}; n = 1; }
      seen[key] = 1; return m;
    } };
  };
  /** A typed code long enough to be a whole part code (a plausible code of 12+ normalised characters, e.g. 90793-AT479-00): if it is not in the list it is an unlisted product, not a half-typed search. */
  L.isFullCode = function (text) {
    return L.isPlausibleCode(text) && L.normScan(text).length >= 12;
  };
  /** 'empty' (nothing read) | 'ignored' (something read that is not a part code: silently dropped) | 'plausible' (+ n = its normalised text) */
  L.readClass = function (text, m) {
    if (!str(text)) return { kind: 'empty', n: '' };
    var c = L.readCandidates(text, m);
    if (!c.length) return { kind: 'ignored', n: '' };
    return { kind: 'plausible', n: L.normScan(c[0]), text: c[0], cands: c };
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
  L.zoomPlan = function (caps, want) {
    var z = caps && caps.zoom;
    if (!z || typeof z !== 'object' || !(Number(z.max) > Number(z.min))) return null;
    var min = Number(z.min) || 1, max = Number(z.max);
    return { min: min, max: max, def: Math.max(min, Math.min(Number(want) > 0 ? Number(want) : 2, max)) };
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
  L.photoTooOld = function (lastModified, now) { return !lastModified || (now - lastModified) > PHOTO_MAX_AGE; };
  /** Checks one daily card before it is queued (the same messages as the old page). d: {crates, per, loose, foundAt, photo, lastModified, now} (qty only for a plain entry) */
  var WHOLE_ONLY = 'กรอกจำนวนเป็นเลขจำนวนเต็มเท่านั้น';
  function whole(v) { var t = str(v).trim(); return t === '' ? null : (/^\d{1,6}$/.test(t) ? parseInt(t, 10) : NaN); }   // the server's rule exactly (Logic.gs wholeNumber): digits only, at most 6, no sign / decimal point
  L.dailyCheck = function (d) {
    var answer, pieces;
    if (d.qty === undefined || d.qty === null || d.crates !== undefined || d.per !== undefined || d.loose !== undefined) {   // the page always sends the crates x per-crate + loose entry (the plain qty form is only kept for the checks)
      if (str(d.crates) === '' && str(d.per) === '' && str(d.loose) === '') return { ok: false, error: 'กรุณากรอกจำนวนที่นับได้' };
      var wc = whole(d.crates), wp = whole(d.per), wl = whole(d.loose);
      if (isNaN(wc) || isNaN(wp) || isNaN(wl)) return { ok: false, error: WHOLE_ONLY };
      if ((wc || 0) > 0 && !wp) return { ok: false, error: 'กรุณากรอกจำนวนชิ้นต่อลัง' };
      answer = { crates: str(d.crates), perCrate: str(d.per), loose: str(d.loose) };
      pieces = (wc || 0) * (wp || 0) + (wl || 0);
    } else {
      if (str(d.qty) === '') return { ok: false, error: 'กรุณากรอกจำนวนที่นับได้ (ไม่มีให้ใส่ 0)' };
      if (isNaN(whole(d.qty))) return { ok: false, error: WHOLE_ONLY };
      answer = { qty: str(d.qty) };
      pieces = whole(d.qty) || 0;
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

  var store = L.makeStore(function () { return window.localStorage; });
  /* per-phone settings (Settings page): font size, vibration, camera info. A write that storage refuses still holds for this page load (pmem). */
  var KFONT = 'sc5.font', KVIB = 'sc5.vib', KDIAG = 'sc5.diag', KSBDAY = 'sc5.sbday', pmem = {};
  function prefGet(k) { return k in pmem ? pmem[k] : store.get(k); }
  function prefSet(k, v) { pmem[k] = v; if (v === null) store.del(k); else store.set(k, v); }   // null = back to the default (the key is removed)
  function fontBig() { return prefGet(KFONT) === 'big'; }
  function vibOn() { return prefGet(KVIB) !== '0'; }        // default on
  function diagOn() { return prefGet(KDIAG) === '1'; }      // default off
  function applyFont() { try { var r = document.documentElement; if (r && r.classList) r.classList.toggle('fbig', fontBig()); } catch (e) { /* no big text: fine */ } }
  var KLINK = 'sc5.link';            // the staff link {x,t} kept so a home-screen launch (no #hash) still works; never the PIN
  var linkFromStore = !L.parseHash(location.hash);   // true when the link came from the saved copy, not from the address
  var T = L.resolveLink(location.hash, store.get(KLINK));
  if (T) {
    // (the saved copy is written only after the server has accepted this link: see acceptBoot)
    if (!L.parseHash(location.hash)) { try { history.replaceState(null, '', location.href.split('#')[0] + '#x=' + T.x + '&t=' + T.t); } catch (e) { /* fine */ } }   // replaceState fires no hashchange
  }
  var EXEC = T ? L.execUrl(T.x) : '';
  var KQ = T ? L.storeKey('q', T.t) : '', KL = T ? L.storeKey('l', T.t) : '';

  var PIN = null;                    // memory only, never stored. null = none typed (a probe / a person with no PIN)
  var M = null, D = null;            // full-count model / daily page
  var cachedBoot = null;             // the last list this phone kept for this link (shown right after the PIN is typed)
  var verified = false, probing = false, pendingPin = null, paused = false;
  var Q = [], gone = Object.create(null), adopted = Object.create(null), vanished = Object.create(null), sendingRid = '', inflight = false, pumpTimer = null, syncTimer = null, toastTimer = null, lockTimer = null, undoMap = {};
  var ST = { q: '', shelf: '', showDone: false, tab: 'first', expanded: false };
  var reloading = false, card = null, notes = [], prefill = {}, draft = {}, loadedAt = 0, noStore = false, offline = false, reloadWhenEmpty = false, lostList = [], offTimer = null;
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
  function buzz(p) { try { if (navigator.vibrate && vibOn()) navigator.vibrate(p); } catch (e) { /* ignore */ } }   // Settings: สั่นเมื่อสแกนติด (default on; the setting row is hidden where vibrate does not exist)
  function toast(msg, ms) {
    var t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, ms || 1800);
  }

  /* ---------------- network ---------------- */
  var NET = { ok: false, code: 'NET', error: 'เชื่อมต่อไม่ได้ ตรวจสอบสัญญาณแล้วลองใหม่' };
  var locCache = {};   // v9: the last list the server sent for each place (this session only), shown at once when switching back while the fresh one loads
  var pickLoc = '';   // v7: the location a roaming person picked (empty = the server decides)
  function api(action, extra, cb, timeoutMs, token) {
    if (pickLoc && (action === 'boot' || action === 'sync' || action === 'daily')) { var ex = {}; Object.keys(extra || {}).forEach(function (k) { ex[k] = extra[k]; }); ex.loc = pickLoc; extra = ex; }
    var asked = (action === 'boot' || action === 'sync' || action === 'daily') ? pickLoc : null;   // the place this request asked for (a reply is judged against it)
    var body = L.makeRequest(token || T.t, PIN, action, extra), ctl = null, to = null, finished = false, srcBio = bioSourced && PIN !== null && PIN !== undefined;   // srcBio: this request carries a PIN that came from the face / fingerprint scan
    function fin(res) {
      if (finished) return; finished = true; clearTimeout(to);
      bioWatch(res, srcBio);
      if (asked !== null && res && typeof res === 'object' && res !== NET) { try { Object.defineProperty(res, '_asked', { value: asked, enumerable: false, configurable: true }); } catch (e) { /* ignore */ } }
      cb(res);
    }
    try {
      if (typeof AbortController !== 'undefined') ctl = new AbortController();
      to = setTimeout(function () { try { if (ctl) ctl.abort(); } catch (e) { /* ignore */ } fin(NET); }, timeoutMs || 30000);   // (always a timer: without AbortController the fetch cannot be cancelled, but the caller is released)
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
  var padGen = 0;   // bumped by showPad: a sync reply that was sent before the pad came up is dropped
  function showPad(msg, locked, set) {
    padGen++;
    if (bioStale) { msg = 'รหัสเปลี่ยนแล้ว ใส่รหัสใหม่'; bioStale = false; }   // the saved scan no longer matches the code: it was deleted, the new code is typed once
    if (set || locked) bioCancel();   // a code to choose / a lock: no scan now
    bioSourced = false; padLocked = !!locked; bioOfferClose();
    camStop(); PIN = null; padBuf = ''; padBusy = false; verified = false; drawDots();
    clearTimeout(rebootTimer); rebootGen++;   // a pending place-switch reboot must not go out with PIN=null (a wrong try server-side); it resumes after the PIN is accepted
    setMode = set ? 'enter' : ''; firstPin = ''; drawSetMode();
    $('app').hidden = true; $('pad').hidden = false; drawInstall();
    $('padLinkHint').hidden = !linkFromStore;   // a saved (old) link may be dead: tell the person where to look, nothing else changes
    if (!$('scan').hidden) closeScan();   // closeScan also syncs the back-history entry; any open card is kept as it was
    closeSettings();
    $('padMsg').textContent = msg || ''; lockKeys(!!locked);
    clearTimeout(syncTimer); clearTimeout(lockTimer);
    if (locked) lockTimer = setTimeout(function () { padLocked = false; lockKeys(false); $('padMsg').textContent = ''; bioDraw(); }, 15 * 60 * 1000 + 3000);
    bioDraw(); bioDrawFoot();
  }
  function padPress(d) {
    if (padBusy || padBuf.length >= 4) return;
    padBuf += d; drawDots();
    if (padBuf.length === 4 && setMode) { setPress(padBuf); return; }
    if (padBuf.length === 4) {
      feedPin(padBuf, false);
    }
  }
  /** A whole PIN (typed, or decrypted after a scan) goes the one way: held back while the "does this link need a PIN" probe is out, else straight to the server. */
  function feedPin(pin, fromBio) {
    bioSourced = !!fromBio; typedByHand = !fromBio;
    if (fromBio) { padBuf = pin; drawDots(); }
    if (probing) { pendingPin = pin; $('padMsg').textContent = 'กำลังตรวจรหัส…'; padBusy = true; return; }   // the "does this link need a PIN" probe is still out
    submitPin(pin);
  }
  /** Four digits typed while choosing a code: remember them, ask again; if the two differ start over; if they match save them and go straight in. */
  function setPress(typed) {
    if (setMode === 'enter') {
      firstPin = typed; setMode = 'confirm'; padBuf = ''; drawDots(); drawSetMode(); $('padMsg').textContent = ''; return;
    }
    if (typed !== firstPin) {
      firstPin = ''; setMode = 'enter'; padBuf = ''; drawDots(); drawSetMode(); $('padMsg').textContent = 'รหัสไม่ตรงกัน ลองใหม่'; return;
    }
    padBusy = true; PIN = typed; bioSourced = false; typedByHand = true; $('padMsg').textContent = 'กำลังบันทึกรหัส…';
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

  /* ---------------- Face ID / fingerprint unlock (optional shortcut on top of the PIN) ----------------
   * WebAuthn + the PRF extension: the phone's scan yields a secret that only this phone can make; it encrypts the PIN (AES-GCM).
   * localStorage keeps only {v,id,salt,iv,ct}; the plain PIN is never stored. Anything that goes wrong falls back to the ordinary PIN pad.
   * Only on a phone used by ONE staff link: if the storage holds data of another link, nothing is offered and nothing is scanned. */
  var KBIO = T ? L.storeKey('bio', T.t) : '', KBION = T ? L.storeKey('bioNo', T.t) : '';
  var bioRec = null, bioState = 'idle', bioGen = 0, bioCtl = null, bioSourced = false, typedByHand = false, bioStale = false, padLocked = false;
  var bioSupport = null, bioOfferBusy = false, bioEnabling = false, bioAutoTried = false, bioTapCb = null, bioUid = null;
  function bioLite() {
    try { return !!(window.PublicKeyCredential && window.crypto && window.crypto.subtle && navigator.credentials && window.TextEncoder && !L.isInAppBrowser(navigator.userAgent)); } catch (e) { return false; }
  }
  /** a phone shared by several staff links: biometrics are off there */
  function bioShared() { return !T || L.otherTokenData(store.keys(), T.t, function (k) { return store.get(k); }); }
  function bioAllowed() { return bioLite() && !bioShared(); }
  function bioRand(n) { var a = new Uint8Array(n); window.crypto.getRandomValues(a); return a; }
  function bioExt(cred) { try { return cred.getClientExtensionResults() || {}; } catch (e) { return {}; } }
  function bioFirst(ext) { var r = ext && ext.prf && ext.prf.results && ext.prf.results.first; return r || null; }
  /** the 32-byte PRF secret -> an AES-GCM 256 key (HKDF, SHA-256, info 'sc5-bio-pin') */
  function bioKey(prf) {
    var sub = window.crypto.subtle;
    return sub.importKey('raw', prf, 'HKDF', false, ['deriveKey']).then(function (base) {
      return sub.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new window.TextEncoder().encode('sc5-bio-pin') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    });
  }
  /** one scan: resolves to the PRF secret (ArrayBuffer) or null when the phone gave none. The call itself happens synchronously (iOS wants it inside the tap). */
  function bioGetPrf(idBytes, saltBytes, signal) {
    var o = { publicKey: { challenge: bioRand(32), allowCredentials: [{ type: 'public-key', id: idBytes, transports: ['internal'] }], userVerification: 'required', rpId: location.hostname, timeout: 60000, extensions: { prf: { eval: { first: saltBytes } } } } };
    if (signal) o.signal = signal;
    return navigator.credentials.get(o).then(function (a) { return bioFirst(bioExt(a)); });
  }
  function bioDelete() { store.del(KBIO); bioRec = null; }
  /** Called with every server answer: a PIN refused that came from a scan, or "no code is set" -> the saved scan is stale and is deleted (a LOCK keeps it). */
  function bioWatch(res, srcBio) {
    if (!bioRec || !res || res === NET || typeof res !== 'object' || res.ok === true) return;
    if (res.code === 'SETPIN' || (res.code === 'PIN' && srcBio)) { bioDelete(); bioStale = true; }
  }
  function bioCancel() {
    bioGen++;
    if (bioCtl) { try { bioCtl.abort(); } catch (e) { /* fine */ } bioCtl = null; }
    bioState = 'idle';
  }
  /** what the pad shows: the PIN keys, or the scan wait / tap button, plus the "scan again" button when a scan is saved (never while the pad is locked) */
  function bioDraw() {
    var sc = bioState === 'scan', tp = bioState === 'tap', lab = L.bioLabel(navigator.userAgent);
    var again = bioState === 'idle' && !!bioRec && !setMode && !padLocked && bioAllowed();
    $('dots').hidden = sc || tp; $('keys').hidden = sc || tp;
    $('bioBusy').hidden = !sc; $('bioTap').hidden = !tp; $('bioAgain').hidden = !again; $('bioPinLink').hidden = !(sc || tp);
    $('bioBox').hidden = !(sc || tp || again);
    if (sc) { $('padSub').textContent = 'สแกน ' + lab + ' เพื่อเข้า'; $('bioBusyTxt').textContent = 'กำลังสแกน ' + lab + '…'; }
    else if (tp) $('padSub').textContent = 'แตะปุ่มแล้วสแกน ' + lab;
    else drawSetMode();
  }
  /** Opens the app with a saved scan: once per page load, only on the ordinary pad (never while choosing a code or locked, never on a shared phone). */
  function bioAuto() {
    if (bioAutoTried || !bioRec || !bioAllowed() || setMode || padLocked) return;
    bioAutoTried = true; bioScan(true);
  }
  function bioScan(auto, retried) {
    if (!bioRec || !bioAllowed() || setMode || verified || padLocked) return;
    var rec = bioRec, idb = L.b64uDec(rec.id), saltb = L.b64uDec(rec.salt), ivb = L.b64uDec(rec.iv), ctb = L.b64uDec(rec.ct), t0 = Date.now(), step = 'scan', ctl = null;
    bioCancel(); var gen = bioGen;
    try { if (typeof AbortController !== 'undefined') ctl = new AbortController(); } catch (e) { ctl = null; }
    bioCtl = ctl; bioState = 'scan'; $('padMsg').textContent = ''; bioDraw();
    var chain;
    try {
      chain = bioGetPrf(idb, saltb, ctl ? ctl.signal : null).then(function (prf) {
        if (!prf) throw { missing: true };   // the phone gave no secret this time: not a reason to delete anything
        step = 'open';
        return bioKey(prf).then(function (k) { return window.crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivb }, k, ctb); });
      }).then(function (buf) {
        var pin = new window.TextDecoder().decode(buf);
        if (!/^[0-9]{4}$/.test(pin)) throw { unusable: true };
        return pin;
      });
    } catch (e) { chain = Promise.reject(e); }
    chain.then(function (pin) {
      if (gen !== bioGen) return;
      bioCtl = null; bioState = 'idle';
      if (verified || $('pad').hidden || setMode || padLocked) { bioDraw(); return; }   // (a link with no PIN got in meanwhile)
      bioDraw(); feedPin(pin, true);
    }, function (err) {
      if (gen !== bioGen) return;
      bioCtl = null;
      var name = err && err.name;
      if (step === 'open' || (err && err.unusable)) {   // the saved code cannot be decrypted (scan data reset on the phone): useless, delete it
        bioDelete(); bioState = 'idle'; $('padMsg').textContent = 'ใช้การสแกนไม่ได้ ใส่รหัส PIN'; bioDraw(); return;
      }
      if (!retried && !auto && (name === 'InvalidStateError' || /pending/i.test(String(err && err.message)))) {   // the aborted earlier prompt is still closing: once more shortly
        setTimeout(function () { if (gen === bioGen) { bioState = 'idle'; bioScan(auto, true); } }, 300); return;
      }
      if (auto && name === 'NotAllowedError' && Date.now() - t0 < 800) { bioState = 'tap'; bioDraw(); return; }   // iOS refuses a scan without a tap: ask for one
      bioState = 'idle'; $('padMsg').textContent = 'สแกนไม่สำเร็จ ใส่รหัส PIN หรือสแกนอีกครั้ง'; bioDraw();
    });
  }
  /** the offer sheet: mode 'ask' (the question) or 'confirm' (iOS: the phone gave no secret on create, one more tap runs the scan) */
  function bioOfferShow(mode) {
    var lab = L.bioLabel(navigator.userAgent), c = mode === 'confirm';
    $('bioOfferTitle').textContent = c ? 'ยืนยันด้วย ' + lab + ' อีกครั้ง' : (lab === 'Face ID' ? 'ใช้ Face ID ครั้งหน้าไหม?' : 'ใช้ลายนิ้วมือ ครั้งหน้าไหม?');
    $('bioOfferSub').textContent = c ? 'แตะปุ่มด้านล่างแล้วสแกนอีกครั้งเพื่อเปิดใช้' : 'ครั้งหน้าไม่ต้องพิมพ์รหัส PIN แค่สแกนก็เข้าได้ ใช้รหัส PIN แทนได้ทุกเมื่อ';
    $('bioOfferYes').hidden = c; $('bioOfferConfirm').hidden = !c;
    $('bioOffer').hidden = false;
  }
  /** hide the sheet; an enable that was waiting for the confirm tap is given up */
  function bioOfferClose() {
    var cb = bioTapCb; bioTapCb = null;
    try { $('bioOffer').hidden = true; } catch (e) { /* fine */ }
    if (cb) cb.cancel();
  }
  function bioInit() {
    var raw = store.get(KBIO); bioRec = L.bioParse(raw);
    if (raw && !bioRec) store.del(KBIO);   // a damaged record is just dropped
    $('bioTap').addEventListener('click', function () { bioScan(false); });
    $('bioAgain').addEventListener('click', function () { if (padBusy) return; bioScan(false); });
    $('bioPinLink').addEventListener('click', function () { bioCancel(); $('padMsg').textContent = ''; bioDraw(); });
    $('bioToggle').addEventListener('click', function () {
      if (bioRec) { bioDelete(); store.set(KBION, '1'); toast('ปิดการสแกนแล้ว'); bioDrawFoot(); return; }
      bioEnable(function (ok) { if (ok) toast('เปิดใช้ ' + L.bioLabel(navigator.userAgent) + ' แล้ว'); bioDrawFoot(); });
    });
    $('bioOfferYes').addEventListener('click', function () {
      $('bioOffer').hidden = true;
      bioEnable(function (ok) { if (ok) toast('เปิดใช้ ' + L.bioLabel(navigator.userAgent) + ' แล้ว'); bioDrawFoot(); });
    });
    $('bioOfferConfirm').addEventListener('click', function () { var cb = bioTapCb; bioTapCb = null; $('bioOffer').hidden = true; if (cb) cb.go(); });   // the scan starts right here, inside the tap
    $('bioOfferNo').addEventListener('click', function () { store.set(KBION, '1'); bioOfferClose(); bioDrawFoot(); });
    if (!bioLite()) { bioSupport = false; return; }
    try {   // the stable passkey user id: first 16 bytes of SHA-256(token), ready before the tap (iOS wants create() inside the tap)
      window.crypto.subtle.digest('SHA-256', new window.TextEncoder().encode(T.t)).then(function (d) { bioUid = new Uint8Array(d).slice(0, 16); }, function () { /* fine */ });
    } catch (e) { /* fine */ }
    try {
      var P = window.PublicKeyCredential;
      P.isUserVerifyingPlatformAuthenticatorAvailable().then(function (v) {
        if (v !== true) return false;
        if (typeof P.getClientCapabilities === 'function') return P.getClientCapabilities().then(function (c) { return !(c && c['extension:prf'] === false); }, function () { return true; });
        return true;
      }).then(function (ok) { bioSupport = ok === true; bioDrawFoot(); bioMaybeOffer(); }, function () { bioSupport = false; });
    } catch (e) { bioSupport = false; }
  }
  /** Make the credential and save the encrypted PIN. Needs a PIN the server has accepted in this page (right after a login). done(ok). Must be called straight from a tap. */
  function bioEnable(done) {
    done = done || function () {};
    if (bioEnabling) return;
    if (!bioAllowed() || bioSupport === false || !verified || offline || PIN === null || PIN === undefined || !/^[0-9]{4}$/.test(String(PIN))) { done(false); return; }
    bioEnabling = true;
    var pinNow = String(PIN), salt = bioRand(32), id = null, enc = new window.TextEncoder(), nm = who() || 'staff';
    function doCreate(uid) {
      var p;
      try {
        p = navigator.credentials.create({ publicKey: {
          rp: { id: location.hostname, name: 'นับสต็อก' }, user: { id: uid, name: nm, displayName: nm }, challenge: bioRand(32),   // a stable user id: enabling again replaces the old passkey
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
          timeout: 60000, extensions: { prf: { eval: { first: salt } } } } });
      } catch (e) { p = Promise.reject(e); }
      p.then(function (cred) {
        id = new Uint8Array(cred.rawId);
        var ext = bioExt(cred);
        if (!(ext.prf && ext.prf.enabled === true)) throw { noprf: true };
        var f = bioFirst(ext);
        if (f) return f;
        // no secret on create (iOS): a get() here would be outside the tap, so ask for one more tap and run it from there
        return new Promise(function (resolve, reject) {
          bioTapCb = { go: function () { bioGetPrf(id, salt, null).then(resolve, reject); }, cancel: function () { reject({ cancelled: true }); } };
          bioOfferShow('confirm');
        });
      }).then(function (prf) {
        if (!prf) throw { noprf: true };
        return bioKey(prf);
      }).then(function (key) {
        var iv = bioRand(12);
        return window.crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, enc.encode(pinNow)).then(function (ct) {
          return { v: 1, id: L.b64uEnc(id), salt: L.b64uEnc(salt), iv: L.b64uEnc(iv), ct: L.b64uEnc(new Uint8Array(ct)) };
        });
      }).then(function (rec) {
        if (!store.set(KBIO, JSON.stringify(rec))) throw { nostore: true };
        bioRec = L.bioParse(JSON.stringify(rec)); store.del(KBION); bioEnabling = false; done(true);
      }, function (err) {
        bioEnabling = false; bioTapCb = null; try { $('bioOffer').hidden = true; } catch (e) { /* fine */ } store.set(KBION, '1');   // do not ask again; the menu button can still turn it on
        toast(err && err.noprf ? 'เครื่องนี้ใช้สแกนไม่ได้ ใช้รหัส PIN ต่อ' : 'ยังไม่ได้เปิดการสแกน ใช้รหัส PIN ต่อ', 3500);
        done(false);
      });
    }
    if (bioUid) doCreate(bioUid);
    else { try { window.crypto.subtle.digest('SHA-256', enc.encode(T.t)).then(function (d) { doCreate(new Uint8Array(d).slice(0, 16)); }, function () { doCreate(bioRand(16)); }); } catch (e) { doCreate(bioRand(16)); } }
  }
  /** After a typed PIN was accepted: offer the scan once (never over a card / the scan sheet; a busy moment is retried at the next refresh). */
  function bioMaybeOffer() {
    if (!typedByHand || bioSourced || bioOfferBusy || !verified || offline || PIN === null || PIN === undefined || !T) return;
    if (bioRec || store.get(KBION) === '1' || bioSupport === false) { typedByHand = false; return; }
    if (noStore || !bioAllowed() || bioSupport !== true) return;   // (support null: the availability check is still running and calls this again)
    if (card || settingsOpen || !$('card').hidden || !$('scan').hidden || !$('pad').hidden || !$('bioOffer').hidden) return;
    typedByHand = false;
    bioOfferShow('ask');
  }
  /** the Face ID / fingerprint switch on the Settings page (row hidden where it cannot work): turn the scan off / on again */
  function bioDrawFoot() {
    var f = $('bioFoot'); if (!f) return;
    var show = verified && PIN !== null && PIN !== undefined && !offline && bioAllowed() && (!!bioRec || bioSupport === true);
    f.hidden = !show;
    if (show) { $('bioLbl').textContent = 'เปิดแอปด้วย ' + L.bioLabel(navigator.userAgent); $('bioToggle').setAttribute('aria-checked', bioRec ? 'true' : 'false'); }
  }

  /* ---------------- boot / sync ---------------- */
  function showCachedUnverified() {
    try { acceptBoot(cachedBoot, true); } catch (e) { /* a damaged cache is just ignored */ M = null; D = null; }
  }
  function onBoot(res, fromPad) {
    var c = L.classify(res);
    if (c === 'ok') { PIN = PIN === null || PIN === undefined ? null : PIN; acceptBoot(res, false); if (switching()) reboot(); return; }   // (a place switch that the pad interrupted goes on)
    if (c === 'pin') {
      var locked = res.code === 'LOCK';
      if (res.code === 'SETPIN') { pendingPin = null; showPad('', false, true); return; }   // choose a code first (nothing was typed wrong)
      if (!fromPad && !locked && !pendingPin) { return; }   // the probe: stay on the pad, nothing to say
      showPad(res.error || (fromPad ? 'รหัสไม่ถูกต้อง' : ''), locked); return;
    }
    // network / server trouble (NET, BUSY, FAULT): the PIN was never checked, so NOTHING becomes "verified" here.
    // With a kept list the person can look at it (read-only: no card, no save, no queue send) until the server has accepted a PIN in this page load.
    if (fromPad && cachedBoot && c === 'retry') { goOffline(res && res.error || NET.error); return; }
    if (fromPad && cachedBoot) { showPad(res && res.error || NET.error, false); return; }   // a refusal (BAD etc.) is not "no signal": back to the pad with the reason, no offline polling
    if (fromPad) { $('padMsg').textContent = res.error || NET.error; PIN = null; padBuf = ''; drawDots(); padBusy = false; return; }
  }
  function goOffline(why) {
    verified = false; offline = true; bioDrawFoot();
    try { acceptBoot(cachedBoot, true); } catch (e) { M = null; D = null; }
    $('pad').hidden = true; $('app').hidden = false; render(); drawInstall();
    clearTimeout(offTimer); offTimer = setTimeout(retryOnline, 15000);
  }
  function retryOnline() {
    clearTimeout(offTimer);
    if (!offline || PIN === null) return;
    api('boot', {}, function (res) { var c = L.classify(res); if (c === 'ok') acceptBoot(res, false); else if (c === 'pin') showPad(res.error, res.code === 'LOCK', res.code === 'SETPIN'); else if (c === 'retry') offTimer = setTimeout(retryOnline, 15000); else showPad(res && res.error || NET.error, false); });   // (a refusal does not poll forever)
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
  /** true while the person has picked another place but the list on screen is still the old place's (the fresh one is on its way) */
  function switching() { return !!(M && pickLoc && M.loc && M.loc !== pickLoc); }
  var rebootFails = 0;   // failed boots of the pending place switch (0 = none yet)
  function switchMsg() { return rebootFails > 0 && M ? 'ไม่มีสัญญาณ — เลือก ' + M.loc + ' กลับเพื่อนับต่อ' : 'กำลังโหลดรายการของ ' + pickLoc + '…'; }
  function switchBlocked() { if (!switching()) return false; toast(switchMsg()); return true; }
  function subText() { var src = M || D || {}; return L.headerSub(today(), !!M, src.loc) + (switching() ? ' · ' + switchMsg() : ''); }
  function acceptBoot(res, unverified, noDraw) {
    if (reloadWhenEmpty) return;   // another link was opened and the old person's saves are being sent: nothing may open the app (or the pad) under the old link meanwhile
    if (res.mode !== 'daily' && pickLoc && res.loc && res.loc !== pickLoc && res._asked !== undefined && res._asked !== pickLoc) return;   // a late reply to a request sent before the switch: dropped (the list of the picked place is on its way)
    if (res.mode !== 'daily' && pickLoc && res.loc && res.loc !== pickLoc && (res.locs || []).indexOf(pickLoc) >= 0) return;   // a late reply for a place the person has since left: dropped
    if (res.mode !== 'daily' && pickLoc && res.loc && res.loc !== pickLoc && res._asked === pickLoc) { pickLoc = res.loc; try { $('locPick').value = res.loc; } catch (e) { /* ignore */ } }   // the server did not take the pick (not one of this person's places): follow the list it sent, never stay blocked
    if (res.mode === 'daily') { M = null; D = res; geoMap = {}; } else { D = null; M = L.makeModel(res); }
    if (res.mode !== 'daily') { geoMap = res.geo && typeof res.geo === 'object' ? res.geo : {}; if (!unverified && res.loc) locCache[res.loc] = { at: Date.now(), res: JSON.stringify(res) }; }
    undoMap = {};
    Q.forEach(function (e) { overlay(e); });
    if (lostList.length) {   // entries whose photo could not be kept: the card comes back asking for a new photo
      lostList.forEach(function (e) { prefill[e.body.id] = { answer: e.body.answer, foundAt: e.body.foundAt, err: 'ต้องถ่ายรูปใหม่' }; notes.push({ id: e.rid, kind: 'err', text: 'ต้องถ่ายรูปใหม่: ' + e.label + ' (รูปที่ถ่ายไว้หายไป กรอกและถ่ายรูปใหม่แล้วส่งอีกครั้ง)' }); });
      lostList = [];
    }
    if (!unverified) {
      verified = true; paused = false; offline = false; clearTimeout(offTimer); loadedAt = Date.now();
      store.set(KX, T.x);   // from now on a link to ANOTHER deployment gets the red warning
      store.set(KLINK, JSON.stringify({ x: T.x, t: T.t }));   // the home-screen copy of the link: only a link the server accepted
      try { L.staleTokenKeys(store.keys(), T.t, function (k) { return store.get(k); }).forEach(function (k) { store.del(k); }); } catch (e) { /* leftovers stay: harmless */ }   // old links' list caches / declined marks / drafts (their queues are empty) must not switch biometrics off
      var s = JSON.stringify(res); cachedBoot = res;
      if (!store.set(KL, s)) noStore = true;
    }
    $('pad').hidden = true; $('app').hidden = false;
    if (noDraw) { $('who').textContent = 'สวัสดี ' + who(); renderBadge(); renderNotes(); redrawLater = true; } else render(); drawInstall();
    if (card && !card.unknown && card.mode === 'scan' && !card.camMsg && !card.locked && !$('card').hidden) drawCard();   // the PIN pad stopped the piece camera: bring it back with the card
    if (!unverified && !udTried) { udTried = true; udRestore(); }
    if (!unverified) { bioCancel(); bioStale = false; bioDrawFoot(); bioMaybeOffer(); }
    if (!unverified) { schedSync(); pump(); if (!geoStarted) { geoStarted = true; geoCheck(); } else geoFlush(); }
  }
  var redrawLater = false;

  /* ---------------- v9: GPS picks the place for a roaming counter ---------------- */
  var geoLock = null, geoMap = {}, geoPlace = '', geoStarted = false, geoBusy = false, geoWait = false, geoHinted = false;
  function geoIdle() {
    if (!(verified && M && !D && !card && !settingsOpen && $('pad').hidden && $('scan').hidden && !$('app').hidden)) return false;
    try {
      var a = document.activeElement; if (a && a.tagName && /^(INPUT|TEXTAREA|SELECT)$/i.test(a.tagName)) return false;
      if ($('codeIn').value.trim() || $('codeSug').childNodes.length) return false;
    } catch (e) { /* ignore */ }
    return !editingDaily();
  }
  function geoChoices() { var src = M || D; return src ? L.locChoices(src.locs, src.loc) : []; }
  /** Ask the phone where it is (at start and when the page comes back); only for a roaming person with a place list and known coordinates. Never nags. */
  function geoCheck() {
    try {
      if (!verified || geoBusy || !navigator.geolocation || !geoChoices().length || !Object.keys(geoMap).length) return;
      geoBusy = true;
      navigator.geolocation.getCurrentPosition(function (pos) {
        geoBusy = false;
        try { geoOnFix({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy }); } catch (e) { /* ignore */ }
      }, function (err) {
        geoBusy = false;
        if (err && err.code === 1 && !geoHinted) { geoHinted = true; notes.push({ id: 'geo', kind: 'info', text: 'เปิดสิทธิ์ตำแหน่ง (GPS) ให้แอปนี้ เพื่อให้เปลี่ยนสถานที่ให้อัตโนมัติ ตอนนี้เลือกสถานที่เองได้ตามเดิม' }); renderNotes(); }
      }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
    } catch (e) { geoBusy = false; }
  }
  function geoOnFix(fix) {
    var src = M || D; if (!src) return;
    if (geoLock) {   // the person chose a place by hand: GPS waits until the phone has really moved away from where that happened
      if (!geoLock.at) geoLock.at = { lat: fix.lat, lng: fix.lng };
      if (L.geoHeld(geoLock.at, fix)) return;
      geoLock = null;
    }
    var d = L.geoDecide(geoPlace, src.loc, L.nearestLoc(fix, geoMap, geoChoices()));
    if (d.switchTo && !geoIdle()) { geoWait = true; return; }   // a card or the PIN pad is open: nothing changes now; asked again when it closes
    geoPlace = d.place;
    if (d.switchTo) switchLoc(d.switchTo, true);
  }
  /** Called when a card / the scan sheet / the pad has closed: a switch that had to wait is decided again with a fresh reading. */
  function geoFlush() { if (geoWait && geoIdle()) { geoWait = false; geoCheck(); } }
  /** The same as choosing the place in the dropdown (auto = GPS did it: say so). */
  function switchLoc(name, auto) {
    pickLoc = name; rebootFails = 0; ST.tab = 'first'; ST.shelf = '';
    if (!auto) { geoLock = { at: null }; geoCheck(); }   // (a fresh reading marks where the hand pick happened)
    if (card) backHome();
    try { $('locPick').value = name; } catch (e) { /* ignore */ }
    var hit = locCache[name];
    if (hit && verified && Date.now() - hit.at < 600000) { try { acceptBoot(JSON.parse(hit.res), true); } catch (e) { /* the fresh list follows anyway */ } }   // (remembered list: shown at once; the fresh one replaces it in a moment)
    $('sub').textContent = subText();
    reboot();
    if (auto) toast('ตอนนี้อยู่ที่ ' + name + ' — เปลี่ยนให้แล้ว', 4000);
  }
  /** true while a daily card holds typed text / a photo that is not sent yet, or one of its boxes has the cursor */
  function editingDaily() {
    var items = (D && D.items) || [], i, d;
    for (i = 0; i < items.length; i++) { d = !items[i].done && draft[items[i].id]; if (d && (d.crates || d.per || d.loose || d.foundAt || d.photo)) return true; }
    try { var a = document.activeElement; if (a && a.tagName && /^(INPUT|TEXTAREA)$/i.test(a.tagName) && $('dList').contains && $('dList').contains(a)) return true; } catch (e) { /* ignore */ }
    return false;
  }
  function overlay(e) {   // a queued (not yet confirmed) save shows as done
    if (e.kind === 'fc' && M && (!e.body.loc || !M.loc || e.body.loc === M.loc)) { var u = L.applySave(M, e.body, M.counter, M.dateText); if (u) undoMap[e.rid] = u; }
    if (e.kind === 'daily' && D && D.items) D.items.forEach(function (it) { if (it.id === e.body.id && !it.done) { it.done = true; D.done = (D.done || 0) + 1; undoMap[e.rid] = { daily: it }; } });
  }
  var rebootTimer = null, rebootGen = 0;
  /** boot again (after a switch / mode change); a failed try (no signal, busy) is repeated with a growing wait while a place switch is pending */
  var ackSeq = 0, syncDrops = 0;   // ackSeq grows with every confirmed save: a list built before that may not contain it (doSync / reboot drop such a reply and ask again)
  function reboot(n, drops) {
    if (reloadWhenEmpty) return;
    n = n || 0; drops = drops || 0; clearTimeout(rebootTimer); var gen = ++rebootGen, ack = ackSeq;
    api('boot', {}, function (res) {
      if (gen !== rebootGen) return;
      var c = L.classify(res);
      if (c === 'ok' && ack !== ackSeq && drops < 3) { rebootTimer = setTimeout(function () { reboot(n, drops + 1); }, 1500); return; }   // a save was confirmed meanwhile: ask again (at most 3 times)
      if (c === 'ok') { rebootFails = 0; acceptBoot(res, false); }
      else if (c === 'pin') showPad(res.error, res.code === 'LOCK', res.code === 'SETPIN');
      else if (c === 'retry') { if (switching()) { rebootFails = n + 1; try { $('sub').textContent = subText(); } catch (e) { /* ignore */ } } if (switching()) rebootTimer = setTimeout(function () { reboot(n + 1); }, Math.min(30000, 2000 * Math.pow(2, n))); }
      else if (switching()) { pickLoc = M.loc; try { $('locPick').value = M.loc; } catch (e) { /* ignore */ } $('sub').textContent = subText(); }   // refused: stay on the list we have, unblocked
    });
  }

  function schedSync() {
    clearTimeout(syncTimer);
    var waiting = (M && M.state !== 'open') || (D && D.state !== 'open');
    syncTimer = setTimeout(function () { doSync(); }, waiting ? WAIT_POLL_MS : SYNC_MS);
  }
  /** the refresh button: pressed state is CSS (:active); while a manual refresh runs the icon spins (class .spin) and further taps are ignored */
  var refreshBusy = false, refreshTimer = null;
  function refreshSpin(on) {
    refreshBusy = !!on; clearTimeout(refreshTimer);
    var b = $('refresh'); if (b) { b.classList.toggle('spin', !!on); b.setAttribute('aria-busy', on ? 'true' : 'false'); }
    if (on) refreshTimer = setTimeout(function () { refreshSpin(false); }, 30000);   // never spin forever
  }
  function doSync(manual, quiet) {
    if (reloadWhenEmpty) { if (manual) refreshSpin(false); return; }   // (see acceptBoot: waiting to reload for another link)
    if (!verified || document.hidden || card || inflight || L.syncHeld(Q, manual)) { if (manual) { refreshSpin(false); if (!quiet) toast('กำลังส่งข้อมูล รอสักครู่'); } schedSync(); return; }   // (a waiting picture does not hold the list back)
    var gen = padGen, ack = ackSeq;
    api('sync', { v: M ? M.v : '' }, function (res) {
      if (manual) refreshSpin(false);
      if (gen !== padGen || !$('pad').hidden) { schedSync(); return; }   // the pad came up while this was out (PIN cleared / lock): a late reply must not open the app again
      var c = L.classify(res);
      if (c === 'ok' && !res.same && ack !== ackSeq && syncDrops < 3) {   // a save was confirmed while this reply was on its way: the list in it may not have that save yet - drop it, ask again soon (never more than 3 times in a row)
        syncDrops++; clearTimeout(syncTimer); syncTimer = setTimeout(function () { doSync(manual, true); }, 1500); return;
      }
      if (c === 'ok') syncDrops = 0;
      if (c === 'ok') {
        if (res.same) { loadedAt = Date.now(); if (manual && !quiet) toast('อัปเดตแล้ว'); }
        else if (!card) { if (D && editingDaily()) { acceptBoot(res, false, true); } else acceptBoot(res, false); if (manual && !quiet) toast('อัปเดตแล้ว'); }   // a half-typed daily card: take the data, draw it later
      }
      else if (c === 'pin') { showPad(res.error, res.code === 'LOCK', res.code === 'SETPIN'); return; }
      else if (manual && !quiet) toast(res.error || NET.error);
      schedSync();
    });
  }

  /* ---------------- queue ---------------- */
  /** Two windows of the same link (the installed app + a Chrome tab, two tabs from LINE) share one localStorage key for the queue. Entries another window queued are taken over here
      (never the ones this window already sent or dropped, never a photo that lost its picture); a taken-over entry goes in by its birth time so per-part order (qDue) holds. */
  function dropQ(rid) { gone[rid] = 1; delete adopted[rid]; L.qDrop(Q, rid); }
  function mergeStored() {
    if (!KQ) return false;
    var raw = ''; try { raw = store.get(KQ); } catch (e) { raw = ''; }
    if (!raw) return false;
    var add = L.qParse(raw, T.t).filter(function (e) { return !e.lostPhoto && !gone[e.rid] && L.qIndex(Q, e.rid) < 0; });
    add.forEach(function (e) {
      adopted[e.rid] = 1;
      var i = Q.length; while (i > 0 && Q[i - 1].born > e.born) i--;
      Q.splice(i, 0, e);
    });
    if (add.length) setTimeout(function () { try { renderBadge(); } catch (e) { /* fine */ } pump(); }, 0);
    return add.length > 0;
  }
  /** another window wrote the queue: take over what is new; what this window took over earlier and the other window has since sent / given back is dropped here too (never the one being sent now) */
  function onQueueStorage(ev) {
    if (!KQ || (ev && ev.key && ev.key !== KQ)) return;
    mergeStored();
    var raw = ''; try { raw = store.get(KQ) || ''; } catch (e) { raw = ''; }
    var live = Object.create(null); L.qParse(raw, T.t).forEach(function (e) { live[e.rid] = 1; });
    Object.keys(live).forEach(function (r) { delete vanished[r]; });
    Q.filter(function (e) { return adopted[e.rid] && !live[e.rid]; }).forEach(function (e) {
      if (inflight && sendingRid === e.rid) { vanished[e.rid] = 1; return; }   // being sent right now: sent() drops it on any reply that is not ok (the other window has sent it already)
      dropQ(e.rid); if (e.kind === 'photo') pstore.del(e.rid);
    });
    renderBadge(); pump();
    if (reloadWhenEmpty && !Q.length) reloadNow();
  }
  function persistQ() {
    if (!KQ) return;
    mergeStored();
    if (!Q.length) { store.del(KQ); return; }
    if (store.set(KQ, L.qSerialize(Q, true))) { noStore = false; return; }
    if (!store.set(KQ, L.qSerialize(Q, false))) noStore = true;
    else noStore = Q.some(function (e) { return e.body && e.body.photo; });   // the pictures were left out of the stored copy: a daily entry still holding one lives only in memory   // photos too big for the phone's storage, or no storage at all: keep the page open
  }
  /** The pictures waiting to be sent: in memory at once, and in IndexedDB (not in the 5 MB localStorage where the queue lives). Without IndexedDB they live in memory only. */
  var pstore = (function () {
    var mem = Object.create(null), memOnly = Object.create(null), db = null, failed = false, waiters = null, OPEN_MS = 3000, GET_MS = 5000;
    /** a late open: pictures saved to memory while it hung are written now (until then they count as memory-only) */
    function flushMem(d) { try { var t = d.transaction('p', 'readwrite'), st = t.objectStore('p'), snap = Object.create(null); Object.keys(mem).forEach(function (k) { snap[k] = mem[k]; st.put(mem[k], k); }); t.oncomplete = function () { Object.keys(snap).forEach(function (k) { if (mem[k] === snap[k]) delete memOnly[k]; }); if (api2.onFlushed) api2.onFlushed(); }; } catch (e) { /* stays memory-only */ } }
    function open(cb) {
      if (db || failed) { cb(db); return; }
      if (waiters) { waiters.push(cb); return; }
      waiters = [cb];
      var timer = null;
      function done(d) { clearTimeout(timer); if (!waiters) { if (d && !db) { db = d; failed = false; flushMem(d); } return; } db = d; failed = !d; var w = waiters; waiters = null; w.forEach(function (f) { f(d); }); }
      try {
        var idb = window.indexedDB; if (!idb) { done(null); return; }
        timer = setTimeout(function () { done(null); }, OPEN_MS);   // iOS sometimes never calls back: give up (memory only) - a late success is still used
        var r = idb.open('sc5photos', 1);
        r.onupgradeneeded = function () { try { r.result.createObjectStore('p'); } catch (e) { /* ignore */ } };
        r.onsuccess = function () { done(r.result); };
        r.onerror = r.onblocked = function () { done(null); };
      } catch (e) { done(null); }
    }
    var api2 = {
      put: function (k, v, cb) {
        mem[k] = v; memOnly[k] = 1;
        open(function (d) {
          if (!d) { cb(); return; }
          var fin = false; function once() { if (!fin) { fin = true; cb(); } }
          try { var t = d.transaction('p', 'readwrite'); t.objectStore('p').put(v, k); t.oncomplete = function () { delete memOnly[k]; once(); }; t.onerror = t.onabort = once; setTimeout(once, GET_MS); } catch (e) { once(); }
        });
      },
      /** cb(data, status): status 'ok' | 'none' (the storage truly has no such picture) | 'err' (could not ask: try again later, the picture may well be there) */
      get: function (k, cb) {
        if (mem[k]) { cb(mem[k], 'ok'); return; }
        var fin = false; function once(v, st) { if (!fin) { fin = true; cb(v, st); } }
        var gt = setTimeout(function () { once(null, 'err'); }, GET_MS);
        function end(v, st) { clearTimeout(gt); once(v, st); }
        if (!window.indexedDB) { end(null, 'none'); return; }
        open(function (d) {
          if (!d) { end(null, 'err'); return; }
          try { var r = d.transaction('p', 'readonly').objectStore('p').get(k); r.onsuccess = function () { end(r.result || null, r.result ? 'ok' : 'none'); }; r.onerror = function () { end(null, 'err'); }; } catch (e) { end(null, 'err'); }
        });
      },
      del: function (k) {
        delete mem[k]; delete memOnly[k];
        open(function (d) { if (!d) return; try { d.transaction('p', 'readwrite').objectStore('p').delete(k); } catch (e) { /* ignore */ } });
      },
      /** forget a broken connection so the next call opens again */
      reset: function () { db = null; failed = false; },
      /** false when a picture lives only in memory (no IndexedDB, or it failed to open); a not-yet-opened db with no memory-only picture is fine (they are in IDB) */
      durable: function () { return !!window.indexedDB && !failed && !Object.keys(memOnly).length; }
    };
    return api2;
  })();
  /** true when a waiting picture exists only in this page's memory: closing or reloading the page would lose it (same care as no storage) */
  pstore.onFlushed = function () { renderNotes(); };
  function memOnlyPhotos() { return Q.some(function (e) { return e.kind === 'photo'; }) && !pstore.durable(); }
  /** The photo goes as its OWN request after the count (a slow or failed photo never holds the count back); it is queued only once the picture is stored. */
  var refusedCounts = Object.create(null), photoErrs = Object.create(null), PHOTO_ERR_MS = 5 * 60 * 1000;   // refused count rids; when each waiting picture's storage first answered 'err' (in a row)
  function enqueuePhoto(code, shelf, qty, loc, data, countRid) {
    var rid = L.makeRid(window.crypto, Math.random), tok = T.t;
    if (countRid && refusedCounts[countRid]) return;   // its count was already refused: no picture to send
    // the picture is in memory the moment put() is called, so the entry is queued and saved at once (a hanging IndexedDB must not lose it); the store is only the backup
    pstore.put(rid, data, function () {
      if (countRid && refusedCounts[countRid]) { dropQ(rid); pstore.del(rid); persistQ(); renderBadge(); }   // its count was refused while the picture was being stored: never sent
    });
    L.qAdd(Q, L.newEntry('photo', rid, L.photoBody(code, shelf, qty, loc, countRid), 'รูป ' + code, Date.now(), tok));
    persistQ(); renderBadge(); renderNotes(); pump();
  }
  function enqueue(kind, body, label) {
    if (!verified) { toast('ยังบันทึกไม่ได้ รอให้ระบบตรวจรหัสก่อน'); return null; }   // never queue (or send) before the server has accepted a PIN in this page load
    var e = L.newEntry(kind, L.makeRid(window.crypto, Math.random), body, label, Date.now(), T.t);
    if (kind === 'fc') delete locCache[body.loc || (M || {}).loc];
    L.qAdd(Q, e); persistQ(); overlay(e); renderBadge(); pump();
    return e;
  }
  function pump() {
    clearTimeout(pumpTimer);
    if (inflight || !Q.length || !verified || paused) return;
    var now = Date.now(), e = L.qDue(Q, now);
    if (!e) { pumpTimer = setTimeout(pump, Math.max(300, L.qNextAt(Q) - now)); return; }
    if (e.tok && e.tok !== T.t) { dropQ(e.rid); if (e.kind === 'photo') pstore.del(e.rid); persistQ(); renderBadge(); pump(); return; }
    if (e.kind === 'photo') {
      inflight = true; sendingRid = e.rid;
      pstore.get(e.rid, function (data, st) {
        if (!data) {
          inflight = false;
          var ad = !!adopted[e.rid];   // taken over from another window: its picture may live only in THAT window's memory ('none' here) - the owner sends it and its storage write drops it here (onQueueStorage)
          if ((st === 'err' || (ad && st === 'none')) && (photoErrs[e.rid] = photoErrs[e.rid] || Date.now(), Date.now() - photoErrs[e.rid] < PHOTO_ERR_MS)) {   // the storage could not be asked (or hung): the picture may well be there - try again later, counts go on meanwhile
            pstore.reset(); L.qRetry(Q, e.rid, Date.now()); persistQ(); renderBadge(); pump(); return;
          }
          delete photoErrs[e.rid];
          if (ad) { dropQ(e.rid); renderBadge(); pump(); return; }   // gave up on another window's picture: no note, nothing deleted (it is not ours), its owner still has it
          pstore.del(e.rid);   // no orphan picture stays in IDB
          // the storage truly has no such picture (browser cleared it, or it kept failing for 5 minutes): the count was saved on its own, only the photo is missing
          dropQ(e.rid); persistQ();
          notes.push({ id: e.rid, kind: 'err', text: 'รูปของ ' + e.body.code + ' หายไป (จำนวนบันทึกแล้ว) กรุณาแจ้งเจ้าของร้านหรือถ่ายรูปส่งให้' });
          renderBadge(); pump(); return;
        }
        delete photoErrs[e.rid];
        if (!verified || paused) { inflight = false; return; }   // a PIN pad opened while the picture was being read: nothing is sent now (it goes on after the PIN)
        api('photoSave', { rid: e.rid, code: e.body.code, shelf: e.body.shelf, qty: e.body.qty, loc: e.body.loc || '', photo: data }, function (res) { inflight = false; sent(e, res); }, 60000, e.tok);
      });
      return;
    }   // never send under another link's token
    inflight = true; sendingRid = e.rid;
    var extra = e.kind === 'fc' ? { rid: e.rid, entry: e.body } : (function () { var x = { rid: e.rid }; Object.keys(e.body).forEach(function (k) { x[k] = e.body[k]; }); return x; })();
    api(e.kind === 'fc' ? 'save' : 'dailySave', extra, function (res) { inflight = false; sent(e, res); }, 45000, e.tok);
  }
  /** another link was opened while saves were waiting and they are all sent now: start over with it (once) */
  var reloadedOnce = false, reloadPoll = null;
  function reloadNow() { if (reloadedOnce) return; reloadedOnce = true; clearTimeout(reloadPoll); reloading = true; location.reload(); }
  var waitFrom = 0;
  /** the old link stays open (its unsent saves are in memory only): put its #hash back (replaceState fires no hashchange) and say why */
  function keepOldLink() {
    try { history.replaceState(null, '', location.href.split('#')[0] + '#x=' + T.x + '&t=' + T.t); } catch (e) { /* fine */ }
    toast('ส่งงานของลิงก์เดิมก่อน', 4000);
    try { if (!$('pad').hidden) $('padMsg').textContent = OLD_LINK_MSG; } catch (e) { /* the toast said it */ }   // a lasting line on the pad, not only the toast
  }
  var OLD_LINK_MSG = 'ลิงก์เดิมยังมีงานรอส่ง ให้เจ้าของลิงก์เดิมใส่รหัส';
  /** the wait for another link's open: ends when the queue is empty; with a DURABLE queue (it is safe in sc5.q.<token>) also after 10 s, at once without signal, or when the sends keep failing - only a memory-only queue is waited for as long as it takes */
  function reloadWatch() {
    clearTimeout(reloadPoll);
    if (!Q.length) { reloadNow(); return; }
    if (!noStore && !memOnlyPhotos() && (Date.now() - waitFrom >= 10000 || navigator.onLine === false || L.qFailing(Q))) { reloadNow(); return; }
    reloadPoll = setTimeout(reloadWatch, 1000);
  }
  function sent(e, res) {
    var c = L.classify(res);
    if (c !== 'ok' && vanished[e.rid]) {   // an entry taken over from another window that the other window has already sent: a refusal / retry / PIN answer here changes nothing (no note, no write)
      delete vanished[e.rid]; dropQ(e.rid); renderBadge(); pump();
      if (reloadWhenEmpty && !Q.length) reloadNow();
      return;
    }
    if (c === 'ok') {
      if (e.kind !== 'photo') ackSeq++;   // a list built before this moment may not contain this save (doSync / reboot look at it)
      dropQ(e.rid); persistQ(); delete undoMap[e.rid];
      if (e.kind === 'photo') pstore.del(e.rid);
      if (e.kind === 'fc') delete locCache[e.body.loc || (M || {}).loc];   // a save here: that place's remembered list is no longer true
      if (e.kind === 'daily') { delete draft[e.body.id]; if (redrawLater && D && !card && !editingDaily()) { redrawLater = false; renderDaily(); } }
      if (e.kind === 'fc' && M && res.progress && (!e.body.loc || !M.loc || e.body.loc === M.loc) && !Q.some(function (x) { return x.kind === 'fc' && (!x.body.loc || !M.loc || x.body.loc === M.loc); })) { M.progress.done = res.progress.done; M.progress.total = res.progress.total; M.progress.pct = res.progress.pct; M.progress.mine = res.progress.mine; if (!card && !$('app').hidden) renderProg(); }
      if (res.replacedOther) notes.push({ id: e.rid, kind: 'info', text: 'แทนที่การนับของ ' + res.replacedOther + ' วันนี้' });
      if (e.kind === 'fc' && e.body.second) setTimeout(function () { doSync(true, true); }, 400);   // others may have counted too
      renderNotes();
    } else if (c === 'retry') {
      // a picture / count the server keeps failing on (Drive full / blocked / a FAULT every time) is given up after a while; only when THIS reply is itself a fault (a network loss or a busy count never gives back)
      var fault = !!(res && (res.code === 'FAULT' || (e.kind === 'photo' && res.code === 'BUSY')));
      if (fault) { e.firstFail = e.firstFail || Date.now(); e.lastFault = true; } else e.lastFault = false;
      if (fault && Date.now() - e.firstFail >= L.GIVEUP_MS) { dropQ(e.rid); persistQ(); giveBack(e, 'ส่งไม่ได้นานเกินไป'); renderBadge(); pump(); if (reloadWhenEmpty && !Q.length) reloadNow(); return; }
      L.qRetry(Q, e.rid, Date.now()); persistQ();
    } else if (c === 'pin') {
      paused = true; var keptOld = false;
      if (reloadWhenEmpty && (noStore || memOnlyPhotos())) {   // waiting for another link, but the saves live only in memory and the old person's PIN is needed: stop waiting, show the OLD link's pad (the old person types the PIN, the saves go, then the new link can be opened)
        reloadWhenEmpty = false; clearTimeout(reloadPoll); $('waitq').hidden = true; keptOld = true; keepOldLink();
      } else if (reloadWhenEmpty) { reloadNow(); return; }   // waiting for another link: never show the OLD link's pad (the new person's PIN would burn its tries); the queue is safe in storage, so just start over
      if (!(res.code === 'SETPIN' && setMode && !$('pad').hidden)) showPad(keptOld ? OLD_LINK_MSG + (res.error ? ' — ' + res.error : '') : (res.error || ''), res.code === 'LOCK', res.code === 'SETPIN');   // (a pad already in set mode keeps the digits being typed)
      renderBadge(); return;   // the queue stays; after the PIN it goes on
    } else {   // refused (or the mode changed): the item comes back with the reason
      dropQ(e.rid); persistQ(); giveBack(e, res.error || 'บันทึกไม่สำเร็จ');
      if (c === 'mode') reboot();
    }
    renderBadge(); pump();
    if (reloadWhenEmpty && !Q.length) reloadNow();   // another link was opened while saves were waiting: now they are all sent, start over with it
  }
  function giveBack(e, reason) {
    if (e.kind === 'photo') { pstore.del(e.rid); notes.push({ id: e.rid, kind: 'err', text: 'ส่งรูปของ ' + e.body.code + ' ไม่สำเร็จ — ' + reason + ' ' + (e.body.countRid && Q.some(function (x) { return x.rid === e.body.countRid; }) ? '(จำนวนยังรอส่งอยู่)' : '(จำนวนบันทึกแล้ว)') + ' กรุณาแจ้งเจ้าของร้าน' }); renderNotes(); return; }
    var u = undoMap[e.rid]; delete undoMap[e.rid];
    if (e.kind === 'fc') {
      refusedCounts[e.rid] = 1;
      Q.filter(function (x) { return x.kind === 'photo' && x.body && x.body.countRid === e.rid; }).forEach(function (x) { dropQ(x.rid); pstore.del(x.rid); });   // its count was refused: the photo of it is not sent
      persistQ();
      if (u) L.revertSave(M, u);
      notes.push({ id: e.rid, kind: 'err', text: 'ไม่ได้บันทึก ' + e.label + ' — ' + reason + ' (คืนรายการแล้ว นับใหม่ได้)' });
    } else {
      var why = L.dailyRefusal(reason, Date.now() - e.born);
      if (why.needPhoto && draft[e.body.id]) { draft[e.body.id].photo = null; draft[e.body.id].lastModified = 0; }   // a photo refusal (too old, 10-minute rule) reads "รูปเก่าเกิน 10 นาที กรุณาถ่ายรูปใหม่"
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
    drawInstall();   // the iPhone home-screen card shows its "send first" line while the queue is not empty
    if (settingsOpen) drawAbout();
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
    if (Q.length && L.qFailing(Q)) box.appendChild(noteBox('refused', 'triangle-alert', 'ส่งไม่สำเร็จ ระบบจะลองส่งซ้ำเอง กรุณาเปิดหน้านี้ค้างไว้จนกว่าจะส่งครบ' + (noStore || memOnlyPhotos() ? ' (เครื่องนี้เก็บคิวไม่ได้ ถ้าปิดหน้านี้รายการจะหาย)' : '')));
    else if (Q.length && (noStore || memOnlyPhotos())) box.appendChild(noteBox('banner', 'info', 'เครื่องนี้เก็บคิวไว้ไม่ได้ กรุณาเปิดหน้านี้ค้างไว้จนกว่า "กำลังส่ง" จะหมด'));
    notes.forEach(function (n) {
      var x = btn('tbtn', 'ปิด');
      x.addEventListener('click', function () { notes = notes.filter(function (y) { return y !== n; }); renderNotes(); });
      box.appendChild(noteBox(n.kind === 'err' ? 'refused' : 'banner', n.kind === 'err' ? 'triangle-alert' : 'info', n.text, x));
    });
  }

  /* ---------------- rendering: shell ---------------- */
  function render() {
    $('who').textContent = 'สวัสดี ' + who();
    $('sub').textContent = subText();
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
    choices.forEach(function (n) { var o = el('option', '', n); o.value = n; if (n === (switching() ? pickLoc : src.loc)) o.selected = true; sel.appendChild(o); });
  }

  /* ---------------- rendering: full count home ---------------- */
  var sbOpen = false;   // collapsed on every page load (not remembered)
  var sbShone = false;  // the rainbow sweep: at most once per page load, and only on the first open of each Bangkok day on this phone (sc5.sbday)
  function sbShine(box) {
    if (sbShone) return; sbShone = true;
    var now = Date.now(), last = null; try { last = store.get(KSBDAY); } catch (e) { last = null; }
    if (!L.sbShouldShine(last, now)) return;
    store.set(KSBDAY, L.bkkDay(now));   // (storage refused: the flag above still limits it to once per page load)
    box.classList.add('sbshine');
    var stopShine = function () { box.classList.remove('sbshine'); };
    box.addEventListener('animationend', stopShine); setTimeout(stopShine, 4000);
  }
  /** One scoreboard card (full count and daily look the same): a head with the title, the person's own line and a ดูทั้งหมด/ซ่อน tag, and a body that slides open (grid rows 0fr -> 1fr) with every row.
   *  The toggle only flips classes (no rebuild), so the slide plays. fill(x, ct) writes one row's number. */
  function drawBoard(box, t2, rows, meRank, fill) {
    clear(box);
    var h = btn('sbhead'), tx = el('div', 'tx'), tg = el('span', 'tg', sbOpen ? 'ซ่อน' : 'ดูทั้งหมด'), body = el('div', 'sbbody' + (sbOpen ? ' open' : '')), inner = el('div'), list = el('div', 'sbrows'), MEDAL = ['🥇', '🥈', '🥉'];
    body.id = box.id + 'Body';
    tx.appendChild(el('div', 't1', 'ใครนับแล้วบ้าง')); tx.appendChild(el('div', 't2', t2));
    h.appendChild(tx); h.appendChild(tg);
    h.setAttribute('aria-expanded', sbOpen ? 'true' : 'false'); h.setAttribute('aria-controls', body.id);
    h.addEventListener('click', function () {
      sbOpen = !sbOpen; body.classList.toggle('open', sbOpen);
      h.setAttribute('aria-expanded', sbOpen ? 'true' : 'false'); tg.textContent = sbOpen ? 'ซ่อน' : 'ดูทั้งหมด';
    });
    box.appendChild(h);
    rows.forEach(function (x, i) {
      var mine = !!meRank && x.rank === meRank, row = el('div', 'sbrow' + (mine ? ' me' : '')), nm = el('div', 'nm', x.name + (mine ? ' (คุณ)' : '')), ct = el('div', 'ct');
      row.appendChild(el('div', 'rk', i < 3 && (Number(x.items !== undefined ? x.items : x.done) || 0) > 0 ? MEDAL[i] : String(x.rank)));   // a medal only for someone who has counted something
      nm.appendChild(el('span', 'pl', x.placesText));
      fill(x, ct);
      row.appendChild(nm); row.appendChild(ct); list.appendChild(row);
    });
    inner.appendChild(list); body.appendChild(inner); box.appendChild(body);
  }
  /** ใครนับแล้วบ้าง (full count home): collapsed = the person's own rank and item count; opened = the whole list with their own row highlighted. */
  function renderSb() {
    var box = $('sb');
    if (!M || M.state !== 'open' || !M.sb || !M.sb.rows.length) { clear(box); box.hidden = true; return; }
    box.hidden = false; sbShine(box);
    var me = L.boardMe(M.sb);
    drawBoard(box, me ? 'คุณอันดับ ' + me.rank + ' · นับแล้ว ' + fmt(me.items) + ' อย่าง' : 'ยังไม่ได้เริ่มนับ', M.sb.rows, me && me.rank, function (x, ct) { ct.textContent = fmt(x.items); ct.appendChild(el('small', '', ' อย่าง')); });
  }
  /** The same card on the daily page, from the daily boot reply's sb (see L.cleanBoardDaily). Hidden when it is absent / empty or the daily page is closed or blocked. */
  function renderSbD() {
    var box = $('sbD'), b = D && D.state === 'open' ? L.cleanBoardDaily(D.sb) : null;
    if (!b || !b.rows.length) { clear(box); box.hidden = true; return; }
    box.hidden = false; sbShine(box);
    drawBoard(box, b.me ? 'คุณอันดับ ' + b.me.rank + ' · นับแล้ว ' + b.me.done + '/' + b.me.total : 'ยังไม่ได้เริ่มนับ', b.rows, b.me && b.me.rank, function (x, ct) {
      var c = L.dailyCount(x.done, x.total);
      if (c.full) { ct.className = 'ct full'; ct.textContent = '✓ ครบ'; } else { ct.textContent = String(c.done); ct.appendChild(el('small', '', '/' + c.total)); }
    });
  }
  function renderFc() {
    renderProg(); renderSb();
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
    // counted part+shelf rows (by anyone, or this phone's own saves) stay hidden in the plain "not counted yet" view, but show as green rows at the bottom of their shelf as soon as the person searches, picks a shelf or ticks "show counted"
    var f = L.filterItems(M, src, { q: ST.q, shelf: ST.shelf, showDone: ST.showDone || (forced && !second), doneLast: !second, max: 150 });
    var fCount = (forced && !ST.showDone && !second) ? L.filterItems(M, src, { q: ST.q, shelf: ST.shelf, showDone: false, max: 150 }) : f;
    if (!second) {
      $('uncLbl').textContent = ST.showDone ? 'ทุกรายการ' : 'ยังไม่ได้นับ';
      $('uncCnt').textContent = fmt(fCount.rows.length + fCount.hidden);
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
    var part = M.parts[it.p], second = ST.tab === 'second', b = btn('prow lrow' + (it.done ? ' done' : '') + (it.done && !second ? ' counted' : ''));
    var two = el('div', 'two'); two.appendChild(el('div', 'l1', part.name));
    var l2 = el('div', 'l2'); l2.appendChild(el('span', 'pn', part.code2));
    var sh = el('span', 'shelfchip'); sh.appendChild(ic('map-pin')); sh.appendChild(el('span', '', it.shelf)); l2.appendChild(sh);
    two.appendChild(l2);
    if (it.done && !second) two.appendChild(el('div', 'l3 cnt', '✓ นับแล้ว'));   // green row, bold label (no date / name on the row)
    else if (it.done) two.appendChild(el('div', 'l3', 'นับแล้ว ' + it.on + ' · ' + it.by));
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

  /* ---------------- Settings page (the gear next to refresh) ---------------- */
  /* It replaces the home view; the gear again or the Android back button closes it (one history entry, like the card). A card / the scan sheet / the PIN pad closes it. */
  function drawSwitch(id, on) { $(id).setAttribute('aria-checked', on ? 'true' : 'false'); }
  function drawAbout() {
    var src = M || D || {};
    $('aboutWho').textContent = who() + (src.loc ? ' · ' + src.loc : '');
    $('aboutQ').textContent = L.queueText(Q.length);
    $('aboutVer').textContent = 'แอปเวอร์ชัน ' + L.versionText(L.APP_VERSION);
  }
  function drawSettings() {
    var big = fontBig();
    $('fontN').setAttribute('aria-pressed', big ? 'false' : 'true'); $('fontB').setAttribute('aria-pressed', big ? 'true' : 'false');
    $('vibRow').hidden = typeof navigator.vibrate !== 'function';   // iPhone browsers have no vibration
    drawSwitch('vibToggle', vibOn()); drawSwitch('diagToggle', diagOn());
    drawAbout(); bioDrawFoot();
  }
  function openSettings() {
    if (card) { toast('บันทึกหรือกลับก่อน'); return; }
    if (settingsOpen || $('app').hidden || !$('scan').hidden || !$('pad').hidden) return;
    settingsOpen = true; $('home').hidden = true; $('settings').hidden = false; $('gear').setAttribute('aria-pressed', 'true');
    drawSettings(); window.scrollTo(0, 0); syncLayer(); drawInstall();
  }
  function closeSettings() {
    if (!settingsOpen) return;
    settingsOpen = false; $('settings').hidden = true; $('gear').setAttribute('aria-pressed', 'false');
    if (!card) $('home').hidden = false;   // (a card that opened meanwhile keeps the home view hidden)
    syncLayer(); geoFlush(); drawInstall();
  }
  /** "หากล้องใหม่": forget the remembered lens (staged and saved) and the ZXing engine note, so the next scanner open tests every back camera again. */
  function camReset() {
    clearTimeout(camSavedWatch); camSavedLens = false; camPicked = false; camDeviceId = ''; camVirtual = false; camWide = false; camBad = {}; camEngineSession = ''; camZxHits = 0; camThrows = 0;
    camPrefDrop(); store.del('sc5.engine');
  }
  function wireSettings() {
    $('gear').addEventListener('click', function () { if (settingsOpen) closeSettings(); else openSettings(); });
    $('fontN').addEventListener('click', function () { prefSet(KFONT, null); applyFont(); drawSettings(); });
    $('fontB').addEventListener('click', function () { prefSet(KFONT, 'big'); applyFont(); drawSettings(); });
    $('vibToggle').addEventListener('click', function () { prefSet(KVIB, vibOn() ? '0' : null); drawSwitch('vibToggle', vibOn()); });
    $('diagToggle').addEventListener('click', function () { prefSet(KDIAG, diagOn() ? null : '1'); drawSwitch('diagToggle', diagOn()); });
    $('camReset').addEventListener('click', function () { camReset(); toast('เปิดกล้องครั้งหน้า แอปจะหากล้องที่ชัดที่สุดให้', 3500); });
  }

  /* ---------------- part card ---------------- */
  function openCard(c, shelf, viaScan) {
    if (switchBlocked()) return;
    card = c;
    card.shelf = shelf === undefined ? null : shelf; card.other = false;
    if (card.shelf === null && card.shelves.length === 1) card.shelf = card.shelves[0].shelf;
    if (card.ext) { card.otherOpen = needShelf(); if (!needShelf()) { card.shelf = ''; card.other = true; } }   // a part from another location: a branch needs no shelf (the branch itself), the main shop asks for a name
    card.mode = 'type'; card.qty = 0; card.lock = ''; card.warn = ''; card.err = ''; card.camMsg = ''; card.leave = false; card.unknown = false;
    card.loc = L.saveLoc(M, pickLoc);   // the place is fixed when the card opens, not read again at save time
    showCard(); focusQty();
  }
  /** the card opens in type mode: put the cursor in the quantity box (iOS may refuse to open the keyboard - harmless) */
  function focusQty() { try { var q = $('qtyIn'); if (q && card && card.mode === 'type') q.focus(); } catch (e) { /* ignore */ } }
  var KUD = T ? 'sc5.ud.' + T.t : '', udTried = false;
  /** A small draft of the unknown-code card (code, quantity, shelf) in the tab session store (KUD): an Android tab reload while the camera app is open must not lose what was typed (the photo may be lost). */
  function udSave() { if (!KUD || !card || !card.unknown) return; try { sessionStorage.setItem(KUD, JSON.stringify({ code: card.ucode, qty: card.qty, shelf: card.ushelf, loc: card.uloc || L.saveLoc(M, pickLoc) })); } catch (e) { /* ignore */ } }
  function udClear() { try { if (KUD) sessionStorage.removeItem(KUD); } catch (e) { /* ignore */ } }
  function udRestore() {
    var d = null; try { d = KUD ? JSON.parse(sessionStorage.getItem(KUD) || 'null') : null; } catch (e) { d = null; }
    if (!d || !d.code || card || !M) { if (d && !M) udClear(); return; }
    card = { unknown: true, ucode: String(d.code), qty: String(d.qty === undefined ? '' : d.qty), ushelf: String(d.shelf || ''), uloc: String(d.loc || ''), err: 'ต้องถ่ายรูปสินค้าใหม่อีกครั้ง', restored: true }; showCard();
  }
  function openUnknown(code) { if (switchBlocked()) return; card = { unknown: true, ucode: code, qty: '', ushelf: '', err: '', loc: L.saveLoc(M, pickLoc) }; udSave(); showCard(); }
  function showCard() { hideSug(); closeScan(); closeSettings(); $('home').hidden = true; $('card').hidden = false; drawCard(); window.scrollTo(0, 0); syncLayer(); drawInstall(); }
  function backHome() { camStop(); card = null; udClear(); $('card').hidden = true; $('home').hidden = false; if (M) { renderProg(); renderChips(); renderList(); } else if (D) renderDaily(); renderNotes(); syncLayer(); geoFlush(); drawInstall(); }
  /* Android back button / back gesture: while the card or the scan sheet is open, one history entry (same URL, state object only) sits on top, so "back" closes that layer
     instead of leaving the app. Closing a layer by hand removes the entry again; the swallow flag ignores the popstate that this causes. */
  var layerPushed = false, layerSwallow = false, settingsOpen = false;
  function layerOpen() { return !!card || !$('scan').hidden || settingsOpen; }
  function syncLayer() {
    try {
      if (layerOpen() && !layerPushed) { history.pushState({ layer: 1 }, ''); layerPushed = true; }
      else if (!layerOpen() && layerPushed) { layerPushed = false; layerSwallow = true; history.back(); }
    } catch (e) { layerPushed = false; layerSwallow = false; }
  }
  function onLayerPop() {
    if (layerSwallow) { layerSwallow = false; return; }
    if (!layerPushed) return;
    layerPushed = false;
    if (card) {
      if (!card.unknown && card.mode === 'scan' && card.qty > 0 && !card.leave) { card.leave = true; drawCard(); syncLayer(); return; }   // same "press again" guard as the card's own back button
      backHome(); return;
    }
    if (!$('scan').hidden) { closeScan(); return; }
    if (settingsOpen) closeSettings();
  }
  function shelfInfo(name) { for (var i = 0; i < card.shelves.length; i++) if (card.shelves[i].shelf === name) return card.shelves[i]; return null; }

  /** The note shown when 2+ shelves of the part are counted: "นับแล้ว N ชั้น", one line per counted shelf, then the redo rule. null when fewer. */
  function countedNote() {
    var done = card.shelves.filter(function (s) { return s.done; });
    if (done.length < 2) return null;
    var d = el('div', 'note'), g = el('div', 'grow');
    d.appendChild(ic('info'));
    g.appendChild(el('div', '', 'นับแล้ว ' + done.length + ' ชั้น'));
    done.forEach(function (s) { g.appendChild(el('div', '', '• ชั้น ' + s.shelf + ' — ' + s.doneOn + ' โดย ' + s.doneBy)); });
    g.appendChild(el('div', '', 'นับชั้นเดิมซ้ำ = แทนที่ค่าเดิม'));
    d.appendChild(g); return d;
  }

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
    if (card.ext) box.appendChild(noteBox('note', 'info', 'อะไหล่จากสาขาอื่น/สำนักงานใหญ่ นับที่นี่ได้ตามปกติ'));
    if (!card.ext && !card.second && !card.locked) { var cnt = countedNote(); if (cnt) box.appendChild(cnt); }   // 2+ counted shelves of this part: who counted which (never a quantity)
    if (card.shelf !== null && card.shelf !== '') {
      grp = el('div', 'group'); var srow = el('div', 'item');
      srow.appendChild(ic('map-pin')); srow.appendChild(el('span', 'grow', 'ชั้น ' + card.shelf)); grp.appendChild(srow);
    }
    if (card.locked && !card.second) { if (grp) box.appendChild(grp); box.appendChild(el('div', 'msg err', 'รายการนี้อยู่ระหว่างนับซ้ำ แจ้งเจ้าของ')); return; }   // under blind recount: no Save button, the owner unlocks it
    if (card.shelf === null) { drawShelfPicker(box); return; }

    if (!(card.ext && !needShelf())) {
      if (!grp) grp = el('div', 'group');
      var chg = btn('item act'); chg.appendChild(el('span', 'grow', 'เปลี่ยนชั้นวาง'));
      chg.addEventListener('click', function () { card.shelf = null; card.other = false; card.qty = 0; card.lock = ''; card.warn = ''; drawCard(); });
      grp.appendChild(chg); box.appendChild(grp);
    }
    var info = card.ext ? (card.extDone ? { done: true, doneOn: card.extDone.doneOn, doneBy: card.extDone.doneBy } : null) : shelfInfo(card.shelf);
    if (info && info.done) box.appendChild(noteBox('note', 'info', 'นับแล้ว ' + info.doneOn + ' โดย ' + info.doneBy + ' — นับใหม่จะแทนที่ค่าเดิม'));

    var tabs = el('div', 'seg'); tabs.setAttribute('role', 'tablist');
    [['type', 'พิมพ์จำนวน'], ['scan', 'สแกนทีละชิ้น']].forEach(function (m) {
      var b = btn('segb'); b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', card.mode === m[0] ? 'true' : 'false');
      b.appendChild(ic('check', 'segck')); b.appendChild(el('span', 'lb', m[1]));
      b.addEventListener('click', function () { if (m[0] === 'scan' && card.mode !== 'scan') { card.qty = 0; card.lock = ''; } card.mode = m[0]; card.warn = ''; card.err = ''; card.camMsg = ''; card.leave = false; drawCard(); });
      tabs.appendChild(b);
    });
    box.appendChild(tabs);

    var pn = el('div', 'card');
    if (card.mode === 'scan') drawScanMode(pn); else drawTypeMode(pn);
    box.appendChild(pn);

    var err = el('div', card.err ? 'msg err' : ''); err.id = 'cardErr'; err.textContent = card.err || ''; box.appendChild(err);
    var save = btn('pbtn', 'บันทึก'); save.id = 'saveBtn';
    save.addEventListener('click', function () {
      if (card.mode === 'scan' && !(Number(card.qty) > 0)) { card.err = 'ยังไม่ได้สแกน ถ้าไม่พบเลยให้กด ไม่พบเลย (0)'; drawCard(); return; }   // scan mode with nothing scanned is never a count of 0: only the explicit ไม่พบเลย (0) button saves 0
      doSave(readQty());
    }); box.appendChild(save);
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
      b.addEventListener('click', function () { card.shelf = s.shelf; card.other = !!s.extra; card.err = ''; drawCard(); });   // a counted typed shelf saves as otherShelf
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
      var same = L.findShelf(card.shelves, 'shelf', v);   // a name that is already a shelf of this part is that shelf (no duplicate)
      if (same) { card.shelf = same.shelf; card.other = !!same.extra; } else { card.shelf = v; card.other = true; }
      card.err = ''; drawCard();
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
      f.addEventListener('change', function () { var file = f.files && f.files[0]; if (!file) { f.value = ''; return; } if (photoDecoding) { f.value = ''; pieceWarn('กำลังอ่านรูปก่อนหน้า…'); return; } pieceWarn('กำลังอ่านบาร์โค้ดจากรูป…'); f.disabled = true; var mineCard = card; decodePhoto(file, function (text, why) { f.value = ''; f.disabled = false; if (card !== mineCard) return; var k = text ? L.readClass(text, M) : null; if (text && !(k && k.kind === 'plausible')) pieceWarn(/:\/\/|www\./i.test(text) ? NOT_A_PART : L.rejectMsg(text)); else if (text) onPiece(pieceRead(k)); else pieceWarn(why || 'อ่านบาร์โค้ดจากรูปไม่ได้'); }); });
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
    var mine = card, hint = L.makeIgnoreHint(), hintEl = $('pieceHint'), rej = L.makeRejectNotes();
    if (!card.gate) card.gate = L.makeGate(700); else { card.gate.lastCb = 0; card.gate.empties = 0; card.gate.lastSeen = Date.now(); }   // kept across camera restarts: the barcode still in view counts as just seen, and the pause is not a slow callback
    camStart(v, function (text) {
      var k = L.readClass(text, M), now = Date.now();
      if (hintEl) hintEl.hidden = !hint.feed(k.kind, now);
      // an implausible read (a QR link, junk) is an empty frame for the piece gate (which keeps its own count of empty frames); the raw text is shown once
      if (k.kind === 'ignored') { var rn = rej.note(text); if (rn && card === mine) pieceWarn(rn); }
      var use = k.kind === 'plausible' ? pieceRead(k) : '';
      if (cam.gate.feed(use, now)) onPiece(use);
    }, function (msg) { if (card === mine) { card.camMsg = msg; drawCard(); } }, { torch: $('pieceTorch'), zoom: $('pieceZoom'), frame: $('pieceVf'), centreOnly: true, gate: card.gate, onWait: function (on) { if (card === mine) pieceWarn(on ? 'กำลังโหลดตัวอ่าน…' : ''); }, prefer: function () { return mine === card && card.codes ? card.codes : null; } });
  }
  /** the candidate of a read that belongs to this card (a quantity / lot suffix is cut off), else the first plausible one */
  function pieceRead(k) { for (var i = 0; i < k.cands.length; i++) if (card && card.codes && card.codes.indexOf(L.normScan(k.cands[i])) >= 0) return k.cands[i]; return k.cands[0]; }
  /** one scan in "scan each piece" mode: the same code adds 1 (once it left the view for ~0.7 s); a different code warns and does not count */
  function onPiece(text) {
    if (!card || card.unknown || card.mode !== 'scan') return;
    var d = L.scanDecision(card.codes, card.lock, text);
    if (d.action === 'count') { card.qty++; card.lock = d.lock; card.warn = ''; beep(); buzz(60); setBig(); }
    else if (d.action === 'wrong') { card.warn = 'บาร์โค้ดไม่ตรงกับชิ้นนี้ ไม่นับ'; beep(); buzz([80, 60, 80]); setBig(); }
  }

  /** A count at a branch needs no shelf name: the server uses the branch itself as the place (v7). The main shop still asks for one. */
  function needShelf() { var l = (card && card.unknown && card.uloc) || (M && M.loc); return !(l && l !== 'สนง.ใหญ่'); }
  /** keep a nowrap line on ONE line: if it still overflows (Android text scaling, a wider fallback font) step its font size down by 0.5 px until it fits or reaches 12 px. Never hides or cuts the text. Runs once per draw. */
  function fitOneLine(node) {
    try {
      if (typeof window.getComputedStyle !== 'function') return;
      var fs = parseFloat(window.getComputedStyle(node).fontSize), n = 0;
      if (!(fs > 0)) return;
      while (node.scrollWidth > node.clientWidth + 0.5 && fs > 12 && n++ < 20) { fs -= 0.5; node.style.fontSize = fs + 'px'; }
    } catch (e) { /* the clamp() size still applies */ }
  }
  function drawUnknown(box) {
    box.appendChild(el('h2', 'pname', 'ไม่พบรหัสนี้'));
    var m = el('div', 'msg err'); m.id = 'unknownMsg'; m.appendChild(document.createTextNode('อ่านได้: ')); m.appendChild(el('span', 'code', card.ucode)); m.appendChild(document.createTextNode(' — ไม่มีในรายการอะไหล่')); box.appendChild(m);
    box.appendChild(el('div', 'caption', 'บันทึกเป็นรหัสไม่รู้จัก เพื่อให้เจ้าของตรวจสอบ'));
    var c = el('div', 'panel fldstack');
    var q = el('input'); q.type = 'number'; q.inputMode = 'numeric'; q.min = '0'; q.placeholder = '0'; q.value = card.qty; q.addEventListener('input', function () { card.qty = q.value; udSave(); }); c.appendChild(ofield('uqty', 'จำนวนที่นับได้', q));
    var s = el('input'); s.type = 'text'; s.maxLength = 40; s.placeholder = needShelf() ? 'เช่น A-05' : 'ไม่ต้องกรอกก็ได้'; s.value = card.ushelf; s.addEventListener('input', function () { card.ushelf = s.value.trim(); udSave(); }); c.appendChild(ofield('ushelf', needShelf() ? 'ชื่อชั้นวาง' : 'ชื่อชั้นวาง (ถ้ามี)', s));
    box.appendChild(c);
    // a part that is not in DMS needs a photo of the product before it can be saved: its own section (header + badge, one big tile that opens the camera, a one-line warning)
    var sec = el('div', 'ph'); box.appendChild(sec);
    var head = el('div', 'phhead'); head.appendChild(el('b', '', 'รูปสินค้า')); head.appendChild(el('span', 'req' + (card.photo ? ' done' : ''), card.photo ? 'ถ่ายแล้ว ✓' : 'จำเป็น')); sec.appendChild(head);
    var tile = el('label', 'phtile' + (card.photo ? ' has' : '')); sec.appendChild(tile);
    if (card.photo) {
      var prev = el('img'); prev.alt = 'รูปสินค้า'; prev.src = card.photo; tile.appendChild(prev);
      var rt = el('span', 'retake'); rt.appendChild(ic('camera')); rt.appendChild(el('span', '', 'ถ่ายใหม่')); tile.appendChild(rt);
    } else {
      var cm = el('span', 'cam'); cm.appendChild(ic('camera', 'big')); tile.appendChild(cm); tile.appendChild(el('span', 'tx', 'แตะเพื่อถ่ายรูปสินค้า'));
    }
    var pf = el('input'); pf.type = 'file'; pf.id = 'uphoto'; pf.accept = 'image/*'; pf.setAttribute('capture', 'environment'); pf.style.position = 'absolute'; pf.style.left = '-9999px'; tile.appendChild(pf);
    var pg = null;   // after a tab reload (a restored draft) the shot just taken may be in the gallery: a second picker WITHOUT capture opens the gallery (a low-memory phone can kill the page every time the camera app opens)
    if (card.restored && !card.photo) {
      var gt = el('label', 'phtile alt'); gt.appendChild(el('span', 'tx', 'เลือกรูปจากคลังภาพ')); sec.appendChild(gt);
      pg = el('input'); pg.type = 'file'; pg.id = 'uphotoPick'; pg.accept = 'image/*'; pg.style.position = 'absolute'; pg.style.left = '-9999px'; gt.appendChild(pg);
    }
    var need = null;
    if (!card.photo && !card.err) { need = el('div', 'need'); need.id = 'photoNeed'; need.appendChild(ic('triangle-alert')); need.appendChild(el('span', '', 'ต้องถ่ายรูปก่อน จึงจะกดบันทึกได้')); sec.appendChild(need); fitOneLine(need); }   // ONE line on every phone (nowrap + a font that shrinks); the error line below says it already after a failed photo
    function onPhoto(inp) {
      var f = inp.files && inp.files[0]; if (!f) return;
      card.qty = q.value; card.ushelf = s.value.trim();
      var mine = card;
      shrinkPhoto(f, function (data) {
        if (card !== mine) return;
        if (data) { card.photo = data; card.err = ''; } else card.err = 'อ่านรูปไม่ได้ ถ่ายรูปใหม่อีกครั้ง';
        drawCard();
      });
    }
    pf.addEventListener('change', function () { onPhoto(pf); });
    if (pg) pg.addEventListener('change', function () { onPhoto(pg); });
    if (card.err) { var e = el('div', 'msg err', card.err); e.setAttribute('role', 'alert'); box.appendChild(e); }
    var b = btn('pbtn', 'บันทึกเป็นรหัสไม่รู้จัก'); b.id = 'unknownSave'; b.disabled = !card.photo; if (need) b.setAttribute('aria-describedby', 'photoNeed');
    b.addEventListener('click', function () {
      card.qty = q.value; card.ushelf = s.value.trim();
      var bad = L.unknownCheck(card.qty, card.ushelf, needShelf(), card.photo);
      if (bad) { card.err = bad; drawCard(); return; }
      if (!verified) { toast('ยังบันทึกไม่ได้ รอให้ระบบตรวจรหัสก่อน'); return; }
      var code = card.ucode, shelf = card.ushelf, qty = card.qty, photo = card.photo, loc = card.uloc || card.loc || L.saveLoc(M, pickLoc);
      var ce = enqueue('fc', L.unknownBody(code, shelf, qty, loc), 'รหัสไม่รู้จัก ' + code);
      enqueuePhoto(code, shelf, qty, loc, photo, ce && ce.rid);
      toast('บันทึกแล้ว'); backHome();
    });
    box.appendChild(b);
  }

  /** Save = optimistic: the item leaves the list at once, the card closes, the request goes through the queue. */
  function doSave(q) {
    if (!verified) { toast('ยังบันทึกไม่ได้ รอให้ระบบตรวจรหัสก่อน'); return; }
    if (q === null || q === '' || isNaN(Number(q)) || Number(q) < 0) { card.err = 'กรุณาใส่จำนวนที่นับได้ (ไม่พบเลยให้กด "ไม่พบเลย")'; drawCard(); return; }
    var body = card.ext ? L.unknownBody(card.code2 || card.codes[0], card.shelf, q, card.loc || L.saveLoc(M, pickLoc), card.mode) : L.fcBody(card, q, card.mode, card.loc || L.saveLoc(M, pickLoc));   // a part from another location is saved exactly like an unknown code (the server stores the same row)
    enqueue('fc', body, card.name + (card.shelf ? ' ชั้น ' + card.shelf : ''));
    toast('บันทึกแล้ว');
    backHome();
  }

  /* ---------------- scan overlay, typed code (local lookup: no server call) ---------------- */
  function homeMsg(t, kind) { var m = $('homeMsg'); clear(m); if (t) m.appendChild(el('div', 'msg ' + kind, t)); }
  var scanSession = 0;   // bumped on every open / close of the scan sheet: a photo decode from an older session is dropped
  function openScan() {
    if (switchBlocked()) return;
    if (!verified) { toast('รอสักครู่ กำลังตรวจรหัส'); return; }
    homeMsg('', '');
    $('scan').hidden = false; syncLayer(); drawInstall(); $('scanNote').textContent = 'เล็งบาร์โค้ดให้อยู่ในกรอบ'; $('scanHint').hidden = true;
    closeSettings();   // (the scan sheet is already up, so the history entry stays)
    if (diagOn()) { try { diagSet(true); } catch (eD) { /* diagnostics are optional */ } }   // Settings: แสดงข้อมูลกล้อง = the line shows whenever the scanner opens (the long-press still toggles it)
    scanRej = L.makeRejectNotes(); photoUi('');
    scanSession++;
    if (photoDecoding) { photoUi('busy'); return; }   // an earlier photo is still being read: its result starts the camera again if nothing else did
    startScanCam();
  }
  /** (re)starts the live camera of the open scan sheet; used on open, after the page was hidden, and after the photo picker closed */
  function startScanCam() {
    camStop();
    if (photoDecoding) return;   // a photo is being read: the live camera must stay off until decodePhoto has called back
    photoUi('');
    var hint = L.makeIgnoreHint(), confirm = L.makeConfirm();
    camStart($('scanVideo'), function (text, view) {
      var k = L.readClass(text, M), now = Date.now();
      $('scanHint').hidden = !hint.feed(k.kind, now);
      if (k.kind === 'ignored') { var rn = scanRej.note(text); if (rn) $('scanNote').textContent = rn; return; }   // a read that is not a part code: say so once (raw text shown), keep scanning
      if (k.kind !== 'plausible') return;                                   // empty
      var code = bestRead(k);
      // a read from the whole-frame / strip views can be a neighbour's label: it must be seen twice (like an unknown code) before a card opens; band reads open at once
      if (!L.isWideView(view) && L.findPart(M, code) >= 0) { camStop(); $('scan').hidden = true; beep(); buzz(60); lookup(code, true); syncLayer(); drawInstall(); return; }
      if (confirm.add(L.normScan(code))) { camStop(); $('scan').hidden = true; beep(); buzz(60); lookup(code, true); syncLayer(); drawInstall(); }   // a plausible code that is not in the list: only after the same code was read twice in a row
    }, function (msg) { $('scanNote').textContent = msg; }, { torch: $('scanTorch'), zoom: $('scanZoom'), frame: $('scanVf'), tapFocus: true, onWait: function (on) { $('scanNote').textContent = on ? 'กำลังโหลดตัวอ่าน…' : 'เล็งบาร์โค้ดให้อยู่ในกรอบ'; }, switchBtn: $('scanSwitch'), onSwitch: function () { startScanCam(); }, onIdle: function () { $('scanNote').textContent = 'ถือห่าง 15–20 ซม. ให้บาร์โค้ดอยู่ในกรอบ หรือกดถ่ายรูปแทน'; } });
  }
  var scanRej = L.makeRejectNotes();   // one rejected-read note per distinct raw value per scan session (reset when the sheet opens)
  /** which candidate of a read to use: the first that is in the part list (so a lot / quantity suffix does not hide the part), else the first plausible one */
  function bestRead(k) { for (var i = 0; i < k.cands.length; i++) if (M && L.findPart(M, k.cands[i]) >= 0) return k.cands[i]; return k.cands[0]; }
  /** the photo part of the scan sheet: '' = nothing, 'busy' = reading (spinner), 'fail' = could not read (message + ถ่ายใหม่) */
  function photoUi(mode) {
    $('scanBusy').hidden = mode !== 'busy'; $('scanFail').hidden = mode !== 'fail'; $('scanFile').disabled = mode === 'busy';
  }
  var pickerOpen = false;   // the iOS/Android photo picker of the scan sheet is open (set on its click, cleared on change / cancel)
  function resumeScanCam() { if (!$('scan').hidden && !document.hidden) startScanCam(); }
  function closeScan() { scanSession++; try { var dg = $('scanDiag'); if (dg) dg.hidden = true; } catch (e) { /* ignore */ } camStop(); photoUi(''); $('scan').hidden = true; syncLayer(); geoFlush(); drawInstall(); }
  function lookup(code, viaScan) {
    if (switchBlocked()) return;
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
    if (switchBlocked()) return;
    if (!verified) { toast('รอสักครู่ กำลังตรวจรหัส'); return; }   // refused: the typed text and the list stay
    hideSug(); homeMsg('', '');
    openCard(L.cardOf(M, p, false), undefined, false);
  }
  /** the "not in the list" row / search with no exact match and no suggestions: the same unknown-code screen lookup() ends in */
  function openUnknownTyped(text) {
    if (switchBlocked()) return;
    if (!verified) { toast('รอสักครู่ กำลังตรวจรหัส'); return; }
    hideSug(); homeMsg('', '');
    openUnknown(text);
  }
  function renderSug() {
    var box = $('codeSug'), live = $('codeSugLive'), inp = $('codeIn'), text = inp.value; clear(box); clear(live);
    if (!M || L.normScan(text).length < 2) { sugHint = false; inp.setAttribute('aria-expanded', 'false'); return; }
    var r = L.suggestMatches(M, text, 8), typed = text.trim(), exact = L.findPart(M, text) >= 0, vi = exact ? -1 : L.findPartVariant(M, text);
    if (vi >= 0 && r.list.indexOf(vi) < 0) r = { list: [vi].concat(r.list), shown: [M.parts[vi].code2 || M.parts[vi].c1].concat(r.shown), total: r.total + 1 };   // a label variant of a listed part: that part's row   // an exact code: just the matches (search opens it), no "unknown" row
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
      } else if (part.ext && part.doneOn) l2.appendChild(el('span', 'donetag', 'นับแล้ว'));
      two.appendChild(l2); b.appendChild(two); b.appendChild(ic('chevron-right', 'chev'));
      b.addEventListener('click', function () { openPart(p); });
      grp.appendChild(b);
    });
    if (r.total > r.list.length) grp.appendChild(el('div', 'sugmore', 'และอีก ' + fmt(r.total - r.list.length) + ' รายการ พิมพ์เพิ่มเพื่อให้แคบลง'));
    if (!exact && vi < 0) {
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
    if (switchBlocked()) return;
    var fp = M ? L.findPart(M, v) : -1, vp = M && fp < 0 ? L.findPartVariant(M, v) : -1;
    if (M && fp < 0 && vp < 0 && L.isFullCode(v)) { openUnknownTyped(v.trim()); return; }   // a whole code that is not listed: like a scan of an unlisted product (refused while not verified: the text stays)
    if (M && fp < 0 && vp < 0 && L.suggestMatches(M, v, 1).total > 0) { sugHint = true; renderSug(); return; }
    if (!verified) { toast('รอสักครู่ กำลังตรวจรหัส'); return; }   // refused: keep the typed text
    hideSug(); lookup(vp >= 0 ? (M.parts[vp].code2 || M.parts[vp].c1) : v, false);
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
  var zxFailAt = 0, zxTag = null;   // when the last ZXing load failed / timed out (no new attempt for 60 s: a retry on every camera frame piled up script tags), and the script tag of the latest attempt
  var ZX_SLOW_MS = 13000, ZX_TIMEOUT_MS = 45000, ZX_RETRY_MS = 60000;
  /** loadZXing(cb, onSlow): cb(ok) once. A slow network is not a failure: after ZX_SLOW_MS every waiting caller's onSlow() runs ("loading..." on screen, camera stays open) and the wait goes on; only an onerror or ZX_TIMEOUT_MS (45 s) without the script answers cb(false). The late onload of a script still sets window.ZXing for the next call. */
  function loadZXing(cb, onSlow) {
    if (window.ZXing) { cb(true); return; }
    var w = { cb: cb, slow: onSlow };
    if (zxLoading) { zxLoading.list.push(w); if (zxLoading.slowFired && onSlow) { try { onSlow(); } catch (e1) { /* ignore */ } } return; }
    if (zxFailAt && Date.now() - zxFailAt < ZX_RETRY_MS) { cb(false); return; }
    var rec = zxLoading = { list: [w], slowFired: false }, finished = false, slowT = null, timer = null;
    var done = function (ok) {
      if (finished) return; finished = true; clearTimeout(slowT); clearTimeout(timer);
      if (zxLoading === rec) zxLoading = null;
      if (!ok) zxFailAt = Date.now();
      rec.list.forEach(function (x) { try { x.cb(ok); } catch (e) { /* one caller must not stop the others */ } });
    };
    slowT = setTimeout(function () { rec.slowFired = true; rec.list.forEach(function (x) { if (x.slow) { try { x.slow(); } catch (e2) { /* ignore */ } } }); }, ZX_SLOW_MS);
    timer = setTimeout(function () { done(!!window.ZXing); }, ZX_TIMEOUT_MS);   // nothing at all after 45 s: now it is a failure
    try {
      if (zxTag && zxTag.parentNode) { try { zxTag.parentNode.removeChild(zxTag); } catch (e0) { /* ignore */ } }
      var s = zxTag = document.createElement('script');
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
    clearTimeout(cam.timer); cam.timer = null; clearTimeout(camSavedWatch);
    try { if (cam.stream) cam.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ignore */ }
    cam.stream = null; cam.torch = false;
    var vs = document.querySelectorAll('video'); for (var i = 0; i < vs.length; i++) { try { vs[i].srcObject = null; } catch (e) { /* ignore */ } }
    var tb = document.querySelectorAll('.torch'); for (var j = 0; j < tb.length; j++) { tb[j].hidden = true; tb[j].classList.remove('on'); }
    var sw = document.querySelectorAll('.switchcam'); for (var m = 0; m < sw.length; m++) sw[m].hidden = true;
    var zb = document.querySelectorAll('.zoom'); for (var k = 0; k < zb.length; k++) zb[k].hidden = true;
  }
  /** Track extras: continuous focus, the torch button, and a zoom button (default about 2x so the phone can be held 15-25 cm away). */
  function setupTrack(stream, torchBtn, zoomBtn) {
    try {
      var track = stream.getVideoTracks()[0], caps = track && track.getCapabilities ? track.getCapabilities() : null;
      if (!caps) return;
      var apply = function (c) { try { var r = track.applyConstraints({ advanced: [c] }); if (r && r.catch) r.catch(function () { /* not supported: fine */ }); return r; } catch (e) { return null; } };
      if (caps.focusMode && caps.focusMode.indexOf && caps.focusMode.indexOf('continuous') >= 0) apply({ focusMode: 'continuous' });
      var ios = isIOS(), zp = L.zoomPlan(caps, ios ? 1.75 : 2);   // iOS without a virtual lens: a bit of zoom so the phone can be held farther away; the triple / dual-wide cameras handle close focus themselves (no automatic zoom, the button still works)
      if (zp && zoomBtn) {
        var wideDef = camVirtual && camWide && caps.zoom && Number(caps.zoom.min) <= 1 && Number(caps.zoom.max) >= 2;   // iOS triple / dual-wide: min may be the ultra-wide lens, so start on the wide lens (2x)
        var noAuto = ios && camVirtual && !wideDef; cam.zoom = noAuto ? zp.min : (wideDef ? 2 : zp.def); if (!noAuto) apply({ zoom: cam.zoom });
        zoomBtn.hidden = false; zoomBtn.textContent = L.zoomLabel(cam.zoom);
        zoomBtn.onclick = function () { cam.zoom = cam.zoom > zp.min ? zp.min : (wideDef ? 2 : zp.def); apply({ zoom: cam.zoom }); zoomBtn.textContent = L.zoomLabel(cam.zoom); };
      }
      if (torchBtn && caps.torch) {
        torchBtn.hidden = false;
        torchBtn.onclick = function () {
          cam.torch = !cam.torch;
          try { track.applyConstraints({ advanced: [{ torch: cam.torch }] }).then(function () { torchBtn.classList.toggle('on', cam.torch); if (caps.focusMode && caps.focusMode.indexOf && caps.focusMode.indexOf('continuous') >= 0) apply({ focusMode: 'continuous' }); }, function () { cam.torch = false; torchBtn.hidden = true; }); } catch (e) { cam.torch = false; torchBtn.hidden = true; }
        };
      }
    } catch (e) { /* no extras: fine */ }
  }
  function engineSaved() { try { return L.engineSavedValid(localStorage.getItem('sc5.engine'), Date.now()) ? 'zx' : ''; } catch (e) { return ''; } }
  /** Writes the 7-day "use ZXing" note, but ONLY when native really ran in this page session and was dropped (camEngineSession is set nowhere else), and never again while the note is still valid (re-saving on every use would make it never expire). A getSupportedFormats timeout / no BarcodeDetector never saves. */
  function engineSave() { if (camEngineSession !== 'zxing' || engineSaved()) return; try { localStorage.setItem('sc5.engine', 'zx:' + Date.now()); } catch (e) { /* ignore */ } }
  var camThrows = 0, camDeviceId = '', camVirtual = false, camWide = false;   // consecutive native detect() failures; the camera chosen earlier in this page session (+ whether it is an iOS triple / dual virtual lens)
  var camList = [];   // [{id,label}]   // Android: deviceIds of the back cameras (best first), for the manual switch button
  var camDiag = { engine: '', frames: 0, t0: 0, natCalls: 0, natHits: 0, zxN: 0, lastRead: 0 };
  var camNativeEver = false;   // the native detector read something at least once in this page session   // for the owner's diagnostic line
  function camPrefGet() { try { return localStorage.getItem('sc5.cam') || ''; } catch (e) { return ''; } }
  /** camPrefSet only STAGES the lens: it is written to sc5.cam by camPrefCommit() once the camera has produced a decoded read (a lens that opens but reads nothing must not be remembered). */
  var camPrefPending = '', camSavedLens = false, camSavedWatch = null;   // staged camKey; the remembered lens was accepted this session and has not read anything yet; its 10 s timer
  function camPrefSet(id) { camPrefPending = id; }
  function camPrefCommit() { var id = camPrefPending; camPrefPending = ''; if (!id) return; try { localStorage.setItem('sc5.cam', id); } catch (e) { /* ignore */ } }
  function camPrefDrop() { camPrefPending = ''; try { localStorage.removeItem('sc5.cam'); } catch (e) { /* ignore */ } }
  var camPicked = false;   // androidPick finished once in this page session: later sheet opens reuse the camera
  var camBad = {};   // deviceIds whose exact open failed in this page session: never retried
  var camZxHits = 0;   // ZXing-only band reads in a row across camera runs (a card opens after the first one, so a per-run count never reaches 2)
  var camEngineSession = '';   // 'zxing' once the native detector proved useless in this page session
  var CAM_VIDEO = { width: { ideal: 1920 }, height: { ideal: 1080 } };
  /** getUserMedia for one exact camera. A busy camera (NotReadableError / AbortError: the previous stream is still being released, typical right after the switch button) is retried ONCE on the same id after 500 ms before the caller falls back. */
  function openCamId(id, wait) {
    var open = function () { return navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: id }, width: CAM_VIDEO.width, height: CAM_VIDEO.height }, audio: false }); };
    return open().catch(function (err) {
      var nm = err && err.name;
      if (nm !== 'NotReadableError' && nm !== 'AbortError') throw err;
      return new Promise(function (res) { setTimeout(res, wait === undefined ? 500 : wait); }).then(open);
    });
  }
  function isIOS() { try { return L.isIOS(navigator.userAgent, navigator.platform, navigator.maxTouchPoints); } catch (e) { return false; } }
  /** After permission: on Android multi-lens phones swap facingMode for the main back camera; on iPhone prefer "Back Triple Camera" / "Back Dual Wide Camera" / "Back Dual Camera" (they switch to the macro lens for close focus). Labels are only readable after permission. Always resolves with a usable stream; any error falls back to facingMode environment. */
  function betterStream(stream, run) {
    return new Promise(function (resolve) {
      try {
        var md = navigator.mediaDevices, tr = stream.getVideoTracks()[0], cur = '';
        try { cur = (tr && tr.getSettings && tr.getSettings().deviceId) || ''; } catch (e) { /* ignore */ }
        var reopen = function (id, virt, wide) {
          stream.getTracks().forEach(function (t) { t.stop(); });
          openCamId(id).then(function (s2) { camDeviceId = id; camVirtual = !!virt; camWide = !!wide; resolve(s2); }, function (err) {
            if (L.camHardFail(err)) camBad[id] = true; camDeviceId = ''; camVirtual = false; camWide = false;
            md.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: CAM_VIDEO.width, height: CAM_VIDEO.height }, audio: false }).then(resolve, function () { resolve(null); });
          });
        };
        if (camDeviceId) { if (camDeviceId === cur) resolve(stream); else reopen(camDeviceId, camVirtual, camWide); return; }   // chosen earlier in this session: no new enumeration
        if (!md.enumerateDevices) { resolve(stream); return; }
        md.enumerateDevices().then(function (devs) {
          var id = L.pickBackCamera(devs), virt = false, wide = false;
          if (!isIOS()) { try { camList = L.backCameras(devs); } catch (e5) { camList = []; } if (camList.length && run === camRun && camPicked) { resolve(stream); return; }   // already picked in this page session: keep the current stream
          if (camList.length && run === camRun) { androidPick(camList, stream, cur, run, resolve); return; } }
          if (!id && isIOS()) { var pk = L.pickIosCamera(devs); if (pk) { id = pk.id; virt = pk.virtual; wide = pk.wide; } }
          if (run !== camRun) { resolve(stream); return; }
          if (id && camBad[id]) id = '';   // an exact open of this camera failed before: keep the stream we have
          if (id && id === cur) { camDeviceId = id; camVirtual = virt; camWide = wide; }
          if (!id || id === cur) { resolve(stream); return; }
          reopen(id, virt, wide);
        }, function () { resolve(stream); });
      } catch (e) { resolve(stream); }
    });
  }
  /** Android: open the remembered (sc5.cam, by label) or the best back camera that can focus. Each tested lens is closed again; the first with continuous focus wins, else the widest-sensor one that is not fixed, else the first. Always resolves with a stream (or null). */
  function androidPick(list, stream, cur, run, resolve) {
    var md = navigator.mediaDevices, order = list.filter(function (c) { return !camBad[c.id]; }), curStream = stream, curId = cur, i = 0, tested = [], MAXT = 4;
    if (!order.length) { resolve(stream); return; }
    var anyFail = false;
    var saved = null; try { saved = L.matchCam(order, camPrefGet()); } catch (e) { saved = null; }
    if (saved) { order.splice(order.indexOf(saved), 1); order.unshift(saved); }   // a remembered choice is tried first and kept as long as it opens (it is the owner's/auto-picked pick)
    var stopS = function (s) { try { if (s) s.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ignore */ } };
    var done = function (c, s) { camPicked = true; camDeviceId = c.id; camVirtual = false; camWide = false; resolve(s); };
    var envFallback = function () { camPicked = true; camDeviceId = ''; md.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: CAM_VIDEO.width, height: CAM_VIDEO.height }, audio: false }).then(resolve, function () { resolve(null); }); };
    var openExact = function (c, ok, bad, retried) {
      md.getUserMedia({ video: { deviceId: { exact: c.id }, width: CAM_VIDEO.width, height: CAM_VIDEO.height }, audio: false }).then(ok, function (err) {
        var nm = err && err.name;
        if (!retried && (nm === 'NotReadableError' || nm === 'AbortError')) { setTimeout(function () { openExact(c, ok, bad, true); }, 400); return; }   // the previous stream may still be releasing the camera: retry the SAME one once
        anyFail = true; if (L.camHardFail(err)) camBad[c.id] = true; bad();
      });
    };
    var finishBest = function () {
      if (run !== camRun) { stopS(curStream); curStream = null; resolve(null); return; }
      // nothing had continuous focus: the best tested one (not fixed, widest) else the first
      var pool = tested.filter(function (t) { return !t.fixed; }); if (!pool.length) pool = tested;
      pool.sort(function (x, y) { return y.w - x.w; });
      var c = pool[0].c; if (curId === c.id && curStream) { if (!anyFail) camPrefSet(L.camKey(c.label)); done(c, curStream); return; }
      stopS(curStream); curStream = null; curId = '';
      openExact(c, function (s) { if (!anyFail) camPrefSet(L.camKey(c.label)); done(c, s); }, function () { envFallback(); });
    };
    var step = function () {
      if (run !== camRun) { stopS(curStream); curStream = null; resolve(null); return; }
      if (i >= order.length || i >= MAXT) { if (tested.length) finishBest(); else envFallback(); return; }
      var c = order[i];
      var after = function (s) {
        if (run !== camRun) { resolve(s); return; }
        var caps = null; try { var t = s.getVideoTracks()[0]; caps = t && t.getCapabilities ? t.getCapabilities() : null; } catch (e) { caps = null; }
        var fixed = false, cont = false, w = 0;
        try { fixed = L.fixedFocus(caps); cont = !!(caps && Array.isArray(caps.focusMode) && caps.focusMode.indexOf('continuous') >= 0); w = (caps && caps.width && Number(caps.width.max)) || 0; } catch (e) { /* ignore */ }
        if (c === saved && !fixed && (cont || !caps)) { camSavedLens = true; done(c, s); return; }   // a remembered lens is trusted only if it still shows continuous focus (capabilities unknown = trusted); otherwise it is tested like the others. camSavedLens: dropped if it reads nothing in 10 s
        if (cont && !fixed) { if (!anyFail) camPrefSet(L.camKey(c.label)); done(c, s); return; }
        tested.push({ c: c, fixed: fixed, w: w }); i++;
        curStream = s; curId = c.id;
        if (i >= order.length || i >= MAXT) { finishBest(); return; }
        stopS(s); curStream = null; curId = ''; step();
      };
      if (c.id === curId && curStream) { after(curStream); return; }
      stopS(curStream); curStream = null; curId = '';
      openExact(c, function (s) { curStream = s; curId = c.id; after(s); }, function () { i++; step(); });
    };
    step();
  }
  var viewCv = null, stripCv = null;   // separate canvases: the strip view (native detector) and the ZXing views are never resized into each other
  /** Another view of the live video for ZXing: 'full' = the whole frame (shrunk to 960 px on the long edge), 'rot' = the central vertical strip turned 90 degrees (a barcode held sideways). Full resolution, one reused canvas. */
  function viewCanvas(video, kind) {
    var vw = video.videoWidth, vh = video.videoHeight, strip = kind === 'strip', c = strip ? (stripCv || (stripCv = document.createElement('canvas'))) : (viewCv || (viewCv = document.createElement('canvas'))), x;
    try { x = c.getContext('2d', { willReadFrequently: true }); } catch (e) { x = c.getContext('2d'); }
    // (the native whole-frame view needs no canvas: the <video> itself goes to detect())
    if (strip) { var tw = vw, th = Math.max(1, Math.round(vh * 0.2)), ty = Math.round((vh - th) / 2); if (c.width !== tw || c.height !== th) { c.width = tw; c.height = th; } x.drawImage(video, 0, ty, tw, th, 0, 0, tw, th); return c; }
    if (kind === 'full') { var k = Math.min(1, L.LIVE_FULL_MAX / Math.max(vw, vh)), fw = Math.max(1, Math.round(vw * k)), fh = Math.max(1, Math.round(vh * k)); c.width = fw; c.height = fh; x.drawImage(video, 0, 0, vw, vh, 0, 0, fw, fh); return c; }   // never a full 1080x1920 decode: the whole-frame view is shrunk to 960 px
    var sw = Math.max(1, Math.round(vw * 0.35)), sh = Math.max(1, Math.round(vh * 0.9)), sx = Math.round((vw - sw) / 2), sy = Math.round((vh - sh) / 2);
    c.width = sh; c.height = sw; x.setTransform(1, 0, 0, 1, 0, 0);
    x.translate(sh, 0); x.rotate(Math.PI / 2); x.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh); x.setTransform(1, 0, 0, 1, 0, 0);
    return c;
  }
  /** Builds decode(canvas, cb): native BarcodeDetector when it really supports 1D formats, ZXing otherwise; falls over to ZXing when native throws or reads nothing for ~4 s. */
  function makeEngine(run, onReady, onNoLib, eo) {
    eo = eo || {};
    camThrows = 0;   // throws of an earlier camera session must not add up to this session's 3-in-a-row switch
    var st = { centreOnly: !!eo.centreOnly, det: null, nativeOk: false, nativeBad: false, zx: false, started: Date.now(), hints: null, frames: 0 };
    var needZX = function (cb) {
      if (!cb && st.zxAsk) return;   // the frame loop asks on every frame while the library loads: one waiting caller is enough
      st.zxAsk = true;
      loadZXing(function (ok) {
        st.zxAsk = false;
        if (run !== camRun) return;
        if (!ok) { if (!st.det || st.nativeBad) onNoLib(); cb && cb(false); return; }
        st.hints = st.hints || L.zxHints(window.ZXing, false); st.zx = true;
        if (st.slowShown) { st.slowShown = false; try { eo.onWait && eo.onWait(false); } catch (e1) { /* ignore */ } }   // the late onload arrived: the "loading" line goes, scanning starts
        cb && cb(true);
      }, function () {   // 13 s without the library: the camera stays open and says so (a slow network is not a failure); only when ZXing is the engine in use
        if (run !== camRun || (st.det && !st.nativeBad)) return;
        st.slowShown = true; try { eo.onWait && eo.onWait(true); } catch (e2) { /* ignore */ }
      });
    };
    // ZXing sees a different view on each frame: the centre band, the whole frame, the band inverted (white-on-black labels), a vertical strip rotated 90 degrees
    var zxRead = function (canvas, video) {
      if (!st.zx) return '';
      var Z = window.ZXing, k = L.zxVariant(st.zxn++), c = canvas, inv = false;
      if (st.centreOnly && (k === 'full' || k === 'rot')) k = 'band';   // piece counting: centre band only
      st.zv = k;
      try {
        if (k === 'full' && video) c = viewCanvas(video, 'full'); else if (k === 'rot' && video) c = viewCanvas(video, 'rot'); else if (k === 'inv') inv = true;
      } catch (e) { c = canvas; inv = false; }
      try { return L.zxDecodeSource(Z, new Z.HTMLCanvasElementLuminanceSource(c), st.hints, inv); } catch (e2) { return ''; }   // the source is built inside the try: a synchronous throw is an empty frame, never an exception into the decode loop
    };
    st.zxn = 0;
    var decode = function (canvas, cb, video) {
      camDiag.engine = (st.nativeBad || !st.det) ? 'zxing' : 'native';
      if (st.nativeBad || !st.det) { var zt = zxRead(canvas, video); if (zt) { camDiag.zxN++; if (!camNativeEver && st.zv === 'band' && ++camZxHits >= 2) engineSave(); } cb(zt, 'zx:' + st.zv); return; }   // every ZXing read is reported as 'zx:<view>': L.isWideView makes the scan sheet want it twice (a full-width band can hold two labels side by side and the left one may win)   // the switch was session-only: it is written to sc5.engine only after a 2nd band hit with native silent
      var after = function (t, view) {
        if (t) { st.nativeOk = true; camNativeEver = true; camDiag.natHits++; camZxHits = 0; cb(t, view); return; }
        if (!st.nativeOk) {   // native silent for 4 s (counted from the first frame it looked at): probe ZXing on every 3rd frame
          if (!st.firstAt) st.firstAt = Date.now();
          if (Date.now() - st.firstAt > 1500) {   // native silent for 1.5 s: probe ZXing on every 2nd frame (a BarcodeDetector can answer [] forever without throwing)
            if (!st.zx) needZX();
            if (++st.frames % 2 === 0) {
              var z = zxRead(canvas, video);
              if (z) camDiag.zxN++;
              // no native read at all in this page session: the first ZXing read switches the session to ZXing for good; otherwise 2 band-view hits (never reset by a miss) do
              if (z && st.zv === 'band') { camZxHits++; if (Date.now() - st.firstAt >= 3000 && (!camNativeEver || camZxHits >= 2)) { camEngineSession = 'zxing'; st.nativeBad = true; if (camZxHits >= 2) engineSave(); } }   // session-only switch, never before native has had ~3 s to warm up; only band reads count (a full/rot read says nothing about the band the native detector looks at)
              if (z) { cb(z, 'zx:' + st.zv); return; }
            }
          }
        }
        cb('');
      };
      var broke = function () { if (++camThrows >= 3) { st.nativeBad = true; camEngineSession = 'zxing'; engineSave(); needZX(); } cb(''); };   // a single throw keeps native; ZXing only after 3 in a row
      var src = canvas, nk = L.nativeViewFor(st.nn = (st.nn || 0) + 1, st.centreOnly), cw = canvas.width, ch = canvas.height;
      try {
        if (video && nk === 'full') { src = video; cw = video.videoWidth; ch = video.videoHeight; }   // the whole frame at native size: the <video> goes straight to detect(), no canvas copy
        else if (video && nk === 'strip') { src = viewCanvas(video, 'strip'); cw = src.width; ch = src.height; }
      } catch (e0) { src = canvas; nk = 'band'; cw = canvas.width; ch = canvas.height; }
      var po = { cx: cw / 2, cy: ch / 2, prefer: eo.prefer ? eo.prefer() : null };
      var broke2 = function () { if (run !== camRun) cb(''); else broke(); };   // a failure from a stale run must not bump camThrows / engineSave()
      camDiag.natCalls++;
      try { st.det.detect(src).then(function (r) { if (run === camRun) camThrows = 0; after(L.pickLive(r, M, po), nk); }, broke2); } catch (e) { broke2(); }
    };
    var go = function (useNative) {
      if (useNative) { st.det = makeDetector(L.ONE_D_NATIVE); }
      if (st.det) { onReady(decode); return; }
      needZX(function (ok) { if (ok) onReady(decode); });
    };
    if (engineSaved() === 'zx' || camEngineSession === 'zxing' || !('BarcodeDetector' in window)) { go(false); return; }
    var sf = window.BarcodeDetector.getSupportedFormats;
    if (typeof sf !== 'function') { go(true); return; }
    var settled = false, fin = function (formats) { if (settled) return; settled = true; go(L.pickEngine(formats) === 'native'); };
    try { sf.call(window.BarcodeDetector).then(fin, function () { fin([]); }); } catch (e) { fin([]); }
    setTimeout(function () { fin([]); }, 1500);   // a slow getSupportedFormats only means ZXing for THIS open: nothing is remembered (no camEngineSession, no sc5.engine), the next open asks again
  }
  /** onFrame(text) gets every decode result ('' = nothing). opts: {torch, zoom, frame (the viewfinder element: its shape follows the decoded band), onIdle (called once when nothing was read for ~8 s)} */
  function camStart(video, onFrame, onFail, opts) {
    opts = opts || {};
    camStop();
    var run = camRun, idleDone = false, idleAt = Date.now() + 8000;
    cam.gate = opts.gate || L.makeGate(700);   // the piece card passes its own gate, so a restart with the same barcode still in view does not count it again
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('nocam');
      var firstOpen = function () { return navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: CAM_VIDEO.width, height: CAM_VIDEO.height }, audio: false }); };
      // the camera chosen earlier in this page session is opened directly (one open, not two: iOS shows the camera twice otherwise); on error fall back to facingMode
      var firstP = (camDeviceId && !camBad[camDeviceId])
        ? openCamId(camDeviceId).catch(function (err) { if (L.camHardFail(err)) camBad[camDeviceId] = true; camDeviceId = ''; camVirtual = false; camWide = false; return firstOpen(); })
        : firstOpen();
      firstP.then(function (first) {
        if (run !== camRun) { first.getTracks().forEach(function (t) { t.stop(); }); return; }
        return betterStream(first, run).then(function (stream) {
          if (run !== camRun) { if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); return; }
          if (!stream) { camStop(); onFail(camMessage(new Error('nocam'))); return; }
          cam.stream = stream;
          video.setAttribute('playsinline', ''); video.setAttribute('autoplay', ''); video.muted = true;
          video.srcObject = stream; setupTrack(stream, opts.torch, opts.zoom);
          try { camExtras(stream, video, opts); } catch (e6) { /* extras never stop scanning */ }
          var p; try { p = video.play(); } catch (e0) { p = null; } if (p && p.catch) p.catch(function () { /* autoplay refused: the stream still decodes */ });
          camDiag.frames = 0; camDiag.t0 = Date.now(); camDiag.lastRead = 0;
          var wrapped = function (text, view) {
            camDiag.frames++; if (text) camDiag.lastRead = Date.now();
            if (text) { camPrefCommit(); camSavedLens = false; clearTimeout(camSavedWatch); }   // the lens produced a read: now it may be remembered
            if (text) idleDone = true;
            else if (!idleDone && opts.onIdle && Date.now() > idleAt) { idleDone = true; try { opts.onIdle(); } catch (e2) { /* ignore */ } }
            onFrame(text, view);
          };
          if (camSavedLens) { clearTimeout(camSavedWatch); camSavedWatch = setTimeout(function () { if (run === camRun && camSavedLens) { camSavedLens = false; camPrefDrop(); } }, 10000); }   // the remembered lens read nothing in 10 s with the sheet open: forget it, the next session tests the lenses again
          makeEngine(run, function (decode) { if (run === camRun) bandLoop(run, video, opts.frame, wrapped, decode, idleAt, function () { if (!idleDone) { idleDone = true; if (opts.onIdle) opts.onIdle(); } }); }, function () { if (run === camRun) { camStop(); onFail(camMessage(new Error('nolib'))); } }, { centreOnly: !!opts.centreOnly, prefer: opts.prefer, onWait: opts.onWait });
        });
      }).catch(function (e) { if (run === camRun) { camStop(); onFail(camMessage(e)); } });
    } catch (e) { camStop(); onFail(camMessage(e)); }
  }
  /** Android extras for the scan sheet: tap to focus on the preview, the manual camera-switch button. All optional, all in try/catch. */
  function camExtras(stream, video, opts) {
    var track = stream.getVideoTracks()[0], caps = null;
    try { caps = track && track.getCapabilities ? track.getCapabilities() : null; } catch (e) { caps = null; }
    var run = camRun, backToCont = null;
    if (opts.tapFocus && track && caps) {
      video.onclick = function (ev) {
        try {
          if (run !== camRun || !caps.pointsOfInterest) return;
          var r = video.getBoundingClientRect(), x = Math.min(1, Math.max(0, (ev.clientX - r.left) / (r.width || 1))), y = Math.min(1, Math.max(0, (ev.clientY - r.top) / (r.height || 1)));
          var c = { pointsOfInterest: [{ x: x, y: y }] }; if (caps.focusMode && caps.focusMode.indexOf && caps.focusMode.indexOf('single-shot') >= 0) c.focusMode = 'single-shot';
          var p = track.applyConstraints({ advanced: [c] }); if (p && p.catch) p.catch(function () { /* ignore */ });
          clearTimeout(backToCont);
          backToCont = setTimeout(function () {
            try { if (run === camRun && caps.focusMode && caps.focusMode.indexOf('continuous') >= 0) { var q = track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); if (q && q.catch) q.catch(function () { /* ignore */ }); } } catch (e2) { /* ignore */ }
          }, 1500);
        } catch (e1) { /* ignore */ }
      };
    }
    if (opts.tapFocus && track && caps && Array.isArray(caps.focusMode) && caps.focusMode.indexOf('single-shot') >= 0 && caps.focusMode.indexOf('continuous') < 0) {   // only single-shot offered: re-trigger it every ~2 s while nothing is read
      var again = function () {
        if (run !== camRun) return;
        try { if (Date.now() - camDiag.lastRead > 2000) { var q = track.applyConstraints({ advanced: [{ focusMode: 'single-shot' }] }); if (q && q.catch) q.catch(function () { /* ignore */ }); } } catch (e4) { /* ignore */ }
        setTimeout(again, 2000);
      };
      setTimeout(again, 2000);
    }
    var sb = opts.switchBtn;
    if (sb && !isIOS() && camList.length >= 2) {
      sb.hidden = false;
      sb.onclick = function () {
        try {
          var cur = camDeviceId || (track.getSettings && track.getSettings().deviceId) || '', nx = L.nextCam(camList.map(function (c) { return c.id; }), cur);
          if (!nx) return;
          camDeviceId = nx; var ne = camList.filter(function (c) { return c.id === nx; })[0]; if (ne) camPrefSet(L.camKey(ne.label)); camVirtual = false; camWide = false;
          if (opts.onSwitch) opts.onSwitch();
        } catch (e3) { /* ignore */ }
      };
    }
  }
  /** The decode loop: copy the centre band of the video (full resolution) to a canvas, decode it, hand the result on, wait ~100 ms, repeat. */
  function bandLoop(run, video, frameEl, onFrame, decode, idleAt, onIdle) {
    var canvas = document.createElement('canvas'), ctx = null, shaped = false;
    (function tick() {
      if (run !== camRun) return;
      var again = function () { if (run === camRun) cam.timer = setTimeout(tick, 100); };
      var vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) { if (onIdle && Date.now() > idleAt) { var oi = onIdle; onIdle = null; try { oi(); } catch (e3) { /* ignore */ } } again(); return; }
      var fin = false, wd = null, finish = function (text, view) { if (fin) return; fin = true; clearTimeout(wd); if (run === camRun) { try { onFrame(text, view); } catch (e1) { /* ignore */ } } again(); };   // the ONLY way a tick continues: callable any number of times, continues once
      try {
        var r = L.bandRect(vw, vh);
        if (!ctx) { try { ctx = canvas.getContext('2d', { willReadFrequently: true }); } catch (e0) { ctx = canvas.getContext('2d'); } }
        if (canvas.width !== r.sw || canvas.height !== r.sh) { canvas.width = r.sw; canvas.height = r.sh; }
        if (!shaped && frameEl && frameEl.style) { shaped = true; frameEl.style.aspectRatio = r.sw + ' / ' + r.sh; }   // the viewfinder shows (about) the band that is decoded
        ctx.drawImage(video, r.sx, r.sy, r.sw, r.sh, 0, 0, r.sw, r.sh);
        wd = setTimeout(function () { finish(''); }, 2000);   // a decoder that never answers must not stall the loop
        decode(canvas, finish, video);
      } catch (e) { finish(''); }   // a synchronous throw after the watchdog was armed must not start a second loop: finish() is once-only
    })();
  }
  /** long-press (700 ms) on the scan sheet title toggles a one-line diagnostic (for a screenshot to the owner) */
  var diagTimer = null, diagTick = null;
  function diagText() {
    var o = { engine: camDiag.engine, natCalls: camDiag.natCalls, natHits: camDiag.natHits, zxN: camDiag.zxN, samsung: /SamsungBrowser/i.test(navigator.userAgent || ''), fps: camDiag.t0 ? camDiag.frames / Math.max(1, (Date.now() - camDiag.t0) / 1000) : 0 };
    try {
      var tr = cam.stream && cam.stream.getVideoTracks()[0], st = tr && tr.getSettings ? tr.getSettings() : {};
      o.label = (tr && tr.label) || ''; o.w = st.width; o.h = st.height; o.zoom = st.zoom; o.focus = st.focusMode;
    } catch (e) { /* ignore */ }
    return L.diagLine(o);
  }
  /** show / hide the one-line diagnostic and keep it fresh once a second while the scan sheet is open */
  function diagSet(on) {
    var box = $('scanDiag'); if (!box) return;
    box.hidden = !on; clearTimeout(diagTick);
    if (on) { var tickD = function () { if ($('scan').hidden || box.hidden) return; box.textContent = diagText(); diagTick = setTimeout(tickD, 1000); }; tickD(); }
  }
  function wireDiag() {
    var t = $('scanTitle'), box = $('scanDiag'); if (!t || !box) return;
    var show = function () { diagSet(box.hidden); };
    var down = function () { clearTimeout(diagTimer); diagTimer = setTimeout(show, 700); }, up = function () { clearTimeout(diagTimer); };
    ['touchstart', 'mousedown'].forEach(function (n) { t.addEventListener(n, down); });
    ['touchend', 'touchcancel', 'touchmove', 'mouseup', 'mouseleave'].forEach(function (n) { t.addEventListener(n, up); });
  }
  var PHOTO_FAIL = 'อ่านบาร์โค้ดจากรูปไม่ได้ — ลองถ่ายใกล้ขึ้น หรือพิมพ์รหัส';
  var photoDecoding = false;   // a photo is being decoded: nothing may start the live camera until decodePhoto has called back
  /** photo of a barcode -> text, decoded on the phone. cb(text) or cb('', thaiReason) - called EXACTLY once, whatever happens (bad image, no memory, no library, 30 s timeout); photoDecoding is cleared right before that call.
   *  Views come from L.photoViewPlan: centre band, tiles and the 2000 px whole picture at NATIVE detail, then turned / inverted, time-boxed (L.PHOTO_BUDGET_MS), yielding to the page between views. */
  function decodePhoto(file, cb) {
    var done = false, url = '', timer = null, img = null;
    photoDecoding = true;
    var fin = function (t, why) {
      if (done) return; done = true; clearTimeout(timer); photoDecoding = false;
      if (img) { img.onload = img.onerror = null; }
      if (url) { try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ } }
      try { cb(t || '', t ? undefined : (why || PHOTO_FAIL)); } catch (e2) { /* the caller's problem; never rethrow into the event loop */ }
      // the scan sheet was opened while this (other) decode ran and shows 'busy': its own handler already settled the display if it started this decode, so a busy still showing is stale
      try { if (!$('scan').hidden && !$('scanBusy').hidden) { photoUi(''); resumeScanCam(); } } catch (e3) { /* ignore */ }
    };
    try {
      timer = setTimeout(function () { fin('', PHOTO_FAIL); }, 30000);
      url = URL.createObjectURL(file); img = new Image();
      img.onload = function () { try { photoViews(img, fin, function () { return done; }); } catch (e) { fin('', PHOTO_FAIL); } };
      img.onerror = function () { fin('', PHOTO_FAIL); };
      img.src = url;
    } catch (e) { fin('', PHOTO_FAIL); }
  }
  /** draws one planned view of the picture onto a new canvas (rotated when asked) */
  function photoCanvas(img, v) {
    var c = document.createElement('canvas'), x;
    c.width = v.rot ? v.dh : v.dw; c.height = v.rot ? v.dw : v.dh;
    try { x = c.getContext('2d', { willReadFrequently: true }); } catch (e) { x = c.getContext('2d'); }
    if (v.rot === 90) { x.translate(c.width, 0); x.rotate(Math.PI / 2); } else if (v.rot === 270) { x.translate(0, c.height); x.rotate(-Math.PI / 2); }
    x.drawImage(img, v.sx, v.sy, v.sw, v.sh, 0, 0, v.dw, v.dh);
    return c;
  }
  function photoViews(img, fin, isDone) {
    isDone = isDone || function () { return false; };
    var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height, t0 = Date.now();
    var plan = L.photoViewPlan(iw, ih), det = makeDetector(L.ONE_D_NATIVE.concat(['qr_code'])), Z = null, i = 0;
    var next = function () { setTimeout(step, 0); };
    var release = function (c) { try { c.width = c.height = 0; } catch (e) { /* ignore */ } };
    var qrPass = function () {
      if (isDone()) return;
      // no 1D barcode in any view: a QR (link) is better than nothing, so the caller can say "that is not a part code"
      try {
        var wv = plan.filter(function (v) { return v.tag === 'whole'; })[0] || plan[0], c = photoCanvas(img, wv), t = Z ? L.zxDecodeSource(Z, new Z.HTMLCanvasElementLuminanceSource(c), L.zxHints(Z, true)) : '';
        release(c); fin(t, PHOTO_FAIL);
      } catch (e) { fin('', PHOTO_FAIL); }
    };
    var step = function () {
      if (isDone()) return;   // the 30 s timeout already answered: stop working
      if (i >= plan.length || Date.now() - t0 > L.PHOTO_BUDGET_MS) { qrPass(); return; }   // time-boxed: the view count alone is not a bound on a slow phone
      var v = plan[i++], c;
      try { c = photoCanvas(img, v); } catch (e) { next(); return; }
      var viaZX = function () {
        var t = '';
        try { if (Z) t = L.zxDecodeSource(Z, new Z.HTMLCanvasElementLuminanceSource(c), L.zxHints(Z, false), v.inv); } catch (e) { t = ''; }
        release(c); if (t) fin(t); else next();
      };
      if (det && !v.inv) { try { det.detect(c).then(function (r) { var t = L.preferOneD(r); if (t) { release(c); fin(t); } else viaZX(); }, viaZX); } catch (e) { viaZX(); } }
      else viaZX();
    };
    var started = false, begin = function (ok) {
      if (started) return; started = true;
      if (!ok && !det) { fin('', 'โหลดตัวอ่านบาร์โค้ดไม่ได้ (ตรวจอินเทอร์เน็ต) พิมพ์รหัสแทน'); return; }
      Z = ok ? window.ZXing : null; step();   // no ZXing but a native detector: the plan runs native-only (inverted views and the QR pass are skipped / empty, the failure text is the ordinary one)
    };
    loadZXing(begin, function () { begin(!!window.ZXing); });   // a photo does not wait out a slow download (the live camera does): after 13 s it goes on without the library
  }
  var NOT_A_PART = 'อ่านได้ แต่ไม่ใช่รหัสอะไหล่ (เช่น QR / ลิงก์) ถ่ายให้เห็นบาร์โค้ดแท่ง หรือพิมพ์รหัสแทน';

  /* ---------------- daily random count (same app, same queue) ---------------- */
  function renderDaily() {
    var page = D, top = $('dTop'), list = $('dList'); clear(top); clear(list);
    renderSbD();
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
  /** Phone photo -> JPEG data URL, longest edge <= 1280 px, quality 0.7, made smaller step by step until about 250 KB. null when the picture cannot be read. */
  function shrinkPhoto(file, cb) {
    var url = null, img = new Image();
    try { url = URL.createObjectURL(file); } catch (e) { cb(null); return; }
    img.onload = function () {
      var data = null;
      try {
        for (var i = 0; i < L.PHOTO_PLANS.length; i++) {
          var pl = L.photoPlan(img.width, img.height, i), c = document.createElement('canvas');
          c.width = pl.w; c.height = pl.h; c.getContext('2d').drawImage(img, 0, 0, pl.w, pl.h);
          data = c.toDataURL('image/jpeg', pl.q);
          if (data.length <= L.PHOTO_MAX_CHARS) break;
        }
      } catch (e) { data = null; }
      if (typeof data !== 'string' || data.length < 1000 || data.indexOf('data:image/jpeg') !== 0) data = null;   // a blank or non-JPEG canvas result (some browsers return 'data:,' or a PNG) is a failure, never a photo
      try { URL.revokeObjectURL(url); } catch (e2) { /* ignore */ }
      cb(data);
    };
    img.onerror = function () { try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ } cb(null); };
    img.src = url;
  }
  function dailyCard(it) {
    var c = el('div', 'card stack', ''), pf = prefill[it.id] || {}, st = draft[it.id];
    if (!st) { st = draft[it.id] = { photo: null, lastModified: 0, crates: '', per: '', loose: '', foundAt: '' };
      if (pf.answer) { st.crates = String(pf.answer.crates || ''); st.per = String(pf.answer.perCrate || ''); st.loose = String(pf.answer.loose || (pf.answer.qty !== undefined ? pf.answer.qty : '')); }   // (an answer queued by the older page was a plain quantity)
      st.foundAt = pf.foundAt || ''; }
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
    crates.value = st.crates; per.value = st.per; loose.value = st.loose;
    total = el('div', 'total', 'รวม 0 ชิ้น'); c.appendChild(total);
    var recalc = function () { total.textContent = 'รวม ' + ((+crates.value || 0) * (+per.value || 0) + (+loose.value || 0)) + ' ชิ้น'; };
    [crates, per, loose].forEach(function (i) { i.addEventListener('input', function () { st.crates = crates.value; st.per = per.value; st.loose = loose.value; recalc(); }); }); recalc();

    var fld = el('div', 'field'); c.appendChild(fld);
    var pick = el('label', 'fbtn tint wide', ''); pick.appendChild(ic('camera')); var pl = el('span', '', 'ถ่ายรูป'); pick.appendChild(pl); fld.appendChild(pick);
    var file = el('input'); file.type = 'file'; file.accept = 'image/*'; file.setAttribute('capture', 'environment'); file.style.position = 'absolute'; file.style.left = '-9999px'; pick.appendChild(file);
    var prev = el('img', 'photo-prev'); prev.alt = ''; fld.appendChild(prev);
    var foundAt = el('input'); foundAt.type = 'text'; foundAt.maxLength = 80; foundAt.value = st.foundAt; foundAt.addEventListener('input', function () { st.foundAt = foundAt.value; });
    foundAt.setAttribute('aria-label', 'เจอที่ไหนบ้าง');
    var fof = el('div', 'of'); fof.appendChild(foundAt); foundAt.placeholder = 'เจอที่ไหนบ้าง (จำเป็นถ้านับได้มากกว่า 0)'; c.appendChild(fof);
    var err = el('div', 'msg err'); err.hidden = true; c.appendChild(err);
    function showErr(t) { err.textContent = t; err.hidden = !t; }
    if (pf.err) showErr(pf.err);
    var send = btn('pbtn', 'ส่งรายการนี้'); c.appendChild(send);
    if (st.photo) { prev.src = st.photo; prev.style.display = 'block'; pl.textContent = 'ถ่ายใหม่'; }
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
    $('locPick').addEventListener('change', function () {
      if (card && M && M.loc && this.value !== M.loc) { this.value = M.loc; toast('บันทึกหรือกลับก่อน'); return; }   // an open card (pieces, unknown photo + draft) is never thrown away by a place switch
      switchLoc(this.value, false);
    });   // v7: a roaming person goes to another location: a fresh list from the server for it
    $('scanBtn').addEventListener('click', openScan);
    $('scanClose').addEventListener('click', closeScan);
    try { wireDiag(); } catch (eD) { /* diagnostics are optional */ }
    $('scanFile').addEventListener('click', function () { pickerOpen = true; camStop(); });   // iOS: the live camera must be off before the photo picker opens
    $('scanFile').addEventListener('cancel', function () { pickerOpen = false; resumeScanCam(); });
    $('scanFile').addEventListener('change', function () {
      var inp = this, f = inp.files && inp.files[0]; pickerOpen = false;
      if (!f) { inp.value = ''; resumeScanCam(); return; }
      if (photoDecoding) { inp.value = ''; $('scanNote').textContent = 'กำลังอ่านรูปก่อนหน้า…'; return; }   // one photo at a time
      camStop(); photoUi('busy'); $('scanNote').textContent = 'เล็งบาร์โค้ดให้อยู่ในกรอบ';
      var mySession = scanSession;
      decodePhoto(f, function (text, why) {
        inp.value = '';
        if (mySession !== scanSession) { if (!$('scan').hidden && !document.hidden) { photoUi(''); startScanCam(); } return; }   // the sheet was closed / reopened while the picture was being read: drop the result
        if ($('scan').hidden) return;
        var k = text ? L.readClass(text, M) : null;
        if (k && k.kind === 'plausible') { text = bestRead(k); photoUi(''); camStop(); $('scan').hidden = true; beep(); buzz(60); lookup(text, true); syncLayer(); drawInstall(); }
        else { photoUi('fail'); $('scanNote').textContent = text ? (/:\/\/|www\./i.test(text) ? NOT_A_PART : L.rejectMsg(text)) : (why || PHOTO_FAIL); }   // stay on the sheet: the live camera is NOT restarted under the message
      });
    });
    $('scanRetake').addEventListener('click', function () { $('scanFile').click(); });   // a new photo
    $('scanLive').addEventListener('click', function () { startScanCam(); });             // the person chose the live camera again
    $('tabFirst').addEventListener('click', function () { ST.tab = 'first'; ST.shelf = ''; renderChips(); renderList(); });
    $('tabSecond').addEventListener('click', function () { ST.tab = 'second'; ST.shelf = ''; renderChips(); renderList(); });
    $('scanBackdrop').addEventListener('click', closeScan);   // same as the X button
    $('uncHead').addEventListener('click', function () { ST.expanded = !ST.expanded; renderList(); });   // collapse / expand the uncounted list (presentation only)
    $('codeGo').addEventListener('click', goCode);
    $('codeIn').addEventListener('input', function () { sugHint = false; renderSug(); });
    $('codeIn').addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); goCode(); } });
    $('shelfSel').addEventListener('change', function () { ST.shelf = this.value; renderList(); });
    $('q').addEventListener('input', function () { ST.q = this.value; renderList(); });
    $('showDone').addEventListener('change', function () { ST.showDone = this.checked; renderList(); });
    $('refresh').addEventListener('click', function () { if (refreshBusy) return; if (!card) { refreshSpin(true); doSync(true); } else toast('บันทึกหรือกลับก่อน แล้วค่อยรีเฟรช'); });
    $('qbadge').addEventListener('click', function () { if (Q.length) { Q.forEach(function (e) { e.next = 0; }); pump(); toast('กำลังลองส่งใหม่'); } });
    // the camera must never stay on: closed with the scan sheet, and whenever the page is hidden or left
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { camStop(); return; }
      geoCheck();
      if (!$('scan').hidden && pickerOpen) { pump(); setTimeout(function () { if (pickerOpen) { pickerOpen = false; resumeScanCam(); } }, 2500); return; }   // back from the photo picker: the picture's change event follows (do not restart the camera under the decode); if none comes (cancel not reported), restart anyway
      if (!$('scan').hidden) { if ($('scanFail').hidden) startScanCam(); pump(); return; }   // the viewfinder went black while the page was hidden (not while a photo failure message waits for the person; startScanCam itself refuses while a photo is being read)
      if (card) { if (!card.unknown && card.mode === 'scan' && !card.camMsg && !card.locked) drawCard(); return; }
      if (verified && Date.now() - loadedAt > 60000) doSync(false);
      pump();
    });
    window.addEventListener('pagehide', camStop);
    window.addEventListener('popstate', onLayerPop);
    window.addEventListener('storage', onQueueStorage);   // a second window of this link wrote the queue: take over its new entries (see mergeStored)
    // another link opened in this tab (a shared phone): ALWAYS start over with it. If the waiting saves exist only in memory (no storage), nothing may be lost:
    // the app is hidden ("รอส่งข้อมูลให้เสร็จก่อน") until they are sent, then the page reloads.
    // Saves waiting under the OLD link are sent first too when storage works (otherwise they would sit in sc5.q.<oldToken> and nobody would ever send them). Only when they cannot be sent now
    // (no accepted PIN in this page: the pad / offline) the page reloads at once and the start-up note tells the person that counts of another link are still unsent.
    window.addEventListener('hashchange', function () {
      if (Q.length && !(verified && !paused) && (noStore || memOnlyPhotos())) { keepOldLink(); return; }   // the pad is showing and the waiting saves live only in memory: nothing can be sent now and a reload would lose them - stay on the OLD link (a wait screen here would never end)
      if (Q.length && verified && !paused) {
        reloadWhenEmpty = true;
        try { bioOfferClose(); } catch (e) { /* fine */ }
        try { if (!$('scan').hidden) closeScan(); } catch (e) { /* fine */ }
        try { closeSettings(); } catch (e) { /* fine */ }
        try { camStop(); backHome(); } catch (e) { /* fine */ }   // no open card / scan sheet / Face ID offer of the OLD link behind the wait screen
        $('app').hidden = true; $('pad').hidden = true; $('xwarn').hidden = true; $('waitq').hidden = false; drawInstall();
        waitFrom = Date.now();
        reloadWatch();   // (a path that empties the queue without going through sent() still ends the wait)
        Q.forEach(function (e) { e.next = 0; }); pump();
        return;
      }
      reloading = true; location.reload();
    });
    window.addEventListener('online', function () { Q.forEach(function (e) { e.next = 0; }); pump(); });
    window.addEventListener('beforeunload', function (ev) { if (Q.length && !reloading) { ev.preventDefault(); ev.returnValue = ''; return ''; } });
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

  /* ---- "add to home screen" pop-up (iPhone + Android): one card, never when already installed ---- */
  var installEvt = null;
  function isStandalone() { try { return !!((window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone); } catch (e) { return false; } }
  /* A small card fixed at the bottom. One picture at a time, moves on by itself every 2.6 s (not with reduced motion), a tap = next. Android Chrome with the install offer: one big button instead. */
  var KA2 = 'sc5.a2hs', KINST = 'sc5.inst', a2Focus = false, a2Got = false, a2Later = false, a2Installed = false, a2Asking = false, a2I = 0, a2Kind = '', a2Timer = null;
  function a2Frames(kind) { var out = [], f, i = 1; while ((f = $('a2f-' + kind + '-' + i))) { out.push(f); i++; } return out; }
  function a2Reduced() { try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; } }
  function a2Stop() { if (a2Timer) { clearTimeout(a2Timer); a2Timer = null; } }
  function a2Show(k) {
    var steps = L.A2HS_STEPS[a2Kind]; if (!steps) return;
    a2I = k;
    a2Frames(a2Kind).forEach(function (f, j) { f.classList.toggle('on', j === k); });
    var dots = $('a2Nav').children; for (var i = 0; i < dots.length; i++) dots[i].classList.toggle('on', i === k);
    $('a2CapN').textContent = String(k + 1); $('a2CapT').textContent = steps[k];
    $('a2Point').className = 'a2pt' + (a2Kind === 'asamsung' ? ' r' : '');
    $('a2Point').hidden = !((a2Kind === 's26' || a2Kind === 'asamsung') && k === 0);   // the bouncing arrow DOWN toward the real ≡ in the bar below (left on iPhone, right on Samsung)
    $('a2PointUp').hidden = !(a2Kind === 'achrome' && k === 0);                       // Chrome: the arrow points UP at the real ⋮ at the top right
  }
  function a2Start(n) {
    if (a2Timer || n < 2 || a2Reduced()) return;
    a2Timer = setTimeout(function () { a2Timer = null; a2Show((a2I + 1) % n); a2Start(n); }, 2600);   // one step at a time (a chain of timeouts, no interval)
  }
  /** a text field has the keyboard: the card would cover what is being typed */
  function a2Typing() {
    if (!a2Focus) return false;
    try { var ae = document.activeElement; if (ae && ae.tagName && !/^(INPUT|SELECT|TEXTAREA)$/i.test(ae.tagName)) return false; } catch (e) { /* trust the flag */ }
    return true;
  }
  /** the page gets bottom padding as tall as the card (its real height + its offset + the safe area + 16 px) so the last row can scroll clear of it; the toast rides above it (--a2top). Cleared when the card is hidden. */
  function a2Pad(box, on) {
    try {
      var b = document.body; if (!b) return;
      if (b.classList) b.classList.toggle('a2on', on);
      var st = b.style; if (!st) return;
      if (!on) { st.paddingBottom = ''; if (st.removeProperty) st.removeProperty('--a2top'); return; }
      var h = Number(box.offsetHeight) || 300, off = box.classList.contains('a2hi') ? 72 : 12;
      st.paddingBottom = 'calc(env(safe-area-inset-bottom, 0px) + ' + Math.round(h + off + 16) + 'px)';
      if (st.setProperty) st.setProperty('--a2top', 'calc(env(safe-area-inset-bottom, 0px) + ' + Math.round(h + off + 10) + 'px)');
    } catch (e) { /* the card still works */ }
  }
  function drawA2hs() {
    var box = $('a2hs'); if (!box) return;
    var ua = navigator.userAgent, kind = L.installCardKind(ua, isStandalone(), navigator.maxTouchPoints, !!installEvt, store.get(KINST) === '1'), today = L.bkkDay(Date.now());
    var show = !!kind && !!T && !$('app').hidden && $('pad').hidden && $('card').hidden && $('scan').hidden && !settingsOpen && !a2Got && !a2Later && !a2Installed && store.get(KA2) !== today && !a2Typing();   // never over the PIN pad, a part card, the scan sheet, Settings, or while the keyboard is up
    box.hidden = !show;
    if (!show) { a2Pad(box, false); a2Stop(); return; }
    var android = kind.charAt(0) === 'a', one = kind === 'aone', steps = L.A2HS_STEPS[kind], queued = !android && Q.length > 0;   // Android installs share the browser's storage: no "send first" line there
    box.classList.toggle('a2hi', kind === 's26' || kind === 'asamsung');   // Safari 26 / Samsung: a floating bar sits at the bottom
    $('a2Title').textContent = L.A2HS_TITLE[kind] || L.A2HS_TITLE_DEFAULT;
    $('a2Queue').hidden = !queued;   // iPhone: unsent counts would be stranded, the home-screen app keeps its own storage
    $('a2One').hidden = !one;
    $('a2Text').hidden = queued || one || !!steps;
    $('a2Vis').hidden = queued || one || !steps;
    $('a2Note').hidden = android;    // "open the new icon and type the PIN again" is an iPhone thing
    $('a2Perm').hidden = !(android && (one || kind === 'achrome') && L.showPermHint(ua));
    $('a2Steps').textContent = steps && !queued ? steps.length + ' ขั้น' : '';
    if (!steps || queued) {
      a2Stop(); $('a2Point').hidden = true; $('a2PointUp').hidden = true;
      if (!queued && !one) $('a2Text').textContent = L.A2HS_TEXT[kind];
      a2Pad(box, true); return;
    }
    if (a2Kind !== kind) {   // first time (or another browser kind): build the dots
      a2Kind = kind; a2I = 0;
      var nav = $('a2Nav'); while (nav.firstChild) nav.removeChild(nav.firstChild);
      steps.forEach(function (_, k) {
        var b = document.createElement('button'); b.type = 'button'; b.setAttribute('aria-label', 'ขั้นที่ ' + (k + 1));
        b.addEventListener('click', function () { a2Show(k); a2Stop(); a2Start(steps.length); });
        nav.appendChild(b);
      });
      ['s26', 's18', 'cr', 'achrome', 'asamsung'].forEach(function (g) { var e = $('a2g-' + g); if (e) e.hidden = g !== kind; });
    }
    a2Show(a2I); a2Start(steps.length); a2Pad(box, true);
  }
  function drawInstall() { try { drawA2hs(); } catch (e) { /* the app works without it */ } }
  function wireInstall() {
    if (isStandalone()) store.set(KINST, '1');   // running as the installed app: remember it (Android shares this storage with Chrome, so a normal Chrome tab later knows too)
    window.addEventListener('beforeinstallprompt', function (e) {
      // keep Chrome's own install offer unless OUR card will really show (not on desktop / LINE / installed, not after ไว้ทีหลัง today or เข้าใจแล้ว)
      var ours = !!L.installCardKind(navigator.userAgent, isStandalone(), navigator.maxTouchPoints, true, false) && !a2Got && !a2Later && !a2Installed && store.get(KA2) !== L.bkkDay(Date.now());
      if (ours && e.preventDefault) e.preventDefault();
      installEvt = e; store.del(KINST);   // an install offer means the app is NOT installed (any more)
      drawInstall();
    });
    window.addEventListener('appinstalled', function () { installEvt = null; a2Installed = true; store.set(KINST, '1'); drawInstall(); });
    if ($('a2Install')) $('a2Install').addEventListener('click', function () {
      var ev = installEvt; if (!ev || !ev.prompt || a2Asking) return;
      a2Asking = true;
      var over = false, gone = function (ok) {   // once only; a prompt can be used once: accepted -> hide; dismissed / failed -> the menu steps take over
        if (over) return; over = true; a2Asking = false;
        if (installEvt === ev) installEvt = null;
        if (ok) { a2Installed = true; store.set(KINST, '1'); }
        drawInstall();
      };
      try {
        var p = ev.prompt();
        if (p && typeof p.then === 'function') p.then(null, function () { gone(false); });   // a refused prompt() must not leave the button frozen
        Promise.resolve(ev.userChoice || p).then(function (c) { gone(!!(c && c.outcome === 'accepted')); }, function () { gone(false); });
      } catch (e) { gone(false); }
    });
    if ($('a2Ill')) {
      var a2Next = function () { var st = L.A2HS_STEPS[a2Kind]; if (!st) return; a2Show((a2I + 1) % st.length); a2Stop(); a2Start(st.length); };
      $('a2Ill').addEventListener('click', a2Next);
      $('a2Ill').addEventListener('keydown', function (e) { if (e && (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar')) { if (e.preventDefault) e.preventDefault(); a2Next(); } });
      document.addEventListener('focusin', function (e) { var t = e && e.target; a2Focus = !!(t && /^(INPUT|SELECT|TEXTAREA)$/i.test(t.tagName || '') && !/^(checkbox|radio|button|submit|file|range)$/i.test(t.type || '')); drawInstall(); });
      document.addEventListener('focusout', function () { a2Focus = false; drawInstall(); });
      window.addEventListener('resize', function () { drawInstall(); });
      $('a2Later').addEventListener('click', function () { a2Later = true; store.set(KA2, L.bkkDay(Date.now())); drawInstall(); });   // hidden until tomorrow (Bangkok date); this page load too if storage refuses
      $('a2Got').addEventListener('click', function () { a2Got = true; drawInstall(); });   // hidden for this page load only
    }
    try { if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { scope: './' }).catch(function () { /* the app works without it */ }); } catch (e) { /* fine */ }
    drawInstall();
  }
  function start() {
    // LINE (Android) can hand the link to the real browser: try once; the query string stops a loop, the #hash is kept
    try { if (L.isLineAndroid(navigator.userAgent) && typeof location.replace === 'function' && !/[?&]openExternalBrowser=/.test(String(location.href).split('#')[0])) { location.replace(location.pathname + '?openExternalBrowser=1' + location.hash); return; } } catch (e) { /* stay here */ }
    applyFont(); loadFonts(); watchSheet();
    try { wireInstall(); } catch (e) { /* the app works without it */ }
    if (L.isLineBrowser(navigator.userAgent)) $('linebanner').hidden = false;   // LINE's in-app browser cannot use the camera
    if (!T) { $('nolink').textContent = 'เปิดแอปจากลิงก์ที่ได้รับครั้งแรก 1 ครั้ง แล้วจึงเพิ่มไปที่หน้าจอโฮม'; $('nolink').hidden = false; return; }
    buildKeys(); wire(); wireSettings(); bioInit();
    $('padBack').addEventListener('click', function () { if (setMode !== 'confirm') return; firstPin = ''; setMode = 'enter'; padBuf = ''; drawDots(); drawSetMode(); $('padMsg').textContent = ''; });
    var all = L.qParse(store.get(KQ), T.t);
    lostList = all.filter(function (e) { return e.lostPhoto; });
    Q = all.filter(function (e) { return !e.lostPhoto; });
    if (lostList.length) persistQ();
    try { if (L.otherQueueTokens(store.keys(), T.t, function (k) { return store.get(k); }).length) notes.push({ id: 'otherq', kind: 'info', text: 'เครื่องนี้มีการนับที่ยังไม่ได้ส่งจากลิงก์อื่น กรุณาเปิดลิงก์เดิมของงานนั้นเพื่อส่งให้เสร็จ' }); } catch (e) { /* no note: fine */ }
    try { var raw = store.get(KL); cachedBoot = raw ? JSON.parse(raw) : null; } catch (e) { cachedBoot = null; }
    // a link to ANOTHER deployment than the one this phone used before: a red warning, no pad (nothing is sent), until a deliberate second tap
    if (L.checkExec(store.get(KX), T.x) === 'differs') {
      cachedBoot = null; $('xwarn').hidden = false;
      var go = $('xgo'), confirmed = false;
      go.addEventListener('click', function () {
        if (!confirmed) { confirmed = true; go.textContent = 'แตะอีกครั้งเฉพาะเมื่อเจ้าของส่งลิงก์นี้ให้คุณจริงๆ'; return; }
        $('xwarn').hidden = true; showPad('', false); probe(); bioAuto();
      });
      return;
    }
    showPad('', false);
    probe();
    bioAuto();
  }
  start();
})();
