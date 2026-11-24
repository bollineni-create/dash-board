import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler, { sanitize } from '../api/gridline.js';

function call(url, headers = {}) {
  const res = {
    code: 0, headers: {}, data: null,
    status(c) { this.code = c; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
    json(d) { this.data = d; return this; },
  };
  const h = { host: 'bollineni.co', 'x-forwarded-for': '10.1.1.1', 'sec-fetch-site': 'same-origin', ...headers };
  return Promise.resolve(handler({ method: 'GET', url, headers: h }, res)).then(() => res);
}

test('gridline ask: says when AI is off instead of failing', async () => {
  const s = await call('/api/gridline?route=status');
  assert.equal(s.code, 200);
  assert.equal(typeof s.data.ai, 'boolean');
  if (!s.data.ai) assert.equal((await call('/api/gridline?route=ask&q=reliable%20suv')).code, 503);
});

test('gridline ask: unknown routes are 404', async () => {
  assert.equal((await call('/api/gridline?route=nope')).code, 404);
});

test('gridline ask: sanitize drops values Gridline cannot use', () => {
  const s = sanitize({
    makes: ['Toyota', '', 'Toyota'], models: [{ make: 'Toyota', model: 'RAV4' }, { make: '', model: 'x' }],
    body: ['SUV', 'Spaceship'], fuel: ['Electric'], drivetrain: ['AWD'], transmission: [], condition: ['Used'],
    colors: ['Red', 'Plaid'], features: ['Third-Row Seating', 'Jetpack'], states: ['FL', 'ZZ'],
    yearMin: 2018, yearMax: 3000, priceMin: null, priceMax: 25000, milesMax: -5,
    nearMe: true, near: 'javascript:alert(1)', radius: 50, sort: 'price-asc', belowMarket: 'yes', note: 'Reliable SUVs', offTopic: false,
  });
  assert.deepEqual(s.makes, ['Toyota']);
  assert.deepEqual(s.models, [{ make: 'Toyota', model: 'RAV4' }]);
  assert.deepEqual(s.body, ['SUV']);
  assert.deepEqual(s.colors, ['Red']);
  assert.deepEqual(s.features, ['Third-Row Seating']);
  assert.deepEqual(s.states, ['FL']);
  assert.equal(s.yearMax, null);
  assert.equal(s.milesMax, null);
  assert.equal(s.near, null);
  assert.equal(s.belowMarket, false);
  assert.equal(s.priceMax, 25000);
  assert.equal(sanitize({ near: 'Denver, CO' }).near, 'Denver, CO');
});

test('gridline ask: the schema has no null inside an enum and stays under the union limit', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../api/gridline.js', import.meta.url), 'utf8');
  assert.ok(!/enum: \[[^\]]*null/.test(src), 'null inside an enum');
  assert.ok(!/type: \[/.test(src), 'type arrays');
  assert.ok((src.match(/anyOf/g) || []).length <= 16);
});
