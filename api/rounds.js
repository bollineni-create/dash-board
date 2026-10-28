// Rounds' server routes for the hosted site (/rounds/api/* is rewritten here). Browsers
// can't read Reddit's JSON across origins, so the web version reads it through this route.
// With REDDIT_CLIENT_ID set it uses an app-only OAuth token (oauth.reddit.com, higher
// limits); without it, it reads the public www.reddit.com JSON. Read-only: nothing posts.
import { randomUUID } from 'node:crypto';

const UA = 'web:com.naren.rounds:v1.0 (by /u/rounds_app)';
const CLIENT_ID = process.env.REDDIT_CLIENT_ID || '';
const PER_MINUTE = 120;
const hits = new Map(); // ip -> [windowStart, count]; per instance, so it's a soft limit
function overLimit(ip) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h[0] > 60_000) { hits.set(ip, [now, 1]); return false; }
  return ++h[1] > PER_MINUTE;
}

function sameSite(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin';
  const from = req.headers.origin || req.headers.referer || '';
  try { return new URL(from).host === req.headers.host; } catch { return false; }
}

const send = (res, status, data, cache = 'no-store') => res.status(status).setHeader('Cache-Control', cache).json(data);

let token = null; // { value, expires }
const deviceId = randomUUID().replace(/-/g, '').slice(0, 30);
async function accessToken() {
  if (token && Date.now() < token.expires) return token.value;
  const r = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(CLIENT_ID + ':').toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
    },
    body: new URLSearchParams({ grant_type: 'https://oauth.reddit.com/grants/installed_client', device_id: deviceId }),
  });
  if (!r.ok) throw Object.assign(new Error(`Reddit sign-in failed (${r.status})`), { status: 502 });
  const j = await r.json();
  token = { value: j.access_token, expires: Date.now() + (Number(j.expires_in) || 3600) * 1000 - 60_000 };
  return token.value;
}

async function reddit(path, params) {
  const qs = new URLSearchParams({ ...params, raw_json: '1' });
  const headers = { 'User-Agent': UA, Accept: 'application/json' };
  let url;
  if (CLIENT_ID) {
    headers.Authorization = 'Bearer ' + await accessToken();
    url = `https://oauth.reddit.com${path}?${qs}`;
  } else {
    url = `https://www.reddit.com${path}.json?${qs}`;
  }
  const r = await fetch(url, { headers, redirect: 'manual' });
  if (r.status === 401 && CLIENT_ID) token = null;
  if (!r.ok) {
    // Reddit redirects unknown subreddits to search, and says why a 403 happened
    // (private, quarantined, banned) in its body; pass that reason on to the app.
    const body = await r.json().catch(() => null);
    const status = r.status >= 300 && r.status < 400 ? 404 : r.status;
    const reason = (typeof body?.reason === 'string' && body.reason) || (status === 404 ? 'not_found' : status === 429 ? 'rate_limited' : 'upstream');
    const message = status === 403 ? 'Reddit refused the request (the subreddit may be private).' : `Reddit returned an error (${status}).`;
    throw Object.assign(new Error(message), { status, reason });
  }
  return r.json();
}

const SUB = /^[A-Za-z0-9_]{3,21}$/;
const ID = /^[a-z0-9]{1,12}$/;
const WINDOWS = new Set(['week', 'month', 'year', 'all']);
const AFTER = /^t3_[a-z0-9]{1,12}$/;
const clamp = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Number(v) || d));
const LISTING = 'public, max-age=0, s-maxage=300, stale-while-revalidate=600';
const COMMENTS = 'public, max-age=0, s-maxage=900, stale-while-revalidate=1800';

export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const route = url.searchParams.get('route') || '';
  const q = (k) => url.searchParams.get(k) || '';
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
  if (route === 'status') return send(res, 200, { rounds: true, oauth: !!CLIENT_ID });
  if (!sameSite(req)) return send(res, 403, { error: 'Forbidden' });
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (overLimit(ip)) {
    res.setHeader('Retry-After', '30');
    return send(res, 429, { error: 'Too many requests. Try again shortly.', reason: 'rate_limited' });
  }
  try {
    if (route === 'top' || route === 'hot' || route === 'about') {
      const sub = q('sub');
      if (!SUB.test(sub)) return send(res, 400, { error: 'That isn’t a valid subreddit name.', reason: 'invalid' });
      if (route === 'about') return send(res, 200, await reddit(`/r/${sub}/about`, {}), LISTING);
      const params = { limit: String(clamp(q('limit'), 1, 100, 100)) };
      if (route === 'top') {
        params.t = WINDOWS.has(q('t')) ? q('t') : 'year';
        if (AFTER.test(q('after'))) params.after = q('after');
      }
      return send(res, 200, await reddit(`/r/${sub}/${route}`, params), LISTING);
    }
    if (route === 'comments') {
      const id = q('id');
      if (!ID.test(id)) return send(res, 400, { error: 'That isn’t a valid thread id.', reason: 'invalid' });
      return send(res, 200, await reddit(`/comments/${id}`, { limit: String(clamp(q('limit'), 1, 500, 500)), sort: 'top' }), COMMENTS);
    }
    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    send(res, e.status || 500, { error: e.message, reason: e.reason || 'upstream' });
  }
}
