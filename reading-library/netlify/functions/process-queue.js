// Scheduled: classifies a couple of pending articles every 10 minutes.
// Scheduled functions only run on the PUBLISHED (production) deploy, never on previews.
import { makeDeps } from '../lib/deps.js';
import { processPending } from '../lib/queue.js';

export default async () => {
  const deps = makeDeps();
  try {
    const summary = await processPending({
      sheet: deps.sheet,
      gemini: deps.gemini,
      limit: 2,
      budgetMs: 24000, // Netlify scheduled functions are cut off at 30s
      log: deps.log,
    });
    deps.log('process-queue', JSON.stringify(summary));
  } catch (err) {
    deps.log('process-queue failed:', err.message);
  }
};

export const config = { schedule: '*/10 * * * *' };
