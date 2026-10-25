import { api } from './api.js';
import { LOW_TIME_HINT, debounce, esc, hostOf, icon, readingLabel, shortDate, toast } from './util.js';
import { articleById, hasOffline, loadLibrary, onChange, state, updateArticle, fetchContent, getProgress } from './sync.js';
import { openMenu, openSheet } from './ui.js';
import { topbar, wireTopbar } from './shell.js';
import { openSettings } from './settings.js';

const view = { q: '', status: 'todo', category: null, sort: 'new' };
const STATUS_TABS = [['todo', 'To read'], ['done', 'Finished'], ['archive', 'Archive'], ['all', 'All']];
const SHELF_PREVIEW = 6;

const inStatus = (a) => (view.status === 'all' ? true
  : view.status === 'todo' ? ['Unread', 'Reading', ''].includes(a.status || '')
    : view.status === 'done' ? a.status === 'Finished' : a.status === 'Archive');
const when = (a) => a.published_date || a.date_added || '';
const SORTS = {
  new: (a, b) => String(when(b)).localeCompare(String(when(a))),
  old: (a, b) => String(when(a)).localeCompare(String(when(b))),
  short: (a, b) => (a.reading_time || 999) - (b.reading_time || 999),
  long: (a, b) => (b.reading_time || 0) - (a.reading_time || 0),
};

function matches(a, q) {
  if (!q) return true;
  const hay = [a.title, a.author_source, a.source_feed, a.category, (a.tags || []).join(' '), a.tldr, a.notes].join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
}

function cardHtml(a, offline, progress) {
  const t = readingLabel(a);
  const tags = (a.tags || []).slice(0, 3).join(' ');
  const fmt = a.type && a.type !== 'Article' ? a.type : a.format;
  const reading = a.status === 'Reading';
  return `<article class="card ${a.status === 'Finished' ? 'done' : ''}" data-id="${esc(a.id)}" tabindex="0" role="link" aria-label="${esc(a.title)}">
    <div class="card-top"><span class="fmt">${esc(fmt || '')}</span><span>${esc(a.source_feed || hostOf(a.url))}</span></div>
    <button class="icon-btn kebab" data-menu aria-label="More actions">${icon('more')}</button>
    <h3>${esc(a.title || a.url)}</h3>
    <p class="by">${esc(a.author_source && a.author_source !== a.source_feed ? a.author_source : '')}</p>
    ${a.tldr ? `<p class="tldr">${esc(a.tldr)}</p>` : ''}
    <div class="card-foot">
      ${t.text ? `<span class="time ${t.low ? 'low' : ''}" ${t.low ? `data-low title="${esc(LOW_TIME_HINT)}"` : ''}>${esc(t.text)}</span>` : ''}
      ${reading ? `<span class="pill reading">${progress ? Math.round(progress) + '% read' : 'Reading'}</span>` : ''}
      ${a.status === 'Finished' ? '<span class="pill">Finished</span>' : ''}
      ${tags ? `<span class="tags">${esc(tags)}</span>` : ''}
      ${offline ? '<span class="dot-off" title="Saved on this device. Kept for 30 days after you last open it.">Offline</span>' : ''}
      <span style="margin-left:auto">${esc(shortDate(when(a)))}</span>
    </div>
  </article>`;
}

