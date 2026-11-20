/* bollineni.co sync kit: one link for every app on the site, on every device, with no account.

   A person turns sync on once, on any device, in any app. That device gets a sync code, and the
   code is kept for the whole site (localStorage on bollineni.co, which every app shares), so every
   app on the device starts syncing at once. To add another device they scan a QR code, share a
   link (bollineni.co/#link=CODE: the part after # never reaches a server), or type the code.

   From the code the browser derives an id (what the server stores saves under) and a key (which
   never leaves the device), the same way Gridline always has, so codes made in Gridline keep
   working everywhere. Each app's save is a small document of collections: every item carries the
   time it last changed, two devices' documents merge item by item with the later change winning,
   and a deleted item leaves a marker so the deletion wins too.

   Files (Loom's photos and PDFs) travel separately, in encrypted parts. Each file gets its own
   random key and name when it is first synced, kept inside the app's encrypted save, so changing
   the code re-encrypts only the saves and every file stays readable.

   Pages load this from /sync/kit.js. Where it doesn't exist (an app opened on its own, a Mac app),
   window.BollineniSync is never defined and the apps leave sync out. */
(function (root) {
  'use strict';
  if (root.BollineniSync) return;

  const webcrypto = root.crypto;
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O or U
  const CODE_LENGTH = 25; // 125 random bits
  const DAY = 86400000;
  const MARKER_DAYS = 90;
  const SITE_KEY = 'bollineni:sync';
  const DEVICE_KEY = 'bollineni:device';
  const TOUCH_KEY = 'bollineni:sync:touched';
  const BASE = '/sync/api/';
  const APP_NAMES = { site: 'This site', gridline: 'Gridline', loom: 'Loom', palimpsest: 'Palimpsest', ballast: 'Ballast' };

  /* ---------- Codes and crypto (identical to Gridline's js/sync.js) ---------- */

  function newCode() {
    const bytes = webcrypto.getRandomValues(new Uint8Array(CODE_LENGTH));
    return Array.from(bytes, (b) => ALPHABET[b & 31]).join('');
  }
  // Accepts a code however it was typed, or a whole link with the code in it.
  function normalizeCode(text) {
    let t = String(text || '');
    const m = /#link=([0-9A-Za-z-]+)/.exec(t);
    if (m) t = m[1];
    const c = t.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
    return c.length === CODE_LENGTH && [...c].every((ch) => ALPHABET.includes(ch)) ? c : null;
  }
  const formatCode = (code) => String(code || '').replace(/(.{5})(?=.)/g, '$1-');
  const utf8 = (s) => new TextEncoder().encode(s);
  const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  function toBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const fromBase64 = (text) => Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));

  const derived = new Map();
  function derive(code) {
    if (derived.has(code)) return derived.get(code);
    const p = (async () => {
      const subtle = webcrypto.subtle;
      const material = await subtle.importKey('raw', utf8(code), 'HKDF', false, ['deriveBits', 'deriveKey']);
      const params = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: utf8('bollineni-sync'), info: utf8(info) });
      const id = hex(await subtle.deriveBits(params('id/v1'), material, 256));
      const key = await subtle.deriveKey(params('key/v1'), material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      return { id, key };
    })();
    derived.set(code, p);
    p.catch(() => derived.delete(code));
    return p;
  }
  async function sealBytes(key, bytes) {
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
    const out = new Uint8Array(iv.length + sealed.length);
    out.set(iv);
    out.set(sealed, iv.length);
    return toBase64(out);
  }
  async function openBytes(key, payload) {
    const bytes = fromBase64(payload);
    return new Uint8Array(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, key, bytes.subarray(12)));
  }
  const seal = (key, value) => sealBytes(key, utf8(JSON.stringify(value)));
  const open = async (key, payload) => JSON.parse(new TextDecoder().decode(await openBytes(key, payload)));

  /* ---------- Storage for each app's sync state (IndexedDB: a library can be megabytes) ---------- */

  const idb = (() => {
    let dbp = null;
    const db = () => dbp || (dbp = new Promise((res, rej) => {
      const r = indexedDB.open('bollineni-sync', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('meta');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
    const tx = async (mode, fn) => {
      const d = await db();
      return new Promise((res, rej) => {
        const t = d.transaction('meta', mode);
        const req = fn(t.objectStore('meta'));
        t.oncomplete = () => res(req && req.result);
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error);
      });
    };
    return {
      get: (k) => tx('readonly', (s) => s.get(k)).catch(() => null),
      set: (k, v) => tx('readwrite', (s) => s.put(v, k)).catch(() => {}),
      remove: (k) => tx('readwrite', (s) => s.delete(k)).catch(() => {}),
    };
  })();

  /* ---------- This device, and the code it is linked with ---------- */

  const ls = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
    set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };

  function guessDeviceName() {
    const ua = navigator.userAgent || '';
    const touch = navigator.maxTouchPoints > 1;
    const kind = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (/Macintosh/.test(ua) && touch) ? 'iPad'
      : /Android/.test(ua) ? (/Mobile/.test(ua) ? 'Android phone' : 'Android tablet')
      : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : 'Device';
    const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) || /FxiOS/.test(ua) ? 'Firefox'
      : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
    return browser ? `${kind} · ${browser}` : kind;
  }
  function device() {
    let d = ls.get(DEVICE_KEY);
    if (!d || typeof d.id !== 'string' || !/^[0-9a-f]{32}$/.test(d.id)) {
      d = { id: hex(webcrypto.getRandomValues(new Uint8Array(16))), name: guessDeviceName(), apps: [] };
      ls.set(DEVICE_KEY, d);
    }
    if (!Array.isArray(d.apps)) d.apps = [];
    return d;
  }

  const siteListeners = new Set();
  const inPage = typeof document !== 'undefined' && !!root.addEventListener;
  // Other tabs hear about a new code through the storage event; frames of this page through the channel.
  const channel = inPage && 'BroadcastChannel' in root ? new BroadcastChannel('bollineni-sync') : null;
  const fireSite = () => siteListeners.forEach((fn) => { try { fn(); } catch (e) { /* listener's own problem */ } });
  if (inPage) root.addEventListener('storage', (e) => { if (e.key === SITE_KEY || e.key === null) fireSite(); });
  if (channel) channel.onmessage = (e) => { if (e.data === 'site') fireSite(); };

  const site = {
    code() { const s = ls.get(SITE_KEY); return s && normalizeCode(s.code) ? s.code : null; },
    set(code, why) {
      ls.set(SITE_KEY, { code, at: Date.now(), why: why || 'link' });
      ls.set(TOUCH_KEY, null);
      fireSite();
      if (channel) channel.postMessage('site');
    },
    clear() { ls.set(SITE_KEY, null); fireSite(); if (channel) channel.postMessage('site'); },
    onChange(fn) { siteListeners.add(fn); return () => siteListeners.delete(fn); },
    linkUrl(code) { return `${location.origin}/#link=${formatCode(code || site.code())}`; },
    device,
    // Notes that an app is used on this device, for the device list (Gridline keeps its own engine).
    uses(app) {
      const d = device();
      if (!d.apps.includes(app)) { d.apps.push(app); ls.set(DEVICE_KEY, d); ls.set(TOUCH_KEY, null); }
      touchDevice();
    },
    rename(name) { const d = device(); d.name = String(name || '').trim().slice(0, 40) || guessDeviceName(); ls.set(DEVICE_KEY, d); ls.set(TOUCH_KEY, null); },
  };

  /* ---------- The server ---------- */

  const failure = (reason, message) => Object.assign(new Error(message), { reason });
  const MESSAGES = {
    code: 'That isn’t a sync code. It has 25 letters and digits.',
    empty: 'Nothing is synced under that code yet. Check it against your other device.',
    erased: 'Sync was turned off from another device. Everything is still saved here.',
    unreadable: 'The synced copy couldn’t be read with this code.',
    rate_limited: 'Too many requests. Sync will try again shortly.',
    offline: 'Couldn’t reach sync. It will try again.',
    too_large: 'There’s too much to sync.',
  };

  let statusP = null;
  function available() {
    if (!statusP) {
      statusP = fetch(BASE + 'status', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => (d && d.sync ? { apps: d.apps || [], parts: d.parts || [] } : null))
        .catch(() => null);
      statusP.then((s) => { if (!s) statusP = null; });
    }
    return statusP;
  }

  async function request(code, method, route, body) {
    const { id } = await derive(code);
    let r;
    try {
      r = await fetch(BASE + route, {
        method,
        headers: Object.assign({ Authorization: 'Bearer ' + id }, body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        // A small save can outlive the page that sent it (leaving, or locking the phone).
        keepalive: !!body && JSON.stringify(body).length < 60000,
      });
    } catch (e) { throw failure('offline', MESSAGES.offline); }
    const data = await r.json().catch(() => null);
    if (r.ok || r.status === 404 || r.status === 409) return { status: r.status, data: data || {} };
    const reason = (data && data.reason) || 'offline';
    throw failure(reason, MESSAGES[reason] || MESSAGES.offline);
  }
  // The decrypted document an app has saved under a code, or null.
  async function readDoc(code, app) {
    const r = await request(code, 'GET', app);
    if (r.status !== 200) return null;
    try { return { doc: await open((await derive(code)).key, r.data.payload), version: r.data.version }; } catch (e) { throw failure('unreadable', MESSAGES.unreadable); }
  }

  /* ---------- Documents ---------- */

  const emptyDoc = () => ({ v: 1, c: {} });
  function canonical(v) {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
    return v;
  }
  const json = (v) => JSON.stringify(canonical(v));
  const same = (a, b) => json(a) === json(b);
  const kept = (map) => Object.keys(map || {}).filter((id) => !map[id].x);

  // Records in the document what changed on this device between two snapshots ({ collection:
  // { id: value } }). With no earlier snapshot the device is syncing for the first time: items in a
  // collection marked `first: 'keep'` join the others' (time 1), and the rest (settings) give way
  // to what is already synced (time 0).
  function stamp(doc, before, after, now, cols) {
    let changed = false;
    const first = !before;
    for (const name of Object.keys(cols)) {
      const map = doc.c[name] || (doc.c[name] = {});
      const was = (before && before[name]) || {};
      const is = after[name] || {};
      const firstT = cols[name].first === 'keep' ? 1 : 0;
      for (const [id, value] of Object.entries(is)) {
        if (first ? !map[id] : !(id in was) || json(was[id]) !== json(value)) { map[id] = { d: value, t: first ? firstT : now }; changed = true; }
      }
      if (!first) for (const id of Object.keys(was)) if (!(id in is)) { map[id] = { x: 1, t: now }; changed = true; }
    }
    return changed;
  }
  function merge(local, remote, now) {
    const out = emptyDoc();
    const later = (a, b) => (!b ? a : !a ? b : a.t > b.t ? a : b);
    const lc = (local && local.c) || {}, rc = (remote && remote.c) || {};
    for (const name of new Set([...Object.keys(lc), ...Object.keys(rc)])) {
      const mine = lc[name] || {}, theirs = rc[name] || {};
      const map = (out.c[name] = {});
      for (const id of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
        const e = later(mine[id], theirs[id]);
        if (!e || typeof e !== 'object' || !Number.isFinite(e.t)) continue;
        if (e.x && now - e.t > MARKER_DAYS * DAY) continue;
        map[id] = e;
      }
    }
    return out;
  }
  const BAD_KEY = (k) => k === '__proto__' || k === 'constructor' || k === 'prototype';
  // What a document says each collection holds, through the app's `clean` (anything arriving was
  // written by whoever holds the code, so the app checks every value).
  function view(doc, cols, clean) {
    const out = {};
    for (const name of Object.keys(cols)) {
      out[name] = {};
      const map = (doc.c && doc.c[name]) || {};
      for (const id of kept(map)) {
        if (BAD_KEY(id) || id.length > 200) continue;
        const v = clean ? clean(name, map[id].d, id) : map[id].d;
        if (v !== undefined && v !== null) out[name][id] = v;
      }
    }
    return out;
  }

  /* ---------- One app's sync ---------- */

  // o: { app, collections: { name: { first: 'keep' | 'remote' } }, read() -> snapshot,
  //      write(view) (async; makes the app match), clean(collection, value, id) -> value | null,
  //      onStatus(), onApplied(), onProblem(error), delay, maxPayload }
  function createEngine(o) {
    const now = () => Date.now();
    const metaKey = 'app:' + o.app;
    const cols = o.collections;
    let meta = null; // { code, version, doc, shadow, syncedAt, dirty }
    let phase = 'idle', problem = null, applying = 0, started = false, server = null, missed = false;
    let queue = Promise.resolve();
    let timer = null, pending = false;
    const listeners = new Set();

    const persist = () => (meta ? idb.set(metaKey, meta) : idb.remove(metaKey));
    const tell = (p, err) => { phase = p; problem = err || null; if (o.onStatus) o.onStatus(); listeners.forEach((fn) => fn()); };
    const status = () => ({ available: !!server, on: !!meta, code: meta ? formatCode(meta.code) : null, phase, problem, syncedAt: meta ? meta.syncedAt || null : null });
    const serial = (job) => { const run = queue.then(job, job); queue = run.catch(() => {}); return run; };

    function note() {
      const after = o.read();
      const changed = stamp(meta.doc, meta.shadow, after, now(), cols);
      meta.shadow = after;
      if (changed) meta.dirty = true;
      return changed;
    }
    async function fold(remote, version) {
      note();
      const merged = merge(meta.doc, remote, now());
      const shown = view(merged, cols, o.clean);
      let wrote = false;
      if (!same(shown, view(meta.doc, cols, o.clean)) || !meta.version) {
        applying++;
        missed = false;
        try { await o.write(shown); } finally { applying--; }
        wrote = true;
        if (o.onApplied) o.onApplied();
      }
      meta.doc = merged;
      meta.version = version;
      meta.dirty = !same(merged, remote);
      // A change made while the write ran was not recorded (changed() can't tell it from the
      // write's own). Compare against what was written, so it is stamped and sent, not taken as
      // already synced.
      if (wrote && missed) { missed = false; meta.shadow = shown; note(); }
      else meta.shadow = o.read();
    }
    async function push(tries) {
      const keys = await derive(meta.code);
      note();
      const payload = await seal(keys.key, meta.doc);
      if (payload.length > (o.maxPayload || 380000)) throw failure('too_large', MESSAGES.too_large);
      const sent = json(meta.doc);
      const r = await request(meta.code, 'PUT', o.app, { payload, base: meta.version || null });
      if (r.status === 200) {
        meta.version = r.data.version;
        meta.syncedAt = now();
        note();
        meta.dirty = json(meta.doc) !== sent;
        return;
      }
      if (r.status !== 409 || !r.data.current || tries <= 0) throw failure('offline', MESSAGES.offline);
      let remote;
      try { remote = await open(keys.key, r.data.current.payload); } catch (e) { throw failure('unreadable', MESSAGES.unreadable); }
      await fold(remote, r.data.current.version);
      if (meta.dirty) await push(tries - 1);
      else meta.syncedAt = now();
    }
    async function pull() {
      const keys = await derive(meta.code);
      const r = await request(meta.code, 'GET', o.app);
      if (r.status === 404) {
        // Synced before and now gone: erased from another device, or the code was changed there.
        if (meta.version) {
          const gone = meta.code;
          meta = null;
          if (site.code() === gone) site.clear();
          throw failure('erased', MESSAGES.erased);
        }
        return push(3);
      }
      if (r.data.version !== meta.version) {
        let remote;
        try { remote = await open(keys.key, r.data.payload); } catch (e) { throw failure('unreadable', MESSAGES.unreadable); }
        await fold(remote, r.data.version);
      } else note();
      if (meta.dirty) await push(3);
      else meta.syncedAt = now();
    }
    let retryIn = 0, retryTimer = null;
    function run(job) {
      return serial(async () => {
        if (!meta || !server) return;
        tell('syncing');
        try {
          await job();
          await persist();
          retryIn = 0; clearTimeout(retryTimer);
          tell('idle');
        } catch (e) {
          await persist();
          const shown = e && e.reason ? e : failure('offline', MESSAGES.offline);
          if (e && !e.reason) console.warn('sync', o.app, e);
          tell(shown.reason === 'erased' ? 'idle' : 'error', shown);
          if (o.onProblem) o.onProblem(shown);
          // Offline or rate-limited: try again by itself (15 s, doubling to 2 min) instead of
          // leaving this device's changes unsent until the page is next focused.
          if (meta && (shown.reason === 'offline' || shown.reason === 'rate_limited')) {
            retryIn = Math.min(retryIn ? retryIn * 2 : 15000, 120000);
            clearTimeout(retryTimer);
            retryTimer = setTimeout(() => { api.sync().catch(() => {}); }, retryIn);
          }
          throw shown;
        }
      });
    }
    // Makes this device's sync follow the site's code: start, move to a new code, or stop.
    function reconcile() {
      return serial(async () => {
        const code = site.code();
        if (!code) {
          if (meta) { meta = null; clearTimeout(timer); await persist(); tell('idle'); }
          return;
        }
        if (!meta) meta = { code, version: null, doc: emptyDoc(), shadow: null, syncedAt: null, dirty: true };
        else if (meta.code !== code) Object.assign(meta, { code, version: null, dirty: true });
        else return;
        await persist();
        tell('idle');
      }).then(() => (meta && server ? api.sync() : undefined));
    }
    function remember() {
      const d = device();
      // A new app on this device: check in again so the device list shows it.
      if (!d.apps.includes(o.app)) { d.apps.push(o.app); ls.set(DEVICE_KEY, d); ls.set(TOUCH_KEY, null); }
    }

    const api = {
      app: o.app,
      status,
      onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      async start() {
        if (started) return;
        started = true;
        meta = (await idb.get(metaKey)) || null;
        if (meta && !normalizeCode(meta.code)) meta = null;
        server = await available();
        if (server && !server.apps.includes(o.app)) server = null;
        tell(phase);
        if (!server) return;
        remember();
        site.onChange(() => { reconcile().catch(() => {}); });
        let last = 0;
        const go = () => {
          if (document.hidden || !meta || Date.now() - last < 30000) return;
          last = Date.now();
          api.sync().catch(() => {});
        };
        document.addEventListener('visibilitychange', go);
        root.addEventListener('focus', go);
        // Back online: send what was saved while offline right away. A background tab still
        // receives this, and go() would skip it while the document is hidden.
        root.addEventListener('online', () => {
          if (!meta) { last = 0; return; }
          last = Date.now();
          api.sync().catch(() => {});
        });
        setInterval(go, 60000);
        // Leaving the page or locking the phone: send a change still waiting out its delay now,
        // so it reaches the other devices without waiting for this one to be opened again.
        const flush = () => {
          if (!pending || !meta) return;
          clearTimeout(timer);
          pending = false;
          run(() => push(3)).catch(() => {});
        };
        document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
        root.addEventListener('pagehide', flush);
        await reconcile().catch(() => {});
        touchDevice();
        flushOthers().catch(() => {});
      },
      // The app calls this after every change to what it saves.
      changed() {
        if (!meta) return;
        if (applying) { missed = true; return; }
        if (!note()) return;
        persist();
        clearTimeout(timer);
        pending = true;
        timer = setTimeout(() => { pending = false; run(() => push(3)).catch(() => {}); }, o.delay == null ? 1500 : o.delay);
      },
      sync() { return meta ? run(pull) : Promise.resolve(); },
      // The document as last synced (for an app that keeps extra bookkeeping, like Loom's files).
      doc() { return meta ? meta.doc : null; },
      code() { return meta ? meta.code : null; },
    };
    return api;
  }

  /* ---------- Changes another app left unsent ---------- */

  // An app notes each change in its saved document before it sends it, so if it was closed first
  // (the phone locked, the tab switched) any page on the site can send it: the document is already
  // complete and encrypted here. If another device changed the same app meanwhile, it is left for
  // the app itself to merge the next time it opens.
  let flushedOthers = false;
  async function flushOthers() {
    if (flushedOthers) return;
    flushedOthers = true;
    const code = site.code();
    const s = await available();
    if (!code || !s) return;
    const running = new Set([...engines].map((e) => e.engine.app));
    for (const app of s.apps) {
      if (app === 'site' || app === 'gridline' || running.has(app)) continue;
      const meta = await idb.get('app:' + app);
      if (!meta || !meta.dirty || meta.code !== code || !meta.version) continue;
      try {
        const keys = await derive(code);
        const r = await request(code, 'PUT', app, { payload: await seal(keys.key, meta.doc), base: meta.version });
        if (r.status !== 200) continue;
        const now = (await idb.get('app:' + app)) || meta;
        if (now.version !== meta.version) continue; // the app itself saved meanwhile
        await idb.set('app:' + app, { ...now, version: r.data.version, dirty: false, syncedAt: Date.now() });
      } catch (e) { /* the app sends it when it next opens */ }
    }
  }

  /* ---------- Devices: the launcher's own small document ---------- */

  // Each device that is linked notes itself in the `site` save (at most once an hour), so the sync
  // panel can list them. Only its chosen name, when it was last seen, and which apps it uses.
  let touching = null;
  function touchDevice(force) {
    const code = site.code();
    if (!code || touching) return touching;
    const last = ls.get(TOUCH_KEY);
    if (!force && last && last.code === code && Date.now() - last.at < 3600000) return null;
    const d = device();
    touching = (async () => {
      const keys = await derive(code);
      for (let attempt = 0; attempt < 3; attempt++) {
        const found = await readDoc(code, 'site').catch(() => null);
        const doc = found ? found.doc : emptyDoc();
        if (!doc.c) doc.c = {};
        const devices = (doc.c.devices = doc.c.devices || {});
        devices[d.id] = { d: { name: d.name, seen: Math.floor(Date.now() / 60000) * 60000, apps: d.apps.slice(0, 10) }, t: Date.now() };
        const r = await request(code, 'PUT', 'site', { payload: await seal(keys.key, doc), base: found ? found.version : null });
        if (r.status === 200) { ls.set(TOUCH_KEY, { code, at: Date.now() }); return; }
        if (r.status !== 409) return;
      }
    })().catch(() => {}).finally(() => { touching = null; });
    return touching;
  }
  async function listDevices() {
    const code = site.code();
    if (!code) return [];
    await touchDevice();
    const found = await readDoc(code, 'site');
    const map = (found && found.doc.c && found.doc.c.devices) || {};
    const me = device().id;
    return kept(map).map((id) => {
      const d = map[id].d || {};
      return { id, me: id === me, name: typeof d.name === 'string' ? d.name.slice(0, 40) : 'Device', seen: Number(d.seen) || 0, apps: Array.isArray(d.apps) ? d.apps.filter((a) => APP_NAMES[a]) : [] };
    }).sort((a, b) => (b.me - a.me) || b.seen - a.seen);
  }
  async function forgetDevice(id) {
    const code = site.code();
    const keys = await derive(code);
    for (let attempt = 0; attempt < 3; attempt++) {
      const found = await readDoc(code, 'site');
      if (!found) return;
      const devices = (found.doc.c && found.doc.c.devices) || {};
      if (!devices[id]) return;
      devices[id] = { x: 1, t: Date.now() };
      const r = await request(code, 'PUT', 'site', { payload: await seal(keys.key, found.doc), base: found.version });
      if (r.status === 200) return;
    }
  }

  /* ---------- Turning sync on, linking, changing the code, erasing ---------- */

  async function turnOn() {
    if (site.code()) return site.code();
    if (!(await available())) throw failure('offline', 'Sync isn’t available on this site right now.');
    const code = newCode();
    site.set(code, 'new');
    await touchDevice(true);
    return code;
  }
  // Links this device to a code typed or pasted (a link works too). Refused when nothing is synced
  // under it, so a typo can't start a separate, empty sync.
  async function link(text) {
    const code = normalizeCode(text);
    if (!code) throw failure('code', MESSAGES.code);
    if (code === site.code()) return code;
    const s = await available();
    if (!s) throw failure('offline', 'Sync isn’t available on this site right now.');
    let any = false;
    for (const app of s.apps) {
      const r = await request(code, 'GET', app);
      if (r.status === 200) { any = true; break; }
    }
    if (!any) throw failure('empty', MESSAGES.empty);
    site.set(code, 'link');
    await touchDevice(true);
    return code;
  }
  // Stops sync on this device. What is saved here and on the other devices stays.
  function unlink() { site.clear(); }

  // Every file part a document lists (Loom's `files` collection), so erasing can take them too.
  function partsOf(doc) {
    const out = [];
    const map = (doc && doc.c && doc.c.files) || {};
    for (const id of kept(map)) {
      const f = map[id].d;
      if (f && typeof f.b === 'string' && /^[0-9a-f]{64}$/.test(f.b) && Number.isInteger(f.n) && f.n > 0 && f.n < 200) {
        for (let i = 0; i < f.n; i++) out.push(f.b + ':' + i);
      }
    }
    return out;
  }
  const partName = async (base, i) => hex(await webcrypto.subtle.digest('SHA-256', utf8(base + ':' + i)));

  // A new code for the same saves. Every save is read with the old code, re-encrypted with the
  // new one and stored under it, then the old copies are deleted. Devices still holding the old
  // code find their saves gone and stop syncing: that is how a lost or old device is signed out.
  async function changeCode(onProgress) {
    const old = site.code();
    if (!old) throw failure('code', 'Sync isn’t on.');
    const s = await available();
    if (!s) throw failure('offline', MESSAGES.offline);
    const code = newCode();
    const keys = await derive(code);
    const moved = [];
    for (const app of s.apps.filter((a) => a !== 'site')) {
      if (onProgress) onProgress(APP_NAMES[app] || app);
      const found = await readDoc(old, app);
      if (!found) continue;
      const r = await request(code, 'PUT', app, { payload: await seal(keys.key, found.doc), base: null });
      if (r.status !== 200) throw failure('offline', MESSAGES.offline);
      moved.push(app);
    }
    site.set(code, 'rotate');
    await touchDevice(true);
    for (const app of [...moved, 'site']) await request(old, 'DELETE', app).catch(() => {});
    return code;
  }
  // Deletes every synced save and file for this code, and stops sync here. Each device keeps what it has.
  async function eraseAll(onProgress) {
    const code = site.code();
    if (!code) return;
    const s = await available();
    if (!s) throw failure('offline', MESSAGES.offline);
    for (const app of s.apps) {
      if (onProgress) onProgress(APP_NAMES[app] || app);
      if (s.parts.includes(app)) {
        const found = await readDoc(code, app).catch(() => null);
        for (const p of partsOf(found && found.doc)) {
          const [base, i] = p.split(':');
          await request(code, 'DELETE', `${app}/part/${await partName(base, Number(i))}`).catch(() => {});
        }
      }
      await request(code, 'DELETE', app);
    }
    site.clear();
  }

  /* ---------- Files, in encrypted parts ---------- */

  // File bytes per part. Sealed (12-byte IV + 16-byte tag) and in base64 it must stay under the
  // server's PARTS limit (4,100,000 characters) and Vercel's 4.5 MB request cap: 3,000,000 bytes
  // come to 4,000,040 characters. (3 MiB came to 4,194,344, so every file over 3 MB was refused.)
  const PART_BYTES = 3_000_000;

  // Uploads a file (Blob) for `app`. Returns the entry to keep in the app's `files` collection:
  // { k: key, b: name base, n: parts, size, type }. Needs sync to be on.
  async function putFile(app, code, blob, onProgress) {
    const raw = webcrypto.getRandomValues(new Uint8Array(32));
    const key = await webcrypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
    const base = hex(webcrypto.getRandomValues(new Uint8Array(32)));
    const n = Math.max(1, Math.ceil(blob.size / PART_BYTES));
    for (let i = 0; i < n; i++) {
      const bytes = new Uint8Array(await blob.slice(i * PART_BYTES, (i + 1) * PART_BYTES).arrayBuffer());
      const payload = await sealBytes(key, bytes);
      const r = await request(code, 'PUT', `${app}/part/${await partName(base, i)}`, { payload });
      if (r.status !== 200) throw failure(r.status === 409 ? 'empty' : 'offline', MESSAGES.offline);
      if (onProgress) onProgress((i + 1) / n);
    }
    return { k: toBase64(raw), b: base, n, size: blob.size, type: blob.type || '' };
  }
  async function getFile(app, code, entry) {
    const key = await webcrypto.subtle.importKey('raw', fromBase64(entry.k), 'AES-GCM', false, ['decrypt']);
    const chunks = [];
    for (let i = 0; i < entry.n; i++) {
      const r = await request(code, 'GET', `${app}/part/${await partName(entry.b, i)}`);
      if (r.status !== 200) throw failure('empty', 'That file isn’t synced any more.');
      chunks.push(await openBytes(key, r.data.payload));
    }
    return new Blob(chunks, { type: entry.type || '' });
  }
  async function removeFile(app, code, entry) {
    for (let i = 0; i < entry.n; i++) await request(code, 'DELETE', `${app}/part/${await partName(entry.b, i)}`).catch(() => {});
  }
  const validFile = (f) => !!(f && typeof f.k === 'string' && f.k.length === 44 && typeof f.b === 'string' && /^[0-9a-f]{64}$/.test(f.b)
    && Number.isInteger(f.n) && f.n > 0 && f.n < 200 && Number.isFinite(f.size) && typeof f.type === 'string' && f.type.length < 120);

  /* ---------- Linking from a link: bollineni.co/#link=CODE ---------- */

  // Returns the code in the address, if any, and takes it out of the address (and the history)
  // so it isn't left on screen or bookmarked.
  function takeLinkFromAddress() {
    const m = /^#link=([0-9A-Za-z-]+)$/.exec(location.hash);
    if (!m) return null;
    history.replaceState(null, '', location.pathname + location.search);
    return normalizeCode(m[1]);
  }

  /* ---------- The sync panel ---------- */

  const since = (t) => {
    if (!t) return 'not yet';
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return Math.floor(s / 86400) + ' d ago';
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const STYLE = `
.bsync-back{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.6);display:flex;align-items:flex-end;justify-content:center;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
@media (min-width:640px){.bsync-back{align-items:center}}
.bsync{--a:#fff;box-sizing:border-box;width:min(520px,100%);max-height:min(92vh,100%);overflow:auto;background:#0b0b0b;color:#f2f2f2;border:1px solid #2a2a2a;font:15px/1.45 Archivo,system-ui,-apple-system,"Segoe UI",sans-serif;padding:22px 22px calc(22px + env(safe-area-inset-bottom));-webkit-font-smoothing:antialiased}
.bsync *{box-sizing:border-box}
.bsync h2{font-size:22px;line-height:1.15;margin:0 34px 6px 0;font-weight:800;letter-spacing:-.01em}
.bsync h3{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#9a9a9a;margin:20px 0 8px;font-weight:600}
.bsync p{margin:0 0 12px;color:#c9c9c9}
.bsync small{color:#9a9a9a;font-size:13px}
.bsync .x{position:absolute;top:0;right:0;width:44px;height:44px;border:0;background:none;color:#bbb;font-size:22px;cursor:pointer}
.bsync .head{position:relative}
.bsync button.b,.bsync a.b{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 16px;border:1px solid #3a3a3a;background:#161616;color:#f2f2f2;font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
.bsync button.b:hover{border-color:#666}
.bsync button.p{background:var(--a);border-color:var(--a);color:#0b0b0b}
.bsync button.d{color:#ff8a80;border-color:#4a2622;background:#1a0f0e}
.bsync button[disabled]{opacity:.5;cursor:default}
.bsync .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;border:0;padding:0;margin:0;grid-template-columns:none}
.bsync .grow{flex:1 1 200px}
.bsync input{min-height:44px;width:100%;padding:0 12px;background:#111;border:1px solid #3a3a3a;color:#fff;font:15px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.04em}
.bsync input:focus,.bsync button:focus-visible{outline:2px solid var(--a);outline-offset:2px}
.bsync .pair{display:grid;grid-template-columns:auto 1fr;gap:16px;align-items:center;padding:14px;border:1px solid #2a2a2a;background:#111}
@media (max-width:420px){.bsync .pair{grid-template-columns:1fr;justify-items:center;text-align:center}}
.bsync .qr{background:#fff;padding:8px;line-height:0}
.bsync .qr svg{width:148px;height:148px;display:block}
.bsync code{font:14px ui-monospace,SFMono-Regular,Menlo,monospace;color:#fff;word-break:break-all;letter-spacing:.03em}
.bsync ul{list-style:none;margin:0;padding:0;border-top:1px solid #222}
.bsync li{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid #222;min-height:44px;color:#f2f2f2;margin:0}
.bsync li::before,.bsync li::after,.bsync b::before,.bsync b::after{content:none!important;display:none!important}
.bsync b,.bsync li b{color:#fff;font-weight:600;font-size:inherit;letter-spacing:normal;position:static}
.bsync p{border:0;padding:0;max-width:none;grid-column:auto}
.bsync .pair p{margin-bottom:12px!important}
.bsync .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#3ddc84;margin-right:8px;vertical-align:1px}
.bsync .dot.off{background:#555}.bsync .dot.err{background:#ff8a80}
.bsync .msg{min-height:20px;font-size:13px;color:#9a9a9a;margin-top:8px}
.bsync .msg.bad{color:#ff8a80}
.bsync .lnk{background:none;border:0;color:#bbb;text-decoration:underline;font:inherit;font-size:13px;cursor:pointer;padding:6px 0;min-height:32px}
.bsync details summary{cursor:pointer;color:#bbb;min-height:44px;display:flex;align-items:center}
`;
  function qrSvg(text) {
    if (typeof root.qrcode !== 'function') return '';
    const q = root.qrcode(0, 'M');
    q.addData(text);
    q.make();
    const n = q.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    return `<svg viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="QR code that links another device"><path d="${d}" fill="#000"/></svg>`;
  }
  let qrLoading = null;
  function loadQr() {
    if (typeof root.qrcode === 'function') return Promise.resolve();
    if (!qrLoading) qrLoading = new Promise((res) => {
      const s = document.createElement('script');
      s.src = '/sync/qrcode.js';
      s.onload = res; s.onerror = res;
      document.head.appendChild(s);
    });
    return qrLoading;
  }

  // Opens the sync panel over the page. `opts`: { app (id of the app it's opened from), tint }.
  // Engines on the page are passed so it can show each app's state and sync now.
  const engines = new Set();
  function openPanel(opts) {
    opts = opts || {};
    if (!document.getElementById('bsync-style')) {
      const st = document.createElement('style');
      st.id = 'bsync-style';
      st.textContent = STYLE;
      document.head.appendChild(st);
    }
    const prev = document.activeElement;
    const back = document.createElement('div');
    back.className = 'bsync-back';
    back.innerHTML = '<div class="bsync" role="dialog" aria-modal="true" aria-labelledby="bsync-title"></div>';
    const box = back.firstChild;
    if (opts.tint) box.style.setProperty('--a', opts.tint);
    document.body.appendChild(back);
    let closed = false;
    const offSite = site.onChange(() => { if (!closed) render(); });
    function close() {
      if (closed) return;
      closed = true;
      offSite();
      back.remove();
      document.removeEventListener('keydown', onKey, true);
      if (prev && prev.focus) prev.focus();
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); }
      if (e.key === 'Tab') {
        const f = [...box.querySelectorAll('button,input,a,summary')].filter((x) => !x.disabled && x.offsetParent);
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    }
    document.addEventListener('keydown', onKey, true);
    back.addEventListener('click', (e) => { if (e.target === back) close(); });

    const say = (text, bad) => { const m = box.querySelector('.msg'); if (m) { m.textContent = text || ''; m.classList.toggle('bad', !!bad); } };
    const busy = (btn, on) => { if (btn) btn.disabled = on; };

    async function render() {
      const code = site.code();
      const s = await available();
      if (closed) return;
      const head = `<div class="head"><h2 id="bsync-title">${code ? 'Synced across your devices' : 'Your apps, on all your devices'}</h2><button class="x" type="button" aria-label="Close" data-a="close">×</button></div>`;
      if (!s) {
        box.innerHTML = head + '<p>Sync isn’t available here right now. Your saves stay on this device.</p><div class="row"><button class="b" type="button" data-a="close">Close</button></div>';
        return wire();
      }
      if (!code) {
        box.innerHTML = head + `
          <p>Sync keeps what you save in Loom, Gridline, Palimpsest and Ballast the same on your phone, tablet and computer. There’s no account and no password: this device gets a private link, and opening it on another device links that one too.</p>
          <p><small>Everything is encrypted on your device before it’s sent, with a key only your devices have.</small></p>
          <div class="row"><button class="b p grow" type="button" data-a="on">Turn on sync</button></div>
          <h3>Already syncing on another device?</h3>
          <form class="row" data-f="link"><input class="grow" name="code" placeholder="Paste the link or type the code" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Sync link or code" required><button class="b" type="submit">Link</button></form>
          <p><small>On that device, open sync and scan its QR code with this one’s camera, or share the link here.</small></p>
          <div class="msg" role="status"></div>`;
        return wire();
      }
      const me = device();
      const url = site.linkUrl(code);
      await loadQr();
      if (closed) return;
      // Every app on the site, with how it stands on this device: from its engine when it runs on
      // this page, otherwise from the record it keeps (Gridline keeps its own in localStorage).
      const ids = s.apps.filter((a) => a !== 'site');
      const records = await Promise.all(ids.map((a) => (a === 'gridline' ? ls.get('gridline:sync') : idb.get('app:' + a))));
      if (closed) return;
      const appRows = ids.map((a, i) => {
        const e = [...engines].find((x) => x.engine.app === a);
        const st = e ? e.engine.status() : { on: !!records[i], phase: 'idle', syncedAt: records[i] && records[i].syncedAt };
        const cls = st.phase === 'error' ? 'err' : st.on ? '' : 'off';
        const text = st.phase === 'syncing' ? 'Syncing…' : st.phase === 'error' ? esc(st.problem && st.problem.message)
          : st.on && st.syncedAt ? `Synced ${since(st.syncedAt)}` : 'Syncs when you open it';
        return `<li><span><span class="dot ${cls}"></span><b>${esc(APP_NAMES[a] || a)}</b></span><small>${text}</small></li>`;
      }).join('');
      box.innerHTML = head + `
        <p>Everything you save in this site’s apps follows you to every device linked here.</p>
        <ul>${appRows}</ul>${engines.size ? '<div class="row" style="margin-top:10px"><button class="b" type="button" data-a="now">Sync now</button></div>' : ''}
        <h3>Add a device</h3>
        <div class="pair">
          <div class="qr">${qrSvg(url)}</div>
          <div><p style="margin-bottom:10px">Point the other device’s camera at this code and open the link. It’s linked straight away, with nothing to sign up for.</p>
            <div class="row">${navigator.share ? '<button class="b p" type="button" data-a="share">Share link</button>' : ''}<button class="b" type="button" data-a="copy">Copy link</button></div></div>
        </div>
        <details><summary>Type the code instead</summary><p><code>${esc(formatCode(code))}</code></p><p><small>Anyone with this code or link can see and change your saves. Keep it like a password.</small></p></details>
        <h3>Linked devices</h3>
        <ul data-devices><li><small>Loading…</small></li></ul>
        <h3>This device</h3>
        <form class="row" data-f="name"><input class="grow" name="name" value="${esc(me.name)}" maxlength="40" aria-label="This device’s name" style="font-family:inherit;letter-spacing:0"><button class="b" type="submit">Rename</button></form>
        <div class="msg" role="status"></div>
        <details><summary>Lost a device, or stopping sync</summary>
          <ul>
            <li><span><b>Unlink this device</b><br><small>Stops sync here. Everything stays on this device and the others.</small></span><button class="b" type="button" data-a="unlink">Unlink</button></li>
            <li><span><b>Change the code</b><br><small>Moves your saves to a new code and signs out every other device. Use it if a device is lost or the link was shared by mistake. Then relink the devices you still use.</small></span><button class="b" type="button" data-a="rotate">Change</button></li>
            <li><span><b>Erase synced data</b><br><small>Deletes the synced copy, including files, and stops sync everywhere. Each device keeps what it has.</small></span><button class="b d" type="button" data-a="erase">Erase</button></li>
          </ul>
        </details>`;
      wire();
      listDevices().then((list) => {
        const ul = box.querySelector('[data-devices]');
        if (!ul || closed) return;
        ul.innerHTML = list.length ? list.map((d) => `<li><span><b>${esc(d.name)}</b>${d.me ? ' <small>(this one)</small>' : ''}<br><small>${d.apps.map((a) => APP_NAMES[a]).join(', ') || 'No apps opened yet'}</small></span>`
          + `<span style="text-align:right"><small>${d.me ? 'Now' : 'Seen ' + since(d.seen)}</small>${d.me ? '' : `<br><button class="lnk" type="button" data-forget="${esc(d.id)}">Remove</button>`}</span></li>`).join('')
          : '<li><small>Only this device so far.</small></li>';
        ul.querySelectorAll('[data-forget]').forEach((b) => b.addEventListener('click', async () => {
          b.disabled = true;
          await forgetDevice(b.dataset.forget).catch(() => {});
          say('Removed from the list. To sign that device out, change the code.');
          render();
        }));
      }).catch(() => {
        const ul = box.querySelector('[data-devices]');
        if (ul && !closed) ul.innerHTML = '<li><small>Couldn’t load the list right now.</small></li>';
      });
    }

    function wire() {
      box.querySelectorAll('[data-a="close"]').forEach((b) => b.addEventListener('click', close));
      const on = (a, fn) => { const b = box.querySelector(`[data-a="${a}"]`); if (b) b.addEventListener('click', () => fn(b)); };
      on('on', async (b) => {
        busy(b, true);
        try { await turnOn(); await render(); } catch (e) { say(e.message, true); busy(b, false); }
      });
      on('now', async (b) => {
        busy(b, true); say('Syncing…');
        const results = await Promise.allSettled([...engines].map((e) => e.engine.sync()));
        const bad = results.find((r) => r.status === 'rejected');
        if (!closed) { await render(); say(bad ? bad.reason.message : 'Up to date.', !!bad); }
      });
      on('share', async () => {
        try { await navigator.share({ title: 'Link my device', text: 'Open this on your other device to sync your bollineni.co apps.', url: site.linkUrl() }); } catch (e) { /* cancelled */ }
      });
      on('copy', async () => {
        try { await navigator.clipboard.writeText(site.linkUrl()); say('Link copied. Open it on your other device.'); } catch (e) { say('Couldn’t copy. Select the code below instead.', true); }
      });
      on('unlink', () => {
        if (!confirm('Stop syncing on this device? Everything stays saved here and on your other devices.')) return;
        unlink();
        render();
      });
      on('rotate', async (b) => {
        if (!confirm('Change the code? Your saves move to a new code, and every other device is signed out until you link it again.')) return;
        busy(b, true);
        try { await changeCode((name) => say(`Moving ${name}…`)); await render(); say('New code ready. Link the devices you still use.'); } catch (e) { say(e.message, true); busy(b, false); }
      });
      on('erase', async (b) => {
        if (!confirm('Erase the synced copy of everything, including files? Sync stops on every device. Each device keeps what it has.')) return;
        busy(b, true);
        try { await eraseAll((name) => say(`Erasing ${name}…`)); await render(); say('Erased. Everything is still on this device.'); } catch (e) { say(e.message, true); busy(b, false); }
      });
      const linkForm = box.querySelector('[data-f="link"]');
      if (linkForm) linkForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const b = linkForm.querySelector('button');
        busy(b, true); say('Checking…');
        try { await link(linkForm.code.value); await render(); say('Linked. Your apps are syncing.'); } catch (err) { say(err.message, true); busy(b, false); }
      });
      const nameForm = box.querySelector('[data-f="name"]');
      if (nameForm) nameForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        site.rename(nameForm.name.value);
        await touchDevice(true);
        render();
      });
      const first = box.querySelector('input:not([name="name"]), .p, .b');
      if (first && !box.contains(document.activeElement)) first.focus({ preventScroll: true });
    }
    render();
    return { close };
  }

  // A small piece of UI an app can put in its settings: a status line and a button to the panel.
  function mountButton(el, engine, opts) {
    const draw = () => {
      const st = engine.status();
      if (!st.available) { el.hidden = true; return; }
      el.hidden = false;
      const text = !st.on ? 'Off. Turn it on to keep your saves on every device, with no account.'
        : st.phase === 'syncing' ? 'Syncing…' : st.phase === 'error' ? (st.problem && st.problem.message) || 'Couldn’t sync.'
        : `On. Last synced ${since(st.syncedAt)}.`;
      el.dataset.syncState = !st.on ? 'off' : st.phase;
      const t = el.querySelector('[data-sync-text]');
      if (t) t.textContent = text;
      const b = el.querySelector('[data-sync-open]');
      if (b) b.textContent = st.on ? (opts && opts.manage) || 'Devices' : (opts && opts.turnOn) || 'Turn on';
    };
    engine.onStatus(draw);
    site.onChange(draw);
    const b = el.querySelector('[data-sync-open]');
    if (b) b.addEventListener('click', () => openPanel(opts));
    draw();
  }

  const api = {
    newCode, normalizeCode, formatCode, derive, seal, open, emptyDoc, stamp, merge, view, same, canonical,
    site, available, createEngine, readDoc, listDevices, flushOthers, turnOn, link, unlink, changeCode, eraseAll,
    putFile, getFile, removeFile, validFile, PART_BYTES, takeLinkFromAddress, openPanel, mountButton, MESSAGES,
    // Apps register their engine so the panel can show it and sync it.
    register(engine, name) { const e = { engine, name }; engines.add(e); return () => engines.delete(e); },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.BollineniSync = api;
})(typeof window !== 'undefined' ? window : globalThis);
