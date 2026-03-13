import { createServer } from 'http';
import http from 'http';
import https from 'https';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import {
  getDb, listDigests, getDigest, createDigest,
  listMarks, createMark, deleteMark,
  getConfig, setConfig,
  listSources, getSource, createSource, updateSource, deleteSource,
  listSubscriptions, subscribe, unsubscribe, bulkSubscribe,
  insertSourceItems, listItems, updateSourceFetchStats,
} from './db.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Load .env ──
const envPath = join(ROOT, '.env');
const env = {};
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
}

const API_KEY = env.API_KEY || process.env.API_KEY || '';
const PORT = process.env.DIGEST_PORT || env.DIGEST_PORT || 8767;
const MAX_BODY_BYTES = 1024 * 1024;
const DB_PATH = process.env.DIGEST_DB || env.AI_DIGEST_DB || join(ROOT, 'data', 'digest.db');

mkdirSync(join(ROOT, 'data'), { recursive: true });
const db = getDb(DB_PATH);

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let tooLarge = false;
    req.on('data', c => {
      if (tooLarge) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) { tooLarge = true; return; }
      body += c;
    });
    req.on('end', () => {
      if (tooLarge) return reject(new Error('payload too large'));
      try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); }
    });
  });
}

function parseUrl(url) {
  const [path, qs] = url.split('?');
  const params = new URLSearchParams(qs || '');
  return { path, params };
}

// ── API key check (for POST /api/digests from local network) ──
function isPrivateOrSpecialIp(ip) {
  if (!ip) return true;
  if (ip.includes(':')) {
    const n = ip.toLowerCase();
    return n === '::1' || n.startsWith('fc') || n.startsWith('fd') || n.startsWith('fe80:') || n.startsWith('::ffff:127.');
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => Number.isNaN(x) || x < 0 || x > 255)) return true;
  const [a, b] = p;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function checkApiAccess(req) {
  const authHeader = req.headers.authorization || '';
  const bearerKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const xKey = req.headers['x-api-key'] || '';
  const providedKey = bearerKey || xKey;
  if (API_KEY && providedKey === API_KEY) return true;
  // Local Network Trust: bypass API key from private IPs
  const rawIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  const ip = rawIp.replace(/^::ffff:/, '');
  if (isPrivateOrSpecialIp(ip)) return true;
  return false;
}

// ── Source URL resolver ──
async function assertSafeFetchUrl(rawUrl) {
  const u = new URL(rawUrl);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('invalid url scheme');
  const host = u.hostname;
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('blocked host');
  if (isIP(host) && isPrivateOrSpecialIp(host)) throw new Error('blocked host');
  const resolved = await lookup(host, { all: true });
  if (!resolved.length || resolved.some((r) => isPrivateOrSpecialIp(r.address))) {
    throw new Error('blocked host');
  }
}

async function httpFetch(url, timeout = 5000, redirectsLeft = 3) {
  await assertSafeFetchUrl(url);
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const r = mod.get(url, { headers: { 'User-Agent': 'ClawFeed/1.0', 'Accept': 'text/html,application/xhtml+xml,application/xml,application/json,*/*' } }, async (resp) => {
      try {
        if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
          clearTimeout(timer);
          if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
          const nextUrl = new URL(resp.headers.location, url).toString();
          return resolve(await httpFetch(nextUrl, Math.max(1000, timeout - 1000), redirectsLeft - 1));
        }
        let data = '';
        resp.on('data', c => { data += c; if (data.length > 200000) resp.destroy(); });
        resp.on('end', () => { clearTimeout(timer); resolve({ contentType: resp.headers['content-type'] || '', body: data }); });
      } catch (e) { clearTimeout(timer); reject(e); }
    });
    const timer = setTimeout(() => { r.destroy(); reject(new Error('timeout')); }, timeout);
    r.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function extractRssPreview(xml) {
  const items = [];
  const re = /<item[^>]*>([\s\S]*?)<\/item>|<entry[^>]*>([\s\S]*?)<\/entry>/gi;
  let m;
  while ((m = re.exec(xml)) && items.length < 5) {
    const block = m[1] || m[2];
    const t = block.match(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/i);
    const l = block.match(/<link[^>]*href=["']([^"']+)["']/i) || block.match(/<link[^>]*>(.*?)<\/link>/i);
    items.push({ title: t ? t[1].trim() : '(untitled)', url: l ? l[1].trim() : '' });
  }
  return items;
}

