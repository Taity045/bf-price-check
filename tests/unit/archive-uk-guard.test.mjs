// Archived copies of UK shops (Common Crawl, Internet Archive) count only when the page itself confirms
// the UK price: GBP from the page, UK VAT included, Shopify buyer country GB. No network.
import assert from "node:assert/strict";
import { describe, test, afterEach } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { W } from "../helpers/load-worker.mjs";
import { readArchivedPage } from "../../scripts/cc/read.mjs";
import { CC_SHOPS } from "../../scripts/cc/shops.mjs";

const LAKE = "https://www.lakeland.co.uk/products/ninja-af300uk-dual-zone-air-fryer";
const LAKE_SHOP = { name: "Lakeland", ccy: "GBP" };
const ld = (offer) => `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Product", name: "Ninja Dual Zone Air Fryer", offers: { "@type": "Offer", availability: "https://schema.org/InStock", ...offer } })}</script>`;
// What Lakeland's page says to a visitor in another country (Shopify Markets): GBP, but without UK VAT.
const shopify = (country, active, price) => `<!doctype html><html><head><title>Ninja</title><script>var Shopify = Shopify || {};
Shopify.shop = "lakeland-uk.myshopify.com";
Shopify.locale = "en";
Shopify.currency = {"active":"${active}","rate":"1.0"};
${country ? `Shopify.country = "${country}";` : ""}
</script>${ld({ price: String(price), priceCurrency: active })}</head><body>${"<p>Air fryer</p>".repeat(200)}</body></html>`;
const plain = (offer) => `<!doctype html><html><head><title>Throw</title>${ld(offer)}</head><body>${"<p>Throw</p>".repeat(200)}</body></html>`;
const check = (html, url, ccy) => W.archivedGeoCheck(html, url, W.extractFromHtml(html, new URL(url).hostname), ccy);

