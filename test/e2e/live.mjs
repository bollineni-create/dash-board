// Live test of Loom sync on https://bollineni.co with four devices. Ends by erasing everything it synced.
import { chromium, webkit, firefox, devices } from 'playwright';
const SITE = process.env.SITE || 'https://bollineni.co';
if (process.env.SITE) await import('./server.mjs');
const LOOM = SITE + '/loom/';
const results = [];
const ok = (c, m) => { results.push([!!c, m]); console.log(c ? 'ok  ' : 'FAIL', m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Waits for fn to be true in the page, asking it to sync about every 5 s.
async function until(page, fn, arg, ms = 60000) {
  const end = Date.now() + ms; let k = 0;
  while (Date.now() < end) {
    if (await page.evaluate(fn, arg).catch(() => false)) return true;
    if (++k % 12 === 0) await page.evaluate(() => typeof LoomSync !== 'undefined' && LoomSync && LoomSync.status().on && LoomSync.engine.sync()).catch(() => {});
    await page.waitForTimeout(400);
  }
  return false;
}
const ready = (p) => until(p, () => typeof LoomSync !== 'undefined' && !!LoomSync && typeof Lib !== 'undefined' && Array.isArray(Lib.state?.items), null, 30000);
const titles = (p) => p.evaluate(() => Lib.state.items.map((i) => i.title || i.body || i.fileName));
const has = (p, text) => until(p, (t) => Lib.state.items.some((i) => (i.body || '').includes(t) || (i.title || '').includes(t)), text);
const hasNot = (p, text) => until(p, (t) => !Lib.state.items.some((i) => (i.body || '').includes(t) || (i.title || '').includes(t)), text);

const browsers = { chromium: await chromium.launch(), webkit: await webkit.launch(), firefox: await firefox.launch() };
async function device(name, type, profile) {
  const ctx = await browsers[type].newContext({ ...profile });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`  [${name}] page error:`, e.message));
  page.on('response', (r) => { if (r.url().includes('/sync/api/') && r.status() >= 500) console.log(`  [${name}] ${r.status()} ${r.url().slice(SITE.length)}`); });
  return { name, ctx, page };
}
const D1 = await device('Desktop Chrome', 'chromium', { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } });
const D2 = await device('iPhone 15 Pro', 'webkit', devices['iPhone 15 Pro']);
const D3 = await device('Pixel 7', 'chromium', devices['Pixel 7']);
const D4 = await device('Desktop Firefox', 'firefox', { ...devices['Desktop Firefox'], ignoreHTTPSErrors: true });
const all = [D1, D2, D3, D4];
let code = null;

