CREATE TABLE IF NOT EXISTS source_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT DEFAULT '',
  author TEXT DEFAULT '',
  content TEXT DEFAULT '',
  summary TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',
  metadata TEXT DEFAULT '{}',
  published_at TEXT,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_source_items_source_url ON source_items(source_id, url);
CREATE INDEX IF NOT EXISTS idx_source_items_source ON source_items(source_id);
CREATE INDEX IF NOT EXISTS idx_source_items_published ON source_items(published_at DESC);
