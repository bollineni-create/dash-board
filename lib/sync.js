// Device-to-device sync for the apps on this site. A person's saves are kept as one private
// file per app in a Vercel Blob store, and the only thing that names that file is a sync code
// the person carries from one device to the next. There are no accounts.
//
// The browser never sends the code itself. It derives two things from it: an id (sent here as
// the bearer token) and an encryption key (never sent). What arrives as `payload` is already
// encrypted, so this route and the store only ever hold text they cannot read.
//
// Everything that decides an answer lives here and takes its storage as an argument, so the
// tests run it against a store kept in memory. api/sync.js wires in the real one.
import { createHash } from 'node:crypto';

// Apps that may sync, and the largest payload each may store (characters of base64 text).
export const APPS = { gridline: 400_000 };

export const validId = (id) => typeof id === 'string' && /^[0-9a-f]{64}$/.test(id);

// The file's name is a hash of the id, so a listing of the store gives nobody a usable token.
// Preview and development builds share the store with production, so each keeps its own folder.
export function pathFor(env, id, app) {
  const folder = createHash('sha256').update('bollineni-sync:' + id).digest('hex');
  return `${env}/${folder}/${app}.json`;
}

// A file over about a kilobyte is read back compressed, and its version then arrives marked weak
// (W/"abc" for "abc"). A conditional write only accepts the plain form, so that is the only form
// this route hands out or passes on.
export const plainVersion = (v) => (typeof v === 'string' ? v.replace(/^W\//, '') : v);

const refused = (status, reason, message, extra) => Object.assign(new Error(message), { status, reason, extra });

// There are no accounts, so anyone can start a new code. Two things keep that from filling the
// store. Every file expires KEEP_DAYS after it was last written (api/sync.js sets that on each
// write), and one that is still being read is written again once it is REFRESH_DAYS old, so only
// codes nobody uses any more go away. And one address may start only a few new codes an hour.
export const KEEP_DAYS = 400;
export const REFRESH_DAYS = 180;
const DAY = 86_400_000;

// `blob` is { read(path) -> { text, version, writtenAt } | null, write(path, text, { ifMatch }) ->
// { version }, remove(path) }. write() throws an error with `conflict: true` when ifMatch (a
// version, or null for "there must be nothing there yet") does not hold.
export function makeStore(blob, env = 'development', now = () => Date.now()) {
  const unpack = (found) => {
    let saved = null;
    try { saved = JSON.parse(found.text); } catch { /* treated as empty below */ }
    if (!saved || typeof saved.payload !== 'string') return null;
    return { payload: saved.payload, updatedAt: saved.updatedAt || null, version: plainVersion(found.version) };
  };
  return {
    // Whether a readable save is there, without renewing it or changing its version.
    async exists(id, app) {
      const found = await blob.read(pathFor(env, id, app));
      return !!(found && unpack(found));
    },
    async load(id, app) {
      const path = pathFor(env, id, app);
      const found = await blob.read(path);
      const saved = found ? unpack(found) : null;
      if (!saved) return null;
      // Still in use but written long ago: write it again so it doesn't expire. If another device
      // saves at the same moment, that save has renewed it anyway.
      if (found.writtenAt && now() - found.writtenAt > REFRESH_DAYS * DAY) {
        try { saved.version = plainVersion((await blob.write(path, found.text, { ifMatch: plainVersion(found.version) })).version); } catch { /* next read tries again */ }
      }
      return saved;
    },
    // `base` is the version the device last saw, or null when it has never seen one. A save made
    // from an older version is refused with what is stored now, so the device can merge and retry.
    async save(id, app, payload, base) {
      const path = pathFor(env, id, app);
      const updatedAt = new Date().toISOString();
      const text = JSON.stringify({ payload, updatedAt });
      let ifMatch = plainVersion(base);
      // A file that is gone, or holds something unreadable, may be written over, so the write is
      // tried again against whatever is there. Another device can get in between each time.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const { version } = await blob.write(path, text, { ifMatch });
          // `created`: this save started a new file, which the route counts per address.
          return { version: plainVersion(version), updatedAt, created: !ifMatch };
        } catch (e) {
          if (!e || !e.conflict) throw e;
          const found = await blob.read(path);
          const current = found && unpack(found);
          if (current) throw refused(409, 'conflict', 'This was changed on another device.', current);
          ifMatch = found ? plainVersion(found.version) : null;
        }
      }
      throw refused(409, 'conflict', 'This was changed on another device.');
    },
    async erase(id, app) { await blob.remove(pathFor(env, id, app)); },
  };
}

