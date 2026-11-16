// Reddit's public Atom feeds (www.reddit.com/…/.rss), read the way the Rounds Mac app reads them
// (RoundsCore/RedditFeedClient.swift). Reddit refuses anonymous JSON requests from cloud hosts and
// from other sites' pages, and approves API client IDs case by case, so without a client ID the
// feeds are the only way the hosted Rounds can read a subreddit.
//
// A feed gives the top 100 posts with their text, and a thread's top comments. It has no upvote
// or comment counts and no reply tree, so every count here is -1 and every comment has depth 0.
// The answers have the shape of Reddit's JSON, so the page reads both the same way.

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
};

/** Named entities Reddit uses plus every numeric one. One pass: "&amp;lt;" becomes "&lt;". */
export function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g, (all, name) => {
    if (name[0] === '#') {
      const code = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return all; }
    }
    return Object.hasOwn(NAMED, name) ? NAMED[name] : all;
  }).replaceAll('\u200b', '');
}

const strip = (html) => html.replace(/<!--.*?-->|<[^>]+>/gs, '');

/** HTML fragment → plain text with Markdown links. */
export function htmlText(html) {
  let s = html;
  // Anchors: keep bare URLs bare, otherwise write [title](url).
  s = s.replace(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gis, (_, href, inner) => {
    const url = decodeEntities(href);
    const title = decodeEntities(strip(inner)).trim();
    return !title || title === url || url.endsWith(title) ? url : `[${title}](${url})`;
  });
  s = s.replace(/<li[^>]*>/gi, '\n- ');
  s = s.replace(/<br\s*\/?>|<\/(div|h[1-6]|tr)>/gi, '\n');
  s = s.replace(/<\/(p|pre|blockquote|table|ul|ol)>/gi, '\n\n');
  s = decodeEntities(strip(s));
  // Tidy whitespace: trim lines, at most one blank line in a row.
  const out = [];
  for (const line of s.split('\n').map((l) => l.trim())) {
    if (line === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(line);
  }
  return out.join('\n').trim();
}

/** The text of a feed entry, and the target of its "[link]" anchor (a post's outbound URL or its own page). */
export function feedParts(html) {
  const link = html.match(/<a href="([^"]*)">\s*\[link\]\s*<\/a>/i);
  // The text lives in <div class="md">…</div>; link and image posts have none.
  let body = '';
  const open = html.indexOf('<div class="md">');
  if (open >= 0) {
    const from = open + '<div class="md">'.length;
    let close = html.indexOf('<!-- SC_ON -->', from);
    if (close < 0) close = html.lastIndexOf('</div>');
    if (close >= from) body = htmlText(html.slice(from, close));
  }
  return { body, linkURL: link ? decodeEntities(link[1]) : null };
}

const inner = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : '';
};
// What an XML parser hands back for an element's text: CDATA as written, entities decoded once.
const xmlText = (raw) => raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>|([^<]+)/g, (_, cdata, text) => (cdata != null ? cdata : decodeEntities(text)));

/** The parts of an Atom feed Rounds reads, or null when the text isn't a feed. */
export function parseAtom(xml) {
  if (typeof xml !== 'string' || !/<feed[\s>]/.test(xml)) return null;
  const first = xml.search(/<entry[\s>]/);
  const entries = [...xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/g)].map(([e]) => {
    const href = e.match(/<link\b[^>]*\bhref="([^"]*)"/);
    return {
      id: xmlText(inner(e, 'id')).trim(),
      title: xmlText(inner(e, 'title')).trim(),
      author: xmlText(inner(inner(e, 'author'), 'name')).trim(),
      content: xmlText(inner(e, 'content')),
      link: href ? decodeEntities(href[1]) : '',
      published: xmlText(inner(e, 'published')).trim(),
      updated: xmlText(inner(e, 'updated')).trim(),
    };
  });
  return { title: xmlText(inner(first < 0 ? xml : xml.slice(0, first), 'title')).trim(), entries };
}

const username = (raw) => (raw.startsWith('/u/') ? raw.slice(3) : raw || '[deleted]');
const parse = (u) => { try { return new URL(u); } catch { return null; } };

/** A post entry as the `data` of a Reddit JSON `t3`, or null for any other entry. */
export function postFromEntry(entry, sub) {
  if (!entry.id.startsWith('t3_')) return null;
  const id = entry.id.slice(3);
  const parts = feedParts(entry.content);
  const permalink = parse(entry.link)?.pathname || `/comments/${id}/`;
  const linked = parts.linkURL ? (parts.linkURL.startsWith('/') ? 'https://www.reddit.com' + parts.linkURL : parts.linkURL) : null;
  const target = linked ? parse(linked) : null;
  const isSelf = !linked || target?.pathname === permalink;
  const host = target?.hostname.toLowerCase() || '';
  const created = Date.parse(entry.published || entry.updated);
  return {
    id, subreddit: sub, title: entry.title, selftext: parts.body, author: username(entry.author),
    score: -1, num_comments: -1, created_utc: Number.isFinite(created) ? created / 1000 : 0,
    permalink, url: isSelf ? 'https://www.reddit.com' + permalink : linked,
    post_hint: host === 'i.redd.it' || host === 'i.imgur.com' ? 'image' : null,
    is_self: isSelf, is_gallery: !!linked && linked.includes('reddit.com/gallery/'), is_video: host === 'v.redd.it',
  };
}

/** A comment entry as the `data` of a Reddit JSON `t1`, or null for the post entry and empty comments. */
export function commentFromEntry(entry) {
  if (!entry.id.startsWith('t1_')) return null;
  const body = feedParts(entry.content).body;
  return body ? { id: entry.id.slice(3), author: username(entry.author), body, score: -1, depth: 0, replies: '' } : null;
}

const listing = (kind, items) => ({ kind: 'Listing', data: { after: null, children: items.map((data) => ({ kind, data })) } });

/** A subreddit feed as a Reddit JSON listing of posts. Feeds have one page, so `after` is always null. */
export const postsListing = (feed, sub) => listing('t3', feed.entries.map((e) => postFromEntry(e, sub)).filter(Boolean));

/** A thread feed as Reddit's [post, comments] pair. The post is left out: the page keeps the copy from the listing. */
export const commentsPair = (feed, limit) => [listing('t3', []), listing('t1', feed.entries.map(commentFromEntry).filter(Boolean).slice(0, limit))];

/** What a feed can say about a subreddit, as Reddit JSON's `t5`. */
export const aboutThing = (feed, sub) => ({ kind: 't5', data: { display_name: sub, subreddit_type: 'public', subscribers: null, public_description: feed.title || '', quarantine: false } });

// What Reddit says is left of this address's request budget: how many requests, and the seconds until it refills.
// A wait is rounded up and a count of requests down, so the page never goes early or counts on part of a request.
const whole = (v, round) => (v != null && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? String(round(Number(v))) : null);
const seconds = (v) => whole(v, Math.ceil);
const requests = (v) => whole(v, Math.floor);
export function budgetOf(r) {
  const reset = seconds(r.headers.get('x-ratelimit-reset'));
  return { remaining: requests(r.headers.get('x-ratelimit-remaining')), reset, retryAfter: seconds(r.headers.get('retry-after')) || reset };
}
