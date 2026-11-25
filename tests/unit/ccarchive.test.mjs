// Common Crawl archive prices: product keys, the page sanity filter, the per-product filter, the load
// endpoint, and how archive rows feed the history and verdicts. No network.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { W } from "../helpers/load-worker.mjs";
import { testDb } from "../helpers/db.mjs";
import { fixture } from "../helpers/fixtures.mjs";
import { readArchivedPage, cleanSeries, toSegments, productKey } from "../../scripts/cc/read.mjs";
import { CC_SHOPS } from "../../scripts/cc/shops.mjs";

const DAY = 864e5, ago = (d) => Date.now() - d * DAY;
const shop = (name) => CC_SHOPS.find((s) => s.name === name);
const KEY = "a".repeat(40);
const page = (body, extra = "") => `<!doctype html><html><head><title>Teddy throw</title>${extra}</head><body>${body}</body></html>`;
const ld = (offer, type = "Product") => `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": type, name: "Teddy throw", offers: { "@type": "Offer", ...offer } })}</script>`;
const DUNELM = "https://www.dunelm.com/product/teddy-bear-throw-1000162540";

describe("archive product keys", () => {
  test("same key as the live check; junk link parameters removed", () => {
    assert.equal(W.archiveKey(DUNELM), W.canonicalize(new URL(DUNELM)).canon);
    assert.equal(W.archiveKey("https://www.lookfantastic.com/p/x-box/11140463/?rctxt=default&affil=thgemail"), "https://www.lookfantastic.com/p/x-box/11140463/");
    assert.equal(W.archiveKey("http://www.wickes.co.uk/Loft-Panels/p/116420?utm_source=x&gclid=1"), "https://www.wickes.co.uk/Loft-Panels/p/116420");
  });
  test("links that pick a size, colour or SKU get no key (their price can differ)", () => {
    assert.equal(W.archiveKey(DUNELM + "?defaultSkuId=30808982"), null);
    assert.equal(W.archiveKey("https://za.puma.com/pd/x/311727.html?color=01"), null);
  });
  test("Woolworths long links share the short product key", () => {
    assert.equal(W.archiveKey("https://www.woolworths.co.za/prod/Women/Bags/Camera-Bag/_/A-505151324?isFromPLP=true"), "https://www.woolworths.co.za/prod/_/A-505151324");
  });
  test("lookup keys cover www and a trailing slash", () => {
    const k = W.archiveLookupKeys("https://www.cyclelab.com/product/3002315-trainer");
    assert.ok(k.includes("https://www.cyclelab.com/product/3002315-trainer"));
    assert.ok(k.includes("https://cyclelab.com/product/3002315-trainer/"));
    assert.ok(k.length <= 8);
  });
  test("the loader uses the worker's key", () => {
    assert.equal(productKey(W, DUNELM + "?utm_source=a"), W.archiveKey(DUNELM));
  });
});

describe("archived page sanity filter", () => {
  const s = shop("Dunelm");
  test("a product page with structured price is read", () => {
    const r = readArchivedPage(W, page(ld({ price: "85.00", priceCurrency: "GBP", availability: "https://schema.org/InStock" })), DUNELM, s);
    assert.equal(r.ok, true); assert.equal(r.price, 85); assert.equal(r.currency, "GBP");
  });
  test("bot check page, out of stock, other currency, no price and zero are dropped", () => {
    assert.equal(readArchivedPage(W, fixture("cloudflare-challenge.html"), DUNELM, s).reason, "bot-page");
    assert.equal(readArchivedPage(W, page(ld({ price: "85.00", priceCurrency: "GBP", availability: "https://schema.org/OutOfStock" })), DUNELM, s).reason, "out-of-stock");
    assert.equal(readArchivedPage(W, page(ld({ price: "85.00", priceCurrency: "EUR" })), DUNELM, s).reason, "currency");
    assert.equal(readArchivedPage(W, page("<p>Hello</p>"), DUNELM, s).reason, "no-price");
    assert.notEqual(readArchivedPage(W, page(ld({ price: "0", priceCurrency: "GBP" })), DUNELM, s).ok, true);
  });
  test("a page that is not a product (no product data) is dropped", () => {
    const r = readArchivedPage(W, page(ld({ price: "85.00", priceCurrency: "GBP" }, "WebPage")), DUNELM, s);
    assert.equal(r.ok, false);
  });
  test("a copy whose canonical link names another page is dropped", () => {
    const html = page(ld({ price: "85.00", priceCurrency: "GBP" }), `<link rel="canonical" href="https://www.dunelm.com/category/throws">`);
    assert.equal(readArchivedPage(W, html, DUNELM, s).reason, "canonical-mismatch");
    const same = page(ld({ price: "85.00", priceCurrency: "GBP" }), `<link rel="canonical" href="${DUNELM}">`);
    assert.equal(readArchivedPage(W, same, DUNELM + "?utm_source=x", s).ok, true);
  });
  test("a guess from visible page text is not trusted for archive copies", () => {
    const r = readArchivedPage(W, fixture("price-block.html"), "https://www.cyclelab.com/product/1-x", shop("Cycle Lab"));
    assert.notEqual(r.ok, true);
  });
  test("a 'was' price that is lower, or more than 5x the price, is dropped", () => {
    const r = readArchivedPage(W, page(ld({ price: "10.00", priceCurrency: "GBP" }) + `<meta property="product:price:amount" content="10">`), DUNELM, s);
    assert.equal(r.was, null);
  });
});

