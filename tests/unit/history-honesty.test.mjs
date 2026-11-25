// Blocked archive copies (bot/check pages, empty JavaScript shells) and the copy spacing for products
// with few copies. No network: fetch is replaced in the fetchSnapshot tests.
import assert from "node:assert/strict";
import { describe, test, afterEach } from "node:test";
import { W } from "../helpers/load-worker.mjs";
import { fixture } from "../helpers/fixtures.mjs";

const text = (n) => "<p>" + "Soft cotton duvet cover with buttons. ".repeat(Math.ceil(n / 38)) + "</p>";
const product = `<html><head><title>Duvet</title><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Duvet","offers":{"@type":"Offer","price":"85.00","priceCurrency":"GBP"}}</script></head><body>${text(2000)}</body></html>`;
const ONE_MOMENT = `<!DOCTYPE html><html lang="en"><head><meta charset="utf8"><script>(function(){setTimeout(function(){window.location.reload();},5000);}())</script><title>One moment, please...</title><style>.spinner{}</style></head><body><h1>Please wait while your request is being verified...</h1><form id="wsidchk-form" action="/.well-known/sgcaptcha/" method="get"></form></body></html>`;
const SHELL = `<!doctype html><html><head><title>Takealot.com: Online Shopping</title><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { x: "y".repeat(5000) } } })}</script></head><body><div id="__next"><noscript>You need to enable JavaScript to run this app.</noscript></div></body></html>`;

describe("blocked archive copies", () => {
  test("SiteGround 'One moment, please' page is a bot page", () => {
    assert.equal(W.archivedCopyBlocked(ONE_MOMENT, W.extractFromHtml(ONE_MOMENT, "www.studio-88.co.za")).reason, "bot-page");
  });
  test("Cloudflare challenge, 'Just a moment' and DataDome pages are bot pages", () => {
    assert.equal(W.archivedCopyBlocked(fixture("cloudflare-challenge.html"), {}).reason, "bot-page");
    assert.equal(W.archivedCopyBlocked(`<html><head><title>Just a moment...</title></head><body>${text(2000)}</body></html>`, {}).reason, "bot-page");
    assert.equal(W.archivedCopyBlocked(`<html><head><title>x</title><script src="https://ct.captcha-delivery.com/c.js"></script></head><body>${text(2000)}</body></html>`, {}).reason, "bot-page");
  });
  test("an empty JavaScript shell with no price is blocked, not 'no price'", () => {
    assert.equal(W.archivedCopyBlocked(SHELL, W.extractFromHtml(SHELL, "www.takealot.com")).reason, "empty-shell");
  });
  test("a normal product page is not blocked", () => {
    assert.equal(W.archivedCopyBlocked(product, W.extractFromHtml(product, "www.dunelm.com")), null);
  });
  test("a long page without a price is 'no price', not blocked", () => {
    const html = `<html><head><title>Duvet</title></head><body>${text(3000)}</body></html>`;
    assert.equal(W.archivedCopyBlocked(html, W.extractFromHtml(html, "www.dunelm.com")), null);
  });
  test("a page with a readable price is never called a check page because of a word in it", () => {
    const html = product.replace("<title>Duvet</title>", "<title>Duvet</title><script>var sgcaptcha=1</script>");
    assert.equal(W.archivedCopyBlocked(html, W.extractFromHtml(html, "www.dunelm.com")), null);
  });
});

describe("fetchSnapshot marks blocked copies", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const serve = (html) => { globalThis.fetch = async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } }); };
  test("bot page and empty shell come back as 'blocked' with a reason", async () => {
    serve(ONE_MOMENT);
    let r = await W.fetchSnapshot("20260713215531", "https://www.studio-88.co.za/adidas-bag", "https://www.studio-88.co.za/adidas-bag");
    assert.equal(r.status, "blocked"); assert.equal(r.reason, "bot-page");
    serve(SHELL);
    r = await W.fetchSnapshot("20260713215531", "https://www.takealot.com/x/PLID1", "https://www.takealot.com/x/PLID1");
    assert.equal(r.status, "blocked"); assert.equal(r.reason, "empty-shell");
  });
  test("a product page gives its price", async () => {
    serve(product);
    const r = await W.fetchSnapshot("20260713215531", "https://www.dunelm.com/product/duvet-1", "https://www.dunelm.com/product/duvet-1");
    assert.equal(r.status, "ok"); assert.equal(r.price, 85); assert.equal(r.currency, "GBP");
  });
});

