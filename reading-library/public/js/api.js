// Talks to the Netlify API. The passphrase is kept on this device and sent in a header.
export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
const KEY = 'rl_pass';
export const getPass = () => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } };
export const setPass = (v) => { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch { /* ignore */ } };

async function call(method, path, body, query) {
  const qs = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== '')).toString() : '';
  let res;
  try {
    res = await fetch('/api/' + path + qs, {
      method,
      headers: { 'x-passphrase': getPass(), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('You appear to be offline.', 0);
  }
  let data = null;
  try { data = await res.json(); } catch { /* not json */ }
  if (!res.ok) throw new ApiError(data?.error || 'Request failed (HTTP ' + res.status + ')', res.status);
  return data;
}

export const api = {
  auth: () => call('GET', 'auth'),
  library: () => call('GET', 'library'),
  addUrl: (url) => call('POST', 'articles', { url }),
  update: (id, fields) => call('POST', 'articles/update', { id, fields }),
  mergeCategory: (from, to) => call('POST', 'categories/merge', { from, to }),
  highlights: (since) => call('GET', 'highlights', null, { since }),
  pushHighlights: (items) => call('POST', 'highlights', { items }),
  extract: (url) => call('GET', 'extract', null, { url }),
};
