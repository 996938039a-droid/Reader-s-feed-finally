// The reading screen: full viewport, no distractions, highlights and notes.
import { COLORS, debounce, esc, getPrefs, highlightsMarkdown, icon, setPrefs, shortDate, toast, uid } from './util.js';
import {
  articleById, deleteHighlight, fetchContent, getContent, getProgress, hasOffline, highlightsFor, onChange,
  removeContent, saveHighlight, setProgress, syncHighlights, updateArticle,
} from './sync.js';
import { describe, paint, rangeOffsets } from './highlight.js';
import { openDrawer, popover } from './ui.js';

const WIDTHS = { narrow: '33rem', medium: '40rem', wide: '50rem' };
const SPACING = { snug: 1.55, normal: 1.7, roomy: 1.95 };
const fsSupported = () => !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
const inFullscreen = () => !!(document.fullscreenElement || document.webkitFullscreenElement);

export function requestFullscreen() {
  const el = document.documentElement;
  try {
    const p = (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el, { navigationUI: 'hide' });
    p?.catch?.(() => {});
  } catch { /* not allowed here */ }
}
export function leaveFullscreen() {
  try { if (inFullscreen()) (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch { /* ignore */ }
}

/** Remove anything that could run code, then make links open in a new tab. */
function clean(html) {
  const d = new DOMParser().parseFromString(html || '', 'text/html');
  d.querySelectorAll('script,style,iframe,object,embed,form,link,meta,noscript').forEach((n) => n.remove());
  d.querySelectorAll('*').forEach((n) => {
    for (const a of [...n.attributes]) {
      if (/^on/i.test(a.name) || (/^(href|src|xlink:href)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) n.removeAttribute(a.name);
    }
    if (n.tagName === 'A') { n.target = '_blank'; n.rel = 'noopener noreferrer'; }
    if (n.tagName === 'IMG') n.loading = 'lazy';
  });
  return d.body.innerHTML;
}

export async function renderReader(app, id, ctx, { hl: focusHid } = {}) {
  const article = articleById(id);
  if (!article) { ctx.go('#/'); return () => {}; }
  const prefs0 = getPrefs();

  app.innerHTML = `<div class="reader" id="reader">
    <div class="r-progress"><i id="bar"></i></div>
    <header class="r-bar">
      <button class="icon-btn" id="r-back" aria-label="Back to library">${icon('back')}</button>
      <div class="r-title">${esc(article.title)}</div>
      <button class="icon-btn" id="r-type" aria-label="Text and theme" title="Text and theme">${icon('type')}</button>
      <button class="icon-btn" id="r-notes" aria-label="Highlights and notes" title="Highlights and notes">${icon('list')}</button>
      ${fsSupported() ? `<button class="icon-btn" id="r-full" aria-label="Full screen" title="Full screen">${icon('full')}</button>` : ''}
      <button class="icon-btn" id="r-more" aria-label="More" title="More">${icon('more')}</button>
    </header>
    <div class="r-scroll" id="scroll"><article class="r-article">
      <div class="r-head"><h1>${esc(article.title)}</h1><div class="r-meta" id="meta"></div></div>
      <div id="notice"></div>
      <div class="r-body" id="body"><p style="color:var(--muted)">Loading…</p></div>
      <footer class="r-foot" id="foot" hidden></footer>
    </article></div>
  </div>`;

  const $ = (s) => app.querySelector(s);
  const reader = $('#reader'), scroller = $('#scroll'), body = $('#body');
  let hls = [];
  let positions = new Map();
  let pending = null; // selection waiting to become a highlight
  let content = null;
  let offline = (await hasOffline()).has(id);
  const disposers = [];
  const on = (t, ev, fn, opt) => { t.addEventListener(ev, fn, opt); disposers.push(() => t.removeEventListener(ev, fn, opt)); };

  /* ---------- typography ---------- */
  function applyType() {
    const p = getPrefs();
    reader.style.setProperty('--r-size', p.size + 'px');
    reader.style.setProperty('--r-width', WIDTHS[p.width] || WIDTHS.medium);
    reader.style.setProperty('--r-lh', SPACING[p.spacing] || 1.7);
    reader.style.setProperty('--r-font', p.font === 'sans' ? 'var(--ui)' : 'var(--serif)');
  }
  applyType();

  /* ---------- header buttons ---------- */
  const goBack = () => { leaveFullscreen(); if (history.length > 1) history.back(); else ctx.go('#/'); };
  $('#r-back').onclick = goBack;
  const fsBtn = $('#r-full');
  const syncFsIcon = () => { if (fsBtn) fsBtn.innerHTML = icon(inFullscreen() ? 'exit' : 'full'); };
  if (fsBtn) fsBtn.onclick = () => (inFullscreen() ? leaveFullscreen() : requestFullscreen());
  on(document, 'fullscreenchange', syncFsIcon);
  on(document, 'webkitfullscreenchange', syncFsIcon);
  syncFsIcon();

  $('#r-type').onclick = (e) => {
    const p = getPrefs();
    const seg = (key, opts) => `<div class="seg" data-key="${key}">${opts.map(([v, l]) => `<button data-v="${v}" aria-pressed="${String(p[key]) === v}">${l}</button>`).join('')}</div>`;
    const pop = popover('typo', `
      <div class="field"><span class="lbl">Text size</span><input type="range" id="sz" min="15" max="28" step="1" value="${p.size}" aria-label="Text size"></div>
      <div class="field"><span class="lbl">Typeface</span>${seg('font', [['serif', 'Serif'], ['sans', 'Sans']])}</div>
      <div class="field"><span class="lbl">Line width</span>${seg('width', [['narrow', 'Narrow'], ['medium', 'Medium'], ['wide', 'Wide']])}</div>
      <div class="field"><span class="lbl">Line spacing</span>${seg('spacing', [['snug', 'Snug'], ['normal', 'Normal'], ['roomy', 'Roomy']])}</div>
      <div class="field"><span class="lbl">Theme</span>${seg('theme', [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']])}</div>`,
    e.currentTarget.getBoundingClientRect());
    pop.el.querySelector('#sz').oninput = (ev) => { setPrefs({ size: Number(ev.target.value) }); applyType(); };
    pop.el.addEventListener('click', (ev) => {
      const b = ev.target.closest('.seg button'); if (!b) return;
      const key = b.parentElement.dataset.key;
      setPrefs({ [key]: b.dataset.v });
      b.parentElement.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      applyType();
    });
  };

  $('#r-notes').onclick = openPanel;
  $('#r-more').onclick = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const items = [];
    items.push(offline
      ? { label: 'Remove offline copy', run: async () => { await removeContent(id); offline = false; toast('Offline copy removed'); } }
      : { label: 'Save for offline', run: async () => { if (content && content.ok !== false) { const { store } = await import('./store.js'); await store.put('content', { ...content, id, savedAt: Date.now() }); offline = true; toast('Saved for offline reading'); } else toast('Nothing to save yet'); } });
    items.push({ label: 'Reload article text', run: () => load(true) });
    items.push({ label: 'Copy highlights as Markdown', run: copyMarkdown });
    items.push({ label: 'Open original page', run: () => window.open(article.url, '_blank', 'noopener') });
    items.push({ label: 'Archive', run: async () => { await updateArticle(id, { status: 'Archive' }); toast('Archived'); goBack(); } });
    import('./ui.js').then(({ openMenu }) => openMenu(rect, items));
  };

  /* ---------- scrolling: progress, auto-hiding bar, position memory ---------- */
  let lastY = 0;
  const saveProgress = debounce(() => {
    const max = scroller.scrollHeight - scroller.clientHeight;
    const pct = max > 0 ? Math.min(100, (scroller.scrollTop / max) * 100) : 100;
    setProgress(id, pct, scroller.scrollTop);
  }, 500);
  on(scroller, 'scroll', () => {
    const y = scroller.scrollTop;
    const max = scroller.scrollHeight - scroller.clientHeight;
    $('#bar').style.width = (max > 0 ? Math.min(100, (y / max) * 100) : 0) + '%';
    const dy = y - lastY;
    if (Math.abs(dy) > 8) {
      const selecting = !getSelection()?.isCollapsed;
      if (dy > 0 && y > 120 && !selecting) reader.classList.add('immersive');
      else if (dy < 0) reader.classList.remove('immersive');
      lastY = y;
    }
    saveProgress();
  }, { passive: true });
  // A tap on the page toggles the bar; taps on links, highlights or while selecting are ignored.
  on(body, 'click', (e) => {
    if (e.target.closest('a, mark.hl, button')) return;
    if (!getSelection()?.isCollapsed) return;
    reader.classList.toggle('immersive');
  });
  on(document, 'keydown', (e) => {
    if (e.target.closest?.('input, textarea')) return;
    if (document.getElementById('layer').children.length) return;
    if (e.key === 'Escape' && !inFullscreen()) goBack();
    if (e.key === 'f' || e.key === 'F') fsBtn?.click();
  });

  /* ---------- highlights ---------- */
  const labels = () => getPrefs().labels;

  function repaint() {
    positions = paint(body, hls);
  }
  async function loadHighlights() {
    hls = await highlightsFor(id);
    repaint();
  }
  disposers.push(onChange((what) => { if (what === 'highlights') loadHighlights(); }));

  // selection toolbar
  const tool = document.createElement('div');
  tool.className = 'seltool';
  tool.hidden = true;
  tool.innerHTML = COLORS.map((c) => `<button data-c="${c}" aria-label="Highlight: ${c}"><span class="dotc ${c}"></span></button>`).join('') +
    `<span class="sep"></span><button data-note aria-label="Highlight and add a note">${icon('note')}</button>`;
  reader.appendChild(tool);
  const hideTool = () => { tool.hidden = true; pending = null; };
  const onSel = debounce(() => {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { if (!tool.matches(':hover, :focus-within')) hideTool(); return; }
    const r = sel.getRangeAt(0);
    if (!body.contains(r.commonAncestorContainer) || !r.toString().trim()) { hideTool(); return; }
    pending = rangeOffsets(body, r);
    const labelsNow = labels();
    tool.querySelectorAll('[data-c]').forEach((b) => { b.title = labelsNow[b.dataset.c]; });
    tool.hidden = false;
    const rect = r.getBoundingClientRect();
    import('./ui.js').then(({ place }) => place(tool, rect, { prefer: 'above' }));
  }, 140);
  on(document, 'selectionchange', onSel);
  on(tool, 'mousedown', (e) => e.preventDefault());
  on(tool, 'pointerdown', (e) => e.preventDefault());
  on(tool, 'click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    addHighlight(b.dataset.c || 'yellow', b.hasAttribute('data-note'));
  });

  async function addHighlight(color, withNote) {
    if (!pending) return;
    const { start, end } = pending;
    const d = describe(body, start, end);
    if (!d.quote.trim()) return;
    d.quote = d.quote.slice(0, 2500);
    const h = await saveHighlight({ id: uid(), article_id: id, ...d, color, note: '' });
    hls.push(h);
    getSelection()?.removeAllRanges();
    hideTool();
    repaint();
    if (withNote) {
      const m = body.querySelector(`mark[data-hid="${h.id}"]`);
      if (m) openHighlight(h.id, m.getBoundingClientRect(), true);
    }
  }

  on(body, 'click', (e) => {
    const m = e.target.closest('mark.hl');
    if (!m || !getSelection()?.isCollapsed) return;
    openHighlight(m.dataset.hid, m.getBoundingClientRect());
  });

  function openHighlight(hid, rect, focusNote = false) {
    const h0 = hls.find((x) => x.id === hid);
    if (!h0) return;
    const L = labels();
    let h = h0;
    const save = debounce(async (patch) => { h = await saveHighlight({ ...h, ...patch }); hls = hls.map((x) => (x.id === h.id ? h : x)); repaintKeepPopover(); }, 500);
    const pop = popover('hlpop', `
      <p class="quote">“${esc(h.quote.length > 220 ? h.quote.slice(0, 220) + '…' : h.quote)}”</p>
      <div class="colors">
        ${COLORS.map((c) => `<button class="dotc ${c}" data-c="${c}" aria-pressed="${h.color === c}" aria-label="${esc(L[c])}" title="${esc(L[c])}"></button>`).join('')}
        <span class="grow"></span>
        <button class="icon-btn" data-del aria-label="Delete highlight" title="Delete highlight">${icon('trash')}</button>
      </div>
      <textarea placeholder="Add a note…" aria-label="Note">${esc(h.note || '')}</textarea>`,
    rect, { prefer: 'below', dim: true, onClose: () => save.flush({}) });
    const ta = pop.el.querySelector('textarea');
    ta.addEventListener('input', () => save({ note: ta.value }));
    pop.el.querySelector('.colors').addEventListener('click', async (e) => {
      const c = e.target.closest('[data-c]');
      if (c) {
        save.cancel();
        h = await saveHighlight({ ...h, color: c.dataset.c, note: ta.value });
        hls = hls.map((x) => (x.id === h.id ? h : x));
        pop.el.querySelectorAll('[data-c]').forEach((b) => b.setAttribute('aria-pressed', String(b === c)));
        repaint();
      }
      if (e.target.closest('[data-del]')) {
        save.cancel();
        await deleteHighlight(h);
        hls = hls.filter((x) => x.id !== h.id);
        pop.close();
        repaint();
        toast('Highlight removed');
      }
    });
    if (focusNote) setTimeout(() => ta.focus(), 50);
  }
  const repaintKeepPopover = () => repaint();

  function scrollToHighlight(hid) {
    const m = body.querySelector(`mark[data-hid="${hid}"]`);
    if (!m) { toast('That passage is not in this version of the text.'); return; }
    m.scrollIntoView({ block: 'center' });
    reader.classList.remove('immersive');
    m.classList.add('flash');
    setTimeout(() => m.classList.remove('flash'), 1600);
  }

  function copyMarkdown() {
    const ordered = [...hls].sort((a, b) => (positions.get(a.id)?.start ?? 1e9) - (positions.get(b.id)?.start ?? 1e9));
    if (!ordered.length) { toast('No highlights yet'); return; }
    navigator.clipboard?.writeText(highlightsMarkdown(articleById(id) || article, ordered, labels())).then(() => toast('Highlights copied'), () => toast('Could not copy'));
  }

  function openPanel() {
    const a = articleById(id) || article;
    const ordered = [...hls].sort((x, y) => (positions.get(x.id)?.start ?? 1e9) - (positions.get(y.id)?.start ?? 1e9));
    const L = labels();
    const d = openDrawer({
      title: `Highlights & notes${ordered.length ? ` (${ordered.length})` : ''}`,
      body: `<div class="field"><label for="art-note">Your notes on this piece</label><textarea id="art-note" placeholder="Thoughts, questions, what to do with this…">${esc(a.notes || '')}</textarea></div>
        <div class="row"><button class="btn" id="md">${icon('copy')} Copy as Markdown</button></div>
        <div class="field" style="gap:.6rem">${ordered.length ? ordered.map((h) => `<div class="hl-item ${h.color}" data-hid="${esc(h.id)}"><q>${esc(h.quote.length > 300 ? h.quote.slice(0, 300) + '…' : h.quote)}</q>${h.note ? `<div class="note">${esc(h.note)}</div>` : ''}<div class="meta"><span>${esc(L[h.color] || h.color)}</span>${positions.has(h.id) ? '' : '<span>· text not found in this version</span>'}</div></div>`).join('') : '<p class="hint">Select any text to highlight it. Tap a highlight to add a note or change its colour.</p>'}</div>`,
    });
    const ta = d.el.querySelector('#art-note');
    const saveNote = debounce(() => updateArticle(id, { notes: ta.value }), 700);
    ta.addEventListener('input', saveNote);
    d.el.querySelector('#md').onclick = copyMarkdown;
    d.el.addEventListener('click', (e) => {
      const it = e.target.closest('.hl-item'); if (!it) return;
      d.close(); setTimeout(() => scrollToHighlight(it.dataset.hid), 60);
    });
  }

  /* ---------- content ---------- */
  function renderMeta(c) {
    const a = articleById(id) || article;
    const mins = c?.readingMinutes || (a.reading_time_low ? 0 : a.reading_time);
    const bits = [c?.byline || (a.author_source !== a.source_feed ? a.author_source : ''), a.source_feed || c?.siteName, shortDate(c?.published || a.published_date), mins ? mins + ' min read' : '']
      .filter(Boolean).map((b) => `<span>${esc(b)}</span>`);
    $('#meta').innerHTML = bits.join('');
  }

  function renderFoot() {
    const a = articleById(id) || article;
    const f = $('#foot');
    f.hidden = false;
    f.innerHTML = `<div class="row">
        ${a.status === 'Finished' ? '<span class="pill">Finished</span>' : '<button class="btn primary" id="f-done">' + icon('check') + ' Mark as finished</button>'}
        <button class="btn" id="f-notes">${icon('list')} Highlights &amp; notes</button>
        <a class="btn" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${icon('ext')} Original</a>
      </div>`;
    const done = f.querySelector('#f-done');
    if (done) done.onclick = async () => { await updateArticle(id, { status: 'Finished' }); toast('Marked as finished'); goBack(); };
    f.querySelector('#f-notes').onclick = openPanel;
  }

  async function load(force = false) {
    body.innerHTML = '<p style="color:var(--muted)">Loading…</p>';
    $('#notice').innerHTML = '';
    try {
      content = force ? await fetchContent(article, { force: true }) : (await getContent(id)) || (await fetchContent(article));
    } catch (err) {
      content = { ok: false, error: err.message || 'Could not load this article.' };
    }
    const a = articleById(id) || article;
    renderMeta(content);

    if (content.ok !== false && content.kind === 'article' && content.contentHtml) {
      body.innerHTML = clean(content.contentHtml);
    } else if (content.ok !== false && content.kind === 'arxiv') {
      body.innerHTML = `<div class="r-abstract"><h2 style="font-size:1.1em;margin-top:0">Abstract</h2><p>${esc(content.abstract || content.excerpt || '')}</p></div>`;
      $('#notice').innerHTML = `<div class="r-notice"><p>This is a research paper. The abstract is here; the full paper opens as a PDF.</p><a class="btn primary" href="${esc(content.launchUrl)}" target="_blank" rel="noopener noreferrer">${icon('ext')} Open the paper (PDF)</a></div>`;
    } else if (content.ok !== false && content.kind === 'pdf') {
      body.innerHTML = a.tldr ? `<div class="r-abstract"><h2 style="font-size:1.1em;margin-top:0">Summary</h2><p>${esc(a.tldr)}</p></div>` : '';
      $('#notice').innerHTML = `<div class="r-notice"><p>This is a PDF document, so it opens in your browser's own viewer.</p><a class="btn primary" href="${esc(content.launchUrl)}" target="_blank" rel="noopener noreferrer">${icon('ext')} Open the document</a></div>`;
    } else {
      body.innerHTML = a.tldr ? `<div class="r-abstract"><h2 style="font-size:1.1em;margin-top:0">Summary</h2><p>${esc(a.tldr)}</p></div>` : '';
      $('#notice').innerHTML = `<div class="r-notice"><p>${esc(content.error || 'This page could not be turned into a clean reading view.')}</p><div class="row"><button class="btn" id="retry">Try again</button><a class="btn primary" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${icon('ext')} Open the original</a></div></div>`;
      $('#retry').onclick = () => load(true);
    }

    offline = (await hasOffline()).has(id);
    await loadHighlights();
    renderFoot();

    // Make the stored reading time exact now that the whole text is here.
    if (content.readingMinutes && content.kind === 'article') {
      const cur = articleById(id);
      if (cur && (cur.reading_time_low || Number(cur.reading_time) !== content.readingMinutes)) {
        updateArticle(id, { reading_time: content.readingMinutes, last_error: '', reading_time_low: false });
      }
    }
  }

  if (article.status === 'Unread' || !article.status) updateArticle(id, { status: 'Reading' });
  await load();
  syncHighlights();

  // where you left off (or jump to a chosen highlight)
  if (focusHid) setTimeout(() => scrollToHighlight(focusHid), 80);
  else {
    const p = await getProgress(id);
    if (p?.y > 40) { scroller.scrollTop = p.y; lastY = p.y; }
  }

  return () => {
    saveProgress.flush();
    disposers.forEach((d) => d());
    document.getElementById('layer').innerHTML = '';
    leaveFullscreen();
  };
}
