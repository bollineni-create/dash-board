// Loom (web): wires the library, map, panels and reels to the page.
'use strict';

(async () => {
  const stage = $('#stage'), hover = $('#hovercard'), search = $('#search'), results = $('#results');
  const hiddenKinds = new Set();

  // ---- Theme -------------------------------------------------------------------------------

  function applyTheme() {
    const t = Lib.state.settings.theme;
    if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    Web.rebuild();
  }

  // ---- Legend ------------------------------------------------------------------------------

  function legend() {
    const counts = {};
    for (const i of Lib.state.items) counts[i.kind] = (counts[i.kind] || 0) + 1;
    const kinds = Object.keys(KINDS).filter((k) => counts[k]);
    $('#legend').innerHTML = kinds.length > 1 ? kinds.map((k) => `<button class="chip${hiddenKinds.has(k) ? ' off' : ''}" data-kind="${k}" aria-pressed="${!hiddenKinds.has(k)}"><i style="background:${KINDS[k].color}"></i>${KINDS[k].plural} ${counts[k]}</button>`).join('') : '';
  }
  $('#legend').addEventListener('click', (e) => {
    const k = e.target.closest('[data-kind]')?.dataset.kind;
    if (!k) return;
    hiddenKinds.has(k) ? hiddenKinds.delete(k) : hiddenKinds.add(k);
    Web.setHidden(new Set(hiddenKinds));
    legend();
  });

  // ---- Status, tray, empty state -----------------------------------------------------------

  function status() {
    const dot = $('#status .dot'), ai = Lib.state.ai, n = Lib.busy();
    dot.className = 'dot' + (ai === null ? '' : !ai ? '' : n ? ' busy' : ' ready');
    $('#status').title = ai === null ? 'Checking Claude…' : !ai ? 'Claude isn’t available' : n ? `Organizing ${n}…` : 'Claude is connected';
    $('#status').setAttribute('aria-label', $('#status').title);
  }
  function tray() {
    const working = Lib.state.items.filter((i) => i.ai === 'processing' || i.reading);
    const extra = Lib.busy() - working.length;
    $('#tray').innerHTML = working.slice(0, 3).map((i) => `<div class="tray-item"><span class="spin"></span><span class="lbl">${i.reading ? 'Reading' : 'Organizing'} ${esc(displayTitle(i))}</span></div>`).join('') +
      (extra > 0 ? `<div class="tray-item"><span class="lbl">${extra} more waiting</span></div>` : '');
  }
  function empty() {
    $('#empty').hidden = Lib.state.items.length > 0;
    $('#legend').hidden = !Lib.state.items.length;
    $('#reels').hidden = !Reels.count();
  }
  function refresh() { legend(); status(); tray(); empty(); }

  // ---- Hover card --------------------------------------------------------------------------

  function hoverCard(item, x, y) {
    if (!item) { hover.hidden = true; return; }
    const k = KINDS[item.kind], img = item.thumb || item.image;
    hover.innerHTML = `${img ? `<img src="${esc(img)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}<div class="b"><div class="k" style="color:${k.color}">${k.label}${item.url ? ' · ' + esc(hostOf(item.url)) : ''}</div><div class="t">${esc(displayTitle(item))}</div>${item.summary ? `<div class="s">${esc(item.summary)}</div>` : ''}</div>`;
    hover.hidden = false;
    const r = stage.getBoundingClientRect(), w = hover.offsetWidth, h = hover.offsetHeight;
    let left = x - r.left + 16, top = y - r.top + 16;
    if (left + w > r.width - 8) left = x - r.left - w - 16;
    if (top + h > r.height - 8) top = y - r.top - h - 16;
    hover.style.left = Math.max(8, left) + 'px'; hover.style.top = Math.max(8, top) + 'px';
  }

  // ---- Map selection <-> panel -------------------------------------------------------------

  function select(n) {
    hover.hidden = true;
    closeResults();
    if (!n) { if (!Panels.editing()) Panels.close(); return; }
    if (n.type === 'item') Panels.openItem(n.key);
    else if (n.type === 'concept') Panels.openConcept(n.label);
    else if (n.type === 'space') Panels.openSpace(n.key.slice(2));
  }
  Panels.onChange((cur) => {
    const key = !cur ? null : cur.type === 'item' ? cur.id : cur.type === 'concept' ? 't:' + cur.id : cur.type === 'space' ? 's:' + cur.id : null;
    document.body.classList.toggle('panel-open', !!cur);
    Web.setSelected(key);
    Web.setFocus(cur && (cur.type === 'concept' || cur.type === 'space') ? key : null);
  });
  Reels.onDetails((id) => Panels.openItem(id, true));

  // ---- Search ------------------------------------------------------------------------------

  let hits = [], sel = -1;
  function runSearch() {
    const q = search.value.trim();
    if (!q) { closeResults(); return; }
    hits = Lib.search(q, { limit: 8 });
    sel = hits.length ? 0 : -1;
    Web.setMatch(new Set(hits.map((i) => i.id)));
    drawResults(q);
  }
  function drawResults(q) {
    results.innerHTML = hits.length ? hits.map((i, n) => {
      const k = KINDS[i.kind];
      return `<button class="result${n === sel ? ' on' : ''}" role="option" aria-selected="${n === sel}" data-open="${i.id}"><span class="kind-badge" style="background:${k.color}">${k.glyph}</span><span class="meta"><span class="t">${esc(displayTitle(i))}</span><span class="s">${esc(i.summary || hostOf(i.url) || relTime(i.createdAt))}</span></span></button>`;
    }).join('') + (Lib.state.ai ? `<button class="result" data-askq="${esc(q)}"><span class="kind-badge" style="background:var(--accent)">✦</span><span class="meta"><span class="t">Ask “${esc(q)}”</span><span class="s">Claude answers from your library</span></span></button>` : '')
      : `<div class="result-empty">Nothing matches “${esc(q)}”.</div>${Lib.state.ai ? `<button class="result" data-askq="${esc(q)}"><span class="kind-badge" style="background:var(--accent)">✦</span><span class="meta"><span class="t">Ask “${esc(q)}”</span><span class="s">Claude answers from your library</span></span></button>` : ''}`;
    results.hidden = false;
  }
  function closeResults() {
    if (results.hidden && !hits.length) return false;
    results.hidden = true; hits = []; sel = -1;
    Web.setMatch(null);
    return true;
  }
  search.addEventListener('input', runSearch);
  search.addEventListener('focus', () => { if (search.value.trim()) runSearch(); });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!hits.length) return;
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length;
      drawResults(search.value.trim());
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (hits[sel]) { const id = hits[sel].id; closeResults(); search.blur(); Panels.openItem(id, true); }
      else if (search.value.trim() && Lib.state.ai) { const q = search.value; closeResults(); search.value = ''; Panels.ask(q); }
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      if (search.value) { search.value = ''; closeResults(); } else search.blur();
    }
  });
  results.addEventListener('pointerdown', (e) => e.preventDefault()); // keep focus in the field
  results.addEventListener('click', (e) => {
    const o = e.target.closest('[data-open]'), a = e.target.closest('[data-askq]');
    if (o) { closeResults(); search.blur(); Panels.openItem(o.dataset.open, true); }
    else if (a) { closeResults(); search.value = ''; search.blur(); Panels.ask(a.dataset.askq); }
  });
  document.addEventListener('pointerdown', (e) => { if (!results.hidden && !e.target.closest('.search-wrap')) { results.hidden = true; } });

  // ---- Ask bar, buttons --------------------------------------------------------------------

  $('#ask-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#ask-input').value.trim();
    if (!q) return Panels.openAsk();
    $('#ask-input').value = '';
    $('#ask-input').blur();
    Panels.ask(q);
  });
  $('#capture').addEventListener('click', () => Panels.capture());
  $('#settings').addEventListener('click', () => Panels.settings());
  $('#status').addEventListener('click', (e) => Panels.statusPopover(e.currentTarget));
  $('#reels').addEventListener('click', () => { Panels.close(); Reels.open(); });
  $$('[data-zoom]').forEach((b) => b.addEventListener('click', () => { const z = b.dataset.zoom; z === 'fit' ? Web.fit() : Web.zoom(z === 'in' ? 1 : -1); }));
  $('#empty').addEventListener('click', async (e) => {
    const a = e.target.closest('[data-action]')?.dataset.action;
    if (a === 'capture') Panels.capture();
    if (a === 'samples') { await Lib.addSamples(); setTimeout(() => Web.fit(), 400); }
  });

  // ---- Paste and drop ----------------------------------------------------------------------

  const typing = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  document.addEventListener('paste', async (e) => {
    if (typing(e.target) || document.querySelector('dialog[open]') || Reels.isOpen) return;
    const files = [...(e.clipboardData?.files || [])];
    const text = e.clipboardData?.getData('text/plain') || '';
    if (!files.length && !text.trim()) return;
    e.preventDefault();
    const made = [];
    for (const f of files) made.push(await Lib.addFile(f, ''));
    if (!files.length) made.push(await Lib.addText(text, ''));
    const last = made.filter(Boolean).pop();
    if (last) { toast('Saved'); setTimeout(() => Web.centerOn(last.id), 60); }
  });

  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].some((t) => t === 'Files' || t === 'text/uri-list' || t === 'text/plain');
  document.addEventListener('dragenter', (e) => { if (!hasFiles(e) || Reels.isOpen) return; e.preventDefault(); dragDepth++; $('#drop').hidden = false; });
  document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').hidden = true; } });
  document.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0; $('#drop').hidden = true;
    if (document.querySelector('dialog[open]')) {
      // Dropped on the capture dialog: add to its pending files.
      if (e.dataTransfer.files.length && $('#dlg-capture').open) { Panels.capture([...e.dataTransfer.files], $('#cap-text').value); }
      return;
    }
    const files = [...e.dataTransfer.files];
    const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    const made = [];
    for (const f of files) made.push(await Lib.addFile(f, ''));
    if (!files.length && text.trim()) made.push(await Lib.addText(text.split('\n').find((l) => l && !l.startsWith('#')) || text, ''));
    const last = made.filter(Boolean).pop();
    if (last) { toast(made.length > 1 ? `Saved ${made.length} items` : 'Saved'); setTimeout(() => Web.centerOn(last.id), 60); }
  });

  // ---- Keyboard ----------------------------------------------------------------------------

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (document.querySelector('dialog[open]')) return; // the dialog closes itself
      if (Reels.close() || Panels.closePopover() || Panels.close() || closeResults()) e.preventDefault();
      return;
    }
    if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]') || Reels.isOpen) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); search.focus(); search.select(); }
      return;
    }
    if (e.key === '/') { e.preventDefault(); search.focus(); }
    else if (e.key === 'n') { e.preventDefault(); Panels.capture(); }
    else if (e.key === 'a') { e.preventDefault(); $('#ask-input').focus(); }
    else if (e.key === 'f') Web.fit();
    else if (e.key === '+' || e.key === '=') Web.zoom(1);
    else if (e.key === '-') Web.zoom(-1);
  });

  // ---- Library events ----------------------------------------------------------------------

  let rebuildTimer;
  Lib.on((what, detail) => {
    if (what === 'load') { Web.rebuild(); Web.fit(false); Panels.close(); refresh(); return; }
    if (what === 'settings') { applyTheme(); return; }
    if (what === 'ai') { status(); Panels.render(); return; }
    if (what === 'queue') { status(); tray(); return; }
    if (what === 'items' || what === 'spaces') {
      clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(() => Web.rebuild(), 30);
      refresh();
      const cur = Panels.current;
      if (cur && !Panels.editing() && (cur.type !== 'item' || !detail || detail.id === cur.id)) Panels.render();
      if (cur?.type === 'item' && !Lib.byId.has(cur.id)) Panels.close();
    }
  });

  // ---- Start -------------------------------------------------------------------------------

  await Web.init($('#web'), { select, hover: hoverCard });
  try { await Lib.load(); } catch (e) { toast(e.message || 'Loom couldn’t open its storage in this browser.'); }
  applyTheme();
  Web.fit(false);
  refresh();
  DB.persist();
  Lib.checkAI();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => Web.rebuild());
})();
