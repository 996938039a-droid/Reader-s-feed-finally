import { makeDeps } from '../lib/deps.js';
import { handle } from '../lib/router.js';
import { json } from '../lib/util.js';

export default async (req) => {
  let deps;
  try {
    deps = makeDeps();
  } catch (err) {
    // Missing env vars: say which ones (names only) instead of crashing.
    return json({ error: 'Server is not configured: ' + err.message }, 500);
  }
  return handle(req, deps);
};

export const config = { path: '/api/*' };
