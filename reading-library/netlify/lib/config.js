// All configuration comes from Netlify environment variables. Nothing secret lives in the repo.

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

export function loadConfig(env = process.env) {
  return {
    appsScriptUrl: env.APPS_SCRIPT_URL || '',
    appsScriptToken: env.APPS_SCRIPT_TOKEN || '',
    geminiKey: env.GEMINI_API_KEY || '',
    // Model names change often. This can be an alias or a pinned ID; if it stops working
    // the Gemini client lists the models your key can use and picks a current Flash model.
    geminiModel: env.GEMINI_MODEL || 'gemini-flash-latest',
    // Gap between Gemini calls. 4.5s = at most ~13 calls/min, under a 15 RPM cap.
    geminiDelayMs: num(env.GEMINI_DELAY_MS, 4500),
    passphrase: env.APP_PASSPHRASE || '',
    // Day-0 seed: how many items to take from a feed that has nothing in the Sheet yet (7-10).
    seedPerFeed: Math.min(10, Math.max(7, num(env.SEED_PER_FEED, 8))),
    // Ongoing harvest: at most this many NEW items per feed per run.
    maxPerFeedPerRun: Math.min(10, num(env.MAX_PER_FEED_PER_RUN, 10)),
  };
}

/** Names of required settings that are missing (never returns values). */
export function missingConfig(cfg) {
  const missing = [];
  if (!cfg.appsScriptUrl) missing.push('APPS_SCRIPT_URL');
  if (!cfg.appsScriptToken) missing.push('APPS_SCRIPT_TOKEN');
  if (!cfg.geminiKey) missing.push('GEMINI_API_KEY');
  if (!cfg.passphrase) missing.push('APP_PASSPHRASE');
  return missing;
}
