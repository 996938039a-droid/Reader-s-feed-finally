import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalCategory, normalizeTags } from '../netlify/lib/categories.js';
import { parseFeed, harvest, FEEDS } from '../netlify/lib/feeds.js';
import { parseArticleHtml, sanitizeHtml, fetchArxiv, extractForReader, materialForClassification } from '../netlify/lib/extract.js';
import { createGemini, pickFlashModel, RateLimitError } from '../netlify/lib/gemini.js';
import { processPending } from '../netlify/lib/queue.js';
import { handle } from '../netlify/lib/router.js';
import { arxivId, assertPublicHttpUrl } from '../netlify/lib/util.js';
import { loadConfig } from '../netlify/lib/config.js';
import { fakeFetch, res } from './helpers.js';

/* ------------------------------ categories ------------------------------ */

test('categories: synonyms and near-duplicates fold onto existing names', () => {
  const existing = ['AI', 'Philosophy', 'Culture & Society', 'Science'];
  assert.equal(canonicalCategory('Artificial Intelligence', existing), 'AI');
  assert.equal(canonicalCategory('A.I.', existing), 'AI');
  assert.equal(canonicalCategory('philosophy', existing), 'Philosophy');
  assert.equal(canonicalCategory('Sciences', existing), 'Science');
  assert.equal(canonicalCategory('Culture and Society', existing), 'Culture & Society');
  assert.equal(canonicalCategory('Cultural Society', existing), 'Cultural Society'); // genuinely different: kept
});

test('categories: brand-new ones are tidied, not mangled', () => {
  assert.equal(canonicalCategory('  economic history. ', []), 'Economic History');
  assert.equal(canonicalCategory('"public health"', []), 'Public Health');
  assert.equal(canonicalCategory('', ['AI']), '');
});

test('tags: normalised, deduped and capped', () => {
  assert.deepEqual(normalizeTags(['central banking', '#CentralBanking', 'AI-policy', '#', 'x y z', 'a', 'b', 'c']), [
    '#CentralBanking', '#AIPolicy', '#XYZ', '#A', '#B',
  ]);
  assert.deepEqual(normalizeTags(null), []);
});

/* ------------------------------ util ------------------------------ */

test('arxiv ids and SSRF guard', () => {
  assert.equal(arxivId('https://arxiv.org/abs/2401.01234v2'), '2401.01234');
  assert.equal(arxivId('https://arxiv.org/pdf/2401.01234v3.pdf'), '2401.01234');
  assert.equal(arxivId('https://arxiv.org/abs/hep-th/9901001'), 'hep-th/9901001');
  assert.equal(arxivId('https://example.com/abs/2401.01234'), null);
  for (const bad of ['http://localhost/x', 'http://127.0.0.1/', 'http://192.168.1.5/', 'http://169.254.169.254/latest', 'ftp://a.com/x', 'not a url']) {
    assert.throws(() => assertPublicHttpUrl(bad), undefined, bad);
  }
  assert.equal(assertPublicHttpUrl('https://aeon.co/essays/x'), 'https://aeon.co/essays/x');
});

test('config clamps seed size to 7-10', () => {
  assert.equal(loadConfig({ SEED_PER_FEED: '3' }).seedPerFeed, 7);
  assert.equal(loadConfig({ SEED_PER_FEED: '50' }).seedPerFeed, 10);
  assert.equal(loadConfig({}).seedPerFeed, 8);
  assert.equal(loadConfig({}).geminiDelayMs, 4500);
});

/* ------------------------------ feeds ------------------------------ */

const RSS = `<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>Feed</title>
<item><title><![CDATA[Traction! &amp; friction]]></title><link>https://aeon.co/essays/traction</link><pubDate>Fri, 23 Oct 2026 10:00:00 GMT</pubDate><dc:creator>Jennifer R Vail</dc:creator><description><![CDATA[<p>A world <b>without</b> friction.</p>]]></description></item>
<item><title>Video one</title><link>https://aeon.co/videos/bhutan</link><pubDate>Thu, 22 Oct 2026 10:01:00 GMT</pubDate><dc:creator>Aeon Video</dc:creator></item>
<item><title>Older essay</title><link>https://aeon.co/essays/older?utm_source=rss</link><pubDate>Mon, 19 Oct 2026 10:00:00 GMT</pubDate></item>
</channel></rss>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atom post</title><link rel="alternate" href="https://example.com/a?x=1&amp;y=2"/><published>2026-10-20T08:00:00Z</published><author><name>Ada</name></author><summary>Short.</summary></entry></feed>`;

