// Fewer D1 rows written (Free plan: 100,000 a day): writes that change nothing are skipped.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { W } from "../helpers/load-worker.mjs";
import { testDb } from "../helpers/db.mjs";

const changes = (db) => Number(db.prepare("SELECT total_changes() AS n").get().n);
const H = 3600e3;
const tk = (n) => `https://www.takealot.com/product-${n}/PLID${1000 + n}`;

describe("track()", () => {
  test("the same cached answer again within 12 hours: no write, still tracked", async (t) => {
    const { db, env } = testDb(t);
    const url = "https://www.evetech.co.za/kettle";
    const cur = { status: "ok", checked_at: Date.now(), price: 99, currency: "ZAR", title: "Kettle" };
    assert.equal(await W.track(env, url, url, cur), true);
    const c0 = changes(db);
    assert.equal(await W.track(env, url, url, cur), true);
    assert.equal(changes(db), c0, "nothing written");
    // A new price read: written.
    const later = cur.checked_at + 1000;
    assert.equal(await W.track(env, url, url, { ...cur, checked_at: later, price: 89 }), true);
    assert.equal(changes(db), c0 + 1);
    assert.equal(db.prepare("SELECT last_checked FROM tracked WHERE url = ?").get(url).last_checked, later);
  });
  test("seen again after 12 hours: last_viewed moves (keeps its daily check)", async (t) => {
    const { db, env } = testDb(t);
    t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 27, 8) });
    const url = "https://www.evetech.co.za/kettle";
    const cur = { status: "ok", checked_at: Date.now(), price: 99, currency: "ZAR" };
    await W.track(env, url, url, cur);
    t.mock.timers.tick(13 * H);
    await W.track(env, url, url, cur);
    assert.equal(db.prepare("SELECT last_viewed FROM tracked WHERE url = ?").get(url).last_viewed, Date.now());
  });
  test("a seed product checked by a person becomes a person's product at once", async (t) => {
    const { db, env } = testDb(t);
    const url = tk(1), now = Date.now();
    db.prepare("INSERT INTO tracked (url, orig_url, added_at, last_viewed, last_checked, seed, lane, host, fails, next_check_at) VALUES (?, ?, ?, ?, ?, 1, 'takealot', 'takealot.com', 0, ?)").run(url, url, now, now, now, now + 23 * H);
    await W.track(env, url, url, { status: "ok", checked_at: now - 1000, price: 5, currency: "ZAR" });
    assert.equal(db.prepare("SELECT seed FROM tracked WHERE url = ?").get(url).seed, 0);
  });
  test("list full: not tracked", async (t) => {
    const { db, env } = testDb(t);
    const ins = db.prepare("INSERT INTO tracked (url, seed, last_viewed) VALUES (?, 0, ?)");
    for (let i = 0; i < W.MAX_TRACKED; i++) ins.run("https://x.co.za/" + i, Date.now());
    assert.equal(await W.track(env, "https://y.co.za/new", "https://y.co.za/new", { status: "ok", checked_at: Date.now(), price: 1 }), false);
  });
});

describe("verdicts", () => {
  test("the same verdict again: no write; a change: written", async (t) => {
    const { db, env } = testDb(t);
    const j = { verdict: "Real discount", price: 90, was: 120, currency: "ZAR", low: 85, med: 110, high: 120, high90: 120, n: 5, gap: null, archived: 0, low_t: 1 };
    const url = "https://www.evetech.co.za/kettle";
    await W.verdictStmt(env, url, "Kettle", j).run();
    const c0 = changes(db);
    await W.verdictStmt(env, url, "Kettle", j).run();
    await W.verdictStmt(env, url, null, j).run();
    assert.equal(changes(db), c0, "nothing written");
    await W.verdictStmt(env, url, "Kettle", { ...j, n: 6 }).run();
    assert.equal(changes(db), c0 + 1);
    assert.equal(db.prepare("SELECT n FROM verdicts WHERE url = ?").get(url).n, 6);
  });
});

describe("schema", () => {
  test("no index that nothing reads", (t) => {
    const { db } = testDb(t);
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name);
    assert.ok(!idx.includes("idx_tracked_last"));
    assert.ok(!idx.includes("idx_checks_via_ts"));
  });
});
