import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { W } from "../helpers/load-worker.mjs";

const id = (title, extra = {}, url = "https://www.takealot.com/x/PLID1") => W.cmpIdentity({ title, price: 1000, currency: "ZAR", ...extra }, url);
const ids = (plan) => plan.shops.map((s) => s.id);
const BIKE_ZA = ["olympiccycles", "mellowvelo", "dville", "bicyclepower", "evobikes"];
const BIKE_UK = ["cyclestore", "biketart", "99bikes"];

describe("compare: kind of product picks the shops", () => {
  test("bike words in the title", () => {
    for (const t of ["Giant Propel Advanced 2 Carbon Road Bike 2026", "Scott Spark 960 Full Suspension MTB", "Shimano 105 R7100 12-speed groupset", "Specialized Align II Bike Helmet", "Kids Balance Bike 12 inch"])
      assert.equal(W.cmpCategory(id(t)), "cycling", t);
    for (const t of ["Trojan Exercise Bike", "Kids Ride-On Motorbike 6V", "Samsung 55 inch Crystal UHD Smart TV"])
      assert.notEqual(W.cmpCategory(id(t)), "cycling", t);
  });
  test("the shop's own category when the title has no telling words", () => {
    assert.equal(W.cmpCategory(id("Occam SL M30 2026", { category: "Mountain Bikes" }, "https://www.example.co.uk/p/1")), "cycling");
    assert.equal(W.cmpCategory(id("Ninja Foodi Max 9.5L", { category: "Small Appliances > Air Fryers" }, "https://www.example.co.uk/p/1")), "appliances");
    // the title wins over broad breadcrumbs (except a bike shop's)
    assert.equal(W.cmpCategory(id("Philips Airfryer 6.2L", { category: "Home & Garden" }, "https://www.example.co.uk/p/1")), "appliances");
    assert.equal(W.cmpCategory(id("Occam SL M30 2026", {}, "https://www.example.co.uk/p/1")), null);
  });
  test("a bike shop's page is a bike-shop item", () => {
    assert.equal(W.cmpCategory(id("Orbea Oiz H30 2025", {}, "https://www.cyclelab.com/product/1")), "cycling");
    assert.equal(W.cmpCategory(id("Orbea Oiz H30 2025", {}, "https://www.olympiccycles.co.za/products/x")), "cycling");
  });
  test("a bike is compared only with bike shops and general shops (South Africa)", () => {
    const p = W.cmpPlan(id("Giant Propel Advanced 2 Carbon Road Bike 2026", {}, "https://www.cyclelab.com/product/1"), "www.cyclelab.com", "ZAR");
    assert.equal(p.category, "cycling"); assert.equal(p.noun, "bikes and cycling gear");
    assert.deepEqual(ids(p), [...BIKE_ZA, "takealot", "loot"]);
    assert.equal(p.specialists, 5);
    for (const no of ["evetech", "hirschs", "exclusivebooks", "cyclelab", "dischem"]) assert.ok(!ids(p).includes(no), no);
  });
  test("a bike in the UK: only UK bike shops, not the shop it came from", () => {
    const p = W.cmpPlan(id("Occam SL M30 2026", { currency: "GBP", brand: "Orbea", category: "Mountain Bikes" }, "https://www.biketart.com/products/orbea-occam-sl-m30-2026"), "www.biketart.com", "GBP");
    assert.deepEqual(ids(p), BIKE_UK.filter((x) => x !== "biketart"));
  });
  test("an unknown kind of product: only general shops", () => {
    const p = W.cmpPlan(id("Zorblax 3000", {}, "https://www.example.co.za/p/1"), "www.example.co.za", "ZAR");
    assert.equal(p.category, null); assert.equal(p.specialists, 0);
    assert.ok(p.shops.every((s) => s.general), ids(p).join());
    assert.deepEqual(W.cmpPlan(id("Zorblax 3000", { currency: "GBP" }, "https://www.example.co.uk/p/1"), "www.example.co.uk", "GBP").shops, []);
  });
  test("bike shops are never searched for other kinds of product", () => {
    const p = W.cmpPlan(id("Samsung 55 inch Crystal UHD Smart TV", { brand: "Samsung" }), "www.takealot.com", "ZAR");
    for (const b of [...BIKE_ZA, ...BIKE_UK]) assert.ok(!ids(p).includes(b), b);
  });
  test("a brand's own shop still sees its products when the kind is unknown", () => {
    assert.ok(ids(W.cmpPlan(id("Puma Speedcat OG", { brand: "Puma" }), "superbalist.com", "ZAR")).includes("puma"));
  });
  test("bike searches use brand and model first", () => {
    assert.equal(W.cmpCoreQuery(id("Giant Propel Advanced 2 Carbon Road Bike 2026")), "giant propel advanced 2");
  });
});

