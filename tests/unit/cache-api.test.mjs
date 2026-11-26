// AB-44: caches run on the Cloudflare Cache API (caches.default) and memory, never on D1. D1 keeps only
// durable data (saved prices, tracked products, verdicts, alerts, requests, stats) and the cron's own
// state (robots.txt, seed list per department, one-time fix flags). Same-day copies of a price are not saved.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { W, worker } from "../helpers/load-worker.mjs";
import { testDb } from "../helpers/db.mjs";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const DOH = new Set(["1.1.1.1", "dns.google", "cloudflare-dns.com"]);
const isWrite = (sql) => /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER)/i.test(sql);

// A fake caches.default (like one Cloudflare data centre) that records every call.
function fakeCaches(t) {
  const store = new Map(), log = [];
  const url = (k) => (typeof k === "string" ? k : k.url);
  const real = globalThis.caches;
  globalThis.caches = { default: {
    match: async (k) => { log.push(["match", url(k)]); const e = store.get(url(k)); return e ? new Response(e.body, { headers: e.headers }) : undefined; },
    put: async (k, r) => { log.push(["put", url(k), r.headers.get("cache-control")]); store.set(url(k), { body: await r.text(), headers: Object.fromEntries(r.headers) }); },
    delete: async (k) => { log.push(["delete", url(k)]); return store.delete(url(k)); },
  } };
  t.after(() => { if (real === undefined) delete globalThis.caches; else globalThis.caches = real; });
  return { store, log, keys: () => [...store.keys()].map((u) => decodeURIComponent(u.slice(W.EDGE_CACHE_BASE.length))) };
}
// The test D1, with every write statement recorded (SQL text).
function countingEnv(env) {
  const writes = [];
  const wrap = (sql, s) => ({
    sql, inner: s,
    bind: (...a) => wrap(sql, s.bind(...a)),
    first: async () => { if (isWrite(sql)) writes.push(sql); return s.first(); },
    run: async () => { if (isWrite(sql)) writes.push(sql); return s.run(); },
    all: async () => { if (isWrite(sql)) writes.push(sql); return s.all(); },
  });
  return { writes, env: { ...env, DB: {
    prepare: (sql) => wrap(sql, env.DB.prepare(sql)),
    batch: async (l) => { for (const x of l) if (isWrite(x.sql)) writes.push(x.sql); return env.DB.batch(l.map((x) => x.inner)); },
  } } };
}
const cacheTableWrites = (writes) => writes.filter((s) => /\b(INTO|UPDATE)\s+cache\b/i.test(s));
// A D1 that fails on any use: caches must not need it.
const noD1 = { DB: { prepare() { throw new Error("D1 used"); }, batch() { throw new Error("D1 used"); } } };

