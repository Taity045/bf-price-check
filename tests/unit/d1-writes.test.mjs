// D1 free plan: 100,000 rows written per day. Rate limits must not write to D1 on Cloudflare, and a
// check must still answer when D1 refuses writes (for example when the daily limit is used up).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { W, worker } from "../helpers/load-worker.mjs";
import { testDb } from "../helpers/db.mjs";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const DOH = new Set(["1.1.1.1", "dns.google", "cloudflare-dns.com"]);
const page = (price) => new Response(`<html><head><script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "Kettle", offers: { "@type": "Offer", price, priceCurrency: "ZAR" } })}</script></head><body>ok</body></html>`, { headers: { "content-type": "text/html" } });
function net(t) {
  t.mock.method(globalThis, "fetch", async (raw) => {
    const url = new URL(raw);
    if (DOH.has(url.hostname)) return Response.json({ Status: 0, Answer: url.searchParams.get("type") === "A" ? [{ type: 1, data: "1.1.1.1" }] : [] });
    if (url.hostname === "shop.co.za") return page(499);
    return new Response("", { status: 404 });
  });
}
// A D1 that counts writes and can refuse them like D1 does when the daily limit is used up.
function writeEnv(env, { refuse = false } = {}) {
  const n = { writes: 0 };
  const isWrite = (sql) => /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER)/i.test(sql);
  const fail = () => { throw new Error("D1_ERROR: Exceeded maximum DB write limit for the day"); };
  const wrap = (sql, s) => ({
    sql, inner: s,
    bind: (...a) => wrap(sql, s.bind(...a)),
    first: async () => { if (isWrite(sql)) { n.writes++; if (refuse) fail(); } return s.first(); },
    run: async () => { if (isWrite(sql)) { n.writes++; if (refuse) fail(); } return s.run(); },
    all: async () => { if (isWrite(sql)) { n.writes++; if (refuse) fail(); } return s.all(); },
    exec: () => s.exec(),
  });
  return { n, env: { ...env, DB: {
    prepare: (sql) => wrap(sql, env.DB.prepare(sql)),
    batch: async (l) => { if (l.some((x) => isWrite(x.sql))) { n.writes++; if (refuse) fail(); } return env.DB.batch(l.map((x) => x.inner)); },
  } } };
}
const check = (env, url = "https://shop.co.za/p", ip = "203.0.113.7") =>
  worker.fetch(new Request("https://site.test/api/check?url=" + encodeURIComponent(url), { headers: { "user-agent": UA, "cf-connecting-ip": ip } }), env, { waitUntil() {} });

describe("rate limits use the Rate Limiting API when it is bound", () => {
  test("a binding answers: no D1 query at all", async (t) => {
    const { env } = testDb(t);
    const keys = [];
    const RL_CHECK = { limit: async ({ key }) => (keys.push(key), { success: keys.length <= 2 }) };
    const w = writeEnv({ ...env, RL_CHECK });
    assert.equal(await W.rateLimit(w.env, "1.2.3.4", "check"), false);
    assert.equal(await W.rateLimit(w.env, "1.2.3.4", "check"), false);
    assert.equal(await W.rateLimit(w.env, "1.2.3.4", "check"), true);
    assert.deepEqual(keys, ["check:1.2.3.4", "check:1.2.3.4", "check:1.2.3.4"]);
    assert.equal(w.n.writes, 0);
    assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM rl").first()).n, 0);
  });
  test("compare limits use their own bindings", async (t) => {
    const { env } = testDb(t);
    const seen = [];
    const fake = (name) => ({ limit: async ({ key }) => (seen.push(name + " " + key), { success: true }) });
    const e = { ...env, RL_CMP_IP: fake("ip"), RL_CMP_SHOP: fake("shop") };
    assert.equal(await W.overLimit(e, "cmp", "1.2.3.4", 240), false);
    assert.equal(await W.overLimit(e, "cmpshop", "evetech", 30), false);
    assert.deepEqual(seen, ["ip cmp:1.2.3.4", "shop cmpshop:evetech"]);
  });
  test("without a binding: the D1 table, same limit", async (t) => {
    const { env } = testDb(t);
    for (let i = 0; i < 20; i++) assert.equal(await W.rateLimit(env, "5.5.5.5", "check"), false);
    assert.equal(await W.rateLimit(env, "5.5.5.5", "check"), true);
  });
  test("the limiter fails: the request is allowed (binding or D1)", async (t) => {
    const { env } = testDb(t);
    const broken = { ...env, RL_CHECK: { limit: async () => { throw new Error("down"); } } };
    assert.equal(await W.rateLimit(broken, "1.2.3.4", "check"), false);
    const refused = writeEnv(env, { refuse: true }).env;
    assert.equal(await W.rateLimit(refused, "1.2.3.4", "check"), false);
  });
});

describe("D1 refuses writes: the check still answers", () => {
  test("a fresh check returns today's price, cached=false, tracked=false", async (t) => {
    const { env } = testDb(t);
    net(t);
    t.mock.method(console, "log", () => {});
    const w = writeEnv(env, { refuse: true });
    const r = await check(w.env);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.current.status, "ok");
    assert.equal(j.current.price, 499);
    assert.equal(j.tracked, false);
    assert.ok(w.n.writes > 0, "it did try to save");
  });
  test("the same check with D1 working saves it (control)", async (t) => {
    const { env, db } = testDb(t);
    net(t);
    const r = await check(env);
    const j = await r.json();
    assert.equal(j.current.price, 499);
    assert.equal(j.tracked, true);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM checks").get().n, 1);
  });
  test("softWrite logs one line per minute, never throws", async (t) => {
    const lines = [];
    t.mock.method(console, "log", (s) => lines.push(s));
    assert.equal(await W.softWrite("x", async () => { throw new Error("D1_ERROR: limit"); }, "fb"), "fb");
    assert.equal(await W.softWrite("y", async () => { throw new Error("D1_ERROR: limit"); }), undefined);
    assert.equal(await W.softWrite("z", async () => 7), 7);
    assert.ok(lines.length <= 1);
  });
});

describe("keepPut (D1 state for the cron, not caches)", () => {
  test("the same value again: no write while more than half its time to live is left", async (t) => {
    const { env, db } = testDb(t);
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    await W.keepPut(env, "k", { a: 1 }, 1000);
    const exp1 = db.prepare("SELECT exp FROM cache WHERE k = 'k'").get().exp;
    t.mock.timers.tick(100);
    await W.keepPut(env, "k", { a: 1 }, 1000);
    assert.equal(db.prepare("SELECT exp FROM cache WHERE k = 'k'").get().exp, exp1, "not rewritten");
    await W.keepPut(env, "k", { a: 2 }, 1000);
    assert.equal(JSON.parse(db.prepare("SELECT v FROM cache WHERE k = 'k'").get().v).a, 2, "a new value is written");
    t.mock.timers.tick(700);
    await W.keepPut(env, "k", { a: 2 }, 1000);
    assert.equal(db.prepare("SELECT exp FROM cache WHERE k = 'k'").get().exp, 1_000_000 + 800 + 1000, "refreshed when under half is left");
  });
  test("D1 refuses the write: no error", async (t) => {
    const { env } = testDb(t);
    t.mock.method(console, "log", () => {});
    await W.keepPut(writeEnv(env, { refuse: true }).env, "k", 1, 1000);
  });
});
