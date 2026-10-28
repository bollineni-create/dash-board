// Build: copy the launcher page into public/, then for every app in apps.json pull its
// code from GitHub at the commit in `commit` (a hand pin) or apps.lock.json (kept current by
// .github/workflows/sync-apps.yml), else the latest (or, with `path`, take it from this repo, as Loom's web version
// lives in apps/loom) into public/<id>/ and its icon into public/icons/. The launcher
// page gets the list of apps written into it, so apps.json is the one place to add an app.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { extname } from 'node:path';

const OUT = 'public', SRC = '.src';
const RESERVED = new Set(['api', 'icons']);
const apps = JSON.parse(readFileSync('apps.json', 'utf8'));
const lock = existsSync('apps.lock.json') ? JSON.parse(readFileSync('apps.lock.json', 'utf8')) : {};

const seen = new Set();
for (const a of apps) {
  for (const k of ['id', 'name', a.path ? 'path' : 'repo', 'icon', 'kind', 'pitch', 'tint', 'wash']) {
    if (!a[k]) throw new Error(`apps.json: "${a.id || a.name || '?'}" is missing "${k}".`);
  }
  if (!/^[a-z0-9-]+$/.test(a.id)) throw new Error(`apps.json: id "${a.id}" must be lowercase letters, digits and dashes.`);
  if (RESERVED.has(a.id) || seen.has(a.id)) throw new Error(`apps.json: id "${a.id}" is taken.`);
  seen.add(a.id);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(`${OUT}/icons`, { recursive: true });
cpSync('site', OUT, { recursive: true });

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const shelf = [];
for (const a of apps) {
  const dest = `${OUT}/${a.id}`;
  const src = a.path || `${SRC}/${a.id}`;
  if (!a.path) {
    rmSync(src, { recursive: true, force: true });
    const commit = a.commit || lock[a.id];
    if (commit) {
      const git = (...args) => execFileSync('git', ['-C', src, ...args], { stdio: 'inherit' });
      mkdirSync(src, { recursive: true });
      git('init', '-q');
      git('fetch', '-q', '--depth', '1', a.repo, commit);
      git('checkout', '-q', 'FETCH_HEAD');
    } else {
      execFileSync('git', ['clone', '--depth', '1', ...(a.branch ? ['--branch', a.branch] : []), a.repo, src], { stdio: 'inherit' });
    }
  }
  // `root` is the folder in the repo that holds the page (Ballast keeps it in public/).
  const base = a.root ? `${src}/${a.root}` : src;
  for (const p of a.files || ['index.html', 'css', 'js', 'assets']) {
    if (existsSync(`${base}/${p}`)) cpSync(`${base}/${p}`, `${dest}/${p}`, { recursive: true });
  }
  if (!existsSync(`${dest}/index.html`)) throw new Error(`${a.id}: no index.html after copying ${JSON.stringify(a.files)}.`);

  // Apps that call paid APIs get told which keys the server holds. Only names reach the
  // browser, never key values: the relay (api/relay.js) swaps in the real key.
  if (a.hostedConfig) {
    const { global, keys = {} } = a.hostedConfig;
    const serverKeys = {};
    for (const [provider, envName] of Object.entries(keys)) if (process.env[envName]) serverKeys[provider] = '__server__';
    writeFileSync(`${dest}/hosted-config.js`,
      `window.${global} = Object.assign(window.${global} || {}, { defaultKeys: ${JSON.stringify(serverKeys)} });\n`);
    const html = readFileSync(`${dest}/index.html`, 'utf8');
    const first = html.indexOf('<script');
    if (first < 0) throw new Error(`${a.id}: index.html has no script tag to put the hosted config before.`);
    writeFileSync(`${dest}/index.html`, html.slice(0, first) + '<script src="hosted-config.js"></script>\n  ' + html.slice(first));
    console.log(`${a.id}: server keys ${Object.keys(serverKeys).join(', ') || 'none'}`);
  }

  // Icons come straight from each app's repo, so they stay current.
  const icon = `icons/${a.id}${extname(a.icon)}`;
  cpSync(`${src}/${a.icon}`, `${OUT}/${icon}`);
  shelf.push({ id: a.id, name: a.name, icon, iconStyle: a.iconStyle || '', url: `/${a.id}/`, kind: a.kind,
    pitch: a.pitch, chips: a.chips || [], tint: a.tint, wash: a.wash, ownsEsc: !!a.ownsEsc });
}

const pagePath = `${OUT}/index.html`;
const page = readFileSync(pagePath, 'utf8');
if (!page.includes('/*APPS*/[]')) throw new Error('site/index.html: no /*APPS*/[] placeholder.');
writeFileSync(pagePath, page
  .replace('/*APPS*/[]', JSON.stringify(shelf).replace(/</g, '\\u003c'))
  .replaceAll('{{FAVICON}}', esc(shelf[0].icon))
  .replaceAll('{{APP_NAMES}}', esc(shelf.map((a) => a.name).join(', '))));

console.log(`Built ${shelf.length} apps: ${shelf.map((a) => a.id).join(', ')}`);
