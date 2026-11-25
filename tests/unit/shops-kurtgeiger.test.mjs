// Kurt Geiger (kurtgeiger.com and global.kurtgeiger.com): its bot check (DataDome) refuses our requests
// (HTTP 403) on product pages and search, so it is on the blocked list. We never try to get past it.
// The person can type the price. The global site sets its price by the visitor's country, so the page
// asks for the currency there. Archived copies count only with a GBP price (UK guard). No network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { W, worker } from "../helpers/load-worker.mjs";
import { testDb } from "../helpers/db.mjs";

const UK = "https://www.kurtgeiger.com/women/bags/shoulder-bags/large-kensington-kurt-black-leather-kurt-geiger-london-9959800109";
const GLOBAL = "https://global.kurtgeiger.com/women/bags/shoulder-bags/large-kensington-kurt-black-leather-kurt-geiger-london-9959800109";
const DATADOME = `<html lang="en"><head><title>kurtgeiger.com</title></head><body><p id="cmsg">Please enable JS and disable any ad blocker</p><script data-cfasync="false">var dd={'rt':'c','host':'geo.captcha-delivery.com'}</script><script src="https://ct.captcha-delivery.com/c.js"></script></body></html>`;
const ld = (price, currency) => `<!doctype html><html><head><title>Large Kensington Kurt Bag</title><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Product", name: "Large Kensington Kurt Bag", offers: { "@type": "Offer", price: String(price), priceCurrency: currency, availability: "https://schema.org/InStock" } })}</script></head><body>${"<p>Bag</p>".repeat(200)}</body></html>`;

describe("Kurt Geiger", () => {
  test("both sites are on the blocked list (UK), not on the list of shops we read", () => {
    for (const u of [UK, GLOBAL, "https://kurtgeiger.com/x"]) {
      assert.equal(W.shopFor(u), null, u);
      const b = W.blockedShopFor(u);
      assert.equal(b && b.name, "Kurt Geiger", u); assert.equal(b.cc, "UK");
    }
    assert.equal(W.blockedShopFor("https://kurtgeigerfake.com/x"), null, "a look-alike domain is not Kurt Geiger");
  });
  test("UK site: price box starts at GBP; global site: no currency guess", () => {
    assert.equal(W.tldCurrency("www.kurtgeiger.com"), "GBP");
    assert.equal(W.tldCurrency("global.kurtgeiger.com"), null);
  });
  test("the DataDome page is a block, not a product page", () => {
    assert.match(W.detectBlock(403, DATADOME), /refused our request \(HTTP 403\)/);
    assert.match(W.detectBlock(200, DATADOME), /bot check/, "the captcha page is a block even with HTTP 200");
  });
  test("archived copies: only a GBP price counts (a global copy in USD or EUR is left out)", () => {
    const check = (html, url) => W.archivedGeoCheck(html, url, W.extractFromHtml(html, new URL(url).hostname));
    assert.equal(W.ukArchiveShop(UK), true); assert.equal(W.ukArchiveShop(GLOBAL), true);
    assert.equal(check(ld(299, "GBP"), UK), null);
    assert.equal(check(ld(299, "GBP"), GLOBAL), null);
    assert.ok(check(ld(395, "USD"), GLOBAL), "USD copy is unusable");
    assert.ok(check(ld(349, "EUR"), GLOBAL), "EUR copy is unusable");
    assert.ok(check(ld(299, "USD"), UK), "USD copy of the UK page is unusable");
  });
  test("UK fashion compare names Kurt Geiger as a shop we can't search (it blocks tools)", () => {
    const shoe = W.cmpIdentity({ title: "Nike Air Force 1 '07 Trainers White", brand: "Nike", price: 110, currency: "GBP" }, "https://www.jdsports.co.uk/product/x/123/");
    const p = W.cmpPlan(shoe, "www.jdsports.co.uk", "GBP");
    assert.equal(p.category, "fashion");
    assert.deepEqual(p.notSearched.filter((x) => x.name === "Kurt Geiger"), [{ name: "Kurt Geiger", why: "blocks" }]);
    assert.ok(!p.shops.some((s) => /kurt/i.test(s.name)), "never searched");
    const milk = W.cmpPlan(W.cmpIdentity({ title: "Coca-Cola Original Taste 24 x 330ml", brand: "Coca-Cola", price: 12.5, currency: "GBP" }, "https://groceries.morrisons.com/x"), "groceries.morrisons.com", "GBP");
    assert.ok(!milk.notSearched.some((x) => x.name === "Kurt Geiger"), "not named for groceries");
    assert.ok(milk.notSearched.some((x) => x.name === "Tesco"), "grocery shops are still named for groceries");
    const za = W.cmpPlan(W.cmpIdentity({ title: "Nike Air Force 1 '07 White", brand: "Nike", price: 1999, currency: "ZAR" }, "https://bash.com/x/p"), "bash.com", "ZAR");
    assert.ok(!za.notSearched.some((x) => x.name === "Kurt Geiger"), "not named for ZA");
  });
  test("result page: the global-site note asks for the currency, plain words", () => {
    const js = readFileSync(new URL("../../public/result.js", import.meta.url), "utf8");
    assert.match(js, /This is its global site\. The price changes with your country\. Type the price and choose its currency below\./);
  });
});

describe("Kurt Geiger in /api/check (mocked shop, no network)", () => {
  const run = async (t, url) => {
    const { env } = testDb(t);
    const real = globalThis.fetch, asked = [];
    globalThis.fetch = async (input) => {
      const u = typeof input === "string" ? input : input.url; asked.push(u);
      if (/dns-query|dns\.google/.test(u)) return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }] }), { headers: { "content-type": "application/dns-json" } });
      if (/kurtgeiger\.com/.test(u)) return new Response(DATADOME, { status: 403, headers: { "content-type": "text/html", "x-datadome": "protected" } });
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    };
    t.after(() => { globalThis.fetch = real; });
    const waits = [];
    const r = await worker.fetch(new Request("https://site.test/api/check?url=" + encodeURIComponent(url), { headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0 Safari/537.36", "cf-connecting-ip": "198.51.100." + (Math.random() * 200 | 0) } }), env, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    return { body: await r.json(), asked };
  };
  test("UK link: blocked, no price, named as Kurt Geiger, GBP for the price box", async (t) => {
    const { body, asked } = await run(t, UK);
    assert.equal(body.current.status, "blocked"); assert.equal(body.current.price, undefined);
    assert.deepEqual(body.blocked_shop, { name: "Kurt Geiger" });
    assert.equal(body.tld_currency, "GBP");
    assert.equal(asked.filter((u) => /^https:\/\/(www\.)?kurtgeiger\.com\//.test(u)).length, 1, "one request to the shop, no retry against its bot check");
  });
  test("global link: blocked, marked as a country-priced site, no currency guess", async (t) => {
    const { body } = await run(t, GLOBAL);
    assert.equal(body.current.status, "blocked");
    assert.deepEqual(body.blocked_shop, { name: "Kurt Geiger", geo: true });
    assert.equal(body.tld_currency, null);
  });
});
