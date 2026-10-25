import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalCategory, normalizeTags } from '../netlify/lib/categories.js';
import { parseFeed, harvest, FEEDS, discoverFeed, loadSources, DEFAULT_SOURCES, SUGGESTED_SOURCES } from '../netlify/lib/feeds.js';
import { defineWord, cleanTerm } from '../netlify/lib/define.js';
import { parseArticleHtml, sanitizeHtml, fetchArxiv, extractForReader, materialForClassification } from '../netlify/lib/extract.js';
import { createGemini, pickFlashModel, rankFlashModels, parseRetryIn, RateLimitError } from '../netlify/lib/gemini.js';
import { createOpenAICompat, createClassifier } from '../netlify/lib/llm.js';
import { buildBatchPrompt, matchResults } from '../netlify/lib/classify-common.js';
import { readingTimeIsLow } from '../netlify/lib/util.js';
import { processPending, READING_TIME_NOTE } from '../netlify/lib/queue.js';
import { handle } from '../netlify/lib/router.js';
import { arxivId, assertPublicHttpUrl } from '../netlify/lib/util.js';
import { loadConfig, backupConfigured } from '../netlify/lib/config.js';
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

test('harvest: later runs add only posts NEWER than what is saved (no backlog creep), and store the feed blurb as tldr', async () => {
  // feed items: i=0 is Oct 24, i=1 Oct 23 ... i=14 Oct 10. We already hold everything up to Oct 20 (i=4).
  const sheet = fakeSheet([{ url: 'https://aeon.test/p/4', source_feed: 'Aeon', published_date: '2026-10-20T00:00:00.000Z' }]);
  const feeds = FEEDS.filter((x) => x.name === 'Aeon');
  const withBlurb = manyItems('aeon', 15).replace(/<\/item>/g, '<description>A short blurb.</description></item>');
  const f = fakeFetch([['aeon.co', () => res(`<rss>${withBlurb}</rss>`)]]);
  const report = await harvest({ sheet, fetchImpl: f, cfg: loadConfig({}), feeds });
  assert.equal(report[0].seeding, false);
  assert.equal(report[0].added, 4, 'only items 0-3 are newer than Oct 20');
  assert.equal(sheet.rows.at(-1).tldr, 'A short blurb.');
  const again = await harvest({ sheet, fetchImpl: f, cfg: loadConfig({}), feeds });
  assert.equal(again[0].added, 0, 'pressing the button twice adds nothing');
  assert.equal(new Set(sheet.rows.map((r) => r.url)).size, sheet.rows.length);
});

test('harvest: pulling the feeds twice in a row does not exceed the seed size', async () => {
  const f = fakeFetch([
    ['aeon.co', () => res(`<rss>${manyItems('aeon', 20)}</rss>`)],
    ['noemamag.com', () => res(`<rss>${manyItems('noema', 10)}</rss>`)],
    ['worksinprogress', () => res(`<rss>${manyItems('wip', 20)}</rss>`)],
    ['psyche.co', () => res(`<rss>${manyItems('psyche', 20)}</rss>`)],
    ['nautil.us', () => res(`<rss>${manyItems('nautilus', 10)}</rss>`)],
  ]);
  const sheet = fakeSheet();
  await harvest({ sheet, fetchImpl: f, cfg: loadConfig({}) });
  const first = sheet.rows.length;
  await harvest({ sheet, fetchImpl: f, cfg: loadConfig({}) });
  assert.equal(first, 40);
  assert.equal(sheet.rows.length, 40);
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

const ITEM = (id, over = {}) => ({ id, title: 'T', category: 'Artificial Intelligence', tags: ['machine learning', '#Policy'], format: 'Longform Essay', tldr: 'It argues a thing. It matters.', author: 'Ann', ...over });
const OK_JSON = (items = [ITEM('1')]) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ items }) }] } }] });
const mk = (opts) => createGemini({ exhausted: new Map(), sleepImpl: async () => {}, delayMs: 0, apiKey: 'k', model: 'm', ...opts });

function gem(routes, extra = {}) {
  const sleeps = [];
  let t = 1_000_000;
  const g = createGemini({
    apiKey: 'k', model: 'gemini-test', fetchImpl: fakeFetch(routes), exhausted: new Map(),
    sleepImpl: async (ms) => { sleeps.push(ms); t += ms; }, now: () => t, ...extra,
  });
  return { g, sleeps };
}

test('gemini: classifies one article, normalising category and tags against your existing ones', async () => {
  const { g } = gem([['generateContent', OK_JSON()]]);
  const out = await g.classify({ url: 'https://a.test', text: 'body', existingCategories: ['AI', 'Science'] });
  assert.equal(out.category, 'AI');
  assert.deepEqual(out.tags, ['#MachineLearning', '#Policy']);
});

test('gemini: request uses JSON mode with a batch schema; key goes in a header, not the URL', async () => {
  const f = fakeFetch([['generateContent', OK_JSON()]]);
  const g = mk({ apiKey: 'SECRETKEY', fetchImpl: f });
  await g.classify({ url: 'https://a.test', text: 'body', existingCategories: ['AI'] });
  const { url, init } = f.calls[0];
  assert.doesNotMatch(url, /SECRETKEY/);
  assert.equal(init.headers['x-goog-api-key'], 'SECRETKEY');
  const body = JSON.parse(init.body);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.ok(body.generationConfig.responseSchema.properties.items.items.properties.category);
  assert.match(body.contents[0].parts[0].text, /Shelves already in this library: AI/);
});

