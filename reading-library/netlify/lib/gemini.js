import { canonicalCategory, normalizeTags } from './categories.js';
import { sleep } from './util.js';

const API = 'https://generativelanguage.googleapis.com/v1beta';

export const FORMATS = ['Longform Essay', 'Whitepaper', 'Research Paper', 'Op-Ed', 'Other'];

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    category: { type: 'STRING' },
    tags: { type: 'ARRAY', items: { type: 'STRING' } },
    format: { type: 'STRING', enum: FORMATS },
    tldr: { type: 'STRING' },
    author: { type: 'STRING' },
  },
  required: ['category', 'tags', 'format', 'tldr', 'author'],
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

/** Usable general-purpose Flash models from a ListModels result, best first. */
export function rankFlashModels(models) {
  const bad = /(image|tts|live|audio|native|robotics|computer|embedding|aqa|learnlm|gemma)/i;
  const usable = (models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => String(m.name || '').replace(/^models\//, ''))
    .filter((n) => /flash/i.test(n) && !bad.test(n));
  const score = (n) => {
    const v = n.match(/(\d+(?:\.\d+)?)/);
    return {
      version: v ? parseFloat(v[1]) : 0,
      stable: /preview|exp|thinking/i.test(n) ? 0 : 1,
      full: /lite/i.test(n) ? 0 : 1,
      alias: /latest/i.test(n) ? 0 : 1,
    };
  };
  usable.sort((a, b) => {
    const x = score(a);
    const y = score(b);
    // Stable beats preview/experimental, then newest version, then full Flash over Lite.
    return (
      y.stable - x.stable || y.version - x.version || y.full - x.full || y.alias - x.alias
    );
  });
  return usable;
}

/** The single best Flash model (or null). */
export function pickFlashModel(models) {
  return rankFlashModels(models)[0] || null;
}

/** Google's human-readable error message from a failed response body. */
export function googleErrorMessage(text) {
  try {
    return JSON.parse(text).error?.message || String(text).slice(0, 300);
  } catch {
    return String(text).slice(0, 300);
  }
}

export function buildPrompt({ url, title, author, text, existingCategories, hasPdf }) {
  const cats = (existingCategories || []).slice(0, 40);
  return [
    'You are a careful librarian filing long-form reading into a personal library.',
    'Return JSON that matches the schema. Rules:',
    '- category: ONE broad subject label of 1-3 words (for example "Economics", "History", "AI").',
    cats.length
      ? `  Existing categories: ${cats.join(' | ')}. Reuse one of these whenever it reasonably fits. Only invent a new category when none fit, and keep any new one broad rather than narrow.`
      : '  There are no categories yet, so choose a sensible broad one.',
    '- tags: 3 to 5 specific topical tags, each starting with # in CamelCase with no spaces (for example #CentralBanking).',
    `- format: exactly one of ${FORMATS.join(' | ')}.`,
    '- tldr: 2 to 3 sentences giving the core thesis or finding in plain language. Do not begin with "This article".',
    '- author: the author name(s) if stated, otherwise the publication name.',
    '- title: the exact title of the work.',
    '',
    `URL: ${url || '(unknown)'}`,
    title ? `Known title: ${title}` : '',
    author ? `Known author: ${author}` : '',
    !hasPdf && !text
      ? 'Only the title is available (the page could not be loaded). Keep the tldr to one cautious sentence based on the title and do not invent specifics.'
      : '',
    hasPdf ? 'The document is attached as a PDF.' : '--- TEXT BEGINS ---\n' + (text || '(no text available)'),
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export function createGemini({
  apiKey,
  model,
  delayMs = 4500,
  fetchImpl = fetch,
  sleepImpl = sleep,
  now = Date.now,
  log = () => {},
  requestTimeoutMs = 15000,
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

  /**
   * One generateContent call with retries.
   * - HTTP 429/503: exponential backoff (5s, 10s, 20s), up to 3 retries.
   * - Unknown model: list your models, switch to a current Flash model, try once more.
   * @param {object} body request body
   * @param {number} [deadline] epoch ms; if a retry could not finish before it, give up early
   */
  async function generate(body, { deadline } = {}) {
    let switched = false;
    let switches = 0;
    let attempt = 0;
    for (;;) {
      const res = await paced(() => rawCall(state.model, body));
      if (res.ok) return res.json();

      const text = await res.text().catch(() => '');

      if ((res.status === 404 || res.status === 400) && /not found|not supported|no longer available/i.test(text) && !switched) {
        switched = true;
        const picked = pickFlashModel(await listModels());
        if (!picked || picked === state.model) throw new Error(`Gemini model "${state.model}" is unavailable and no replacement was found.`);
        log(`Gemini model "${state.model}" unavailable; switching to "${picked}".`);
        state.model = picked;
        continue;
      }

      if (res.status === 429 || res.status === 503) {
        const detail = googleErrorMessage(text);

        // "limit: 0" means this model has NO free-tier quota on your project at all.
        // Waiting never helps, so move on to the next Flash model your key can use.
        if (/limit:\s*0\b/i.test(detail) && switches < 3) {
          switches++;
          const next = rankFlashModels(await listModels()).find((m) => !state.tried.has(m));
          if (next) {
            log(`Gemini model "${state.model}" has no free quota (${detail.slice(0, 120)}); trying "${next}".`);
            state.tried.add(next);
            state.model = next;
            continue;
          }
          throw new RateLimitError(`No free-tier quota on any available model. Google says: ${detail}`, { daily: true });
        }

        const daily = /PerDay|per day|daily/i.test(text);
        if (daily) throw new RateLimitError(`Gemini daily free-tier quota reached. Google says: ${detail}`, { daily: true });
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

      const msg = (() => {
        try {
          return JSON.parse(text).error?.message;
        } catch {
          return text.slice(0, 200);
        }
      })();
      throw new Error(`Gemini HTTP ${res.status}: ${msg || 'request failed'}`);
    }
  }

  /**
   * Classify an article, abstract, or PDF.
   * @returns {{title,category,tags,format,tldr,author}}
   */
  async function classify(
    { url, title, author, text, pdfBase64, existingCategories = [] },
    opts = {}
  ) {
    const prompt = buildPrompt({ url, title, author, text: (text || '').slice(0, 12000), existingCategories, hasPdf: !!pdfBase64 });
    const parts = pdfBase64
      ? [{ inlineData: { mimeType: 'application/pdf', data: pdfBase64 } }, { text: prompt }]
      : [{ text: prompt }];
    const data = await generate(
      {
        contents: [{ role: 'user', parts }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 1024,
          responseMimeType: 'application/json',
          responseSchema: SCHEMA,
        },
      },
      opts
    );

    const outText = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    if (!outText) {
      const reason = data.promptFeedback?.blockReason || data.candidates?.[0]?.finishReason || 'empty response';
      throw new Error(`Gemini returned no content (${reason}).`);
    }
    let parsed;
    try {
      parsed = JSON.parse(outText.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    } catch {
      throw new Error('Gemini returned invalid JSON.');
    }

    return {
      title: String(parsed.title || '').trim(),
      category: canonicalCategory(parsed.category, existingCategories),
      tags: normalizeTags(parsed.tags),
      format: FORMATS.includes(parsed.format) ? parsed.format : 'Other',
      tldr: String(parsed.tldr || '').replace(/\s+/g, ' ').trim().slice(0, 700),
      author: String(parsed.author || '').trim().slice(0, 200),
    };
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

  return { classify, generate, listModels, ping, state };
}