describe("per-product filter and runs of the same price", () => {
  const pt = (d, price) => ({ t: ago(d), price, currency: "GBP", url: DUNELM, crawl: "CC-MAIN-2026-30" });
  test("a misread far from the usual price is dropped (Dunelm £14 -> £1)", () => {
    const kept = cleanSeries([pt(200, 14), pt(150, 14), pt(100, 14), pt(50, 1)]);
    assert.deepEqual(kept.map((p) => p.price), [14, 14, 14]);
  });
  test("two copies far apart: we can't tell which is right, so neither is kept", () => {
    assert.deepEqual(cleanSeries([pt(100, 1.75), pt(10, 7)]), []);
  });
  test("copies that still disagree wildly drop the product", () => {
    assert.deepEqual(cleanSeries([pt(300, 10), pt(200, 20), pt(100, 31), pt(50, 20)]), []);
  });
  test("real price changes are kept", () => {
    assert.deepEqual(cleanSeries([pt(200, 1699), pt(100, 1699), pt(30, 934)]).map((p) => p.price), [1699, 1699, 934]);
  });
  test("one row per run of the same price: first and last copy", () => {
    const segs = toSegments(cleanSeries([pt(200, 85), pt(170, 85), pt(140, 85), pt(100, 105), pt(70, 85)]));
    assert.equal(segs.length, 3);
    assert.equal(segs[0].n, 3); assert.equal(segs[0].captured_at < segs[0].last_seen, true);
    assert.deepEqual(segs.map((s) => s.price), [85, 105, 85]);
  });
});

const loadReq = (rows, { key = KEY, mode = "load" } = {}) => new Request("https://eish.veldwire.com/api/admin/archive-load", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ mode, rows }) });
const row = (o = {}) => ({ key: DUNELM, captured_at: Math.round(ago(120)), last_seen: Math.round(ago(90)), n: 3, price: 85, was: null, currency: "GBP", url: DUNELM, crawl: "CC-MAIN-2026-25", last_crawl: "CC-MAIN-2026-34", ...o });

