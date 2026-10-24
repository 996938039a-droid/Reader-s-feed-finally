// Thin client for the Apps Script web app in Code.gs.
// Apps Script answers POSTs with a redirect; fetch follows it automatically.

export function createSheet({ url, token, fetchImpl = fetch, timeoutMs = 25000 }) {
  if (!url || !token) throw new Error('APPS_SCRIPT_URL / APPS_SCRIPT_TOKEN are not set.');

  async function parse(res) {
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(
        'The Sheet API did not return JSON (HTTP ' +
          res.status +
          '). Check that the Apps Script deployment is set to "Anyone" and that the URL ends in /exec.'
      );
    }
    if (!body.ok) throw new Error('Sheet API: ' + (body.error || 'unknown error'));
    return body;
  }

  async function get(what, params = {}) {
    const u = new URL(url);
    u.searchParams.set('token', token);
    u.searchParams.set('what', what);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
    const res = await fetchImpl(u.href, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    return (await parse(res)).data;
  }

  async function post(action, data) {
    const res = await fetchImpl(url, {
      method: 'POST',
      redirect: 'follow',
      // text/plain avoids a CORS preflight, which Apps Script cannot answer.
      headers: { 'content-type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token, action, data }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return (await parse(res)).data;
  }

  return {
    articles: () => get('articles'),
    pending: (limit = 3) => get('pending', { limit: String(limit) }),
    categories: () => get('categories'),
    highlights: (since) => get('highlights', { since }),
    add: (items) => post('add', items),
    exists: (urls) => post('exists', { urls }),
    updateArticle: (items) => post('update_article', items),
    updateStatus: (id, status) => post('update_status', { id, status }),
    upsertHighlights: (items) => post('upsert_highlights', items),
    mergeCategory: (from, to) => post('merge_category', { from, to }),
    ping: () => post('ping', {}),
  };
}
