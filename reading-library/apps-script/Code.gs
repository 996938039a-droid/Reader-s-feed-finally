/**
 * Reading Library: Database API
 * Google Apps Script Web App (container-bound to the "Reading Library" Sheet)
 *
 * Tabs:   Articles, Highlights
 * Auth:   every request must carry the secret in Script Property API_TOKEN
 *         (GET: ?token=...   POST: {"token": "...", "action": "...", "data": ...})
 *
 * Only your Netlify functions should ever call this URL. Never put the
 * token or the /exec URL in browser-side code.
 *
 * ---------------------------------------------------------------------------
 * GET  ?token=T&what=articles                   -> all articles
 * GET  ?token=T&what=highlights[&since=ISO]     -> all highlights (or changed since)
 * GET  ?token=T&what=pending[&limit=3]          -> articles still waiting for AI classification
 * GET  ?token=T&what=categories                 -> [{name, count}] sorted by count
 *
 * POST actions
 *   add                data: article | [article]          (dedupes by normalised URL)
 *   update_status      data: {id, status}                 (Unread|Reading|Finished|Archive)
 *   update_article     data: {id, fields:{...}} | [ ... ] (whitelisted fields only)
 *   exists             data: {url} | {urls:[...]}
 *   upsert_highlights  data: highlight | [highlight]      (last-write-wins on updated_at)
 *   merge_category     data: {from, to}
 *   ping               -> {pong:true}
 * ---------------------------------------------------------------------------
 */

var SHEET_ARTICLES = 'Articles';
var SHEET_HIGHLIGHTS = 'Highlights';

var ARTICLE_COLS = [
  'id', 'date_added', 'title', 'author_source', 'url', 'category', 'tags',
  'format', 'reading_time', 'tldr', 'status', 'type', 'notes', 'source_feed',
  'published_date', 'classify_attempts', 'last_error'
];
var HIGHLIGHT_COLS = [
  'id', 'article_id', 'quote', 'prefix', 'suffix', 'note', 'color',
  'created_at', 'updated_at', 'deleted', 'device'
];

var VALID_STATUS = ['Unread', 'Reading', 'Finished', 'Archive'];
var UPDATABLE_ARTICLE_FIELDS = [
  'title', 'author_source', 'category', 'tags', 'format', 'reading_time',
  'tldr', 'status', 'type', 'notes', 'classify_attempts', 'last_error'
];
var MAX_CLASSIFY_ATTEMPTS = 5;

/* ============================== ENTRY POINTS ============================== */

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    requireToken_(p.token);
    var what = p.what || 'articles';

    if (what === 'articles') {
      return json_({ ok: true, data: readAll_(SHEET_ARTICLES).map(articleOut_) });
    }
    if (what === 'highlights') {
      var rows = readAll_(SHEET_HIGHLIGHTS).map(highlightOut_);
      if (p.since) {
        rows = rows.filter(function (r) { return String(r.updated_at) > String(p.since); });
      }
      return json_({ ok: true, data: rows });
    }
    if (what === 'pending') {
      var limit = Math.max(1, Math.min(50, parseInt(p.limit, 10) || 3));
      var pending = readAll_(SHEET_ARTICLES)
        .filter(function (r) {
          return !String(r.category).trim() &&
            (Number(r.classify_attempts) || 0) < MAX_CLASSIFY_ATTEMPTS;
        })
        .slice(0, limit)
        .map(articleOut_);
      return json_({ ok: true, data: pending });
    }
    if (what === 'categories') {
      var counts = {};
      readAll_(SHEET_ARTICLES).forEach(function (r) {
        var c = String(r.category).trim();
        if (c) counts[c] = (counts[c] || 0) + 1;
      });
      var list = Object.keys(counts)
        .map(function (k) { return { name: k, count: counts[k] }; })
        .sort(function (a, b) { return b.count - a.count; });
      return json_({ ok: true, data: list });
    }
    return json_({ ok: false, error: 'Unknown "what": ' + what });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  var locked = false;
  try {
    var body = parseBody_(e);
    requireToken_(body.token);
    var action = body.action;
    var data = body.data;

    if (action === 'ping') return json_({ ok: true, pong: true });

    lock.waitLock(20000);
    locked = true;

    var result;
    switch (action) {
      case 'add':               result = actionAdd_(data); break;
      case 'update_status':     result = actionUpdateStatus_(data); break;
      case 'update_article':    result = actionUpdateArticle_(data); break;
      case 'exists':            result = actionExists_(data); break;
      case 'upsert_highlights': result = actionUpsertHighlights_(data); break;
      case 'merge_category':    result = actionMergeCategory_(data); break;
      default: throw new Error('Unknown action: ' + action);
    }
    return json_({ ok: true, data: result });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  } finally {
    if (locked) lock.releaseLock();
  }
}

