// In-memory SQLite that behaves like the parts of the D1 binding the worker uses.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export const schema = readFileSync(new URL("../../schema.sql", import.meta.url), "utf8");
// Tables the worker creates at runtime (CREATE TABLE IF NOT EXISTS). Created up front because the
// worker remembers per isolate that it already created them.
const RUNTIME = `
CREATE TABLE IF NOT EXISTS shop_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, host TEXT, shop_text TEXT NOT NULL, product_url TEXT, email TEXT, created_at INTEGER NOT NULL, ip_hash TEXT);
CREATE TABLE IF NOT EXISTS verdicts (url TEXT PRIMARY KEY, host TEXT, title TEXT, verdict TEXT, price REAL, was REAL, currency TEXT, low REAL, med REAL, high REAL, high90 REAL, n INTEGER, gap REAL, archived INTEGER DEFAULT 0, low_t INTEGER, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, orig_url TEXT, title TEXT, email TEXT NOT NULL, target REAL NOT NULL, currency TEXT, token TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, sent_at INTEGER, last_price REAL, test INTEGER DEFAULT 0);`;

export function testDb(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(schema + RUNTIME);
  const D1 = {
    prepare(sql) {
      const stmt = db.prepare(sql);
      const bound = (...args) => ({
        bind: bound,
        first: async () => stmt.get(...args) ?? null,
        run: async () => { const r = stmt.run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
        all: async () => ({ results: stmt.all(...args) }),
        // Like D1's batch(): every statement gives { results, meta }; results is empty for writes.
        exec: () => {
          if (stmt.columns().length) return { success: true, results: stmt.all(...args), meta: {} };
          const r = stmt.run(...args); return { success: true, results: [], meta: { changes: Number(r.changes) } };
        },
      });
      return bound();
    },
    // D1 runs a batch as one transaction: all statements or none.
    async batch(list) {
      db.exec("BEGIN");
      try { const out = list.map((s) => s.exec()); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; }
    },
  };
  if (t) t.after(() => db.close());
  return { db, env: { DB: D1 } };
}
