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

const refused = (status, reason, message, extra) => Object.assign(new Error(message), { status, reason, extra });

// `blob` is { read(path) -> { text, version } | null, write(path, text, { ifMatch }) -> { version },
// remove(path) }. write() throws an error with `conflict: true` when ifMatch (a version, or null
// for "there must be nothing there yet") does not hold.
export function makeStore(blob, env = 'development') {
  const unpack = (found) => {
    let saved = null;
    try { saved = JSON.parse(found.text); } catch { /* treated as empty below */ }
    if (!saved || typeof saved.payload !== 'string') return null;
    return { payload: saved.payload, updatedAt: saved.updatedAt || null, version: found.version };
  };
  return {
    async load(id, app) {
      const found = await blob.read(pathFor(env, id, app));
      return found ? unpack(found) : null;
    },
    // `base` is the version the device last saw, or null when it has never seen one. A save made
    // from an older version is refused with what is stored now, so the device can merge and retry.
    async save(id, app, payload, base) {
      const path = pathFor(env, id, app);
      const updatedAt = new Date().toISOString();
      try {
        const { version } = await blob.write(path, JSON.stringify({ payload, updatedAt }), { ifMatch: base });
        return { version, updatedAt };
      } catch (e) {
        if (!e || !e.conflict) throw e;
        const found = await blob.read(path);
        const current = found && unpack(found);
        // The file went away, or holds something unreadable: the device may write over it.
        if (!current) {
          const { version } = await blob.write(path, JSON.stringify({ payload, updatedAt }), { ifMatch: found ? found.version : null });
          return { version, updatedAt };
        }
        throw refused(409, 'conflict', 'This was changed on another device.', current);
      }
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
const LIMITS = { read: [60_000, 90], write: [60_000, 40] };
function limiter() {
  const hits = new Map();
  return (ip, bucket) => {
    const [win, max] = LIMITS[bucket];
    const key = `${bucket}:${ip}`, now = Date.now();
    const h = hits.get(key);
    if (!h || now - h[0] > win) {
      if (hits.size > 5000) hits.clear();
      hits.set(key, [now, 1]);
      return false;
    }
    return ++h[1] > max;
  };
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
      return send(res, 200, await store.save(id, app, payload, base));
    } catch (e) {
      if (e && e.status === 409) return send(res, 409, { error: e.message, reason: e.reason, current: e.extra });
      console.error('sync', app, req.method, e && e.message);
      return send(res, 502, { error: 'Sync couldn’t reach its storage. Try again shortly.', reason: 'upstream' });
    }
  };
}
