// Small helpers shared by every view.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  d.cancel = () => clearTimeout(t);
  return d;
}

export const uid = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '').slice(0, 12) : Math.random().toString(36).slice(2, 14));

export function toast(msg, ms = 2600) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}

/* ---------- preferences ---------- */
export const DEFAULT_LABELS = { yellow: 'Key idea', green: 'Evidence', pink: 'Disagree / question', blue: 'Revisit' };
export const COLORS = ['yellow', 'green', 'pink', 'blue'];
const DEFAULTS = { theme: 'auto', fullscreen: true, font: 'serif', size: 19, width: 'medium', spacing: 'normal', labels: DEFAULT_LABELS };

export function getPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('rl_prefs') || '{}');
    return { ...DEFAULTS, ...p, labels: { ...DEFAULT_LABELS, ...(p.labels || {}) } };
  } catch {
    return { ...DEFAULTS };
  }
}
export function setPrefs(patch) {
  const next = { ...getPrefs(), ...patch };
  try { localStorage.setItem('rl_prefs', JSON.stringify(next)); } catch { /* private mode */ }
  applyTheme(next.theme);
  return next;
}

const mq = window.matchMedia('(prefers-color-scheme: dark)');
export function applyTheme(theme = getPrefs().theme) {
  const dark = theme === 'dark' || (theme === 'auto' && mq.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const meta = document.getElementById('theme-color');
  if (meta) meta.content = dark ? '#151412' : '#f7f4ee';
}
mq.addEventListener?.('change', () => applyTheme());

export function toggleTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  return setPrefs({ theme: dark ? 'light' : 'dark' }).theme;
}

/* ---------- formatting ---------- */
export function readingLabel(a) {
  const n = Number(a.reading_time);
  if (!n) return { text: '', low: false };
  return { text: (a.reading_time_low ? '~' : '') + n + ' min', low: !!a.reading_time_low };
}
export const LOW_TIME_HINT = 'Estimate: the page text was short or unavailable. It becomes exact once you open the article.';

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export function shortDate(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

export function firstUrl(...texts) {
  for (const t of texts) {
    const m = String(t || '').match(/https?:\/\/[^\s<>"']+/i);
    if (m) return m[0].replace(/[).,;]+$/, '');
  }
  return '';
}

/* ---------- icons ---------- */
const P = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  type: '<path d="M4 7V5h16v2M9 19h6M12 5v14"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  full: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  exit: '<path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3"/>',
  note: '<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5V21h16"/>',
  volume: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
};
export const icon = (n) => `<svg viewBox="0 0 24 24" aria-hidden="true">${P[n] || ''}</svg>`;

/** Highlights as Markdown, for copying into notes apps. */
export function highlightsMarkdown(article, list, labels = DEFAULT_LABELS) {
  const lines = [`# ${article.title || article.url}`, ''];
  if (article.author_source) lines.push(`*${article.author_source}*`);
  if (article.url) lines.push(article.url);
  lines.push('');
  for (const h of list) {
    lines.push(`> ${String(h.quote).replace(/\s+/g, ' ').trim()}`);
    lines.push(`> — ${labels[h.color] || h.color}`);
    if (h.note) lines.push('', h.note.trim());
    lines.push('');
  }
  return lines.join('\n');
}

export function timeAgo(iso) {
  const t = new Date(iso).getTime();
  if (!t) return 'never';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 2) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + ' h ago';
  const d = Math.round(h / 24);
  return d + (d === 1 ? ' day ago' : ' days ago');
}
