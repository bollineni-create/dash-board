import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APPS, createHandler, makeStore, pathFor, validId } from '../lib/sync.js';

// A store kept in memory that behaves like the Blob store: versions change on every write, and
// a write whose ifMatch (a version, or null for "nothing there yet") doesn't hold is refused.
function memoryBlob() {
  const files = new Map();
  let n = 0;
  return {
    files,
    async read(path) { const f = files.get(path); return f ? { text: f.text, version: f.version } : null; },
    async write(path, text, { ifMatch }) {
      const f = files.get(path);
      if (ifMatch ? !f || f.version !== ifMatch : !!f) throw Object.assign(new Error('precondition'), { conflict: true });
      const version = `"v${++n}"`;
      files.set(path, { text, version });
      return { version };
    },
    async remove(path) { files.delete(path); },
  };
}

const ID = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

function call(handler, { method = 'GET', route = 'gridline', id = ID, body, site = 'same-origin', ip = '1.1.1.1' } = {}) {
  const headers = { host: 'bollineni.co', 'x-forwarded-for': ip };
  if (site) headers['sec-fetch-site'] = site;
  if (id) headers.authorization = 'Bearer ' + id;
  const res = {
    code: 0, headers: {}, data: null,
    status(c) { this.code = c; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
    json(d) { this.data = d; return this; },
  };
  return handler({ method, url: `/api/sync?route=${route}`, headers, body }, res).then(() => res);
}

test('an id is 64 lowercase hex characters and nothing else', () => {
  assert.ok(validId(ID));
  for (const bad of ['', 'a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64), ID + '/x', null, 12]) assert.ok(!validId(bad));
});

test("a file's name hides the id and keeps each environment and app apart", () => {
  const p = pathFor('production', ID, 'gridline');
  assert.match(p, /^production\/[0-9a-f]{64}\/gridline\.json$/);
  assert.ok(!p.includes(ID));
  assert.notEqual(p, pathFor('preview', ID, 'gridline'));
  assert.notEqual(p, pathFor('production', OTHER, 'gridline'));
});

test('a save is read back on another device, and each code sees only its own', async () => {
  const handler = createHandler(makeStore(memoryBlob(), 'production'));
  assert.equal((await call(handler)).code, 404);
  const saved = await call(handler, { method: 'PUT', body: { payload: 'cipher-1', base: null } });
  assert.equal(saved.code, 200);
  assert.equal(saved.headers['Cache-Control'], 'no-store');
  const read = await call(handler);
  assert.equal(read.code, 200);
  assert.equal(read.data.payload, 'cipher-1');
  assert.equal(read.data.version, saved.data.version);
  assert.equal((await call(handler, { id: OTHER })).code, 404);
});

test('a save made from an older version is refused with what is stored now', async () => {
  const handler = createHandler(makeStore(memoryBlob(), 'production'));
  const first = await call(handler, { method: 'PUT', body: { payload: 'one', base: null } });
  const second = await call(handler, { method: 'PUT', body: { payload: 'two', base: first.data.version } });
  assert.equal(second.code, 200);
  const stale = await call(handler, { method: 'PUT', body: { payload: 'three', base: first.data.version } });
  assert.equal(stale.code, 409);
  assert.equal(stale.data.reason, 'conflict');
  assert.deepEqual({ payload: stale.data.current.payload, version: stale.data.current.version }, { payload: 'two', version: second.data.version });
  // A device that has never synced meets an existing save the same way.
  const fresh = await call(handler, { method: 'PUT', body: { payload: 'four', base: null } });
  assert.equal(fresh.code, 409);
  assert.equal(fresh.data.current.payload, 'two');
  // Merged against the current version, the save goes through.
  assert.equal((await call(handler, { method: 'PUT', body: { payload: 'merged', base: second.data.version } })).code, 200);
});

test('a save whose version points at a file that is gone or unreadable is written anyway', async () => {
  const blob = memoryBlob();
  const handler = createHandler(makeStore(blob, 'production'));
  const first = await call(handler, { method: 'PUT', body: { payload: 'one', base: null } });
  await call(handler, { method: 'DELETE' });
  assert.equal((await call(handler, { method: 'PUT', body: { payload: 'again', base: first.data.version } })).code, 200);
  blob.files.set(pathFor('production', ID, 'gridline'), { text: 'not json', version: '"x"' });
  assert.equal((await call(handler)).code, 404);
  assert.equal((await call(handler, { method: 'PUT', body: { payload: 'fixed', base: null } })).code, 200);
  assert.equal((await call(handler)).data.payload, 'fixed');
});

test('erasing removes the save', async () => {
  const handler = createHandler(makeStore(memoryBlob(), 'production'));
  await call(handler, { method: 'PUT', body: { payload: 'one', base: null } });
  assert.equal((await call(handler, { method: 'DELETE' })).code, 200);
  assert.equal((await call(handler)).code, 404);
});

test('requests that are not from the site, have no valid code, or name no known app are turned away', async () => {
  const handler = createHandler(makeStore(memoryBlob(), 'production'));
  assert.equal((await call(handler, { site: 'cross-site' })).code, 403);
  assert.equal((await call(handler, { site: null })).code, 403);
  assert.equal((await call(handler, { id: null })).code, 401);
  assert.equal((await call(handler, { id: 'A'.repeat(64) })).code, 401);
  assert.equal((await call(handler, { route: 'nope' })).code, 404);
  assert.equal((await call(handler, { route: 'constructor' })).code, 404);
  assert.equal((await call(handler, { method: 'POST' })).code, 405);
});

test('a save that is malformed or too large is refused', async () => {
  const handler = createHandler(makeStore(memoryBlob(), 'production'));
  for (const body of [undefined, null, {}, { payload: '' }, { payload: 5 }, { payload: 'x', base: 7 }, 'not json']) {
    assert.equal((await call(handler, { method: 'PUT', body })).code, 400);
  }
  assert.equal((await call(handler, { method: 'PUT', body: JSON.stringify({ payload: 'as text' }) })).code, 200);
  assert.equal((await call(handler, { method: 'PUT', id: OTHER, body: { payload: 'x'.repeat(APPS.gridline + 1) } })).code, 413);
});

test('status says whether sync is set up, without a code', async () => {
  const on = await call(createHandler(makeStore(memoryBlob())), { route: 'status', id: null, site: null });
  assert.deepEqual(on.data, { sync: true, apps: ['gridline'] });
  const off = createHandler(null);
  assert.deepEqual((await call(off, { route: 'status', id: null, site: null })).data, { sync: false, apps: [] });
  assert.equal((await call(off)).code, 503);
});

test('one address cannot flood the route, and a storage failure is not blamed on the person', async () => {
  const handler = createHandler(makeStore(memoryBlob(), 'production'));
  let last;
  for (let i = 0; i < 41; i++) last = await call(handler, { method: 'PUT', ip: '9.9.9.9', body: { payload: 'x', base: 'nope' } });
  assert.equal(last.code, 429);
  assert.equal(last.headers['Retry-After'], '30');
  const broken = createHandler(makeStore({ read: async () => { throw new Error('down'); } }, 'production'));
  const err = console.error; console.error = () => {};
  try { assert.equal((await call(broken)).code, 502); } finally { console.error = err; }
});
