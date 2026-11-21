# Sync end-to-end tests

Browser tests for site sync (`site/sync/kit.js` + `lib/sync.js`), written against Loom. Not run by
CI: they need Playwright browsers and a checkout of `bollineni-create/blank` beside this repo
(or `LOOM_WEB=/path/to/blank/web`).

```
npm i -D playwright && npx playwright install chromium webkit firefox
SITE=http://localhost:8787 node test/e2e/live.mjs   # local copy of the site, in-memory storage
node test/e2e/live.mjs                              # the real bollineni.co (erases what it syncs at the end)
node test/e2e/race.mjs                              # edit made while another device's changes apply
node test/e2e/hidden.mjs                            # background tab sends offline edits on reconnect
```

`live.mjs` runs four devices (desktop Chrome, iPhone 15 Pro/WebKit, Pixel 7, desktop Firefox) through
33 checks: join by typed code, shared link and pasted link; wrong code refused; photo, 7 MB file
byte-for-byte, 30 MB file kept local; offline edits/rename/delete; conflicting renames settle;
settings follow; reopen; delete; change code signs out a lost device; erase everything.
Last result on bollineni.co: 33/33 (Nov 21, 2026).

## Bugs these found (all fixed)
- File parts over the server's limit, so files over 3 MB never synced (#39).
- Safari Private Browsing / in-app browsers can't store Blobs in IndexedDB (blank #44).
- A video with no poster frame was rejected by every other device (blank #45).
- An edit made while a sync was being applied was recorded as synced and never sent (#41).
- Offline changes waited for focus or the next poll; background tabs skipped the reconnect (#41, #43).

## Adding another app
The kit is shared, so most checks carry over. Per app you need: the page path, how to add/edit/delete
a record from the page (Loom uses `Lib.addText`, `Lib.save`, `Lib.remove`), and how to read its
state back. Copy `live.mjs`, swap those calls, and keep the file checks only for apps that sync files.
Watch for app-specific `clean()` rules that reject fields an app writes (the video bug above).
