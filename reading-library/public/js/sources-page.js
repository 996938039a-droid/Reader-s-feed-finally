import { api } from './api.js';
import { esc, hostOf, icon, timeAgo, toast } from './util.js';
import { loadLibrary } from './sync.js';
import { topbar, wireTopbar } from './shell.js';
import { openSettings } from './settings.js';
import { openSheet } from './ui.js';

export async function renderSources(app, ctx) {
  app.innerHTML = `<div class="shell">${topbar('sources')}
    <main class="page narrow">
      <h1 class="page-title">Sources</h1>
      <p class="hint">Where your articles come from. New posts are pulled automatically every 6 hours.</p>

      <form class="panel" id="src-form">
        <label class="lbl" for="src-url">Add a source</label>
        <div class="addbar" style="margin:0">
          <input id="src-url" type="text" inputmode="url" placeholder="Paste a website or feed address, e.g. quantamagazine.org" autocomplete="off" required>
          <button class="btn primary" type="submit" id="src-go">Add</button>
        </div>
        <label class="row" style="margin-top:.2rem"><input type="checkbox" id="src-long" checked> Long reads only: skip pieces shorter than
          <select id="src-min" style="width:auto;min-height:34px"><option>5</option><option selected>6</option><option>8</option><option>10</option><option>15</option></select> minutes</label>
        <p class="hint" id="src-msg" role="status"></p>
      </form>

      <div class="row" style="justify-content:space-between;margin:1.6rem 0 .6rem"><h2 class="sec">Your sources</h2><button class="btn" id="pull-all">Check all now</button></div>
      <div id="src-list"><p class="hint">Loading…</p></div>

      <h2 class="sec" style="margin:2rem 0 .3rem">Suggested long-form sources</h2>
      <p class="hint" style="margin-bottom:.8rem">Tap Add and the app finds the feed and checks it works before saving.</p>
      <div id="sugg" class="sugg"></div>
    </main></div>`;
  const $ = (s) => app.querySelector(s);
  wireTopbar(app, { onSettings: () => openSettings({ onSignOut: ctx.signOut }), onAdd: () => $('#src-url').focus() });
  $('#add-toggle').hidden = true;

  let data = { sources: [], suggestions: [] };
  const msg = (t, bad = false) => { const m = $('#src-msg'); m.textContent = t; m.style.color = bad ? 'var(--danger)' : ''; };

  function statusLine(s) {
    if (!s.last_fetched) return '<span>Not pulled yet</span>';
    const bad = /^failed/i.test(s.last_status || '');
    return `<span ${bad ? 'style="color:var(--danger)"' : ''}>${bad ? esc(s.last_status) : 'Checked ' + esc(timeAgo(s.last_fetched))}</span>`;
  }

  function render() {
    const list = data.sources;
    $('#src-list').innerHTML = list.length ? list.map((s) => `<div class="src" data-id="${esc(s.id)}">
        <div class="src-main">
          <strong>${esc(s.name)}</strong>
          <div class="src-meta"><span>${s.article_count || 0} articles</span>${statusLine(s)}<a href="${esc(s.site_url || s.feed_url)}" target="_blank" rel="noopener noreferrer">${esc(hostOf(s.site_url || s.feed_url))}</a></div>
        </div>
        <div class="src-ctl">
          <label class="row"><input type="checkbox" data-act="active" ${s.active ? 'checked' : ''}> On</label>
          <label class="row"><input type="checkbox" data-act="long" ${s.long_only ? 'checked' : ''}> Long reads only${s.long_only ? ` (${s.min_minutes || 6}+ min)` : ''}</label>
          <button class="btn ghost danger" data-act="remove">Remove</button>
        </div>
      </div>`).join('') : '<p class="hint">No sources yet.</p>';

    const have = new Set(list.map((s) => hostOf(s.site_url || s.feed_url)));
    const sugg = data.suggestions.filter((g) => !have.has(hostOf(g.site)));
    $('#sugg').innerHTML = sugg.length ? sugg.map((g) => `<div class="card sugg-card" style="cursor:default">
        <h3>${esc(g.name)}</h3><p class="tldr" style="-webkit-line-clamp:3">${esc(g.about)}</p>
        <div class="card-foot"><button class="btn" data-add="${esc(g.site)}" data-name="${esc(g.name)}">${icon('plus')} Add</button></div></div>`).join('') : '<p class="hint">You have added all the suggestions.</p>';
  }

  async function reload() {
    try { data = await api.sources(); render(); } catch (e) { $('#src-list').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  }

  async function addSource(url, name) {
    const longOnly = $('#src-long').checked;
    const opts = { long_only: longOnly, min_minutes: Number($('#src-min').value) };
    if (name) opts.name = name;
    msg('Looking for the feed…');
    let r;
    try { r = await api.addSource(url, opts); } catch (e) { msg(e.message, true); return false; }
    if (r.duplicate) { msg(`“${r.name}” is already in your sources.`); return true; }
    msg(`Found “${r.name}”. Fetching its first articles…`);
    try {
      const pulled = await api.pullSource(r.id);
      const n = pulled.report?.[0]?.added ?? 0;
      msg(n ? `Added “${r.name}” with ${n} articles. They will be sorted into categories shortly.` : `Added “${r.name}”, but nothing qualified yet${longOnly ? ' (short pieces are skipped)' : ''}. It will keep checking.`);
      toast(n ? `${n} articles added from ${r.name}` : `${r.name} added`);
      loadLibrary().catch(() => {});
    } catch (e) { msg(`Added “${r.name}”. The first pull did not finish (${e.message}); it will happen on the next automatic check.`); }
    await reload();
    return true;
  }

  $('#src-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#src-go'); btn.disabled = true;
    const ok = await addSource($('#src-url').value.trim());
    if (ok) $('#src-url').value = '';
    btn.disabled = false;
  });
  $('#sugg').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-add]'); if (!b) return;
    b.disabled = true; b.textContent = 'Adding…';
    window.scrollTo({ top: 0, behavior: 'smooth' });
    await addSource(b.dataset.add, b.dataset.name);
    b.disabled = false;
    render();
  });
  $('#src-list').addEventListener('change', async (e) => {
    const row = e.target.closest('.src'); const act = e.target.dataset.act; if (!row || !act) return;
    const id = row.dataset.id;
    try {
      if (act === 'active') await api.updateSource(id, { active: e.target.checked });
      if (act === 'long') await api.updateSource(id, { long_only: e.target.checked, min_minutes: e.target.checked ? Number($('#src-min').value) : 0 });
      await reload();
    } catch (err) { toast(err.message); reload(); }
  });
  $('#src-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act="remove"]'); if (!b) return;
    const row = b.closest('.src'); const s = data.sources.find((x) => x.id === row.dataset.id);
    const sheet = openSheet({ title: `Remove ${s.name}?`, body: `<p class="hint">Its ${s.article_count || 0} articles stay in your library. No new ones will be pulled.</p><div class="row"><button class="btn danger" id="rm-go">Remove source</button><button class="btn" id="rm-no">Keep it</button></div>` });
    sheet.el.querySelector('#rm-no').onclick = () => sheet.close();
    sheet.el.querySelector('#rm-go').onclick = async () => { sheet.close(); try { await api.deleteSource(s.id); toast('Source removed'); await reload(); } catch (err) { toast(err.message); } };
  });
  $('#pull-all').onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = 'Checking…';
    try {
      const r = await api.harvest();
      const added = (r.report || []).reduce((n, x) => n + (x.added || 0), 0);
      toast(added ? `${added} new articles` : 'Nothing new right now');
      loadLibrary().catch(() => {});
      await reload();
    } catch (err) { toast(err.message); }
    e.target.disabled = false; e.target.textContent = 'Check all now';
  };

  await reload();
  return () => {};
}
