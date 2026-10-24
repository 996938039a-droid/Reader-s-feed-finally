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
    // Model names change often. Flash-Lite has the biggest free allowance and is plenty for sorting
    // articles. If this name stops working, or its free quota runs out, the Gemini client lists the
    // models your key can use and moves to the next Flash model by itself.
    geminiModel: env.GEMINI_MODEL || 'gemini-flash-lite-latest',
    // Gap between Gemini calls. 4.5s = at most ~13 calls/min, under a 15 RPM cap.
    geminiDelayMs: num(env.GEMINI_DELAY_MS, 4500),
    passphrase: env.APP_PASSPHRASE || '',
    // Articles sent to the AI together in one request (scheduled runs / the setup-page button).
    batchSize: Math.min(10, num(env.CLASSIFY_BATCH, 5)),
    manualBatch: Math.min(6, num(env.MANUAL_BATCH, 2)),
    // Optional backup AI used when Gemini's free quota is gone. Any OpenAI-compatible API
    // (Groq, Cerebras, Mistral, OpenRouter ...). All three must be set to switch it on.
    backupBaseUrl: env.BACKUP_LLM_BASE_URL || '',
    backupKey: env.BACKUP_LLM_API_KEY || '',
    backupModel: env.BACKUP_LLM_MODEL || '',
    backupDelayMs: num(env.BACKUP_LLM_DELAY_MS, 2500),
    // Day-0 seed: how many items to take from a feed that has nothing in the Sheet yet (7-10).
    seedPerFeed: Math.min(10, Math.max(7, num(env.SEED_PER_FEED, 8))),
    // Ongoing harvest: at most this many NEW items per feed per run.
    maxPerFeedPerRun: Math.min(10, num(env.MAX_PER_FEED_PER_RUN, 10)),
  };
}

export const backupConfigured = (cfg) => !!(cfg.backupBaseUrl && cfg.backupKey && cfg.backupModel);

/** Names of required settings that are missing (never returns values). */
export function missingConfig(cfg) {
  const missing = [];
  if (!cfg.appsScriptUrl) missing.push('APPS_SCRIPT_URL');
  if (!cfg.appsScriptToken) missing.push('APPS_SCRIPT_TOKEN');
  if (!cfg.geminiKey) missing.push('GEMINI_API_KEY');
  if (!cfg.passphrase) missing.push('APP_PASSPHRASE');
  return missing;
}
