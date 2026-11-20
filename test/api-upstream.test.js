import { test } from 'node:test';
import assert from 'node:assert/strict';
import relay from '../api/relay.js';

function call(handler, url, ip) {
  const headers = { host: 'bollineni.co', 'x-forwarded-for': ip, 'sec-fetch-site': 'same-origin' };
  const res = {
    code: 0, headers: {}, data: null,
    status(c) { this.code = c; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
    json(d) { this.data = d; return this; },
    send(d) { this.data = d; return this; },
    end() { return this; },
  };
  return Promise.resolve(handler({ method: 'GET', url, headers }, res)).then(() => res);
}

function fakeFetch(status, landedUrl, body = '') {
  return async () => {
    const r = new Response(body, { status });
    if (landedUrl) Object.defineProperty(r, 'url', { value: landedUrl });
    return r;
  };
}




test('relay: a hung upstream answers 504 instead of holding the function open', async (t) => {
  process.env.VISOR_KEY = 'test-key';
  t.mock.method(globalThis, 'fetch', async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); });
  const res = await call(relay, '/api/relay?provider=visor&path=v1/listings', '10.0.0.4');
  assert.equal(res.code, 504);
});

test('relay: the upstream call carries an abort signal', async (t) => {
  process.env.VISOR_KEY = 'test-key';
  let signal;
  t.mock.method(globalThis, 'fetch', async (_u, opts) => { signal = opts.signal; return new Response('{}', { status: 200 }); });
  await call(relay, '/api/relay?provider=visor&path=v1/listings', '10.0.0.5');
  assert.ok(signal instanceof AbortSignal);
});
