CREATE TABLE IF NOT EXISTS checks (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, ts INTEGER NOT NULL, price REAL, was REAL, currency TEXT, source TEXT, title TEXT);
CREATE INDEX IF NOT EXISTS idx_checks_url_ts ON checks(url, ts);
CREATE TABLE IF NOT EXISTS product_snaps (url TEXT NOT NULL, snap_ts TEXT NOT NULL, orig TEXT NOT NULL, price REAL, was REAL, currency TEXT, status TEXT NOT NULL DEFAULT 'pending', fetched_at INTEGER, PRIMARY KEY(url, snap_ts));
CREATE TABLE IF NOT EXISTS tracked (url TEXT PRIMARY KEY, orig_url TEXT, title TEXT, added_at INTEGER, last_viewed INTEGER, last_checked INTEGER, last_status TEXT, check_count INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_tracked_last ON tracked(last_checked);
CREATE TABLE IF NOT EXISTS cache (k TEXT PRIMARY KEY, v TEXT, exp INTEGER);
CREATE TABLE IF NOT EXISTS rl (k TEXT PRIMARY KEY, n INTEGER, win INTEGER);
