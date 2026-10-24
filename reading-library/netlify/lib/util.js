export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** Same normalisation as Code.gs, so duplicate checks agree on both sides. */
export function normalizeUrl(u) {
  u = String(u).trim().replace(/#.*$/, '');
  const m = u.match(/^(?:https?:\/\/)?([^/?]+)([^?]*)(\?.*)?$/i);
  if (!m) return u.toLowerCase();
  const host = m[1].toLowerCase().replace(/^www\./, '');
  const path = m[2].replace(/\/+$/, '');
  let q = '';
  if (m[3]) {
    const kept = m[3]
      .slice(1)
      .split('&')
      .filter((kv) => kv && !/^(utm_|fbclid|gclid|mc_|ref=|ref_src)/i.test(kv))
      .sort();
    q = kept.length ? '?' + kept.join('&') : '';
  }
  return host + path + q;
}

export function hostOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Only public http(s) URLs may be fetched on the user's behalf. */
export function assertPublicHttpUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw new Error('That does not look like a valid URL.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are supported.');
  }
  const h = u.hostname.toLowerCase();
  const privateHost =
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    h === '::1' ||
    h === '[::1]' ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    h === '0.0.0.0';
  if (privateHost) throw new Error('Private or local addresses are not allowed.');
  return u.href;
}

export function readingMinutes(words) {
  if (!words || words < 1) return '';
  return Math.max(1, Math.round(words / 230));
}

/** Returns the canonical arXiv id (no version, no .pdf) or null. */
export function arxivId(url) {
  const m = String(url).match(
    /arxiv\.org\/(?:abs|pdf)\/((?:\d{4}\.\d{4,5})|(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}))(?:v\d+)?(?:\.pdf)?/i
  );
  return m ? m[1] : null;
}

export function looksLikePdfUrl(url) {
  try {
    return /\.pdf$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeFromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#039;/g, "'")
    .replace(/&amp;/g, '&');
}

function safeFromCodePoint(n) {
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

export function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
