// Backup AI provider for any "OpenAI-compatible" chat API (Groq, Cerebras, Mistral, OpenRouter, ...),
// plus the chain that tries providers in order when one is out of free quota.
import { buildBatchPrompt, matchResults, parseModelJson } from './classify-common.js';
import { RateLimitError, googleErrorMessage } from './gemini.js';
import { sleep } from './util.js';

export function createOpenAICompat({
  baseUrl,
  apiKey,
  model,
  name = 'backup',
  delayMs = 2500,
  fetchImpl = fetch,
  sleepImpl = sleep,
  now = Date.now,
  log = () => {},
  requestTimeoutMs = 25000,
}) {
  if (!baseUrl || !apiKey || !model) throw new Error('Backup provider needs a base URL, key and model.');
  const base = baseUrl.replace(/\/+$/, '');
  const state = { lastCallAt: 0, jsonMode: true };

  async function post(body) {
    const wait = state.lastCallAt + delayMs - now();
    if (wait > 0) await sleepImpl(wait);
    try {
      return await fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } finally {
      state.lastCallAt = now();
    }
  }

  /** Same contract as the Gemini provider: one request, many articles, aligned results. */
  async function classifyBatch(items, { existingCategories = [], deadline } = {}) {
    const pdfs = items.filter((i) => i.pdfBase64);
    if (pdfs.length) throw new Error('The backup provider cannot read PDFs.');
    const prompt = buildBatchPrompt({ items, existingCategories });
    let attempt = 0;
    for (;;) {
      const body = {
        model,
        temperature: 0.2,
        max_tokens: Math.min(8000, 600 * items.length + 1000),
        messages: [
          { role: 'system', content: 'You are a precise assistant. Reply with a single JSON object and nothing else.' },
          { role: 'user', content: prompt + '\n\nRespond with JSON only.' },
        ],
        ...(state.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      };
      const res = await post(body);

      if (res.ok) {
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content;
        if (!text) throw new Error(`${name} returned no content (${data.choices?.[0]?.finish_reason || 'empty'}).`);
        return matchResults(parseModelJson(text), items, existingCategories);
      }

      const text = await res.text().catch(() => '');
      const detail = googleErrorMessage(text);

      // Some providers/models reject JSON mode: retry once without it.
      if (res.status === 400 && state.jsonMode && /response_format|json/i.test(detail)) {
        state.jsonMode = false;
        continue;
      }
      if (res.status === 429 || res.status === 503) {
        if (/per day|daily|quota|tokens per day/i.test(detail)) {
          throw new RateLimitError(`${name} daily limit reached. It says: ${detail}`, { daily: true });
        }
        const header = Number(res.headers?.get?.('retry-after'));
        const wait = Math.max(Number.isFinite(header) ? header * 1000 : 0, 4000 * 2 ** attempt);
        if (attempt >= 2 || (deadline && now() + wait + 3000 > deadline)) {
          throw new RateLimitError(`${name} is rate limiting. It says: ${detail}`);
        }
        attempt++;
        log(`${name} HTTP ${res.status}; retry ${attempt}/2 in ${Math.round(wait / 1000)}s.`);
        await sleepImpl(wait);
        continue;
      }
      throw new Error(`${name} HTTP ${res.status}: ${detail || 'request failed'}`);
    }
  }

  async function classify(item, opts = {}) {
    const [r] = await classifyBatch([{ id: '1', ...item }], { existingCategories: item.existingCategories || [], ...opts });
    if (!r.ok) throw new Error(r.error);
    return r.result;
  }

  return { name, supportsPdf: false, classify, classifyBatch, state, model };
}

/**
 * Try providers in order. A provider that is rate limited or out of quota is skipped for the next one;
 * any other error is a real failure and is thrown straight away.
 */
export function createClassifier(providers, { log = () => {} } = {}) {
  async function run(method, args, { needsPdf = false } = {}) {
    let last;
    for (const p of providers) {
      if (needsPdf && !p.supportsPdf) continue;
      try {
        return await p[method](...args);
      } catch (err) {
        if (err instanceof RateLimitError) {
          last = err;
          log(`${p.name}: ${err.message} Trying the next provider.`);
          continue;
        }
        throw err;
      }
    }
    throw last || new RateLimitError('No AI provider is available for this request.');
  }
  return {
    providers,
    classifyBatch: (items, opts) => run('classifyBatch', [items, opts], { needsPdf: items.some((i) => i.pdfBase64) }),
    classify: (item, opts) => run('classify', [item, opts], { needsPdf: !!item.pdfBase64 }),
  };
}