describe("UK archive guard (archivedGeoCheck)", () => {
  test("Lakeland copy made from the US (Shopify.country US): unusable, not a price", () => {
    assert.equal(check(shopify("US", "GBP", 166.66), LAKE).reason, "geo-price");
    const r = readArchivedPage(W, shopify("US", "GBP", 166.66), LAKE, LAKE_SHOP);
    assert.equal(r.ok, false); assert.equal(r.unusable, true); assert.equal(r.reason, "geo-price");
    assert.equal(readArchivedPage(W, shopify("ZA", "GBP", 166.66), LAKE, LAKE_SHOP).reason, "geo-price");
  });
  test("Lakeland copy for UK visitors (country GB, GBP) is read and marked UK-confirmed", () => {
    assert.equal(check(shopify("GB", "GBP", 199.99), LAKE), null);
    const r = readArchivedPage(W, shopify("GB", "GBP", 199.99), LAKE, LAKE_SHOP);
    assert.equal(r.ok, true); assert.equal(r.price, 199.99); assert.equal(r.geo, "GB");
  });
  test("Shopify page in another currency, or with no buyer country: unusable", () => {
    assert.equal(check(shopify("GB", "USD", 250), LAKE).reason, "geo-currency");
    assert.equal(check(shopify(null, "GBP", 199.99), LAKE).reason, "geo-unconfirmed");
  });
  test("a 'VAT not included' flag in the structured data: unusable", () => {
    const html = plain({ price: "70.00", priceCurrency: "GBP", priceSpecification: { "@type": "UnitPriceSpecification", price: "70.00", priceCurrency: "GBP", valueAddedTaxIncluded: false } });
    assert.equal(check(html, "https://www.dunelm.com/product/throw-1000162540", "GBP").reason, "ex-vat");
    const inc = plain({ price: "84.00", priceCurrency: "GBP", priceSpecification: { "@type": "UnitPriceSpecification", price: "84.00", priceCurrency: "GBP", valueAddedTaxIncluded: true } });
    assert.equal(check(inc, "https://www.dunelm.com/product/throw-1000162540", "GBP"), null);
  });
  test("the currency must come from the page, not from the .co.uk domain", () => {
    const html = `<!doctype html><html><head><title>Saw</title><meta property="og:type" content="product"><meta property="product:price:amount" content="20"></head><body>${"<p>x</p>".repeat(300)}</body></html>`;
    assert.equal(check(html, "https://www.wickes.co.uk/Saw/p/123456", "GBP").reason, "currency-unconfirmed");
    assert.equal(readArchivedPage(W, html, "https://www.wickes.co.uk/Saw/p/123456", CC_SHOPS.find((s) => s.name === "Wickes")).ok, false);
  });
  test("a UK shop on .com showing USD (Escentual): unusable", () => {
    assert.equal(check(plain({ price: "40.00", priceCurrency: "USD" }), "https://escentual.com/products/x").reason, "currency");
    assert.equal(W.ukArchiveShop("https://escentual.com/products/x"), true);
    assert.equal(W.ukArchiveShop("https://www.apple.com/uk/shop/product/x"), true);
    assert.equal(W.ukArchiveShop("https://www.takealot.com/x/PLID1"), false);
  });
  test("Amazon UK: the delivery address in the header must be in the UK", () => {
    const amz = (place, vat = "") => `<!doctype html><html><head><title>Kindle : Amazon.co.uk</title></head><body><div id="glow-ingress-block"><span id="glow-ingress-line1">${place}</span></div>
<div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">£169.99</span></span></div><div id="vatMessage_feature_div">${vat}</div><span data-currency currencyOfPreference="GBP"></span>${"<p>x</p>".repeat(300)}</body></html>`;
    const u = "https://www.amazon.co.uk/dp/B0CFPWLGF2";
    assert.equal(check(amz("Delivering to London E17 7"), u, "GBP"), null);
    assert.equal(check(amz("Deliver to United States"), u, "GBP").reason, "geo-price");
    assert.equal(check(amz(""), u, "GBP").reason, "geo-unconfirmed");
    const enc = amz("Delivering to London E17 7").replace('currencyOfPreference="GBP"', 'data-a-state="{&quot;currencyOfPreference&quot;:&quot;GBP&quot;}"');
    assert.equal(check(enc, u, "GBP"), null);
    assert.equal(check(amz("Delivering to London E17 7").replace('currencyOfPreference="GBP"', 'currencyOfPreference="USD"'), u, "GBP").reason, "currency");
    // No currency marker: the price read must be shown with a pound sign (here "£1,169.99").
    const big = amz("Delivering to London E17 7").replace('<span data-currency currencyOfPreference="GBP"></span>', "").replace("£169.99", "£1,169.99");
    assert.equal(check(big, u, "GBP"), null);
    assert.match(check(big.replace("£1,169.99", "€1,169.99"), u, "GBP").reason, /^currency/);
    // The Internet Archive's copy for a Finnish delivery address (seen on a saved AirPods copy).
    assert.equal(check(amz('<a class="a-link-normal" href="#">Deliver to Finland</a>'), u, "GBP").reason, "geo-price");
    assert.equal(check(amz("Delivering to London E17 7", "<span>Price excl. VAT</span>"), u, "GBP").reason, "ex-vat");
  });
  test("South African shops are not changed by this guard", () => {
    assert.equal(check(shopify("US", "ZAR", 115), "https://exclusivebooks.co.za/products/9780007350810"), null);
  });
});

describe("Internet Archive copies of UK shops", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const serve = (html) => { globalThis.fetch = async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } }); };
  test("an ex-VAT Lakeland copy comes back 'unusable' with no price", async () => {
    serve(shopify("US", "GBP", 166.66));
    const r = await W.fetchSnapshot("20260713215531", LAKE, LAKE);
    assert.equal(r.status, "unusable"); assert.equal(r.reason, "geo-price"); assert.equal(r.price, undefined);
  });
  test("a UK copy is read as before", async () => {
    serve(shopify("GB", "GBP", 199.99));
    const r = await W.fetchSnapshot("20260713215531", LAKE, LAKE);
    assert.equal(r.status, "ok"); assert.equal(r.price, 199.99); assert.equal(r.currency, "GBP");
  });
});