test('feeds: parses RSS (CDATA, entities, dc:creator) newest first', () => {
  const items = parseFeed(RSS);
  assert.equal(items.length, 3);
  assert.equal(items[0].title, 'Traction! & friction');
  assert.equal(items[0].author, 'Jennifer R Vail');
  assert.equal(items[0].summary, 'A world without friction.');
  assert.equal(items[0].published, '2026-10-23T10:00:00.000Z');
});

test('feeds: parses Atom', () => {
  const [it] = parseFeed(ATOM);
  assert.equal(it.url, 'https://example.com/a?x=1&y=2');
  assert.equal(it.author, 'Ada');
});

function fakeSheet(initial = []) {
  const rows = [...initial];
  return {
    rows,
    articles: async () => rows,
    add: async (items) => { rows.push(...items); return { results: items.map((_, i) => ({ ok: true, id: 'n' + i })) }; },
  };
}

function manyItems(prefix, n, extra = '') {
  return Array.from({ length: n }, (_, i) =>
    `<item><title>${prefix} ${i}</title><link>https://${prefix}.test/p/${i}${extra}</link><pubDate>${new Date(Date.UTC(2026, 9, 24 - i)).toUTCString()}</pubDate></item>`
  ).join('');
}

test('harvest: seeds 8 per feed, skips videos, tops up a short Noema from page 2, survives a dead feed', async () => {
  const f = fakeFetch([
    ['aeon.co', `<rss>${manyItems('aeon', 12)}<item><title>V</title><link>https://aeon.co/videos/x</link><pubDate>${new Date(Date.UTC(2026, 9, 25)).toUTCString()}</pubDate></item></rss>`],
    ['noemamag.com/feed/?paged=2', `<rss>${manyItems('noema2', 5)}</rss>`],
    ['noemamag.com', `<rss>${manyItems('noema', 5)}</rss>`],
    ['worksinprogress', () => res('boom', { status: 500 })],
    ['psyche.co', `<rss>${manyItems('psyche', 20)}</rss>`],
    ['nautil.us', `<rss>${manyItems('nautilus', 10)}</rss>`],
  ]);
  const sheet = fakeSheet();
  const report = await harvest({ sheet, fetchImpl: f, cfg: loadConfig({}) });
  const by = Object.fromEntries(report.map((r) => [r.feed, r]));

  assert.equal(by.Aeon.added, 8);
  assert.equal(by.Noema.added, 8, 'Noema topped up from page 2');
  assert.equal(by.Psyche.added, 8);
  assert.equal(by.Nautilus.added, 8);
  assert.match(by['Works in Progress'].error, /500/);
  assert.equal(sheet.rows.length, 32);
  assert.ok(!sheet.rows.some((r) => r.url.includes('/videos/')));
  assert.ok(sheet.rows.every((r) => r.source_feed && r.status === 'Unread'));
});

test('harvest: ongoing runs add only new items (max 10) and never duplicates', async () => {
  const sheet = fakeSheet([{ url: 'https://aeon.test/p/0', source_feed: 'Aeon' }]);
  const f = fakeFetch([['aeon.co', `<rss>${manyItems('aeon', 15)}</rss>`]]);
  const feeds = FEEDS.filter((x) => x.name === 'Aeon');
  // known url from the Sheet uses a different host than the feed, so use the feed's own url
  sheet.rows[0].url = 'https://aeon.test/p/0';
  const report = await harvest({ sheet, fetchImpl: f, cfg: loadConfig({}), feeds });
  assert.equal(report[0].seeding, false);
  assert.equal(report[0].added, 10);
  const again = await harvest({ sheet, fetchImpl: f, cfg: loadConfig({}), feeds });
  assert.equal(again[0].added, 4, 'second run picks up the remaining 4, no repeats');
  assert.equal(new Set(sheet.rows.map((r) => r.url)).size, sheet.rows.length);
});

