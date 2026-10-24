// Shared test helpers: fake fetch responses and an in-memory Apps Script runtime.
import vm from 'node:vm';
import fs from 'node:fs';

export function res(body, { status = 200, headers = {}, url = 'https://example.com/x' } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const h = new Headers(headers);
  if (!h.has('content-type')) h.set('content-type', typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json');
  const r = new Response(text, { status, headers: h });
  Object.defineProperty(r, 'url', { value: url });
  return r;
}

/** fetch stub: routes by substring match, in order; records calls. */
export function fakeFetch(routes) {
  const calls = [];
  const f = async (input, init = {}) => {
    const u = String(input);
    calls.push({ url: u, init });
    for (const [match, handler] of routes) {
      if (u.includes(match)) {
        const out = typeof handler === 'function' ? await handler(u, init, calls.length) : handler;
        return out instanceof Response ? out : res(out);
      }
    }
    return res('not found', { status: 404, url: u });
  };
  f.calls = calls;
  return f;
}

/* ---------- minimal in-memory Apps Script runtime to exercise Code.gs ---------- */

class FakeRange {
  constructor(sheet, r, c, nr, nc) {
    Object.assign(this, { sheet, r, c, nr, nc });
  }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = [];
      for (let j = 0; j < this.nc; j++) row.push(this.sheet.cell(this.r + i, this.c + j));
      out.push(row);
    }
    return out;
  }
  setValues(vals) {
    vals.forEach((row, i) => row.forEach((v, j) => this.sheet.set(this.r + i, this.c + j, v)));
    return this;
  }
  setValue(v) {
    for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sheet.set(this.r + i, this.c + j, v);
    return this;
  }
  setNumberFormat() { return this; }
  setFontWeight() { return this; }
}

class FakeSheet {
  constructor(name) {
    this.name = name;
    this.data = [];
    this.maxRows = 1000;
    this.maxCols = 26;
  }
  cell(r, c) {
    return (this.data[r - 1] && this.data[r - 1][c - 1] !== undefined) ? this.data[r - 1][c - 1] : '';
  }
  set(r, c, v) {
    if (r > this.maxRows) throw new Error('Range out of bounds: row ' + r + ' > ' + this.maxRows);
    while (this.data.length < r) this.data.push([]);
    const row = this.data[r - 1];
    while (row.length < c) row.push('');
    row[c - 1] = v;
  }
  getName() { return this.name; }
  getLastRow() {
    for (let i = this.data.length - 1; i >= 0; i--) if (this.data[i].some((v) => v !== '' && v !== undefined)) return i + 1;
    return 0;
  }
  getLastColumn() {
    let max = 0;
    for (const row of this.data) for (let j = row.length - 1; j >= 0; j--) if (row[j] !== '' && row[j] !== undefined) { max = Math.max(max, j + 1); break; }
    return max;
  }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  insertRowsAfter(_after, n) { this.maxRows += n; }
  getRange(r, c, nr = 1, nc = 1) { return new FakeRange(this, r, c, nr, nc); }
  getDataRange() { return new FakeRange(this, 1, 1, this.getLastRow(), this.getLastColumn()); }
  setFrozenRows() {}
}

export function loadAppsScript(path = new URL('../apps-script/Code.gs', import.meta.url)) {
  const code = fs.readFileSync(path, 'utf8');
  const sheets = {};
  const props = { API_TOKEN: 'secret-token' };
  let n = 0;
  const ss = {
    getSheetByName: (name) => sheets[name] || null,
    insertSheet: (name) => (sheets[name] = new FakeSheet(name)),
  };
  const sandbox = {
    console,
    Logger: { log() {} },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => props[k] ?? null,
        setProperty: (k, v) => { props[k] = v; },
      }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (s) => ({ text: s, setMimeType() { return this; } }),
    },
    Utilities: { getUuid: () => `${String(++n).padStart(8, '0')}-aaaa-4000-8000-${String(n * 7919).padStart(12, '0')}` },
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  const call = (fn, arg) => JSON.parse(vm.runInContext(`(${fn.toString()})`, sandbox)(arg).text);
  return {
    sandbox,
    sheets,
    setup: () => vm.runInContext('setup()', sandbox),
    get: (params) => { sandbox.__p = params; return JSON.parse(vm.runInContext('doGet({parameter: __p}).text', sandbox)); },
    post: (body) => { sandbox.__b = JSON.stringify(body); return JSON.parse(vm.runInContext('doPost({postData:{contents: __b}}).text', sandbox)); },
    normalizeUrl: (u) => { sandbox.__u = u; return vm.runInContext('normalizeUrl_(__u)', sandbox); },
    call,
  };
}