describe("cacheGet / cachePut: Cloudflare Cache API and memory, no D1", () => {
  test("a value is put in caches.default on a synthetic URL with max-age, and read back", async (t) => {
    testDb(t);
    const c = fakeCaches(t);
    await W.cachePut(noD1, "check-v4:https://shop.co.za/p", { price: 499 }, 6 * 3600e3);
    const put = c.log.find((x) => x[0] === "put");
    assert.equal(put[1], W.EDGE_CACHE_BASE + encodeURIComponent("check-v4:https://shop.co.za/p"));
    assert.match(put[1], /^https:\/\/cache\.eish\.veldwire\.com\//);
    assert.equal(put[2], "public, max-age=21600");
    W.memCacheReset();   // a new isolate: the value comes from the Cloudflare cache
    assert.deepEqual(await W.cacheGet(noD1, "check-v4:https://shop.co.za/p"), { price: 499 });
    assert.equal(c.log.filter((x) => x[0] === "match").length, 1);
    assert.deepEqual(await W.cacheGet(noD1, "check-v4:https://shop.co.za/p"), { price: 499 });
    assert.equal(c.log.filter((x) => x[0] === "match").length, 1, "second read from memory: no Cache API call (subrequest)");
  });
  test("an expired value is not used, from memory or the Cloudflare cache", async (t) => {
    testDb(t);
    fakeCaches(t);
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    await W.cachePut(noD1, "k", 1, 1000);
    assert.equal(await W.cacheGet(noD1, "k"), 1);
    t.mock.timers.tick(1001);
    assert.equal(await W.cacheGet(noD1, "k"), null, "memory");
    W.memCacheReset();
    assert.equal(await W.cacheGet(noD1, "k"), null, "Cloudflare cache (x-exp)");
  });
  test("without caches.default (unit tests, workers.dev): memory only, no errors", async (t) => {
    testDb(t);
    const real = globalThis.caches; delete globalThis.caches;
    t.after(() => { if (real !== undefined) globalThis.caches = real; });
    await W.cachePut(noD1, "k", { a: 1 }, 60e3);
    assert.deepEqual(await W.cacheGet(noD1, "k"), { a: 1 });
    assert.equal(await W.cacheGet(noD1, "other"), null);
    await W.cacheDel(noD1, "k");
    assert.equal(await W.cacheGet(noD1, "k"), null);
  });
  test("a Cache API error is not an error for the request", async (t) => {
    testDb(t);
    const real = globalThis.caches;
    globalThis.caches = { default: { match: async () => { throw new Error("down"); }, put: async () => { throw new Error("down"); }, delete: async () => { throw new Error("down"); } } };
    t.after(() => { globalThis.caches = real; });
    await W.cachePut(noD1, "k", 1, 60e3);
    W.memCacheReset();
    assert.equal(await W.cacheGet(noD1, "k"), null);
    await W.cacheDel(noD1, "k");
  });
  test("with ctx, the Cloudflare cache write runs after the answer (waitUntil)", async (t) => {
    testDb(t);
    const c = fakeCaches(t);
    const waits = [];
    await W.cachePut(noD1, "k", 1, 60e3, { waitUntil: (p) => waits.push(p) });
    assert.equal(waits.length, 1);
    await Promise.all(waits);
    assert.ok(c.store.size === 1);
  });
  test("big values (share images) go to the Cloudflare cache, not memory", async (t) => {
    testDb(t);
    const c = fakeCaches(t);
    await W.cachePut(noD1, "og-v3:home", { b64: "x".repeat(200000) }, 60e3);
    assert.equal(c.store.size, 1);
    assert.equal((await W.cacheGet(noD1, "og-v3:home")).b64.length, 200000);
  });
});

const page = (price) => new Response(`<html><head><script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "Kettle", offers: { "@type": "Offer", price, priceCurrency: "ZAR" } })}</script></head><body>ok</body></html>`, { headers: { "content-type": "text/html" } });
function net(t, price = { v: 499 }) {
  t.mock.method(globalThis, "fetch", async (raw) => {
    const url = new URL(typeof raw === "string" ? raw : raw.url);
    if (DOH.has(url.hostname)) return Response.json({ Status: 0, Answer: url.searchParams.get("type") === "A" ? [{ type: 1, data: "1.1.1.1" }] : [] });
    if (url.hostname === "shop.co.za") return page(price.v);
    return new Response("", { status: 404 });
  });
}
const check = (env, waits, q = "") => worker.fetch(new Request("https://site.test/api/check?url=" + encodeURIComponent("https://shop.co.za/p") + q, { headers: { "user-agent": UA, "cf-connecting-ip": "203.0.113.9" } }), env, { waitUntil: (p) => waits.push(p) });

describe("live check: cached in the Cloudflare cache, prices saved in D1", () => {
  test("first check: price and tracked product in D1, answer in caches.default, zero D1 cache rows", async (t) => {
    const { env, db } = testDb(t);
    const c = fakeCaches(t);
    net(t);
    const w = countingEnv(env), waits = [];
    const j = await (await check(w.env, waits)).json();
    await Promise.all(waits);
    assert.equal(j.current.price, 499); assert.equal(j.cached, false);
    assert.deepEqual(cacheTableWrites(w.writes), [], "no write to the D1 cache table");
    assert.ok(w.writes.some((s) => /INSERT INTO checks/.test(s)), "the price is saved");
    assert.ok(c.keys().includes(W.LIVE_CACHE_PREFIX + "https://shop.co.za/p"), c.keys().join(","));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cache").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM checks").get().n, 1);
    // the same check again (another isolate in the same data centre): from the Cloudflare cache, no D1 writes
    // (rate limit on the Rate Limiting API, as on Cloudflare; the private stats counts are separate)
    W.memCacheReset();
    const rows = () => JSON.stringify(["checks", "tracked", "verdicts", "cache", "rl"].map((x) => db.prepare("SELECT * FROM " + x).all()));
    const before = rows();
    const w2 = countingEnv({ ...env, RL_CHECK: { limit: async () => ({ success: true }) } });
    const j2 = await (await check(w2.env, waits)).json();
    await Promise.all(waits);
    assert.equal(j2.cached, true); assert.equal(j2.current.price, 499);
    assert.equal(rows(), before, "a cached check writes no D1 rows (prices, products, verdicts, cache, rate limits)");
    assert.deepEqual(w2.writes.filter((x) => !/m_counts|m_seen|m_salt/.test(x) && !/INSERT INTO (tracked|verdicts)/.test(x)), [], "no other D1 write is tried (track() and the verdict write only change rows when something changed)");
    assert.deepEqual(cacheTableWrites(w2.writes), []);
  });
  test("a fresh check with the same price the same day: no second price row; a new price: saved", async (t) => {
    const { env, db } = testDb(t);
    fakeCaches(t);
    const price = { v: 499 };
    net(t, price);
    const waits = [];
    await check(env, waits); await Promise.all(waits);
    await check(env, waits, "&fresh=1"); await Promise.all(waits);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM checks").get().n, 1, "same price, same day: one row");
    price.v = 449;
    await check(env, waits, "&fresh=1"); await Promise.all(waits);
    assert.deepEqual(db.prepare("SELECT price FROM checks ORDER BY id").all().map((r) => r.price), [499, 449], "a new price is always saved");
  });
});

