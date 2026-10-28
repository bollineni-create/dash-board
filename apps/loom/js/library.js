// Loom (web): the library — items, spaces, search, and the organize queue that asks Claude
// (through /loom/api) to title, summarize and tag what you save.
'use strict';

const Lib = (() => {
  const state = { items: [], spaces: [], chats: [], settings: { auto: true, theme: '' }, ai: null };
  const listeners = new Set();
  const byId = new Map();
  const emit = (what, detail) => listeners.forEach((fn) => fn(what, detail));

  async function load() {
    const [items, spaces, chats, settings] = await Promise.all([DB.all('items'), DB.all('spaces'), DB.all('chats'), DB.get('kv', 'settings')]);
    state.items = items.sort((a, b) => b.createdAt - a.createdAt);
    state.items.forEach((i) => byId.set(i.id, i));
    state.spaces = spaces.sort((a, b) => a.createdAt - b.createdAt);
    state.chats = chats.sort((a, b) => b.updatedAt - a.updatedAt);
    Object.assign(state.settings, settings || {});
    emit('load');
  }

  async function checkAI() {
    try { state.ai = !!(await api('status')).ai; } catch { state.ai = false; }
    emit('ai');
    if (state.ai && state.settings.auto) for (const i of state.items) if (i.ai === 'pending' || i.ai === 'processing' || i.ai === 'off') enqueue(i, false);
  }

  async function save(item, quiet) {
    item.updatedAt = Date.now();
    if (!byId.has(item.id)) { state.items.unshift(item); byId.set(item.id, item); }
    await DB.put('items', item);
    if (!quiet) emit('items', item);
    return item;
  }

  async function saveSettings(patch) {
    Object.assign(state.settings, patch);
    await DB.put('kv', state.settings, 'settings');
    emit('settings');
  }

  // ---- Capture -----------------------------------------------------------------------------

  const URL_ONLY = /^\s*(https?:\/\/[^\s]+)\s*$/i;
  const TEXT_FILE = /^(text\/|application\/(json|xml|x-yaml|javascript))|\.(md|markdown|txt|csv|json|ya?ml|xml|html?|js|ts|py|swift|rtf)$/i;
  const MAX_FILE = 250 * 1048576;

  function base(kind, space) {
    const now = Date.now();
    return { id: uid(), kind, title: '', body: '', url: '', text: '', summary: '', takeaways: [], tags: [], userTags: [],
      createdAt: now, updatedAt: now, fav: false, space: space || '', ai: 'pending', aiError: '' };
  }

  async function addText(raw, space) {
    const text = raw.trim();
    if (!text) return null;
    const m = text.match(URL_ONLY);
    if (m) {
      const item = base('link', space);
      item.url = m[1];
      await save(item);
      readLink(item);
      return item;
    }
    const item = base('note', space);
    item.body = text;
    await save(item);
    enqueue(item);
    return item;
  }

  async function addFile(file, space) {
    if (file.size > MAX_FILE) { toast(`${file.name} is larger than 250 MB.`); return null; }
    const type = file.type || '';
    const kind = type.startsWith('image/') ? 'image' : type.startsWith('video/') ? 'video' : type === 'application/pdf' || /\.pdf$/i.test(file.name) ? 'pdf' : 'file';
    const item = base(kind, space);
    Object.assign(item, { fileName: file.name, fileType: type || (kind === 'pdf' ? 'application/pdf' : ''), fileSize: file.size });
    if (kind === 'image') item.thumb = (await scaleImage(file, 400, 0.78, true)) || '';
    if (kind === 'video') item.thumb = await videoThumb(file);
    if (kind === 'file' && TEXT_FILE.test(type || file.name) && file.size < 2 * 1048576) item.text = (await file.text()).slice(0, 60000);
    try { await DB.put('blobs', file, item.id); } catch (e) { toast('Your browser is out of room for files.'); return null; }
    await save(item);
    DB.persist();
    enqueue(item);
    return item;
  }

  async function readLink(item) {
    item.ai = 'processing'; save(item);
    try {
      const page = await api('link?url=' + encodeURIComponent(item.url));
      Object.assign(item, { url: page.url || item.url, pageTitle: page.title, description: page.description, image: page.image, text: page.text });
      if (!item.titleEdited && page.title) item.title = page.title;
      if (!item.summary && page.description) item.summary = page.description;
      item.ai = 'pending';
      await save(item);
      enqueue(item);
    } catch (e) {
      item.ai = 'pending';
      item.linkError = e.message;
      await save(item);
      enqueue(item); // Claude can still tag it from the address alone
    }
  }

  async function remove(id) {
    const item = byId.get(id);
    if (!item) return;
    const blob = await DB.get('blobs', id);
    state.items = state.items.filter((i) => i.id !== id);
    byId.delete(id);
    await DB.del('items', id); await DB.del('blobs', id);
    emit('items');
    toast('Deleted “' + displayTitle(item).slice(0, 40) + '”', { label: 'Undo', run: async () => {
      if (blob) await DB.put('blobs', blob, id);
      byId.set(id, item); state.items.push(item); state.items.sort((a, b) => b.createdAt - a.createdAt);
      await DB.put('items', item); emit('items', item);
    } });
  }

  // ---- Spaces ------------------------------------------------------------------------------

  async function addSpace(emoji, name) {
    const s = { id: uid(), emoji: emoji || '📁', name: name.trim().slice(0, 40), createdAt: Date.now() };
    state.spaces.push(s);
    await DB.put('spaces', s);
    emit('spaces');
    return s;
  }
  async function removeSpace(id) {
    state.spaces = state.spaces.filter((s) => s.id !== id);
    await DB.del('spaces', id);
    for (const i of state.items) if (i.space === id) { i.space = ''; await save(i, true); }
    emit('spaces'); emit('items');
  }
  const space = (id) => state.spaces.find((s) => s.id === id);

  // ---- Tags --------------------------------------------------------------------------------

  function tagCounts() {
    const m = new Map();
    for (const i of state.items) for (const t of i.tags) m.set(t, (m.get(t) || 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  // ---- Organize queue ----------------------------------------------------------------------

  const queue = [];
  let running = 0;
  const CONCURRENCY = 2;
  const PDF_MAX = 2.8 * 1048576;

  function enqueue(item, force = true) {
    if (!state.ai || (!force && !state.settings.auto) || (!state.settings.auto && force !== 'manual')) {
      if (item.ai !== 'done') { item.ai = state.ai === false ? 'off' : item.ai === 'processing' ? 'pending' : item.ai; save(item, true).then(() => emit('items', item)); }
      return;
    }
    if (queue.includes(item.id)) return;
    item.ai = 'pending'; item.aiError = '';
    queue.push(item.id);
    emit('queue');
    pump();
  }
  const regenerate = (item) => enqueue(item, 'manual');
  const busy = () => running + queue.length;

  function pump() {
    while (running < CONCURRENCY && queue.length) {
      const item = byId.get(queue.shift());
      if (!item) continue;
      running++;
      organize(item).finally(() => { running--; emit('queue'); pump(); });
    }
  }

  async function payload(item) {
    const parts = [];
    const p = { kind: item.kind, existingTags: tagCounts().slice(0, 30).map((t) => t[0]).filter((t) => !item.tags.includes(t)) };
    if (item.kind === 'link') {
      parts.push('URL: ' + item.url);
      if (item.pageTitle) parts.push('Page title: ' + item.pageTitle);
      if (item.description) parts.push('Description: ' + item.description);
      if (item.text) parts.push('Page text:\n' + item.text.slice(0, 18000));
      else if (item.linkError) parts.push('(The page could not be read: ' + item.linkError + ')');
    }
    if (item.fileName) parts.push('File name: ' + item.fileName);
    if (item.body) parts.push((item.kind === 'note' ? '' : 'The user’s note: ') + item.body);
    if (item.kind === 'file' && item.text) parts.push('File contents:\n' + item.text.slice(0, 20000));
    if (item.kind === 'image' || item.kind === 'video' || item.kind === 'pdf') {
      const blob = await DB.get('blobs', item.id);
      if (!blob) throw Object.assign(new Error('The file is missing.'), { reason: 'skip' });
      if (item.kind === 'image') {
        const jpg = await scaleImage(blob, 1568, 0.85);
        if (!jpg) throw Object.assign(new Error('This image format can’t be read here.'), { reason: 'skip' });
        p.media = { type: 'image/jpeg', data: await blobToBase64(jpg) };
      } else if (item.kind === 'video') {
        const frame = await videoThumb(blob, 1280);
        if (!frame) throw Object.assign(new Error('Couldn’t read a frame of this video.'), { reason: 'skip' });
        p.media = { type: 'image/jpeg', data: frame.split(',')[1] };
        parts.push('(The attached image is a frame from the saved video.)');
      } else {
        if (blob.size > PDF_MAX) throw Object.assign(new Error('PDFs over 2.8 MB are too big to send to Claude from here.'), { reason: 'skip' });
        p.media = { type: 'application/pdf', data: await blobToBase64(blob) };
      }
    }
    if (item.kind === 'file' && !item.text && !item.body) throw Object.assign(new Error('Claude can read notes, links, images, PDFs and text files.'), { reason: 'skip' });
    p.text = parts.join('\n\n');
    return p;
  }

  async function organize(item) {
    item.ai = 'processing'; item.aiError = '';
    await save(item);
    try {
      const out = await api('organize', await payload(item));
      if (!byId.has(item.id)) return;
      if (!item.titleEdited && out.title) item.title = out.title;
      item.summary = out.summary || item.summary;
      item.takeaways = out.takeaways || [];
      item.tags = [...new Set([...(item.userTags || []), ...out.tags])];
      item.ai = 'done';
    } catch (e) {
      if (e.reason === 'no_ai') { state.ai = false; emit('ai'); item.ai = 'off'; }
      else if (e.reason === 'skip') { item.ai = 'skipped'; item.aiError = e.message; }
      else { item.ai = 'failed'; item.aiError = e.message; }
    }
    if (byId.has(item.id)) await save(item);
  }

  // ---- Search ------------------------------------------------------------------------------

  const STOP = new Set('a an and are as at be but by can did do does for from had has have how i in is it its me my of on or our so that the their them then there these they this to was we were what when where which who why will with you your about into than'.split(' '));
  const words = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);

  function search(q, { limit = 6, forAsk = false } = {}) {
    let terms = words(q);
    if (forAsk) terms = terms.filter((t) => !STOP.has(t) && t.length > 1);
    if (!terms.length) return [];
    const out = [];
    for (const item of state.items) {
      const fields = [
        [words(displayTitle(item)), 3], [words(item.tags.join(' ')), 3], [words(item.summary), 2],
        [words(item.takeaways.join(' ') + ' ' + item.body + ' ' + (item.description || '') + ' ' + hostOf(item.url) + ' ' + (item.fileName || '')), 1],
        [words((item.text || '').slice(0, 8000)), 0.5],
      ];
      let score = 0, hit = 0;
      for (const t of terms) {
        let ts = 0;
        for (const [ws, w] of fields) for (const x of ws) if (x === t) ts += w; else if (x.startsWith(t) && t.length > 1) ts += w * 0.6;
        if (ts) { hit++; score += Math.min(ts, 12); }
      }
      if (!hit) continue;
      score *= hit / terms.length;
      if (!forAsk && hit < terms.length) score *= 0.4;
      out.push([score, item]);
    }
    return out.sort((a, b) => b[0] - a[0]).slice(0, limit).map((x) => x[1]);
  }

  // ---- Ask ---------------------------------------------------------------------------------

  async function saveChat(chat) {
    chat.updatedAt = Date.now();
    if (!state.chats.includes(chat)) state.chats.unshift(chat);
    await DB.put('chats', chat);
  }

  async function ask(chat, question) {
    const hits = search(question, { limit: 4, forAsk: true });
    const history = chat.messages.slice(-8).map((m) => ({ user: !!m.user, text: m.text.slice(0, 600) }));
    chat.messages.push({ user: true, text: question, at: Date.now() });
    if (!chat.title) chat.title = question.slice(0, 60);
    await saveChat(chat);
    const sources = hits.map((i) => ({
      title: displayTitle(i), kind: i.kind, date: new Date(i.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' }),
      summary: i.summary, takeaways: i.takeaways, text: (i.body || i.text || i.description || '').slice(0, 1500),
    }));
    const { answer } = await api('ask', { question, history, sources });
    // Renumber citations to the ones actually used, in order; fall back to the top 3 hits.
    const order = [];
    answer.replace(/\[(\d+)\]/g, (_, n) => { const k = +n; if (k >= 1 && k <= hits.length && !order.includes(k)) order.push(k); return _; });
    const text = order.length ? answer.replace(/\[(\d+)\]/g, (m, n) => (order.includes(+n) ? `[${order.indexOf(+n) + 1}]` : '')) : answer;
    const used = order.length ? order.map((k) => hits[k - 1].id) : hits.slice(0, 3).map((i) => i.id);
    const msg = { user: false, text, sources: used, cited: order.length > 0, at: Date.now() };
    chat.messages.push(msg);
    await saveChat(chat);
    return msg;
  }

  async function removeChat(id) {
    state.chats = state.chats.filter((c) => c.id !== id);
    await DB.del('chats', id);
  }

  // ---- Export / erase / samples ------------------------------------------------------------

  function exportJSON() {
    const strip = ({ thumb, ...rest }) => rest;
    const data = { app: 'Loom', exportedAt: new Date().toISOString(), spaces: state.spaces, items: state.items.map(strip) };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = 'loom-library.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  async function erase() {
    queue.length = 0;
    await DB.clear();
    state.items = []; state.spaces = []; state.chats = []; byId.clear();
    emit('load');
  }

  async function addSamples() {
    const reading = await addSpace('📚', 'Reading');
    const kitchen = await addSpace('🍞', 'Kitchen');
    const day = 86400000;
    const S = [
      { kind: 'note', title: 'Spaced repetition beats rereading', space: reading.id, body: 'Rereading feels productive but fades fast. Testing yourself at growing intervals (1 day, 3 days, a week, a month) keeps things for years.',
        summary: 'Retrieval practice spaced over growing intervals keeps memories far longer than rereading, which mostly builds familiarity.', takeaways: ['Test yourself instead of rereading', 'Stretch the gaps: 1 day, 3 days, 1 week, 1 month', 'Struggling to recall is what makes it stick'], tags: ['learning', 'memory'] },
      { kind: 'note', title: 'The Feynman technique', space: reading.id, body: 'Explain the idea in plain words as if to a 12-year-old. Wherever you stall or reach for jargon is the gap. Go back to the source, then simplify again.',
        summary: 'Explaining an idea simply exposes the parts you don’t understand yet, so you know exactly what to relearn.', takeaways: ['Write the explanation out in plain words', 'Jargon and hand-waving mark the gaps', 'Return to the source, then simplify again'], tags: ['learning', 'writing'] },
      { kind: 'link', title: 'Zettelkasten', url: 'https://en.wikipedia.org/wiki/Zettelkasten', space: reading.id,
        summary: 'A note-taking method of small, linked, permanent notes, made famous by sociologist Niklas Luhmann’s 90,000-card archive.', takeaways: ['One idea per note, in your own words', 'Link each new note to the ones it relates to', 'Structure emerges from the links rather than folders'], tags: ['note-taking', 'writing', 'memory'] },
      { kind: 'note', title: 'Sourdough starter ratios', space: kitchen.id, body: 'Feed 1:5:5 (starter:flour:water) at room temp for a 12-hour peak. 1:2:2 peaks in about 4–6 hours. Rye in the mix speeds it up.',
        summary: 'Feeding ratios control how fast a starter peaks: higher dilution slows it down, rye flour speeds it up.', takeaways: ['1:5:5 peaks in about 12 hours', '1:2:2 peaks in 4–6 hours', 'A little rye makes it more active'], tags: ['baking', 'fermentation'] },
      { kind: 'note', title: 'Quick-pickled red onions', space: kitchen.id, body: 'Slice thin, cover with equal parts vinegar and hot water, a spoon of sugar and a pinch of salt. Ready in 30 minutes, keeps two weeks.',
        summary: 'A fast pickle: thin onions in a warm vinegar brine are ready in half an hour and keep for two weeks in the fridge.', takeaways: ['Equal parts vinegar and hot water', 'One spoon sugar, a pinch of salt', 'Ready in 30 minutes, keeps 2 weeks'], tags: ['fermentation', 'recipes'] },
      { kind: 'note', title: 'Walk before deep work', body: 'Twenty minutes outside before a focus block makes the first hour noticeably easier. Try it for two weeks and note the difference.',
        summary: 'A short walk before focused work seems to make starting easier; worth a two-week trial.', takeaways: ['Walk about 20 minutes first', 'Track focus for two weeks'], tags: ['habits', 'focus'] },
      { kind: 'note', title: 'Writing to think', space: reading.id, body: 'Drafting is how I find out what I think. Start messy, then cut. The outline comes after the first draft, not before.',
        summary: 'Writing is a way of thinking: a messy first draft reveals the argument, and the structure comes afterwards.', takeaways: ['Draft first, outline after', 'Cutting is where clarity comes from'], tags: ['writing', 'focus'] },
    ];
    let t = Date.now() - S.length * day;
    for (const s of S) {
      const item = Object.assign(base(s.kind, s.space), s, { ai: 'done', createdAt: (t += day) });
      await save(item, true);
    }
    state.items.sort((a, b) => b.createdAt - a.createdAt);
    emit('items');
  }

  return {
    state, byId, on: (fn) => listeners.add(fn), load, checkAI, save, saveSettings, addText, addFile, remove,
    addSpace, removeSpace, space, tagCounts, enqueue, regenerate, busy, search, ask, saveChat, removeChat,
    exportJSON, erase, addSamples, readLink,
  };
})();
