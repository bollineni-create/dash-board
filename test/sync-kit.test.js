import { test } from 'node:test';
import assert from 'node:assert/strict';

// The kit is a plain browser script; loaded here it puts itself on globalThis like it does on window.
await import('../site/sync/kit.js');
const Kit = globalThis.BollineniSync;

const cols = { items: { first: 'keep' }, prefs: { first: 'remote' } };

test('codes: typed, pasted or inside a link, they read the same', () => {
  const code = Kit.newCode();
  assert.equal(code.length, 25);
  assert.equal(Kit.normalizeCode(Kit.formatCode(code).toLowerCase()), code);
  assert.equal(Kit.normalizeCode(`https://bollineni.co/#link=${Kit.formatCode(code)}`), code);
  assert.equal(Kit.normalizeCode('nope'), null);
});

test('the id and key come from the code exactly as in Gridline, so its codes work everywhere', async () => {
  const code = '0123456789ABCDEFGHJKMNPQR';
  const a = await Kit.derive(code);
  // The same derivation, written out: HKDF-SHA256, salt "bollineni-sync", info "id/v1".
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('bollineni-sync'), info: new TextEncoder().encode('id/v1') }, material, 256);
  assert.equal(a.id, Buffer.from(bits).toString('hex'));
  const sealed = await Kit.seal(a.key, { hello: 'world' });
  assert.deepEqual(await Kit.open(a.key, sealed), { hello: 'world' });
  const other = await Kit.derive(Kit.newCode());
  await assert.rejects(Kit.open(other.key, sealed));
});

test('first sync: items join what is synced, settings give way to it', () => {
  const doc = Kit.emptyDoc();
  Kit.stamp(doc, null, { items: { a: { n: 1 } }, prefs: { theme: 'dark' } }, 1000, cols);
  assert.equal(doc.c.items.a.t, 1);
  assert.equal(doc.c.prefs.theme.t, 0);
  const remote = { v: 1, c: { items: { b: { d: { n: 2 }, t: 500 } }, prefs: { theme: { d: 'light', t: 400 } } } };
  const merged = Kit.merge(doc, remote, 2000);
  assert.deepEqual(Kit.view(merged, cols), { items: { a: { n: 1 }, b: { n: 2 } }, prefs: { theme: 'light' } });
});

test('later changes win item by item, and a deletion wins over an older edit', () => {
  const a = Kit.emptyDoc(), b = Kit.emptyDoc();
  const base = { items: { x: { v: 1 }, y: { v: 1 } }, prefs: {} };
  Kit.stamp(a, {}, base, 100, cols);
  Kit.stamp(b, {}, base, 100, cols);
  Kit.stamp(a, base, { items: { x: { v: 2 }, y: { v: 1 } }, prefs: {} }, 200, cols); // edit x on A
  Kit.stamp(b, base, { items: { x: { v: 1 } }, prefs: {} }, 300, cols); // delete y on B
  Kit.stamp(b, { items: { x: { v: 1 } }, prefs: {} }, { items: { x: { v: 3 } }, prefs: {} }, 150, cols); // older edit of x on B
  const m = Kit.merge(a, b, 400);
  assert.deepEqual(Kit.view(m, cols).items, { x: { v: 2 } });
  assert.equal(m.c.items.y.x, 1);
  // Old deletion markers are dropped after 90 days.
  assert.equal(Kit.merge(m, m, 300 + 91 * 86400000).c.items.y, undefined);
});

test('view runs every value through the app’s check and skips unsafe ids', () => {
  const doc = { v: 1, c: { items: { ok: { d: 'fine', t: 1 }, bad: { d: '<script>', t: 1 }, __proto__x: { d: 'x', t: 1 }, ['constructor']: { d: 'x', t: 1 } } } };
  const v = Kit.view(doc, { items: {} }, (c, val) => (val.includes('<') ? null : val));
  assert.deepEqual(Object.keys(v.items).sort(), ['__proto__x', 'ok']);
});

test('file entries are checked before a file is fetched', () => {
  assert.ok(Kit.validFile({ k: 'A'.repeat(43) + '=', b: 'a'.repeat(64), n: 2, size: 10, type: 'image/png' }));
  assert.ok(!Kit.validFile({ k: 'short', b: 'a'.repeat(64), n: 2, size: 10, type: '' }));
  assert.ok(!Kit.validFile({ k: 'A'.repeat(43) + '=', b: 'a'.repeat(64), n: 0, size: 10, type: '' }));
});
