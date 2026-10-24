// Keeps AI-chosen categories and tags tidy so "AI", "A.I." and "Artificial Intelligence"
// don't become three different shelves.

const ALIASES = {
  'artificial intelligence': 'ai',
  'a i': 'ai',
  ai: 'ai',
  'geo politic': 'geopolitic',
  'international relation': 'geopolitic',
  'international affair': 'geopolitic',
};

const SMALL_WORDS = new Set(['and', 'of', 'the', 'in', 'on', 'for', 'to', 'a', 'an']);

/** Comparison key: lowercase, no punctuation, naive singularising, alias-folded. */
export function categoryKey(raw) {
  let s = String(raw || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  s = s
    .split(' ')
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .join(' ');
  return ALIASES[s] || s;
}

function editDistance(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 1) return 2;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[a.length][b.length];
}

export function tidyCategory(raw) {
  const cleaned = String(raw || '')
    .replace(/["'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.;:,!?]+$/g, '')
    .trim()
    .slice(0, 40);
  if (!cleaned) return '';
  if (/^[A-Z0-9&. ]{1,5}$/.test(cleaned)) return cleaned.replace(/\./g, '').trim(); // "AI", "A.I."
  return cleaned
    .split(' ')
    .map((w, i) => {
      if (w === '&') return w;
      if (/^[A-Z0-9]{2,5}$/.test(w)) return w; // acronyms
      const lower = w.toLowerCase();
      if (i > 0 && SMALL_WORDS.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

/**
 * Map a model-suggested category onto an existing one when they mean the same thing;
 * otherwise return a tidied new name.
 * @param {string} raw
 * @param {string[]} existing display names already in the Sheet
 */
export function canonicalCategory(raw, existing = []) {
  const key = categoryKey(raw);
  if (!key) return '';
  for (const name of existing) if (categoryKey(name) === key) return name;
  if (key.length >= 6) {
    for (const name of existing) {
      const k = categoryKey(name);
      if (k.length >= 6 && editDistance(k, key) <= 1) return name;
    }
  }
  return tidyCategory(raw);
}

/** "#some tag", "Some Tag", "#some-tag" -> "#SomeTag". Dedupes, caps at 5. */
export function normalizeTags(tags, max = 5) {
  const seen = new Set();
  const out = [];
  for (const t of Array.isArray(tags) ? tags : []) {
    const words = String(t || '')
      .replace(/^#+/, '')
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean);
    if (!words.length) continue;
    const tag =
      '#' +
      words
        .map((w) => (/^[A-Z0-9]{2,}$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
        .join('');
    const k = tag.toLowerCase();
    if (seen.has(k) || tag.length > 40) continue;
    seen.add(k);
    out.push(tag);
    if (out.length >= max) break;
  }
  return out;
}