/* ------------------------------ extraction ------------------------------ */

const PARA = 'The quick brown fox jumps over the lazy dog while the committee deliberates about long term growth, institutions and the strange persistence of old habits in modern economies. ';
const ARTICLE_HTML = `<!doctype html><html><head><title>Fallback title</title>
<meta property="og:title" content="A Real Essay"><meta name="author" content="Jane Writer"><meta property="og:site_name" content="Test Mag">
<script>alert('x')</script></head><body>
<nav>Home About</nav><article><h1>A Real Essay</h1>
<p>${PARA.repeat(4)}</p>
<p onclick="steal()">${PARA.repeat(4)} <a href="/relative/link">relative</a> <a href="javascript:alert(1)">bad</a></p>
<img data-src="/img/lazy.jpg" src="data:image/gif;base64,R0lGOD" alt="lazy">
<p>${PARA.repeat(4)}</p><iframe src="https://evil.test"></iframe><script>evil()</script>
</article><footer>Footer junk</footer></body></html>`;

test('extract: clean readable HTML, sanitised, absolute URLs, lazy images fixed', () => {
  const a = parseArticleHtml(ARTICLE_HTML, 'https://mag.test/essays/real');
  assert.equal(a.ok, true);
  assert.equal(a.title, 'A Real Essay');
  assert.equal(a.byline, 'Jane Writer');
  assert.ok(a.wordCount > 100);
  assert.ok(a.readingMinutes >= 1);
  assert.doesNotMatch(a.contentHtml, /<script|<iframe|onclick|javascript:/i);
  assert.match(a.contentHtml, /href="https:\/\/mag\.test\/relative\/link"/);
  assert.match(a.contentHtml, /src="https:\/\/mag\.test\/img\/lazy\.jpg"/);
});

test('extract: tiny / paywalled pages report ok=false so the UI can fall back', () => {
  const a = parseArticleHtml('<html><head><title>Subscribe</title></head><body><p>Please subscribe to continue reading.</p></body></html>', 'https://mag.test/x');
  assert.equal(a.ok, false);
});

test('sanitize: strips scripts, handlers, styles, unknown wrappers and non-http images', () => {
  const dirty = '<div class="x" style="color:red" onmouseover="a()"><custom-el>kept text</custom-el><script>bad()</script><img src="data:text/html;base64,AAAA"><img src="https://ok.test/a.png" onerror="x()"><a href="data:text/html,hi">d</a></div>';
  const clean = sanitizeHtml(dirty);
  assert.doesNotMatch(clean, /script|onmouseover|onerror|style=|class=|data:text|custom-el/);
  assert.match(clean, /kept text/);
  assert.match(clean, /https:\/\/ok\.test\/a\.png/);
});

test('arXiv: title, authors and abstract come from the official API', async () => {
  const xml = `<feed><entry><id>x</id><published>2024-01-02T00:00:00Z</published><title>Attention
   Is Enough</title><summary>  We show that   attention works. </summary><author><name>A. Author</name></author><author><name>B. Author</name></author></entry></feed>`;
  const f = fakeFetch([['export.arxiv.org', () => res(xml, { headers: { 'content-type': 'application/atom+xml' } })]]);
  const a = await fetchArxiv('2401.01234', { fetchImpl: f });
  assert.equal(a.title, 'Attention Is Enough');
  assert.deepEqual(a.authors, ['A. Author', 'B. Author']);
  assert.equal(a.abstract, 'We show that attention works.');

  const out = await extractForReader('https://arxiv.org/pdf/2401.01234v2', { fetchImpl: f });
  assert.equal(out.kind, 'arxiv');
  assert.equal(out.launchUrl, 'https://arxiv.org/pdf/2401.01234');
  const m = await materialForClassification('https://arxiv.org/abs/2401.01234', { fetchImpl: f });
  assert.equal(m.type, 'arXiv');
  assert.match(m.text, /attention works/);
});

