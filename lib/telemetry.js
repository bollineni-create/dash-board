// Analytics (PostHog) and error tracking (Sentry) on every page the build writes, the site's
// own and each app's. Each switches on only when its key is in the Vercel project's environment
// settings; with no keys the build adds nothing and the pages are exactly as before. Both keys
// are public client keys, read at build time and never committed.
//   PostHog: production only, so previews don't count as visitors. Every event carries `app`
//            (the first folder of the address: gridline, ballast, ... or home), so each app has its
//            own numbers. Typed input is masked in session replays.
//   Sentry:  all environments, tagged with the environment, the commit and the app.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const POSTHOG_KEYS = ['POSTHOG_KEY', 'NEXT_PUBLIC_POSTHOG_KEY', 'NEXT_PUBLIC_POSTHOG_PROJECT_API_KEY', 'POSTHOG_PROJECT_API_KEY', 'POSTHOG_PROJECT_TOKEN'];
const POSTHOG_HOSTS = ['POSTHOG_HOST', 'NEXT_PUBLIC_POSTHOG_HOST'];
const SENTRY_DSNS = ['SENTRY_DSN', 'NEXT_PUBLIC_SENTRY_DSN'];
const POSTHOG_LIB = 'node_modules/posthog-js/dist/array.full.js';

const first = (env, names) => names.map((n) => (env[n] || '').trim()).find(Boolean);

export function telemetryConfig(env = process.env) {
  const environment = env.VERCEL_ENV || 'development';
  const key = first(env, POSTHOG_KEYS);
  const host = (first(env, POSTHOG_HOSTS) || 'https://us.i.posthog.com').replace(/\/+$/, '');
  const posthog = environment === 'production' && key && /^phc_[A-Za-z0-9_-]+$/.test(key)
    && /^https:\/\/[a-z0-9.-]+$/i.test(host) ? { key, host } : null;
  let sentry = null;
  const dsn = first(env, SENTRY_DSNS);
  if (dsn) {
    try {
      const u = new URL(dsn);
      if (u.protocol === 'https:' && /^[a-f0-9]{32}$/.test(u.username)) sentry = { publicKey: u.username };
    } catch { /* not a DSN: leave Sentry off */ }
  }
  return { posthog, sentry, environment, release: env.VERCEL_GIT_COMMIT_SHA || null };
}

export function telemetryScript(cfg) {
  const c = JSON.stringify({ posthog: cfg.posthog, sentry: !!cfg.sentry, environment: cfg.environment, release: cfg.release })
    .replace(/</g, '\\u003c');
  return `(function () {
  var c = ${c};
  var app = location.pathname.split('/')[1] || 'home';
  if (c.sentry) window.sentryOnLoad = function () {
    Sentry.init({ environment: c.environment, release: c.release || undefined, sendDefaultPii: false, initialScope: { tags: { app: app } } });
  };
  if (c.posthog && window.posthog) window.posthog.init(c.posthog.key, {
    api_host: c.posthog.host, defaults: '2026-08-30', person_profiles: 'identified_only', respect_dnt: true,
    session_recording: { maskAllInputs: true },
    loaded: function (ph) { ph.register({ app: app }); }
  });
})();
`;
}

const htmlFiles = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? htmlFiles(p) : n.endsWith('.html') ? [p] : [];
});

// Writes /vendor/ into `out` and adds the script tags to every page there. Returns how many pages.
export function installTelemetry(out, cfg = telemetryConfig()) {
  if (!cfg.posthog && !cfg.sentry) return 0;
  mkdirSync(join(out, 'vendor'), { recursive: true });
  const script = telemetryScript(cfg);
  const v = createHash('sha256').update(script).digest('hex').slice(0, 12);
  writeFileSync(join(out, 'vendor/telemetry.js'), script);
  const tags = [];
  if (cfg.posthog) {
    if (!existsSync(POSTHOG_LIB)) throw new Error(`telemetry: ${POSTHOG_LIB} is missing; is posthog-js installed?`);
    const lib = readFileSync(POSTHOG_LIB);
    copyFileSync(POSTHOG_LIB, join(out, 'vendor/posthog.js'));
    tags.push(`<script defer src="/vendor/posthog.js?v=${createHash('sha256').update(lib).digest('hex').slice(0, 12)}"></script>`);
  }
  // Order matters: deferred scripts run in order, and telemetry.js must set sentryOnLoad before the loader runs.
  tags.push(`<script defer src="/vendor/telemetry.js?v=${v}"></script>`);
  if (cfg.sentry) tags.push(`<script defer src="https://js.sentry-cdn.com/${cfg.sentry.publicKey}.min.js" crossorigin="anonymous"></script>`);
  const block = tags.join('\n');
  let pages = 0;
  for (const f of htmlFiles(out)) {
    const html = readFileSync(f, 'utf8');
    const at = html.search(/<\/head>/i);
    if (at < 0 || html.includes('/vendor/telemetry.js')) continue;
    writeFileSync(f, html.slice(0, at) + block + '\n' + html.slice(at));
    pages++;
  }
  return pages;
}
