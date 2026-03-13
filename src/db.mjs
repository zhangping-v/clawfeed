import Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

let _db;

// Run a SQL file, tolerating duplicate-column / already-exists errors
function runMigration(db, sqlFile) {
  try {
    const sql = readFileSync(join(ROOT, 'migrations', sqlFile), 'utf8');
    for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) {
      try { db.exec(stmt + ';'); } catch (e) {
        if (!e.message.includes('duplicate column') && !e.message.includes('already exists')) throw e;
      }
    }
  } catch (e) {
    if (!e.message.includes('duplicate column') && !e.message.includes('already exists')) {
      console.error(`Migration ${sqlFile}:`, e.message);
    }
  }
}

function ensureSchema(db) {
  // Core migrations (always safe to re-run)
  runMigration(db, '001_init.sql');
  runMigration(db, '003_sources.sql');
  runMigration(db, '004_feed.sql');
  runMigration(db, '007_soft_delete.sql');
  runMigration(db, '010_source_items.sql');

  // Subscriptions: we use a simplified version without user_id
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      is_active INTEGER NOT NULL DEFAULT 1,
      category TEXT NOT NULL DEFAULT '未分类',
      subcategory TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_subs_source ON user_subscriptions(source_id);
  `);
}

export function getDb(dbPath) {
  if (_db) return _db;
  const p = dbPath || join(ROOT, 'data', 'digest.db');
  _db = new Database(p);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  ensureSchema(_db);
  return _db;
}

// ── Digests ──

export function listDigests(db, { type, limit = 20, offset = 0 } = {}) {
  let sql = 'SELECT id, type, content, metadata, created_at FROM digests';
  const params = [];
  if (type) { sql += ' WHERE type = ?'; params.push(type); }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(sql).all(...params);
}

export function getDigest(db, id) {
  return db.prepare('SELECT * FROM digests WHERE id = ?').get(id);
}

export function createDigest(db, { type, content, metadata = '{}', created_at }) {
  const sql = created_at
    ? 'INSERT INTO digests (type, content, metadata, created_at) VALUES (?, ?, ?, ?)'
    : 'INSERT INTO digests (type, content, metadata) VALUES (?, ?, ?)';
  const params = created_at ? [type, content, metadata, created_at] : [type, content, metadata];
  const result = db.prepare(sql).run(...params);
  return { id: result.lastInsertRowid };
}

// ── Marks ──

export function listMarks(db, { status, limit = 100, offset = 0 } = {}) {
  let sql = 'SELECT * FROM marks';
  const params = [];
  if (status) { sql += ' WHERE status = ?'; params.push(status); }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(sql).all(...params);
}

export function createMark(db, { url, title = '', note = '' }) {
  const existing = db.prepare('SELECT id FROM marks WHERE url = ?').get(url);
  if (existing) return { id: existing.id, duplicate: true };
  const result = db.prepare('INSERT INTO marks (url, title, note) VALUES (?, ?, ?)').run(url, title, note);
  return { id: result.lastInsertRowid, duplicate: false };
}

export function deleteMark(db, id) {
  return db.prepare('DELETE FROM marks WHERE id = ?').run(id);
}

export function updateMarkStatus(db, id, status) {
  return db.prepare('UPDATE marks SET status = ? WHERE id = ?').run(status, id);
}

// ── Sources ──

export function listSources(db, { activeOnly = false } = {}) {
  let sql = 'SELECT * FROM sources WHERE is_deleted = 0';
  if (activeOnly) sql += ' AND is_active = 1';
  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all();
}

export function getSource(db, id) {
  return db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
}

export function createSource(db, { name, type, config = '{}' }) {
  const result = db.prepare(
    'INSERT INTO sources (name, type, config) VALUES (?, ?, ?)'
  ).run(name, type, typeof config === 'string' ? config : JSON.stringify(config));
  const sourceId = result.lastInsertRowid;
  // Auto-subscribe
  try {
    db.prepare('INSERT OR IGNORE INTO user_subscriptions (source_id) VALUES (?)').run(sourceId);
  } catch { }
  return { id: sourceId };
}

export function updateSource(db, id, patch) {
  const allowed = ['name', 'type', 'config', 'is_active'];
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = k === 'isActive' ? 'is_active' : k;
    if (allowed.includes(col)) {
      sets.push(`${col} = ?`);
      params.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
    }
  }
  if (!sets.length) return { changes: 0 };
  sets.push("updated_at = datetime('now')");
  params.push(id);
  return db.prepare(`UPDATE sources SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export function deleteSource(db, id) {
  return db.prepare("UPDATE sources SET is_deleted = 1, deleted_at = datetime('now') WHERE id = ?").run(id);
}

export function getSourceByTypeConfig(db, type, config) {
  return db.prepare('SELECT * FROM sources WHERE type = ? AND config = ?').get(type, config);
}

// ── Source Items ──

export function insertSourceItems(db, sourceId, items) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO source_items
      (source_id, url, title, author, content, summary, tags, metadata, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const run = db.transaction((rows) => {
    let added = 0;
    let skipped = 0;
    for (const it of rows) {
      if (!it || !it.url) { skipped += 1; continue; }
      const r = stmt.run(
        sourceId,
        it.url,
        it.title || '',
        it.author || '',
        it.content || '',
        it.summary || '',
        it.tags || '[]',
        it.metadata || '{}',
        it.published_at || null
      );
      added += r.changes;
    }
    return { added, skipped, duplicates: Math.max(0, rows.length - added - skipped) };
  });
  return run(items);
}

export function listItems(db, {
  sourceId,
  sourceType,
  q,
  tag,
  since,
  until,
  limit = 50,
  offset = 0,
} = {}) {
  let sql = `
    SELECT si.*, s.name as source_name, s.type as source_type
    FROM source_items si
    JOIN sources s ON si.source_id = s.id
    WHERE s.is_deleted = 0
  `;
  const params = [];
  if (sourceId) {
    sql += ' AND si.source_id = ?';
    params.push(sourceId);
  }
  if (sourceType) {
    sql += ' AND s.type = ?';
    params.push(sourceType);
  }
  if (q) {
    sql += ' AND (si.title LIKE ? OR si.summary LIKE ? OR si.content LIKE ?)';
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  if (tag) {
    sql += ' AND si.tags LIKE ?';
    params.push(`%${tag}%`);
  }
  if (since) {
    sql += ' AND coalesce(si.published_at, si.fetched_at) >= ?';
    params.push(since);
  }
  if (until) {
    sql += ' AND coalesce(si.published_at, si.fetched_at) <= ?';
    params.push(until);
  }
  sql += ' ORDER BY coalesce(si.published_at, si.fetched_at) DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(sql).all(...params);
}

export function updateSourceFetchStats(db, sourceId, added) {
  return db.prepare(`
    UPDATE sources
    SET last_fetched_at = datetime('now'),
        fetch_count = coalesce(fetch_count, 0) + ?
    WHERE id = ?
  `).run(added || 0, sourceId);
}

// ── Subscriptions (single-user, source-keyed) ──

export function listSubscriptions(db) {
  return db.prepare(`
    SELECT s.*, us.id as sub_id, us.created_at as subscribed_at, s.is_deleted,
           coalesce(us.category, '未分类') as category,
           coalesce(us.subcategory, '') as subcategory
    FROM user_subscriptions us
    JOIN sources s ON us.source_id = s.id
    ORDER BY us.category, us.subcategory, us.created_at DESC
  `).all();
}

export function subscribe(db, sourceId) {
  return db.prepare('INSERT OR IGNORE INTO user_subscriptions (source_id) VALUES (?)').run(sourceId);
}

export function unsubscribe(db, sourceId) {
  return db.prepare('DELETE FROM user_subscriptions WHERE source_id = ?').run(sourceId);
}

export function bulkSubscribe(db, sourceIds) {
  const stmt = db.prepare('INSERT OR IGNORE INTO user_subscriptions (source_id) VALUES (?)');
  const run = db.transaction((ids) => {
    let added = 0;
    for (const sid of ids) {
      const r = stmt.run(sid);
      added += r.changes;
    }
    return added;
  });
  return run(sourceIds);
}

// ── Config ──

export function getConfig(db) {
  const rows = db.prepare('SELECT key, value FROM config').all();
  const obj = {};
  for (const r of rows) {
    try { obj[r.key] = JSON.parse(r.value); } catch { obj[r.key] = r.value; }
  }
  return obj;
}

export function setConfig(db, key, value) {
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, v);
}
