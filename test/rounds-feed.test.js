// The Rounds feed reader against Atom trimmed from real www.reddit.com/…/.rss responses
// (the same fixtures as the Mac app's FeedClientTests). Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aboutThing, budgetOf, commentsPair, decodeEntities, parseAtom, postsListing } from '../lib/rounds-feed.js';

const entry = ({ id, sub = 'mdphd', title, author = 'someone', content, published = '2026-10-22T22:33:31+00:00' }) =>
  `<entry><author><name>/u/${author}</name><uri>https://www.reddit.com/user/${author}</uri></author>`
  + `<category term="${sub}" label="r/${sub}"/><content type="html">${content}</content><id>t3_${id}</id>`
  + `<link href="https://www.reddit.com/r/${sub}/comments/${id}/slug/" /><updated>${published}</updated>`
  + `<published>${published}</published><title>${title}</title></entry>`;

const footer = (id, link, sub = 'mdphd', author = 'someone') => {
  const permalink = `https://www.reddit.com/r/${sub}/comments/${id}/slug/`;
  return ` &amp;#32; submitted by &amp;#32; &lt;a href=&quot;https://www.reddit.com/user/${author}&quot;&gt; /u/${author} &lt;/a&gt; &lt;br/&gt; `
    + `&lt;span&gt;&lt;a href=&quot;${link ?? permalink}&quot;&gt;[link]&lt;/a&gt;&lt;/span&gt; &amp;#32; `
    + `&lt;span&gt;&lt;a href=&quot;${permalink}&quot;&gt;[comments]&lt;/a&gt;&lt;/span&gt;`;
};

const md = (html) => `&lt;!-- SC_OFF --&gt;&lt;div class=&quot;md&quot;&gt;${html}&lt;/div&gt;&lt;!-- SC_ON --&gt;`;

const feed = (entries, title = 'top scoring links : mdphd') =>
  `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">`
  + `<category term="mdphd" label="r/mdphd"/><updated>2026-10-28T21:25:08+00:00</updated><id>/r/mdphd/top/.rss</id>`
  + `<title>${title}</title>${entries.join('')}</feed>`;

const comment = (id, author, html) =>
  `<entry><author><name>/u/${author}</name></author><category term="mdphd" label="r/mdphd" />`
  + `<content type="html">${md(html)}</content><id>t1_${id}</id>`
  + `<link href="https://www.reddit.com/r/mdphd/comments/f1/slug/${id}/"/><updated>2026-10-27T16:29:34+00:00</updated>`
  + `<title>/u/${author} on a thread</title></entry>`;

const TOP = feed([
  entry({ id: 'f1', title: 'MSTP interviews: what I wish I knew',
    content: md('&lt;p&gt;Here&amp;#39;s my tracker: &lt;a href=&quot;https://docs.google.com/spreadsheets/d/abc123/edit?usp=sharing&amp;amp;utm_source=reddit&quot;&gt;Interview tracker&lt;/a&gt;&lt;/p&gt; &lt;p&gt;Good luck &amp;amp; have fun.&lt;/p&gt; ') + footer('f1') }),
  entry({ id: 'f2', title: 'How do I balance research and Step 1?', content: md('&lt;p&gt;Asking for a friend.&lt;/p&gt; ') + footer('f2') }),
  entry({ id: 'f3', title: 'Lab life', content: '&lt;table&gt; &lt;tr&gt;&lt;td&gt; &lt;img src=&quot;https://preview.redd.it/x.png&quot; /&gt; &lt;/td&gt;&lt;td&gt;'
    + footer('f3', 'https://i.redd.it/xyz.png') + '&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;' }),
  entry({ id: 'f4', title: 'Great review article', content: footer('f4', 'https://www.nature.com/articles/abc') }),
]);

const THREAD = feed([
  entry({ id: 'f1', title: 'post', content: md('&lt;p&gt;Body&lt;/p&gt;') + footer('f1') }),
  comment('c1', 'alpha', '&lt;p&gt;My notes: &lt;a href=&quot;https://example.com/notes.pdf&quot;&gt;https://example.com/notes.pdf&lt;/a&gt;&lt;/p&gt;'),
  comment('c2', 'beta', '&lt;p&gt;Where are you going?&lt;/p&gt;'),
  comment('c3', 'gamma', ''),
], 'a thread');

