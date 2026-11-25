import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { W } from "../helpers/load-worker.mjs";

describe("bike, home and TV shops we check prices on", () => {
  test("on the list of shops we check", () => {
    for (const [u, name] of [["https://www.olympiccycles.co.za/products/giant-2026-talon-0", "Olympic Cycles"], ["https://mellowvelo.co.za/products/orbea-oiz-h30", "Mellow Velo"],
      ["https://dvillecyclery.co.za/product/giant-stance-black/", "Dville Cyclery"], ["https://bicyclepower.co.za/shop/kits/x/", "Bicycle Power"], ["https://evobikes.co.za/product/x/", "Evo Bikes"],
      ["https://www.cyclestore.co.uk/products/align-ii", "Cyclestore"], ["https://www.biketart.com/products/orbea-occam-sl-m30-2026", "Biketart"], ["https://www.99bikes.co.uk/products/x", "99 Bikes UK"],
      ["https://www.robertdyas.co.uk/ninja-af100uk-3-8l-air-fryer-45-grey", "Robert Dyas"], ["https://petertyson.co.uk/sony-sa-sw3", "Peter Tyson"]])
      assert.equal((W.shopFor(u) || {}).name, name, u);
  });
  test("WooCommerce shops are read from the Store API by the page's slug", () => {
    assert.equal(W.readerFor("https://dvillecyclery.co.za/product/giant-stance-black/").api, "https://dvillecyclery.co.za/wp-json/wc/store/v1/products?slug=giant-stance-black");
    assert.equal(W.readerFor("https://www.bicyclepower.co.za/shop/kits/muc-off-dark-energy-chain-care-kit/").api, "https://bicyclepower.co.za/wp-json/wc/store/v1/products?slug=muc-off-dark-energy-chain-care-kit");
    assert.equal(W.readerFor("https://evobikes.co.za/about-us/"), null, "not a product page");
    assert.equal(W.readerTarget("https://evobikes.co.za/product/kask-helmet/"), "https://evobikes.co.za/wp-json/wc/store/v1/products?slug=kask-helmet");
  });
  test("Store API answer: minor units, sale price, one price only", () => {
    const one = (prices, extra = {}) => [{ name: "Giant Stance &#8211; Black", is_in_stock: true, images: [{ src: "https://dvillecyclery.co.za/i.webp" }], prices: { currency_code: "ZAR", currency_minor_unit: 2, ...prices }, ...extra }];
    const r = W.wooProduct(one({ price: "6490000", regular_price: "7999000" }));
    assert.equal(r.price, 64900); assert.equal(r.was, 79990); assert.equal(r.currency, "ZAR"); assert.equal(r.title, "Giant Stance – Black"); assert.equal(r.source, "woo-store-api");
    assert.equal(W.wooProduct(one({ price: "4895", regular_price: "4895", currency_minor_unit: 0 })).price, 4895);
    assert.ok(W.wooProduct(one({ price: "100", price_range: { min_amount: "100", max_amount: "900" } })).error, "options at different prices");
    assert.ok(W.wooProduct([]).error); assert.ok(W.wooProduct(one({ price: "0" })).error);
    assert.ok(W.wooProduct([...one({ price: "100" }), ...one({ price: "200" })]).error, "two products for one slug: no guess");
  });
});
