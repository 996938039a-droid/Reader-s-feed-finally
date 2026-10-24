// Scheduled: classifies a batch of pending articles every 10 minutes (one AI request per batch).
// Scheduled functions only run on the PUBLISHED (production) deploy, never on previews.
import { makeDeps } from '../lib/deps.js';
import { processPending } from '../lib/queue.js';

export default async () => {
  const deps = makeDeps();
  try {
    const summary = await processPending({
      sheet: deps.sheet,
      classifier: deps.classifier,
      limit: deps.cfg.batchSize,
      budgetMs: 24000, // Netlify scheduled functions are cut off at 30s
      log: deps.log,
    });
    deps.log('process-queue', JSON.stringify(summary));
  } catch (err) {
    deps.log('process-queue failed:', err.message);
  }
};

export const config = { schedule: '*/10 * * * *' };
