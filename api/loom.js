// Loom's server routes for the hosted site (/loom/api/* is rewritten here). The library itself
// stays in the browser (IndexedDB); this route only does what a page can't do alone: read a
// saved link's page across origins, and ask Claude to organize an item or answer a question.
// Claude runs only when ANTHROPIC_API_KEY is set; without it Loom still saves and searches.
import Anthropic from '@anthropic-ai/sdk';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';

const aiEnabled = !!process.env.ANTHROPIC_API_KEY;
const client = aiEnabled ? new Anthropic() : null;
const MODEL = 'claude-opus-5-5';

// Per instance, so these are soft limits: [windowStart, count] per ip and bucket.
const LIMITS = { organize: [600_000, 40], ask: [600_000, 30], link: [60_000, 30] };
const hits = new Map();
function overLimit(ip, bucket) {
  const [win, max] = LIMITS[bucket];
  const key = `${bucket}:${ip}`, now = Date.now();
  const h = hits.get(key);
  if (!h || now - h[0] > win) { hits.set(key, [now, 1]); return false; }
  return ++h[1] > max;
}

function sameSite(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin';
  const from = req.headers.origin || req.headers.referer || '';
  try { return new URL(from).host === req.headers.host; } catch { return false; }
}

const send = (res, status, data, cache = 'no-store') => res.status(status).setHeader('Cache-Control', cache).json(data);
const fail = (status, message, reason) => Object.assign(new Error(message), { status, reason });
const str = (v, max) => (typeof v === 'string' ? v : '').slice(0, max);

// ---- Reading a saved link ------------------------------------------------------------------

// Only public addresses: no loopback, private, link-local, CGNAT, multicast or metadata ranges.
function publicAddress(ip) {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return publicAddress(v.slice(7));
    return !(v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff') || v.startsWith('64:ff9b') || v.startsWith('2001:db8'));
  }
  const [a, b] = ip.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)));
}

