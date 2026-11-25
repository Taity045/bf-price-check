// Shop readers (src/readers.js) against saved real answers and page excerpts (tests/fixtures/shops, 2026-11-25).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { W, worker } from "../helpers/load-worker.mjs";
import { fixture } from "../helpers/fixtures.mjs";
import { testDb } from "../helpers/db.mjs";

const RESOLVERS = new Set(["1.1.1.1", "dns.google"]);
const publicDns = (u) => Response.json({ Status: 0, Answer: u.searchParams.get("type") === "A" ? [{ type: 1, data: "104.16.0.1" }] : [] });
function mockNet(t, site) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (raw, init = {}) => {
    const u = new URL(raw);
    if (RESOLVERS.has(u.hostname)) return publicDns(u);
    calls.push({ url: u.href, method: init.method || "GET", headers: init.headers || {}, body: init.body });
    return site(u, init);
  });
  return calls;
}
const json = (name) => new Response(fixture("shops/" + name), { headers: { "content-type": "application/json" } });
const page = (name) => new Response(fixture("shops/" + name), { headers: { "content-type": "text/html" } });

describe("readerFor: which links get a shop reader", () => {
  test("TFG brands (Bash, Foschini, Markham, Sportscene, Totalsports, @home…) go to the Bash VTEX API by slug", () => {
    for (const u of ["https://bash.com/markham-men-s-cargo-fatigue-shorts-020203acje7/p", "https://www.markham.co.za/markham-men-s-cargo-fatigue-shorts-020203acje7/p", "https://www.sportscene.co.za/puma-men-s-inverse-mosiac-black-pink-sneaker-060601ahvh6/p?utm_source=x", "https://www.totalsports.co.za/x-130609aejk8/p/", "https://www.foschini.co.za/brushed-fleece-barrel-leg-joggers-000007abea5/p", "https://www.athome.co.za/grace-collection-smoothest-fitted-sheet-200-thread-count-153301aakf0/p"]) {
      const r = W.readerFor(u);
      assert.equal(r && r.id, "tfg-vtex", u);
      assert.match(r.api, /^https:\/\/bash\.com\/api\/catalog_system\/pub\/products\/search\/[a-z0-9-]+\/p$/);
    }
    assert.equal(W.readerFor("https://bash.com/nike"), null, "a brand page is not a product");
  });
  test("Mr Price, Mr Price Home and Mr Price Sport: store and SKU from the number at the end", () => {
    assert.deepEqual(W.readerFor("https://www.mrp.com/en_za/regular-fit-shirt-107779844"), { id: "mrp-graphql", store: "en_za", sku: "01_107779844", api: "https://apiprd.omni.mrpg.com/graphql" });
    assert.equal(W.readerFor("https://www.mrphome.com/en_za/velvet-swirl-scatter-cushion-40x60cm-106687619").sku, "02_106687619");
    assert.equal(W.readerFor("https://www.mrpsport.com/en_za/joma-victory-running-shoes-105614664").store, "mrpsport_en_za");
    assert.equal(W.readerFor("https://www.mrp.com/en_za/men"), null);
  });
  test("Pick n Pay: product code from /p/…", () => {
    assert.equal(W.readerFor("https://www.pnp.co.za/rhodes-peach-halves-in-syrup-410g/p/000000000000110557_EA").api, "https://www.pnp.co.za/pnphybris/v2/pnp-spa/products/000000000000110557_EA?fields=FULL&storeCode=WC44");
  });
  test("page readers: Cape Union Mart / Poetry, NetFlorist, Clicks, Absolute Pets; other shops: none", () => {
    assert.deepEqual(W.readerFor("https://www.capeunionmart.co.za/products/k-way-mens-edge-migo-insulated-jacket/108271108-C01.html"), { id: "sfcc-rsc", code: "108271108-C01" });
    assert.equal(W.readerFor("https://www.poetry.co.za/products/fia-bow-bucket-hat/109110860-C69.html").code, "109110860-C69");
    assert.equal(W.readerFor("https://www.netflorist.co.za/shop/flowers/classic-red-rose-bouquet").id, "netflorist");
    assert.equal(W.readerFor("https://clicks.co.za/x/p/410827").id, "clicks");
    assert.equal(W.readerFor("https://www.absolutepets.com/shop/product/festive-ostrich-sticks").id, "absolutepets");
    assert.equal(W.readerFor("https://www.evetech.co.za/x/best-deal/22831"), null);
    assert.equal(W.readerFor("https://bash.com.evil.example/x-1234/p"), null, "look-alike host");
  });
  test("readerTarget: the daily robots.txt check tests the URL we really fetch", () => {
    assert.match(W.readerTarget("https://www.markham.co.za/x-020203acje7/p"), /^https:\/\/bash\.com\/api\//);
    assert.equal(W.readerTarget("https://www.evetech.co.za/x/best-deal/22831"), "https://www.evetech.co.za/x/best-deal/22831");
  });
});

describe("API readers (saved real answers)", () => {
  test("VTEX: lowest price of a size in stock, its list price as 'was' (a cheaper sold-out colour is skipped)", () => {
    const r = W.vtexProduct(JSON.parse(fixture("shops/vtex-duvet.json")));
    assert.equal(r.price, 1299); assert.equal(r.was, null, "in-stock sizes are not on sale");
    assert.equal(r.currency, "ZAR"); assert.match(r.title, /Grace Softest/); assert.equal(r.source, "vtex-api");
    const s = W.vtexProduct(JSON.parse(fixture("shops/vtex-markham-sale.json")));
    assert.equal(s.price, 336.75); assert.equal(s.was, 449);
    assert.ok(W.vtexProduct([]).error);
  });
  test("Mr Price GraphQL: final price and regular price as 'was'; the placeholder image is dropped", () => {
    const r = W.mrpProduct(JSON.parse(fixture("shops/mrp-graphql-sale.json")));
    assert.deepEqual([r.price, r.was, r.currency, r.title, r.image], [750, 1499.99, "ZAR", "Joma Victory Running Shoes", null]);
    assert.ok(W.mrpProduct({ data: { products: { items: [] } } }).error);
  });
  test("Pick n Pay OCC: price.value; oldPrice 0 means no 'was' price", () => {
    const r = W.pnpProduct(JSON.parse(fixture("shops/pnp-occ.json")));
    assert.deepEqual([r.price, r.was, r.currency, r.title], [29.99, null, "ZAR", "Rhodes Peach Halves in Syrup 410g"]);
    assert.equal(W.pnpProduct({ name: "X", price: { value: 80, oldPrice: 100, currencyIso: "ZAR" } }).was, 100);
  });
  test("Mr Price: one POST to the GraphQL API with the store header and the SKU; the page is not fetched", async (t) => {
    const calls = mockNet(t, () => json("mrp-graphql-sale.json"));
    const r = await W.getCurrent(W.canonicalize(new URL("https://www.mrpsport.com/en_za/joma-victory-running-shoes-105614664")), "https://www.mrpsport.com/en_za/joma-victory-running-shoes-105614664", "www.mrpsport.com");
    assert.equal(r.status, "ok"); assert.equal(r.price, 750); assert.equal(r.was, 1499.99); assert.equal(r.source, "mrp-graphql");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST"); assert.equal(calls[0].headers.store, "mrpsport_en_za");
    assert.match(calls[0].body, /07_105614664/);
  });
  test("Markham link: read from the Bash API (the brand site only redirects to a brand page)", async (t) => {
    const calls = mockNet(t, (u) => (u.hostname === "bash.com" ? json("vtex-markham-sale.json") : new Response("no", { status: 500 })));
    const u = "https://www.markham.co.za/markham-men-s-cargo-fatigue-shorts-020203acje7/p";
    const r = await W.getCurrent(W.canonicalize(new URL(u)), u, "www.markham.co.za");
    assert.equal(r.price, 336.75); assert.equal(r.was, 449); assert.equal(r.source, "vtex-api");
    assert.deepEqual(calls.map((c) => new URL(c.url).hostname), ["bash.com"]);
  });
  test("an API error gives a clear 'no price' answer, not a wrong price", async (t) => {
    mockNet(t, () => new Response("[]", { headers: { "content-type": "application/json" } }));
    const u = "https://bash.com/gone-product-123456abc/p";
    const r = await W.getCurrent(W.canonicalize(new URL(u)), u, "bash.com");
    assert.equal(r.status, "noprice"); assert.equal(r.price, undefined); assert.match(r.message, /no product at this link/);
  });
});

describe("page readers (saved page excerpts)", () => {
  test("Cape Union Mart: sale price and list price from the stream data (cents)", () => {
    assert.deepEqual(W.sfccRsc(fixture("shops/cum-sale.html"), "108271108-C01"), { price: 299, was: 1299, currency: "ZAR", title: "K-WAY Men's Edge Migo Insulated Jacket", source: "rsc-data" });
  });
  test("Poetry: same platform", () => {
    const r = W.sfccRsc(fixture("shops/poetry-sale.html"), "109099909-C99");
    assert.equal(r.price, 1199.4); assert.equal(r.was, 1999); assert.equal(r.source, "rsc-data");
  });
  test("Cape Union Mart: without the product code, the schema.org offer in the stream is used", () => {
    const r = W.sfccRsc(fixture("shops/cum-sale.html"), null);
    assert.equal(r.price, 299); assert.equal(r.source, "rsc-json-ld");
  });
  test("NetFlorist: productPrice from __NEXT_DATA__, productWasPrice 0 is no 'was' price", () => {
    assert.deepEqual(W.netflorist(fixture("shops/netflorist.html")), { price: 349.95, was: null, currency: "ZAR", title: "Classic Red Rose Bouquet", source: "next-data" });
  });
  test("Clicks: the promo price shown on the page, the regular price as 'was' (not the JSON-LD regular price)", () => {
    assert.deepEqual(W.clicksPage(fixture("shops/clicks-promo.html")), { price: 279.3, was: 399, currency: "ZAR", source: "clicks-page" });
    assert.equal(W.extractFromHtml(fixture("shops/clicks-promo.html"), "clicks.co.za").price === 279.3, false, "the general reader alone gets it wrong: that is why Clicks has a reader");
  });
  test("Absolute Pets: the shelf price with VAT (R45.00), not the data layer value without VAT (39.13)", () => {
    assert.deepEqual(W.absolutePets(fixture("shops/absolutepets.html")), { price: 45, was: null, currency: "ZAR", source: "absolutepets-page" });
    assert.equal(W.extractFromHtml(fixture("shops/absolutepets.html"), "www.absolutepets.com").price, 39.13, "general reader: ex-VAT data layer");
    assert.equal(W.absolutePets(fixture("shops/absolutepets-from.html")).price, 575, "'from R575.00': the lowest size price");
  });
  test("whole check: Absolute Pets page → R45.00 from the page reader", async (t) => {
    mockNet(t, () => page("absolutepets.html"));
    const u = "https://www.absolutepets.com/shop/product/festive-ostrich-sticks";
    const r = await W.getCurrent(W.canonicalize(new URL(u)), u, "www.absolutepets.com");
    assert.equal(r.price, 45); assert.equal(r.currency, "ZAR"); assert.equal(r.source, "absolutepets-page"); assert.equal(r.currency_guessed, false);
  });
});

describe("daily check obeys robots.txt for the API it uses", () => {
  test("a Markham link is robots-checked on bash.com (the API host), not markham.co.za", async (t) => {
    const { db, env } = testDb(t);
    const u = "https://www.markham.co.za/markham-men-s-cargo-fatigue-shorts-020203acje7/p";
    db.prepare("INSERT INTO tracked (url, orig_url, title, added_at, last_viewed, last_checked, check_count) VALUES (?, ?, NULL, ?, ?, NULL, 0)").run(u, u, Date.now(), Date.now());
    const calls = mockNet(t, (x) => (x.pathname === "/robots.txt" ? new Response("User-agent: *\nDisallow: /api/\n") : json("vtex-markham-sale.json")));
    await W.runDaily(env, Date.now() - (Date.now() % 3600e3));
    assert.ok(calls.some((c) => c.url === "https://bash.com/robots.txt"), JSON.stringify(calls.map((c) => c.url)));
    assert.ok(!calls.some((c) => c.url.includes("/api/catalog_system")), "robots.txt says no: the API is not called");
  });
});