test('reader: PDFs return a launcher, failures return ok=false with a message (never throw)', async () => {
  const f = fakeFetch([
    ['doc.pdf', () => res('%PDF-1.4', { headers: { 'content-type': 'application/pdf' }, url: 'https://x.test/doc.pdf' })],
    ['down.test', () => res('nope', { status: 503 })],
  ]);
  const pdf = await extractForReader('https://x.test/doc.pdf', { fetchImpl: f });
  assert.equal(pdf.kind, 'pdf');
  assert.equal(pdf.launchUrl, 'https://x.test/doc.pdf');
  const bad = await extractForReader('https://down.test/a', { fetchImpl: f });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /503/);
  const priv = await extractForReader('http://localhost:8888/secret', { fetchImpl: f });
  assert.equal(priv.ok, false);
});

/* ------------------------------ gemini ------------------------------ */

const OK_JSON = (over = {}) => ({
  candidates: [{ content: { parts: [{ text: JSON.stringify({ title: 'T', category: 'Artificial Intelligence', tags: ['machine learning', '#Policy'], format: 'Longform Essay', tldr: 'It argues a thing. It matters.', author: 'Ann', ...over }) }] } }],
});

function gem(routes, extra = {}) {
  const sleeps = [];
  let t = 1_000_000;
  const g = createGemini({
    apiKey: 'k', model: 'gemini-test', fetchImpl: fakeFetch(routes),
    sleepImpl: async (ms) => { sleeps.push(ms); t += ms; }, now: () => t, ...extra,
  });
  return { g, sleeps };
}

test('gemini: classifies, normalises category/tags, and sends the schema + key header', async () => {
  const { g } = gem([['generateContent', OK_JSON()]]);
  const out = await g.classify({ url: 'https://a.test', text: 'body', existingCategories: ['AI', 'Science'] });
  assert.equal(out.category, 'AI');
  assert.deepEqual(out.tags, ['#MachineLearning', '#Policy']);
});

test('gemini: request body uses JSON mode with a schema; key goes in a header, not the URL', async () => {
  const f = fakeFetch([['generateContent', OK_JSON()]]);
  const g = createGemini({ apiKey: 'SECRETKEY', model: 'm', fetchImpl: f, sleepImpl: async () => {}, delayMs: 0 });
  await g.classify({ url: 'https://a.test', text: 'body', existingCategories: ['AI'] });
  const { url, init } = f.calls[0];
  assert.doesNotMatch(url, /SECRETKEY/);
  assert.equal(init.headers['x-goog-api-key'], 'SECRETKEY');
  const body = JSON.parse(init.body);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.ok(body.generationConfig.responseSchema.properties.category);
  assert.match(body.contents[0].parts[0].text, /Existing categories: AI/);
});

test('gemini: keeps >= 4.5s between calls', async () => {
  const { g, sleeps } = gem([['generateContent', OK_JSON()]]);
  await g.classify({ text: 'a' });
  await g.classify({ text: 'b' });
  await g.classify({ text: 'c' });
  const waits = sleeps.filter((s) => s > 0);
  assert.equal(waits.length, 2);
  assert.ok(waits.every((w) => w >= 4400 && w <= 4500), JSON.stringify(waits));
});

test('gemini: retries 429 with exponential backoff (5s, 10s), honouring retryDelay', async () => {
  let n = 0;
  const { g, sleeps } = gem([
    ['generateContent', () => (++n <= 2 ? res({ error: { message: 'slow down', details: [{ retryDelay: '2s' }] } }, { status: 429 }) : res(OK_JSON()))],
  ]);
  const out = await g.classify({ text: 'x' });
  assert.equal(out.format, 'Longform Essay');
  assert.equal(n, 3);
  const backoffs = sleeps.filter((s) => s >= 5000);
  assert.deepEqual(backoffs, [5000, 10000]);
});

test('gemini: gives up after 3 retries with a RateLimitError (queue then stops, nothing lost)', async () => {
  const { g } = gem([['generateContent', () => res({ error: { message: 'limit' } }, { status: 429 })]]);
  await assert.rejects(g.classify({ text: 'x' }), RateLimitError);
});

