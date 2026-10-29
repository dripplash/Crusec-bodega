CREATE TABLE IF NOT EXISTS products (
  sku TEXT PRIMARY KEY,
  relbase_id TEXT,
  name TEXT NOT NULL,
  barcode TEXT,
  brand TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  stock REAL,
  stock_updated_at TEXT,
  sync_generation TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS products_barcode_idx ON products(barcode);
CREATE INDEX IF NOT EXISTS products_name_idx ON products(name);

CREATE TABLE IF NOT EXISTS locations (
  sku TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  aisle INTEGER,
  side TEXT,
  side_label TEXT,
  rack INTEGER,
  level INTEGER,
  area_key TEXT,
  area_label TEXT,
  spot_key TEXT,
  spot_label TEXT,
  position INTEGER,
  full_label TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS history (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  sku TEXT NOT NULL,
  product_name TEXT NOT NULL,
  brand TEXT,
  action TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  before_label TEXT,
  after_label TEXT
);

CREATE INDEX IF NOT EXISTS history_sku_idx ON history(sku, created_at DESC);
CREATE INDEX IF NOT EXISTS history_created_idx ON history(created_at DESC);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  encrypted_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL,
  generation TEXT,
  next_url TEXT,
  page INTEGER NOT NULL DEFAULT 0,
  product_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  finished_at TEXT,
  error TEXT
);

INSERT OR IGNORE INTO sync_state (id, status) VALUES (1, 'idle');
