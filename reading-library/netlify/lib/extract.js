import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import {
  BROWSER_UA,
  arxivId,
  assertPublicHttpUrl,
  decodeEntities,
  hostOf,
  looksLikePdfUrl,
  readingMinutes,
  stripTags,
} from './util.js';

const MAX_HTML_BYTES = 4 * 1024 * 1024;
const MAX_PDF_BYTES = 12 * 1024 * 1024; // Gemini accepts ~20MB per request incl. base64 overhead

export class FetchError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'FetchError';
    this.status = status;
  }
}

/* ------------------------------ fetching ------------------------------ */

async function readLimited(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (declared && declared > maxBytes) throw new FetchError('Page is too large to process.', 413);
  if (!res.body?.getReader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new FetchError('Page is too large to process.', 413);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new FetchError('Page is too large to process.', 413);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function decodeBody(bytes, contentType) {
  const m = /charset=([\w-]+)/i.exec(contentType || '');
  let label = m ? m[1] : 'utf-8';
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/**
 * Fetch a page. Returns { finalUrl, contentType, kind: 'html'|'pdf', html?, bytes? }.
 * `wantPdfBytes` decides whether PDF bodies are downloaded (for Gemini) or just detected.
 */
export async function fetchPage(url, { fetchImpl = fetch, timeoutMs = 8000, wantPdfBytes = false } = {}) {
  const safe = assertPublicHttpUrl(url);
  const res = await fetchImpl(safe, {
    redirect: 'follow',
    headers: {
      'user-agent': BROWSER_UA,
      accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new FetchError(`The site returned HTTP ${res.status}.`, res.status);

  const contentType = res.headers.get('content-type') || '';
  const finalUrl = res.url || safe;
  const isPdf = /application\/pdf/i.test(contentType) || looksLikePdfUrl(finalUrl);

  if (isPdf) {
    if (!wantPdfBytes) {
      await res.body?.cancel?.().catch(() => {});
      return { finalUrl, contentType, kind: 'pdf' };
    }
    return { finalUrl, contentType, kind: 'pdf', bytes: await readLimited(res, MAX_PDF_BYTES) };
  }
  const bytes = await readLimited(res, MAX_HTML_BYTES);
  return { finalUrl, contentType, kind: 'html', html: decodeBody(bytes, contentType) };
}

/* ------------------------------ metadata ------------------------------ */

function metaContent(document, selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    const v = el?.getAttribute('content');
    if (v && v.trim()) return decodeEntities(v.trim());
  }
  return '';
}

function jsonLdAuthor(document) {
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(s.textContent || '');
      const nodes = Array.isArray(data) ? data : data['@graph'] || [data];
      for (const n of nodes) {
        const a = n?.author;
        if (!a) continue;
        const list = Array.isArray(a) ? a : [a];
        const names = list.map((x) => (typeof x === 'string' ? x : x?.name)).filter(Boolean);
        if (names.length) return names.join(', ');
      }
    } catch {
      /* ignore malformed JSON-LD */
    }
  }
  return '';
}

export function pageMeta(document, url = '') {
  const title =
    metaContent(document, ['meta[property="og:title"]', 'meta[name="twitter:title"]']) ||
    decodeEntities((document.querySelector('title')?.textContent || '').trim());
  const author =
    metaContent(document, ['meta[name="author"]', 'meta[property="article:author"]', 'meta[name="byl"]']) ||
    jsonLdAuthor(document);
  return {
    title,
    author: /^https?:\/\//i.test(author) ? '' : author, // some sites put a profile URL here
    siteName: metaContent(document, ['meta[property="og:site_name"]']) || hostOf(url),
    description: metaContent(document, [
      'meta[property="og:description"]',
      'meta[name="description"]',
      'meta[name="twitter:description"]',
    ]),
    published: metaContent(document, [
      'meta[property="article:published_time"]',
      'meta[name="date"]',
      'meta[name="pubdate"]',
    ]),
  };
}

/* ------------------------------ sanitising ------------------------------ */

const DROP = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea',
  'link', 'meta', 'noscript', 'canvas', 'audio', 'video', 'svg', 'math', 'template', 'dialog', 'nav', 'footer',
]);
const KEEP = new Set([
  'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'img', 'figure', 'figcaption',
  'blockquote', 'ul', 'ol', 'li', 'em', 'strong', 'b', 'i', 'u', 's', 'sup', 'sub', 'code', 'pre',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'span', 'div', 'section', 'article',
  'small', 'mark', 'abbr', 'cite', 'q', 'dl', 'dt', 'dd', 'time', 'details', 'summary', 'picture', 'source',
]);
const ATTRS = {
  a: ['href', 'title'],
  img: ['src', 'alt', 'title', 'width', 'height'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan'],
  abbr: ['title'],
  time: ['datetime'],
  ol: ['start'],
};

function resolveUrl(value, base) {
  try {
    return new URL(value, base).href;
  } catch {
    return '';
  }
}

function bestFromSrcset(srcset, base) {
  let best = '';
  let bestW = -1;
  for (const part of String(srcset).split(',')) {
    const [u, d] = part.trim().split(/\s+/);
    if (!u) continue;
    const w = d && /w$/.test(d) ? parseInt(d, 10) : d && /x$/.test(d) ? parseFloat(d) * 1000 : 0;
    if (w >= bestW) {
      bestW = w;
      best = u;
    }
  }
  return best ? resolveUrl(best, base) : '';
}

/** Make every link and image absolute, and un-lazy images, BEFORE Readability runs. */
function absolutise(document, base) {
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#')) continue;
    const abs = resolveUrl(href, base);
    if (abs) a.setAttribute('href', abs);
  }
  for (const img of document.querySelectorAll('img')) {
    let src = img.getAttribute('src') || '';
    const lazy = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original');
    if ((!src || src.startsWith('data:')) && lazy) src = lazy;
    const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
    if (!src && srcset) src = bestFromSrcset(srcset, base);
    if (src && !src.startsWith('data:')) src = resolveUrl(src, base);
    if (src) img.setAttribute('src', src);
    img.removeAttribute('srcset');
  }
  for (const s of document.querySelectorAll('picture source')) s.remove();
}

/** Strip everything that could run code or phone home; keep readable structure. */
export function sanitizeHtml(html, base = '') {
  const { document } = parseHTML('<!doctype html><html><body>' + html + '</body></html>');
  for (const el of [...document.body.querySelectorAll('*')]) {
    const tag = el.tagName.toLowerCase();
    if (DROP.has(tag)) {
      el.remove();
      continue;
    }
    if (!KEEP.has(tag)) {
      // unknown/custom element: keep its text and children, drop the wrapper
      const parent = el.parentNode;
      if (parent) {
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        el.remove();
      }
      continue;
    }
    const allowed = ATTRS[tag] || [];
    for (const attr of [...el.attributes]) {
      if (!allowed.includes(attr.name.toLowerCase())) el.removeAttribute(attr.name);
    }
    if (tag === 'a') {
      const href = el.getAttribute('href') || '';
      if (href && !/^(https?:|mailto:|#)/i.test(href)) el.removeAttribute('href');
      if (el.getAttribute('href')) {
        el.setAttribute('rel', 'noopener noreferrer');
        el.setAttribute('target', '_blank');
      }
    }
    if (tag === 'img') {
      const src = el.getAttribute('src') || '';
      if (!/^https?:\/\//i.test(src)) {
        el.remove();
        continue;
      }
      el.setAttribute('loading', 'lazy');
      el.setAttribute('referrerpolicy', 'no-referrer');
    }
  }
  return document.body.innerHTML;
}

/* ------------------------------ extraction ------------------------------ */

/**
 * Parse an HTML page into clean article content.
 * @returns {{ok:boolean, title, byline, siteName, excerpt, contentHtml, textContent, wordCount, readingMinutes, published}}
 */
export function parseArticleHtml(html, url) {
  const { document } = parseHTML(html);
  const baseHref = document.querySelector('base[href]')?.getAttribute('href');
  const base = baseHref ? resolveUrl(baseHref, url) || url : url;
  const meta = pageMeta(document, url);
  absolutise(document, base);

  let article = null;
  try {
    article = new Readability(document, { charThreshold: 250, keepClasses: false }).parse();
  } catch {
    article = null;
  }

  const textContent = (article?.textContent || '').replace(/\s+/g, ' ').trim();
  const wordCount = textContent ? textContent.split(/\s+/).length : 0;
  // Very short results are almost always paywalls, JS-rendered pages or error screens.
  const ok = !!article && wordCount >= 120;

  return {
    ok,
    title: (article?.title || meta.title || '').trim(),
    byline: (article?.byline || meta.author || '').replace(/^by\s+/i, '').trim(),
    siteName: article?.siteName || meta.siteName,
    excerpt: (article?.excerpt || meta.description || '').trim(),
    contentHtml: ok ? sanitizeHtml(article.content, base) : '',
    textContent,
    wordCount,
    readingMinutes: readingMinutes(wordCount),
    published: article?.publishedTime || meta.published || '',
    meta,
  };
}

/** arXiv abstract page data via the official API (no HTML scraping needed). */
export async function fetchArxiv(id, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const res = await fetchImpl(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': BROWSER_UA },
  });
  if (!res.ok) throw new FetchError(`arXiv API returned HTTP ${res.status}.`, res.status);
  const xml = await res.text();
  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1];
  if (!entry) throw new FetchError('arXiv has no record for that id.', 404);
  const pick = (re) => stripTags((entry.match(re) || [])[1] || '');
  const authors = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((m) => stripTags(m[1]));
  return {
    title: pick(/<title>([\s\S]*?)<\/title>/),
    abstract: pick(/<summary>([\s\S]*?)<\/summary>/),
    authors,
    published: pick(/<published>([\s\S]*?)<\/published>/),
    absUrl: `https://arxiv.org/abs/${id}`,
    pdfUrl: `https://arxiv.org/pdf/${id}`,
  };
}

/**
 * Full reader extraction for the app's reading mode.
 * Always resolves with { ok, kind, ... } so the UI can fall back to "open original".
 */
export async function extractForReader(url, deps = {}) {
  const id = arxivId(url);
  try {
    if (id) {
      const a = await fetchArxiv(id, deps);
      return {
        ok: true,
        kind: 'arxiv',
        title: a.title,
        byline: a.authors.join(', '),
        siteName: 'arXiv',
        excerpt: a.abstract.slice(0, 300),
        abstract: a.abstract,
        published: a.published,
        launchUrl: a.pdfUrl,
        originalUrl: a.absUrl,
      };
    }
    const page = await fetchPage(url, { ...deps, wantPdfBytes: false });
    if (page.kind === 'pdf') {
      return { ok: true, kind: 'pdf', title: titleFromUrl(page.finalUrl), launchUrl: page.finalUrl, originalUrl: page.finalUrl };
    }
    const parsed = parseArticleHtml(page.html, page.finalUrl);
    return {
      kind: 'article',
      originalUrl: page.finalUrl,
      ...parsed,
      meta: undefined,
      error: parsed.ok ? undefined : 'Could not extract readable text (paywall, login wall, or a page that needs JavaScript).',
    };
  } catch (err) {
    return { ok: false, kind: 'article', originalUrl: url, error: friendlyError(err) };
  }
}

/**
 * Material for classification. Returns one of:
 *  { text, title?, author?, readingMinutes?, type }  or  { pdfBase64, ... }
 */
export async function materialForClassification(url, { fetchImpl = fetch, fallbackText = '' } = {}) {
  const id = arxivId(url);
  if (id) {
    const a = await fetchArxiv(id, { fetchImpl });
    return { type: 'arXiv', title: a.title, author: a.authors.join(', '), text: a.abstract };
  }
  let page;
  try {
    page = await fetchPage(url, { fetchImpl, wantPdfBytes: true, timeoutMs: 8000 });
  } catch (err) {
    // A deleted page is a real failure. Anything else (timeout, bot-blocking, 5xx) should not
    // leave the article stuck: classify from the feed summary, or failing that the title alone.
    if (err?.status === 404 || err?.status === 410 || /valid URL|Private or local|http\(s\)/.test(err?.message || '')) throw err;
    return {
      type: looksLikePdfUrl(url) ? 'PDF' : 'Article',
      text: fallbackText,
      thin: true,
      fetchError: friendlyError(err),
    };
  }
  if (page.kind === 'pdf') {
    return {
      type: 'PDF',
      title: titleFromUrl(page.finalUrl),
      pdfBase64: page.bytes ? Buffer.from(page.bytes).toString('base64') : undefined,
    };
  }
  const parsed = parseArticleHtml(page.html, page.finalUrl);
  const text = parsed.textContent.length > 300 ? parsed.textContent : [parsed.excerpt, fallbackText].filter(Boolean).join('\n\n');
  return {
    type: 'Article',
    title: parsed.title,
    author: parsed.byline,
    text,
    readingMinutes: parsed.readingMinutes,
    thin: parsed.textContent.length <= 300,
  };
}

/** Light metadata for "+ Add URL": a single fetch, no Readability. */
export async function quickMeta(url, { fetchImpl = fetch } = {}) {
  const id = arxivId(url);
  try {
    if (id) {
      const a = await fetchArxiv(id, { fetchImpl, timeoutMs: 4000 });
      return { type: 'arXiv', title: a.title, author_source: a.authors.join(', '), url: a.absUrl };
    }
    const page = await fetchPage(url, { fetchImpl, timeoutMs: 4500, wantPdfBytes: false });
    if (page.kind === 'pdf') {
      return { type: 'PDF', title: titleFromUrl(page.finalUrl), author_source: hostOf(page.finalUrl), url: page.finalUrl };
    }
    const { document } = parseHTML(page.html);
    const m = pageMeta(document, page.finalUrl);
    return {
      type: 'Article',
      title: m.title || hostOf(page.finalUrl),
      author_source: m.author || m.siteName,
      url: page.finalUrl,
      published_date: m.published,
    };
  } catch {
    // Still save it; the queue will retry fetching later.
    return { type: looksLikePdfUrl(url) ? 'PDF' : 'Article', title: titleFromUrl(url) || hostOf(url), author_source: hostOf(url), url };
  }
}

export function titleFromUrl(url) {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    const t = last.replace(/\.pdf$/i, '').replace(/[-_]+/g, ' ').trim();
    return t || u.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function friendlyError(err) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'The site took too long to respond.';
  return err?.message || 'Something went wrong.';
}
