import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const pub = path.join(import.meta.dirname, '..', 'public');
const read = (p) => fs.readFileSync(path.join(pub, p), 'utf8');

test('service worker caches every app file, and every cached file exists', () => {
  const sw = read('sw.js');
  const listed = [...sw.matchAll(/'(\/[^']*)'/g)].map((m) => m[1]).filter((p) => /\.(js|css|png|svg|html|webmanifest)$/.test(p) || p === '/');
  for (const f of fs.readdirSync(path.join(pub, 'js'))) assert.ok(listed.includes('/js/' + f), `/js/${f} is missing from sw.js SHELL`);
  assert.ok(listed.includes('/css/app.css'));
  for (const p of listed) if (p !== '/') assert.ok(fs.existsSync(path.join(pub, p)), `${p} listed but missing`);
});

test('every import in the app resolves to a real file', () => {
  for (const f of fs.readdirSync(path.join(pub, 'js'))) {
    for (const m of read('js/' + f).matchAll(/from '(\.\/[^']+)'|import\('(\.\/[^']+)'\)/g)) {
      const target = m[1] || m[2];
      assert.ok(fs.existsSync(path.join(pub, 'js', target)), `${f} imports ${target}`);
    }
  }
});

test('manifest: installable, with a share target and real icons', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.display, 'standalone');
  assert.equal(m.share_target.method, 'GET');
  assert.deepEqual(Object.keys(m.share_target.params).sort(), ['text', 'title', 'url']);
  for (const i of m.icons) assert.ok(fs.existsSync(path.join(pub, i.src)), i.src);
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
});

test('index.html: sets the theme before paint, is mobile-ready, loads the app', () => {
  const h = read('index.html');
  assert.match(h, /viewport-fit=cover/);
  assert.match(h, /dataset\.theme/);
  assert.match(h, /type="module" src="\/js\/main\.js"/);
  assert.match(h, /rel="manifest"/);
});

test('reader fills the screen and hides its bar (CSS contract)', () => {
  const css = read('css/app.css');
  assert.match(css, /\.reader\s*\{[^}]*position:\s*fixed;\s*inset:\s*0/);
  assert.match(css, /100dvh/);
  assert.match(css, /\.reader\.immersive \.r-bar/);
  assert.match(css, /:root\[data-theme="dark"\]/);
  assert.match(css, /env\(safe-area-inset-top/);
});

test('deleting a highlight cannot be undone by closing the popup (regression)', () => {
  const r = read('js/reader.js');
  // the popup's close handler may only save pending edits, and never after a delete
  assert.match(r, /removed = true/);
  assert.match(r, /if \(!patch \|\| removed\)/);
  assert.doesNotMatch(r, /save\.flush\(\{\}\)/);
});

test('offline copies: expire 30 days after last opened; no way to remove them by hand', () => {
  const sync = read('js/sync.js');
  assert.match(sync, /OFFLINE_DAYS = 30/);
  assert.match(sync, /openedAt \|\| c\.savedAt/);
  for (const f of ['library.js', 'reader.js', 'settings.js']) {
    const t = read('js/' + f);
    assert.doesNotMatch(t, /Remove offline copy|Clear offline copies/, f);
  }
  assert.match(read('js/library.js'), /Save for offline/, 'saving ahead of time stays');
  assert.match(read('js/main.js'), /purgeExpiredContent\(\)/);
});