test('gemini: ONE request classifies several articles; answers are matched by id, even out of order', async () => {
  const f = fakeFetch([['generateContent', OK_JSON([ITEM('b', { category: 'History', title: 'Second' }), ITEM('a', { category: 'Economics', title: 'First' }), ITEM('c', { category: 'history' })])]]);
  const g = mk({ fetchImpl: f });
  const out = await g.classifyBatch([
    { id: 'a', url: 'https://x.test/a', text: 'aaa' }, { id: 'b', url: 'https://x.test/b', text: 'bbb' }, { id: 'c', url: 'https://x.test/c', text: 'ccc' },
  ], { existingCategories: [] });
  assert.equal(f.calls.length, 1, 'three articles, one request');
  assert.deepEqual(out.map((o) => [o.id, o.ok, o.result.title]), [['a', true, 'First'], ['b', true, 'Second'], ['c', true, 'T']]);
  assert.equal(out[2].result.category, out[1].result.category, '"history" folds onto "History" invented earlier in the same batch');
  const prompt = JSON.parse(f.calls[0].init.body).contents[0].parts.at(-1).text;
  assert.match(prompt, /id=a[\s\S]*id=b[\s\S]*id=c/);
});

test('gemini: an article the model skips is reported, not silently dropped', async () => {
  const g = mk({ fetchImpl: fakeFetch([['generateContent', OK_JSON([ITEM('a')])]]) });
  const out = await g.classifyBatch([{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }]);
  assert.equal(out[0].ok, true);
  assert.equal(out[1].ok, false);
  assert.match(out[1].error, /skipped/);
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
  assert.deepEqual(sleeps.filter((s) => s >= 5000), [5000, 10000]);
});

test('gemini: gives up after 3 retries with a RateLimitError (queue then stops, nothing lost)', async () => {
  const { g } = gem([['generateContent', () => res({ error: { message: 'limit' } }, { status: 429 })]]);
  await assert.rejects(g.classify({ text: 'x' }), RateLimitError);
});

test('gemini: stops early when a retry would not fit in the time budget', async () => {
  let t = 1_000_000;
  const f = fakeFetch([['generateContent', () => res({ error: {} }, { status: 429 })]]);
  const g = mk({ fetchImpl: f, sleepImpl: async (ms) => { t += ms; }, now: () => t });
  await assert.rejects(g.classify({ text: 'x' }, { deadline: t + 4000 }), /no time left to retry/);
  assert.equal(f.calls.length, 1);
});

test('gemini: a retired model triggers auto-discovery, preferring Flash-Lite', async () => {
  const f = fakeFetch([
    ['models/old-model:generateContent', () => res({ error: { message: 'models/old-model is not found for API version v1beta' } }, { status: 404 })],
    ['v1beta/models?pageSize', { models: [
      { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.5-flash-image', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding-9', supportedGenerationMethods: ['embedContent'] },
    ] }],
    ['models/gemini-3.5-flash-lite:generateContent', () => res(OK_JSON())],
  ]);
  const g = mk({ model: 'old-model', fetchImpl: f });
  const out = await g.classify({ text: 'x' });
  assert.equal(out.title, 'T');
  assert.equal(g.state.model, 'gemini-3.5-flash-lite');
});

test('gemini: model ranking (stable before preview; Lite first only when asked)', () => {
  const mkm = (names) => names.map((name) => ({ name: 'models/' + name, supportedGenerationMethods: ['generateContent'] }));
  const noise = ['gemini-3.5-flash-image', 'gemini-3.5-flash-tts', 'gemini-3.5-pro', 'gemini-3.5-flash-live'];
  assert.equal(pickFlashModel(mkm(['gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-4-flash-preview', ...noise])), 'gemini-3.5-flash');
  assert.equal(pickFlashModel(mkm(['gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite']), { preferLite: true }), 'gemini-3.5-flash-lite');
  assert.deepEqual(rankFlashModels(mkm(['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.8-flash-lite']), { preferLite: true }), ['gemini-3.8-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.8-flash']);
  assert.equal(pickFlashModel(mkm(['gemini-4-flash-preview', ...noise])), 'gemini-4-flash-preview', 'a preview is better than nothing');
  assert.equal(pickFlashModel(mkm(noise)), null);
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
  const g = mk({ fetchImpl: f });
  await g.classify({ url: 'https://x.test/a.pdf', pdfBase64: 'JVBERi0=' });
  const parts = JSON.parse(f.calls[0].init.body).contents[0].parts;
  assert.equal(parts[0].inlineData.mimeType, 'application/pdf');
  assert.equal(parts[0].inlineData.data, 'JVBERi0=');
});

test('gemini: "Please retry in 8h43m" is understood', () => {
  assert.equal(parseRetryIn('Please retry in 8h43m54.5s.'), (8 * 3600 + 43 * 60 + 54.5) * 1000);
  assert.equal(parseRetryIn('Please retry in 12s'), 12000);
  assert.equal(parseRetryIn('nothing here'), 0);
});

const DAILY = { error: { message: 'Quota exceeded ... Generate content requests per day limit exceeded on Free Tier. limit: 20, model: gemini-3.8-flash. Please retry in 8h43m54s.' } };
const MODELS = { models: ['gemini-3.8-flash', 'gemini-3.8-flash-lite'].map((n) => ({ name: 'models/' + n, supportedGenerationMethods: ['generateContent'] })) };