describe("archive load endpoint refuses unconfirmed UK rows", () => {
  const DUNELM = "https://www.dunelm.com/product/teddy-bear-throw-1000162540";
  const row = (o = {}) => ({ key: DUNELM, captured_at: Date.now() - 100 * 864e5, last_seen: Date.now() - 90 * 864e5, n: 2, price: 85, was: null, currency: "GBP", url: DUNELM, crawl: "CC-MAIN-2026-25", last_crawl: "CC-MAIN-2026-34", ...o });
  test("GBP rows need geo GB (set only by a loader that ran the check)", () => {
    assert.equal(W.cleanArchiveRow(row(), Date.now()), null);
    assert.equal(W.cleanArchiveRow(row({ geo: "US" }), Date.now()), null);
    assert.ok(W.cleanArchiveRow(row({ geo: "GB" }), Date.now()));
  });
  test("ZAR rows are unchanged", () => {
    const k = "https://www.cyclelab.com/product/3002315-trainer";
    assert.ok(W.cleanArchiveRow(row({ key: k, url: k, currency: "ZAR" }), Date.now()));
  });
});

describe("reduce keeps only UK-confirmed captures", () => {
  test("unchecked and unusable UK captures are left out and counted; confirmed ones are loaded with geo GB", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccgeo-"));
    try {
      const t = Date.now() - 30 * 864e5, base = "https://www.dunelm.com/product/";
      const cap = (k, crawl, price, extra = {}) => ({ crawl, shop: "Dunelm", key: base + k, url: base + k, t, ok: true, price, was: null, currency: "GBP", ...extra });
      const caps = [
        cap("a-1000000001", "CC-MAIN-2026-43", 10, { geo: "GB" }),       // read with the check
        cap("b-1000000002", "CC-MAIN-2026-43", 20),                      // old capture, confirmed by recheck
        cap("c-1000000003", "CC-MAIN-2026-43", 30),                      // old capture, recheck says unusable
        cap("d-1000000004", "CC-MAIN-2026-43", 40),                      // old capture, not rechecked yet
        cap("e-1000000005", "CC-MAIN-2026-43", 50),                      // recheck read a different price
        { crawl: "CC-MAIN-2026-43", shop: "Cashbuild", key: "https://www.cashbuild.co.za/x/123-y", url: "https://www.cashbuild.co.za/x/123-y", t, ok: true, price: 99, was: null, currency: "ZAR" },
      ];
      writeFileSync(join(dir, "captures.jsonl"), caps.map((c) => JSON.stringify(c)).join("\n") + "\n");
      writeFileSync(join(dir, "geo.jsonl"), [
        { crawl: "CC-MAIN-2026-43", key: base + "b-1000000002", price: 20, geo: "GB" },
        { crawl: "CC-MAIN-2026-43", key: base + "c-1000000003", price: 30, unusable: "geo-price" },
        { crawl: "CC-MAIN-2026-43", key: base + "e-1000000005", price: 41.67, geo: "GB" },
      ].map((c) => JSON.stringify(c)).join("\n") + "\n");
      execFileSync("node", ["scripts/cc/archive.mjs", "reduce", "--out", dir], { encoding: "utf8" });
      const rows = readFileSync(join(dir, "rows.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const keys = rows.map((r) => r.key.split("/").pop()).sort();
      assert.deepEqual(keys, ["123-y", "a-1000000001", "b-1000000002"]);
      for (const r of rows.filter((r) => r.shop === "Dunelm")) assert.ok(r.segs.every((s) => s.geo === "GB"));
      assert.ok(rows.find((r) => r.shop === "Cashbuild").segs.every((s) => s.geo === undefined));
      const sum = JSON.parse(readFileSync(join(dir, "reduce_summary.json"), "utf8"));
      assert.equal(sum.page_reads["uk-unusable"], 2); assert.equal(sum.page_reads["uk-unchecked"], 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
