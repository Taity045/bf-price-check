import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { W } from "../helpers/load-worker.mjs";
import { testDb } from "../helpers/db.mjs";

const KEY = "k".repeat(40);
const T = W.PRICE_FIX_BEFORE;
const AF = "https://www.lakeland.co.uk/products/ninja-foodi-dual-air-fryer-7-6l-af300uk";
const CARVE = "https://www.lakeland.co.uk/products/lakeland-carving-set";
const LIBRE = "https://escentual.com/products/yves-saint-laurent-libre-eau-de-parfum-spray";
const FEN = "https://fenwick.co.uk/products/sage-the-barista-express";
const req = (body, key = KEY) => new Request("https://eish.veldwire.com/api/admin/price-fix", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify(body) });

function setup(t) {
  const { env } = testDb(t);
  env.ARCHIVE_LOAD_KEY = KEY;
  const ins = (id, url, ts, price, currency, source = "json-ld") => env.DB.prepare("INSERT INTO checks (id, url, ts, price, currency, source) VALUES (?, ?, ?, ?, ?, ?)").bind(id, url, ts, price, currency, source).run();
  // the shop now (Shopify .js for its home country)
  t.mock.method(globalThis, "fetch", async (raw) => {
    const u = new URL(raw);
    if (u.pathname.endsWith("/robots.txt")) return new Response("", { status: 404 });
    if (u.href.startsWith(CARVE + ".js?country=GB&currency=GBP")) return Response.json({ variants: [{ price: 2299 }] }, { headers: { "set-cookie": "cart_currency=GBP" } });
    return new Response("no", { status: 404 });
  });
  return { env, ins };
}
describe("price fix: geo-priced reads saved before #14", () => {
  test("hidden without the key", async (t) => {
    const { env } = setup(t);
    assert.equal((await W.apiPriceFix(req({}, "x".repeat(40)), env)).status, 404);
  });
  test("lists, then deletes only rows with evidence; correct rows, later rows and other shops stay", async (t) => {
    const { env, ins } = setup(t);
    await ins(1, AF, T - 600e3, 166.66, "GBP");        // ex-VAT: 199.99 / 166.66 = 1.2
    await ins(2, AF, T + 60e3, 199.99, "GBP");         // after the fix: stays
    await ins(3, CARVE, T - 3600e3, 19.16, "GBP");     // no later read: shop asked now (22.99 / 19.16 = 1.2)
    await ins(4, LIBRE, T - 600e3, 110, "USD");        // wrong currency
    await ins(5, LIBRE, T - 600e3, 107, "GBP", "compare-escentual"); // right currency: stays
    await ins(6, FEN, T - 600e3, 499, "GBP", "compare-fenwick");     // not geo-priced: stays
    await ins(7, AF, T - 900e3, 199.99, "GBP");        // Lakeland read with VAT before the fix: no 1.2 evidence, stays
    await env.DB.prepare("INSERT INTO verdicts (url, verdict, price, currency, updated_at) VALUES (?, 'x', 19.16, 'GBP', 1)").bind(CARVE).run();
    for (const k of [`check-v4:${CARVE}`, `cmpid-v5:${AF}`, `cmp-v5:fenwick:${AF}`, `og-v3:${AF}:123`, `cmp-v4:lakeland:https://www.dunelm.com/product/x`, `check-v4:${FEN}`])
      await env.DB.prepare("INSERT INTO cache (k, v, exp) VALUES (?, '{}', ?)").bind(k, Date.now() + 1e9).run();
    const dry = await (await W.apiPriceFix(req({}), env)).json();
    assert.equal(dry.applied, false);
    assert.deepEqual(dry.rows.map((r) => r.id).sort(), [1, 3, 4]);
    assert.equal(dry.rows.find((r) => r.id === 1).ratio_after, 1.2);
    assert.equal(dry.rows.find((r) => r.id === 3).ratio_after, 1.1999);
    assert.equal((await env.DB.prepare("SELECT count(*) n FROM checks").first()).n, 7);
    const done = await (await W.apiPriceFix(req({ apply: true }), env)).json();
    assert.equal(done.applied, true);
    assert.deepEqual(done.deleted, { checks: 3, verdicts: 1, cache: 5 });
    assert.deepEqual((await env.DB.prepare("SELECT id FROM checks ORDER BY id").all()).results.map((r) => r.id), [2, 5, 6, 7]);
    assert.deepEqual((await env.DB.prepare("SELECT k FROM cache").all()).results.map((r) => r.k), [`check-v4:${FEN}`]);
    const again = await (await W.apiPriceFix(req({ apply: true }), env)).json();
    assert.equal(again.rows.length, 0);
  });
});
describe("price fix: compare rows saved for one option of a multi-price page", () => {
  test("only compare rows at pages whose options have different prices go", async (t) => {
    const { env } = testDb(t);
    env.ARCHIVE_LOAD_KEY = KEY;
    const ED = "https://www.edgars.co.za/products/sauvage-eau-de-parfum-c29481813";
    const ONE = "https://www.edgars.co.za/products/one-size";
    t.mock.method(globalThis, "fetch", async (raw) => {
      const u = new URL(raw);
      if (u.pathname.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (u.pathname.endsWith("sauvage-eau-de-parfum-c29481813.js")) return Response.json({ variants: [{ title: "60ml", price: 235500 }, { title: "100ml", price: 324500 }] });
      if (u.pathname.endsWith("one-size.js")) return Response.json({ variants: [{ title: "Default Title", price: 10000 }] });
      return new Response("no", { status: 404 });
    });
    const ins = (id, url, price, source) => env.DB.prepare("INSERT INTO checks (id, url, ts, price, currency, source) VALUES (?, ?, ?, ?, 'ZAR', ?)").bind(id, url, Date.now(), price, source).run();
    await ins(1, ED, 3245, "compare-edgars"); await ins(2, ED, 2355, "json-ld"); await ins(3, ONE, 100, "compare-edgars");
    const dry = await (await W.apiPriceFix(req({ multi_urls: [ED, ONE] }), env)).json();
    assert.deepEqual(dry.urls.map((x) => [x.multi, x.rows.map((r) => r.id)]), [[true, [1]], [false, []]]);
    assert.equal((await env.DB.prepare("SELECT count(*) n FROM checks").first()).n, 3);
    const done = await (await W.apiPriceFix(req({ multi_urls: [ED, ONE], apply: true }), env)).json();
    assert.equal(done.deleted.checks, 1);
    assert.deepEqual((await env.DB.prepare("SELECT id FROM checks ORDER BY id").all()).results.map((r) => r.id), [2, 3]);
  });
});

describe("price fix: saved Internet Archive copies of UK shops (UK guard)", () => {
  const AMZ = "https://www.amazon.co.uk/dp/B0CHWZ9TZS";
  const page = (place) => `<!doctype html><html><head><title>AirPods : Amazon.co.uk</title></head><body><span id="glow-ingress-line1">${place}</span><div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">£185.18</span></span></div><span data-currency currencyOfPreference="GBP"></span>${"<p>x</p>".repeat(300)}</body></html>`;
  function setupSnaps(t, place) {
    const { env } = testDb(t);
    env.ARCHIVE_LOAD_KEY = KEY;
    t.mock.method(globalThis, "fetch", async (raw) => {
      const u = String(raw);
      if (u.includes("web.archive.org/web/20251129135306id_/")) return new Response(page(place), { status: 200, headers: { "content-type": "text/html" } });
      return new Response("no", { status: 404 });
    });
    return env;
  }
  const add = (env, ts, price) => env.DB.prepare("INSERT INTO product_snaps (url, snap_ts, orig, price, currency, status, fetched_at) VALUES (?, ?, ?, ?, 'GBP', 'ok', 1)").bind(AMZ, ts, AMZ + "/", price).run();
  test("a copy made for a delivery outside the UK: listed, then excluded (no price, status unusable)", async (t) => {
    const env = setupSnaps(t, "Deliver to Finland");
    await add(env, "20251129135306", 185.18);
    await add(env, "20260630043741", 165.72);
    const dry = await (await W.apiPriceFix(req({ snap_rows: [`${AMZ}|20251129135306`] }), env)).json();
    assert.equal(dry.rows[0].recheck.status, "unusable"); assert.equal(dry.rows[0].recheck.reason, "geo-price"); assert.equal(dry.excluded, 0);
    assert.equal((await env.DB.prepare("SELECT status FROM product_snaps WHERE snap_ts = '20251129135306'").first()).status, "ok");
    const done = await (await W.apiPriceFix(req({ snap_rows: [`${AMZ}|20251129135306`], apply: true }), env)).json();
    assert.equal(done.excluded, 1);
    const rows = (await env.DB.prepare("SELECT snap_ts, status, price FROM product_snaps ORDER BY snap_ts").all()).results.map((r) => ({ ...r }));
    assert.deepEqual(rows, [{ snap_ts: "20251129135306", status: "unusable", price: null }, { snap_ts: "20260630043741", status: "ok", price: 165.72 }]);
  });
  test("a copy the guard confirms as the UK price stays", async (t) => {
    const env = setupSnaps(t, "Delivering to London E17 7");
    await add(env, "20251129135306", 185.18);
    const done = await (await W.apiPriceFix(req({ snap_rows: [`${AMZ}|20251129135306`], apply: true }), env)).json();
    assert.equal(done.rows[0].recheck.status, "ok"); assert.equal(done.excluded, 0);
    assert.equal((await env.DB.prepare("SELECT status FROM product_snaps").first()).status, "ok");
  });
});