describe("archive load endpoint", () => {
  test("hidden without the secret, or with a wrong key", async (t) => {
    const { env } = testDb(t);
    assert.equal((await W.apiArchiveLoad(loadReq([row()]), env)).status, 404);
    env.ARCHIVE_LOAD_KEY = KEY;
    assert.equal((await W.apiArchiveLoad(loadReq([row()], { key: "b".repeat(40) }), env)).status, 404);
  });
  test("loads rows once (running the same load again writes nothing)", async (t) => {
    const { env, db } = testDb(t); env.ARCHIVE_LOAD_KEY = KEY;
    const base = row();
    const r1 = await (await W.apiArchiveLoad(loadReq([base, row({ captured_at: Math.round(ago(60)), last_seen: Math.round(ago(30)), price: 105 })]), env)).json();
    assert.equal(r1.written, 2);
    const r2 = await (await W.apiArchiveLoad(loadReq([base]), env)).json();
    assert.equal(r2.written, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM archive_prices").get().n, 2);
    assert.equal(db.prepare("SELECT source FROM archive_prices LIMIT 1").get().source, "common crawl");
  });
  test("rejects rows for other shops, other currencies, junk keys, zero prices and future dates", async (t) => {
    const { env } = testDb(t); env.ARCHIVE_LOAD_KEY = KEY;
    const bad = [
      row({ key: "https://evil.example/product/1", url: "https://evil.example/product/1" }),
      row({ currency: "ZAR" }),
      row({ key: DUNELM + "?utm_source=x" }),
      row({ price: 0 }),
      row({ captured_at: Date.now() + 5 * DAY, last_seen: Date.now() + 5 * DAY }),
      row({ url: "https://www.wickes.co.uk/x/p/1" }),
      row({ was: 1000 }),
    ];
    const r = await (await W.apiArchiveLoad(loadReq(bad), env)).json();
    assert.equal(r.accepted, 0); assert.equal(r.rejected, bad.length); assert.equal(r.written, 0);
  });
  test("a daily cap stops the load", async (t) => {
    const { env } = testDb(t); env.ARCHIVE_LOAD_KEY = KEY; env.ARCHIVE_DAILY_CAP = "2";
    assert.equal((await W.apiArchiveLoad(loadReq([row()]), env)).status, 200);
    const r = await W.apiArchiveLoad(loadReq([row({ captured_at: Math.round(ago(50)), last_seen: Math.round(ago(50)) }), row({ captured_at: Math.round(ago(40)), last_seen: Math.round(ago(40)) })]), env);
    assert.equal(r.status, 429);
  });
  test("append: same price extends the latest row, a new price adds a row", async (t) => {
    const { env, db } = testDb(t); env.ARCHIVE_LOAD_KEY = KEY;
    await W.apiArchiveLoad(loadReq([row()]), env);
    const t1 = Math.round(ago(20));
    await W.apiArchiveLoad(loadReq([row({ captured_at: t1, last_seen: t1, n: 1, crawl: "CC-MAIN-2026-47", last_crawl: "CC-MAIN-2026-47" })], { mode: "append" }), env);
    let rows = db.prepare("SELECT * FROM archive_prices ORDER BY captured_at").all();
    assert.equal(rows.length, 1); assert.equal(rows[0].last_seen, t1); assert.equal(rows[0].n, 4);
    const t2 = Math.round(ago(5));
    await W.apiArchiveLoad(loadReq([row({ captured_at: t2, last_seen: t2, n: 1, price: 99, crawl: "CC-MAIN-2026-48" })], { mode: "append" }), env);
    await W.apiArchiveLoad(loadReq([row({ captured_at: t2, last_seen: t2, n: 1, price: 99, crawl: "CC-MAIN-2026-48" })], { mode: "append" }), env);
    rows = db.prepare("SELECT * FROM archive_prices ORDER BY captured_at").all();
    assert.deepEqual(rows.map((r) => r.price), [85, 99]);
  });
});

describe("archive rows in the history and verdicts", () => {
  const seed = async (env, rows) => { env.ARCHIVE_LOAD_KEY = KEY; await W.apiArchiveLoad(loadReq(rows), env); };
  test("storedHistory finds rows by the checked product's key (www / slash forms too)", async (t) => {
    const { env } = testDb(t);
    await seed(env, [row()]);
    const h = await W.storedHistory(env, "https://dunelm.com/product/teddy-bear-throw-1000162540/");
    assert.equal(h.cc.length, 1);
  });
  test("no table yet: no rows, no error", async (t) => {
    const { env, db } = testDb(t);
    db.exec("DROP TABLE archive_prices");
    assert.deepEqual(await W.archiveRows(env, ["https://x/y"], 0), []);
  });
  test("one older price from 3-6 months ago exposes an inflated 'was' price", async (t) => {
    const { env } = testDb(t);
    await seed(env, [row({ captured_at: Math.round(ago(120)), last_seen: Math.round(ago(120)), n: 1, price: 85 })]);
    const h = await W.storedHistory(env, DUNELM);
    const j = W.judge({ status: "ok", price: 85, was: 140, currency: "GBP" }, h);
    assert.equal(j.verdict, "Likely inflated was price");
    assert.equal(j.evidence.kind, "cc");
    assert.equal(j.evidence.price, 85);
  });
  test("first and last copy of a run count as two older prices; a change makes three", async (t) => {
    const { env } = testDb(t);
    await seed(env, [row({ captured_at: Math.round(ago(200)), last_seen: Math.round(ago(120)), price: 100 }), row({ captured_at: Math.round(ago(60)), last_seen: Math.round(ago(60)), n: 1, price: 100 })]);
    const h = await W.storedHistory(env, DUNELM);
    const j = W.judge({ status: "ok", price: 100, was: 160, currency: "GBP" }, h);
    assert.equal(j.n, 3);
    assert.equal(j.verdict, "Fake discount");
  });
  test("an archive price more than 3x away from today's price is never shown", async (t) => {
    const { env } = testDb(t);
    await seed(env, [row({ price: 400, captured_at: Math.round(ago(100)), last_seen: Math.round(ago(100)), n: 1 })]);
    const h = await W.storedHistory(env, DUNELM);
    const { pts } = W.historyPoints(h, "GBP", 100);
    assert.equal(pts.length, 0);
    assert.equal(W.historyPoints(h, "GBP", 300).pts.length, 1);
  });
  test("points link to Common Crawl's public index record", () => {
    const p = W.archivePoints([{ ...row(), product_key: DUNELM }], ago(365), 85);
    assert.equal(p.length, 2);
    assert.match(p[0].link, /^https:\/\/index\.commoncrawl\.org\/CC-MAIN-2026-25-index\?url=https%3A%2F%2Fwww\.dunelm\.com/);
    assert.match(p[1].link, /CC-MAIN-2026-34-index/);
  });
});
