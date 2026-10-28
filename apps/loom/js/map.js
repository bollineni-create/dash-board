// Loom (web): the knowledge web — concepts (tags) and spaces as hubs, items around them,
// laid out by a small force simulation on a canvas you can pan, zoom and drag.
'use strict';

const Web = (() => {
  let cv, g, W = 0, H = 0, dpr = 1;
  let nodes = [], edges = [], byKey = new Map();
  const view = { k: 1, x: 0, y: 0 };
  let alpha = 0, raf = 0, saved = {};
  let hidden = new Set(), match = null, focusKey = null, hoverKey = null, selKey = null;
  const cb = { select() {}, hover() {} };

  const itemR = (deg) => 6 + Math.min(deg, 6) * 0.7;

  async function init(canvas, handlers) {
    cv = canvas; g = cv.getContext('2d');
    Object.assign(cb, handlers);
    saved = (await DB.get('kv', 'positions')) || {};
    new ResizeObserver(resize).observe(cv);
    resize();
    bind();
  }

  function resize() {
    const r = cv.getBoundingClientRect();
    dpr = Math.min(devicePixelRatio || 1, 2);
    const first = !W;
    W = r.width; H = r.height;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    if (first) { view.x = W / 2; view.y = H / 2; }
    draw();
  }

  // ---- Graph -------------------------------------------------------------------------------

  function rebuild() {
    const old = byKey;
    nodes = []; edges = []; byKey = new Map();
    const items = Lib.state.items;
    const tags = Lib.tagCounts().slice(0, 60);
    const tagSet = new Set(tags.map((t) => t[0]));
    const add = (n) => {
      const prev = old.get(n.key), pos = saved[n.key];
      if (prev) Object.assign(n, { x: prev.x, y: prev.y, vx: 0, vy: 0, fixed: prev.fixed });
      else if (pos) Object.assign(n, { x: pos[0], y: pos[1], vx: 0, vy: 0, fixed: !!pos[2] });
      else { const a = Math.random() * Math.PI * 2, d = 60 + Math.random() * 200; Object.assign(n, { x: Math.cos(a) * d, y: Math.sin(a) * d, vx: 0, vy: 0, fresh: true }); }
      n.deg = 0; n.idx = nodes.length;
      nodes.push(n); byKey.set(n.key, n);
      return n;
    };
    for (const [t, n] of tags) add({ key: 't:' + t, type: 'concept', label: t, count: n, r: 14 + Math.sqrt(n) * 4, color: branchColor(t) });
    const spaceCount = new Map();
    for (const i of items) if (i.space) spaceCount.set(i.space, (spaceCount.get(i.space) || 0) + 1);
    for (const s of Lib.state.spaces) if (spaceCount.get(s.id)) add({ key: 's:' + s.id, type: 'space', label: s.name, emoji: s.emoji, count: spaceCount.get(s.id), r: 16 + Math.sqrt(spaceCount.get(s.id)) * 4, color: css('--accent') || '#E07A52' });
    for (const i of items) {
      const n = add({ key: i.id, type: 'item', item: i, r: 6 });
      const first = i.tags.find((t) => tagSet.has(t));
      n.color = first ? branchColor(first) : KINDS[i.kind]?.color || '#888';
      for (const t of i.tags) if (tagSet.has(t)) link(n, byKey.get('t:' + t), 80);
      if (i.space && byKey.has('s:' + i.space)) link(n, byKey.get('s:' + i.space), 90);
    }
    for (const n of nodes) if (n.type === 'item') n.r = itemR(n.deg);
    // New items start next to their first hub rather than at random.
    for (const n of nodes) if (n.fresh) {
      const e = edges.find((e) => e.a === n || e.b === n);
      const hub = e && (e.a === n ? e.b : e.a);
      if (hub && !hub.fresh) { n.x = hub.x + (Math.random() - 0.5) * 60; n.y = hub.y + (Math.random() - 0.5) * 60; }
      delete n.fresh;
    }
    const anyNew = nodes.some((n) => !old.has(n.key) && !saved[n.key]);
    if (anyNew || nodes.length !== old.size) {
      alpha = Math.max(alpha, old.size ? 0.5 : 1);
      if (!old.size && !Object.keys(saved).length) { for (let i = 0; i < 150; i++) step(); fit(false); }
    }
    kick();
  }

  function link(a, b, len) {
    if (!a || !b) return;
    edges.push({ a, b, len });
    a.deg++; b.deg++;
  }

  // ---- Simulation --------------------------------------------------------------------------

  function step() {
    const n = nodes.length;
    for (const e of edges) {
      const dx = e.b.x + e.b.vx - e.a.x - e.a.vx || 0.01, dy = e.b.y + e.b.vy - e.a.y - e.a.vy || 0.01;
      const d = Math.hypot(dx, dy);
      const f = ((d - e.len) / d) * alpha * (0.5 / Math.min(e.a.deg, e.b.deg));
      const bias = e.a.deg / (e.a.deg + e.b.deg);
      e.b.vx -= dx * f * bias; e.b.vy -= dy * f * bias;
      e.a.vx += dx * f * (1 - bias); e.a.vy += dy * f * (1 - bias);
    }
    for (let i = 0; i < n; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
        if (d2 > 640000) continue;
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        const sa = a.type === 'item' ? -140 : -520, sb = b.type === 'item' ? -140 : -520;
        b.vx -= (dx * sa * alpha) / d2; b.vy -= (dy * sa * alpha) / d2;
        a.vx += (dx * sb * alpha) / d2; a.vy += (dy * sb * alpha) / d2;
        const min = a.r + b.r + 6;
        if (d2 < min * min) {
          const d = Math.sqrt(d2), push = ((min - d) / d) * 0.5;
          a.vx -= dx * push * 0.5; a.vy -= dy * push * 0.5;
          b.vx += dx * push * 0.5; b.vy += dy * push * 0.5;
        }
      }
    }
    for (const p of nodes) {
      p.vx -= p.x * 0.012 * alpha; p.vy -= p.y * 0.012 * alpha;
      if (p.fixed || p === drag?.node) { p.vx = p.vy = 0; continue; }
      p.vx *= 0.6; p.vy *= 0.6;
      p.x += p.vx; p.y += p.vy;
    }
    alpha += (0 - alpha) * 0.0228;
  }

  function kick() { if (!raf) raf = requestAnimationFrame(frame); }
  function frame() {
    raf = 0;
    if (alpha > 0.004) { step(); raf = requestAnimationFrame(frame); }
    else if (alpha) { alpha = 0; persist(); }
    draw();
  }
  function reheat(a = 0.3) { alpha = Math.max(alpha, a); kick(); }

  let persistT;
  function persist() {
    clearTimeout(persistT);
    persistT = setTimeout(() => {
      const out = {};
      for (const n of nodes) out[n.key] = [Math.round(n.x), Math.round(n.y), n.fixed ? 1 : 0];
      saved = out;
      DB.put('kv', out, 'positions');
    }, 400);
  }

  // ---- Drawing -----------------------------------------------------------------------------

  const visible = (n) => n.type !== 'item' || !hidden.has(n.item.kind);
  function lit(n) {
    if (match) return n.type === 'item' ? match.has(n.key) : edges.some((e) => (e.a === n && match.has(e.b.key)) || (e.b === n && match.has(e.a.key)));
    if (focusKey) {
      if (n.key === focusKey) return true;
      return edges.some((e) => (e.a.key === focusKey && e.b === n) || (e.b.key === focusKey && e.a === n));
    }
    return true;
  }

  function draw() {
    if (!g) return;
    const ink = css('--ink'), muted = css('--muted'), line = css('--line'), surface = css('--surface'), accent = css('--accent');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.save();
    g.translate(view.x, view.y); g.scale(view.k, view.k);
    // Rings
    g.strokeStyle = line; g.lineWidth = 1 / view.k; g.globalAlpha = 0.5;
    for (let r = 160; r <= 960; r += 160) { g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.stroke(); }
    g.globalAlpha = 1;
    // Edges
    for (const e of edges) {
      if (!visible(e.a) || !visible(e.b)) continue;
      const on = lit(e.a) && lit(e.b);
      g.strokeStyle = (e.b.type === 'item' ? e.b : e.a).color;
      g.globalAlpha = on ? (focusKey || match ? 0.55 : 0.28) : 0.05;
      g.lineWidth = (on && (focusKey || match) ? 1.6 : 1.1) / Math.sqrt(view.k);
      const mx = (e.a.x + e.b.x) / 2, my = (e.a.y + e.b.y) / 2, dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
      g.beginPath(); g.moveTo(e.a.x, e.a.y); g.quadraticCurveTo(mx - dy * 0.12, my + dx * 0.12, e.b.x, e.b.y); g.stroke();
    }
    g.globalAlpha = 1;
    // Nodes: hubs first, items on top
    const order = nodes.filter(visible).sort((a, b) => (a.type === 'item') - (b.type === 'item'));
    const labelK = view.k;
    for (const n of order) {
      const on = lit(n);
      g.globalAlpha = on ? 1 : 0.14;
      if (n.type === 'item') {
        g.beginPath(); g.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        g.fillStyle = surface; g.fill();
        g.lineWidth = n.key === selKey || n.key === hoverKey ? 3 : 2; g.strokeStyle = n.color; g.stroke();
        g.beginPath(); g.arc(n.x, n.y, n.r * 0.45, 0, Math.PI * 2); g.fillStyle = n.item.fav ? accent : n.color; g.fill();
        if (n.item.ai === 'processing' || n.item.ai === 'pending' && Lib.busy()) {
          g.beginPath(); g.arc(n.x, n.y, n.r + 4, 0, Math.PI * 2); g.setLineDash([3, 3]); g.lineWidth = 1.2; g.strokeStyle = muted; g.stroke(); g.setLineDash([]);
        }
        if (n.key === selKey) { g.beginPath(); g.arc(n.x, n.y, n.r + 5, 0, Math.PI * 2); g.lineWidth = 2; g.strokeStyle = accent; g.stroke(); }
        if (labelK > 1.3 || n.key === hoverKey || n.key === selKey || (match && on)) label(n, displayTitle(n.item).slice(0, 34), n.y + n.r + 12, 11, muted);
      } else {
        g.beginPath(); g.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        g.fillStyle = n.color; g.globalAlpha *= n.type === 'space' ? 0.16 : 0.2; g.fill();
        g.globalAlpha = on ? 1 : 0.14;
        g.lineWidth = n.key === focusKey || n.key === hoverKey ? 2.5 : 1.5; g.strokeStyle = n.color; g.stroke();
        if (n.type === 'space') { g.font = `${Math.round(n.r * 0.9)}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(n.emoji, n.x, n.y + 1); }
        else { g.beginPath(); g.arc(n.x, n.y, 4, 0, Math.PI * 2); g.fillStyle = n.color; g.fill(); }
        label(n, n.label, n.y + n.r + 14, 13, ink, 650);
      }
    }
    g.restore();
    g.globalAlpha = 1;
  }

  function label(n, text, y, size, color, weight = 500) {
    g.font = `${weight} ${size / Math.sqrt(view.k)}px Figtree, system-ui, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 3 / Math.sqrt(view.k); g.strokeStyle = css('--ground'); g.lineJoin = 'round';
    const yy = n.y + (y - n.y) / Math.sqrt(view.k);
    g.strokeText(text, n.x, yy);
    g.fillStyle = color; g.fillText(text, n.x, yy);
  }

  // ---- Interaction -------------------------------------------------------------------------

  const toWorld = (sx, sy) => [(sx - view.x) / view.k, (sy - view.y) / view.k];
  function hit(sx, sy) {
    const [x, y] = toWorld(sx, sy);
    const pad = 6 / view.k;
    let best = null;
    for (const n of nodes) {
      if (!visible(n)) continue;
      const d = Math.hypot(n.x - x, n.y - y);
      if (d <= n.r + pad && (!best || (n.type === 'item' && best.type !== 'item') || d < best.d)) best = Object.assign(n, { d });
    }
    return best;
  }

  let drag = null;
  const ptrs = new Map();
  function bind() {
    const pos = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, pos(e));
      if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; drag = { pinch: true, d: Math.hypot(a[0] - b[0], a[1] - b[1]), k: view.k, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], vx: view.x, vy: view.y }; return; }
      const [sx, sy] = pos(e);
      const n = hit(sx, sy);
      drag = { node: n, sx, sy, vx: view.x, vy: view.y, moved: false, t: performance.now() };
      cb.hover(null);
    });
    cv.addEventListener('pointermove', (e) => {
      const p = pos(e);
      if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, p);
      if (!drag) {
        if (e.pointerType !== 'mouse') return;
        const n = hit(...p);
        const key = n?.key || null;
        cv.classList.toggle('pointing', !!n);
        if (key !== hoverKey) { hoverKey = key; draw(); }
        cb.hover(n && n.type === 'item' ? n.item : null, e.clientX, e.clientY);
        return;
      }
      if (drag.pinch) {
        if (ptrs.size < 2) return;
        const [a, b] = [...ptrs.values()];
        const k = clamp(drag.k * Math.hypot(a[0] - b[0], a[1] - b[1]) / drag.d, 0.12, 4);
        const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const wx = (drag.mid[0] - drag.vx) / drag.k, wy = (drag.mid[1] - drag.vy) / drag.k;
        view.k = k; view.x = mid[0] - wx * k; view.y = mid[1] - wy * k;
        draw(); return;
      }
      const dx = p[0] - drag.sx, dy = p[1] - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      cv.classList.add('dragging');
      if (drag.node) {
        const [x, y] = toWorld(...p);
        drag.node.x = x; drag.node.y = y; drag.node.fixed = true;
        reheat(0.15);
      } else { view.x = drag.vx + dx; view.y = drag.vy + dy; draw(); }
    });
    const up = (e) => {
      ptrs.delete(e.pointerId);
      cv.classList.remove('dragging');
      if (!drag) return;
      if (drag.pinch) { if (!ptrs.size) drag = null; return; }
      const d = drag; drag = null;
      if (!d.moved) cb.select(d.node || null);
      else if (d.node) persist();
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', () => { if (hoverKey) { hoverKey = null; draw(); } cb.hover(null); });
    cv.addEventListener('dblclick', (e) => {
      const r = cv.getBoundingClientRect();
      const n = hit(e.clientX - r.left, e.clientY - r.top);
      if (n?.fixed) { n.fixed = false; reheat(0.2); }
    });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      if (e.ctrlKey || e.deltaMode || Math.abs(e.deltaY) > 40 && !e.deltaX) zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0022)));
      else { view.x -= e.deltaX; view.y -= e.deltaY; draw(); }
    }, { passive: false });
  }

  function zoomAt(sx, sy, f) {
    const k = clamp(view.k * f, 0.12, 4);
    const wx = (sx - view.x) / view.k, wy = (sy - view.y) / view.k;
    view.k = k; view.x = sx - wx * k; view.y = sy - wy * k;
    draw();
  }

  let anim = 0;
  function animateTo(k, x, y) {
    cancelAnimationFrame(anim);
    const from = { ...view }, t0 = performance.now(), dur = matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 420;
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      view.k = from.k + (k - from.k) * e; view.x = from.x + (x - from.x) * e; view.y = from.y + (y - from.y) * e;
      draw();
      if (p < 1) anim = requestAnimationFrame(tick);
    };
    anim = requestAnimationFrame(tick);
  }

  // Leave room for the top bar, bottom bar and an open panel.
  function frameBox() {
    const panel = $('#panel');
    const side = !panel.hidden && W > 640 ? panel.offsetWidth + 24 : 0;
    const sheet = !panel.hidden && W <= 640 ? panel.offsetHeight : 0;
    return { l: 20, r: W - side - 20, t: 76, b: H - Math.max(96, sheet + 16) };
  }

  function fit(animate = true) {
    const vis = nodes.filter(visible);
    const box = frameBox();
    if (!vis.length) { const k = 1; return animate ? animateTo(k, (box.l + box.r) / 2, (box.t + box.b) / 2) : Object.assign(view, { k, x: (box.l + box.r) / 2, y: (box.t + box.b) / 2 }); }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of vis) { x0 = Math.min(x0, n.x - n.r - 30); y0 = Math.min(y0, n.y - n.r - 30); x1 = Math.max(x1, n.x + n.r + 30); y1 = Math.max(y1, n.y + n.r + 30); }
    const k = clamp(Math.min((box.r - box.l) / (x1 - x0), (box.b - box.t) / (y1 - y0)), 0.12, 1.6);
    const x = (box.l + box.r) / 2 - ((x0 + x1) / 2) * k, y = (box.t + box.b) / 2 - ((y0 + y1) / 2) * k;
    if (animate) animateTo(k, x, y); else Object.assign(view, { k, x, y });
  }

  function centerOn(key) {
    const n = byKey.get(key);
    if (!n) return;
    const box = frameBox();
    const k = Math.max(view.k, 0.9);
    animateTo(k, (box.l + box.r) / 2 - n.x * k, (box.t + box.b) / 2 - n.y * k);
  }

  return {
    init, rebuild, draw, fit, centerOn, reheat,
    zoom: (dir) => { const box = frameBox(); zoomAt((box.l + box.r) / 2, (box.t + box.b) / 2, dir > 0 ? 1.3 : 1 / 1.3); },
    setHidden: (set) => { hidden = set; draw(); },
    setMatch: (ids) => { match = ids; draw(); },
    setFocus: (key) => { focusKey = key; draw(); },
    setSelected: (key) => { selKey = key; draw(); },
    node: (key) => byKey.get(key),
    get size() { return nodes.length; },
  };
})();
