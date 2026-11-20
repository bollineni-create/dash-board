import { test } from 'node:test';
import assert from 'node:assert/strict';
import rounds from '../api/rounds.js';
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

test('rounds: a bare 404 on a subreddit feed is a retryable refusal, not "doesn\'t exist"', async (t) => {
  t.mock.method(globalThis, 'fetch', fakeFetch(404, 'https://www.reddit.com/r/medicalschool/top/.rss'));
  const res = await call(rounds, '/api/rounds?route=top&sub=medicalschool&t=month&limit=100', '10.0.0.1');
  assert.equal(res.code, 503);
  assert.equal(res.data.reason, 'unavailable');
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('rounds: a redirect to subreddit search still means the subreddit does not exist', async (t) => {
  t.mock.method(globalThis, 'fetch', fakeFetch(200, 'https://www.reddit.com/subreddits/search/.rss?q=nosuchsubzz'));
  const res = await call(rounds, '/api/rounds?route=top&sub=nosuchsubzz&t=month', '10.0.0.2');
  assert.equal(res.code, 404);
  assert.equal(res.data.reason, 'not_found');
});

test('rounds: a 404 on a thread still means the thread is gone', async (t) => {
  t.mock.method(globalThis, 'fetch', fakeFetch(404, 'https://www.reddit.com/comments/abc123/.rss'));
  const res = await call(rounds, '/api/rounds?route=comments&id=abc123', '10.0.0.3');
  assert.equal(res.code, 404);
});

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
