// Local preview with fake data, no Netlify, Sheet or AI needed:  node dev/mock-server.js  ->  http://localhost:8888
// Passphrase: demo
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PASS = 'demo';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };

const day = (n) => new Date(Date.now() - n * 864e5).toISOString();
const A = (i, title, author, feed, category, fmt, mins, tldr, extra = {}) => ({
  id: 'a' + i, date_added: day(i), title, author_source: author, url: `https://example.test/${i}`, category, tags: ['#Ideas', '#Essay'],
  format: fmt, reading_time: mins, tldr, status: 'Unread', type: 'Article', notes: '', source_feed: feed, published_date: day(i), classify_attempts: 1, last_error: '', ...extra,
});
let articles = [
  A(1, 'The ladder of knowledge', 'Alexander V Gheorghiu', 'Aeon', 'Philosophy', 'Longform Essay', 14, 'A century-long search for the limits of what can be known, and why every answer opens a harder question.'),
  A(2, 'Is everything conscious?', 'Sam Kimpton-Nye', 'Aeon', 'Philosophy', 'Longform Essay', 20, 'The philosophical demand for complete intelligibility leads, step by step, toward panpsychism.'),
  A(3, 'Mosquitoes are a choice', 'Maya Rosen', 'Works in Progress', 'Biology', 'Longform Essay', 10, 'Genetic engineering can suppress dangerous mosquito populations, but regulation keeps it in limbo.'),
  A(4, 'How China became rich', 'Ben Southwood', 'Works in Progress', 'Economics', 'Longform Essay', 20, 'Competitive local governments function like venture capital firms, creating a powerful engine for manufacturing.'),
  A(5, 'Roman love', 'Samuel Hughes', 'Works in Progress', 'History', 'Longform Essay', 1, 'A review of Kyle Harper’s From Shame to Sin and the evolution of sexuality in the Roman world.', { reading_time_low: true, last_error: 'Classified from a short excerpt (page text unavailable).' }),
  A(6, 'How to overcome task paralysis', 'Joe Wilner', 'Psyche', 'Psychology', 'Longform Essay', 9, 'Task paralysis is a breakdown of executive function; goal management training bridges intention and action.'),
  A(7, 'What life in Denmark shows about the power of emotional safety', 'Ruth Aharoni Nielsen', 'Psyche', 'Psychology', 'Longform Essay', 7, 'Tryg, an intentional state of emotional safety, lets people drop their guard and meet the world with curiosity.'),
  A(8, 'LSD may speed up brain activity and make it fractal', 'Kristen French', 'Nautilus', 'Neuroscience', 'Longform Essay', 5, 'The drug reshuffles how neural systems communicate rather than simply quieting control networks.'),
  A(9, 'The AIs are not going rogue', 'Ken Archer', 'Noema', 'AI & Technology', 'Longform Essay', 12, 'Incidents of AI going rogue are misunderstandings; true general intelligence would question its instructions.'),
  A(10, 'We are already post-human', 'Nathan Gardels', 'Noema', 'AI & Technology', 'Longform Essay', 4, 'Humanity has never been an autonomous rational entity; we already live in a distributed cognition.', { status: 'Reading' }),
  A(11, 'Why housing reforms keep failing', 'Works in Progress', 'Works in Progress', 'Cities & Housing', 'Longform Essay', 18, 'Strict zoning drives up costs; top-down preemption wins votes but meets fierce local resistance.', { status: 'Finished' }),
  A(12, 'Traction!', 'Jennifer R Vail', 'Aeon', '', '', null, 'Tribologists study friction: what happens when things rub together.'),
];
let highlights = [];
let sources = [
  { id: 's1', name: 'Aeon', feed_url: 'https://aeon.co/feed.rss', site_url: 'https://aeon.co', active: true, long_only: false, min_minutes: 0, last_fetched: day(0.1), last_status: 'OK', last_found: 20, total_added: 8 },
  { id: 's2', name: 'Noema', feed_url: 'https://www.noemamag.com/feed/', site_url: 'https://www.noemamag.com', active: true, long_only: true, min_minutes: 6, last_fetched: day(0.3), last_status: 'Failed: HTTP 503', last_found: null, total_added: 6 },
];
const SUGG = [
  { name: 'Quanta Magazine', site: 'https://www.quantamagazine.org', about: 'Mathematics, physics, biology and computer science, explained in depth.' },
  { name: 'The Marginalian', site: 'https://www.themarginalian.org', about: 'Maria Popova on art, science, philosophy and the examined life.' },
  { name: 'Longreads', site: 'https://longreads.com', about: 'A daily pick of the best long stories around the web.' },
];

const para = (s) => `<p>${s}</p>`;
const LONG = Array.from({ length: 26 }, (_, i) => para(
  `${i === 0 ? 'The question is older than the sciences themselves. ' : ''}Paragraph ${i + 1}: knowledge does not arrive in a straight line. Each generation of thinkers inherits a ladder it did not build, climbs a few rungs, and discovers that the view from higher up reveals gaps that were invisible from below. The more carefully we look, the more the horizon recedes, and what once felt like a settled floor turns out to be another rung to stand on.`)).join('\n');
const CONTENT = `<h2>Where the ladder starts</h2>${LONG}<blockquote>“A map is not the territory, but it is the only way we have of walking toward it.”</blockquote><h2>Why it matters now</h2>${LONG.slice(0, 3000)}`;