test('gemini: stops early when a retry would not fit in the time budget', async () => {
  let t = 1_000_000;
  const f = fakeFetch([['generateContent', () => res({ error: {} }, { status: 429 })]]);
  const g = createGemini({ apiKey: 'k', model: 'm', fetchImpl: f, sleepImpl: async (ms) => { t += ms; }, now: () => t, delayMs: 0 });
  await assert.rejects(g.classify({ text: 'x' }, { deadline: t + 4000 }), /out of time/);
  assert.equal(f.calls.length, 1);
});

test('gemini: daily quota is not retried', async () => {
  const f = fakeFetch([['generateContent', () => res({ error: { message: 'Quota exceeded for GenerateRequestsPerDayPerProjectPerModel' } }, { status: 429 })]]);
  const g = createGemini({ apiKey: 'k', model: 'm', fetchImpl: f, sleepImpl: async () => {}, delayMs: 0 });
  await assert.rejects(g.classify({ text: 'x' }), (e) => e instanceof RateLimitError && e.daily);
  assert.equal(f.calls.length, 1);
});

test('gemini: a retired model triggers auto-discovery of a current Flash model', async () => {
  const f = fakeFetch([
    ['models/old-model:generateContent', () => res({ error: { message: 'models/old-model is not found for API version v1beta' } }, { status: 404 })],
    ['v1beta/models?pageSize', { models: [
      { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.5-flash-image', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding-9', supportedGenerationMethods: ['embedContent'] },
    ] }],
    ['models/gemini-3.5-flash:generateContent', OK_JSON()],
  ]);
  const g = createGemini({ apiKey: 'k', model: 'old-model', fetchImpl: f, sleepImpl: async () => {}, delayMs: 0 });
  const out = await g.classify({ text: 'x' });
  assert.equal(out.title, 'T');
  assert.equal(g.state.model, 'gemini-3.5-flash');
});

test('gemini: pickFlashModel prefers stable over preview, then newest, then full Flash over Lite', () => {
  const mk = (names) => names.map((name) => ({ name: 'models/' + name, supportedGenerationMethods: ['generateContent'] }));
  const noise = ['gemini-3.5-flash-image', 'gemini-3.5-flash-tts', 'gemini-3.5-pro', 'gemini-3.5-flash-live'];
  assert.equal(pickFlashModel(mk(['gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-4-flash-preview', ...noise])), 'gemini-3.5-flash');
  assert.equal(pickFlashModel(mk(['gemini-2.5-flash', 'gemini-3.5-flash-lite', ...noise])), 'gemini-3.5-flash-lite');
  assert.equal(pickFlashModel(mk(['gemini-4-flash-preview', ...noise])), 'gemini-4-flash-preview', 'a preview is better than nothing');
  assert.equal(pickFlashModel(mk(noise)), null);
  assert.equal(pickFlashModel([]), null);
});

test('gemini: bad JSON and blocked responses become clear errors', async () => {
  const bad = gem([['generateContent', { candidates: [{ content: { parts: [{ text: 'not json' }] } }] }]]);
  await assert.rejects(bad.g.classify({ text: 'x' }), /invalid JSON/);
  const blocked = gem([['generateContent', { promptFeedback: { blockReason: 'SAFETY' } }]]);
  await assert.rejects(blocked.g.classify({ text: 'x' }), /SAFETY/);
});

test('gemini: PDFs are sent inline, not as text', async () => {
  const f = fakeFetch([['generateContent', OK_JSON()]]);
  const g = createGemini({ apiKey: 'k', model: 'm', fetchImpl: f, sleepImpl: async () => {}, delayMs: 0 });
  await g.classify({ url: 'https://x.test/a.pdf', pdfBase64: 'JVBERi0=' });
  const parts = JSON.parse(f.calls[0].init.body).contents[0].parts;
  assert.equal(parts[0].inlineData.mimeType, 'application/pdf');
  assert.equal(parts[0].inlineData.data, 'JVBERi0=');
});

/* ------------------------------ queue ------------------------------ */

