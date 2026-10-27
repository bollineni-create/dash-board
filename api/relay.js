// Relays Gridline's /api/<provider>/* requests to Visor or auto.dev.
// The API keys live in Vercel environment variables (AUTODEV_KEY, VISOR_KEY)
// and never reach the browser. Guard rails: GET only, an allowlist of API
// paths, same-site callers only, a per-visitor rate limit, and CDN caching
// so repeat searches don't spend calls.
const UPSTREAMS = { visor: 'https://api.visor.vin', autodev: 'https://api.auto.dev' };
const PATHS = { visor: /^\/v1\/[A-Za-z0-9_\-/.%]+$/, autodev: /^\/(listings|photos)(\/[A-Za-z0-9]{1,17})?$/ };
const ENV_KEYS = { visor: 'VISOR_KEY', autodev: 'AUTODEV_KEY' };
const LIMIT_PER_MIN = Number(process.env.RELAY_LIMIT_PER_MIN) || 30;

const hits = new Map(); // ip -> [windowStart, count]; per instance, so it's a soft limit
function overLimit(ip) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h[0] > 60_000) { hits.set(ip, [now, 1]); return false; }
  h[1]++;
  return h[1] > LIMIT_PER_MIN;
}

function sameSite(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin';
  const from = req.headers.origin || req.headers.referer || '';
  try { return new URL(from).host === req.headers.host; } catch { return false; }
}

const fail = (res, status, message) => res.status(status).setHeader('Cache-Control', 'no-store').json({ error: { message } });

export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const provider = url.searchParams.get('provider');
  const apiPath = '/' + (url.searchParams.get('path') || '');
  url.searchParams.delete('provider');
  url.searchParams.delete('path');
  if (req.method !== 'GET' || !UPSTREAMS[provider] || !PATHS[provider].test(apiPath)) return fail(res, 400, 'Request not allowed.');

  const sent = req.headers['x-api-key'];
  const useServerKey = !sent || sent === '__server__';
  const key = useServerKey ? process.env[ENV_KEYS[provider]] : sent;
  if (!key) return fail(res, 401, `This site has no ${provider === 'visor' ? 'Visor' : 'auto.dev'} key. Add your own in Settings.`);
  if (useServerKey) {
    if (!sameSite(req)) return fail(res, 403, 'The shared key only works from this site.');
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    if (overLimit(ip)) { res.setHeader('Retry-After', '20'); return fail(res, 429, 'Too many requests. Retry after 20 seconds.'); }
  }

  try {
    const qs = url.searchParams.toString();
    const up = await fetch(UPSTREAMS[provider] + apiPath + (qs ? '?' + qs : ''), { headers: { Authorization: `Bearer ${key}` } });
    const body = Buffer.from(await up.arrayBuffer());
    res.setHeader('Content-Type', up.headers.get('content-type') || 'application/json');
    // Shared-key answers are cached at the edge for 30 minutes; answers made with a visitor's own key never are.
    res.setHeader('Cache-Control', useServerKey && up.ok ? 'public, max-age=0, s-maxage=1800' : 'no-store');
    for (const h of ['x-usage-cost-micros', 'x-ratelimit-remaining-60s', 'retry-after']) if (up.headers.get(h)) res.setHeader(h, up.headers.get(h));
    res.status(up.status).send(body);
  } catch (e) {
    fail(res, 502, `Could not reach the listings API: ${e.message}`);
  }
}