/* ================================ ACTIONS ================================= */

function actionAdd_(data) {
  var items = Array.isArray(data) ? data : [data];
  var sheet = getSheet_(SHEET_ARTICLES);
  var hdr = headers_(sheet);
  var known = urlIndex_(sheet, hdr); // normalised url -> id
  var now = new Date().toISOString();
  var rows = [];
  var results = [];

  items.forEach(function (it) {
    if (!it || !it.url) { results.push({ ok: false, error: 'missing url' }); return; }
    var key = normalizeUrl_(it.url);
    if (known[key]) {
      results.push({ ok: true, url: it.url, id: known[key], duplicate: true });
      return;
    }
    var id = newId_();
    var obj = {
      id: id,
      date_added: now,
      title: it.title || '',
      author_source: it.author_source || '',
      url: String(it.url).trim(),
      category: it.category || '',
      tags: Array.isArray(it.tags) ? it.tags.join(', ') : (it.tags || ''),
      format: it.format || '',
      reading_time: it.reading_time || '',
      tldr: it.tldr || '',
      status: VALID_STATUS.indexOf(it.status) >= 0 ? it.status : 'Unread',
      type: it.type || 'Article',
      notes: it.notes || '',
      source_feed: it.source_feed || '',
      published_date: it.published_date || '',
      classify_attempts: it.classify_attempts || 0,
      last_error: ''
    };
    known[key] = id;
    rows.push(hdr.map(function (h) { return cell_(obj[h]); }));
    results.push({ ok: true, url: it.url, id: id, duplicate: false });
  });

  appendRows_(sheet, hdr, rows);
  return { results: results };
}

function actionUpdateStatus_(data) {
  if (!data || !data.id) throw new Error('id required');
  if (VALID_STATUS.indexOf(data.status) < 0) {
    throw new Error('status must be one of: ' + VALID_STATUS.join(', '));
  }
  return actionUpdateArticle_({ id: data.id, fields: { status: data.status } });
}

function actionUpdateArticle_(data) {
  var items = Array.isArray(data) ? data : [data];
  var sheet = getSheet_(SHEET_ARTICLES);
  var hdr = headers_(sheet);
  var rowById = idRowMap_(sheet, hdr);
  var updated = [];
  var missing = [];

  items.forEach(function (it) {
    if (!it || !it.id) return;
    var row = rowById[String(it.id)];
    if (!row) { missing.push(it.id); return; }
    var fields = it.fields || {};
    Object.keys(fields).forEach(function (k) {
      if (UPDATABLE_ARTICLE_FIELDS.indexOf(k) < 0) return;
      var col = hdr.indexOf(k) + 1;
      if (col < 1) return;
      var v = fields[k];
      if (k === 'status' && VALID_STATUS.indexOf(v) < 0) {
        throw new Error('Invalid status: ' + v);
      }
      if (k === 'tags' && Array.isArray(v)) v = v.join(', ');
      var cell = sheet.getRange(row, col);
      cell.setNumberFormat('@');
      cell.setValue(cell_(v));
    });
    updated.push(it.id);
  });
  return { updated: updated, missing: missing };
}

function actionExists_(data) {
  var sheet = getSheet_(SHEET_ARTICLES);
  var hdr = headers_(sheet);
  var known = urlIndex_(sheet, hdr);

  if (data && Array.isArray(data.urls)) {
    var map = {};
    data.urls.forEach(function (u) {
      var id = known[normalizeUrl_(u)];
      map[u] = id ? { exists: true, id: id } : { exists: false };
    });
    return { results: map };
  }
  if (data && data.url) {
    var id1 = known[normalizeUrl_(data.url)];
    return id1 ? { exists: true, id: id1 } : { exists: false };
  }
  throw new Error('url or urls required');
}