function queueSheet(pending) {
  const writes = [];
  return {
    writes,
    pending: async () => pending,
    categories: async () => [{ name: 'AI', count: 3 }],
    updateArticle: async (items) => { writes.push(...items); return { updated: items.map((i) => i.id) }; },
  };
}
const goodPage = () => res(ARTICLE_HTML, { url: 'https://mag.test/a' });

test('queue: classifies, writes all fields, clears the in-progress marker', async () => {
  const sheet = queueSheet([{ id: 'a1', url: 'https://mag.test/a', title: 'RSS title', author_source: 'Test Mag', source_feed: 'Test Mag', classify_attempts: 0 }]);
  const gemini = { classify: async (i) => { assert.match(i.text, /quick brown fox/); assert.deepEqual(i.existingCategories, ['AI']); return { title: 'T', category: 'AI', tags: ['#A'], format: 'Op-Ed', tldr: 'Short.', author: 'Jane Writer' }; } };
  const out = await processPending({ sheet, gemini, fetchImpl: fakeFetch([['mag.test', goodPage]]), limit: 2 });
  assert.equal(out.processed, 1);
  assert.equal(sheet.writes[0].fields.classify_attempts, 1);
  const final = sheet.writes.at(-1).fields;
  assert.equal(final.category, 'AI');
  assert.equal(final.last_error, '');
  assert.equal(final.author_source, 'Jane Writer');
  assert.ok(final.reading_time >= 1);
  assert.equal(final.title, undefined, 'a good RSS title is kept');
});

test('queue: rate limit stops the run and restores the attempt counter', async () => {
  const sheet = queueSheet([
    { id: 'a1', url: 'https://mag.test/a', classify_attempts: 2 },
    { id: 'a2', url: 'https://mag.test/b', classify_attempts: 0 },
  ]);
  const gemini = { classify: async () => { throw new RateLimitError('slow'); } };
  const out = await processPending({ sheet, gemini, fetchImpl: fakeFetch([['mag.test', goodPage]]), limit: 2 });
  assert.equal(out.stopped, 'rate limited');
  assert.equal(out.processed, 0);
  assert.equal(sheet.writes.at(-1).fields.classify_attempts, 2);
  assert.equal(sheet.writes.filter((w) => w.id === 'a2').length, 0, 'second article untouched');
});

test('queue: a failing article records its error and the next one still runs', async () => {
  const sheet = queueSheet([
    { id: 'bad', url: 'https://down.test/a', classify_attempts: 0 },
    { id: 'ok', url: 'https://mag.test/a', classify_attempts: 0 },
  ]);
  const gemini = { classify: async () => ({ title: '', category: 'Science', tags: [], format: 'Other', tldr: 'x', author: '' }) };
  const f = fakeFetch([['down.test', res('x', { status: 403 })], ['mag.test', goodPage]]);
  const out = await processPending({ sheet, gemini, fetchImpl: f, limit: 2, perItemMs: 0 });
  assert.equal(out.failed, 1);
  assert.equal(out.processed, 1);
  assert.match(sheet.writes.find((w) => w.id === 'bad' && w.fields.last_error !== 'in progress').fields.last_error, /403/);
});

test('queue: does not start another article when the time budget is nearly gone', async () => {
  let t = 0;
  const sheet = queueSheet([{ id: 'a', url: 'https://mag.test/a' }, { id: 'b', url: 'https://mag.test/b' }]);
  const gemini = { classify: async () => { t += 15000; return { title: '', category: 'AI', tags: [], format: 'Other', tldr: 'x', author: '' }; } };
  const out = await processPending({ sheet, gemini, fetchImpl: fakeFetch([['mag.test', goodPage]]), limit: 2, budgetMs: 24000, perItemMs: 11000, now: () => t });
  assert.equal(out.processed, 1);
  assert.equal(out.stopped, 'out of time');
});

test('queue: nothing pending is a cheap no-op', async () => {
  const out = await processPending({ sheet: queueSheet([]), gemini: {}, limit: 2 });
  assert.deepEqual(out, { processed: 0, failed: 0, remaining: 0, stopped: '' });
});

/* ------------------------------ router ------------------------------ */