describe("recordCheck: durable price history", () => {
  const U = "https://shop.co.za/p";
  const cur = (ts, price, was = null, currency = "ZAR") => ({ status: "ok", checked_at: ts, price, was, currency, source: "json-ld", title: "Kettle" });
  test("saves a price; skips the same price (and was, currency) on the same UTC day; saves it again the next day", async (t) => {
    const { env, db } = testDb(t);
    const d = Date.UTC(2026, 10, 27, 8);
    assert.equal(await W.recordCheck(env, U, cur(d, 499)), true);
    assert.equal(await W.recordCheck(env, U, cur(d + 3600e3, 499)), false, "copy");
    assert.equal(await W.recordCheck(env, U, cur(d + 7200e3, 499, 599)), true, "a new was price");
    assert.equal(await W.recordCheck(env, U, cur(d + 7300e3, 499, null, "GBP")), true, "another currency");
    assert.equal(await W.recordCheck(env, U, cur(d + 864e5, 499)), true, "next day");
    assert.equal(await W.recordCheck(env, U, { status: "noprice", checked_at: d }), false, "no price: nothing");
    assert.equal(await W.recordCheck(env, "https://shop.co.za/other", cur(d, 499)), true, "another page");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM checks").get().n, 5);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM checks WHERE via IS NULL").get().n, 5, "a person's check (not the daily check)");
  });
  test("the daily check's statement is not changed", async (t) => {
    const { env, db } = testDb(t);
    const d = Date.UTC(2026, 10, 27, 8);
    await W.checkStmt(env, U, cur(d, 499), "daily").run();
    await W.checkStmt(env, U, cur(d + 60e3, 499), "daily").run();
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM checks WHERE via = 'daily'").get().n, 2);
  });
});

describe("Workers AI day count: Cache API and memory, no D1", () => {
  test("counts calls and stops at the cap, with no D1 use at all", async (t) => {
    testDb(t);
    const c = fakeCaches(t);
    assert.equal(await W.cmpAiBudget(noD1), true);
    assert.equal(await W.cmpAiBudget(noD1), true);
    assert.equal((await W.cacheGet(noD1, W.cmpAiDay())).n, 2);
    assert.ok(c.keys().includes(W.cmpAiDay()));
    await W.cachePut(noD1, W.cmpAiDay(), { n: W.CMP_AI_DAILY }, 864e5);
    assert.equal(await W.cmpAiBudget(noD1), false);
  });
});

describe("summaries and cron state", () => {
  test("/api/daily-status and /api/archive-stats: cached without D1 cache rows", async (t) => {
    const { env, db } = testDb(t);
    const c = fakeCaches(t);
    const w = countingEnv(env);
    await W.apiDailyStatus(w.env); await W.apiArchiveStats(w.env);
    await W.apiDailyStatus(w.env); await W.apiArchiveStats(w.env);
    assert.deepEqual(cacheTableWrites(w.writes), []);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cache").get().n, 0);
    assert.ok(c.keys().includes("daily-status-v1") && c.keys().includes("archive-stats-v1"), c.keys().join(","));
  });
  test("the one-time snapshot fix flag stays in D1 (the same in every data centre)", async (t) => {
    const { env, db } = testDb(t);
    fakeCaches(t);
    await W.relabelOldSnaps(env);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cache WHERE k = 'snap-relabel-v1'").get().n, 1);
    W.memCacheReset();
    assert.equal(await W.relabelOldSnaps(env), 0, "runs once");
  });
  test("keepGet/keepPut: D1, memory is not used for it", async (t) => {
    const { env, db } = testDb(t);
    await W.keepPut(env, "seed-dept:x", { n: 1 }, 60e3);
    assert.deepEqual(await W.keepGet(env, "seed-dept:x"), { n: 1 });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cache").get().n, 1);
  });
});

describe("price fix: cached answers for the product go", () => {
  test("cachePurgeProduct removes the live check and compare identity from memory and caches.default", async (t) => {
    testDb(t);
    const c = fakeCaches(t);
    const U = "https://shop.co.za/p";
    await W.cachePut(noD1, W.LIVE_CACHE_PREFIX + U, { price: 1 }, 60e3);
    await W.cachePut(noD1, "cmpid-" + W.CMP_VER + ":" + U, { title: "x" }, 60e3);
    await W.cachePut(noD1, "cmp-" + W.CMP_VER + ":fenwick:" + U, { shop: "fenwick" }, 60e3);
    await W.cachePut(noD1, W.LIVE_CACHE_PREFIX + "https://shop.co.za/other", { price: 2 }, 60e3);
    await W.cachePurgeProduct(noD1, U);
    assert.equal(await W.cacheGet(noD1, W.LIVE_CACHE_PREFIX + U), null);
    assert.equal(await W.cacheGet(noD1, "cmpid-" + W.CMP_VER + ":" + U), null);
    assert.deepEqual(await W.cacheGet(noD1, W.LIVE_CACHE_PREFIX + "https://shop.co.za/other"), { price: 2 });
    assert.ok(c.log.filter((x) => x[0] === "delete").length === 2, "two Cache API deletes (subrequests)");
  });
});
