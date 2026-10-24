import { FORMATS, buildBatchPrompt, matchResults, parseModelJson } from './classify-common.js';
import { sleep } from './util.js';

export { FORMATS };

const API = 'https://generativelanguage.googleapis.com/v1beta';

const ITEM_SCHEMA = {
  type: 'OBJECT',
  properties: {
    id: { type: 'STRING' },
    title: { type: 'STRING' },
    category: { type: 'STRING' },
    tags: { type: 'ARRAY', items: { type: 'STRING' } },
    format: { type: 'STRING', enum: FORMATS },
    tldr: { type: 'STRING' },
    author: { type: 'STRING' },
  },
  required: ['id', 'category', 'tags', 'format', 'tldr', 'author'],
};
const BATCH_SCHEMA = {
  type: 'OBJECT',
  properties: { items: { type: 'ARRAY', items: ITEM_SCHEMA } },
  required: ['items'],
};

export class RateLimitError extends Error {
  constructor(message, { daily = false } = {}) {
    super(message);
    this.name = 'RateLimitError';
    this.daily = daily;
  }
}

/** Parse "retryDelay": "12s" (Google error details) or a Retry-After header into ms. */
function retryDelayMs(res, bodyText) {
  const header = Number(res.headers?.get?.('retry-after'));
  if (Number.isFinite(header) && header > 0) return header * 1000;
  const m = String(bodyText).match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : 0;
}

/** "Please retry in 8h43m54.2s" -> milliseconds (0 if absent). */
export function parseRetryIn(message) {
  const m = String(message).match(/retry in\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:([\d.]+)s)?/i);
  if (!m || (!m[1] && !m[2] && !m[3])) return 0;
  return Math.ceil(((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (parseFloat(m[3]) || 0)) * 1000);
}

/**
 * Usable general-purpose Flash models from a ListModels result, best first.
 * `preferLite`: for bulk sorting, put Flash-Lite ahead of full Flash (bigger free quota, plenty smart enough).
 */
