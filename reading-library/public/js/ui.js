// Menus, dialogs and popovers.
import { esc, icon } from './util.js';

const layer = () => document.getElementById('layer');

function scrim(onClose, dim = true) {
  const s = document.createElement('div');
  s.className = 'scrim';
  if (!dim) s.style.background = 'transparent';
  s.addEventListener('pointerdown', (e) => { if (e.target === s) onClose(); });
  return s;
}

/** Keep a fixed-position box inside the screen. */
export function place(el, rect, { prefer = 'below' } = {}) {
  const pad = 8;
  const w = el.offsetWidth, h = el.offsetHeight;
  let left = rect.left + rect.width / 2 - w / 2;
  left = Math.max(pad, Math.min(left, innerWidth - w - pad));
  let top = prefer === 'below' ? rect.bottom + 8 : rect.top - h - 10;
  if (prefer === 'below' && top + h > innerHeight - pad) top = rect.top - h - 8;
  if (prefer === 'above' && top < pad) top = rect.bottom + 10;
  top = Math.max(pad, Math.min(top, innerHeight - h - pad));
  el.style.left = left + 'px';
  el.style.top = top + 'px';
}

/** Popover that closes when you tap outside or press Escape. Returns { el, close }. */
export function popover(className, html, anchorRect, { prefer = 'below', dim = false, onClose } = {}) {
  const host = layer();
  const s = scrim(() => close(), dim && innerWidth <= 720);
  const el = document.createElement('div');
  el.className = className;
  el.innerHTML = html;
  host.append(s, el);
  place(el, anchorRect, { prefer });
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    s.remove(); el.remove();
    onClose?.();
  }
  return { el, close, scrim: s };
}

/** items: [{label, run, danger}] or '-' for a divider. */
export function openMenu(anchor, items) {
  const rect = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor;
  const html = items.map((it, i) => (it === '-' ? '<hr>' : `<button data-i="${i}" ${it.danger ? 'style="color:var(--danger)"' : ''}>${esc(it.label)}</button>`)).join('');
  const p = popover('menu', html, rect, { dim: true });
  p.el.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    p.close();
    items[Number(b.dataset.i)].run?.();
  });
  return p;
}

/** Centered dialog (bottom sheet on phones). body is an HTML string. */
export function openSheet({ title, body, onClose }) {
  const host = layer();
  const s = scrim(() => close());
  const el = document.createElement('div');
  el.className = 'sheet';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', title);
  el.innerHTML = `<div class="sheet-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div><div class="sheet-body">${body}</div>`;
  host.append(s, el);
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  el.querySelector('[data-close]').onclick = () => close();
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    s.remove(); el.remove();
    onClose?.();
  }
  return { el, close, body: el.querySelector('.sheet-body') };
}

/** Right-hand drawer (bottom sheet on phones). */
export function openDrawer({ title, body, onClose }) {
  const host = layer();
  const s = scrim(() => close());
  const el = document.createElement('aside');
  el.className = 'drawer';
  el.innerHTML = `<div class="sheet-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div><div class="sheet-body">${body}</div>`;
  host.append(s, el);
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  el.querySelector('[data-close]').onclick = () => close();
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    s.remove(); el.remove();
    onClose?.();
  }
  return { el, close, body: el.querySelector('.sheet-body') };
}

export function closeAll() { layer().innerHTML = ''; }