test('a subreddit feed becomes a listing of posts', () => {
  const listing = postsListing(parseAtom(TOP), 'mdphd');
  assert.equal(listing.kind, 'Listing');
  assert.equal(listing.data.after, null);
  assert.deepEqual(listing.data.children.map((c) => c.kind), ['t3', 't3', 't3', 't3']);
  const posts = listing.data.children.map((c) => c.data);
  assert.deepEqual(posts.map((p) => p.id), ['f1', 'f2', 'f3', 'f4']);

  const f1 = posts[0];
  assert.equal(f1.subreddit, 'mdphd');
  assert.equal(f1.title, 'MSTP interviews: what I wish I knew');
  assert.equal(f1.author, 'someone');
  assert.equal(f1.score, -1);
  assert.equal(f1.num_comments, -1);
  assert.equal(f1.permalink, '/r/mdphd/comments/f1/slug/');
  assert.equal(f1.is_self, true);
  assert.equal(f1.url, 'https://www.reddit.com/r/mdphd/comments/f1/slug/');
  assert.equal(f1.selftext,
    "Here's my tracker: [Interview tracker](https://docs.google.com/spreadsheets/d/abc123/edit?usp=sharing&utm_source=reddit)\n\nGood luck & have fun.");
  assert.equal(f1.created_utc, 1792708411);
});

test('image and link posts keep their target and have no text', () => {
  const posts = postsListing(parseAtom(TOP), 'mdphd').data.children.map((c) => c.data);
  assert.equal(posts[2].post_hint, 'image');
  assert.equal(posts[2].is_self, false);
  assert.equal(posts[2].url, 'https://i.redd.it/xyz.png');
  assert.equal(posts[2].selftext, '');
  assert.equal(posts[3].url, 'https://www.nature.com/articles/abc');
  assert.equal(posts[3].is_self, false);
  assert.equal(posts[3].post_hint, null);
});

test('a thread feed becomes flat comments, without the post or empty comments', () => {
  const [post, comments] = commentsPair(parseAtom(THREAD), 20);
  assert.deepEqual(post.data.children, []);
  const list = comments.data.children.map((c) => c.data);
  assert.deepEqual(comments.data.children.map((c) => c.kind), ['t1', 't1']);
  assert.deepEqual(list.map((c) => c.id), ['c1', 'c2']);
  assert.deepEqual(list.map((c) => c.author), ['alpha', 'beta']);
  assert.equal(list[0].body, 'My notes: https://example.com/notes.pdf');
  assert.deepEqual(list.map((c) => c.depth), [0, 0]);
  assert.deepEqual(list.map((c) => c.score), [-1, -1]);
  assert.equal(commentsPair(parseAtom(THREAD), 1)[1].data.children.length, 1);
});

test('about is built from the feed title', () => {
  const about = aboutThing(parseAtom(feed([], 'MD/PhD')), 'mdphd');
  assert.equal(about.kind, 't5');
  assert.equal(about.data.display_name, 'mdphd');
  assert.equal(about.data.subreddit_type, 'public');
  assert.equal(about.data.public_description, 'MD/PhD');
});

test('anything that is not a feed is rejected', () => {
  assert.equal(parseAtom('<html><body>Too Many Requests</body></html>'), null);
  assert.equal(parseAtom(''), null);
  assert.equal(parseAtom(undefined), null);
  assert.deepEqual(parseAtom(feed([])).entries, []);
});

test('entities are decoded once', () => {
  assert.equal(decodeEntities('&amp;lt;b&amp;gt; &#39;x&#x27; &unknown; a\u200bb'), "&lt;b&gt; 'x' &unknown; ab");
});

test("Reddit's budget: requests left round down, waits round up", () => {
  const answer = (h) => ({ headers: { get: (name) => h[name] ?? null } });
  // Half a request left is none; 12.2 seconds is 13.
  assert.deepEqual(budgetOf(answer({ 'x-ratelimit-remaining': '0.5', 'x-ratelimit-reset': '12.2' })), { remaining: '0', reset: '13', retryAfter: '13' });
  assert.deepEqual(budgetOf(answer({ 'x-ratelimit-remaining': '3.0', 'x-ratelimit-reset': '40', 'retry-after': '7' })), { remaining: '3', reset: '40', retryAfter: '7' });
  // Nothing said, or nonsense, is passed on as nothing.
  assert.deepEqual(budgetOf(answer({ 'x-ratelimit-remaining': 'soon', 'x-ratelimit-reset': '-4' })), { remaining: null, reset: null, retryAfter: null });
  assert.deepEqual(budgetOf(answer({})), { remaining: null, reset: null, retryAfter: null });
});