function actionUpsertHighlights_(data) {
  var items = Array.isArray(data) ? data : [data];
  var sheet = getSheet_(SHEET_HIGHLIGHTS);
  var hdr = headers_(sheet);
  var values = sheet.getDataRange().getValues();
  var idCol = hdr.indexOf('id');
  var upCol = hdr.indexOf('updated_at');

  var existing = {}; // id -> {index into values, updated_at}
  for (var i = 1; i < values.length; i++) {
    var rid = values[i][idCol];
    if (rid) existing[String(rid)] = { i: i, updated: String(cellOut_(values[i][upCol])) };
  }

  var now = new Date().toISOString();
  var appendList = [];
  var applied = [];
  var conflicts = [];

  items.forEach(function (it) {
    if (!it || !it.id || !it.article_id) return;
    var incomingUpdated = String(it.updated_at || now);
    var ex = existing[String(it.id)];

    if (ex && ex.i < 0) return; // same id twice in one batch: first one wins

    if (ex) {
      if (incomingUpdated > ex.updated) {
        var base = values[ex.i].slice();
        hdr.forEach(function (h, j) {
          if (it[h] !== undefined) base[j] = cell_(h === 'deleted' ? boolStr_(it[h]) : it[h]);
        });
        base[upCol] = incomingUpdated;
        var rng = sheet.getRange(ex.i + 1, 1, 1, hdr.length);
        rng.setNumberFormat('@');
        rng.setValues([base]);
        values[ex.i] = base;
        ex.updated = incomingUpdated;
        applied.push(it.id);
      } else {
        // Server copy is newer (or identical): hand it back so the client can take it.
        var cur = rowToObj_(hdr, values[ex.i]);
        if (incomingUpdated < ex.updated) conflicts.push(highlightOut_(cur));
      }
    } else {
      var rec = {};
      hdr.forEach(function (h) { rec[h] = it[h]; });
      rec.created_at = it.created_at || now;
      rec.updated_at = incomingUpdated;
      rec.deleted = boolStr_(it.deleted);
      appendList.push(hdr.map(function (h) { return cell_(rec[h]); }));
      existing[String(it.id)] = { i: -1, updated: incomingUpdated };
      applied.push(it.id);
    }
  });

  appendRows_(sheet, hdr, appendList);
  return { applied: applied, conflicts: conflicts };
}

function actionMergeCategory_(data) {
  if (!data || !data.from || !data.to) throw new Error('from and to required');
  var sheet = getSheet_(SHEET_ARTICLES);
  var hdr = headers_(sheet);
  var col = hdr.indexOf('category') + 1;
  var last = sheet.getLastRow();
  if (last < 2) return { changed: 0 };

  var range = sheet.getRange(2, col, last - 1, 1);
  var vals = range.getValues();
  var from = String(data.from).trim().toLowerCase();
  var changed = 0;
  vals.forEach(function (r) {
    if (String(r[0]).trim().toLowerCase() === from) { r[0] = String(data.to).trim(); changed++; }
  });
  if (changed) range.setValues(vals);
  return { changed: changed };
}

/* ================================ HELPERS ================================= */

function requireToken_(token) {
  var expected = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  if (!expected) throw new Error('API_TOKEN is not configured. Run setup() first.');
  if (!token || String(token) !== expected) throw new Error('Unauthorized');
}

function parseBody_(e) {
  if (!e || !e.postData || !e.postData.contents) throw new Error('Empty body');
  try {
    return JSON.parse(e.postData.contents);
  } catch (err) {
    throw new Error('Body must be JSON');
  }
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('Missing sheet tab: ' + name + '. Run setup().');
  return sheet;
}

function headers_(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) throw new Error('Header row is empty on ' + sheet.getName() + '. Run setup().');
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
}

function readAll_(name) {
  var sheet = getSheet_(name);
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var hdr = values[0].map(function (h) { return String(h).trim(); });
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var empty = row.every(function (c) { return c === '' || c === null; });
    if (empty) continue;
    out.push(rowToObj_(hdr, row));
  }
  return out;
}

function rowToObj_(hdr, row) {
  var o = {};
  hdr.forEach(function (h, j) { if (h) o[h] = cellOut_(row[j]); });
  return o;
}

function cellOut_(v) {
  if (v instanceof Date) return v.toISOString();
  if (v === null || v === undefined) return '';
  return v;
}

function cell_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

function boolStr_(v) {
  return (v === true || String(v).toLowerCase() === 'true') ? 'true' : 'false';
}

