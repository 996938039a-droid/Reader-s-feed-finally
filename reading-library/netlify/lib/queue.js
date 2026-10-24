import { RateLimitError } from './gemini.js';
import { friendlyError, materialForClassification } from './extract.js';

/**
 * Classify pending articles one at a time (the Sheet is the queue).
 *
 * Safe against being killed mid-run: before an article is touched its attempt counter is
 * bumped, so an article that keeps crashing the function is skipped after 5 tries instead of
 * blocking the queue forever.
 *
 * @param {object} o
 * @param {number} o.limit        max articles to take this run
 * @param {number} o.budgetMs     total time this invocation may use
 * @param {number} [o.perItemMs]  rough worst-case time one article needs (don't start another if it won't fit)
 */
export async function processPending({
  sheet,
  gemini,
  fetchImpl = fetch,
  limit = 2,
  budgetMs = 24000,
  perItemMs = 11000,
  now = Date.now,
  log = () => {},
}) {
  const started = now();
  const deadline = started + budgetMs;
  const summary = { processed: 0, failed: 0, remaining: null, stopped: '' };

  // Ask for a few extra rows so we can report roughly how many are still waiting.
  const pending = await sheet.pending(Math.max(limit, 1) + 25);
  if (!pending.length) {
    summary.remaining = 0;
    return summary;
  }
  const cats = await sheet.categories();
  const categoryNames = cats.map((c) => c.name);

  for (const item of pending.slice(0, limit)) {
    if (summary.processed + summary.failed > 0 && now() + perItemMs > deadline) {
      summary.stopped = 'out of time';
      break;
    }
    const attemptsBefore = Number(item.classify_attempts) || 0;
    await sheet.updateArticle([{ id: item.id, fields: { classify_attempts: attemptsBefore + 1, last_error: 'in progress' } }]);

    try {
      const material = await materialForClassification(item.url, { fetchImpl, fallbackText: item.tldr || '' });
      const result = await gemini.classify(
        {
          url: item.url,
          title: material.title || item.title,
          author: material.author || (item.author_source !== item.source_feed ? item.author_source : ''),
          text: material.text,
          pdfBase64: material.pdfBase64,
          existingCategories: categoryNames,
        },
        { deadline }
      );

      if (result.category && !categoryNames.includes(result.category)) categoryNames.push(result.category);

      const fields = {
        category: result.category || 'Uncategorised',
        tags: result.tags,
        format: result.format,
        tldr: result.tldr,
        type: material.type || item.type || 'Article',
        last_error: '',
      };
      if (material.readingMinutes) fields.reading_time = material.readingMinutes;
      if (result.author) fields.author_source = result.author;
      // Prefer the real title for PDFs and for rows saved with only a URL-derived title.
      const betterTitle = (material.title || result.title || '').trim();
      if (betterTitle && (!item.title || item.type === 'PDF' || item.title === item.url)) fields.title = betterTitle;
      if (material.thin) fields.last_error = 'Classified from a short excerpt (page text unavailable).';

      await sheet.updateArticle([{ id: item.id, fields }]);
      summary.processed++;
    } catch (err) {
      if (err instanceof RateLimitError) {
        // Not this article's fault: undo the attempt and stop for now.
        await sheet
          .updateArticle([{ id: item.id, fields: { classify_attempts: attemptsBefore, last_error: '' } }])
          .catch(() => {});
        summary.stopped = err.daily ? 'daily Gemini quota reached' : 'rate limited';
        log(`Stopping: ${err.message}`);
        break;
      }
      summary.failed++;
      log(`Failed to classify ${item.url}: ${err.message}`);
      await sheet
        .updateArticle([{ id: item.id, fields: { last_error: friendlyError(err).slice(0, 300) } }])
        .catch(() => {});
    }
  }

  summary.remaining = Math.max(0, pending.length - summary.processed - summary.failed);
  return summary;
}
