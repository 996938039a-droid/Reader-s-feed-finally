// Scheduled: checks the five RSS feeds every 6 hours and adds new items to the Sheet.
// The first run also performs the Day-0 seed (7-10 items per feed).
import { makeDeps } from '../lib/deps.js';
import { harvest } from '../lib/feeds.js';

export default async () => {
  const deps = makeDeps();
  try {
    const report = await harvest({ sheet: deps.sheet, cfg: deps.cfg, log: deps.log });
    deps.log('harvest', JSON.stringify(report));
  } catch (err) {
    deps.log('harvest failed:', err.message);
  }
};

export const config = { schedule: '0 */6 * * *' };
