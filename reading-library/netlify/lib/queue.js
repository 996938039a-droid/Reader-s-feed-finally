import { RateLimitError } from './gemini.js';
import { friendlyError, materialForClassification } from './extract.js';
import { loadSources } from './feeds.js';

/** Marker text in last_error that tells the app to show the reading time as low confidence. */
export const READING_TIME_NOTE = 'Reading time may be off (the page text looked short).';

export const SHORT_NOTE = 'Short piece, archived automatically (this source is set to long reads only).';

function fieldsFor(item, material, result, source) {
  const fields = {
    category: result.category || 'Uncategorised',
    tags: result.tags,
    format: result.format,
    tldr: result.tldr,
  };
  const type = material.type || item.type || 'Article';
  if (type !== item.type) fields.type = type;
  if (item.last_error) fields.last_error = '';
  if (material.readingMinutes) fields.reading_time = material.readingMinutes;
  if (result.author) fields.author_source = result.author;
  // Prefer the real title for PDFs and for rows saved with only a URL-derived title.
  const betterTitle = (material.title || result.title || '').trim();
  if (betterTitle && (!item.title || item.type === 'PDF' || item.title === item.url)) fields.title = betterTitle;
  if (
    source?.long_only && source.min_minutes && type === 'Article' && !material.thin && material.readingMinutes &&
    material.readingMinutes < source.min_minutes && (!item.status || item.status === 'Unread')
  ) {
    fields.status = 'Archive';
    fields.last_error = SHORT_NOTE;
  } else if (material.shortText && !material.thin) fields.last_error = READING_TIME_NOTE;
  if (material.thin) {
    const basis = material.text ? 'the feed summary' : 'the title only';
    fields.last_error = material.fetchError
      ? `Page unavailable (${material.fetchError}); classified from ${basis}.`
      : 'Classified from a short excerpt (page text unavailable).';
  }
  return fields;
}

/**
 * Classify a batch of pending articles with ONE AI request (the Sheet is the queue).
 *
 * Free AI tiers count requests, not articles, so sending several articles at once is what makes
 * them last: 60 articles take ~10 requests instead of 60.
 *
 * Safe against being killed mid-run: before anything else each article's attempt counter is bumped,
 * so an article that keeps crashing the function is skipped after 5 tries instead of blocking the queue.
 * Running out of AI quota is not the article's fault: its attempt is given back.
 *
 * @param {object} o
 * @param {object} o.classifier  { classifyBatch(items, opts), classify(item, opts) }
 * @param {number} o.limit       articles to take this run (sent to the AI together)
 * @param {number} o.budgetMs    time this invocation may use (limits retry waiting)
 */
export async function processPending({
  sheet,
  classifier,
  fetchImpl = fetch,
  limit = 5,
  budgetMs = 24000,
  sources,
  now = Date.now,
  log = () => {},
}) {
  const started = now();
  const deadline = started + budgetMs;
  const summary = { processed: 0, failed: 0, remaining: null, stopped: '', elapsedMs: 0 };
  const finish = () => {
    summary.elapsedMs = now() - started;
    return summary;
  };

  // Ask for a few extra rows so we can report roughly how many are still waiting.
  const pending = (await sheet.pending(Math.max(limit, 1) + 25)).sort(
    // Fresh articles first, so one stubborn article cannot hog every run.
    (a, b) => (Number(a.classify_attempts) || 0) - (Number(b.classify_attempts) || 0)
  );
  if (!pending.length) {
    summary.remaining = 0;
    return finish();
  }
  const batch = pending.slice(0, Math.max(limit, 1));
  const attemptsBefore = new Map(batch.map((it) => [it.id, Number(it.classify_attempts) || 0]));
  const categoryNames = (await sheet.categories()).map((c) => c.name);

  await sheet.updateArticle(batch.map((it) => ({ id: it.id, fields: { classify_attempts: attemptsBefore.get(it.id) + 1 } })));

  // Load every article's text at the same time.
  const loaded = await Promise.all(
    batch.map(async (item) => {
      try {
        return { item, material: await materialForClassification(item.url, { fetchImpl, fallbackText: item.tldr || '' }) };
      } catch (err) {
        return { item, error: err };
      }
    })
  );

  const updates = [];
  const ready = [];
  for (const l of loaded) {
    if (l.error) {
      summary.failed++;
      log(`Could not load ${l.item.url}: ${l.error.message}`);
      updates.push({ id: l.item.id, fields: { last_error: friendlyError(l.error).slice(0, 300) } });
    } else {
      ready.push(l);
    }
  }

  const toInput = ({ item, material }) => ({
    id: item.id,
    url: item.url,
    title: material.title || item.title,
    author: material.author || (item.author_source !== item.source_feed ? item.author_source : ''),
    text: material.text,
    pdfBase64: material.pdfBase64,
  });
  const done = new Map(); // id -> { ok, result?, error? }
  const textItems = ready.filter((r) => !r.material.pdfBase64);
  const pdfItems = ready.filter((r) => r.material.pdfBase64);
  let blocked = null;
  let batchError = null;

  try {
    if (textItems.length) {
      const res = await classifier.classifyBatch(textItems.map(toInput), { existingCategories: categoryNames, deadline });
      res.forEach((r) => done.set(r.id, r));
    }
    // PDFs are sent as files, so each goes on its own.
    for (const r of pdfItems) {
      const [res] = await classifier.classifyBatch([toInput(r)], { existingCategories: categoryNames, deadline });
      done.set(res.id, res);
    }
  } catch (err) {
    if (err instanceof RateLimitError) blocked = err;
    else batchError = err;
  }

  // Only needed to archive short pieces from "long reads only" sources; a failure here changes nothing.
  const srcList = sources ?? (done.size ? await loadSources(sheet, { seed: false }).catch(() => []) : []);
  for (const r of ready) {
    const out = done.get(r.item.id);
    if (out?.ok) {
      summary.processed++;
      updates.push({ id: r.item.id, fields: fieldsFor(r.item, r.material, out.result, srcList.find((x) => x.name === r.item.source_feed)) });
    } else if (out) {
      summary.failed++;
      updates.push({ id: r.item.id, fields: { last_error: String(out.error || 'Not classified.').slice(0, 300) } });
    } else if (blocked) {
      // Not this article's fault: give the attempt back and try again later.
      updates.push({
        id: r.item.id,
        fields: { classify_attempts: attemptsBefore.get(r.item.id), last_error: ('Waiting to retry: ' + blocked.message).slice(0, 300) },
      });
    } else {
      summary.failed++;
      log(`Batch failed: ${batchError?.message}`);
      updates.push({ id: r.item.id, fields: { last_error: friendlyError(batchError).slice(0, 300) } });
    }
  }

  if (blocked) {
    summary.stopped = blocked.daily ? 'daily AI quota reached' : 'rate limited';
    summary.detail = blocked.message;
    log(`Stopping: ${blocked.message}`);
  }

  if (updates.length) await sheet.updateArticle(updates);

  summary.remaining = Math.max(0, pending.length - summary.processed - summary.failed);
  return finish();
}