const send = (res, code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
const readBody = (req) => new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch { r({}); } }); });

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/')) {
    if (req.headers['x-passphrase'] !== PASS) return send(res, 401, { error: 'Unauthorized' });
    const p = u.pathname.slice(5);
    const body = req.method === 'POST' ? await readBody(req) : {};
    if (p === 'auth') return send(res, 200, { ok: true });
    if (p === 'library') {
      const cats = {}; articles.forEach((a) => a.category && (cats[a.category] = (cats[a.category] || 0) + 1));
      return send(res, 200, { articles: articles.map((a) => ({ ...a, reading_time_low: !!a.reading_time_low && /classified|may be off/i.test(a.last_error || '') })), categories: Object.entries(cats).map(([name, count]) => ({ name, count })), pending: articles.filter((a) => !a.category).length });
    }
    if (p === 'articles/update') { const a = articles.find((x) => x.id === body.id); if (a) Object.assign(a, body.fields); return send(res, 200, { ok: true }); }
    if (p === 'articles') { const id = 'n' + Date.now(); articles.unshift(A(0, body.url, '', 'Manual', '', '', null, '', { id, url: body.url, date_added: day(0), classify_attempts: 0 })); return send(res, 200, { ok: true, id, title: body.url }); }
    if (p === 'categories/merge') { articles.forEach((a) => { if (a.category === body.from) a.category = body.to; }); return send(res, 200, { ok: true }); }
    if (p === 'highlights' && req.method === 'GET') return send(res, 200, { highlights: highlights.filter((h) => !u.searchParams.get('since') || h.updated_at > u.searchParams.get('since')) });
    if (p === 'highlights') {
      const applied = [], conflicts = [];
      for (const it of body.items || []) {
        const i = highlights.findIndex((h) => h.id === it.id);
        if (i < 0) { highlights.push(it); applied.push(it.id); } else if (it.updated_at > highlights[i].updated_at) { highlights[i] = { ...highlights[i], ...it }; applied.push(it.id); } else conflicts.push(highlights[i]);
      }
      return send(res, 200, { applied, conflicts });
    }
    if (p === 'extract') {
      const a = articles.find((x) => x.url === u.searchParams.get('url'));
      await new Promise((r) => setTimeout(r, 250));
      return send(res, 200, { ok: true, kind: 'article', title: a?.title, byline: a?.author_source, siteName: a?.source_feed, contentHtml: CONTENT, wordCount: 4200, readingMinutes: 17, originalUrl: u.searchParams.get('url') });
    }
    if (p === 'define') {
      const w = (u.searchParams.get('word') || '').toLowerCase();
      if (w === 'nonsenseword') return send(res, 200, { ok: false, notFound: true });
      return send(res, 200, { ok: true, word: w, phonetic: '/ˈsɛrənˌdɪpɪti/', audio: '', meanings: [{ pos: 'noun', definitions: [{ text: 'The occurrence of events by chance in a happy or beneficial way.', example: 'A fortunate stroke of serendipity.' }, { text: 'An aptitude for making desirable discoveries by accident.', example: '' }] }, { pos: 'adjective', definitions: [{ text: 'Happening by chance, in a pleasant way.', example: '' }] }], source: 'Free Dictionary', url: 'https://en.wiktionary.org/wiki/' + w });
    }
    if (p === 'sources' && req.method === 'GET') return send(res, 200, { sources: sources.map((x) => ({ ...x, article_count: articles.filter((a) => a.source_feed === x.name).length })), suggestions: SUGG });
    if (p === 'sources' && req.method === 'POST') {
      if (/bad/.test(body.url)) return send(res, 422, { ok: false, error: 'No feed was found on that site. Try pasting the feed address itself (often ending in /feed or /rss).' });
      const name = body.name || 'New Source ' + (sources.length + 1);
      const id = 's' + (sources.length + 1);
      sources.push({ id, name, feed_url: body.url + '/feed', site_url: body.url, active: true, long_only: body.long_only !== false, min_minutes: body.min_minutes || 6, last_fetched: '', last_status: '', last_found: null, total_added: 0 });
      return send(res, 200, { ok: true, id, name, feedUrl: body.url + '/feed', sample: [], longCount: 3, total: 10 });
    }
    if (p === 'sources/pull') { const x = sources.find((q) => q.id === body.id); if (x) { x.last_fetched = day(0); x.last_status = 'OK'; x.total_added = 7; } return send(res, 200, { ok: true, report: [{ feed: x?.name, added: 7, found: 12 }] }); }
    if (p === 'sources/update') { const x = sources.find((q) => q.id === body.id); if (x) Object.assign(x, body.fields); return send(res, 200, { ok: true }); }
    if (p === 'sources/delete') { sources = sources.filter((q) => q.id !== body.id); return send(res, 200, { ok: true, deleted: true }); }
    if (p === 'harvest') return send(res, 200, { ok: true, report: [{ feed: 'Aeon', added: 2 }] });
    return send(res, 404, { error: 'Not found' });
  }
  let f = path.join(root, u.pathname === '/' ? 'index.html' : u.pathname);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(root, 'index.html');
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
}).listen(process.env.PORT || 8888, () => console.log('Preview on http://localhost:' + (process.env.PORT || 8888) + '  (passphrase: demo)'));
