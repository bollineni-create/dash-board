import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stampAssets } from '../lib/stamp-assets.js';

test("an app's own scripts and stylesheets get the app's commit", () => {
  const html = '<link rel="stylesheet" href="css/app.css">\n<script src="js/core.js"></script>\n<script type="module" src=\'app.mjs\'></script>';
  assert.equal(stampAssets(html, 'abc1234'),
    '<link rel="stylesheet" href="css/app.css?v=abc1234">\n<script src="js/core.js?v=abc1234"></script>\n<script type="module" src=\'app.mjs?v=abc1234\'></script>');
});

test('a stamp the app put there itself is replaced, and other parameters and the fragment stay', () => {
  assert.equal(stampAssets('<script src="js/app.js?v=202610280450"></script>', 'abc1234'), '<script src="js/app.js?v=abc1234"></script>');
  assert.equal(stampAssets('<script src="js/app.js?mode=x&v=1#top"></script>', 'abc1234'), '<script src="js/app.js?mode=x&v=abc1234#top"></script>');
});

test("other sites' files, the host's files and everything that isn't a script or stylesheet are left alone", () => {
  const html = [
    '<script src="https://cdn.jsdelivr.net/npm/maplibre-gl@5.8.0/dist/maplibre-gl.js"></script>',
    '<script defer src="/_vercel/insights/script.js"></script>',
    '<script src="//example.com/x.js"></script>',
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter&display=swap">',
    '<link rel="icon" href="favicon.svg">',
    '<link rel="manifest" href="manifest.webmanifest">',
    '<script>const src = "js/app.js";</script>',
    '<a href="js/app.js">source</a><img src="assets/a.png">',
    '<script src="js/data.json"></script>',
  ].join('\n');
  assert.equal(stampAssets(html, 'abc1234'), html);
});

test('stamping twice gives the same page', () => {
  const once = stampAssets('<script src="js/app.js"></script>', 'abc1234');
  assert.equal(stampAssets(once, 'abc1234'), once);
});

test('a version that could break the address is refused', () => {
  assert.throws(() => stampAssets('<script src="js/app.js"></script>', 'a b"c'));
  assert.throws(() => stampAssets('<script src="js/app.js"></script>', ''));
});