export async function renderLibrary(app, ctx) {
  app.innerHTML = `<div class="shell">${topbar('library', { search: true })}
    <main class="page">
      <form class="addbar" id="addbar" hidden><input id="add-url" type="url" inputmode="url" placeholder="Paste a link to save…" required autocomplete="off"><button class="btn primary" type="submit">Add</button></form>
      <div id="banner"></div>
      <div class="filters">
        <div class="seg" id="status" role="group" aria-label="Show">${STATUS_TABS.map(([k, l]) => `<button data-s="${k}" aria-pressed="${view.status === k}">${l}</button>`).join('')}</div>
        <select class="sortsel" id="sort" aria-label="Sort">
          <option value="new">Newest first</option><option value="old">Oldest first</option>
          <option value="short">Shortest first</option><option value="long">Longest first</option>
        </select>
      </div>
      <div class="chips" id="chips" role="group" aria-label="Categories"></div>
      <div id="list"></div>
    </main></div>`;
  const $ = (s) => app.querySelector(s);
  $('#q').value = view.q;
  $('#sort').value = view.sort;
  wireTopbar(app, {
    onSettings: () => openSettings({ onSignOut: ctx.signOut }),
    onAdd: () => { const f = $('#addbar'); f.hidden = !f.hidden; if (!f.hidden) $('#add-url').focus(); },
  });

  let offlineSet = new Set();
  let progress = new Map();

  function render() {
    const all = state.articles;
    const list = all.filter(inStatus);
    const unsorted = list.filter((a) => !a.category);
    const counts = new Map();
    for (const a of list) if (a.category) counts.set(a.category, (counts.get(a.category) || 0) + 1);
    const cats = [...counts].sort((a, b) => b[1] - a[1]);

    // banners
    const waiting = all.filter((a) => !a.category).length;
    $('#banner').innerHTML =
      (state.offline ? `<div class="banner warn">You are offline. Showing what is saved on this device.</div>` : '') +
      (waiting ? `<div class="banner">${waiting} article${waiting === 1 ? ' is' : 's are'} waiting to be sorted into categories. It happens in the background; <a href="/setup.html">Setup</a> can speed it up.</div>` : '');

    // chips
    if (view.category && view.category !== '__unsorted' && !counts.has(view.category)) view.category = null;
    $('#chips').innerHTML =
      `<button class="chip" data-c="" aria-pressed="${!view.category}">All shelves <small>${list.length}</small></button>` +
      cats.map(([c, n]) => `<button class="chip" data-c="${esc(c)}" aria-pressed="${view.category === c}">${esc(c)} <small>${n}</small></button>`).join('') +
      (unsorted.length ? `<button class="chip" data-c="__unsorted" aria-pressed="${view.category === '__unsorted'}">Unsorted <small>${unsorted.length}</small></button>` : '');

    const sorter = SORTS[view.sort];
    const q = view.q.trim();
    const card = (a) => cardHtml(a, offlineSet.has(a.id), progress.get(a.id));
    let html = '';

    if (q || view.category) {
      let rows = list.filter((a) => matches(a, q));
      if (view.category === '__unsorted') rows = rows.filter((a) => !a.category);
      else if (view.category) rows = rows.filter((a) => a.category === view.category);
      rows.sort(sorter);
      if (view.category && view.category !== '__unsorted') {
        html += `<div class="shelf-head" style="margin-top:.4rem"><h2>${esc(view.category)}</h2><span class="count">${rows.length}</span><button class="btn ghost more" data-merge="${esc(view.category)}">Merge into…</button></div>`;
      }
      html += rows.length ? `<div class="grid">${rows.map(card).join('')}</div>` : emptyHtml(q);
    } else {
      const shelves = cats.map(([c]) => [c, list.filter((a) => a.category === c).sort(sorter)]);
      if (unsorted.length) shelves.push(['Waiting to be sorted', unsorted.sort(sorter)]);
      html = shelves.length ? shelves.map(([c, rows]) => `<section class="shelf">
          <div class="shelf-head"><h2>${esc(c)}</h2><span class="count">${rows.length}</span>
          ${rows.length > SHELF_PREVIEW ? `<button class="btn ghost more" data-show="${c === 'Waiting to be sorted' ? '__unsorted' : esc(c)}">Show all ${rows.length}</button>` : ''}</div>
          <div class="grid">${rows.slice(0, SHELF_PREVIEW).map(card).join('')}</div></section>`).join('') : emptyHtml('');
    }
    $('#list').innerHTML = html;
  }

  function emptyHtml(q) {
    if (q) return `<div class="empty"><h2>Nothing matches “${esc(q)}”</h2><p>Try fewer words, or look in All.</p></div>`;
    if (!state.articles.length) return `<div class="empty"><h2>Your library is empty</h2><p>Open <a href="/setup.html">Setup</a> and press “Pull feeds now”, or add a link with the + button.</p></div>`;
    return `<div class="empty"><h2>All caught up</h2><p>Nothing here. Try another tab above.</p></div>`;
  }

  async function refreshAux() {
    offlineSet = await hasOffline();
    const rows = await Promise.all(state.articles.filter((a) => a.status === 'Reading').map(async (a) => [a.id, (await getProgress(a.id))?.pct]));
    progress = new Map(rows.filter(([, p]) => p));
    render();
  }

  // ---- events ----
  $('#status').addEventListener('click', (e) => {
    const b = e.target.closest('[data-s]'); if (!b) return;
    view.status = b.dataset.s;
    $('#status').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    render();
  });
  $('#sort').onchange = (e) => { view.sort = e.target.value; render(); };
  $('#q').addEventListener('input', debounce((e) => { view.q = e.target.value; render(); }, 120));
  $('#chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-c]'); if (!b) return;
    view.category = b.dataset.c || null; render(); scrollTo({ top: 0 });
  });
  $('#addbar').addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = $('#add-url').value.trim();
    if (!url) return;
    const btn = e.target.querySelector('button'); btn.disabled = true;
    try {
      const r = await api.addUrl(url);
      toast(r.duplicate ? 'Already in your library' : 'Added. It will be sorted shortly.');
      $('#add-url').value = ''; e.target.hidden = true;
      await loadLibrary();
    } catch (err) { toast(err.message || 'Could not add that link'); }
    btn.disabled = false;
  });

  $('#list').addEventListener('click', (e) => {
    const low = e.target.closest('[data-low]');
    if (low) { toast(LOW_TIME_HINT, 4500); return; }
    const show = e.target.closest('[data-show]');
    if (show) { view.category = show.dataset.show; render(); scrollTo({ top: 0 }); return; }
    const merge = e.target.closest('[data-merge]');
    if (merge) { mergeDialog(merge.dataset.merge); return; }
    const card = e.target.closest('.card'); if (!card) return;
    const a = articleById(card.dataset.id); if (!a) return;
    if (e.target.closest('[data-menu]')) { cardMenu(e.target.closest('[data-menu]'), a); return; }
    ctx.read(a.id); // called inside the click so the browser allows full screen
  });
  $('#list').addEventListener('keydown', (e) => {
    const card = e.target.closest?.('.card');
    if (card && e.key === 'Enter' && e.target === card) ctx.read(card.dataset.id);
  });

  function cardMenu(btn, a) {
    const setStatus = (status) => () => updateArticle(a.id, { status });
    const items = [{ label: 'Read', run: () => ctx.read(a.id) }, '-'];
    if (a.status !== 'Unread') items.push({ label: 'Mark as unread', run: setStatus('Unread') });
    if (a.status !== 'Finished') items.push({ label: 'Mark as finished', run: setStatus('Finished') });
    items.push(a.status === 'Archive' ? { label: 'Move out of archive', run: setStatus('Unread') } : { label: 'Archive', run: setStatus('Archive') });
    items.push('-', { label: 'Move to category…', run: () => categoryDialog(a) });
    if (!offlineSet.has(a.id)) {
      items.push({ label: 'Save for offline', run: async () => { toast('Saving…'); try { const c = await fetchContent(a); if (c.ok === false) throw new Error(c.error); offlineSet.add(a.id); render(); toast('Saved for offline reading'); } catch (err) { toast(err.message || 'Could not save this one'); } } });
    }
    items.push({ label: 'Open original page', run: () => window.open(a.url, '_blank', 'noopener') });
    openMenu(btn, items);
  }

  function categoryDialog(a) {
    const names = [...new Set(state.articles.map((x) => x.category).filter(Boolean))].sort();
    const s = openSheet({
      title: 'Move to category',
      body: `<div class="field"><label for="cat-in">Category</label><input id="cat-in" type="text" list="cat-list" value="${esc(a.category || '')}" maxlength="40" autocomplete="off"><datalist id="cat-list">${names.map((n) => `<option value="${esc(n)}">`).join('')}</datalist><p class="hint">Pick one or type a new name.</p></div><button class="btn primary" id="cat-save">Save</button>`,
    });
    s.el.querySelector('#cat-save').onclick = async () => {
      const v = s.el.querySelector('#cat-in').value.trim();
      if (!v) return;
      s.close();
      await updateArticle(a.id, { category: v });
    };
  }

  function mergeDialog(from) {
    const names = [...new Set(state.articles.map((x) => x.category).filter((c) => c && c !== from))].sort();
    if (!names.length) { toast('There is no other category to merge into.'); return; }
    const s = openSheet({
      title: `Merge “${from}”`,
      body: `<div class="field"><label for="m-to">Move all its articles into</label><select id="m-to">${names.map((n) => `<option>${esc(n)}</option>`).join('')}</select></div><button class="btn primary" id="m-go">Merge</button>`,
    });
    s.el.querySelector('#m-go').onclick = async () => {
      const to = s.el.querySelector('#m-to').value;
      s.close();
      try { await api.mergeCategory(from, to); view.category = to; await loadLibrary(); toast(`Merged into ${to}`); } catch (err) { toast(err.message); }
    };
  }

  const off = onChange((what) => { if (what === 'library') refreshAux(); });
  render();
  loadLibrary().catch((e) => { if (e.status === 401) ctx.signOut(); else toast(e.message); }).finally(refreshAux);
  refreshAux();
  return () => off();
}
