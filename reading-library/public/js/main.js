import { api, ApiError, getPass, setPass } from './api.js';
import { applyTheme, esc, firstUrl, getPrefs, toast } from './util.js';
import { articleById, loadLibrary, purgeExpiredContent, state, syncAll } from './sync.js';
import { renderLibrary } from './library.js';
import { renderReader, requestFullscreen } from './reader.js';
import { renderHighlights } from './highlights-page.js';
import { renderSources } from './sources-page.js';
import { closeAll } from './ui.js';

const app = document.getElementById('app');
let cleanup = null;
let routeId = 0;

const ctx = {
  go: (hash) => { location.hash = hash; },
  // Called from inside a tap/click, which is what lets the browser go full screen.
  read: (id, hid) => {
    if (getPrefs().fullscreen) requestFullscreen();
    location.hash = '#/read/' + id + (hid ? '?h=' + hid : '');
  },
  signOut: () => { setPass(''); route(); },
};

function renderLogin(message = '') {
  app.innerHTML = `<main class="login"><form id="login" autocomplete="on">
    <h1>Library</h1><p>Enter your passphrase to open your reading library.</p>
    <input type="password" id="pass" name="password" placeholder="Passphrase" autocomplete="current-password" required autofocus aria-label="Passphrase">
    <p class="err" id="err">${esc(message)}</p>
    <button class="btn primary" type="submit">Open</button>
  </form></main>`;
  const form = app.querySelector('#login');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = app.querySelector('#err');
    setPass(app.querySelector('#pass').value);
    err.textContent = 'Checking…';
    try {
      await api.auth();
      route();
    } catch (ex) {
      setPass('');
      err.textContent = ex instanceof ApiError && ex.status === 401 ? 'That passphrase is not right.' : ex.message;
    }
  };
}

/** Links arriving from the share sheet or the bookmarklet (?add=…, or ?url=/?text= from Share). */
async function handleIncoming() {
  const q = new URLSearchParams(location.search);
  const target = firstUrl(q.get('add'), q.get('url'), q.get('text'));
  if (!q.has('add') && !q.has('url') && !q.has('text')) return;
  history.replaceState(null, '', '/' + location.hash);
  if (!target) { toast('No link found in what was shared.'); return; }
  toast('Saving link…');
  try {
    const r = await api.addUrl(target);
    toast(r.duplicate ? 'That one is already in your library' : 'Saved. It will be sorted shortly.');
    loadLibrary().catch(() => {});
  } catch (e) { toast(e.message || 'Could not save that link'); }
}

async function route() {
  const my = ++routeId;
  try { cleanup?.(); } catch { /* view already gone */ }
  cleanup = null;
  closeAll();
  if (!getPass()) { renderLogin(); return; }

  const [path, qs] = (location.hash.slice(1) || '/').split('?');
  const params = new URLSearchParams(qs || '');
  let fn;
  try {
    if (path.startsWith('/read/')) {
      const id = decodeURIComponent(path.slice(6));
      if (!articleById(id)) await loadLibrary({ refresh: false }).catch(() => {});
      if (!articleById(id)) await loadLibrary().catch(() => {});
      fn = await renderReader(app, id, ctx, { hl: params.get('h') });
    } else if (path === '/sources') {
      fn = await renderSources(app, ctx);
    } else if (path === '/highlights') {
      fn = await renderHighlights(app, ctx);
    } else {
      fn = await renderLibrary(app, ctx);
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) { setPass(''); renderLogin('Please sign in again.'); return; }
    app.innerHTML = `<main class="login"><div><h1>Something went wrong</h1><p>${esc(e.message)}</p><a class="btn" href="#/">Back to the library</a></div></main>`;
    return;
  }
  if (my !== routeId) { fn?.(); return; }
  cleanup = fn;
  window.scrollTo(0, 0);
}

applyTheme();
addEventListener('hashchange', route);
route().then(() => { if (getPass()) { handleIncoming(); syncAll(); purgeExpiredContent(); } });

if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