describe("compare: bike model years", () => {
  const src = id("Giant Propel Advanced 2 2027", { brand: "Giant", price: 59990 }, "https://www.olympiccycles.co.za/products/x");
  const cand = (title, extra = {}) => ({ title, brand: "Giant", price: 58000, gtins: [], ...extra });
  test("same year matches, MY26 is 2026", () => {
    assert.equal(W.cmpMatch(src, cand("Giant Propel Advanced 2 2027")).level, "name");
    assert.deepEqual([...W.cmpAttrs("Orbea Orca M30 Iris White – MY26").year], [2026]);
    assert.equal(W.cmpMatch(id("Orbea 2026 Orca M30", { brand: "Orbea", price: 54999 }, "https://www.olympiccycles.co.za/products/x"), cand("Orbea Orca M30 Iris White – MY26", { brand: null })).level, "name");
  });
  test("another year or no year is not the same bike", () => {
    assert.equal(W.cmpMatch(src, cand("Giant 2025 Propel Advanced 2")).why, "different year");
    assert.equal(W.cmpMatch(src, cand("New Giant Propel Advanced 2 – Cobalt")).why, "no model year");
    assert.equal(W.cmpMatch(src, cand("Giant Propel Advanced 2", { url: "https://x.co.za/p/giant-propel-advanced-2-2027" })).level, "name");
    assert.equal(W.cmpMatch(src, cand("Giant Propel Advanced 2", { url: "https://x.co.za/p/giant-propel-advanced-2-2025" })).why, "different year");
  });
  test("other kinds keep the old rule (a year on one side only is fine)", () => {
    assert.equal(W.cmpMatch(id("Apple AirPods 4 2024", { brand: "Apple" }), { title: "Apple AirPods 4", brand: "Apple", price: 1000, gtins: [] }).level, "name");
  });
});

describe("compare: WooCommerce Store API results", () => {
  const shop = { id: "dville", name: "Dville Cyclery", cur: "ZAR", kind: "woo", base: "https://dvillecyclery.co.za" };
  test("price in minor units, sale price, link on the shop", () => {
    const c = W.cmpWooItem(shop, { name: "Orbea Orca M30 Iris White &#8211; MY26", slug: "orbea-orca-m30-iris-white-my26", permalink: "https://dvillecyclery.co.za/product/orbea-orca-m30/", sku: "N10305", is_in_stock: true,
      prices: { price: "5999900", regular_price: "6499900", sale_price: "5999900", currency_code: "ZAR", currency_minor_unit: 2 } });
    assert.equal(c.title, "Orbea Orca M30 Iris White – MY26"); assert.equal(c.price, 59999); assert.equal(c.was, 64999); assert.equal(c.mpn, "N10305"); assert.equal(c.in_stock, true);
    assert.equal(W.cmpWooItem(shop, { name: "X", permalink: "https://dvillecyclery.co.za/p/x", prices: { price: "37999", currency_code: "ZAR", currency_minor_unit: 0 } }).price, 37999);
  });
  test("refuses another currency, a link to another site, and a price range", () => {
    assert.equal(W.cmpWooItem(shop, { name: "X", permalink: "https://dvillecyclery.co.za/p/x", prices: { price: "100", currency_code: "USD", currency_minor_unit: 2 } }), null);
    assert.equal(W.cmpWooItem(shop, { name: "X", permalink: "https://evil.example/p/x", prices: { price: "100", currency_code: "ZAR", currency_minor_unit: 2 } }).url, null);
    assert.equal(W.cmpWooItem(shop, { name: "X", permalink: "https://dvillecyclery.co.za/p/x", prices: { price: "100", currency_code: "ZAR", currency_minor_unit: 2, price_range: { min_amount: "100", max_amount: "900" } } }).range, true);
  });
});

describe("page reading: the shop's category", () => {
  test("JSON-LD category and breadcrumbs", () => {
    const html = `<script type="application/ld+json">{"@type":"Product","name":"Occam SL M30 2026","category":"Mountain Bikes","offers":{"price":"3399","priceCurrency":"GBP"}}</script>
<script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[{"name":"Home"},{"name":"Bikes"},{"name":"Mountain Bikes"},{"name":"Occam SL M30 2026"}]}</script>`;
    const ex = W.extractFromHtml(html, "www.example.co.uk");
    assert.equal(ex.price, 3399); assert.equal(ex.category, "Mountain Bikes > Bikes");
  });
  test("Shopify product type", () => {
    const html = `<script>var meta = {"product":{"id":1,"vendor":"Orbea","type":"Road Bikes","variants":[]}};</script><script type="application/ld+json">{"@type":"Product","name":"Orca M30","offers":{"price":"54999","priceCurrency":"ZAR"}}</script>`;
    assert.equal(W.extractFromHtml(html, "www.example.co.za").category, "Road Bikes");
  });
  test("a later script never changes the price that was read", () => {
    const html = `<script type="application/ld+json">{"@type":"Product","name":"A","offers":{"price":"100","priceCurrency":"ZAR"}}</script><script type="application/ld+json">{"@type":"Product","name":"B","offers":{"price":"5","priceCurrency":"USD"}}</script>`;
    const ex = W.extractFromHtml(html, "www.example.co.za");
    assert.equal(ex.price, 100); assert.equal(ex.currency, "ZAR"); assert.equal(ex.title, "A");
  });
});