try {
  for (const d of [D1, D2]) { await d.page.goto(LOOM); ok(await ready(d.page), `${d.name}: Loom loads with sync available`); }

  // 1. Desktop builds a library: note, photo, 7 MB file, 30 MB file (over the 25 MB file limit), a space.
  const ids = await D1.page.evaluate(async () => {
    const pattern = (n, seed) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 255; return b; };
    const note = await Lib.addText('LIVE-TEST desk note: sourdough peaks at 12 hours', '');
    const c = document.createElement('canvas'); c.width = 1200; c.height = 900; const g = c.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 1200, 900); grd.addColorStop(0, '#e07a52'); grd.addColorStop(1, '#1b1411'); g.fillStyle = grd; g.fillRect(0, 0, 1200, 900);
    const jpg = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    const img = await Lib.addFile(new File([jpg], 'sunset.jpg', { type: 'image/jpeg' }), '');
    const mid = await Lib.addFile(new File([pattern(7 * 1048576, 7)], 'report.pdf', { type: 'application/pdf' }), '');
    const huge = await Lib.addFile(new File([pattern(30 * 1048576, 3)], 'video.mov', { type: 'video/quicktime' }), '');
    const sp = await Lib.addSpace('📚', 'LIVE-TEST space');
    return { note: note.id, img: img.id, mid: mid.id, huge: huge.id, space: sp.id, jpgSize: jpg.size };
  });
  code = await D1.page.evaluate(() => BollineniSync.turnOn());
  ok(/^[0-9A-Z]{25}$/.test(code), 'Desktop turns sync on and gets a code');
  ok(await until(D1.page, (i) => LoomSync.synced(i.img) && LoomSync.synced(i.mid), ids, 90000), 'Desktop uploads the photo and the 7 MB file');
  ok(await D1.page.evaluate((i) => !LoomSync.synced(i.huge) && Lib.byId.has(i.huge), ids), 'the 30 MB file stays on the desktop only (over the 25 MB limit), no error');

  // 2. iPhone: has its own note; a wrong code is refused; joins by typing the code sloppily.
  await D2.page.evaluate(() => Lib.addText('LIVE-TEST phone note: call the bakery', ''));
  const wrong = await D2.page.evaluate(() => BollineniSync.link('7777777777777777777777777').then(() => 'linked', (e) => e.message));
  ok(wrong !== 'linked', `iPhone: a wrong code is refused ("${wrong}")`);
  const sloppy = code.toLowerCase().replace(/(.{5})/g, '$1 ').replace(/0/g, 'o').replace(/1/g, 'l');
  await D2.page.evaluate((c) => BollineniSync.link(c), sloppy);
  ok(await has(D2.page, 'sourdough') && await until(D2.page, (i) => Lib.byId.has(i.img) && Lib.byId.has(i.mid) && Lib.byId.has(i.huge) && Lib.state.spaces.some((s) => s.id === i.space), ids), 'iPhone joins with the code typed in lowercase with spaces and O/l mix-ups, and gets every item and the space');
  ok(await until(D2.page, async (i) => (await DB.get('blobs', i.mid))?.size === 7 * 1048576, ids, 90000), 'iPhone downloads the 7 MB file');
  ok(await D2.page.evaluate(async (i) => { const b = new Uint8Array(await (await DB.get('blobs', i.mid)).arrayBuffer()); for (let k = 0; k < b.length; k += 997) if (b[k] !== ((k * 31 + 7) & 255)) return false; return true; }, ids), '…byte for byte');
  ok(await until(D2.page, async (i) => (await DB.get('blobs', i.img))?.size === i.jpgSize && !!Lib.byId.get(i.img).thumb, ids), 'iPhone gets the photo and builds its thumbnail');
  ok(await D2.page.evaluate(async (i) => !(await DB.get('blobs', i.huge)) && Lib.byId.get(i.huge)?.fileName === 'video.mov', ids), 'iPhone lists the 30 MB video by name without its file (expected)');
  ok(await has(D1.page, 'call the bakery'), 'Desktop gets the phone’s own note (libraries merge, nothing overwritten)');

  // 3. Android joins from a shared link (bollineni.co/#link=CODE), then opens Loom.
  await D3.page.goto(`${SITE}/#link=${code}`);
  ok(await until(D3.page, () => !location.hash.includes('link') && !!window.BollineniSync?.site.code(), null, 30000), 'Android: opening the shared link links the device and takes the code out of the address bar');
  await D3.page.goto(LOOM); await ready(D3.page);
  ok(await has(D3.page, 'sourdough') && await has(D3.page, 'call the bakery'), 'Android opens Loom and already has both devices’ notes');
  ok(await until(D3.page, async (i) => (await DB.get('blobs', i.img))?.size === i.jpgSize, ids), 'Android gets the photo');

  // 4. Firefox joins by pasting the whole link.
  await D4.page.goto(LOOM); await ready(D4.page);
  await D4.page.evaluate((c) => BollineniSync.link(`https://bollineni.co/#link=${c.replace(/(.{5})(?=.)/g, '$1-')}`), code);
  ok(await has(D4.page, 'sourdough') && await until(D4.page, async (i) => (await DB.get('blobs', i.mid))?.size === 7 * 1048576, ids, 90000), 'Firefox joins by pasting the link and gets the library and the 7 MB file');

  // 5. iPhone goes offline (subway): adds a note, renames the photo, deletes the desk note.
  //    Meanwhile the desktop adds its own note. Back online, everything lands everywhere.
  await D2.ctx.setOffline(true);
  await D2.page.evaluate(async (i) => {
    await Lib.addText('LIVE-TEST written offline on the subway', '');
    const it = Lib.byId.get(i.img); it.title = 'LIVE-TEST renamed offline'; it.titleEdited = true; await Lib.save(it);
    await Lib.remove(i.note);
  }, ids);
  await D2.page.waitForTimeout(4000);
  ok(await D2.page.evaluate(() => LoomSync.status().phase !== 'syncing'), 'iPhone offline: edits stay on the phone, Loom keeps working');
  await D1.page.evaluate(() => Lib.addText('LIVE-TEST desk while phone offline', ''));
  await D1.page.waitForTimeout(4000);
  await D2.ctx.setOffline(false);
  await D2.page.evaluate(() => window.dispatchEvent(new Event('online')));
  for (const d of [D1, D3, D4]) {
    ok(await has(d.page, 'written offline on the subway') && await has(d.page, 'renamed offline') && await hasNot(d.page, 'sourdough'), `${d.name}: gets the iPhone’s offline note, rename and delete after it reconnects`);
  }
  ok(await has(D2.page, 'desk while phone offline'), 'iPhone gets the note the desktop wrote while it was offline');

  // 6. Same item renamed on two devices at nearly the same time: every device settles on one name.
  await Promise.all([
    D1.page.evaluate((i) => { const it = Lib.byId.get(i.mid); it.title = 'LIVE-TEST name from desk'; it.titleEdited = true; return Lib.save(it); }, ids),
    D3.page.evaluate((i) => { const it = Lib.byId.get(i.mid); it.title = 'LIVE-TEST name from android'; it.titleEdited = true; return Lib.save(it); }, ids),
  ]);
  await sleep(8000);
  const settled = async () => { const n = await Promise.all(all.map((d) => d.page.evaluate((i) => Lib.byId.get(i.mid)?.title, ids))); return new Set(n).size === 1 ? n[0] : null; };
  let name = null; for (let k = 0; k < 15 && !name; k++) { for (const d of all) await d.page.evaluate(() => LoomSync.engine.sync()).catch(() => {}); await sleep(3000); name = await settled(); }
  ok(!!name && name.startsWith('LIVE-TEST name from'), `a conflicting rename settles on one name on all four devices ("${name}")`);

  // 7. Theme changed on the desktop follows to the phone.
  await D1.page.evaluate(() => Lib.saveSettings({ theme: 'dark' }));
  ok(await until(D2.page, () => Lib.state.settings.theme === 'dark'), 'a settings change (dark theme) follows to the iPhone');

  // 8. Closing and reopening the app on Android: still linked, everything still there, files included.
  await D3.page.close(); D3.page = await D3.ctx.newPage(); await D3.page.goto(LOOM); await ready(D3.page);
  ok(await until(D3.page, async (i) => LoomSync.status().on && Lib.byId.has(i.mid) && !!(await DB.get('blobs', i.img)), ids, 20000), 'Android after closing and reopening the app: still synced, library and photo still there');

  // 9. Delete a file item on the desktop: it disappears everywhere and its file parts are removed later.
  await D1.page.evaluate((i) => Lib.remove(i.mid), ids);
  for (const d of [D2, D3, D4]) ok(await until(d.page, (i) => !Lib.byId.has(i.mid), ids), `${d.name}: the deleted 7 MB file disappears`);

  // 10. Lost Firefox laptop: change the code from the desktop. Firefox stops syncing; re-link the others with the new code.
  const oldCode = code;
  code = await D1.page.evaluate(() => BollineniSync.changeCode());
  ok(code && code !== oldCode, 'Desktop changes the code (for a lost device)');
  await D1.page.evaluate(() => Lib.addText('LIVE-TEST after the code changed', ''));
  ok(await until(D4.page, () => !LoomSync.status().on, null, 60000), 'Firefox (the "lost" device) is signed out');
  ok(await D4.page.evaluate(() => Lib.state.items.length > 0) && !(await D4.page.evaluate(() => Lib.state.items.some((i) => (i.body || '').includes('after the code changed')))), '…keeps what it had, and gets nothing new');
  await D2.page.evaluate((c) => BollineniSync.link(c), code);
  const relinked = await has(D2.page, 'after the code changed') && await D2.page.evaluate((i) => !!Lib.byId.get(i.img), ids);
  if (!relinked) console.log('   server', await D2.page.evaluate(async (c) => { const f = await BollineniSync.readDoc(c, 'loom'); const items = f?.doc?.c?.items || {}; return JSON.stringify({ version: f?.version, n: Object.keys(items).length, note: Object.values(items).filter((e) => JSON.stringify(e).includes('after the code')).map((e) => ({ t: e.t, x: e.x || 0 })) }); }, code), 'iphoneVer', await D2.page.evaluate(() => JSON.stringify(LoomSync.engine.doc()?.c?.items ? Object.values(LoomSync.engine.doc().c.items).filter((e) => JSON.stringify(e).includes('after the code')).map((e) => ({ t: e.t, x: e.x || 0 })) : null)));
  if (!relinked) console.log('   diag', await D2.page.evaluate((i) => JSON.stringify({ st: LoomSync.status(), site: BollineniSync.site.code(), img: !!Lib.byId.get(i.img), n: Lib.state.items.length, texts: Lib.state.items.map((x) => (x.body || x.title || '').slice(0, 30)) }), ids), 'desk:', await D1.page.evaluate(() => JSON.stringify({ st: LoomSync.status(), has: Lib.state.items.some((x) => (x.body || '').includes('after the code')) })));
  ok(relinked, 'iPhone re-links with the new code and the photo is still readable');

  // 11. Erase everything from the desktop: the others stop syncing and keep their library.
  await D1.page.evaluate(() => BollineniSync.eraseAll());
  code = null;
  ok(await until(D2.page, () => !LoomSync.status().on, null, 60000) && await D2.page.evaluate(() => Lib.state.items.length > 0), 'Erase: the iPhone stops syncing and keeps its library');
  ok(await D1.page.evaluate(() => !LoomSync.status().on && Lib.state.items.length > 0), 'Erase: the desktop keeps its library too');
} catch (e) {
  ok(false, 'test crashed: ' + e.message.split('\n')[0]);
} finally {
  if (code) await D1.page.evaluate(() => BollineniSync.eraseAll()).catch(() => {});
  for (const b of Object.values(browsers)) await b.close();
  const failed = results.filter((r) => !r[0]);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}
