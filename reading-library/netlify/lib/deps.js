import { backupConfigured, loadConfig } from './config.js';
import { createGemini } from './gemini.js';
import { createClassifier, createOpenAICompat } from './llm.js';
import { createSheet } from './sheet.js';

/** Build the shared clients from environment variables (call once per invocation). */
export function makeDeps(env = process.env) {
  const cfg = loadConfig(env);
  const log = (...a) => console.log('[reading-library]', ...a);
  const gemini = createGemini({ apiKey: cfg.geminiKey, model: cfg.geminiModel, delayMs: cfg.geminiDelayMs, log });
  const providers = [gemini];
  if (backupConfigured(cfg)) {
    providers.push(
      createOpenAICompat({
        baseUrl: cfg.backupBaseUrl,
        apiKey: cfg.backupKey,
        model: cfg.backupModel,
        delayMs: cfg.backupDelayMs,
        name: 'Backup AI',
        log,
      })
    );
  }
  return {
    cfg,
    log,
    sheet: createSheet({ url: cfg.appsScriptUrl, token: cfg.appsScriptToken }),
    gemini,
    classifier: createClassifier(providers, { log }),
  };
}
