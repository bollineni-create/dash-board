// Loom (web): the inspector panel (item, concept, space, ask), the status popover and the dialogs.
'use strict';

const Panels = (() => {
  const panel = $('#panel'), body = $('#panel-body');
  let cur = null; // { type, id, chat }
  const cb = { change() {} };

  const ICON = {
    close: '<svg viewBox="0 0 20 20" class="ico"><path d="M5 5l10 10M15 5L5 15" /></svg>',
    star: (on) => `<svg viewBox="0 0 20 20" class="ico"><path d="M10 3l2.1 4.4 4.8.6-3.5 3.3.9 4.7L10 13.8 5.7 16l.9-4.7L3.1 8l4.8-.6z"${on ? ' class="fill"' : ''} /></svg>`,
    spark: '<svg viewBox="0 0 20 20" class="ico"><path d="M10 2.5l1.6 4.4 4.4 1.6-4.4 1.6L10 14.5l-1.6-4.4L4 8.5l4.4-1.6z" class="fill" /></svg>',
    send: '<svg viewBox="0 0 20 20" class="ico"><path d="M10 15.5v-11M5.5 9l4.5-4.5L14.5 9" /></svg>',
    back: '<svg viewBox="0 0 20 20" class="ico"><path d="M12 4l-6 6 6 6" /></svg>',
  };

  function show(state) {
    cur = state;
    panel.hidden = false;
    panel.classList.remove('short');
    render();
    cb.change(cur);
  }
  function close() {
    if (!cur) return false;
    blobURLs.forEach(URL.revokeObjectURL); blobURLs = [];
    cur = null; panel.hidden = true; body.innerHTML = '';
    cb.change(null);
    return true;
  }
  function render() {
    if (!cur) return;
    const keep = body.scrollTop;
    if (cur.type === 'item') renderItem();
    else if (cur.type === 'concept' || cur.type === 'space') renderGroup();
    else if (cur.type === 'ask') renderAsk();
    body.scrollTop = keep;
  }

  const head = (kicker, extra = '') => `<div class="p-head"><div class="kicker">${kicker}</div>${extra}<button class="icon-btn" data-act="close" aria-label="Close">${ICON.close}</button></div>`;
  const tagHTML = (t, removable) => `<span class="tag" style="--c:${branchColor(t)}"><button class="tag-go" data-tag="${esc(t)}" style="all:unset;cursor:pointer">${esc(t)}</button>${removable ? `<button class="x" data-untag="${esc(t)}" aria-label="Remove ${esc(t)}">×</button>` : ''}</span>`;
  function resultHTML(i, n) {
    const k = KINDS[i.kind];
    const badge = i.thumb || i.image ? `<span class="kind-badge" style="background:${k.color}"><img src="${esc(i.thumb || i.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()"></span>` : `<span class="kind-badge" style="background:${k.color}">${k.glyph}</span>`;
    return `<button class="result" data-open="${i.id}">${n ? `<span class="n">${n}</span>` : ''}${badge}<span class="meta"><span class="t">${esc(displayTitle(i))}</span><span class="s">${esc(i.summary || i.description || hostOf(i.url) || relTime(i.createdAt))}</span></span></button>`;
  }

  // ---- Item --------------------------------------------------------------------------------

  let blobURLs = [];
  async function blobURL(id) {
    const b = await DB.get('blobs', id);
    if (!b) return '';
    const u = URL.createObjectURL(b); blobURLs.push(u); return u;
  }

  function aiRow(i) {
    const s = i.ai;
    if (s === 'done') return `<div class="ai-row">${ICON.spark}<span class="grow">Organized by Claude</span><button class="btn small ghost" data-act="regen">Regenerate</button></div>`;
    if (s === 'processing' || (s === 'pending' && Lib.state.ai && Lib.state.settings.auto)) return `<div class="ai-row"><span class="spin"></span><span class="grow">${s === 'processing' ? 'Claude is reading this…' : 'Waiting to be organized…'}</span></div>`;
    if (s === 'failed') return `<div class="ai-row err"><span class="grow">${esc(i.aiError || 'Claude couldn’t organize this.')}</span><button class="btn small ghost" data-act="regen">Try again</button></div>`;
    if (s === 'skipped') return `<div class="ai-row"><span class="grow">${esc(i.aiError || 'Claude skipped this item.')}</span></div>`;
    if (Lib.state.ai === false) return `<div class="ai-row"><span class="grow">Claude isn’t set up on this site yet, so items are saved without a summary.</span></div>`;
    return `<div class="ai-row">${ICON.spark}<span class="grow">Not organized yet.</span><button class="btn small primary" data-act="regen">Organize</button></div>`;
  }

  async function renderItem() {
    const i = Lib.byId.get(cur.id);
    if (!i) return close();
    const k = KINDS[i.kind];
    const sp = Lib.space(i.space);
    const spaces = Lib.state.spaces.map((s) => `<option value="${s.id}"${s.id === i.space ? ' selected' : ''}>${esc(s.emoji + ' ' + s.name)}</option>`).join('');
    const host = hostOf(i.url);
    const meta = [relTime(i.createdAt), i.fileSize ? fmtSize(i.fileSize) : '', i.fileName && i.kind !== 'note' ? esc(i.fileName) : ''].filter(Boolean);
    const media = i.kind === 'image' || i.kind === 'video' ? `<div class="p-media" data-media></div>` : i.image ? `<div class="p-media"><img src="${esc(i.image)}" alt="" referrerpolicy="no-referrer" onerror="this.parentNode.remove()"></div>` : '';
    body.innerHTML = head(`<span class="kind-badge" style="background:${k.color};width:20px;height:20px;font-size:11px">${k.glyph}</span>${k.label}${sp ? ' · ' + esc(sp.emoji + ' ' + sp.name) : ''}`,
      `<button class="icon-btn${i.fav ? ' fav' : ''}" data-act="fav" aria-label="${i.fav ? 'Unfavorite' : 'Favorite'}" aria-pressed="${!!i.fav}">${ICON.star(i.fav)}</button>`) +
      media +
      `<div class="p-sec"><textarea class="p-title" rows="1" data-field="title" aria-label="Title">${esc(displayTitle(i))}</textarea>
        <div class="p-host">${host ? `<a href="${esc(i.url)}" target="_blank" rel="noopener noreferrer">${esc(host)} ↗</a>` : ''}${meta.map((m) => `<span>${m}</span>`).join('')}</div></div>` +
      (i.linkError ? `<div class="p-sec"><div class="ai-row">${esc('Couldn’t read the page: ' + i.linkError)}</div></div>` : '') +
      `<div class="p-sec">${aiRow(i)}</div>` +
      (i.summary || i.ai === 'done' ? `<div class="p-sec"><div class="label">Summary</div><textarea class="p-edit" rows="1" data-field="summary" aria-label="Summary">${esc(i.summary)}</textarea></div>` : '') +
      (i.takeaways.length ? `<div class="p-sec"><div class="label">Key points</div><ul class="takeaways">${i.takeaways.map((t, n) => `<li><textarea class="p-edit" rows="1" data-take="${n}" aria-label="Key point ${n + 1}">${esc(t)}</textarea></li>`).join('')}</ul></div>` : '') +
      `<div class="p-sec"><div class="label">Tags</div><div class="tags">${i.tags.map((t) => tagHTML(t, true)).join('')}<input class="tag-in" placeholder="+ tag" maxlength="32" aria-label="Add tag"></div></div>` +
      (i.kind === 'note' ? `<div class="p-sec"><div class="label">Note</div><textarea class="p-edit body" rows="3" data-field="body" aria-label="Note">${esc(i.body)}</textarea></div>` : '') +
      (i.kind !== 'note' && i.text && i.kind !== 'link' ? `<div class="p-sec"><div class="label">Text</div><div class="text-block">${esc(i.text.slice(0, 4000))}</div></div>` : '') +
      `<div class="p-actions"><label class="field inline"><span>Space</span><select data-act="space"><option value="">None</option>${spaces}<option value="+">New space…</option></select></label>
        <span class="spacer"></span>
        ${i.kind === 'pdf' || i.kind === 'file' ? `<button class="btn small ghost" data-act="openfile">${i.kind === 'pdf' ? 'Open PDF' : 'Download'}</button>` : ''}
        ${i.url ? `<a class="btn small ghost" href="${esc(i.url)}" target="_blank" rel="noopener noreferrer">Open link</a>` : ''}
        <button class="btn small danger" data-act="delete">Delete</button></div>`;
    $$('textarea', body).forEach(autosize);
    if (i.kind === 'image' || i.kind === 'video') {
      const box = $('[data-media]', body);
      if (i.thumb) box.innerHTML = `<img src="${i.thumb}" alt="">`;
      const u = await blobURL(i.id);
      if (u && cur?.id === i.id && box.isConnected) box.innerHTML = i.kind === 'image' ? `<img src="${u}" alt="${esc(displayTitle(i))}">` : `<video src="${u}" controls playsinline preload="metadata"${i.thumb ? ` poster="${i.thumb}"` : ''}></video>`;
      else if (!u && !i.thumb) box.remove();
    }
  }

  async function itemEvent(e) {
    const i = Lib.byId.get(cur.id);
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (e.type === 'click') {
      if (act === 'fav') { i.fav = !i.fav; await Lib.save(i); }
      else if (act === 'regen') Lib.regenerate(i);
      else if (act === 'delete') { close(); Lib.remove(i.id); }
      else if (act === 'openfile') {
        const b = await DB.get('blobs', i.id);
        if (!b) return toast('The file isn’t in this browser any more.');
        const u = URL.createObjectURL(i.kind === 'pdf' ? new Blob([b], { type: 'application/pdf' }) : b);
        if (i.kind === 'pdf') window.open(u, '_blank', 'noopener');
        else { const a = document.createElement('a'); a.href = u; a.download = i.fileName || 'file'; a.click(); }
        setTimeout(() => URL.revokeObjectURL(u), 60000);
      } else if (e.target.closest('[data-untag]')) {
        const t = e.target.closest('[data-untag]').dataset.untag;
        i.tags = i.tags.filter((x) => x !== t); i.userTags = (i.userTags || []).filter((x) => x !== t);
        i.removedTags = [...new Set([...(i.removedTags || []), t])];
        await Lib.save(i);
      }
    } else if (e.type === 'change' && act === 'space') {
      const v = e.target.value;
      if (v === '+') { const s = await askSpace(); i.space = s ? s.id : i.space; }
      else i.space = v;
      await Lib.save(i);
    }
  }

  // Edits save on blur so typing never re-renders under the cursor.
  function itemInput(e) {
    const t = e.target;
    if (t.tagName === 'TEXTAREA') autosize(t);
  }
  async function itemBlur(e) {
    const t = e.target, i = cur && Lib.byId.get(cur.id);
    if (!i || cur.type !== 'item') return;
    if (t.dataset.field) {
      const f = t.dataset.field, v = f === 'title' ? t.value.replace(/\s+/g, ' ').trim() : t.value;
      if (f === 'title') { if (v === displayTitle(i)) return; i.title = v; i.titleEdited = true; }
      else { if (v === (i[f] || '')) return; i[f] = v; }
      await Lib.save(i, true);
      Web.rebuild();
    } else if (t.dataset.take !== undefined) {
      const n = +t.dataset.take, v = t.value.trim();
      if (v === i.takeaways[n]) return;
      if (v) i.takeaways[n] = v; else i.takeaways.splice(n, 1);
      await Lib.save(i, !!v);
    } else if (t.classList.contains('tag-in')) addTag(t);
  }
  async function addTag(input) {
    const i = Lib.byId.get(cur.id);
    const t = input.value.toLowerCase().replace(/[^\p{L}\p{N} -]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 32);
    input.value = '';
    if (!t || i.tags.includes(t)) return;
    i.tags.push(t); i.userTags = [...new Set([...(i.userTags || []), t])];
    await Lib.save(i);
    setTimeout(() => $('.tag-in', body)?.focus(), 0);
  }

  // ---- Concept / space ---------------------------------------------------------------------

  function renderGroup() {
    const concept = cur.type === 'concept';
    const items = Lib.state.items.filter((i) => (concept ? i.tags.includes(cur.id) : i.space === cur.id));
    const sp = concept ? null : Lib.space(cur.id);
    if (!concept && !sp) return close();
    const related = new Map();
    if (concept) for (const i of items) for (const t of i.tags) if (t !== cur.id) related.set(t, (related.get(t) || 0) + 1);
    const rel = [...related].sort((a, b) => b[1] - a[1]).slice(0, 10);
    body.innerHTML = head(concept ? `<i style="width:10px;height:10px;border-radius:50%;background:${branchColor(cur.id)}"></i>Concept` : 'Space') +
      `<div class="p-sec"><h2 class="p-title" style="margin:0">${concept ? esc(cur.id) : esc(sp.emoji + ' ' + sp.name)}</h2>
        <div class="p-host"><span>${items.length} ${items.length === 1 ? 'item' : 'items'}</span></div></div>` +
      (rel.length ? `<div class="p-sec"><div class="label">Related concepts</div><div class="tags">${rel.map(([t]) => tagHTML(t)).join('')}</div></div>` : '') +
      `<div class="p-sec"><div class="label">Items</div><div class="c-items">${items.map((i) => resultHTML(i)).join('') || '<p class="chat-hint">Nothing here yet.</p>'}</div></div>` +
      (concept ? `<div class="p-actions"><span class="spacer"></span><button class="btn small ghost" data-act="ask-about">Ask about ${esc(cur.id)}</button></div>` : '');
  }

  // ---- Ask ---------------------------------------------------------------------------------

  function md(text) {
    const inline = (s) => esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
      .replace(/\[(\d+)\]/g, '<button class="cite" data-cite="$1">$1</button>');
    const out = [];
    let list = null;
    const flush = () => { if (list) { out.push(`<${list.t}>${list.items.map((x) => `<li>${inline(x)}</li>`).join('')}</${list.t}>`); list = null; } };
    let para = [];
    const flushP = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      let m;
      if (!line) { flushP(); flush(); continue; }
      if ((m = line.match(/^#{1,4}\s+(.*)/))) { flushP(); flush(); out.push(`<h4>${inline(m[1])}</h4>`); continue; }
      if ((m = line.match(/^[-*•]\s+(.*)/)) || (m = line.match(/^\d+[.)]\s+(.*)/))) {
        flushP();
        const t = /^\d/.test(line) ? 'ol' : 'ul';
        if (!list || list.t !== t) { flush(); list = { t, items: [] }; }
        list.items.push(m[1]); continue;
      }
      flush(); para.push(line);
    }
    flushP(); flush();
    return out.join('');
  }

  function renderAsk() {
    const chat = cur.chat;
    let inner;
    if (cur.list) {
      inner = `<div class="chat"><div class="chat-list">${Lib.state.chats.map((c) => `<button class="result" data-chat="${c.id}"><span class="meta"><span class="t">${esc(c.title || 'Untitled')}</span><span class="s">${c.messages.length} messages · ${relTime(c.updatedAt)}</span></span></button>`).join('') || '<p class="chat-hint">No conversations yet.</p>'}</div></div>`;
    } else {
      const msgs = chat.messages.map((m) => {
        if (m.user) return `<div class="msg user">${esc(m.text)}</div>`;
        const src = (m.sources || []).map((id) => Lib.byId.get(id)).filter(Boolean);
        return `<div class="msg bot">${m.error ? `<p class="ai-row err">${esc(m.text)}</p>` : md(m.text)}${src.length ? `<div class="sources"><div class="label">${m.cited ? 'Sources' : 'Related in your brain'}</div>${src.map((i, n) => resultHTML(i, m.cited ? n + 1 : 0)).join('')}</div>` : ''}</div>`;
      }).join('');
      const hint = !chat.messages.length ? `<p class="chat-hint">${Lib.state.ai === false ? 'Asking needs Claude, which isn’t set up on this site yet.' : Lib.state.items.length ? 'Ask a question and Claude answers from what you’ve saved, with sources.' : 'Save a few things first, then ask about them here.'}</p>` : '';
      inner = `<div class="chat">${hint}${msgs}${cur.busy ? '<div class="thinking"><span class="spin"></span>Reading your brain…</div>' : ''}</div>
        <form class="ask-foot" data-ask><label class="pill">${ICON.spark}<input placeholder="Ask a follow-up…" aria-label="Ask a follow-up" autocomplete="off"${cur.busy ? ' disabled' : ''}><button class="send" aria-label="Ask"${cur.busy ? ' disabled' : ''}>${ICON.send}</button></label></form>`;
    }
    body.innerHTML = head(cur.list ? `<button class="icon-btn small" data-act="back" aria-label="Back" style="width:28px;height:28px">${ICON.back}</button>Conversations` : 'Ask',
      cur.list ? '' : `${Lib.state.chats.length ? '<button class="btn small ghost" data-act="history">History</button>' : ''}${chat.messages.length ? '<button class="btn small ghost" data-act="newchat">New chat</button>' : ''}`) + inner;
    const chatEl = $('.chat', body);
    requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
    if (!cur.list && !cur.busy && matchMedia('(pointer: fine)').matches) $('.ask-foot input', body)?.focus();
    return chatEl;
  }

  async function ask(question, chat) {
    question = question.trim();
    if (!question) return;
    if (!chat) chat = cur?.type === 'ask' && !cur.list ? cur.chat : { id: uid(), title: '', messages: [], updatedAt: Date.now() };
    show({ type: 'ask', chat, busy: true });
    try { await Lib.ask(chat, question); }
    catch (e) {
      const text = e.reason === 'no_ai' ? 'Claude isn’t set up on this site yet.' : e.reason === 'refusal' ? 'Claude declined to answer that one.' : e.message;
      chat.messages.push({ user: false, text, error: true, at: Date.now() });
      if (e.reason === 'no_ai') { Lib.state.ai = false; }
    }
    if (cur?.chat === chat) { cur.busy = false; render(); }
  }

  // ---- Panel events ------------------------------------------------------------------------

  body.addEventListener('click', async (e) => {
    if (!cur) return;
    const t = e.target;
    const act = t.closest('[data-act]')?.dataset.act;
    if (act === 'close') return close();
    const open = t.closest('[data-open]');
    if (open) return openItem(open.dataset.open, true);
    const tag = t.closest('[data-tag]');
    if (tag) return openConcept(tag.dataset.tag, true);
    const cite = t.closest('[data-cite]');
    if (cite) {
      const msg = cite.closest('.msg'), n = +cite.dataset.cite;
      const r = $$('.sources .result', msg)[n - 1];
      return r && openItem(r.dataset.open, true);
    }
    if (cur.type === 'ask') {
      if (act === 'newchat') return show({ type: 'ask', chat: { id: uid(), title: '', messages: [], updatedAt: Date.now() } });
      if (act === 'history') return show({ type: 'ask', chat: cur.chat, list: true });
      if (act === 'back') return show({ type: 'ask', chat: cur.chat });
      const c = t.closest('[data-chat]');
      if (c) return show({ type: 'ask', chat: Lib.state.chats.find((x) => x.id === c.dataset.chat) });
    }
    if (act === 'ask-about') return ask(`What have I saved about ${cur.id}?`, { id: uid(), title: '', messages: [], updatedAt: Date.now() });
    if (cur.type === 'item') itemEvent(e);
  });
  body.addEventListener('change', (e) => { if (cur?.type === 'item') itemEvent(e); });
  body.addEventListener('input', itemInput);
  body.addEventListener('focusout', itemBlur);
  body.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t.classList.contains('tag-in') && (e.key === 'Enter' || e.key === ',')) { e.preventDefault(); addTag(t); }
    else if (t.classList.contains('p-title') && e.key === 'Enter') { e.preventDefault(); t.blur(); }
    else if (e.key === 'Escape' && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) { e.preventDefault(); e.stopPropagation(); t.blur(); }
  });
  body.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('input', e.target);
    const q = input.value; input.value = '';
    ask(q);
  });

  // Swipe the phone sheet down to close it.
  (() => {
    let y0 = null;
    panel.addEventListener('touchstart', (e) => { if (body.scrollTop <= 0 && innerWidth <= 640) y0 = e.touches[0].clientY; }, { passive: true });
    panel.addEventListener('touchmove', (e) => {
      if (y0 == null) return;
      const dy = e.touches[0].clientY - y0;
      if (dy > 0 && body.scrollTop <= 0) panel.style.transform = `translateY(${dy}px)`;
    }, { passive: true });
    panel.addEventListener('touchend', (e) => {
      if (y0 == null) return;
      const dy = e.changedTouches[0].clientY - y0; y0 = null;
      panel.style.transform = '';
      if (dy > 110) close();
    });
  })();

  function openItem(id, center) {
    const item = Lib.byId.get(id);
    if (!item) return;
    show({ type: 'item', id });
    if (center) Web.centerOn(id);
  }
  function openConcept(tag, center) {
    show({ type: 'concept', id: tag });
    if (center && Web.node('t:' + tag)) Web.centerOn('t:' + tag);
  }
  const openSpace = (id) => show({ type: 'space', id });

  // ---- Status popover ----------------------------------------------------------------------

  const pop = $('#popover');
  function statusPopover(anchor) {
    if (!pop.hidden) return closePopover();
    const ai = Lib.state.ai, n = Lib.busy();
    const failed = Lib.state.items.filter((i) => i.ai === 'failed').length;
    const waiting = Lib.state.items.filter((i) => i.ai === 'pending' || i.ai === 'off').length;
    pop.innerHTML = ai === null ? '<h4><span class="spin"></span>Checking Claude…</h4>'
      : ai ? `<h4><span class="dot" style="background:var(--signal)"></span>Claude is connected</h4>
          <p>${n ? `Organizing ${n} ${n === 1 ? 'item' : 'items'}…` : Lib.state.settings.auto ? 'New items are summarized and tagged as you save them.' : 'Auto-organize is off. Use Organize on an item, or turn it back on in Settings.'}${failed ? ` ${failed} couldn’t be organized.` : ''}</p>
          ${failed ? '<button class="btn small ghost" data-pop="retry">Retry failed</button>' : ''}${!Lib.state.settings.auto && waiting ? `<button class="btn small primary" data-pop="all">Organize ${waiting}</button>` : ''}`
      : `<h4><span class="dot" style="background:var(--faint)"></span>Claude isn’t available</h4>
          <p>Everything you save is kept in this browser; summaries, tags and Ask need Claude, which this site hasn’t been set up with yet${navigator.onLine ? '' : ' (you also seem to be offline)'}.</p>
          <button class="btn small ghost" data-pop="recheck">Check again</button>`;
    const r = anchor.getBoundingClientRect();
    pop.hidden = false;
    pop.style.top = r.bottom + 8 + 'px';
    pop.style.left = clamp(r.right - 280, 8, innerWidth - 288) + 'px';
  }
  function closePopover() { if (pop.hidden) return false; pop.hidden = true; return true; }
  pop.addEventListener('click', (e) => {
    const a = e.target.closest('[data-pop]')?.dataset.pop;
    if (!a) return;
    closePopover();
    if (a === 'retry') Lib.state.items.filter((i) => i.ai === 'failed').forEach(Lib.regenerate);
    if (a === 'all') Lib.state.items.filter((i) => i.ai === 'pending' || i.ai === 'off').forEach(Lib.regenerate);
    if (a === 'recheck') Lib.checkAI();
  });
  document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('#status')) closePopover(); });

  // ---- Dialogs -----------------------------------------------------------------------------

  for (const d of $$('dialog')) {
    d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) d.close(''); });
  }

  function spaceOptions(sel, value) {
    sel.innerHTML = `<option value="">None</option>${Lib.state.spaces.map((s) => `<option value="${s.id}">${esc(s.emoji + ' ' + s.name)}</option>`).join('')}<option value="+">New space…</option>`;
    sel.value = value || '';
  }

  // Capture
  const dlgCap = $('#dlg-capture'), capText = $('#cap-text'), capFiles = $('#cap-files'), capSpace = $('#cap-space');
  let pending = [];
  function capture(files = [], text = '') {
    pending = [...files];
    capText.value = text;
    drawFiles();
    spaceOptions(capSpace, cur?.type === 'space' ? cur.id : '');
    dlgCap.showModal();
    capText.focus();
  }
  function drawFiles() {
    capFiles.innerHTML = pending.map((f, n) => `<span class="cap-file"><span>${esc(f.name)}</span><button type="button" data-rm="${n}" aria-label="Remove ${esc(f.name)}">×</button></span>`).join('');
  }
  capFiles.addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (b) { pending.splice(+b.dataset.rm, 1); drawFiles(); } });
  $('#cap-file').addEventListener('change', (e) => { pending.push(...e.target.files); e.target.value = ''; drawFiles(); });
  capSpace.addEventListener('change', async () => {
    if (capSpace.value !== '+') return;
    const s = await askSpace();
    spaceOptions(capSpace, s?.id || '');
  });
  capText.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('#form-capture').requestSubmit(); } });
  $('#form-capture').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = capText.value, files = pending, sp = capSpace.value === '+' ? '' : capSpace.value;
    if (!text.trim() && !files.length) return capText.focus();
    dlgCap.close();
    pending = [];
    const made = [];
    if (text.trim()) made.push(await Lib.addText(text, sp));
    for (const f of files) made.push(await Lib.addFile(f, sp));
    const last = made.filter(Boolean).pop();
    if (last) { toast(made.length > 1 ? `Saved ${made.length} items` : 'Saved'); setTimeout(() => Web.centerOn(last.id), 60); }
  });

  // New space
  const dlgSpace = $('#dlg-space');
  function askSpace() {
    return new Promise((res) => {
      $('#space-name').value = ''; $('#space-emoji').value = '📁';
      const done = async () => {
        dlgSpace.removeEventListener('close', done);
        const name = $('#space-name').value.trim();
        res(dlgSpace.returnValue !== '' && name ? await Lib.addSpace($('#space-emoji').value.trim(), name) : null);
      };
      dlgSpace.returnValue = '';
      dlgSpace.addEventListener('close', done);
      dlgSpace.showModal();
      $('#space-name').focus();
    });
  }
  $('#form-space').addEventListener('submit', (e) => { e.preventDefault(); dlgSpace.close('ok'); });

  // Settings
  const dlgSet = $('#dlg-settings');
  async function settings() {
    $('#set-auto').checked = !!Lib.state.settings.auto;
    $('#set-theme').value = Lib.state.settings.theme || '';
    drawSpaces();
    const est = await DB.estimate().catch(() => null);
    const n = Lib.state.items.length;
    $('#set-usage').textContent = `${n} ${n === 1 ? 'item' : 'items'}${est?.usage ? ` · about ${fmtSize(est.usage)} used in this browser` : ''}.`;
    dlgSet.showModal();
  }
  function drawSpaces() {
    $('#set-spaces').innerHTML = Lib.state.spaces.length ? `<div class="label">Spaces</div>${Lib.state.spaces.map((s) => `<div class="row"><span>${esc(s.emoji + ' ' + s.name)}</span><button type="button" class="btn small ghost" data-rmspace="${s.id}">Remove</button></div>`).join('')}` : '';
  }
  $('#set-auto').addEventListener('change', (e) => {
    Lib.saveSettings({ auto: e.target.checked });
    if (e.target.checked && Lib.state.ai) Lib.state.items.filter((i) => i.ai === 'pending' || i.ai === 'off').forEach((i) => Lib.enqueue(i));
  });
  $('#set-theme').addEventListener('change', (e) => Lib.saveSettings({ theme: e.target.value }));
  $('#set-spaces').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-rmspace]');
    if (!b) return;
    await Lib.removeSpace(b.dataset.rmspace);
    drawSpaces();
  });
  dlgSet.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-action]')?.dataset.action;
    if (a === 'export') Lib.exportJSON();
    if (a === 'erase') {
      if (!confirm('Erase everything in your Loom library on this browser? This can’t be undone.')) return;
      dlgSet.close(); close();
      await Lib.erase();
      toast('Library erased');
    }
  });
  $('#form-settings').addEventListener('submit', (e) => { e.preventDefault(); dlgSet.close(); });

  return {
    onChange: (fn) => { cb.change = fn; },
    get current() { return cur; },
    render, close, openItem, openConcept, openSpace, ask, capture, settings, statusPopover, closePopover,
    openAsk: () => show({ type: 'ask', chat: cur?.type === 'ask' ? cur.chat : Lib.state.chats[0] && !Lib.state.chats[0].messages.length ? Lib.state.chats[0] : { id: uid(), title: '', messages: [], updatedAt: Date.now() } }),
    editing: () => cur?.type === 'item' && body.contains(document.activeElement) && /TEXTAREA|INPUT/.test(document.activeElement.tagName),
  };
})();