test('gemini: when a model\'s DAILY quota is gone, it moves to the next model (Flash-Lite) and remembers', async () => {
  const exhausted = new Map();
  const f = fakeFetch([
    ['models/gemini-3.8-flash:generateContent', () => res(DAILY, { status: 429 })],
    ['v1beta/models?pageSize', MODELS],
    ['models/gemini-3.8-flash-lite:generateContent', () => res(OK_JSON())],
  ]);
  const g = mk({ model: 'gemini-3.8-flash', fetchImpl: f, exhausted });
  assert.equal((await g.classify({ text: 'x' })).title, 'T');
  assert.equal(g.state.model, 'gemini-3.8-flash-lite');
  assert.ok(exhausted.get('gemini-3.8-flash') > Date.now() + 8 * 3600 * 1000, 'remembered until the quota resets');

  // A fresh instance (e.g. the next scheduled run on a warm server) skips the used-up model entirely.
  const f2 = fakeFetch([
    ['models/gemini-3.8-flash:generateContent', () => res(DAILY, { status: 429 })],
    ['v1beta/models?pageSize', MODELS],
    ['models/gemini-3.8-flash-lite:generateContent', () => res(OK_JSON())],
  ]);
  const g2 = mk({ model: 'gemini-3.8-flash', fetchImpl: f2, exhausted });
  await g2.classify({ text: 'y' });
  assert.equal(f2.calls.filter((c) => c.url.includes('3.8-flash:generateContent')).length, 0);
});

