import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../public/setup.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

/** Run the page script against fake DOM/fetch; `replies` is the sequence of /api/process answers. */
async function run(replies, { stopAfter } = {}) {
  const els = {};
  const el = (id) => (els[id] ||= { id, value: 'pw', textContent: '', disabled: false, onclick: null });
  let calls = 0;
  const sandbox = {
    document: { getElementById: el },
    localStorage: { getItem: () => 'pw', setItem() {} },
    setTimeout: (fn) => { fn(); return 0; },
    fetch: async () => {
      const r = replies[Math.min(calls++, replies.length - 1)];
      if (r === 'network') throw new Error('offline');
      return { ok: r.status ? r.status < 400 : true, status: r.status || 200, json: async () => r.body ?? r };
    },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  const p = els.all.onclick();
  if (stopAfter) els.stop.onclick();
  await p;
  return { out: els.out.textContent, calls, allDisabled: els.all.disabled, stopDisabled: els.stop.disabled };
}

test('setup page: works through the queue and stops when caught up', async () => {
  const r = await run([
    { ok: true, processed: 1, failed: 0, remaining: 25, stopped: '' },
    { ok: true, processed: 1, failed: 0, remaining: 25, stopped: '' },
    { ok: true, processed: 1, failed: 0, remaining: 1, stopped: '' },
    { ok: true, processed: 0, failed: 0, remaining: 0, stopped: '' },
  ]);
  assert.equal(r.calls, 4);
  assert.match(r.out, /Classified 3, failed 0/);
  assert.match(r.out, /All caught up/);
  assert.equal(r.allDisabled, false, 'button is usable again');
  assert.equal(r.stopDisabled, true);
});

test('setup page: pauses on a rate limit, then carries on', async () => {
  const r = await run([
    { ok: true, processed: 0, failed: 0, remaining: 5, stopped: 'rate limited' },
    { ok: true, processed: 1, failed: 0, remaining: 4, stopped: '' },
    { ok: true, processed: 0, failed: 0, remaining: 0, stopped: '' },
  ]);
  assert.match(r.out, /Pausing 30 seconds/);
  assert.match(r.out, /Classified 1/);
  assert.match(r.out, /All caught up/);
});

test('setup page: gives up after repeated rate limits and shows Google\'s reason', async () => {
  const r = await run([{ ok: true, processed: 0, failed: 0, remaining: 5, stopped: 'rate limited', detail: 'limit: 0' }]);
  assert.match(r.out, /keeps pushing back: limit: 0/);
  assert.equal(r.calls, 6);
});

test('setup page: stops cleanly for the daily quota', async () => {
  const r = await run([{ ok: true, processed: 0, failed: 0, remaining: 9, stopped: 'daily Gemini quota reached' }]);
  assert.match(r.out, /daily free quota/);
  assert.equal(r.calls, 1);
});

test('setup page: retries network/server errors a few times, then stops with advice', async () => {
  const net = await run(['network']);
  assert.equal(net.calls, 4);
  assert.match(net.out, /repeated errors/);
  const srv = await run([{ status: 504, body: { error: 'Timeout' } }]);
  assert.match(srv.out, /HTTP 504 – Timeout/);
});

test('setup page: recovers from one hiccup', async () => {
  const r = await run(['network', { ok: true, processed: 1, failed: 0, remaining: 0, stopped: '' }, { ok: true, processed: 0, failed: 0, remaining: 0, stopped: '' }]);
  assert.match(r.out, /Classified 1/);
  assert.match(r.out, /All caught up/);
});

test('setup page: will not spin forever if nothing moves', async () => {
  const r = await run([{ ok: true, processed: 0, failed: 0, remaining: 7, stopped: '' }]);
  assert.equal(r.calls, 3);
  assert.match(r.out, /Nothing is moving/);
});

test('setup page: Stop button halts the loop', async () => {
  const r = await run([{ ok: true, processed: 1, failed: 0, remaining: 20, stopped: '' }], { stopAfter: true });
  assert.match(r.out, /Stopped/);
  assert.ok(r.calls <= 1);
});
