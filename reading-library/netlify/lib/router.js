import { isAuthorised } from './auth.js';
import { backupConfigured, missingConfig } from './config.js';
import { extractForReader, friendlyError, quickMeta } from './extract.js';
import { harvest } from './feeds.js';
import { processPending } from './queue.js';
import { assertPublicHttpUrl, json, sleep } from './util.js';

const STATUSES = ['Unread', 'Reading', 'Finished', 'Archive'];
const EDITABLE = ['status', 'notes', 'category', 'tags', 'title', 'reading_time', 'last_error'];
const MAX_ATTEMPTS = 5;

async function readBody(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

function categoriesFrom(articles) {
  const counts = new Map();
  for (const a of articles) if (a.category) counts.set(a.category, (counts.get(a.category) || 0) + 1);
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

/**
 * Handle one /api/* request.
 * @param {Request} req
 * @param {object} deps { cfg, sheet, gemini, log, fetchImpl? }
 */
import { GENERIC_CATEGORY } from './classify-common.js';
import { readingTimeIsLow } from './util.js';

export async function handle(req, deps) {
  const { cfg, sheet, gemini, log } = deps;
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/(?:\.netlify\/functions\/api|api)\/?/, '').replace(/\/+$/, '');
  const method = req.method.toUpperCase();

  if (!isAuthorised(req, cfg.passphrase)) {
    await sleep(deps.authDelayMs ?? 400); // slow down guessing
    return json({ error: 'Unauthorized' }, 401);
  }

  try {
    if (method === 'GET' && path === 'auth') return json({ ok: true });

    if (method === 'GET' && path === 'health') {
      const out = { ok: true, missing: missingConfig(cfg), model: gemini?.state?.model, backupAI: backupConfigured(cfg) ? 'configured' : 'not set (optional)', sheet: 'unchecked', gemini: 'unchecked' };
      try {
        await sheet.ping();
        out.sheet = 'ok';
      } catch (e) {
        out.sheet = e.message;
      }
      try {
        const models = await gemini.listModels();
        out.gemini = `ok (${models.length} models visible)`;
      } catch (e) {
        out.gemini = e.message;
      }
      return json(out);
    }

    if (method === 'GET' && path === 'gemini-test') {
      return json(await gemini.ping());
    }

    if (method === 'GET' && path === 'models') {
      const models = await gemini.listModels();
      return json({
        current: gemini.state.model,
        models: models
          .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
          .map((m) => String(m.name).replace(/^models\//, '')),
      });
    }

    if (method === 'GET' && path === 'library') {
      const articles = (await sheet.articles()).map((a) => ({ ...a, reading_time_low: readingTimeIsLow(a) }));
      const pending = articles.filter((a) => !a.category && (a.classify_attempts || 0) < MAX_ATTEMPTS).length;
      return json({ articles, categories: categoriesFrom(articles), pending });
    }

    if (method === 'POST' && path === 'articles') {
      const body = await readBody(req);
      const safe = assertPublicHttpUrl(body.url);
      const meta = await quickMeta(safe, { fetchImpl: deps.fetchImpl });
      const res = await sheet.add([{ ...meta, source_feed: body.source_feed || 'Manual', status: 'Unread' }]);
      const r = res.results?.[0] || {};
      return json({ ok: r.ok !== false, id: r.id, duplicate: !!r.duplicate, title: meta.title, type: meta.type });
    }

    if (method === 'POST' && path === 'articles/update') {
      const body = await readBody(req);
      if (!body.id || !body.fields) return json({ error: 'id and fields are required' }, 400);
      const fields = {};
      for (const k of EDITABLE) if (body.fields[k] !== undefined) fields[k] = body.fields[k];
      if (fields.status && !STATUSES.includes(fields.status)) return json({ error: 'Invalid status' }, 400);
      const res = await sheet.updateArticle([{ id: body.id, fields }]);
      return json({ ok: true, ...res });
    }

    if (method === 'POST' && path === 'reclassify') {
      // Put articles back in the queue so the (improved) AI sorts them again.
      const body = await readBody(req);
      const mode = body.mode === 'all' ? 'all' : 'weak';
      const articles = await sheet.articles();
      const weak = (a) => !a.category || GENERIC_CATEGORY.test(a.category) || !(a.tags || []).length;
      const chosen = articles.filter((a) => a.category && (mode === 'all' || weak(a)));
      for (let i = 0; i < chosen.length; i += 40) {
        await sheet.updateArticle(chosen.slice(i, i + 40).map((a) => ({ id: a.id, fields: { category: '', classify_attempts: 0 } })));
      }
      return json({ ok: true, requeued: chosen.length, mode });
    }

    if (method === 'POST' && path === 'categories/merge') {
      const body = await readBody(req);
      if (!body.from || !body.to) return json({ error: 'from and to are required' }, 400);
      return json({ ok: true, ...(await sheet.mergeCategory(body.from, body.to)) });
    }

    if (method === 'GET' && path === 'highlights') {
      return json({ highlights: await sheet.highlights(url.searchParams.get('since') || undefined) });
    }

    if (method === 'POST' && path === 'highlights') {
      const body = await readBody(req);
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return json({ applied: [], conflicts: [] });
      return json(await sheet.upsertHighlights(items));
    }

    if (method === 'GET' && path === 'extract') {
      const target = url.searchParams.get('url');
      if (!target) return json({ error: 'url is required' }, 400);
      return json(await extractForReader(target, { fetchImpl: deps.fetchImpl }));
    }

    if (method === 'POST' && path === 'process') {
      // A small batch, so it fits a synchronous function's time limit. `elapsedMs` shows how close it was.
      const body = await readBody(req);
      const size = Math.min(6, Math.max(1, Number(body.batch) || cfg.manualBatch || 2));
      const summary = await processPending({
        sheet,
        classifier: deps.classifier,
        fetchImpl: deps.fetchImpl,
        limit: size,
        budgetMs: 8000,
        log,
      });
      return json({ ok: true, ...summary });
    }

    if (method === 'POST' && path === 'harvest') {
      const report = await harvest({ sheet, cfg, fetchImpl: deps.fetchImpl, log });
      return json({ ok: true, report });
    }

    return json({ error: 'Not found' }, 404);
  } catch (err) {
    log('API error on', method, path, '-', err.message);
    return json({ error: friendlyError(err) }, 500);
  }
}
