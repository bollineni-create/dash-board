// Loom (web): Reels — your saved videos, full screen, one per swipe.
'use strict';

const Reels = (() => {
  const el = $('#reel');
  let urls = [], io = null, onDetails = () => {};
  let muted = true;
  try { muted = localStorage.getItem('loom.reelMuted') !== '0'; } catch {}

  const ICON = {
    close: '<svg viewBox="0 0 20 20" class="ico"><path d="M5 5l10 10M15 5L5 15" /></svg>',
    muted: '<svg viewBox="0 0 20 20" class="ico"><path d="M3.5 8h3l4-3.5v11L6.5 12h-3zM14 8l4 4M18 8l-4 4" /></svg>',
    sound: '<svg viewBox="0 0 20 20" class="ico"><path d="M3.5 8h3l4-3.5v11L6.5 12h-3zM13.5 7.5a3.5 3.5 0 010 5M15.5 5.5a6.5 6.5 0 010 9" /></svg>',
    play: '<svg viewBox="0 0 20 20" class="ico" style="width:30px;height:30px"><path d="M7 5v10l8-5z" class="fill" /></svg>',
  };

  const videos = () => Lib.state.items.filter((i) => i.kind === 'video');

  async function open(startId) {
    const list = videos();
    if (!list.length) return;
    // Shuffle, but start with the one asked for.
    for (let n = list.length - 1; n > 0; n--) { const m = Math.floor(Math.random() * (n + 1)); [list[n], list[m]] = [list[m], list[n]]; }
    if (startId) { const k = list.findIndex((i) => i.id === startId); if (k > 0) list.unshift(...list.splice(k, 1)); }
    el.innerHTML = `<div class="reel-top"><button data-r="close" aria-label="Close reels">${ICON.close}</button><button data-r="mute" aria-label="${muted ? 'Unmute' : 'Mute'}">${muted ? ICON.muted : ICON.sound}</button></div>` +
      list.map((i) => `<div class="reel-slide" data-id="${i.id}"><video playsinline loop preload="none"${muted ? ' muted' : ''}${i.thumb ? ` poster="${i.thumb}"` : ''}></video>
        <div class="reel-over"><h3>${esc(displayTitle(i))}</h3>${i.summary ? `<p>${esc(i.summary)}</p>` : ''}
          ${i.tags.length ? `<div class="tags">${i.tags.slice(0, 4).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
          <div class="row"><button class="btn small" data-r="fav" aria-pressed="${!!i.fav}">${i.fav ? '★ Favorite' : '☆ Favorite'}</button><button class="btn small" data-r="details">Details</button></div></div></div>`).join('');
    el.hidden = false;
    el.scrollTop = 0;
    document.body.style.overflow = 'hidden';
    io = new IntersectionObserver((entries) => entries.forEach((e) => (e.isIntersecting ? play(e.target) : pause(e.target))), { root: el, threshold: 0.6 });
    $$('.reel-slide', el).forEach((s) => io.observe(s));
    $('[data-r="close"]', el).focus();
  }

  async function play(slide) {
    const v = $('video', slide);
    if (!v.src) {
      const b = await DB.get('blobs', slide.dataset.id);
      if (!b) { $('.reel-over', slide).insertAdjacentHTML('afterbegin', '<p>This video isn’t stored in this browser.</p>'); return; }
      const u = URL.createObjectURL(b); urls.push(u); v.src = u;
    }
    v.muted = muted;
    $('.reel-paused', slide)?.remove();
    v.play().catch(() => {});
  }
  function pause(slide) { $('video', slide)?.pause(); }

  function close() {
    if (el.hidden) return false;
    io?.disconnect(); io = null;
    $$('video', el).forEach((v) => { v.pause(); v.removeAttribute('src'); v.load(); });
    urls.forEach(URL.revokeObjectURL); urls = [];
    el.hidden = true; el.innerHTML = '';
    document.body.style.overflow = '';
    $('#reels').focus();
    return true;
  }

  function heart(slide) {
    const h = document.createElement('div');
    h.className = 'reel-heart'; h.textContent = '♥';
    slide.append(h);
    setTimeout(() => h.remove(), 800);
  }

  async function setFav(slide, on) {
    const i = Lib.byId.get(slide.dataset.id);
    if (!i) return;
    i.fav = on ?? !i.fav;
    await Lib.save(i);
    const b = $('[data-r="fav"]', slide);
    b.textContent = i.fav ? '★ Favorite' : '☆ Favorite';
    b.setAttribute('aria-pressed', i.fav);
  }

  let lastTap = 0, tapTimer;
  el.addEventListener('click', (e) => {
    const r = e.target.closest('[data-r]')?.dataset.r;
    const slide = e.target.closest('.reel-slide');
    if (r === 'close') return close();
    if (r === 'mute') {
      muted = !muted;
      try { localStorage.setItem('loom.reelMuted', muted ? '1' : '0'); } catch {}
      $$('video', el).forEach((v) => { v.muted = muted; });
      const b = e.target.closest('button');
      b.innerHTML = muted ? ICON.muted : ICON.sound; b.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
      return;
    }
    if (r === 'fav') return setFav(slide);
    if (r === 'details') { const id = slide.dataset.id; close(); return onDetails(id); }
    if (!slide || e.target.closest('.reel-over .row, .tags')) return;
    // Double tap favorites; a single tap toggles play.
    const now = Date.now();
    if (now - lastTap < 300) {
      clearTimeout(tapTimer); lastTap = 0;
      heart(slide); setFav(slide, true);
      return;
    }
    lastTap = now;
    tapTimer = setTimeout(() => {
      const v = $('video', slide);
      if (v.paused) { v.play().catch(() => {}); $('.reel-paused', slide)?.remove(); }
      else { v.pause(); slide.insertAdjacentHTML('beforeend', `<div class="reel-paused">${ICON.play}</div>`); }
    }, 300);
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      el.scrollBy({ top: (e.key === 'ArrowDown' ? 1 : -1) * el.clientHeight, behavior: 'smooth' });
    }
  });

  return { open, close, get isOpen() { return !el.hidden; }, count: () => videos().length, onDetails: (fn) => { onDetails = fn; } };
})();
