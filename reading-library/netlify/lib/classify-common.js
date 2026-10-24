// Shared by every AI provider: the prompt, the expected JSON shape, and tidy-up of the answers.
import { canonicalCategory, normalizeTags } from './categories.js';

export const FORMATS = ['Longform Essay', 'Whitepaper', 'Research Paper', 'Op-Ed', 'Other'];

/** Characters of article text sent per article. Batching keeps requests small. */
export const TEXT_PER_ITEM = 2500;

export function buildBatchPrompt({ items, existingCategories = [] }) {
  const cats = existingCategories.slice(0, 40);
  const head = [
    'You are a careful librarian filing long-form reading into a personal library.',
    `Classify EACH of the ${items.length} article(s) below. Return ONLY JSON of the form {"items":[...]} with exactly one object per article, copying its "id" unchanged.`,
    'Rules for every object:',
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
  ];
  const body = items.map((it) => {
    const lines = [`=== ARTICLE id=${it.id} ===`, `URL: ${it.url || '(unknown)'}`];
    if (it.title) lines.push(`Known title: ${it.title}`);
    if (it.author) lines.push(`Known author: ${it.author}`);
    if (it.pdfBase64) lines.push('The document is attached as a PDF.');
    else if (it.text) lines.push('TEXT:\n' + String(it.text).slice(0, TEXT_PER_ITEM));
    else
      lines.push(
        'Only the title is available (the page could not be loaded). Keep the tldr to one cautious sentence based on the title and do not invent specifics.'
      );
    return lines.join('\n');
  });
  return head.concat(body).join('\n');
}

/** Parse a model's JSON text (tolerates ```json fences). Throws a clear error otherwise. */
export function parseModelJson(text) {
  const cleaned = String(text || '').replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error('The AI returned invalid JSON.');
  }
}

export function normalizeResult(raw, existingCategories = []) {
  return {
    title: String(raw?.title || '').trim(),
    category: canonicalCategory(raw?.category, existingCategories),
    tags: normalizeTags(raw?.tags),
    format: FORMATS.includes(raw?.format) ? raw.format : 'Other',
    tldr: String(raw?.tldr || '').replace(/\s+/g, ' ').trim().slice(0, 700),
    author: String(raw?.author || '').trim().slice(0, 200),
  };
}

/**
 * Line the model's answers up with the articles we sent.
 * Matches by id; if ids are missing but the counts agree, falls back to order.
 * Categories invented earlier in the same batch are reused by later items.
 * @returns {{id:string, ok:boolean, result?:object, error?:string}[]}
 */
export function matchResults(parsed, items, existingCategories = []) {
  let list = Array.isArray(parsed?.items) ? parsed.items : Array.isArray(parsed) ? parsed : parsed && parsed.category ? [parsed] : [];
  const byId = new Map(list.filter((r) => r && r.id !== undefined).map((r) => [String(r.id), r]));
  const known = [...existingCategories];
  return items.map((item, i) => {
    const raw = byId.get(String(item.id)) || (byId.size === 0 && list.length === items.length ? list[i] : undefined);
    if (!raw || !raw.category) return { id: item.id, ok: false, error: 'The AI skipped this article.' };
    const result = normalizeResult(raw, known);
    if (result.category && !known.includes(result.category)) known.push(result.category);
    return { id: item.id, ok: true, result };
  });
}
