// Loom (web): shared helpers. Scripts are plain globals, loaded in order from index.html.
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Branch colours from the Mac app's map, one per concept.
const BRANCHES = ['#2a7471', '#c98a2b', '#4f78ad', '#a64d6c', '#6f8f3a', '#7a5cae', '#d06a3c', '#3a9aa6', '#8b6b4a', '#b84a4a'];
const branchColor = (key) => {
  let h = 0;
  for (const ch of String(key)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return BRANCHES[h % BRANCHES.length];
};

const KINDS = {
  note:  { label: 'Note',  plural: 'Notes',  color: '#b5502c', glyph: '✎' },
  link:  { label: 'Link',  plural: 'Links',  color: '#4f78ad', glyph: '↗' },
  image: { label: 'Image', plural: 'Images', color: '#a64d6c', glyph: '▣' },
  video: { label: 'Video', plural: 'Videos', color: '#7a5cae', glyph: '▶' },
  pdf:   { label: 'PDF',   plural: 'PDFs',   color: '#c98a2b', glyph: '▤' },
  file:  { label: 'File',  plural: 'Files',  color: '#8b6b4a', glyph: '◫' },
};

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

// Same order as Item.displayTitle in the Mac app.
function displayTitle(item) {
  if (item.title && item.title.trim()) return item.title.trim();
  const first = (item.body || '').split('\n').map((l) => l.trim()).find(Boolean);
  if (first) return first.length > 80 ? first.slice(0, 79) + '…' : first;
  if (item.fileName) return item.fileName;
  const host = hostOf(item.url);
  if (host) return host;
  return 'Untitled ' + (KINDS[item.kind]?.label || 'item').toLowerCase();
}

function relTime(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  if (s < 86400 * 7) return Math.floor(s / 86400) + ' d ago';
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

const fmtSize = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB';

let toastTimer;
function toast(msg, action) {
  const el = $('#toast');
  el.innerHTML = esc(msg);
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.onclick = () => { el.hidden = true; action.run(); };
    el.append(b);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? 6000 : 3200);
}

// Calls to this site's /loom/api routes. Errors carry the server's message and reason.
async function api(route, body, { signal } = {}) {
  const opts = body === undefined ? { signal } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal };
  let r;
  try { r = await fetch('/loom/api/' + route, opts); } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw Object.assign(new Error('You seem to be offline.'), { reason: 'offline' });
  }
  const data = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error(data?.error || `Request failed (${r.status}).`), { reason: data?.reason || 'error', status: r.status });
  return data;
}

// Grow a textarea to its content.
function autosize(el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1]);
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(blob);
  });
}

// Downscale an image blob; returns a JPEG blob (or a dataURL with asDataURL).
async function scaleImage(blob, max, quality = 0.85, asDataURL = false) {
  const bmp = await createImageBitmap(blob).catch(() => null);
  if (!bmp) return null;
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  if (asDataURL) return c.toDataURL('image/jpeg', quality);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', quality));
}

// First frame of a video as a small JPEG dataURL.
function videoThumb(blob, max = 400) {
  return new Promise((res) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(blob);
    const done = (out) => { URL.revokeObjectURL(url); res(out); };
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
    v.onloadeddata = () => { v.currentTime = Math.min(0.5, (v.duration || 1) / 3); };
    v.onseeked = () => {
      const k = Math.min(1, max / Math.max(v.videoWidth, v.videoHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(v.videoWidth * k)); c.height = Math.max(1, Math.round(v.videoHeight * k));
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      try { done(c.toDataURL('image/jpeg', 0.75)); } catch { done(''); }
    };
    v.onerror = () => done('');
    setTimeout(() => done(''), 8000);
  });
}
