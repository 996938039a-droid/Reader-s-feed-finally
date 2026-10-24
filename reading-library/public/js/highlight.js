// Text highlighting that survives reloads: a highlight is stored as the quoted text plus a little
// context either side, and found again by text search (so it still works if the page layout changes).
const CONTEXT = 40;

export function fullText(root) {
  const r = document.createRange();
  r.selectNodeContents(root);
  return r.toString();
}

/** Character offsets of a DOM range within the article text. */
export function rangeOffsets(root, range) {
  const pre = document.createRange();
  pre.selectNodeContents(root);
  pre.setEnd(range.startContainer, range.startOffset);
  const start = pre.toString().length;
  return { start, end: start + range.toString().length };
}

/** What gets stored for a new highlight. */
export function describe(root, start, end) {
  const text = fullText(root);
  return {
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CONTEXT), start),
    suffix: text.slice(end, end + CONTEXT),
  };
}

function commonSuffix(a, b) { let i = 0; while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++; return i; }
function commonPrefix(a, b) { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; }

/** Find where a stored highlight now lives. Returns {start,end} or null. */
export function locate(text, h) {
  const q = h.quote || '';
  if (!q.trim()) return null;
  let best = null;
  let idx = text.indexOf(q);
  while (idx !== -1) {
    const before = text.slice(Math.max(0, idx - (h.prefix || '').length), idx);
    const after = text.slice(idx + q.length, idx + q.length + (h.suffix || '').length);
    const score = commonSuffix(before, h.prefix || '') + commonPrefix(after, h.suffix || '');
    if (!best || score > best.score) best = { start: idx, end: idx + q.length, score };
    idx = text.indexOf(q, idx + 1);
  }
  return best && { start: best.start, end: best.end };
}

function textNodes(root) {
  const out = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let pos = 0;
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    out.push({ node: n, start: pos, end: pos + n.data.length });
    pos += n.data.length;
  }
  return out;
}

/** Wrap the characters [start,end) in <mark> elements (one per text node touched). */
export function wrap(root, start, end, h) {
  const segs = textNodes(root).filter((t) => t.end > start && t.start < end);
  for (const t of segs) {
    const a = Math.max(start, t.start) - t.start;
    const b = Math.min(end, t.end) - t.start;
    if (b <= a) continue;
    let target = t.node;
    if (/^\s*$/.test(target.data.slice(a, b)) && /\n/.test(target.data.slice(a, b))) continue; // gaps between blocks
    if (a > 0) target = target.splitText(a);
    if (b - a < target.data.length) target.splitText(b - a);
    const mark = document.createElement('mark');
    mark.className = `hl hl-${h.color || 'yellow'}${h.note ? ' has-note' : ''}`;
    mark.dataset.hid = h.id;
    target.parentNode.insertBefore(mark, target);
    mark.appendChild(target);
  }
}

export function clear(root) {
  for (const m of root.querySelectorAll('mark.hl')) {
    const p = m.parentNode;
    while (m.firstChild) p.insertBefore(m.firstChild, m);
    p.removeChild(m);
  }
  root.normalize();
}

/** Redraw every highlight. Returns a map id -> {start,end} (missing = could not be found). */
export function paint(root, highlights) {
  clear(root);
  const text = fullText(root);
  const found = new Map();
  const ordered = [...highlights].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const spots = ordered.map((h) => ({ h, at: locate(text, h) }));
  for (const { h, at } of spots) if (at) found.set(h.id, at);
  for (const { h, at } of spots) if (at) wrap(root, at.start, at.end, h);
  return found;
}
