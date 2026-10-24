import { COLORS, debounce, esc, getPrefs, highlightsMarkdown, icon, shortDate, toast } from './util.js';
import { allHighlights, articleById, loadLibrary, onChange, state, syncHighlights } from './sync.js';
import { topbar, wireTopbar } from './shell.js';
import { openSettings } from './settings.js';

const view = { q: '', color: '' };

export async function renderHighlights(app, ctx) {
  app.innerHTML = `<div class="shell">${topbar('highlights')}
    <main class="page">
      <div class="filters">
        <label class="search" style="max-width:26rem;flex:1"><span class="sr">Search highlights</span>${icon('search')}<input id="hq" type="search" placeholder="Search quotes, notes, titles…" autocomplete="off"></label>
        <button class="btn" id="copy-all">${icon('copy')} Copy all as Markdown</button>
      </div>
      <div class="chips" id="hchips" role="group" aria-label="Colour"></div>
      <div id="hl-out"></div>
    </main></div>`;
  const $ = (s) => app.querySelector(s);
  $('#hq').value = view.q;
  wireTopbar(app, { onSettings: () => openSettings({ onSignOut: ctx.signOut }), onAdd: () => ctx.go('#/') });
  $('#add-toggle').hidden = true;

  let list = [];
  const labels = () => getPrefs().labels;

  function matching() {
    const q = view.q.toLowerCase().split(/\s+/).filter(Boolean);
    return list.filter((h) => {
      if (view.color && h.color !== view.color) return false;
      const a = articleById(h.article_id);
      const hay = `${h.quote} ${h.note || ''} ${a?.title || ''} ${a?.author_source || ''}`.toLowerCase();
      return q.every((t) => hay.includes(t));
    });
  }

  function render() {
    const L = labels();
    $('#hchips').innerHTML = `<button class="chip" data-c="" aria-pressed="${!view.color}">All <small>${list.length}</small></button>` +
      COLORS.map((c) => `<button class="chip" data-c="${c}" aria-pressed="${view.color === c}"><span class="swatch ${c}" style="width:14px;height:14px"></span>${esc(L[c])} <small>${list.filter((h) => h.color === c).length}</small></button>`).join('');
    const rows = matching();
    if (!rows.length) {
      $('#hl-out').innerHTML = `<div class="empty"><h2>${list.length ? 'No highlights match' : 'No highlights yet'}</h2><p>${list.length ? 'Try other words or another colour.' : 'Open an article, select some text, and pick a colour.'}</p></div>`;
      return;
    }
    const groups = new Map();
    for (const h of rows) { if (!groups.has(h.article_id)) groups.set(h.article_id, []); groups.get(h.article_id).push(h); }
    const ordered = [...groups].sort((a, b) => String(b[1][0].updated_at).localeCompare(String(a[1][0].updated_at)));
    $('#hl-out').innerHTML = `<div class="hl-groups">${ordered.map(([aid, hs]) => {
      const a = articleById(aid);
      return `<section class="hl-group"><h3><a href="#/read/${esc(aid)}">${esc(a?.title || 'Article no longer in the library')}</a></h3>
        <div class="hl-list">${hs.sort((x, y) => String(x.created_at).localeCompare(String(y.created_at))).map((h) => `
          <div class="hl-item ${h.color}" data-aid="${esc(aid)}" data-hid="${esc(h.id)}" tabindex="0">
            <q>${esc(h.quote.length > 320 ? h.quote.slice(0, 320) + '…' : h.quote)}</q>
            ${h.note ? `<div class="note">${esc(h.note)}</div>` : ''}
            <div class="meta"><span>${esc(L[h.color] || h.color)}</span><span>· ${esc(shortDate(h.created_at))}</span></div>
          </div>`).join('')}</div></section>`;
    }).join('')}</div>`;
  }

  async function reload() {
    list = await allHighlights();
    render();
  }

  $('#hq').addEventListener('input', debounce((e) => { view.q = e.target.value; render(); }, 120));
  $('#hchips').addEventListener('click', (e) => { const b = e.target.closest('[data-c]'); if (b) { view.color = b.dataset.c; render(); } });
  $('#hl-out').addEventListener('click', (e) => {
    const it = e.target.closest('.hl-item'); if (!it) return;
    ctx.read(it.dataset.aid, it.dataset.hid);
  });
  $('#hl-out').addEventListener('keydown', (e) => { const it = e.target.closest?.('.hl-item'); if (it && e.key === 'Enter') ctx.read(it.dataset.aid, it.dataset.hid); });
  $('#copy-all').onclick = () => {
    const rows = matching();
    if (!rows.length) { toast('Nothing to copy'); return; }
    const byArticle = new Map();
    rows.forEach((h) => { if (!byArticle.has(h.article_id)) byArticle.set(h.article_id, []); byArticle.get(h.article_id).push(h); });
    const md = [...byArticle].map(([aid, hs]) => highlightsMarkdown(articleById(aid) || { title: 'Untitled' }, hs, labels())).join('\n---\n\n');
    navigator.clipboard?.writeText(md).then(() => toast('Copied'), () => toast('Could not copy'));
  };

  const off = onChange((w) => { if (w === 'highlights' || w === 'library') reload(); });
  if (!state.articles.length) await loadLibrary({ refresh: false });
  await reload();
  syncHighlights();
  loadLibrary().catch(() => {});
  return () => off();
}
