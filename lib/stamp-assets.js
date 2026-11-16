// An app's own scripts and stylesheets may be kept by a browser for an hour (vercel.json), which is
// fine only if their address changes when they do. The build marks each one with the app's commit:
// js/app.js becomes js/app.js?v=<commit>. Without that, a returning browser runs the old code after
// an update, or worse, a new file next to an old one.

const TAG = /<(script|link)\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi;
const STYLE_OR_MODULE = /\brel\s*=\s*["']?(?:stylesheet|modulepreload)["'\s>]/i;
// Relative addresses only: the app's own files, never another site's or the host's (/_vercel/...).
const OWN_FILE = /^(?![a-z][a-z0-9+.-]*:|\/|#)[^?#]+\.(?:m?js|css)$/i;

/** `url` with its `v` parameter set to `version`; other parameters and the fragment stay. */
function stamped(url, version) {
  const hashAt = url.indexOf('#');
  const hash = hashAt < 0 ? '' : url.slice(hashAt);
  const rest = hashAt < 0 ? url : url.slice(0, hashAt);
  const queryAt = rest.indexOf('?');
  const path = queryAt < 0 ? rest : rest.slice(0, queryAt);
  if (!OWN_FILE.test(path)) return url;
  const kept = (queryAt < 0 ? '' : rest.slice(queryAt + 1)).split('&').filter((part) => part && !/^v(=|$)/.test(part));
  return `${path}?${[...kept, `v=${version}`].join('&')}${hash}`;
}

/** Marks the page's own scripts and stylesheets with `version`. Everything else in the page is left as it is. */
export function stampAssets(html, version) {
  if (!/^[\w.-]+$/.test(version || '')) throw new Error(`stampAssets: "${version}" can't be used as a version.`);
  return html.replace(TAG, (tag, name) => {
    const script = name.toLowerCase() === 'script';
    if (!script && !STYLE_OR_MODULE.test(tag)) return tag;
    return tag.replace(script ? /(\bsrc\s*=\s*)(["'])([^"']*)\2/i : /(\bhref\s*=\s*)(["'])([^"']*)\2/i,
      (whole, before, quote, url) => `${before}${quote}${stamped(url, version)}${quote}`);
  });
}
