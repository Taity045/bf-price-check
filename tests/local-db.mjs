import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

export function localDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  const env = { DB: { async batch(list) { return Promise.all(list.map((x) => x.run())); }, prepare(sql) {
    const stmt = db.prepare(sql);
    function bound(...args) {
      return { bind: bound, first: () => stmt.get(...args), run: () => stmt.run(...args), all: () => ({ results: stmt.all(...args) }) };
    }
    return bound();
  } } };
  return { db, env };
}
