import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAppsScript } from './helpers.js';
import { normalizeUrl } from '../netlify/lib/util.js';

function fresh() {
  const gs = loadAppsScript();
  gs.setup();
  return gs;
}
const T = 'secret-token';

test('setup creates both tabs with headers', () => {
  const gs = fresh();
  assert.equal(gs.sheets.Articles.cell(1, 1), 'id');
  assert.equal(gs.sheets.Articles.cell(1, 17), 'last_error');
  assert.equal(gs.sheets.Highlights.cell(1, 2), 'article_id');
});

test('rejects missing or wrong token', () => {
  const gs = fresh();
  assert.equal(gs.get({ what: 'articles' }).ok, false);
  assert.match(gs.get({ token: 'nope', what: 'articles' }).error, /Unauthorized/);
  assert.match(gs.post({ token: 'nope', action: 'add', data: { url: 'https://a.com' } }).error, /Unauthorized/);
});

test('add appends rows, defaults status/type, and returns ids', () => {
  const gs = fresh();
  const r = gs.post({ token: T, action: 'add', data: { title: 'Hello', url: 'https://example.com/a', tags: ['#A', '#B'] } });
  assert.equal(r.ok, true);
  assert.equal(r.data.results[0].duplicate, false);
  const list = gs.get({ token: T, what: 'articles' }).data;
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'Unread');
  assert.equal(list[0].type, 'Article');
  assert.deepEqual(list[0].tags, ['#A', '#B']);
  assert.ok(list[0].id && list[0].date_added);
});

test('add dedupes URLs that differ by www, fragment, slash and tracking params', () => {
  const gs = fresh();
  gs.post({ token: T, action: 'add', data: { url: 'https://www.example.com/p/?utm_source=x#top' } });
  const r = gs.post({ token: T, action: 'add', data: [{ url: 'http://example.com/p' }, { url: 'https://example.com/other' }] });
  assert.equal(r.data.results[0].duplicate, true);
  assert.equal(r.data.results[1].duplicate, false);
  assert.equal(gs.get({ token: T, what: 'articles' }).data.length, 2);
});

test('exists works for one url and for many', () => {
  const gs = fresh();
  gs.post({ token: T, action: 'add', data: { url: 'https://example.com/a' } });
  assert.equal(gs.post({ token: T, action: 'exists', data: { url: 'https://www.example.com/a/' } }).data.exists, true);
  const many = gs.post({ token: T, action: 'exists', data: { urls: ['https://example.com/a', 'https://example.com/zzz'] } }).data.results;
  assert.equal(many['https://example.com/a'].exists, true);
  assert.equal(many['https://example.com/zzz'].exists, false);
});

test('update_status validates and updates the right row', () => {
  const gs = fresh();
  const id = gs.post({ token: T, action: 'add', data: [{ url: 'https://a.com/1' }, { url: 'https://a.com/2' }] }).data.results[1].id;
  assert.match(gs.post({ token: T, action: 'update_status', data: { id, status: 'Bogus' } }).error, /status must be/);
  assert.equal(gs.post({ token: T, action: 'update_status', data: { id, status: 'Finished' } }).ok, true);
  const list = gs.get({ token: T, what: 'articles' }).data;
  assert.equal(list.find((a) => a.id === id).status, 'Finished');
  assert.equal(list.find((a) => a.id !== id).status, 'Unread');
});

test('update_article only touches whitelisted fields', () => {
  const gs = fresh();
  const id = gs.post({ token: T, action: 'add', data: { url: 'https://a.com/1', title: 'T' } }).data.results[0].id;
  gs.post({ token: T, action: 'update_article', data: { id, fields: { category: 'AI', tags: ['#X'], url: 'https://evil.com', id: 'hacked' } } });
  const a = gs.get({ token: T, what: 'articles' }).data[0];
  assert.equal(a.category, 'AI');
  assert.deepEqual(a.tags, ['#X']);
  assert.equal(a.url, 'https://a.com/1');
  assert.equal(a.id, id);
});

test('pending lists unclassified rows and honours the attempt cap', () => {
  const gs = fresh();
  const ids = gs.post({ token: T, action: 'add', data: [{ url: 'https://a.com/1' }, { url: 'https://a.com/2' }, { url: 'https://a.com/3' }] }).data.results.map((r) => r.id);
  gs.post({ token: T, action: 'update_article', data: { id: ids[0], fields: { category: 'Science' } } });
  gs.post({ token: T, action: 'update_article', data: { id: ids[1], fields: { classify_attempts: 5 } } });
  const pending = gs.get({ token: T, what: 'pending', limit: '10' }).data;
  assert.deepEqual(pending.map((p) => p.id), [ids[2]]);
});