async function resolveSourceUrl(url) {
  const u = url.toLowerCase();

  // Twitter/X
  if (u.includes('x.com') || u.includes('twitter.com')) {
    const listMatch = url.match(/\/i\/lists\/(\d+)/);
    if (listMatch) return { name: `X List ${listMatch[1]}`, type: 'twitter_list', config: { list_url: url }, icon: '🐦' };
    const handleMatch = url.match(/(?:x\.com|twitter\.com)\/(@?[A-Za-z0-9_]+)/);
    if (handleMatch && !['i', 'search', 'explore', 'home', 'notifications', 'messages', 'settings'].includes(handleMatch[1].toLowerCase())) {
      const handle = handleMatch[1].replace(/^@/, '');
      return { name: `@${handle}`, type: 'twitter_feed', config: { handle: `@${handle}` }, icon: '🐦' };
    }
    return { name: 'X Feed', type: 'twitter_feed', config: { handle: url }, icon: '🐦' };
  }

  // Reddit
  const redditMatch = url.match(/reddit\.com\/r\/([A-Za-z0-9_]+)/);
  if (redditMatch) return { name: `r/${redditMatch[1]}`, type: 'reddit', config: { subreddit: redditMatch[1], sort: 'hot', limit: 20 }, icon: '👽' };

  // GitHub Trending
  if (u.includes('github.com/trending')) {
    const langMatch = url.match(/\/trending\/([a-z0-9+#.-]+)/i);
    const lang = langMatch ? langMatch[1] : '';
    return { name: `GitHub Trending${lang ? ' - ' + lang : ''}`, type: 'github_trending', config: { language: lang || 'all', since: 'daily' }, icon: '⭐' };
  }

  // Hacker News
  if (u.includes('news.ycombinator.com')) return { name: 'Hacker News', type: 'hackernews', config: { filter: 'top', min_score: 100 }, icon: '🔶' };

  // Fetch URL
  const resp = await httpFetch(url);
  const ct = resp.contentType.toLowerCase();
  const body = resp.body;

  // RSS/Atom
  if (ct.includes('xml') || ct.includes('rss') || ct.includes('atom') || body.trimStart().startsWith('<?xml') || body.includes('<rss') || body.includes('<feed')) {
    if (body.includes('<rss') || body.includes('<feed') || body.includes('<channel')) {
      const titleMatch = body.match(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/);
      const name = titleMatch ? titleMatch[1].trim() : new URL(url).hostname;
      const preview = extractRssPreview(body);
      return { name, type: 'rss', config: { url }, icon: '📡', preview };
    }
  }

  // JSON Feed
  if (ct.includes('json') || body.trimStart().startsWith('{')) {
    try {
      const j = JSON.parse(body);
      if (j.version && j.version.includes('jsonfeed')) {
        const preview = (j.items || []).slice(0, 5).map(i => ({ title: i.title || '(untitled)', url: i.url }));
        return { name: j.title || new URL(url).hostname, type: 'digest_feed', config: { url }, icon: '📰', preview };
      }
    } catch { }
  }

  // HTML
  if (ct.includes('html') || body.includes('<html') || body.includes('<!DOCTYPE')) {
    const titleMatch = body.match(/<title[^>]*>(.*?)<\/title>/is);
    const name = titleMatch ? titleMatch[1].trim().replace(/\s+/g, ' ').slice(0, 100) : new URL(url).hostname;
    return { name, type: 'website', config: { url }, icon: '🌐' };
  }

  throw new Error('Cannot detect source type');
}

function normalizeItemPayload(item) {
  if (!item || !item.url) return null;
  const tags = Array.isArray(item.tags) ? item.tags : (item.tags ? [item.tags] : []);
  const metadata = item.metadata && typeof item.metadata === 'object' ? item.metadata : (item.metadata || {});
  return {
    url: String(item.url).trim(),
    title: (item.title || '').toString(),
    author: (item.author || '').toString(),
    content: (item.content || '').toString(),
    summary: (item.summary || '').toString(),
    tags: JSON.stringify(tags),
    metadata: JSON.stringify(metadata),
    published_at: item.published_at ? String(item.published_at) : null,
  };
}

function normalizeItems(items) {
  if (!Array.isArray(items)) return [];
  const normalized = [];
  for (const it of items) {
    const n = normalizeItemPayload(it);
    if (n && n.url) normalized.push(n);
  }
  return normalized;
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  let { path, params } = parseUrl(req.url);

  // ── Health check ──
  if (req.method === 'GET' && (path === '/api/health' || path === '/health')) {
    return json(res, { status: 'ok' });
  }

  // ── SPA route ──
  if (req.method === 'GET' && path === '/') {
    try {
      const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    } catch { res.writeHead(500); res.end('Internal error'); return; }
  }

  if (!path.startsWith('/api/')) {
    path = '/api' + path;
  }

  try {
    // ── Auth stub (for frontend compatibility) ──
    if (req.method === 'GET' && path === '/api/auth/config') {
      return json(res, { authEnabled: false });
    }
    if (req.method === 'GET' && path === '/api/auth/me') {
      return json(res, { user: { id: 1, name: 'Admin', email: '', avatar: '', slug: 'admin' } });
    }

    // ── Digest endpoints ──
    if (req.method === 'GET' && path === '/api/digests') {
      const type = params.get('type') || undefined;
      const limit = parseInt(params.get('limit') || '20');
      const offset = parseInt(params.get('offset') || '0');
      return json(res, listDigests(db, { type, limit, offset }));
    }

    const digestMatch = path.match(/^\/api\/digests\/(\d+)$/);
    if (req.method === 'GET' && digestMatch) {
      const d = getDigest(db, parseInt(digestMatch[1]));
      if (!d) return json(res, { error: 'not found' }, 404);
      return json(res, d);
    }

    if (req.method === 'POST' && path === '/api/digests') {
      if (!checkApiAccess(req)) return json(res, { error: 'invalid api key or permission denied' }, 401);
      const body = await parseBody(req);
      const result = createDigest(db, body);
      return json(res, result, 201);
    }

    // ── Marks endpoints ──
    if (req.method === 'GET' && path === '/api/marks') {
      const status = params.get('status') || undefined;
      return json(res, listMarks(db, { status }));
    }

    if (req.method === 'POST' && path === '/api/marks') {
      const body = await parseBody(req);
      const result = createMark(db, body);
      return json(res, { ok: true, ...result });
    }

    const markMatch = path.match(/^\/api\/marks\/(\d+)$/);
    if (req.method === 'DELETE' && markMatch) {
      deleteMark(db, parseInt(markMatch[1]));
      return json(res, { ok: true });
    }

    // Backward compat /mark
    if (req.method === 'POST' && path === '/mark') {
      const body = await parseBody(req);
      const url = (body.url || '').split('?')[0];
      if (!url) return json(res, { error: 'invalid url' }, 400);
      const result = createMark(db, { url });
      return json(res, { ok: true, status: result.duplicate ? 'already_marked' : 'marked' });
    }

    if (req.method === 'GET' && path === '/marks') {
      const marks = listMarks(db, {});
      const history = marks.map(m => ({
        action: m.status === 'processed' ? 'processed' : 'mark',
        target: m.url, at: m.created_at, title: m.title || '',
      }));
      return json(res, { tweets: marks.filter(m => m.status === 'pending').map(m => ({ url: m.url, markedAt: m.created_at })), history });
    }

    // ── Subscriptions endpoints ──
    if (req.method === 'GET' && path === '/api/subscriptions') {
      const subs = listSubscriptions(db);
      return json(res, subs.map(s => ({ ...s, sourceDeleted: !!s.is_deleted })));
    }

    if (req.method === 'POST' && path === '/api/subscriptions') {
      const body = await parseBody(req);
      if (!body.sourceId) return json(res, { error: 'sourceId required' }, 400);
      const source = getSource(db, body.sourceId);
      if (!source) return json(res, { error: 'source not found' }, 404);
      const category = (body.category || '未分类').trim();
      const subcategory = (body.subcategory || '').trim();
      db.prepare('INSERT OR IGNORE INTO user_subscriptions (source_id, category, subcategory) VALUES (?, ?, ?)').run(body.sourceId, category, subcategory);
      return json(res, { ok: true });
    }

    if (req.method === 'POST' && path === '/api/subscriptions/bulk') {
      const body = await parseBody(req);
      if (!Array.isArray(body.sourceIds)) return json(res, { error: 'sourceIds array required' }, 400);
      const added = bulkSubscribe(db, body.sourceIds);
      return json(res, { ok: true, added });
    }

    const subMatch = path.match(/^\/api\/subscriptions\/(\d+)$/);
    if (req.method === 'DELETE' && subMatch) {
      unsubscribe(db, parseInt(subMatch[1]));
      return json(res, { ok: true });
    }

    if (req.method === 'PUT' && subMatch) {
      const body = await parseBody(req);
      const category = (body.category || '未分类').trim();
      const subcategory = (body.subcategory || '').trim();
      db.prepare('UPDATE user_subscriptions SET category = ?, subcategory = ? WHERE source_id = ?').run(category, subcategory, parseInt(subMatch[1]));
      return json(res, { ok: true });
    }

    if (req.method === 'PUT' && path === '/api/subscriptions/rename-group') {
      const body = await parseBody(req);
      const { oldCategory, oldSubcategory, newCategory, newSubcategory } = body;
      if (oldCategory && newCategory !== undefined) {
        if (oldSubcategory !== undefined && newSubcategory !== undefined) {
          db.prepare('UPDATE user_subscriptions SET subcategory = ? WHERE category = ? AND subcategory = ?')
            .run(newSubcategory.trim(), oldCategory, oldSubcategory);
        } else {
          db.prepare('UPDATE user_subscriptions SET category = ? WHERE category = ?')
            .run(newCategory.trim() || '未分类', oldCategory);
        }
      }
      return json(res, { ok: true });
    }

    // ── Source resolve endpoint ──
    if (req.method === 'POST' && path === '/api/sources/resolve') {
      const body = await parseBody(req);
      const url = (body.url || '').trim();
      if (!url) return json(res, { error: 'url required' }, 400);
      try {
        const result = await resolveSourceUrl(url);
        return json(res, result);
      } catch (e) {
        return json(res, { error: e.message || 'cannot resolve' }, 422);
      }
    }

    // ── Items endpoints ──
    const sourceItemsMatch = path.match(/^\/api\/sources\/(\d+)\/items$/);
    if (req.method === 'POST' && sourceItemsMatch) {
      if (!checkApiAccess(req)) return json(res, { error: 'invalid api key or permission denied' }, 401);
      const sourceId = parseInt(sourceItemsMatch[1]);
      const source = getSource(db, sourceId);
      if (!source) return json(res, { error: 'source not found' }, 404);
      const body = await parseBody(req);
      const items = normalizeItems(body.items);
      if (!items.length) return json(res, { error: 'items array required' }, 400);
      const result = insertSourceItems(db, sourceId, items);
      updateSourceFetchStats(db, sourceId, result.added);
      return json(res, { ok: true, ...result });
    }

    if (req.method === 'POST' && path === '/api/items/bulk') {
      if (!checkApiAccess(req)) return json(res, { error: 'invalid api key or permission denied' }, 401);
      const body = await parseBody(req);
      if (!Array.isArray(body.items) || !body.items.length) {
        return json(res, { error: 'items array required' }, 400);
      }
      const bySource = new Map();
      for (const raw of body.items) {
        if (!raw || !raw.source_id) return json(res, { error: 'source_id required' }, 400);
        const sid = parseInt(raw.source_id);
        if (!bySource.has(sid)) bySource.set(sid, []);
        bySource.get(sid).push(raw);
      }
      for (const sid of bySource.keys()) {
        const source = getSource(db, sid);
        if (!source) return json(res, { error: `source not found: ${sid}` }, 404);
      }
      let added = 0;
      let duplicates = 0;
      let skipped = 0;
      for (const [sid, itemsRaw] of bySource.entries()) {
        const items = normalizeItems(itemsRaw);
        if (!items.length) continue;
        const result = insertSourceItems(db, sid, items);
        updateSourceFetchStats(db, sid, result.added);
        added += result.added;
        duplicates += result.duplicates;
        skipped += result.skipped;
      }
      return json(res, { ok: true, added, duplicates, skipped });
    }

    if (req.method === 'GET' && path === '/api/items') {
      const sourceId = params.get('source_id') ? parseInt(params.get('source_id')) : undefined;
      const sourceType = params.get('type') || undefined;
      const q = params.get('q') || undefined;
      const tag = params.get('tag') || undefined;
      const since = params.get('since') || undefined;
      const until = params.get('until') || undefined;
      const limit = parseInt(params.get('limit') || '50');
      const offset = parseInt(params.get('offset') || '0');
      const items = listItems(db, { sourceId, sourceType, q, tag, since, until, limit, offset });
      return json(res, items);
    }

    if (req.method === 'GET' && sourceItemsMatch) {
      const sourceId = parseInt(sourceItemsMatch[1]);
      const limit = parseInt(params.get('limit') || '50');
      const offset = parseInt(params.get('offset') || '0');
      const since = params.get('since') || undefined;
      const until = params.get('until') || undefined;
      const items = listItems(db, { sourceId, since, until, limit, offset });
      return json(res, items);
    }

    // ── Sources export ──
    if (req.method === 'GET' && path === '/api/sources/export') {
      const sources = listSources(db, { activeOnly: false });
      const subs = listSubscriptions(db);
      const subMap = new Map(subs.map(s => [s.id, s]));
      const exported = sources.map(s => {
        const sub = subMap.get(s.id) || {};
        let config = {};
        try { config = JSON.parse(s.config || '{}'); } catch { }
        return {
          name: s.name,
          type: s.type,
          ...config,
          category: sub.category || '',
          subcategory: sub.subcategory || '',
          is_active: s.is_active !== 0,
        };
      });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="clawfeed-sources-${new Date().toISOString().slice(0, 10)}.json"`,
      });
      res.end(JSON.stringify({ exported_at: new Date().toISOString(), sources: exported }, null, 2));
      return;
    }

    // ── Sources endpoints ──
    if (req.method === 'GET' && path === '/api/sources') {
      const sources = listSources(db, { activeOnly: false });
      const subs = new Set(listSubscriptions(db).map(s => s.id));
      return json(res, sources.map(s => ({ ...s, subscribed: subs.has(s.id) })));
    }

    const sourceMatch = path.match(/^\/api\/sources\/(\d+)$/);
    if (req.method === 'GET' && sourceMatch) {
      const s = getSource(db, parseInt(sourceMatch[1]));
      if (!s) return json(res, { error: 'not found' }, 404);
      return json(res, s);
    }

    if (req.method === 'POST' && path === '/api/sources') {
      const body = await parseBody(req);
      const result = createSource(db, body);
      if (body.category || body.subcategory) {
        const category = (body.category || '未分类').trim();
        const subcategory = (body.subcategory || '').trim();
        db.prepare('UPDATE user_subscriptions SET category = ?, subcategory = ? WHERE source_id = ?').run(category, subcategory, result.id);
      }
      return json(res, result, 201);
    }

    if (req.method === 'PUT' && sourceMatch) {
      const s = getSource(db, parseInt(sourceMatch[1]));
      if (!s) return json(res, { error: 'not found' }, 404);
      const body = await parseBody(req);
      updateSource(db, parseInt(sourceMatch[1]), body);
      return json(res, { ok: true });
    }

    if (req.method === 'DELETE' && sourceMatch) {
      const s = getSource(db, parseInt(sourceMatch[1]));
      if (!s) return json(res, { error: 'not found' }, 404);
      deleteSource(db, parseInt(sourceMatch[1]));
      return json(res, { ok: true });
    }

    // ── Config endpoints ──
    if (req.method === 'GET' && path === '/api/changelog') {
      const l = params.get('lang') || 'en';
      const suffix = l === 'zh' ? '.zh.md' : '.md';
      try {
        const content = readFileSync(join(__dirname, '..', `CHANGELOG${suffix}`), 'utf-8');
        return json(res, { content });
      } catch { return json(res, { content: '# Changelog\n\nNo changelog found.' }); }
    }

    if (req.method === 'GET' && path === '/api/roadmap') {
      const l = params.get('lang') || 'en';
      const suffix = l === 'zh' ? '.zh.md' : l === 'en' ? '.en.md' : '.md';
      try {
        const content = readFileSync(join(__dirname, '..', `ROADMAP${suffix}`), 'utf-8');
        return json(res, { content });
      } catch { return json(res, { content: '# Roadmap\n\nNo roadmap found.' }); }
    }

    if (req.method === 'GET' && path === '/api/config') {
      return json(res, getConfig(db));
    }

    if (req.method === 'PUT' && path === '/api/config') {
      if (!checkApiAccess(req)) return json(res, { error: 'invalid api key or permission denied' }, 401);
      const body = await parseBody(req);
      for (const [k, v] of Object.entries(body)) setConfig(db, k, v);
      return json(res, { ok: true });
    }

    json(res, { error: 'not found' }, 404);
  } catch (e) {
    if (e.message === 'payload too large') return json(res, { error: e.message }, 413);
    console.error(e);
    json(res, { error: e.message }, 500);
  }
});

const HOST = process.env.DIGEST_HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`🚀 ClawFeed API running on http://${HOST}:${PORT}`);
});
