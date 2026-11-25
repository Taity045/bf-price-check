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
