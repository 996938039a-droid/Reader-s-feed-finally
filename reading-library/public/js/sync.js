// Keeps the library, article edits and highlights in step between this device and the Sheet.
// Everything is written to the device first, so reading and highlighting work offline;
// changes are sent when a connection is available.
import { api, ApiError } from './api.js';
import { store, getMeta, setMeta } from './store.js';
import { uid } from './util.js';

const listeners = new Set();
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (what) => listeners.forEach((fn) => { try { fn(what); } catch { /* a view failed; ignore */ } });

export const state = { articles: [], pending: 0, offline: false, syncing: false };

export function deviceId() {
  try {
    let d = localStorage.getItem('rl_device');
    if (!d) { d = uid(); localStorage.setItem('rl_device', d); }
    return d;
  } catch { return 'device'; }
}

/* ---------- library ---------- */
export async function loadLibrary({ refresh = true } = {}) {
  const cached = await store.all('articles').catch(() => []);
  if (cached.length) { state.articles = cached; emit('library'); }
  if (!refresh) return state;
  try {
    const data = await api.library();
    // Re-apply edits that have not reached the Sheet yet so the screen never jumps back.
    const outbox = await store.all('outbox').catch(() => []);
    const byId = new Map(data.articles.map((a) => [a.id, a]));
    for (const o of outbox) if (byId.has(o.id)) Object.assign(byId.get(o.id), o.fields);
    state.articles = [...byId.values()];
    state.pending = data.pending || 0;
    state.offline = false;
    await store.replaceAll('articles', state.articles).catch(() => {});
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) throw e;
    state.offline = true;
    if (!state.articles.length) throw e;
  }
  emit('library');
  return state;
}

export const articleById = (id) => state.articles.find((a) => a.id === id);

/** Change an article: applied on screen at once, then sent (or queued while offline). */
export async function updateArticle(id, fields) {
  const a = articleById(id);
  if (a) { Object.assign(a, fields); await store.put('articles', a).catch(() => {}); }
  await store.put('outbox', { id, fields, at: Date.now() }).catch(() => {});
  emit('library');
  flushOutbox();
}

let flushing = false;
export async function flushOutbox() {
  if (flushing) return;
  flushing = true;
  try {
    const items = await store.all('outbox');
    for (const o of items) {
      try {
        await api.update(o.id, o.fields);
        await store.del('outbox', o.key);
      } catch (e) {
        if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 408 && e.status !== 429) await store.del('outbox', o.key); // will never succeed
        else break; // offline or server trouble: keep for later
      }
    }
  } catch { /* ignore */ } finally { flushing = false; }
}

/* ---------- highlights ---------- */
export const highlightsFor = (articleId) => store.byIndex('highlights', 'article_id', articleId).then((l) => l.filter((h) => !h.deleted));
export const allHighlights = () => store.all('highlights').then((l) => l.filter((h) => !h.deleted));

export async function saveHighlight(h) {
  const now = new Date().toISOString();
  const rec = { created_at: now, device: deviceId(), ...h, updated_at: now, dirty: true };
  await store.put('highlights', rec);
  emit('highlights');
  scheduleSync();
  return rec;
}
export const deleteHighlight = (h) => saveHighlight({ ...h, deleted: true });

let timer;
export function scheduleSync(ms = 1500) { clearTimeout(timer); timer = setTimeout(syncHighlights, ms); }

export async function syncHighlights() {
  if (state.syncing) return;
  state.syncing = true;
  try {
    // 1. send local changes
    const all = await store.all('highlights');
    const dirty = all.filter((h) => h.dirty);
    for (let i = 0; i < dirty.length; i += 50) {
      const chunk = dirty.slice(i, i + 50);
      const res = await api.pushHighlights(chunk.map(({ dirty: _d, ...rest }) => rest));
      const conflict = new Set((res.conflicts || []).map((c) => c.id));
      await store.putMany('highlights', [
        ...chunk.filter((h) => !conflict.has(h.id)).map((h) => ({ ...h, dirty: false })),
        ...(res.conflicts || []).map((c) => ({ ...c, deleted: !!c.deleted, dirty: false })),
      ]);
    }
    // 2. fetch what changed elsewhere
    const since = await getMeta('hl_since', '');
    const { highlights = [] } = await api.highlights(since);
    if (highlights.length) {
      const local = new Map((await store.all('highlights')).map((h) => [h.id, h]));
      const take = highlights.filter((s) => { const l = local.get(s.id); return !l || (!l.dirty && s.updated_at >= l.updated_at); });
      await store.putMany('highlights', take.map((s) => ({ ...s, deleted: !!s.deleted, dirty: false })));
      const newest = highlights.reduce((m, h) => (h.updated_at > m ? h.updated_at : m), since);
      await setMeta('hl_since', newest);
    }
    emit('highlights');
  } catch { /* offline: try again later */ } finally { state.syncing = false; }
}

export async function syncAll() {
  await flushOutbox();
  await syncHighlights();
}
addEventListener('online', () => { syncAll(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncAll(); });

/* ---------- offline copies of articles ---------- */
export const getContent = (id) => store.get('content', id).catch(() => undefined);
export const hasOffline = async () => new Set((await store.all('content').catch(() => [])).map((c) => c.id));
export async function fetchContent(article, { force = false } = {}) {
  if (!force) {
    const have = await getContent(article.id);
    if (have) return have;
  }
  const data = await api.extract(article.url);
  const rec = { ...data, id: article.id, savedAt: Date.now() };
  if (data.ok !== false) await store.put('content', rec).catch(() => {});
  return rec;
}
export const removeContent = (id) => store.del('content', id).catch(() => {});

/* ---------- reading position ---------- */
export const getProgress = (id) => store.get('progress', id).catch(() => undefined);
export const setProgress = (id, pct, y) => store.put('progress', { id, pct, y }).catch(() => {});