function sameSite(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin';
  const from = req.headers.origin || req.headers.referer || '';
  try { return new URL(from).host === req.headers.host; } catch { return false; }
}

// Per instance, so these are soft limits: [windowStart, count] per address and bucket.
// `create` is how many new codes one address may start.
const LIMITS = { read: [60_000, 90], write: [60_000, 40], create: [3_600_000, 6] };
function limiter() {
  const hits = new Map();
  const current = (ip, bucket, now) => {
    const h = hits.get(`${bucket}:${ip}`);
    return h && now - h[0] <= LIMITS[bucket][0] ? h : null;
  };
  // Counts a request and says whether it is one too many.
  const over = (ip, bucket) => {
    const now = Date.now();
    const h = current(ip, bucket, now);
    if (!h) {
      if (hits.size > 5000) hits.clear();
      hits.set(`${bucket}:${ip}`, [now, 1]);
      return false;
    }
    return ++h[1] > LIMITS[bucket][1];
  };
  // Takes back a request that was counted and turned out not to belong in the bucket.
  over.undo = (ip, bucket) => { const h = current(ip, bucket, Date.now()); if (h && h[1] > 0) h[1]--; };
  return over;
}

const send = (res, status, data) => res.status(status).setHeader('Cache-Control', 'no-store').json(data);

// `store` is null when the site has no Blob store connected; the route then says so and the apps
// leave sync out of their settings.
export function createHandler(store) {
  const overLimit = limiter();
  return async function handler(req, res) {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const app = url.searchParams.get('route') || '';
    if (app === 'status') {
      if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
      return send(res, 200, { sync: !!store, apps: store ? Object.keys(APPS) : [] });
    }
    if (!sameSite(req)) return send(res, 403, { error: 'Forbidden' });
    if (!store) return send(res, 503, { error: 'Sync isn’t set up on this site.', reason: 'off' });
    if (!Object.hasOwn(APPS, app)) return send(res, 404, { error: 'No such app.', reason: 'invalid' });
    const write = req.method === 'PUT' || req.method === 'DELETE';
    if (!write && req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    if (overLimit(ip, write ? 'write' : 'read')) {
      res.setHeader('Retry-After', '30');
      return send(res, 429, { error: 'Too many requests. Try again shortly.', reason: 'rate_limited' });
    }
    const id = (/^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization || '') || [])[1];
    if (!validId(id)) return send(res, 401, { error: 'That sync code isn’t valid.', reason: 'code' });
    try {
      if (req.method === 'GET') {
        const found = await store.load(id, app);
        if (!found) return send(res, 404, { error: 'Nothing is saved under this code yet.', reason: 'empty' });
        return send(res, 200, found);
      }
      if (req.method === 'DELETE') {
        await store.erase(id, app);
        return send(res, 200, { erased: true });
      }
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
      const payload = body && body.payload;
      const base = body && body.base != null ? body.base : null;
      if (typeof payload !== 'string' || !payload || (base !== null && (typeof base !== 'string' || base.length > 200))) {
        return send(res, 400, { error: 'That save couldn’t be read.', reason: 'invalid' });
      }
      if (payload.length > APPS[app]) return send(res, 413, { error: 'There’s too much to sync.', reason: 'too_large' });
      // Any save might start a new file (a first save, or one whose file is gone), and one address
      // may start only so many. Each save is counted as a new file before it is written, so a
      // burst sent all at once can't slip past, and the count is given back when the save turns
      // out to be to a file that already exists. Saves to existing files always go through.
      let counted = true;
      if (overLimit(ip, 'create')) {
        overLimit.undo(ip, 'create');
        counted = false;
        if (!(await store.exists(id, app))) {
          res.setHeader('Retry-After', '3600');
          return send(res, 429, { error: 'Too many new sync codes from this network. Try again in an hour.', reason: 'rate_limited' });
        }
      }
      try {
        const { created, ...saved } = await store.save(id, app, payload, base);
        if (counted && !created) overLimit.undo(ip, 'create');
        return send(res, 200, saved);
      } catch (e) {
        if (counted) overLimit.undo(ip, 'create');
        throw e;
      }
    } catch (e) {
      if (e && e.status === 409) return send(res, 409, { error: e.message, reason: e.reason, current: e.extra });
      console.error('sync', app, req.method, e && e.message);
      return send(res, 502, { error: 'Sync couldn’t reach its storage. Try again shortly.', reason: 'upstream' });
    }
  };
}
