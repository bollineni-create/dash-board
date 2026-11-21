// App icons arrive in two shapes: full-bleed squares (Gridline, Bridge) and squares drawn inside a
// transparent margin (Ballast, Loom, Palimpsest ship with ~10% padding on each side). In the launcher
// every icon sits in the same rounded tile, so a padded one looked a size smaller than its neighbours.
// iconFit reads the PNG's alpha channel, finds the box the opaque pixels fill, and returns the CSS
// transform that zooms that box up to fill the tile. Full-bleed icons and SVGs get ''.
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

// Alpha channel of a non-interlaced 8-bit PNG as { w, h, alpha: Uint8Array } (null if it has none).
export function pngAlpha(buf) {
  if (buf.toString('ascii', 1, 4) !== 'PNG') return null;
  let pos = 8, w, h, depth, type, interlace; const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), kind = buf.toString('ascii', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    pos += 12 + len;
  }
  const channels = { 4: 2, 6: 4 }[type]; // grey+alpha, RGBA. Other types have no alpha channel to trim.
  if (!channels || depth !== 8 || interlace) return null;
  const raw = inflateSync(Buffer.concat(idat)), stride = w * channels, out = new Uint8Array(w * h);
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0, b = prev[x], c = x >= channels ? prev[x - channels] : 0;
      let v = row[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = v & 255;
    }
    for (let x = 0; x < w; x++) out[y * w + x] = cur[x * channels + channels - 1];
    [prev, cur] = [cur, prev];
  }
  return { w, h, alpha: out };
}

// The box of pixels at least half opaque: [left, top, right, bottom), or null.
export function opaqueBox({ w, h, alpha }) {
  let l = w, t = h, r = -1, b = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (alpha[y * w + x] >= 128) {
    if (x < l) l = x; if (x > r) r = x; if (y < t) t = y; if (y > b) b = y;
  }
  return r < 0 ? null : [l, t, r + 1, b + 1];
}

// CSS for the icon's <img>: zoom its opaque square to fill the tile. '' when it already does.
export function iconFit(file) {
  if (!/\.png$/i.test(file)) return '';
  const img = pngAlpha(readFileSync(file));
  const box = img && opaqueBox(img);
  if (!box) return '';
  const [l, t, r, b] = box, bw = r - l, bh = b - t;
  if (bw / img.w > 0.97 && bh / img.h > 0.97) return '';          // full bleed already
  if (Math.abs(bw - bh) > Math.max(bw, bh) * 0.04) return '';     // not a square tile: leave it alone
  const scale = Math.min(img.w / bw, img.h / bh);
  // Centre of the opaque box, as a share of the image, moved to the centre of the tile.
  const dx = (0.5 - (l + r) / 2 / img.w) * 100, dy = (0.5 - (t + b) / 2 / img.h) * 100;
  const shift = Math.abs(dx) > 0.2 || Math.abs(dy) > 0.2 ? ` translate(${dx.toFixed(2)}%, ${dy.toFixed(2)}%)` : '';
  return `transform: scale(${scale.toFixed(3)})${shift}`;
}
