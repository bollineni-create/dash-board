// An edit made while a device is applying another device's changes must still sync.
import { chromium } from 'playwright';
await import('./server.mjs');
const URL_ = 'http://localhost:8787/loom/';
const b = await chromium.launch();
const A = await (await b.newContext()).newPage(), B = await (await b.newContext()).newPage();
for (const p of [A, B]) { await p.goto(URL_); await p.waitForFunction(() => typeof LoomSync !== 'undefined' && LoomSync && typeof Lib !== 'undefined'); }
await A.evaluate(async () => { for (let i = 0; i < 60; i++) await Lib.addText('bulk note ' + i, ''); });
const code = await A.evaluate(() => BollineniSync.turnOn());
await A.waitForFunction(() => LoomSync.status().syncedAt && LoomSync.status().phase === 'idle');
// B links, and adds a note the moment A's items start arriving (mid-apply).
const caught = await B.evaluate(async (c) => {
  BollineniSync.link(c);
  for (let k = 0; k < 2000; k++) { if (Lib.state.items.length > 0 || (await DB.all('items')).length > 0) break; await new Promise((r) => setTimeout(r, 5)); }
  await Lib.addText('MID-APPLY note from B', '');
  return Lib.state.items.length;
}, code);
let got = false;
for (let k = 0; k < 40 && !got; k++) { await A.waitForTimeout(500); if (k % 4 === 3) { await B.evaluate(() => LoomSync.engine.sync()).catch(() => {}); await A.evaluate(() => LoomSync.engine.sync()).catch(() => {}); } got = await A.evaluate(() => Lib.state.items.some((i) => (i.body || '').includes('MID-APPLY'))); }
const bHas = await B.evaluate(() => Lib.state.items.some((i) => (i.body || '').includes('MID-APPLY')));
console.log(got ? 'PASS' : 'FAIL', `edit made mid-apply reaches the other device (B had ${caught} items when it edited; B still has it: ${bHas})`);
// No ping-pong: once settled, repeated syncs don't keep writing new versions.
const ver = async () => (await A.evaluate((c) => BollineniSync.readDoc(c, 'loom'))).version ?? null;
for (const p of [A, B, A, B]) await p.evaluate(() => LoomSync.engine.sync());
const v1 = await A.evaluate((c) => BollineniSync.readDoc(c, 'loom').then((f) => f.version), code);
for (const p of [A, B, A, B, A, B]) await p.evaluate(() => LoomSync.engine.sync());
const v2 = await A.evaluate((c) => BollineniSync.readDoc(c, 'loom').then((f) => f.version), code);
console.log(v1 === v2 ? 'PASS' : 'FAIL', `settled devices stop writing (${v1} → ${v2})`);
await b.close(); process.exit();
