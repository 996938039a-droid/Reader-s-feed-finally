import { BROWSER_UA, assertPublicHttpUrl, decodeEntities, normalizeUrl, stripTags } from './util.js';

/**
 * The five seed feeds. `skip` filters out non-reading items (videos, podcasts).
 * `wpPaged`: WordPress feeds that support ?paged=2 so we can top up a short feed.
 */
export const FEEDS = [
  { id: 'aeon', name: 'Aeon', url: 'https://aeon.co/feed.rss', skip: [/\/videos?\//i] },
  { id: 'noema', name: 'Noema', url: 'https://www.noemamag.com/feed/', wpPaged: true },
  { id: 'wip', name: 'Works in Progress', url: 'https://www.worksinprogress.news/feed' },
  { id: 'psyche', name: 'Psyche', url: 'https://psyche.co/feed', skip: [/\/videos?\//i] },
  { id: 'nautilus', name: 'Nautilus', url: 'https://nautil.us/feed/' },
];

/** Words per minute, matching readingMinutes() in util.js. */
const WPM = 230;
/** Pieces of this kind are never reading material. */
const GLOBAL_SKIP = [/\/videos?\//i, /\/podcasts?\//i, /\/newsletter\//i];

/** Feeds the app starts with. They are copied into the Sources tab the first time. */
export const DEFAULT_SOURCES = FEEDS.map((f) => ({ name: f.name, feed_url: f.url, site_url: new URL(f.url).origin, active: true, long_only: false, min_minutes: 0 }));

/**
 * Long-form publications to offer on the Sources page. Only the site address is stored here: when
 * you add one, the app finds the real feed address itself and checks it works.
 */
export const SUGGESTED_SOURCES = [
  { name: 'Quanta Magazine', site: 'https://www.quantamagazine.org', about: 'Mathematics, physics, biology and computer science, explained in depth.' },
  { name: 'The Marginalian', site: 'https://www.themarginalian.org', about: 'Maria Popova on art, science, philosophy and the examined life.' },
  { name: 'Boston Review', site: 'https://www.bostonreview.net', about: 'Political and cultural essays and forums.' },
  { name: 'The Public Domain Review', site: 'https://publicdomainreview.org', about: 'Essays on strange and wonderful historical material.' },
  { name: 'Palladium', site: 'https://www.palladiummag.com', about: 'Long essays on governance, technology and civilisation.' },
  { name: 'Asterisk', site: 'https://asteriskmag.com', about: 'Quarterly of careful, evidence-minded essays on the big questions.' },
  { name: 'Hakai Magazine', site: 'https://hakaimagazine.com', about: 'Coastal science and culture, long-form reporting.' },
  { name: 'The New Atlantis', site: 'https://www.thenewatlantis.com', about: 'Technology, science and society.' },
  { name: 'Longreads', site: 'https://longreads.com', about: 'A daily pick of the best long stories around the web.' },
  { name: 'Literary Hub', site: 'https://lithub.com', about: 'Essays, excerpts and criticism on books and writing.' },
  { name: 'Lapham’s Quarterly', site: 'https://www.laphamsquarterly.org', about: 'History as a lens for the present.' },
  { name: 'Undark', site: 'https://undark.org', about: 'Science journalism with a critical eye.' },
  { name: 'The Point Magazine', site: 'https://thepointmag.com', about: 'Philosophical essays on everyday life.' },
  { name: 'Astral Codex Ten', site: 'https://www.astralcodexten.com', about: 'Long essays on psychology, science, society and reasoning.' },
];

/* ------------------------------ parsing ------------------------------ */

function tag(block, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i');
  const m = block.match(re);
  if (!m) return '';
  return m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1').trim();
}

function toIso(s) {
  const d = new Date(s);
  return s && !Number.isNaN(d.getTime()) ? d.toISOString() : '';
}

/** Parse RSS 2.0 or Atom into [{title,url,author,published,summary}], newest first. */
export function parseFeed(xml) {
  const items = [];
  const blocks = [
    ...String(xml).matchAll(/<item[\s>][\s\S]*?<\/item>/gi),
    ...String(xml).matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi),
  ].map((m) => m[0]);

  for (const b of blocks) {
    let link = stripTags(tag(b, 'link'));
    if (!link) {
      const atom =
        b.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i) ||
        b.match(/<link[^>]*href=["']([^"']+)["']/i);
      link = atom ? decodeEntities(atom[1]) : '';
    }
    if (!link) {
      const guid = stripTags(tag(b, 'guid'));
      if (/^https?:\/\//i.test(guid)) link = guid;
    }
    if (!/^https?:\/\//i.test(link)) continue;

    const author =
      stripTags(tag(b, 'dc:creator')) || stripTags(tag(b, 'author')) || stripTags(tag(b, 'name'));
    const published = toIso(stripTags(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date')));
    const summary = stripTags(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content:encoded')).slice(0, 800);
    // Some feeds carry the whole article. Then we know its length without opening the page (0 = unknown).
    const full = stripTags(tag(b, 'content:encoded') || tag(b, 'content'));
    const words = full ? full.split(/\s+/).filter(Boolean).length : 0;

    items.push({
      title: stripTags(tag(b, 'title')),
      url: link,
      author: /@/.test(author) ? author.replace(/^.*\(([^)]+)\).*$/, '$1') : author, // "mail (Name)" -> Name
      published,
      summary,
      words: words > 300 ? words : 0, // a short body is probably just an excerpt
    });
  }
  return items.sort((a, b) => (b.published || '').localeCompare(a.published || ''));
}

/* ------------------------------ harvesting ------------------------------ */

async function getXml(url, fetchImpl) {
  const res = await fetchImpl(url, {
    redirect: 'follow',
    headers: { 'user-agent': BROWSER_UA, accept: 'application/rss+xml, application/xml, text/xml, */*' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function usable(feed, items) {
  const skip = [...GLOBAL_SKIP, ...(feed.skip || [])];
  return items.filter((it) => {
    if (skip.some((re) => re.test(it.url))) return false;
    // "Long reads only": drop items whose feed text already proves they are short.
    if (feed.longOnly && feed.minMinutes && it.words && it.words < feed.minMinutes * WPM) return false;
    return true;
  });
}

/** Turn a Sources-tab row (or a legacy feed object) into what harvest works with. */
function toFeed(src) {
  const known = FEEDS.find((f) => f.url === (src.feed_url || src.url));
  return {
    id: src.id,
    name: src.name,
    url: src.feed_url || src.url,
    longOnly: !!src.long_only || !!src.longOnly,
    minMinutes: Number(src.min_minutes ?? src.minMinutes) || 0,
    skip: src.skip || known?.skip,
    wpPaged: src.wpPaged ?? known?.wpPaged ?? /\/feed\/?$/.test(src.feed_url || src.url || ''),
  };
}

/** The sources to pull from. Falls back to the built-in five if the Sheet has no Sources tab yet. */
export async function loadSources(sheet, { seed = true } = {}) {
  if (typeof sheet.sources !== 'function') return DEFAULT_SOURCES.map((d) => ({ ...d }));
  try {
    let list = await sheet.sources();
    // The built-in five are copied in whenever none of them are present, even if you already added
    // your own sources first. (Switch one Off rather than removing it, or removing all five brings them back.)
    const have = new Set(list.map((s) => normalizeUrl(s.feed_url)));
    const anyBuiltIn = DEFAULT_SOURCES.some((d) => have.has(normalizeUrl(d.feed_url)));
    if (!anyBuiltIn && seed && typeof sheet.addSource === 'function') {
      try {
        await sheet.addSource(DEFAULT_SOURCES);
        list = await sheet.sources();
      } catch {
        /* could not save them this time; keep the sources you have and try again next run */
      }
    }
    return list;
  } catch {
    return DEFAULT_SOURCES.map((d) => ({ ...d })); // an older Code.gs without Sources support
  }
}

/**
 * Pull new items from every active source and add them to the Sheet as unclassified rows.
 * - A source with nothing in the Sheet yet is "seeded" with `seedPerFeed` items (7-10).
 * - Otherwise at most `maxPerFeedPerRun` new items are added, and only ones newer than the newest saved.
 * Returns a per-source report. Never throws for a single bad feed.
 * @param {string} [onlyId] pull just this source (used right after adding one)
 */
export async function harvest({ sheet, fetchImpl = fetch, cfg, feeds, onlyId, log = () => {} }) {
  let sources = feeds ? feeds.map((f) => ({ ...f })) : await loadSources(sheet);
  sources = sources.filter((s) => (s.active === undefined ? true : s.active !== false) && (!onlyId || s.id === onlyId));
  const feedList = sources.map(toFeed);

  const existing = await sheet.articles();
  const countByFeed = new Map();
  for (const a of existing) if (a.source_feed) countByFeed.set(a.source_feed, (countByFeed.get(a.source_feed) || 0) + 1);

  const report = [];
  const known = new Set(existing.map((a) => normalizeUrl(a.url)));
  const latestByFeed = new Map();
  for (const a of existing) {
    if (a.source_feed && a.published_date && String(a.published_date) > (latestByFeed.get(a.source_feed) || '')) {
      latestByFeed.set(a.source_feed, String(a.published_date));
    }
  }

  const results = await Promise.all(
    feedList.map(async (feed) => {
      try {
        let items = usable(feed, parseFeed(await getXml(feed.url, fetchImpl)));
        const seeding = !countByFeed.get(feed.name);
        const want = seeding ? cfg.seedPerFeed : cfg.maxPerFeedPerRun;

        // Short feeds (Noema serves only 5) get topped up from page 2 when seeding.
        if (seeding && feed.wpPaged && items.length < want) {
          try {
            const more = usable(feed, parseFeed(await getXml(feed.url + (feed.url.includes('?') ? '&' : '?') + 'paged=2', fetchImpl)));
            const seen = new Set(items.map((i) => normalizeUrl(i.url)));
            items = items.concat(more.filter((i) => !seen.has(normalizeUrl(i.url))));
          } catch {
            /* page 2 is a bonus; ignore failures */
          }
        }
        return { feed, items, want, seeding };
      } catch (err) {
        log(`Feed "${feed.name}" failed: ${err.message}`);
        return { feed, error: err.message };
      }
    })
  );

  const toAdd = [];
  const statusUpdates = [];
  const stamp = new Date().toISOString();
  for (const r of results) {
    if (r.error) {
      report.push({ feed: r.feed.name, error: r.error, added: 0 });
      if (r.feed.id) statusUpdates.push({ id: r.feed.id, fields: { last_fetched: stamp, last_status: ('Failed: ' + r.error).slice(0, 200) } });
      continue;
    }
    const fresh = [];
    // After the first seed, only take posts NEWER than the newest one already saved from this
    // feed. Otherwise every later run would keep pulling the feed's older backlog.
    const latest = r.seeding ? '' : latestByFeed.get(r.feed.name) || '';
    for (const it of r.items) {
      const key = normalizeUrl(it.url);
      if (known.has(key)) continue;
      if (latest && it.published && it.published <= latest) continue;
      if (fresh.length >= r.want) break;
      known.add(key);
      fresh.push(it);
    }
    for (const it of fresh) {
      toAdd.push({
        title: it.title,
        author_source: it.author || r.feed.name,
        url: it.url,
        type: 'Article',
        source_feed: r.feed.name,
        published_date: it.published,
        // The feed's own blurb, shown until the AI writes a proper TL;DR. It is also the
        // fallback text if the article page itself cannot be loaded.
        tldr: it.summary ? it.summary.slice(0, 500) : '',
        status: 'Unread',
      });
    }
    report.push({ feed: r.feed.name, seeding: r.seeding, found: r.items.length, added: fresh.length });
    if (r.feed.id) {
      const prev = sources.find((x) => x.id === r.feed.id);
      statusUpdates.push({
        id: r.feed.id,
        fields: { last_fetched: stamp, last_status: 'OK', last_found: r.items.length, total_added: (Number(prev?.total_added) || 0) + fresh.length },
      });
    }
  }

  if (toAdd.length) await sheet.add(toAdd);
  if (statusUpdates.length && typeof sheet.updateSource === 'function') await sheet.updateSource(statusUpdates).catch(() => {});
  return report;
}

/* ------------------------------ finding a feed ------------------------------ */

const FEED_GUESSES = ['/feed', '/feed/', '/rss', '/rss.xml', '/feed.xml', '/atom.xml', '/index.xml', '/?feed=rss2'];
const looksLikeFeed = (t) => /<(rss|feed|rdf:RDF)[\s>]/i.test(String(t).slice(0, 3000));

async function tryGet(url, fetchImpl, timeoutMs = 6000) {
  const res = await fetchImpl(url, {
    redirect: 'follow',
    headers: { 'user-agent': BROWSER_UA, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html, */*' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { text: await res.text(), url: res.url || url };
}

function channelTitle(xml) {
  const head = String(xml).split(/<item[\s>]|<entry[\s>]/i)[0];
  return stripTags(tag(head, 'title'));
}

/**
 * Given a site address or a feed address, find a working feed.
 * @returns {{ok:true, feedUrl, siteUrl, name, items:[{title,url,published,words}], longCount} | {ok:false, error}}
 */
export async function discoverFeed(input, { fetchImpl = fetch } = {}) {
  let start;
  try {
    let raw = String(input || '').trim();
    if (raw && !/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
    start = new URL(assertPublicHttpUrl(raw));
  } catch (e) {
    return { ok: false, error: e.message || 'That does not look like a web address.' };
  }
  const siteUrl = start.origin;
  const candidates = [];
  let first;
  try {
    first = await tryGet(start.href, fetchImpl, 5000);
  } catch (e) {
    first = null;
    var firstError = e.message;
  }
  if (first && looksLikeFeed(first.text)) candidates.push({ url: first.url, xml: first.text });
  else if (first) {
    for (const m of first.text.matchAll(/<link\b[^>]*>/gi)) {
      const t = m[0];
      if (!/rel=["']alternate["']/i.test(t) || !/type=["']application\/(rss|atom)\+xml["']/i.test(t)) continue;
      const href = t.match(/href=["']([^"']+)["']/i)?.[1];
      if (!href || /comments/i.test(href)) continue;
      try { candidates.push({ url: new URL(decodeEntities(href), first.url).href }); } catch { /* bad href */ }
    }
  }
  const host = start.hostname;
  if (/\.substack\.com$/i.test(host)) candidates.push({ url: siteUrl + '/feed' });
  for (const g of FEED_GUESSES) candidates.push({ url: siteUrl + g });
  if (start.pathname.length > 1) for (const g of ['feed', 'rss', 'feed.xml']) candidates.push({ url: start.href.replace(/\/+$/, '') + '/' + g });

  const seen = new Set();
  const ordered = candidates.filter((c) => !seen.has(c.url) && seen.add(c.url));

  async function check(c) {
    try {
      const xml = c.xml ?? (await tryGet(c.url, fetchImpl, 4500)).text;
      if (!looksLikeFeed(xml)) return null;
      const items = parseFeed(xml);
      if (!items.length) return null;
      return {
        ok: true,
        feedUrl: c.url,
        siteUrl,
        name: channelTitle(xml) || host.replace(/^www\./, ''),
        items: items.slice(0, 5).map((i) => ({ title: i.title, url: i.url, published: i.published, words: i.words })),
        longCount: items.filter((i) => i.words >= 1200).length,
        total: items.length,
      };
    } catch {
      return null;
    }
  }
  // Check the guesses at the same time (keeping their order of preference) so this stays quick.
  if (first || /^HTTP/.test(firstError || '')) {
    const found = (await Promise.all(ordered.slice(0, 10).map(check))).find(Boolean);
    if (found) return found;
  }
  return { ok: false, error: first ? 'No feed was found on that site. Try pasting the feed address itself (often ending in /feed or /rss).' : `That address could not be reached (${firstError}).` };
}
