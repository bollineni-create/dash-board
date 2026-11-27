import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { telemetryConfig, installTelemetry } from '../lib/telemetry.js';

const DSN = 'https://0123456789abcdef0123456789abcdef@o1.ingest.us.sentry.io/42';

test('off with no keys', () => {
  const cfg = telemetryConfig({ VERCEL_ENV: 'production' });
  assert.equal(cfg.posthog, null);
  assert.equal(cfg.sentry, null);
  const out = mkdtempSync(join(tmpdir(), 'tel-'));
  writeFileSync(join(out, 'index.html'), '<html><head></head></html>');
  assert.equal(installTelemetry(out, cfg), 0);
  assert.equal(readFileSync(join(out, 'index.html'), 'utf8'), '<html><head></head></html>');
});

test('PostHog only in production, and only a real key', () => {
  assert.equal(telemetryConfig({ VERCEL_ENV: 'preview', NEXT_PUBLIC_POSTHOG_KEY: 'phc_abc' }).posthog, null);
  assert.equal(telemetryConfig({ VERCEL_ENV: 'production', NEXT_PUBLIC_POSTHOG_KEY: 'nope' }).posthog, null);
  assert.deepEqual(telemetryConfig({ VERCEL_ENV: 'production', NEXT_PUBLIC_POSTHOG_KEY: 'phc_abc', NEXT_PUBLIC_POSTHOG_HOST: 'https://eu.i.posthog.com/' }).posthog,
    { key: 'phc_abc', host: 'https://eu.i.posthog.com' });
});

test('Sentry reads the public key from the DSN, and ignores junk', () => {
  assert.deepEqual(telemetryConfig({ SENTRY_DSN: DSN }).sentry, { publicKey: '0123456789abcdef0123456789abcdef' });
  assert.equal(telemetryConfig({ SENTRY_DSN: 'not a dsn' }).sentry, null);
});

test('tags every page once, in order', () => {
  const out = mkdtempSync(join(tmpdir(), 'tel-'));
  mkdirSync(join(out, 'gridline'));
  writeFileSync(join(out, 'index.html'), '<html><HEAD><title>x</title></HEAD></html>');
  writeFileSync(join(out, 'gridline/index.html'), '<html><head></head><body></body></html>');
  const cfg = telemetryConfig({ VERCEL_ENV: 'production', POSTHOG_KEY: 'phc_abc', SENTRY_DSN: DSN });
  assert.equal(installTelemetry(out, cfg), 2);
  assert.equal(installTelemetry(out, cfg), 0, 'second run adds nothing');
  const html = readFileSync(join(out, 'gridline/index.html'), 'utf8');
  const order = ['/vendor/posthog.js', '/vendor/telemetry.js', 'js.sentry-cdn.com'].map((s) => html.indexOf(s));
  assert.ok(order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1])), html);
  assert.ok(existsSync(join(out, 'vendor/posthog.js')));
  assert.match(readFileSync(join(out, 'vendor/telemetry.js'), 'utf8'), /window\.sentryOnLoad/);
});