describe("copy spacing", () => {
  const day = (y, m, d) => `${y}${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}120000`;
  const rows = (days) => days.map((ts) => [ts, "https://www.dunelm.com/product/duvet-1"]);
  test("few copies: copies 1 day apart are all kept (3 older prices from 3 days)", () => {
    const p = W.pickSnaps(rows([day(2026, 9, 1), day(2026, 9, 2), day(2026, 9, 3)]));
    assert.equal(p.length, 3);
    assert.deepEqual(p.map((x) => x.ts), [day(2026, 9, 1), day(2026, 9, 2), day(2026, 9, 3)]);
  });
  test("many copies: thinned to at most 64, oldest first, newest kept", () => {
    const all = [];
    for (let i = 0; i < 300; i++) { const t = new Date(Date.UTC(2026, 0, 1) + i * 864e5); all.push(t.toISOString().slice(0, 10).replace(/-/g, "") + "120000"); }
    const p = W.pickSnaps(rows(all));
    assert.ok(p.length <= 64 && p.length >= 40, String(p.length));
    assert.equal(p[p.length - 1].ts, all[all.length - 1]);
    for (let i = 1; i < p.length; i++) assert.ok(p[i].ts > p[i - 1].ts);
  });
  test("one copy per day only (the caller dedupes days before)", () => {
    const p = W.pickSnaps(rows([day(2026, 9, 1), day(2026, 9, 5)]));
    assert.equal(p.length, 2);
  });
});

import { testDb } from "../helpers/db.mjs";
describe("price history per shop", () => {
  const DAY = 864e5, ago = (d) => Date.now() - d * DAY;
  const ymdOf = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, "") + "120000";
  test("levels: good / some / building up", () => {
    assert.equal(W.historyLevel(25, 25), "good");
    assert.equal(W.historyLevel(3, 3), "some");
    assert.equal(W.historyLevel(0, 10), "some");
    assert.equal(W.historyLevel(2, 9), "building");
    assert.equal(W.historyLevel(0, 0), "building");
  });
  test("one product key across www, trailing slash and http", () => {
    assert.equal(W.historyProductKey("http://www.dunelm.com/product/a-1/"), W.historyProductKey("https://dunelm.com/product/a-1"));
  });
  test("counted from saved checks, Wayback copies and Common Crawl rows; today's check and failed copies don't count", async (t) => {
    const { db, env } = testDb(t);
    await W.ensureArchiveTables(env);
    const dun = "https://www.dunelm.com/product/duvet-1000215618";
    // Dunelm: 1 older check + 1 Wayback copy + 1 Common Crawl run (first and last copy) = 4 older prices
    db.prepare("INSERT INTO checks (url, ts, price, currency, source) VALUES (?, ?, 85, 'GBP', 'json-ld')").run(dun, ago(10));
    db.prepare("INSERT INTO checks (url, ts, price, currency, source) VALUES (?, ?, 85, 'GBP', 'json-ld')").run(dun, Date.now() - 3600e3); // today: not older
    db.prepare("INSERT INTO product_snaps (url, snap_ts, orig, price, currency, status) VALUES (?, ?, ?, 80, 'GBP', 'ok')").run(dun, ymdOf(ago(40)), dun);
    db.prepare("INSERT INTO product_snaps (url, snap_ts, orig, status) VALUES (?, ?, ?, 'blocked')").run(dun, ymdOf(ago(50)), dun);
    db.prepare("INSERT INTO archive_prices (product_key, captured_at, last_seen, n, price, currency, url) VALUES (?, ?, ?, 2, 90, 'GBP', ?)").run("https://www.dunelm.com/product/duvet-1000215618", ago(120), ago(90), dun);
    // Takealot: only a check from today -> nothing older
    db.prepare("INSERT INTO checks (url, ts, price, currency, source) VALUES (?, ?, 100, 'ZAR', 'takealot-api')").run("https://www.takealot.com/x/PLID1", Date.now() - 3600e3);
    // Pep: one product with 1 older check
    db.prepare("INSERT INTO checks (url, ts, price, currency, source) VALUES (?, ?, 50, 'ZAR', 'json-ld')").run("https://www.pepstores.com/products/kettle-sku-a1", ago(5));
    // Lakeland: an Internet Archive copy and a Common Crawl copy of the same day + one check = 2 days, not 3
    const lak = "https://www.lakeland.co.uk/12345/some-pan";
    db.prepare("INSERT INTO product_snaps (url, snap_ts, orig, price, currency, status) VALUES (?, ?, ?, 20, 'GBP', 'ok')").run(lak, ymdOf(ago(30)), lak);
    db.prepare("INSERT INTO archive_prices (product_key, captured_at, last_seen, n, price, currency, url) VALUES (?, ?, ?, 1, 20, 'GBP', ?)").run(lak, ago(30), ago(30), lak);
    db.prepare("INSERT INTO checks (url, ts, price, currency, source) VALUES (?, ?, 20, 'GBP', 'json-ld')").run(lak, ago(3));
    const h = await W.computeShopHistory(env);
    assert.deepEqual(h.shops["Lakeland"], { any: 1, full: 0, level: "building" });
    assert.deepEqual(h.shops["Dunelm"], { any: 1, full: 1, level: "building" });
    assert.deepEqual(h.shops["Takealot"], { any: 0, full: 0, level: "building" });
    assert.deepEqual(h.shops["Pep"], { any: 1, full: 0, level: "building" });
  });
  test("/api/shops gives every shop a history level and is cached", async (t) => {
    const { db, env } = testDb(t);
    for (let i = 0; i < 30; i++) for (let d = 2; d <= 4; d++) db.prepare("INSERT INTO checks (url, ts, price, currency, source) VALUES (?, ?, 10, 'GBP', 'json-ld')").run(`https://www.dunelm.com/product/p-${1000000 + i}`, ago(d));
    const r = await (await W.apiShops(env, null)).json();
    assert.equal(r.shops.length, W.SHOP_LIST.works.length);
    const dun = r.shops.find((s) => s.name === "Dunelm");
    assert.equal(dun.history, "good"); assert.equal(dun.products_with_history, 30);
    assert.equal(dun.note, "Price history: good");
    assert.equal(dun.where, "United Kingdom");
    assert.equal(r.shops.find((s) => s.name === "Takealot").note, "We read today's price. History is building up.");
    assert.ok(r.shops.every((s) => ["good", "some", "building"].includes(s.history)));
    // cached: a new row does not change the answer until the cache is rebuilt
    db.prepare("DELETE FROM checks").run();
    const r2 = await (await W.apiShops(env, null)).json();
    assert.equal(r2.shops.find((s) => s.name === "Dunelm").history, "good");
  });
  test("works with no tables for archives yet (fresh database)", async (t) => {
    const { env } = testDb(t);
    const h = await W.computeShopHistory(env);
    assert.ok(Object.values(h.shops).every((s) => s.level === "building"));
  });
});

