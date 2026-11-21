// Local stand-in for bollineni.co: serves Loom at /loom/ and the real sync handler at /sync/api/*.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHandler, makeStore } from '../../lib/sync.js';

const files = new Map(); let n = 0;
export const blob = {
  files,
  async read(p) { const f = files.get(p); return f ? { text: f.text, version: f.version, writtenAt: f.at } : null; },
  async write(p, text, { ifMatch }) {
    const f = files.get(p);
    if (ifMatch ? !f || f.version !== ifMatch : !!f) throw Object.assign(new Error('precondition'), { conflict: true });
    const version = `"v${++n}"`; files.set(p, { text, version, at: Date.now() }); return { version };
  },
  async remove(p) { files.delete(p); },
  async put(p, text) { files.set(p, { text, version: `"v${++n}"`, at: Date.now() }); },
  async list(prefix) { return [...files.keys()].filter((k) => k.startsWith(prefix)); },
  async removeMany(ps) { for (const p of ps) files.delete(p); },
};
const sync = createHandler(makeStore(blob, 'test'));
const SITE_DIR = new URL('../../site', import.meta.url).pathname;
// Loom's web app: a checkout of bollineni-create/blank, its web/ folder (LOOM_WEB to override).
const ROOT = process.env.LOOM_WEB || new URL('../../../blank/web', import.meta.url).pathname;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ttf': 'font/ttf' };

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/sync/api/')) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    if (raw.length > 4.5e6) { res.writeHead(413); return res.end('{}'); }
    const q = new URLSearchParams(u.search); q.set('route', u.pathname.slice(10));
    const r = { method: req.method, url: '/api/sync?' + q, headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
    let code = 200; const hdr = {};
    const w = { status(c) { code = c; return w; }, setHeader(k, v) { hdr[k] = v; return w; }, json(d) { res.writeHead(code, { ...hdr, 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); return w; } };
    return sync(r, w);
  }
  if (u.pathname.startsWith('/sync/') && !u.pathname.startsWith('/sync/api/')) { const p = SITE_DIR + u.pathname; if (fs.existsSync(p)) { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(fs.readFileSync(p)); } }
  if (u.pathname === '/loom/api/status') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ai":false}'); }
  if (u.pathname.startsWith('/loom/')) {
    let p = path.join(ROOT, u.pathname.slice(6) || 'index.html');
    if (p.endsWith('/')) p += 'index.html';
    if (fs.existsSync(p) && fs.statSync(p).isFile()) { res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); return res.end(fs.readFileSync(p)); }
  }
  { const p = SITE_DIR + (u.pathname === '/' ? '/index.html' : u.pathname); if (fs.existsSync(p) && fs.statSync(p).isFile()) { res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'text/javascript' }); return res.end(fs.readFileSync(p)); } }
  res.writeHead(404); res.end('');
}).listen(8787, () => console.log('up'));
