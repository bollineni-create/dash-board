// Ballast's server routes for the hosted site (/ballast/api/* is rewritten here).
// The market data and strategy builder code is Ballast's own, from the copy build.mjs
// clones into .src/ballast. The paper-trading autopilot is never served from here: it
// trades with Alpaca keys and stays in the Mac app.
import { getHistory, getQuotes, stockProvider } from '../.src/ballast/marketdata.js';
import { aiEnabled, generateStrategy } from '../.src/ballast/ai.js';

const GENERATE_PER_10_MIN = Number(process.env.BALLAST_GENERATE_LIMIT) || 6;
const hits = new Map(); // ip -> [windowStart, count]; per instance, so it's a soft limit
function overLimit(ip) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h[0] > 600_000) { hits.set(ip, [now, 1]); return false; }
  return ++h[1] > GENERATE_PER_10_MIN;
}

function sameSite(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin';
  const from = req.headers.origin || req.headers.referer || '';
  try { return new URL(from).host === req.headers.host; } catch { return false; }
}

const send = (res, status, data, cache = 'no-store') => res.status(status).setHeader('Cache-Control', cache).json(data);

export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const route = url.searchParams.get('route') || '';
  try {
    if (route === 'status' && req.method === 'GET') return send(res, 200, { ai: aiEnabled, stockProvider, autopilot: false });
    if (route === 'history' && req.method === 'GET') {
      const raw = url.searchParams.get('years');
      const years = raw === 'max' ? 'max' : Math.min(50, Math.max(1, Number(raw) || 3));
      return send(res, 200, await getHistory(url.searchParams.get('symbol'), years), 'public, max-age=0, s-maxage=1800, stale-while-revalidate=3600');
    }
    if (route === 'quotes' && req.method === 'GET') {
      const symbols = (url.searchParams.get('symbols') || '').split(',').filter(Boolean);
      return send(res, 200, await getQuotes(symbols), 'public, max-age=0, s-maxage=10');
    }
    if (route === 'generate' && req.method === 'POST') {
      if (!sameSite(req) || !String(req.headers['content-type']).startsWith('application/json')) return send(res, 403, { error: 'Forbidden' });
      const { prompt, currentCode } = req.body || {};
      if (!prompt || typeof prompt !== 'string') return send(res, 400, { error: 'prompt is required' });
      if (prompt.length > 4000 || (currentCode && String(currentCode).length > 20000)) return send(res, 413, { error: 'That request is too long.' });
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
      if (aiEnabled && overLimit(ip)) {
        res.setHeader('Retry-After', '120');
        return send(res, 429, { error: 'The Claude builder is busy for you right now. Try again in a couple of minutes.' });
      }
      return send(res, 200, await generateStrategy(prompt, currentCode ? String(currentCode) : undefined));
    }
    if (route.startsWith('autopilot')) return send(res, 404, { error: 'The paper-trading autopilot runs only in the Ballast Mac app.' });
    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    send(res, e.status || 500, { error: e.message });
  }
}
