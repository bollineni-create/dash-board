import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APPS, FILES, createHandler, makeStore, pathFor, plainVersion, validId } from '../lib/sync.js';

// A store kept in memory that behaves like the Blob store: versions change on every write, and
// a write whose ifMatch (a version, or null for "nothing there yet") doesn't hold is refused.
const clock = { t: Date.now() };
function memoryBlob() {
  const files = new Map();
  let n = 0;
  return {
    files,
    async read(path) { const f = files.get(path); return f ? { text: f.text, version: f.version, writtenAt: f.writtenAt } : null; },
    async write(path, text, { ifMatch }) {
      const f = files.get(path);
      if (ifMatch ? !f || f.version !== ifMatch : !!f) throw Object.assign(new Error('precondition'), { conflict: true });
      const version = `"v${++n}"`;
      files.set(path, { text, version, writtenAt: clock.t });
      return { version };
    },
    async remove(path) { files.delete(path); },
    async put(path, text) { files.set(path, { text, version: `"v${++n}"`, writtenAt: clock.t }); },
    async list(prefix) { return [...files.keys()].filter((p) => p.startsWith(prefix)); },
    async removeMany(paths) { for (const p of paths) files.delete(p); },
  };
}

const ID = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

function call(handler, { method = 'GET', route = 'gridline', id = ID, body, site = 'same-origin', ip = '1.1.1.1', query = '' } = {}) {
  const headers = { host: 'bollineni.co', 'x-forwarded-for': ip };
  if (site) headers['sec-fetch-site'] = site;
  if (id) headers.authorization = 'Bearer ' + id;
  const res = {
    code: 0, headers: {}, data: null,
    status(c) { this.code = c; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
    json(d) { this.data = d; return this; },
  };
  return handler({ method, url: `/api/sync?route=${route}${query}`, headers, body }, res).then(() => res);
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
  assert.deepEqual(on.data, { sync: true, apps: ['gridline', 'loom'] });
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

test('a save that loses a race while writing over a missing file still gets the other save back', async () => {
  const blob = memoryBlob();
  const handler = createHandler(makeStore(blob, 'production'));
  const path = pathFor('production', ID, 'gridline');
  // Another device saves between this one's refused write and its second try.
  const write = blob.write;
  let raced = false;
  blob.write = async (p, text, opts) => {
    if (opts.ifMatch === null && !raced && blob.files.size === 0 && text.includes('late')) {
      raced = true;
      await write(p, JSON.stringify({ payload: 'theirs', updatedAt: 'now' }), { ifMatch: null });
    }
    return write(p, text, opts);
  };
  const lost = await call(handler, { method: 'PUT', body: { payload: 'late', base: '"gone"' } });
  assert.equal(lost.code, 409);
  assert.equal(lost.data.current.payload, 'theirs');
  assert.equal(JSON.parse(blob.files.get(path).text).payload, 'theirs');
  // A file that stays unreadable and keeps changing is given up on as a conflict, not a storage failure.
  blob.write = async () => { blob.files.set(path, { text: 'junk', version: `"j${Math.random()}"` }); throw Object.assign(new Error('pre'), { conflict: true }); };
  const stuck = await call(handler, { method: 'PUT', id: ID, body: { payload: 'x', base: null } });
  assert.equal(stuck.code, 409);
  assert.equal(stuck.data.current, undefined);
});

test('a save still being read is written again before it expires, and one nobody reads is left to expire', async () => {
  const blob = memoryBlob();
  const day = 86_400_000;
  const handler = createHandler(makeStore(blob, 'production', () => clock.t));
  const path = pathFor('production', ID, 'gridline');
  await call(handler, { method: 'PUT', body: { payload: 'kept', base: null } });
  const written = blob.files.get(path).writtenAt;
  clock.t = written + 100 * day;
  await call(handler);
  assert.equal(blob.files.get(path).writtenAt, written, 'a recent file is left alone');
  clock.t = written + 181 * day;
  const read = await call(handler);
  assert.equal(read.data.payload, 'kept');
  assert.equal(blob.files.get(path).writtenAt, clock.t);
  assert.equal(read.data.version, blob.files.get(path).version, 'the device is told the version it now has');
  assert.equal(JSON.parse(blob.files.get(path).text).payload, 'kept');
  clock.t = Date.now();
});

test('an address that has used up its new codes can still save to an old file about to be renewed', async () => {
  const blob = memoryBlob();
  const handler = createHandler(makeStore(blob, 'production', () => clock.t));
  const ip = '4.4.4.4';
  const code = (n) => (0xabc000 + n).toString(16).padStart(64, '0');
  const mine = await call(handler, { method: 'PUT', ip, id: code(0), body: { payload: 'x', base: null } });
  for (let n = 1; n < 6; n++) await call(handler, { method: 'PUT', ip, id: code(n), body: { payload: 'x', base: null } });
  blob.files.get(pathFor('production', code(0), 'gridline')).writtenAt = clock.t - 200 * 86_400_000;
  // The limit's look at the file must not renew it, or this save's version would be out of date.
  const saved = await call(handler, { method: 'PUT', ip, id: code(0), body: { payload: 'y', base: mine.data.version } });
  assert.equal(saved.code, 200);
});

test('one address can start only a few new codes an hour, and its existing saves keep working', async () => {
  const handler = createHandler(makeStore(memoryBlob(), 'production'));
  const ip = '7.7.7.7';
  const code = (n) => n.toString(16).padStart(64, '0');
  const first = await call(handler, { method: 'PUT', ip, id: code(0), body: { payload: 'x', base: null } });
  for (let n = 1; n < 6; n++) assert.equal((await call(handler, { method: 'PUT', ip, id: code(n), body: { payload: 'x', base: null } })).code, 200);
  const seventh = await call(handler, { method: 'PUT', ip, id: code(6), body: { payload: 'x', base: null } });
  assert.equal(seventh.code, 429);
  assert.equal(seventh.headers['Retry-After'], '3600');
  // Naming a version doesn't get a new file past the limit either.
  assert.equal((await call(handler, { method: 'PUT', ip, id: code(7), body: { payload: 'x', base: '"made up"' } })).code, 429);
  // Saves to a code that already exists are not new codes.
  assert.equal((await call(handler, { method: 'PUT', ip, id: code(0), body: { payload: 'y', base: first.data.version } })).code, 200);
  assert.equal(first.data.created, undefined);
  // Another address is unaffected.
  assert.equal((await call(handler, { method: 'PUT', ip: '8.8.8.8', id: code(8), body: { payload: 'x', base: null } })).code, 200);
  // Sent all at once, a burst gets no more than the same six.
  const burst = await Promise.all(Array.from({ length: 12 }, (_, n) => call(handler, { method: 'PUT', ip: '6.6.6.6', id: code(100 + n), body: { payload: 'x', base: n % 2 ? null : '"made up"' } })));
  assert.equal(burst.filter((r) => r.code === 200).length, 6);
  assert.equal(burst.filter((r) => r.code === 429).length, 6);
  // Conflicts and saves to existing codes hand their count back, so they never use up the six.
  const own = await call(handler, { method: 'PUT', ip: '5.5.5.5', id: code(200), body: { payload: 'x', base: null } });
  for (let n = 0; n < 10; n++) {
    assert.equal((await call(handler, { method: 'PUT', ip: '5.5.5.5', id: code(200), body: { payload: 'y', base: '"stale"' } })).code, 409);
  }
  let version = own.data.version;
  for (let n = 0; n < 10; n++) version = (await call(handler, { method: 'PUT', ip: '5.5.5.5', id: code(200), body: { payload: 'z' + n, base: version } })).data.version;
  for (let n = 1; n < 6; n++) assert.equal((await call(handler, { method: 'PUT', ip: '5.5.5.5', id: code(200 + n), body: { payload: 'x', base: null } })).code, 200);
});

test('a version read back marked weak still works for the next save', async () => {
  // Like the real store: writes answer "abc", reads of larger files answer W/"abc", and a
  // conditional write accepts only the plain form.
  const blob = memoryBlob();
  const read = blob.read;
  blob.read = async (path) => { const f = await read(path); return f && f.text.length > 100 ? { ...f, version: 'W/' + f.version } : f; };
  const handler = createHandler(makeStore(blob, 'production', () => clock.t));
  const big = 'x'.repeat(500);
  const first = await call(handler, { method: 'PUT', body: { payload: big, base: null } });
  const got = await call(handler);
  assert.equal(got.data.version, first.data.version);
  assert.ok(!got.data.version.startsWith('W/'));
  // A second device saves from the version it read, and one still holding a weak version can too.
  const second = await call(handler, { method: 'PUT', body: { payload: big + '2', base: got.data.version } });
  assert.equal(second.code, 200);
  assert.equal((await call(handler, { method: 'PUT', body: { payload: big + '3', base: 'W/' + second.data.version } })).code, 200);
  // A stale save is told the current version in the form it can use.
  const stale = await call(handler, { method: 'PUT', body: { payload: 'late', base: first.data.version } });
  assert.equal(stale.code, 409);
  assert.ok(!stale.data.current.version.startsWith('W/'));
  assert.equal((await call(handler, { method: 'PUT', body: { payload: 'merged', base: stale.data.current.version } })).code, 200);
  // An old file is renewed from a weak version as well.
  const path = pathFor('production', ID, 'gridline');
  blob.files.set(path, { ...blob.files.get(path), text: JSON.stringify({ payload: big, updatedAt: 'x' }), writtenAt: clock.t - 200 * 86_400_000 });
  const renewed = await call(handler);
  assert.equal(blob.files.get(path).writtenAt, clock.t);
  assert.equal(renewed.data.version, blob.files.get(path).version);
  assert.equal(plainVersion('W/"a"'), '"a"');
  assert.equal(plainVersion(null), null);
});

// ---- Loom: library and files ---------------------------------------------------------------

const FILE = '0f8a3c2e-1b4d-4e5f-9a6b-7c8d9e0f1a2b';
const chunk = (c, extra = {}) => ({ route: 'loom-files', query: `&f=${FILE}&c=${c}`, ...extra });

test('Loom syncs, with room for a whole library', async () => {
  assert.ok(APPS.loom > 1_000_000 && APPS.loom < 4_500_000);
  const handler = createHandler(makeStore(memoryBlob(), 'production'));
  const status = await call(handler, { route: 'status' });
  assert.ok(status.data.apps.includes('loom'));
  const big = 'x'.repeat(2_000_000);
  assert.equal((await call(handler, { method: 'PUT', route: 'loom', body: { payload: big, base: null } })).code, 200);
  assert.equal((await call(handler, { route: 'loom' })).data.payload, big);
});

test("a file's chunks are stored and read back, but only under a code that has a save", async () => {
  const blob = memoryBlob();
  const handler = createHandler(makeStore(blob, 'production'));
  assert.equal((await call(handler, { method: 'PUT', ...chunk(0, { body: { data: 'QUJD' } }) })).code, 404);
  await call(handler, { method: 'PUT', route: 'loom', body: { payload: 'lib', base: null } });
  assert.equal((await call(handler, { method: 'PUT', ...chunk(0, { body: { data: 'QUJD' } }) })).code, 200);
  assert.equal((await call(handler, { method: 'PUT', ...chunk(1, { body: { data: 'REVG' } }) })).code, 200);
  // Sent twice (a retry after a dropped answer): lands on itself.
  assert.equal((await call(handler, { method: 'PUT', ...chunk(1, { body: { data: 'REVG' } }) })).code, 200);
  assert.equal((await call(handler, chunk(0))).data.data, 'QUJD');
  assert.equal((await call(handler, chunk(1))).data.data, 'REVG');
  assert.equal((await call(handler, chunk(2))).code, 404);
  // Another code sees nothing, and nothing in the store names the id or the file in the clear.
  assert.equal((await call(handler, chunk(0, { id: OTHER }))).code, 404);
  assert.ok([...blob.files.keys()].every((p) => !p.includes(ID)));
});

test('a bad file id, chunk number or chunk body is refused', async () => {
  const handler = createHandler(makeStore(memoryBlob(), 'production'));
  await call(handler, { method: 'PUT', route: 'loom', body: { payload: 'lib', base: null } });
  for (const query of ['&f=../x&c=0', '&f=short&c=0', `&f=${FILE}&c=-1`, `&f=${FILE}&c=${FILES.loom.chunks}`, `&f=${FILE}&c=1.5`, `&f=${FILE}&c=01`, `&f=${FILE}`]) {
    assert.equal((await call(handler, { route: 'loom-files', query })).code, 400, query);
  }
  assert.equal((await call(handler, { method: 'PUT', ...chunk(0, { body: { data: '<script>' } }) })).code, 400);
  assert.equal((await call(handler, { method: 'PUT', ...chunk(0, { body: { data: 'A'.repeat(FILES.loom.chunk + 4) } }) })).code, 413);
  assert.equal((await call(handler, { method: 'POST', ...chunk(0) })).code, 405);
  assert.equal((await call(handler, { ...chunk(0), id: null })).code, 401);
  assert.equal((await call(handler, { ...chunk(0), site: 'cross-site' })).code, 403);
});

test("deleting a file removes its chunks; erasing Loom's save removes every file", async () => {
  const blob = memoryBlob();
  const handler = createHandler(makeStore(blob, 'production'));
  await call(handler, { method: 'PUT', route: 'loom', body: { payload: 'lib', base: null } });
  const other = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  await call(handler, { method: 'PUT', ...chunk(0, { body: { data: 'QUJD' } }) });
  await call(handler, { method: 'PUT', route: 'loom-files', query: `&f=${other}&c=0`, body: { data: 'QUJD' } });
  assert.equal((await call(handler, { method: 'DELETE', route: 'loom-files', query: `&f=${FILE}` })).code, 200);
  assert.equal((await call(handler, chunk(0))).code, 404);
  assert.equal((await call(handler, { route: 'loom-files', query: `&f=${other}&c=0` })).code, 200);
  assert.equal((await call(handler, { method: 'DELETE', route: 'loom' })).code, 200);
  assert.equal(blob.files.size, 0);
});

test("a device that already has the latest version isn't sent it again", async () => {
  const handler = createHandler(makeStore(memoryBlob(), 'production'));
  const saved = await call(handler, { method: 'PUT', route: 'loom', body: { payload: 'lib', base: null } });
  const same = await call(handler, { route: 'loom', query: '&since=' + encodeURIComponent(saved.data.version) });
  assert.equal(same.data.unchanged, true);
  assert.equal(same.data.payload, undefined);
  const stale = await call(handler, { route: 'loom', query: '&since=' + encodeURIComponent('"old"') });
  assert.equal(stale.data.payload, 'lib');
});
