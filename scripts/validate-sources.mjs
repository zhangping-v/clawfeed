#!/usr/bin/env node
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] || fallback;
}

const dbPath = getArg('--db') || process.env.DIGEST_DB || process.env.AI_DIGEST_DB || join(ROOT, 'data', 'digest.db');
const limit = parseInt(getArg('--limit', '1000'), 10);
const concurrency = Math.max(1, parseInt(getArg('--concurrency', '6'), 10));
const outPath = getArg('--out');
const onlyTypes = (getArg('--only', '') || '').split(',').map(s => s.trim()).filter(Boolean);

const db = new Database(dbPath, { readonly: true });

const sources = db.prepare(`
  SELECT id, name, type, config, is_active, is_deleted
  FROM sources
  WHERE is_deleted = 0
  ORDER BY created_at DESC
  LIMIT ?
`).all(limit);

function parseConfig(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

function buildCheckUrl(source) {
  const cfg = parseConfig(source.config);
  switch (source.type) {
    case 'rss':
    case 'digest_feed':
    case 'website':
      return cfg.url || '';
    case 'custom_api':
      return cfg.endpoint || '';
    case 'github_trending': {
      const lang = (cfg.language || '').trim();
      return lang ? `https://github.com/trending/${encodeURIComponent(lang)}` : 'https://github.com/trending';
    }
    case 'hackernews':
      return 'https://news.ycombinator.com/';
    case 'reddit': {
      const sub = cfg.subreddit || '';
      return sub ? `https://www.reddit.com/r/${sub}/.rss` : '';
    }
    default:
      return '';
  }
}

function isSkippableType(type) {
  return type === 'twitter_feed' || type === 'twitter_list' || type === 'twitter';
}

async function fetchWithTimeout(url, ms = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'ClawFeed-Validator/1.0' } });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function checkSource(source) {
  if (onlyTypes.length && !onlyTypes.includes(source.type)) {
    return { id: source.id, name: source.name, type: source.type, skipped: true, reason: 'filtered' };
  }
  if (isSkippableType(source.type)) {
    return { id: source.id, name: source.name, type: source.type, skipped: true, reason: 'not_checkable' };
  }
  const url = buildCheckUrl(source);
  if (!url) {
    return { id: source.id, name: source.name, type: source.type, ok: false, error: 'missing url' };
  }
  const started = Date.now();
  try {
    const res = await fetchWithTimeout(url, 12000);
    const elapsedMs = Date.now() - started;
    const ok = res.status >= 200 && res.status < 400;
    return {
      id: source.id,
      name: source.name,
      type: source.type,
      url,
      ok,
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      elapsedMs,
    };
  } catch (e) {
    return {
      id: source.id,
      name: source.name,
      type: source.type,
      url,
      ok: false,
      error: e.name === 'AbortError' ? 'timeout' : e.message,
    };
  }
}

async function runPool(items, worker, size) {
  const results = [];
  let index = 0;
  async function next() {
    const i = index++;
    if (i >= items.length) return;
    results[i] = await worker(items[i]);
    return next();
  }
  const workers = Array.from({ length: Math.min(size, items.length) }, () => next());
  await Promise.all(workers);
  return results;
}

(async () => {
  const results = await runPool(sources, checkSource, concurrency);
  const summary = results.reduce((acc, r) => {
    if (r.skipped) acc.skipped += 1;
    else if (r.ok) acc.ok += 1;
    else acc.fail += 1;
    return acc;
  }, { ok: 0, fail: 0, skipped: 0 });

  const output = { checked_at: new Date().toISOString(), db: dbPath, limit, concurrency, summary, results };
  const text = JSON.stringify(output, null, 2);
  if (outPath) {
    await import('fs').then(fs => fs.writeFileSync(outPath, text));
    console.log(`Wrote ${results.length} results to ${outPath}`);
  } else {
    console.log(text);
  }
})();