test('gemini: "limit: 0" (no free quota on this model at all) also switches instead of waiting', async () => {
  const quota = { error: { message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-3-flash' } };
  const sleeps = [];
  const f = fakeFetch([
    ['models/gemini-3-flash:generateContent', () => res(quota, { status: 429 })],
    ['v1beta/models?pageSize', { models: ['gemini-3-flash', 'gemini-3-flash-lite'].map((n) => ({ name: 'models/' + n, supportedGenerationMethods: ['generateContent'] })) }],
    ['models/gemini-3-flash-lite:generateContent', () => res(OK_JSON())],
  ]);
  const g = mk({ model: 'gemini-3-flash', fetchImpl: f, sleepImpl: async (ms) => sleeps.push(ms) });
  assert.equal((await g.classify({ text: 'x' })).title, 'T');
  assert.equal(g.state.model, 'gemini-3-flash-lite');
  assert.ok(!sleeps.some((s) => s >= 5000), 'no pointless back-off');
});

test('gemini: when EVERY model is out of quota the error says so (daily) and makes just one generate call', async () => {
  const f = fakeFetch([
    ['generateContent', () => res(DAILY, { status: 429 })],
    ['v1beta/models?pageSize', { models: [{ name: 'models/only-one-flash', supportedGenerationMethods: ['generateContent'] }] }],
  ]);
  const g = mk({ model: 'only-one-flash', fetchImpl: f });
  await assert.rejects(g.classify({ text: 'x' }), (e) => e instanceof RateLimitError && e.daily && /used up/.test(e.message));
  assert.equal(f.calls.filter((c) => c.url.includes('generateContent')).length, 1);
});

test('gemini: transient overload keeps Google\'s own message', async () => {
  const f = fakeFetch([['generateContent', () => res({ error: { message: 'The model is overloaded. Please try again later.' } }, { status: 503 })]]);
  await assert.rejects(mk({ fetchImpl: f }).classify({ text: 'x' }), /overloaded/);
});

test('gemini: ping reports status and message without retrying or leaking the key', async () => {
  const f = fakeFetch([['generateContent', () => res({ error: { message: 'API key not valid.' } }, { status: 400 })]]);
  const out = await mk({ apiKey: 'SECRETKEY', fetchImpl: f }).ping();
  assert.deepEqual(out, { ok: false, status: 400, model: 'm', message: 'API key not valid.' });
  assert.equal(f.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(out), /SECRETKEY/);
});

/* ------------------------------ backup provider ------------------------------ */

const chatReply = (items) => ({ choices: [{ message: { content: JSON.stringify({ items }) }, finish_reason: 'stop' }] });
const backup = (routes, extra = {}) => createOpenAICompat({ baseUrl: 'https://api.backup.test/openai/v1/', apiKey: 'BKEY', model: 'llama-x', delayMs: 0, sleepImpl: async () => {}, fetchImpl: fakeFetch(routes), ...extra });

test('backup AI: OpenAI-style request with JSON mode, bearer key, batch in one call', async () => {
  const f = fakeFetch([['chat/completions', () => res(chatReply([ITEM('a'), ITEM('b')]))]]);
  const p = backup([], { fetchImpl: f });
  const out = await p.classifyBatch([{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }], { existingCategories: ['AI'] });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://api.backup.test/openai/v1/chat/completions');
  assert.equal(f.calls[0].init.headers.authorization, 'Bearer BKEY');
  const body = JSON.parse(f.calls[0].init.body);
  assert.equal(body.model, 'llama-x');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.deepEqual(out.map((o) => o.ok), [true, true]);
  assert.equal(out[0].result.category, 'AI');
});

test('backup AI: retries once without JSON mode if the model rejects it', async () => {
  let n = 0;
  const f = fakeFetch([['chat/completions', (_u, init) => (++n === 1 ? res({ error: { message: "response_format 'json_object' is not supported by this model" } }, { status: 400 }) : res(chatReply([ITEM('a')])))]]);
  const out = await backup([], { fetchImpl: f }).classifyBatch([{ id: 'a', text: 'x' }]);
  assert.equal(out[0].ok, true);
  assert.equal(JSON.parse(f.calls[1].init.body).response_format, undefined);
});

test('backup AI: daily limit is reported as a daily RateLimitError; PDFs are refused', async () => {
  const p = backup([['chat/completions', () => res({ error: { message: 'Rate limit reached: tokens per day (TPD) limit 200000' } }, { status: 429 })]]);
  await assert.rejects(p.classifyBatch([{ id: 'a', text: 'x' }]), (e) => e instanceof RateLimitError && e.daily);
  await assert.rejects(p.classifyBatch([{ id: 'a', pdfBase64: 'AAA' }]), /cannot read PDFs/);
});

test('provider chain: Gemini out of quota -> backup answers; real errors are not hidden; PDFs never go to the backup', async () => {
  const gemini = { name: 'gemini', supportsPdf: true, classifyBatch: async () => { throw new RateLimitError('Gemini used up', { daily: true }); } };
  const second = { name: 'backup', supportsPdf: false, classifyBatch: async (items) => items.map((i) => ({ id: i.id, ok: true, result: { category: 'AI' } })) };
  const chain = createClassifier([gemini, second]);
  assert.equal((await chain.classifyBatch([{ id: 'a', text: 'x' }]))[0].result.category, 'AI');
  await assert.rejects(chain.classifyBatch([{ id: 'a', pdfBase64: 'AAA' }]), (e) => e instanceof RateLimitError && /Gemini used up/.test(e.message));

  const broken = { name: 'gemini', supportsPdf: true, classifyBatch: async () => { throw new Error('The AI returned invalid JSON.'); } };
  await assert.rejects(createClassifier([broken, second]).classifyBatch([{ id: 'a', text: 'x' }]), /invalid JSON/);
  await assert.rejects(createClassifier([gemini]).classifyBatch([{ id: 'a', text: 'x' }]), /Gemini used up/);
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
const okResult = (over = {}) => ({ title: '', category: 'AI', tags: ['#A'], format: 'Op-Ed', tldr: 'Short.', author: 'Jane Writer', ...over });
const fakeClassifier = (fn) => ({ calls: [], classifyBatch: async function (items, opts) { this.calls.push({ items, opts }); return fn(items, opts); } });
const answerAll = (over) => (items) => items.map((i) => ({ id: i.id, ok: true, result: okResult(typeof over === 'function' ? over(i) : over) }));

test('queue: several articles are classified with ONE AI request, and every field is written', async () => {
  const sheet = queueSheet([
    { id: 'a1', url: 'https://mag.test/a', title: 'RSS title', author_source: 'Test Mag', source_feed: 'Test Mag', type: 'Article', classify_attempts: 0 },
    { id: 'a2', url: 'https://mag.test/b', title: 'Two', type: 'Article', classify_attempts: 0 },
    { id: 'a3', url: 'https://mag.test/c', title: 'Three', type: 'Article', classify_attempts: 0 },
  ]);
  const classifier = fakeClassifier(answerAll());
  const out = await processPending({ sheet, classifier, fetchImpl: fakeFetch([['mag.test', goodPage]]), limit: 5 });
  assert.equal(classifier.calls.length, 1, 'one request for three articles');
  assert.equal(classifier.calls[0].items.length, 3);
  assert.match(classifier.calls[0].items[0].text, /quick brown fox/);
  assert.deepEqual(classifier.calls[0].opts.existingCategories, ['AI']);
  assert.equal(out.processed, 3);
  assert.deepEqual(sheet.writes.slice(0, 3).map((w) => w.fields.classify_attempts), [1, 1, 1], 'attempts bumped first');
  const final = sheet.writes.find((w) => w.id === 'a1' && w.fields.category);
  assert.equal(final.fields.category, 'AI');
  assert.equal(final.fields.author_source, 'Jane Writer');
  assert.ok(final.fields.reading_time >= 1);
  assert.equal(final.fields.title, undefined, 'a good RSS title is kept');
  assert.equal(typeof out.elapsedMs, 'number');
});

test('queue: running out of AI quota gives every attempt back and records why', async () => {
  const sheet = queueSheet([
    { id: 'a1', url: 'https://mag.test/a', classify_attempts: 2 },
    { id: 'a2', url: 'https://mag.test/b', classify_attempts: 0 },
  ]);
  const classifier = fakeClassifier(() => { throw new RateLimitError('Free quota used up. Google says: limit: 0', { daily: true }); });
  const out = await processPending({ sheet, classifier, fetchImpl: fakeFetch([['mag.test', goodPage]]), limit: 5 });
  assert.equal(out.stopped, 'daily AI quota reached');
  assert.match(out.detail, /limit: 0/);
  assert.equal(out.processed, 0);
  assert.equal(out.failed, 0);
  const restored = Object.fromEntries(sheet.writes.filter((w) => /Waiting to retry/.test(w.fields.last_error || '')).map((w) => [w.id, w.fields.classify_attempts]));
  assert.deepEqual(restored, { a2: 0, a1: 2 });
});

test('queue: a deleted page fails alone; the others in the batch are still classified', async () => {
  const sheet = queueSheet([
    { id: 'bad', url: 'https://down.test/a', classify_attempts: 0 },
    { id: 'ok', url: 'https://mag.test/a', classify_attempts: 0 },
  ]);
  const classifier = fakeClassifier(answerAll());
  const f = fakeFetch([['down.test', () => res('x', { status: 404 })], ['mag.test', goodPage]]);
  const out = await processPending({ sheet, classifier, fetchImpl: f, limit: 5 });
  assert.equal(out.failed, 1);
  assert.equal(out.processed, 1);
  assert.deepEqual(classifier.calls[0].items.map((i) => i.id), ['ok']);
  assert.match(sheet.writes.find((w) => w.id === 'bad' && w.fields.last_error).fields.last_error, /404/);
});

test('queue: an article the AI skipped is counted as failed with a reason', async () => {
  const sheet = queueSheet([{ id: 'a1', url: 'https://mag.test/a' }, { id: 'a2', url: 'https://mag.test/b' }]);
  const classifier = fakeClassifier((items) => [{ id: items[0].id, ok: true, result: okResult() }, { id: items[1].id, ok: false, error: 'The AI skipped this article.' }]);
  const out = await processPending({ sheet, classifier, fetchImpl: fakeFetch([['mag.test', goodPage]]), limit: 5 });
  assert.equal(out.processed, 1);
  assert.equal(out.failed, 1);
  assert.match(sheet.writes.at(-1).fields.last_error, /skipped/);
});

test('queue: a page that times out falls back to the feed summary instead of failing', async () => {
  const sheet = queueSheet([{ id: 'a1', url: 'https://slow.test/a', title: 'Slow Essay', tldr: 'Feed blurb about growth.', classify_attempts: 0 }]);
  const classifier = fakeClassifier(answerAll({ category: 'Economics' }));
  const f = fakeFetch([['slow.test', () => { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; }]]);
  const out = await processPending({ sheet, classifier, fetchImpl: f, limit: 5 });
  assert.equal(out.processed, 1);
  assert.equal(classifier.calls[0].items[0].text, 'Feed blurb about growth.');
  const final = sheet.writes.at(-1).fields;
  assert.equal(final.category, 'Economics');
  assert.match(final.last_error, /took too long.*feed summary/);
});

test('queue: PDFs are classified on their own request, text articles together', async () => {
  const sheet = queueSheet([{ id: 'p', url: 'https://x.test/doc.pdf', type: 'PDF' }, { id: 't1', url: 'https://mag.test/a' }, { id: 't2', url: 'https://mag.test/b' }]);
  const classifier = fakeClassifier(answerAll());
  const f = fakeFetch([['doc.pdf', () => res('%PDF-1.4 fake', { headers: { 'content-type': 'application/pdf' }, url: 'https://x.test/doc.pdf' })], ['mag.test', goodPage]]);
  const out = await processPending({ sheet, classifier, fetchImpl: f, limit: 5 });
  assert.equal(out.processed, 3);
  assert.equal(classifier.calls.length, 2);
  assert.deepEqual(classifier.calls.map((c) => c.items.length).sort(), [1, 2]);
  assert.ok(classifier.calls.find((c) => c.items[0].pdfBase64));
});

test('queue: a broken AI answer marks the batch failed (not stuck), with the reason', async () => {
  const sheet = queueSheet([{ id: 'a1', url: 'https://mag.test/a' }, { id: 'a2', url: 'https://mag.test/b' }]);
  const classifier = fakeClassifier(() => { throw new Error('The AI returned invalid JSON.'); });
  const out = await processPending({ sheet, classifier, fetchImpl: fakeFetch([['mag.test', goodPage]]), limit: 5 });
  assert.equal(out.failed, 2);
  assert.match(sheet.writes.at(-1).fields.last_error, /invalid JSON/);
});

test('queue: articles with fewer failed attempts go first, and limit caps the batch', async () => {
  const sheet = queueSheet([
    { id: 'stubborn', url: 'https://mag.test/a', classify_attempts: 3 },
    { id: 'fresh', url: 'https://mag.test/b', classify_attempts: 0 },
  ]);
  const classifier = fakeClassifier(answerAll());
  await processPending({ sheet, classifier, fetchImpl: fakeFetch([['mag.test', goodPage]]), limit: 1 });
  assert.deepEqual(classifier.calls[0].items.map((i) => i.id), ['fresh']);
});

test('queue: nothing pending is a cheap no-op', async () => {
  const out = await processPending({ sheet: queueSheet([]), classifier: {}, limit: 5 });
  assert.deepEqual({ ...out, elapsedMs: 0 }, { processed: 0, failed: 0, remaining: 0, stopped: '', elapsedMs: 0 });
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


test('router: gemini-test route returns the ping result', async () => {
  const d = routerDeps();
  d.gemini = { state: { model: 'm' }, ping: async () => ({ ok: true, status: 200, model: 'm', message: 'Gemini answered.' }) };
  const j = await (await handle(api('GET', 'gemini-test'), d)).json();
  assert.equal(j.status, 200);
});

test('router: process classifies a small batch and reports how long it took', async () => {
  const d = routerDeps();
  d.cfg = { passphrase: 'pw', manualBatch: 2 };
  const calls = [];
  d.sheet = { ...d.sheet, pending: async () => [{ id: 'a1', url: 'https://mag.test/a' }, { id: 'a2', url: 'https://mag.test/b' }, { id: 'a3', url: 'https://mag.test/c' }], categories: async () => [], updateArticle: async () => ({}) };
  d.classifier = { classifyBatch: async (items) => { calls.push(items.length); return items.map((i) => ({ id: i.id, ok: true, result: { category: 'AI', tags: [], format: 'Other', tldr: 'x', author: '' } })); } };
  d.fetchImpl = fakeFetch([['mag.test', goodPage]]);
  const j = await (await handle(api('POST', 'process'), d)).json();
  assert.deepEqual(calls, [2], 'manualBatch of 2 respected');
  assert.equal(j.processed, 2);
  assert.equal(typeof j.elapsedMs, 'number');
  const big = await (await handle(api('POST', 'process', { body: { batch: 99 } }), d)).json();
  assert.ok(calls.at(-1) <= 6, 'capped at 6');
});

test('config: batch and backup-AI settings', () => {
  const c = loadConfig({});
  assert.equal(c.batchSize, 5);
  assert.equal(c.geminiModel, 'gemini-flash-lite-latest');
  assert.equal(backupConfigured(c), false);
  assert.equal(backupConfigured(loadConfig({ BACKUP_LLM_BASE_URL: 'https://x/v1', BACKUP_LLM_API_KEY: 'k', BACKUP_LLM_MODEL: 'm' })), true);
  assert.equal(backupConfigured(loadConfig({ BACKUP_LLM_BASE_URL: 'https://x/v1' })), false, 'all three are required');
});

test('prompt: judges by subject, forbids "Other", and asks for the topic first', () => {
  const prompt = buildBatchPrompt({ items: [{ id: '1', text: 'x' }], existingCategories: ['History'] });
  assert.match(prompt, /Never answer "Other"/);
  assert.match(prompt, /topic: ONE plain sentence/);
  assert.match(prompt, /ONLY if it is a precise fit/);
  assert.match(prompt, /Philosophy/);
});

test('classification: a vague category ("Other") is rejected so the article is retried, not filed', () => {
  const items = [{ id: 'a' }, { id: 'b' }];
  const out = matchResults({ items: [ITEM('a', { category: 'Other' }), ITEM('b', { category: 'Philosophy' })] }, items, []);
  assert.equal(out[0].ok, false);
  assert.match(out[0].error, /vague category/);
  assert.equal(out[1].ok, true);
});

test('queue: short extracted text marks the reading time as low confidence; library route exposes it', async () => {
  const sheet = queueSheet([{ id: 'a1', url: 'https://mag.test/a', classify_attempts: 0 }]);
  const classifier = fakeClassifier(answerAll());
  const shortPage = () => res('<html><body><article><h1>T</h1>' + '<p>word </p>'.repeat(5) + '</article></body></html>', { url: 'https://mag.test/a' });
  await processPending({ sheet, classifier, fetchImpl: fakeFetch([['mag.test', shortPage]]), limit: 5 });
  const final = sheet.writes.at(-1).fields;
  assert.match(final.last_error, /Reading time|Classified from/);
  assert.equal(readingTimeIsLow({ last_error: READING_TIME_NOTE }), true);
  assert.equal(readingTimeIsLow({ last_error: 'Page unavailable (x); classified from the title only.' }), true);
  assert.equal(readingTimeIsLow({ last_error: '' }), false);
});

test('router: reclassify puts weak articles back in the queue; "all" re-queues everything', async () => {
  const d = routerDeps();
  const written = [];
  d.sheet = { ...d.sheet, articles: async () => [
    { id: '1', category: 'Other', tags: ['#A'] }, { id: '2', category: 'History', tags: [] },
    { id: '3', category: 'Philosophy', tags: ['#A'] }, { id: '4', category: '', tags: [] },
  ], updateArticle: async (items) => { written.push(...items); return {}; } };
  let j = await (await handle(api('POST', 'reclassify', { body: {} }), d)).json();
  assert.equal(j.requeued, 2);
  assert.deepEqual(written.map((w) => w.id).sort(), ['1', '2']);
  assert.deepEqual(written[0].fields, { category: '', classify_attempts: 0 });
  written.length = 0;
  j = await (await handle(api('POST', 'reclassify', { body: { mode: 'all' } }), d)).json();
  assert.equal(j.requeued, 3);
});

/* ------------------------------ sources, discovery, long reads ------------------------------ */

const rssItem = (n, words) => `<item><title>Piece ${n}</title><link>https://q.test/p${n}</link><pubDate>Mon, 0${n} Sep 2026 10:00:00 GMT</pubDate><description>Blurb ${n}</description>${words ? `<content:encoded><![CDATA[<p>${'word '.repeat(words)}</p>]]></content:encoded>` : ''}</item>`;
const feedXml = (items, title = 'Quanta Magazine') => `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>${title}</title>${items}</channel></rss>`;

test('feeds: item length is read from the feed when it carries full text, else unknown', () => {
  const items = parseFeed(feedXml(rssItem(1, 2000) + rssItem(2, 0) + rssItem(3, 100)));
  const by = Object.fromEntries(items.map((i) => [i.title, i.words]));
  assert.equal(by['Piece 1'] > 1500, true);
  assert.equal(by['Piece 2'], 0, 'no body: unknown');
  assert.equal(by['Piece 3'], 0, 'a tiny body is just an excerpt');
});

test('harvest: "long reads only" skips items the feed proves are short, keeps unknowns and long ones', async () => {
  const added = [];
  const sheet = { articles: async () => [], add: async (x) => added.push(...x) };
  const feeds = [{ id: 's1', name: 'Q', feed_url: 'https://q.test/feed', long_only: true, min_minutes: 6, active: true }];
  const f = fakeFetch([['q.test/feed', () => res(feedXml(rssItem(1, 600) + rssItem(2, 2500) + rssItem(3, 0)))]]);
  const rep = await harvest({ sheet, fetchImpl: f, cfg: { seedPerFeed: 8, maxPerFeedPerRun: 5 }, feeds });
  assert.deepEqual(added.map((a) => a.title).sort(), ['Piece 2', 'Piece 3']);
  assert.equal(rep[0].added, 2);
});

test('harvest: reads sources from the Sheet, skips inactive ones, and records how each pull went', async () => {
  const added = [];
  const updates = [];
  const sheet = {
    articles: async () => [],
    add: async (x) => added.push(...x),
    sources: async () => [
      { id: 's1', name: 'Q', feed_url: 'https://q.test/feed', active: true, total_added: 3 },
      { id: 's2', name: 'Off', feed_url: 'https://off.test/feed', active: false },
      { id: 's3', name: 'Broken', feed_url: 'https://broken.test/feed', active: true },
    ],
    updateSource: async (u) => updates.push(...u),
  };
  const f = fakeFetch([['q.test/feed', () => res(feedXml(rssItem(1, 0)))], ['broken.test', () => res('x', { status: 503 })]]);
  const rep = await harvest({ sheet, fetchImpl: f, cfg: { seedPerFeed: 8, maxPerFeedPerRun: 5 } });
  assert.deepEqual(rep.map((r) => r.feed).sort(), ['Broken', 'Q']);
  assert.equal(f.calls.some((c) => c.url.includes('off.test')), false);
  const q = updates.find((u) => u.id === 's1').fields;
  assert.equal(q.last_status, 'OK');
  assert.equal(q.total_added, 4);
  assert.match(updates.find((u) => u.id === 's3').fields.last_status, /Failed: HTTP 503/);
});

test('harvest: onlyId pulls just one source (used right after adding it)', async () => {
  const sheet = { articles: async () => [], add: async () => {}, updateSource: async () => {}, sources: async () => [
    { id: 's1', name: 'A', feed_url: 'https://a.test/feed', active: true }, { id: 's2', name: 'B', feed_url: 'https://b.test/feed', active: true }] };
  const f = fakeFetch([['feed', () => res(feedXml(rssItem(1, 0)))]]);
  const rep = await harvest({ sheet, fetchImpl: f, cfg: { seedPerFeed: 8, maxPerFeedPerRun: 5 }, onlyId: 's2' });
  assert.deepEqual(rep.map((r) => r.feed), ['B']);
});

test('sources: the first harvest copies the five built-in feeds into the Sources tab; an old Code.gs still works', async () => {
  let stored = [];
  const sheet = { sources: async () => stored, addSource: async (items) => { stored = items.map((i, n) => ({ id: 'x' + n, ...i })); } };
  const list = await loadSources(sheet);
  assert.equal(list.length, DEFAULT_SOURCES.length);
  assert.deepEqual(list.map((s) => s.name), ['Aeon', 'Noema', 'Works in Progress', 'Psyche', 'Nautilus']);
  const old = await loadSources({ sources: async () => { throw new Error('Unknown "what": sources'); } });
  assert.equal(old.length, 5, 'falls back to the built-in feeds');
});

test('discoverFeed: finds the feed from a site page via <link rel=alternate>', async () => {
  const html = '<html><head><link rel="alternate" type="application/rss+xml" title="comments" href="/comments/feed"><link rel="alternate" type="application/rss+xml" href="/rss/all.xml"></head></html>';
  const f = fakeFetch([['q.test/rss/all.xml', () => res(feedXml(rssItem(1, 2500) + rssItem(2, 0)))], ['q.test', () => res(html, { url: 'https://q.test/' })]]);
  const r = await discoverFeed('q.test', { fetchImpl: f });
  assert.equal(r.ok, true);
  assert.equal(r.feedUrl, 'https://q.test/rss/all.xml');
  assert.equal(r.name, 'Quanta Magazine');
  assert.equal(r.items.length, 2);
  assert.equal(r.longCount, 1);
});

test('discoverFeed: accepts a feed address directly; tries common paths when the page has no link tag', async () => {
  const direct = await discoverFeed('https://q.test/feed', { fetchImpl: fakeFetch([['q.test', () => res(feedXml(rssItem(1, 0)), { url: 'https://q.test/feed' })]]) });
  assert.equal(direct.feedUrl, 'https://q.test/feed');
  const guess = await discoverFeed('https://blog.test', { fetchImpl: fakeFetch([['blog.test/feed', () => res(feedXml(rssItem(1, 0)))], ['blog.test', () => res('<html>no link tags</html>')]]) });
  assert.equal(guess.ok, true);
  assert.match(guess.feedUrl, /blog\.test\/feed/);
});

test('discoverFeed: clear errors for no feed, unreachable sites, and private addresses', async () => {
  const none = await discoverFeed('https://nofeed.test', { fetchImpl: fakeFetch([['nofeed.test', () => res('<html>hi</html>')]]) });
  assert.equal(none.ok, false);
  assert.match(none.error, /No feed was found/);
  const down = await discoverFeed('https://down.test', { fetchImpl: fakeFetch([['down.test', () => { throw new Error('boom'); }]]) });
  assert.match(down.error, /could not be reached/);
  assert.match((await discoverFeed('http://192.168.1.5/feed')).error, /Private|local/);
  assert.match((await discoverFeed('')).error, /address|valid/i);
});

test('suggested sources: every entry has a name, an https site and a description', () => {
  assert.ok(SUGGESTED_SOURCES.length >= 10);
  for (const s of SUGGESTED_SOURCES) { assert.ok(s.name && s.about); assert.match(s.site, /^https:\/\//); }
});

test('queue: a short piece from a long-reads-only source is archived automatically; long ones and other sources are not', async () => {
  const sheet = queueSheet([
    { id: 'short', url: 'https://mag.test/short', source_feed: 'Q', status: 'Unread', classify_attempts: 0 },
    { id: 'long', url: 'https://mag.test/long', source_feed: 'Q', status: 'Unread', classify_attempts: 0 },
    { id: 'other', url: 'https://mag.test/short2', source_feed: 'Free', status: 'Unread', classify_attempts: 0 },
  ]);
  const body = (n) => `<html><head><title>T</title></head><body><article><h1>T</h1>${'<p>' + 'word '.repeat(200) + '</p>'.repeat(1)}`.repeat(1) + `${('<p>' + 'word '.repeat(200) + '</p>').repeat(n)}</article></body></html>`;
  const f = fakeFetch([['short2', () => res(body(3))], ['short', () => res(body(3))], ['long', () => res(body(40))]]);
  const sources = [{ name: 'Q', long_only: true, min_minutes: 6 }, { name: 'Free', long_only: false }];
  await processPending({ sheet, classifier: fakeClassifier(answerAll()), fetchImpl: f, limit: 5, sources });
  const final = (id) => sheet.writes.filter((w) => w.id === id && w.fields.category).at(-1).fields;
  assert.equal(final('short').status, 'Archive');
  assert.equal(final('long').status, undefined);
  assert.equal(final('other').status, undefined);
});

test('router: sources list, add (discover + save), update whitelist, delete', async () => {
  const d = routerDeps();
  const calls = [];
  d.sheet = {
    ...d.sheet,
    articles: async () => [{ id: '1', source_feed: 'Quanta Magazine' }],
    sources: async () => [{ id: 's1', name: 'Quanta Magazine', feed_url: 'https://q.test/feed', active: true }],
    addSource: async (x) => { calls.push(['add', x]); return { results: [{ ok: true, id: 'new1' }] }; },
    updateSource: async (x) => { calls.push(['update', x]); return { updated: ['s1'] }; },
    deleteSource: async (id) => { calls.push(['delete', id]); return { deleted: true }; },
  };
  d.fetchImpl = fakeFetch([['q.test', () => res(feedXml(rssItem(1, 2500)), { url: 'https://q.test/feed' })]]);
  let j = await (await handle(api('GET', 'sources'), d)).json();
  assert.equal(j.sources[0].article_count, 1);
  assert.ok(j.suggestions.length >= 10);

  j = await (await handle(api('POST', 'sources', { body: { url: 'https://q.test/feed', min_minutes: 8 } }), d)).json();
  assert.equal(j.ok, true);
  assert.equal(j.id, 'new1');
  assert.deepEqual([calls[0][1].long_only, calls[0][1].min_minutes, calls[0][1].feed_url], [true, 8, 'https://q.test/feed']);

  await handle(api('POST', 'sources/update', { body: { id: 's1', fields: { active: false, feed_url: 'https://evil.test', total_added: 99 } } }), d);
  assert.deepEqual(calls.find((c) => c[0] === 'update')[1], [{ id: 's1', fields: { active: false } }], 'only whitelisted fields');

  await handle(api('POST', 'sources/delete', { body: { id: 's1' } }), d);
  assert.deepEqual(calls.at(-1), ['delete', 's1']);

  const nofeed = await handle(api('POST', 'sources', { body: { url: 'https://nope.test' } }), { ...d, fetchImpl: fakeFetch([['nope.test', () => res('<html></html>')]]) });
  assert.equal(nofeed.status, 422);
});

/* ------------------------------ word meanings ------------------------------ */

const DICT = [{ word: 'serendipity', phonetic: '/ˌsɛɹənˈdɪpɪti/', phonetics: [{ text: '/x/', audio: 'https://a/s.mp3' }], meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'Finding good things by chance.', example: 'Pure serendipity.' }, { definition: 'A knack for it.' }] }] }];

test('define: cleans the selection, rejects non-words and long passages', () => {
  assert.equal(cleanTerm('  “Serendipity,” '), 'Serendipity');
  assert.equal(cleanTerm('a b c d e'), '');
  assert.equal(cleanTerm('12345'), '');
  assert.equal(cleanTerm(''), '');
});

test('define: returns meanings from the dictionary service', async () => {
  const f = fakeFetch([['dictionaryapi.dev', () => res(DICT)]]);
  const r = await defineWord('Serendipity.', { fetchImpl: f });
  assert.equal(r.ok, true);
  assert.equal(r.meanings[0].pos, 'noun');
  assert.equal(r.meanings[0].definitions[0].example, 'Pure serendipity.');
  assert.equal(r.audio, 'https://a/s.mp3');
  assert.match(f.calls[0].url, /entries\/en\/serendipity$/);
});

test('define: falls back to Wiktionary, and to the base word for "climbs"/"discovered"', async () => {
  const wik = { en: [{ partOfSpeech: 'Verb', definitions: [{ definition: '<a href="x">To</a> go up.', examples: ['<i>She climbs.</i>'] }] }] };
  const f = fakeFetch([
    ['dictionaryapi.dev/api/v2/entries/en/climbs', () => res({ title: 'No Definitions Found' }, { status: 404 })],
    ['wiktionary.org/api/rest_v1/page/definition/climbs', () => res({}, { status: 404 })],
    ['dictionaryapi.dev/api/v2/entries/en/climb', () => res({ x: 1 }, { status: 404 })],
    ['wiktionary.org/api/rest_v1/page/definition/climb', () => res(wik)],
  ]);
  const r = await defineWord('climbs', { fetchImpl: f });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'Wiktionary');
  assert.equal(r.looked, 'climb');
  assert.equal(r.meanings[0].definitions[0].text, 'To go up.');
});

test('define: not found vs. service down are different answers', async () => {
  const nf = await defineWord('zzzqx', { fetchImpl: fakeFetch([['dictionaryapi', () => res({}, { status: 404 })], ['wiktionary', () => res({}, { status: 404 })]]) });
  assert.deepEqual([nf.ok, nf.notFound], [false, true]);
  const down = await defineWord('word', { fetchImpl: fakeFetch([['', () => res('x', { status: 500 })]]) });
  assert.equal(down.ok, false);
  assert.equal(down.notFound, undefined);
  assert.match(down.error, /could not be reached/);
});

test('router: /api/define', async () => {
  const d = routerDeps();
  d.fetchImpl = fakeFetch([['dictionaryapi.dev', () => res(DICT)]]);
  const j = await (await handle(api('GET', 'define?word=serendipity'), d)).json();
  assert.equal(j.ok, true);
});