export function rankFlashModels(models, { preferLite = false } = {}) {
  const bad = /(image|tts|live|audio|native|robotics|computer|embedding|aqa|learnlm|gemma)/i;
  const usable = (models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => String(m.name || '').replace(/^models\//, ''))
    .filter((n) => /flash/i.test(n) && !bad.test(n));
  const score = (n) => {
    const v = n.match(/(\d+(?:\.\d+)?)/);
    const lite = /lite/i.test(n);
    return {
      version: v ? parseFloat(v[1]) : 0,
      stable: /preview|exp|thinking/i.test(n) ? 0 : 1,
      tier: preferLite ? (lite ? 1 : 0) : lite ? 0 : 1,
      alias: /latest/i.test(n) ? 0 : 1,
    };
  };
  usable.sort((a, b) => {
    const x = score(a);
    const y = score(b);
    // Stable beats preview/experimental. With preferLite the tier decides before the version number.
    const order = preferLite ? y.tier - x.tier || y.version - x.version : y.version - x.version || y.tier - x.tier;
    return y.stable - x.stable || order || y.alias - x.alias;
  });
  return usable;
}

/** The single best Flash model (or null). */
export function pickFlashModel(models, opts) {
  return rankFlashModels(models, opts)[0] || null;
}

/** Google's human-readable error message from a failed response body. */
export function googleErrorMessage(text) {
  try {
    return JSON.parse(text).error?.message || String(text).slice(0, 300);
  } catch {
    return String(text).slice(0, 300);
  }
}

// Models whose daily quota is used up, shared by warm function instances: model -> epoch ms when it resets.
const SHARED_EXHAUSTED = new Map();

export function createGemini({
  apiKey,
  model,
  delayMs = 4500,
  fetchImpl = fetch,
  sleepImpl = sleep,
  now = Date.now,
  log = () => {},
  requestTimeoutMs = 20000,
  exhausted = SHARED_EXHAUSTED,
}) {
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set.');
  const state = { model, lastCallAt: 0, chain: Promise.resolve(), tried: new Set([model]) };

  // Serialise every call and keep at least `delayMs` between starts (free-tier RPM cap).
  function paced(fn) {
    const run = state.chain.then(async () => {
      const wait = state.lastCallAt + delayMs - now();
      if (wait > 0) await sleepImpl(wait);
      try {
        return await fn();
      } finally {
        state.lastCallAt = now();
      }
    });
    state.chain = run.catch(() => {});
    return run;
  }

  async function rawCall(modelName, body) {
    return fetchImpl(`${API}/models/${modelName}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  }

  async function listModels() {
    const res = await fetchImpl(`${API}/models?pageSize=200`, {
      headers: { 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!res.ok) throw new Error(`Listing Gemini models failed (HTTP ${res.status}).`);
    return (await res.json()).models || [];
  }

  const isExhausted = (m) => (exhausted.get(m) || 0) > now();

  /** Next model (Flash-Lite first) that has not been tried and still has quota; null if none. */
  async function nextModel() {
    try {
      const ranked = rankFlashModels(await listModels(), { preferLite: true });
      return ranked.find((m) => !state.tried.has(m) && !isExhausted(m)) || null;
    } catch {
      return null;
    }
  }

  /**
   * One generateContent call with retries.
   * - Free quota used up for a model (daily limit, or "limit: 0"): remember it, move to the next
   *   Flash model (each model has its own quota). Only when none are left, give up for today.
   * - HTTP 429/503 otherwise: exponential backoff (5s, 10s, 20s), up to 3 retries.
   * - Unknown model: list your models, switch to a current Flash model, try once more.
   * @param {object} body request body
   * @param {number} [deadline] epoch ms; if a retry could not finish before it, give up early
   */
  async function generate(body, { deadline } = {}) {
    let switchedMissing = false;
    let switches = 0;
    let attempt = 0;
    for (;;) {
      if (isExhausted(state.model)) {
        const next = switches < 4 ? await nextModel() : null;
        if (!next) {
          throw new RateLimitError(
            `Free quota is used up on every Gemini model tried (${[...state.tried].join(', ')}).`,
            { daily: true }
          );
        }
        switches++;
        state.tried.add(next);
        log(`Gemini "${state.model}" is out of free quota; using "${next}".`);
        state.model = next;
      }

      const res = await paced(() => rawCall(state.model, body));
      if (res.ok) return res.json();

      const text = await res.text().catch(() => '');
      const detail = googleErrorMessage(text);

      if ((res.status === 404 || res.status === 400) && /not found|not supported|no longer available/i.test(text) && !switchedMissing) {
        switchedMissing = true;
        const picked = pickFlashModel(await listModels(), { preferLite: true });
        if (!picked || picked === state.model) throw new Error(`Gemini model "${state.model}" is unavailable and no replacement was found.`);
        log(`Gemini model "${state.model}" unavailable; switching to "${picked}".`);
        state.tried.add(picked);
        state.model = picked;
        continue;
      }

      if (res.status === 429 || res.status === 503) {
        const noQuota = /limit:\s*0\b/i.test(detail);
        const daily = /PerDay|per day|daily/i.test(text);
        if (noQuota || daily) {
          // Waiting will not help; this model is done for today. The loop top picks the next one.
          exhausted.set(state.model, now() + (parseRetryIn(detail) || 6 * 3600 * 1000));
          if (switches >= 4) {
            throw new RateLimitError(`Gemini free quota used up. Google says: ${detail}`, { daily: true });
          }
          continue;
        }
        if (attempt >= 3) throw new RateLimitError(`Gemini keeps rate limiting (HTTP ${res.status}) on "${state.model}". Google says: ${detail}`);
        const wait = Math.max(retryDelayMs(res, text), 5000 * 2 ** attempt);
        if (deadline && now() + wait + 3000 > deadline) {
          throw new RateLimitError(`Gemini HTTP ${res.status} on "${state.model}" and no time left to retry. Google says: ${detail}`);
        }
        attempt++;
        log(`Gemini HTTP ${res.status}; retry ${attempt}/3 in ${Math.round(wait / 1000)}s.`);
        await sleepImpl(wait);
        continue;
      }

      throw new Error(`Gemini HTTP ${res.status}: ${detail || 'request failed'}`);
    }
  }

  /**
   * Classify several articles in ONE request (the free tier counts requests, not articles).
   * @param {{id:string,url?:string,title?:string,author?:string,text?:string,pdfBase64?:string}[]} items
   * @returns {Promise<{id:string, ok:boolean, result?:object, error?:string}[]>} aligned with `items`
   */
  async function classifyBatch(items, { existingCategories = [], deadline } = {}) {
    const parts = [];
    for (const it of items) {
      if (it.pdfBase64) parts.push({ inlineData: { mimeType: 'application/pdf', data: it.pdfBase64 } });
    }
    parts.push({ text: buildBatchPrompt({ items, existingCategories }) });

    const data = await generate(
      {
        contents: [{ role: 'user', parts }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: Math.min(8192, 600 * items.length + 1500),
          responseMimeType: 'application/json',
          responseSchema: BATCH_SCHEMA,
        },
      },
      { deadline }
    );

    const outText = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    if (!outText) {
      const reason = data.promptFeedback?.blockReason || data.candidates?.[0]?.finishReason || 'empty response';
      throw new Error(`Gemini returned no content (${reason}).`);
    }
    return matchResults(parseModelJson(outText), items, existingCategories);
  }

  /** Classify a single article/PDF. Throws if the model does not answer for it. */
  async function classify(item, opts = {}) {
    const [r] = await classifyBatch([{ id: '1', ...item }], { existingCategories: item.existingCategories || [], ...opts });
    if (!r.ok) throw new Error(r.error);
    return r.result;
  }

  /** One tiny, unretried call that reports exactly what Google answers. For the setup page. */
  async function ping() {
    const res = await rawCall(state.model, {
      contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ready' }] }],
      generationConfig: { maxOutputTokens: 20 },
    });
    const text = await res.text().catch(() => '');
    return {
      ok: res.ok,
      status: res.status,
      model: state.model,
      message: res.ok ? 'Gemini answered.' : googleErrorMessage(text),
    };
  }

  return { name: 'gemini', supportsPdf: true, classify, classifyBatch, generate, listModels, ping, state };
}