describe("old archive copies saved as 'no price' before the bot-check detection", () => {
  test("are marked for one more read, once, and do not count until then", async (t) => {
    const { db, env } = testDb(t);
    const u = "https://www.takealot.com/x/PLID1";
    const ins = (ts, status, at) => db.prepare("INSERT INTO product_snaps (url, snap_ts, orig, status, fetched_at, price, currency) VALUES (?, ?, ?, ?, ?, ?, ?)").run(u, ts, u, status, at, status === "ok" ? 10 : null, status === "ok" ? "ZAR" : null);
    const before = W.SNAP_DETECT_SINCE - 864e5, after = W.SNAP_DETECT_SINCE + 3600e3;
    ins("20260101120000", "noprice", before);   // old empty shell: read again
    ins("20260102120000", "noprice", null);     // very old row with no time: read again
    ins("20260103120000", "noprice", after);    // read with the new check: keep
    ins("20260104120000", "ok", before);        // a price: keep
    ins("20260105120000", "blocked", after);    // already blocked: keep
    assert.equal(await W.relabelOldSnaps(env), 2);
    const st = Object.fromEntries(db.prepare("SELECT snap_ts, status, fetched_at FROM product_snaps").all().map((r) => [r.snap_ts.slice(0, 8), r.status + ":" + r.fetched_at]));
    assert.deepEqual(st, { 20260101: "retry:0", 20260102: "retry:0", 20260103: "noprice:" + after, 20260104: "ok:" + before, 20260105: "blocked:" + after });
    // stored history leaves the copies waiting for a new read out (not "no price")
    const h = await W.storedHistory(env, u);
    assert.deepEqual(h.snaps.map((s) => s.status).sort(), ["blocked", "noprice", "ok"]);
    // runs once: a later 'no price' row from before the cutoff is not touched again
    ins("20260106120000", "noprice", before);
    assert.equal(await W.relabelOldSnaps(env), 0);
    assert.equal(db.prepare("SELECT status FROM product_snaps WHERE snap_ts = '20260106120000'").get().status, "noprice");
  });
});
