// Word meanings for the reader's "Define" button. Free services, no keys, nothing counts against AI quota.
import { decodeEntities, stripTags } from './util.js';

const UA = 'ReadingLibrary/1.0 (personal reading app)';

export function cleanTerm(raw) {
  const t = String(raw || '')
    .replace(/[“”"‘’`]/g, '')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || t.length > 60 || t.split(' ').length > 4 || !/\p{L}/u.test(t)) return '';
  return t;
}

/** Simple endings to strip when the exact word is not in the dictionary ("climbs", "discovered"). */
function stems(w) {
  const out = [];
  if (/ies$/.test(w)) out.push(w.slice(0, -3) + 'y');
  if (/(es|s)$/.test(w) && !/ss$/.test(w)) out.push(w.replace(/es$/, ''), w.replace(/s$/, ''));
  if (/ed$/.test(w)) out.push(w.slice(0, -2), w.slice(0, -1));
  if (/ing$/.test(w)) out.push(w.slice(0, -3), w.slice(0, -3) + 'e');
  return [...new Set(out)].filter((x) => x.length > 2);
}

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': UA }, signal: AbortSignal.timeout(5000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function fromDictionaryApi(data, term) {
  if (!Array.isArray(data) || !data.length) return null;
  const e = data[0];
  const meanings = [];
  for (const entry of data) {
    for (const m of entry.meanings || []) {
      const defs = (m.definitions || []).slice(0, 3).map((d) => ({ text: d.definition, example: d.example || '' })).filter((d) => d.text);
      if (defs.length) meanings.push({ pos: m.partOfSpeech || '', definitions: defs });
    }
  }
  if (!meanings.length) return null;
  const ph = (e.phonetics || []).find((p) => p.text) || {};
  const audio = (e.phonetics || []).find((p) => p.audio)?.audio || '';
  return { word: e.word || term, phonetic: e.phonetic || ph.text || '', audio, meanings: meanings.slice(0, 4), source: 'Free Dictionary', url: `https://en.wiktionary.org/wiki/${encodeURIComponent(term)}` };
}

function fromWiktionary(data, term) {
  const list = data?.en;
  if (!Array.isArray(list) || !list.length) return null;
  const meanings = list.slice(0, 4).map((m) => ({
    pos: m.partOfSpeech || '',
    definitions: (m.definitions || []).slice(0, 3).map((d) => ({
      text: decodeEntities(stripTags(d.definition || '')).trim(),
      example: decodeEntities(stripTags((d.examples || [])[0] || '')).trim(),
    })).filter((d) => d.text),
  })).filter((m) => m.definitions.length);
  if (!meanings.length) return null;
  return { word: term, phonetic: '', audio: '', meanings, source: 'Wiktionary', url: `https://en.wiktionary.org/wiki/${encodeURIComponent(term)}` };
}

/**
 * @returns {Promise<{ok:true, word, phonetic, audio, meanings:[{pos, definitions:[{text, example}]}], source, url} | {ok:false, notFound?:true, error?:string}>}
 */
export async function defineWord(raw, { fetchImpl = fetch } = {}) {
  const term = cleanTerm(raw);
  if (!term) return { ok: false, notFound: true, error: 'Select a single word or a short phrase.' };
  const lower = term.toLowerCase();
  const tries = [lower, ...(term.includes(' ') ? [] : stems(lower))];
  let failed = false;
  for (const w of tries) {
    try {
      const hit = fromDictionaryApi(await getJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(w)}`, fetchImpl), w);
      if (hit) return { ok: true, ...hit, looked: w !== lower ? w : undefined };
    } catch {
      failed = true;
    }
    try {
      const hit = fromWiktionary(await getJson(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(w)}`, fetchImpl), w);
      if (hit) return { ok: true, ...hit, looked: w !== lower ? w : undefined };
    } catch {
      failed = true;
    }
  }
  return failed
    ? { ok: false, error: 'The dictionary could not be reached. Try again in a moment.' }
    : { ok: false, notFound: true };
}
