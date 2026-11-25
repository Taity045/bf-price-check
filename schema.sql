CREATE TABLE IF NOT EXISTS checks (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, ts INTEGER NOT NULL, price REAL, was REAL, currency TEXT, source TEXT, title TEXT, via TEXT);
CREATE INDEX IF NOT EXISTS idx_checks_url_ts ON checks(url, ts);
CREATE TABLE IF NOT EXISTS product_snaps (url TEXT NOT NULL, snap_ts TEXT NOT NULL, orig TEXT NOT NULL, price REAL, was REAL, currency TEXT, status TEXT NOT NULL DEFAULT 'pending', fetched_at INTEGER, PRIMARY KEY(url, snap_ts));
CREATE TABLE IF NOT EXISTS tracked (url TEXT PRIMARY KEY, orig_url TEXT, title TEXT, added_at INTEGER, last_viewed INTEGER, last_checked INTEGER, last_status TEXT, check_count INTEGER DEFAULT 0, seed INTEGER DEFAULT 0, lane TEXT, host TEXT, fails INTEGER DEFAULT 0, next_check_at INTEGER, days INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_tracked_last ON tracked(last_checked);
CREATE TABLE IF NOT EXISTS cache (k TEXT PRIMARY KEY, v TEXT, exp INTEGER);
CREATE TABLE IF NOT EXISTS rl (k TEXT PRIMARY KEY, n INTEGER, win INTEGER);
CREATE TABLE IF NOT EXISTS verdicts (url TEXT PRIMARY KEY, host TEXT, title TEXT, verdict TEXT, price REAL, was REAL, currency TEXT, low REAL, med REAL, high REAL, high90 REAL, n INTEGER, gap REAL, archived INTEGER DEFAULT 0, low_t INTEGER, updated_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_verdicts_v ON verdicts(verdict, gap);
CREATE TABLE IF NOT EXISTS alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, orig_url TEXT, title TEXT, email TEXT NOT NULL, target REAL NOT NULL, currency TEXT, token TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, sent_at INTEGER, last_price REAL, test INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_alerts_url ON alerts(url, status);
-- Daily price saving (src/daily.js). On an existing database the worker adds the new columns and
-- these indexes itself (ensureDailySchema), so this file stays safe to run again.
-- Private stats (src/stats.js): daily totals only. m_seen holds today's salted visitor hashes, m_salt today's salt; both are cleared daily.
CREATE TABLE IF NOT EXISTS m_counts (day TEXT NOT NULL, metric TEXT NOT NULL, key TEXT NOT NULL DEFAULT '', n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, metric, key));
CREATE TABLE IF NOT EXISTS m_seen (day TEXT NOT NULL, h TEXT NOT NULL, PRIMARY KEY (day, h));
CREATE TABLE IF NOT EXISTS m_salt (day TEXT PRIMARY KEY, salt TEXT NOT NULL);
