import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { W, worker } from "../helpers/load-worker.mjs";
import { testDb } from "../helpers/db.mjs";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
let ipSeq = 0;

function setup(t, extraEnv = {}) {
  const { db, env } = testDb(t);
  Object.assign(env, extraEnv);
  const waits = [];
  const ip = "198.51.100." + (++ipSeq);
  const send = (body, { headers = {}, method = "POST", raw } = {}) => worker.fetch(new Request("https://site.test/api/request", {
    method,
    headers: { "content-type": "application/json", "user-agent": UA, "cf-connecting-ip": ip, ...headers },
    body: method === "GET" ? undefined : raw ?? JSON.stringify(body),
  }), env, { waitUntil: (p) => waits.push(p) });
  const rows = () => db.prepare("SELECT host, shop_text, product_url, email, ip_hash FROM shop_requests").all();
  return { db, env, send, rows, waits };
}

describe("shop request form (/api/request)", () => {
  test("valid request is stored with the shop's host and a hashed IP", async (t) => {
    const { send, rows } = setup(t);
    const r = await send({ shop: "www.Makro.co.za", product_url: "https://www.makro.co.za/p/123", email: "me@example.co.za" });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
    const [row] = rows();
    assert.equal(row.host, "makro.co.za");
    assert.equal(row.shop_text, "www.Makro.co.za");
    assert.equal(row.email, "me@example.co.za");
    assert.match(row.ip_hash, /^[0-9a-f]{32}$/);
    assert.ok(!row.ip_hash.includes("198.51"));
  });
  test("shop name only (no link, no email) is fine; host comes from the name when it looks like a domain", async (t) => {
    const { send, rows } = setup(t);
    assert.equal((await send({ shop: "Game" })).status, 200);
    assert.equal((await send({ shop: "game.co.za" })).status, 200);
    assert.deepEqual(rows().map((r) => [r.host, r.product_url, r.email]), [[null, null, null], ["game.co.za", null, null]]);
  });
  const bad = [
    ["missing shop", { product_url: "https://x.co.za/p" }, 400, /shop name/],
    ["one-letter shop", { shop: " a " }, 400, /shop name/],
    ["product link without http", { shop: "Makro", product_url: "makro.co.za/p" }, 400, /http/],
    ["javascript: product link", { shop: "Makro", product_url: "javascript:alert(1)" }, 400, /http/],
    ["bad email", { shop: "Makro", email: "not-an-email" }, 400, /email/],
    ["email without domain dot", { shop: "Makro", email: "a@b" }, 400, /email/],
  ];
  for (const [name, body, status, re] of bad) {
    test(`rejects ${name}`, async (t) => {
      const { send, rows } = setup(t);
      const r = await send(body);
      assert.equal(r.status, status);
      assert.match((await r.json()).error, re);
      assert.equal(rows().length, 0);
    });
  }
  test("rejects a body that is not JSON", async (t) => {
    const { send } = setup(t);
    assert.equal((await send(null, { raw: "{nope" })).status, 400);
    assert.equal((await send(null, { raw: "null" })).status, 400);
  });
  test("rejects the wrong content type", async (t) => {
    const { send } = setup(t);
    assert.equal((await send({ shop: "Makro" }, { headers: { "content-type": "text/plain" } })).status, 415);
  });
  test("rejects a body over 6000 characters", async (t) => {
    const { send } = setup(t);
    assert.equal((await send({ shop: "x".repeat(7000) })).status, 413);
  });
  test("GET is not allowed", async (t) => {
    const { send } = setup(t);
    assert.equal((await send(null, { method: "GET" })).status, 405);
  });
  test("long fields are cut and control characters removed", async (t) => {
    const { send, rows } = setup(t);
    assert.equal((await send({ shop: "Shop\u0000\u0007 name\n\n" + "y".repeat(400) })).status, 200);
    const [row] = rows();
    assert.equal(row.shop_text.length, 200);
    assert.ok(row.shop_text.startsWith("Shop name y"));
  });
  test("honeypot field: answers ok but stores nothing", async (t) => {
    const { send, rows } = setup(t);
    const r = await send({ shop: "Makro", website: "http://spam.example" });
    assert.equal(r.status, 200);
    assert.equal(rows().length, 0);
  });
  test("scraper user agents and other websites are refused", async (t) => {
    const { send } = setup(t);
    assert.equal((await send({ shop: "Makro" }, { headers: { "user-agent": "python-requests/2.31" } })).status, 403);
    assert.equal((await send({ shop: "Makro" }, { headers: { "user-agent": "" } })).status, 403);
    assert.equal((await send({ shop: "Makro" }, { headers: { origin: "https://evil.example" } })).status, 403);
    assert.equal((await send({ shop: "Makro" }, { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal((await send({ shop: "Makro" }, { headers: { origin: "https://site.test", "sec-fetch-site": "same-origin" } })).status, 200);
  });
  test("6th request in a minute from one address is rate limited", async (t) => {
    const { send, rows } = setup(t);
    for (let i = 0; i < 5; i++) assert.equal((await send({ shop: "Shop " + i })).status, 200);
    const r = await send({ shop: "Shop 6" });
    assert.equal(r.status, 429);
    assert.equal(rows().length, 5);
  });
  test("with Turnstile on, a missing token is refused and a good token passes", async (t) => {
    const { send, rows } = setup(t, { TURNSTILE_SITEKEY: "site", TURNSTILE_SECRET: "secret" });
    t.mock.method(globalThis, "fetch", async (raw, init) => {
      assert.equal(new URL(raw).hostname, "challenges.cloudflare.com");
      return Response.json({ success: init.body.get("response") === "good-token" });
    });
    assert.equal((await send({ shop: "Makro" })).status, 403);
    assert.equal((await send({ shop: "Makro", ts: "bad-token" })).status, 403);
    assert.equal((await send({ shop: "Makro", ts: "good-token" })).status, 200);
    assert.equal(rows().length, 1);
  });
  test("e2e test key: no rate limit, but names must start with e2e-test", async (t) => {
    const key = "k".repeat(24);
    const { send, rows } = setup(t, { E2E_KEY: key });
    assert.equal((await send({ shop: "Makro" }, { headers: { "x-e2e-key": key } })).status, 400);
    for (let i = 0; i < 7; i++) assert.equal((await send({ shop: "e2e-test " + i }, { headers: { "x-e2e-key": key } })).status, 200);
    assert.equal((await send({ shop: "e2e-test" }, { headers: { "x-e2e-key": "short" } })).status, 200, "a wrong key is a normal request");
    assert.equal(rows().length, 8);
  });
  test("owner email is sent in the background with the fields escaped", async (t) => {
    const sent = [];
    const { send, waits } = setup(t, { OWNER_EMAIL: "owner@example.com", MAIL_FROM: "no-reply@example.com", EMAIL: { send: async (m) => { sent.push(m); return { messageId: "1" }; } } });
    assert.equal((await send({ shop: "<img src=x onerror=alert(1)>", email: "me@example.co.za" })).status, 200);
    await Promise.all(waits);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "owner@example.com");
    assert.equal(sent[0].replyTo, "me@example.co.za");
    assert.ok(!sent[0].html.includes("<img"));
    assert.ok(sent[0].html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  });
});

describe("rate limiter", () => {
  test("counts per bucket and address within one minute", async (t) => {
    const { env } = testDb(t);
    t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 25, 10, 0, 5) });
    for (let i = 1; i <= W.RL.req; i++) assert.equal(await W.rateLimit(env, "1.2.3.4", "req"), false, `request ${i}`);
    assert.equal(await W.rateLimit(env, "1.2.3.4", "req"), true);
    assert.equal(await W.rateLimit(env, "1.2.3.5", "req"), false, "another address has its own count");
    assert.equal(await W.rateLimit(env, "1.2.3.4", "check"), false, "another bucket has its own count");
  });
  test("the count starts again in the next minute", async (t) => {
    const { env } = testDb(t);
    t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 25, 10, 0, 50) });
    for (let i = 0; i <= W.RL.req; i++) await W.rateLimit(env, "9.9.9.9", "req");
    assert.equal(await W.rateLimit(env, "9.9.9.9", "req"), true);
    t.mock.timers.tick(15_000);
    assert.equal(await W.rateLimit(env, "9.9.9.9", "req"), false);
  });
  test("limits per minute", () => {
    assert.deepEqual(W.RL, { check: 20, snap: 120, req: 5, verdict: 40, others: 20, search: 30 });
  });
  test("/api/check answers 429 after 20 checks a minute", async (t) => {
    const { env } = testDb(t);
    let n = 0;
    t.mock.method(globalThis, "fetch", async () => { n++; throw new Error("no network expected"); });
    for (let i = 0; i < 20; i++) await W.rateLimit(env, "203.0.113.9", "check");
    const r = await worker.fetch(new Request("https://site.test/api/check?url=" + encodeURIComponent("https://shop.co.za/p"), { headers: { "user-agent": UA, "cf-connecting-ip": "203.0.113.9" } }), env, { waitUntil() {} });
    assert.equal(r.status, 429);
    assert.equal(n, 0, "no DNS or store call once limited");
  });
});