function splitTags_(s) {
  return String(s || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean);
}

function articleOut_(r) {
  var o = {};
  Object.keys(r).forEach(function (k) { o[k] = r[k]; });
  o.tags = splitTags_(r.tags);
  var rt = parseFloat(r.reading_time);
  o.reading_time = isNaN(rt) ? null : rt;
  o.classify_attempts = Number(r.classify_attempts) || 0;
  return o;
}

function highlightOut_(r) {
  var o = {};
  Object.keys(r).forEach(function (k) { o[k] = r[k]; });
  o.deleted = String(r.deleted).toLowerCase() === 'true';
  return o;
}

function newId_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 12);
}

function idRowMap_(sheet, hdr) {
  var col = hdr.indexOf('id') + 1;
  var last = sheet.getLastRow();
  var map = {};
  if (col < 1 || last < 2) return map;
  sheet.getRange(2, col, last - 1, 1).getValues().forEach(function (r, i) {
    if (r[0]) map[String(r[0])] = i + 2;
  });
  return map;
}

function urlIndex_(sheet, hdr) {
  var col = hdr.indexOf('url') + 1;
  var idCol = hdr.indexOf('id') + 1;
  var last = sheet.getLastRow();
  var map = {};
  if (col < 1 || last < 2) return map;
  var urls = sheet.getRange(2, col, last - 1, 1).getValues();
  var ids = sheet.getRange(2, idCol, last - 1, 1).getValues();
  urls.forEach(function (r, i) {
    if (r[0]) map[normalizeUrl_(r[0])] = String(ids[i][0]);
  });
  return map;
}

/** Normalise for duplicate detection: drop scheme, www., #fragment, trailing slash, tracking params. */
function normalizeUrl_(u) {
  u = String(u).trim().replace(/#.*$/, '');
  var m = u.match(/^(?:https?:\/\/)?([^\/?]+)([^?]*)(\?.*)?$/i);
  if (!m) return u.toLowerCase();
  var host = m[1].toLowerCase().replace(/^www\./, '');
  var path = m[2].replace(/\/+$/, '');
  var q = '';
  if (m[3]) {
    var kept = m[3].slice(1).split('&').filter(function (kv) {
      return kv && !/^(utm_|fbclid|gclid|mc_|ref=|ref_src)/i.test(kv);
    }).sort();
    q = kept.length ? '?' + kept.join('&') : '';
  }
  return host + path + q;
}

/** Appends rows below the last used row, growing the sheet if needed. Forces plain-text format. */
function appendRows_(sheet, hdr, rows) {
  if (!rows.length) return;
  var start = sheet.getLastRow() + 1;
  var needed = start + rows.length - 1;
  var max = sheet.getMaxRows();
  if (needed > max) sheet.insertRowsAfter(max, needed - max);
  var range = sheet.getRange(start, 1, rows.length, hdr.length);
  range.setNumberFormat('@');
  range.setValues(rows);
}

/* ================================== SETUP ================================== */

/**
 * Run this ONCE from the Apps Script editor (select "setup" > Run).
 *  - makes sure both tabs and their header rows exist
 *  - stores everything as plain text so Sheets never reinterprets dates/ids
 *  - creates a random API_TOKEN if you have not set one (check View > Logs)
 */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureTab_(ss, SHEET_ARTICLES, ARTICLE_COLS);
  ensureTab_(ss, SHEET_HIGHLIGHTS, HIGHLIGHT_COLS);

  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('API_TOKEN')) {
    var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('API_TOKEN', token);
    Logger.log('NEW API_TOKEN (copy it now, keep it private): ' + token);
  } else {
    Logger.log('API_TOKEN already set (not shown). Change it in Project Settings > Script properties.');
  }
  Logger.log('Setup complete.');
}

function ensureTab_(ss, name, cols) {
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  var lastCol = sheet.getLastColumn();
  var current = lastCol > 0
    ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); })
    : [];
  // Append any missing header; never reorder or delete existing columns.
  cols.forEach(function (c) {
    if (current.indexOf(c) < 0) {
      current.push(c);
      sheet.getRange(1, current.length).setValue(c);
    }
  });
  sheet.getRange(1, 1, 1, current.length).setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, sheet.getMaxRows(), Math.max(current.length, sheet.getMaxColumns()))
    .setNumberFormat('@');
}