function api(method, path, { body, pass = 'pw' } = {}) {
  return new Request('https://app.test/api/' + path, {
    method,
    headers: { 'x-passphrase': pass, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}
function routerDeps(over = {}) {
  const added = [];
  const sheet = {
    articles: async () => [
      { id: '1', category: 'AI', status: 'Unread', classify_attempts: 0 },
      { id: '2', category: 'AI', status: 'Unread', classify_attempts: 0 },
      { id: '3', category: '', status: 'Unread', classify_attempts: 0 },
      { id: '4', category: '', status: 'Unread', classify_attempts: 5 },
    ],
    add: async (items) => { added.push(...items); return { results: [{ ok: true, id: 'new1', duplicate: false }] }; },
    updateArticle: async (items) => ({ updated: items.map((i) => i.id), items }),
    ping: async () => ({ pong: true }),
    ...over,
  };
  return { cfg: { passphrase: 'pw' }, sheet, gemini: { state: { model: 'm' }, listModels: async () => [] }, log: () => {}, authDelayMs: 0, added };
}

test('router: wrong or missing passphrase is 401 on every route', async () => {
  const d = routerDeps();
  assert.equal((await handle(api('GET', 'library', { pass: 'wrong' }), d)).status, 401);
  assert.equal((await handle(new Request('https://app.test/api/library'), d)).status, 401);
  assert.equal((await handle(api('GET', 'library', { pass: '' }), { ...d, cfg: { passphrase: '' } })).status, 401);
});

test('router: library returns articles, category counts and pending count', async () => {
  const r = await handle(api('GET', 'library'), routerDeps());
  const j = await r.json();
  assert.equal(j.articles.length, 4);
  assert.deepEqual(j.categories, [{ name: 'AI', count: 2 }]);
  assert.equal(j.pending, 1, 'items that hit the retry cap are not "pending"');
});

test('router: adding a URL saves metadata fast and flags duplicates', async () => {
  const d = routerDeps();
  d.fetchImpl = fakeFetch([['mag.test', res('<html><head><meta property="og:title" content="Neat Essay"><meta name="author" content="Jo"></head></html>', { url: 'https://mag.test/e' })]]);
  const j = await (await handle(api('POST', 'articles', { body: { url: 'https://mag.test/e' } }), d)).json();
  assert.equal(j.ok, true);
  assert.equal(j.title, 'Neat Essay');
  assert.equal(d.added[0].author_source, 'Jo');
  assert.equal(d.added[0].source_feed, 'Manual');
  const bad = await handle(api('POST', 'articles', { body: { url: 'http://localhost/x' } }), d);
  assert.equal(bad.status, 500);
});

test('router: a dead site still gets saved (queue retries later)', async () => {
  const d = routerDeps();
  d.fetchImpl = fakeFetch([['gone.test', res('x', { status: 500 })]]);
  const j = await (await handle(api('POST', 'articles', { body: { url: 'https://gone.test/some-long-essay-title' } }), d)).json();
  assert.equal(j.ok, true);
  assert.equal(d.added[0].title, 'some long essay title');
});

test('router: update only passes whitelisted fields and validates status', async () => {
  const d = routerDeps();
  const ok = await (await handle(api('POST', 'articles/update', { body: { id: '1', fields: { status: 'Finished', url: 'https://evil', classify_attempts: 0 } } }), d)).json();
  assert.deepEqual(Object.keys(ok.items[0].fields), ['status']);
  assert.equal((await handle(api('POST', 'articles/update', { body: { id: '1', fields: { status: 'Nope' } } }), d)).status, 400);
  assert.equal((await handle(api('POST', 'articles/update', { body: {} }), d)).status, 400);
});

test('router: health reports missing config names without leaking values; unknown route is 404', async () => {
  const d = routerDeps();
  d.cfg = { passphrase: 'pw', appsScriptUrl: '', appsScriptToken: 'SECRET', geminiKey: 'ALSO-SECRET' };
  const txt = await (await handle(api('GET', 'health'), d)).text();
  assert.match(txt, /APPS_SCRIPT_URL/);
  assert.doesNotMatch(txt, /SECRET/);
  assert.equal((await handle(api('GET', 'nope'), d)).status, 404);
});