test('categories are counted and merge_category renames case-insensitively', () => {
  const gs = fresh();
  const ids = gs.post({ token: T, action: 'add', data: [{ url: 'https://a.com/1', category: 'A.I.' }, { url: 'https://a.com/2', category: 'a.i.' }, { url: 'https://a.com/3', category: 'Science' }] }).data.results.map((r) => r.id);
  assert.equal(gs.get({ token: T, what: 'categories' }).data.length, 3);
  assert.equal(gs.post({ token: T, action: 'merge_category', data: { from: 'a.i.', to: 'AI' } }).data.changed, 2);
  const cats = gs.get({ token: T, what: 'categories' }).data;
  assert.deepEqual(cats[0], { name: 'AI', count: 2 });
  assert.ok(ids.length === 3);
});

test('highlights: insert, newer update wins, stale update is rejected with the server copy', () => {
  const gs = fresh();
  const h = { id: 'h1', article_id: 'a1', quote: 'hello world', prefix: 'say ', suffix: ' now', note: '', color: 'yellow', updated_at: '2026-10-25T10:00:00.000Z' };
  assert.deepEqual(gs.post({ token: T, action: 'upsert_highlights', data: h }).data.applied, ['h1']);

  const newer = { ...h, note: 'good point', updated_at: '2026-10-25T11:00:00.000Z' };
  assert.deepEqual(gs.post({ token: T, action: 'upsert_highlights', data: newer }).data.applied, ['h1']);

  const stale = { ...h, note: 'OLD', updated_at: '2026-10-25T09:00:00.000Z' };
  const r = gs.post({ token: T, action: 'upsert_highlights', data: stale }).data;
  assert.deepEqual(r.applied, []);
  assert.equal(r.conflicts[0].note, 'good point');

  const all = gs.get({ token: T, what: 'highlights' }).data;
  assert.equal(all.length, 1);
  assert.equal(all[0].note, 'good point');
  assert.equal(all[0].deleted, false);
});

test('highlights: soft delete propagates and since= filters', () => {
  const gs = fresh();
  const base = { id: 'h1', article_id: 'a1', quote: 'q', color: 'green' };
  gs.post({ token: T, action: 'upsert_highlights', data: { ...base, updated_at: '2026-10-25T10:00:00.000Z' } });
  gs.post({ token: T, action: 'upsert_highlights', data: { ...base, deleted: true, updated_at: '2026-10-25T12:00:00.000Z' } });
  const all = gs.get({ token: T, what: 'highlights' }).data;
  assert.equal(all[0].deleted, true);
  assert.equal(gs.get({ token: T, what: 'highlights', since: '2026-10-25T11:00:00.000Z' }).data.length, 1);
  assert.equal(gs.get({ token: T, what: 'highlights', since: '2026-10-25T13:00:00.000Z' }).data.length, 0);
});

test('highlights: same id twice in one batch does not crash', () => {
  const gs = fresh();
  const h = { id: 'dup', article_id: 'a1', quote: 'q', updated_at: '2026-10-25T10:00:00.000Z' };
  const r = gs.post({ token: T, action: 'upsert_highlights', data: [h, { ...h, updated_at: '2026-10-25T11:00:00.000Z' }] });
  assert.equal(r.ok, true);
  assert.equal(gs.get({ token: T, what: 'highlights' }).data.length, 1);
});

test('sheet grows past its initial row count when many rows are added', () => {
  const gs = fresh();
  const items = Array.from({ length: 1200 }, (_, i) => ({ url: `https://a.com/${i}` }));
  assert.equal(gs.post({ token: T, action: 'add', data: items }).ok, true);
  assert.equal(gs.get({ token: T, what: 'articles' }).data.length, 1200);
});

test('Code.gs and the Netlify side normalise URLs identically', () => {
  const gs = fresh();
  const urls = [
    'https://www.Example.com/Path/?utm_source=a&b=2&a=1#frag',
    'http://example.com/',
    'https://aeon.co/essays/why-a-world-without-friction-is-a-world-without-progress',
    'https://nautil.us/mother-bats-1286069/',
    'https://arxiv.org/abs/2401.01234?ref=feed',
  ];
  for (const u of urls) assert.equal(gs.normalizeUrl(u), normalizeUrl(u), u);
});