// The address is checked inside the socket's own lookup, so the connection goes to the
// address that was checked (a second DNS answer can't swap in a private one).
function guardedLookup(host, opts, cb) {
  lookup(host, { all: true }).then((addrs) => {
    const ok = addrs.filter((a) => publicAddress(a.address));
    if (!ok.length || ok.length !== addrs.length) return cb(fail(400, 'That address isn’t on the public internet.', 'private'));
    if (opts && opts.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  }, () => cb(fail(404, 'Couldn’t find that site.', 'dns')));
}

const PAGE_LIMIT = 2_000_000;
function get(url) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(url, {
      lookup: guardedLookup,
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LoomWeb/1.0; +https://bollineni-create.vercel.app/loom/)',
        Accept: 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8,*/*;q=0.5', 'Accept-Encoding': 'identity', 'Accept-Language': 'en' },
    }, (r) => {
      const chunks = [];
      let size = 0;
      r.on('data', (c) => { size += c.length; if (size > PAGE_LIMIT) { r.destroy(); resolve({ r, body: Buffer.concat(chunks), cut: true }); } else chunks.push(c); });
      r.on('end', () => resolve({ r, body: Buffer.concat(chunks) }));
      r.on('error', reject);
    });
    req.on('timeout', () => req.destroy(fail(504, 'That site took too long to answer.', 'timeout')));
    req.on('error', (e) => reject(e.status ? e : fail(502, 'Couldn’t reach that site.', 'upstream')));
  });
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
  return ENTITIES[e.toLowerCase()] ?? m;
});
function meta(html, ...names) {
  for (const n of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*>`, 'i');
    const tag = html.match(re)?.[0];
    const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
    if (content) return decode(content).trim();
  }
  return '';
}

export function readPage(html, base) {
  const title = meta(html, 'og:title', 'twitter:title') || decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim();
  const description = meta(html, 'og:description', 'description', 'twitter:description');
  let image = meta(html, 'og:image', 'twitter:image');
  try { image = image ? new URL(image, base).href : ''; } catch { image = ''; }
  if (image && !/^https?:/.test(image)) image = '';
  const main = html.match(/<(article|main)[^>]*>([\s\S]*?)<\/\1>/i)?.[2] || html.match(/<body[^>]*>([\s\S]*)/i)?.[1] || html;
  const text = decode(main
    .replace(/<(script|style|noscript|svg|template|iframe|nav|footer|header|form|aside)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|blockquote)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\f\r]+/g, ' ').replace(/\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title: title.slice(0, 300), description: description.slice(0, 1000), image, text: text.slice(0, 20000) };
}

async function fetchLink(raw) {
  let url;
  try { url = new URL(raw); } catch { throw fail(400, 'That isn’t a web address.', 'invalid'); }
  for (let hop = 0; hop < 4; hop++) {
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw fail(400, 'Only http and https links can be read.', 'invalid');
    if (url.port && !['80', '443', '8080', '8443'].includes(url.port)) throw fail(400, 'That port isn’t allowed.', 'invalid');
    if (isIP(url.hostname.replace(/^\[|\]$/g, '')) && !publicAddress(url.hostname.replace(/^\[|\]$/g, ''))) throw fail(400, 'That address isn’t on the public internet.', 'private');
    const { r, body } = await get(url);
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { url = new URL(r.headers.location, url); continue; }
    if (r.statusCode >= 400) throw fail(502, `That site answered with an error (${r.statusCode}).`, 'upstream');
    const type = String(r.headers['content-type'] || '');
    if (!/html|xml|text\/plain/i.test(type)) return { url: url.href, title: '', description: '', image: '', text: '', contentType: type.split(';')[0] };
    const html = body.toString('utf8');
    if (/text\/plain/i.test(type)) return { url: url.href, title: '', description: '', image: '', text: html.slice(0, 20000), contentType: 'text/plain' };
    return { url: url.href, ...readPage(html, url), contentType: 'text/html' };
  }
  throw fail(502, 'That link redirects too many times.', 'upstream');
}

// ---- Claude --------------------------------------------------------------------------------

const LIBRARIAN = 'You are a precise librarian for a private personal knowledge library.';
const ORGANIZED = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'A short title, at most 8 words.' },
    summary: { type: 'string', description: 'At most 3 sentences on what this is and why it matters.' },
    takeaways: { type: 'array', items: { type: 'string' }, description: '2 to 5 short, specific things worth remembering.' },
    tags: { type: 'array', items: { type: 'string' }, description: '2 to 5 lowercase topic tags, one to three words each.' },
  },
  required: ['title', 'summary', 'takeaways', 'tags'],
  additionalProperties: false,
};

const ASK_SYSTEM = `You are Loom, a private assistant that helps the user use their personal library \
of saved notes, links, images and files. Answer using the numbered library items provided. Cite items inline \
like [1] or [2]. If the items don't contain the answer, say so briefly, then help from general knowledge and \
make clear that part isn't from their library. Be concise and use Markdown for lists.`;

async function claude(params) {
  const response = await client.beta.messages.create({
    model: MODEL,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    ...params,
  });
  if (response.stop_reason === 'refusal') throw fail(422, 'Claude declined this one.', 'refusal');
  return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

// Models sometimes copy the list of existing tags. Keep a reused tag only if the content mentions it.
export function relevantTags(tags, existing, content) {
  const known = new Set(existing.map((t) => t.toLowerCase().trim()));
  const hay = content.toLowerCase();
  return tags.filter((tag) => {
    const t = tag.toLowerCase().trim();
    return !known.has(t) || t.split(' ').some((w) => hay.includes(w.slice(0, 5)));
  });
}

const KINDS = new Set(['note', 'link', 'image', 'video', 'pdf', 'file']);
const MEDIA = { image: /^image\/(jpeg|png|gif|webp)$/, pdf: /^application\/pdf$/ };

async function organize(body) {
  const kind = KINDS.has(body.kind) ? body.kind : 'note';
  const text = str(body.text, 24000);
  const existing = (Array.isArray(body.existingTags) ? body.existingTags : []).filter((t) => typeof t === 'string').slice(0, 30).map((t) => t.slice(0, 40));
  const content = [];
  const media = body.media && typeof body.media === 'object' ? body.media : null;
  if (media) {
    const data = str(media.data, 4_000_000), type = str(media.type, 40);
    if (MEDIA.image.test(type)) content.push({ type: 'image', source: { type: 'base64', media_type: type, data } });
    else if (MEDIA.pdf.test(type)) content.push({ type: 'document', source: { type: 'base64', media_type: type, data } });
  }
  if (!content.length && text.trim().length <= 3) throw fail(400, 'There’s nothing to organize yet.', 'empty');
  content.push({ type: 'text', text: `Read this saved ${kind} and capture what is worth remembering from it.
If the content is too thin to learn from, keep takeaways to what it actually says.
Use only facts from the content. Never write about Loom, this library or tags.
Tags must name topics this content is actually about.

CONTENT:
${text || (content.length ? `(the attached ${kind})` : '')}
${existing.length ? `\nThe library already uses these tags. Reuse one only if the content above is clearly about it: ${existing.join(', ')}` : ''}` });
  const out = await claude({
    max_tokens: 1500,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: ORGANIZED } },
    system: LIBRARIAN,
    messages: [{ role: 'user', content }],
  });
  let parsed;
  try { parsed = JSON.parse(out); } catch { throw fail(502, 'Claude’s answer couldn’t be read.', 'upstream'); }
  const clean = (a, n) => (Array.isArray(a) ? a : []).filter((s) => typeof s === 'string').map((s) => s.trim()).filter(Boolean).slice(0, n);
  const tags = clean(parsed.tags, 8).map((t) => t.toLowerCase().replace(/^[#\s]+|\s+$/g, '')).filter((t) => t && t.length < 30);
  return {
    title: str(parsed.title, 120).trim(),
    summary: str(parsed.summary, 1200).trim(),
    takeaways: clean(parsed.takeaways, 6).map((t) => t.replace(/^[-•*\s]+/, '')),
    tags: media ? tags : relevantTags(tags, existing, text),
  };
}

async function ask(body) {
  const question = str(body.question, 2000).trim();
  if (!question) throw fail(400, 'Ask something first.', 'empty');
  const history = (Array.isArray(body.history) ? body.history : []).slice(-8);
  const sources = (Array.isArray(body.sources) ? body.sources : []).slice(0, 6);
  let prompt = `QUESTION: ${question}\n\n`;
  if (history.length) {
    prompt += 'EARLIER IN THIS CHAT:\n';
    for (const m of history) prompt += (m?.user ? 'User: ' : 'Loom: ') + str(m?.text, 600) + '\n';
    prompt += '\n';
  }
  if (sources.length) {
    prompt += 'LIBRARY ITEMS:\n';
    sources.forEach((s, i) => {
      let text = s.summary ? `Summary: ${str(s.summary, 1200)}\n` : '';
      const takeaways = Array.isArray(s.takeaways) ? s.takeaways.filter((t) => typeof t === 'string').slice(0, 6) : [];
      if (takeaways.length) text += 'Takeaways: ' + takeaways.map((t) => t.slice(0, 300)).join(' | ') + '\n';
      text += str(s.text, 1500);
      prompt += `[${i + 1}] ${str(s.title, 200)} (${KINDS.has(s.kind) ? s.kind : 'note'}, saved ${str(s.date, 40)})\n${text}\n\n`;
    });
  } else {
    prompt += 'LIBRARY ITEMS: none matched this question.\n\n';
  }
  prompt += 'Answer the QUESTION in your own words in one to four short paragraphs. Use only the items that are relevant, '
    + 'cite them inline like [1], and don\'t repeat or list the items themselves.';
  const answer = await claude({ max_tokens: 1500, output_config: { effort: 'low' }, system: ASK_SYSTEM, messages: [{ role: 'user', content: prompt }] });
  return { answer };
}

// ---- Routes --------------------------------------------------------------------------------

export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const route = url.searchParams.get('route') || '';
  if (route === 'status' && req.method === 'GET') return send(res, 200, { loom: true, ai: aiEnabled });
  if (!sameSite(req)) return send(res, 403, { error: 'Forbidden' });
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  try {
    if (route === 'link' && req.method === 'GET') {
      if (overLimit(ip, 'link')) { res.setHeader('Retry-After', '30'); return send(res, 429, { error: 'Too many links at once. Try again shortly.', reason: 'rate_limited' }); }
      const target = url.searchParams.get('url') || '';
      if (target.length > 2048) return send(res, 413, { error: 'That link is too long.', reason: 'invalid' });
      return send(res, 200, await fetchLink(target));
    }
    if ((route === 'organize' || route === 'ask') && req.method === 'POST') {
      if (!String(req.headers['content-type']).startsWith('application/json')) return send(res, 415, { error: 'Send JSON.' });
      if (!aiEnabled) return send(res, 503, { error: 'Claude isn’t set up on this server.', reason: 'no_ai' });
      if (overLimit(ip, route)) {
        res.setHeader('Retry-After', '120');
        return send(res, 429, { error: 'Claude is busy for you right now. Try again in a couple of minutes.', reason: 'rate_limited' });
      }
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      return send(res, 200, route === 'organize' ? await organize(body) : await ask(body));
    }
    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
    // Errors from the Claude API carry its status; don't pass its message (or a 401) through.
    if (e instanceof Anthropic.APIError) return send(res, e.status === 429 || e.status === 529 ? 503 : 502, { error: 'Claude couldn’t answer just now. Try again in a moment.', reason: 'upstream' });
    send(res, status, { error: e.reason ? e.message : 'Something went wrong.', reason: e.reason || 'error' });
  }
}
