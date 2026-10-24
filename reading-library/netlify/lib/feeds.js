import { BROWSER_UA, decodeEntities, normalizeUrl, stripTags } from './util.js';

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

    items.push({
      title: stripTags(tag(b, 'title')),
      url: link,
      author: /@/.test(author) ? author.replace(/^.*\(([^)]+)\).*$/, '$1') : author, // "mail (Name)" -> Name
      published,
      summary,
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
  return items.filter((it) => !(feed.skip || []).some((re) => re.test(it.url)));
}

/**
 * Pull new items from every feed and add them to the Sheet as unclassified rows.
 * - A feed with nothing in the Sheet yet is "seeded" with `seedPerFeed` items (7-10).
 * - Otherwise at most `maxPerFeedPerRun` new items are added.
 * Returns a per-feed report. Never throws for a single bad feed.
 */
export async function harvest({ sheet, fetchImpl = fetch, cfg, feeds = FEEDS, log = () => {} }) {
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
    feeds.map(async (feed) => {
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
  for (const r of results) {
    if (r.error) {
      report.push({ feed: r.feed.name, error: r.error, added: 0 });
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
        // The feed's own blurb, shown until Gemini writes a proper TL;DR. It is also the
        // fallback text if the article page itself cannot be loaded.
        tldr: it.summary ? it.summary.slice(0, 500) : '',
        status: 'Unread',
      });
    }
    report.push({ feed: r.feed.name, seeding: r.seeding, found: r.items.length, added: fresh.length });
  }

  if (toAdd.length) await sheet.add(toAdd);
  return report;
}
