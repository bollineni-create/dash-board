// A backgrounded tab that comes back online sends its offline edits without being focused.
import { chromium } from 'playwright';
await import('./server.mjs');
const b = await chromium.launch();
const A = await (await b.newContext()).newPage(); const Bc = await b.newContext(); const B = await Bc.newPage();
for (const p of [A, B]) { await p.goto('http://localhost:8787/loom/'); await p.waitForFunction(() => typeof LoomSync !== 'undefined' && LoomSync && typeof Lib !== 'undefined'); }
const code = await A.evaluate(() => BollineniSync.turnOn()); await A.waitForTimeout(3000);
await B.evaluate((c) => BollineniSync.link(c), code); await B.waitForTimeout(3000);
await Bc.setOffline(true);
await B.evaluate(() => Lib.addText('HIDDEN-TAB offline note', ''));
await B.waitForTimeout(3000);
await B.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); });
await Bc.setOffline(false); await B.evaluate(() => window.dispatchEvent(new Event('online')));
let got = false; for (let k = 0; k < 20 && !got; k++) { await A.waitForTimeout(500); if (k % 4 === 3) await A.evaluate(() => LoomSync.engine.sync()); got = await A.evaluate(() => Lib.state.items.some((i) => (i.body || '').includes('HIDDEN-TAB'))); }
console.log(got ? 'PASS' : 'FAIL', 'background tab sends offline edits on reconnect within 10 s');
await b.close(); process.exit();
