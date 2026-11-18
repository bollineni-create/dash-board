// Sync for the apps on the hosted site (/sync/api/<app> is rewritten here). The rules are in
// lib/sync.js; this file only connects them to the site's private Vercel Blob store. Without a
// store (no BLOB_READ_WRITE_TOKEN) the route answers `status` with sync off and the apps hide it.
import { BlobPreconditionFailedError, del, get, put } from '@vercel/blob';
import { createHandler, makeStore } from '../lib/sync.js';

const access = 'private';

const blob = {
  // useCache: false reads the file itself, so a device never merges against an old copy.
  async read(path) {
    const found = await get(path, { access, useCache: false });
    if (!found || found.statusCode !== 200) return null;
    return { text: await new Response(found.stream).text(), version: found.blob.etag };
  },
  async write(path, text, { ifMatch }) {
    const options = { access, addRandomSuffix: false, contentType: 'application/json', cacheControlMaxAge: 60 };
    try {
      const saved = await put(path, text, ifMatch ? { ...options, ifMatch } : { ...options, allowOverwrite: false });
      return { version: saved.etag };
    } catch (e) {
      // A later save found a newer version.
      if (e instanceof BlobPreconditionFailedError) throw Object.assign(e, { conflict: true });
      // A first save that fails may have found a file already there. The store has no error of
      // its own for that, so look: if the file exists, another device got there first.
      if (!ifMatch && await blob.read(path).catch(() => null)) throw Object.assign(e, { conflict: true });
      throw e;
    }
  },
  async remove(path) { await del(path); },
};

const enabled = !!process.env.BLOB_READ_WRITE_TOKEN;
export default createHandler(enabled ? makeStore(blob, process.env.VERCEL_ENV || 'development') : null);
