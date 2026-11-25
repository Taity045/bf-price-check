// Groceries and toiletries compare: category, strict matching (barcode, or brand + exact size and pack),
// own brands, member prices, and the Pick n Pay / Clicks / Morrisons searches (fixtures, no network).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { W } from "../helpers/load-worker.mjs";

const fx = (n) => readFileSync(new URL("../fixtures/shops/" + n, import.meta.url), "utf8");
const id = (title, brand, more = {}) => W.cmpIdentity({ title, brand, price: 50, currency: "ZAR", ...more }, more.canon || "https://www.pnp.co.za/p/x");
const m = (src, title, more = {}) => W.cmpMatch(src, { title, price: 50, ...more }, { grocery: true });
const shop = (sid) => W.CMP_SHOPS.find((s) => s.id === sid);
const shift = (ms) => new Date(Date.now() + ms).toISOString().replace("Z", "+0000");

function mockFetch(t, fn) {
  const real = globalThis.fetch, calls = [];
  globalThis.fetch = async (input, init = {}) => { const url = typeof input === "string" ? input : input.url; calls.push({ url, init }); return fn(url, init); };
  t.after(() => { globalThis.fetch = real; });
  return calls;
}

describe("grocery category", () => {
  test("food, drink, household and toiletries are groceries; rum and cola is liquor", () => {
    for (const t of ["Coca-Cola Plastic 2L", "Nescafe Gold Instant Coffee 200g", "Red Bull Energy Drink 4 x 250ml", "Sunlight Original Dishwashing Liquid 750ml", "Jungle Oats 1kg"]) assert.equal(W.cmpCategory(id(t, null)), "groceries", t);
    assert.equal(W.cmpCategory(id("Bacardi Rum and Cola Can 6 x 300ml", "Bacardi")), "liquor");
    assert.notEqual(W.cmpCategory(id("Oral-B iO Series 5 Electric Toothbrush", "Oral-B")), "groceries");
  });
});

describe("grocery matching", () => {
  const coke = id("Coca-Cola Plastic 2L", "Coca-Cola");
  test("same brand, name and size: a match; packaging words are allowed", () => {
    assert.equal(m(coke, "Coca-Cola Soft Drink Plastic Bottle 2L").level, "name");
    assert.equal(m(id("Red Bull Energy Drink 4 x 250 ml", "Red Bull"), "Red Bull Energy Drink Can 4 x 250ml").level, "name");
  });
  test("another flavour or kind, size, or multipack: no match", () => {
    assert.equal(m(coke, "Coca-Cola Zero Plastic Bottle 2L").level, null);
    assert.equal(m(coke, "Coca-Cola Light Plastic Bottle 2L").level, null);
    assert.equal(m(coke, "Coca-Cola Soft Drink 1.5L").level, null);
    assert.equal(m(coke, "Coca-Cola Soft Drink 6 x 2L").level, null);
    assert.equal(m(id("Red Bull Energy Drink 250ml", "Red Bull"), "Red Bull Energy Drink 4 x 250ml").level, null);
    assert.equal(m(id("Sunlight Original Dishwashing Liquid 750ml", "Sunlight"), "Sunlight Dishwashing Liquid Refill 750ml").level, null);
    assert.equal(m(id("Nescafe Gold Instant Coffee 200g", "Nescafe"), "Nescafe Gold Mild Instant Coffee 200g").level, null);
    assert.equal(m(id("Nescafe Gold Instant Coffee 200g", "Nescafe"), "Nescafe Gold Instant Coffee 200ml").level, null);
  });
  test("no pack size on the page: no name match", () => {
    assert.equal(m(id("Nivea Soft Body Cream", "Nivea"), "Nivea Soft Body Cream").level, null);
  });
  test("'Skin Soft' nappies are not accessories; nappy counts must be the same", () => {
    const h = id("Huggies Gold Size 4 (8-14kg) Value Pack 50 Nappies", "Huggies");
    assert.equal(m(h, "Huggies Gold Size 4 (8-14kg) Value Pack 50 Nappies").level, "name");
    assert.equal(m(h, "Huggies Gold Size 4 (8-14kg) Value Pack 66 Nappies").level, null);
    assert.notEqual(m(h, "Huggies Gold Skin Soft Value Pack Size 4 50s").why, "accessory");
  });
  test("the same barcode is a match even when the shops name it differently", () => {
    const src = id("Colgate Total 12 Clean Mint Toothpaste 75ml", "Colgate", { gtin: "6920354819667" });
    assert.equal(m(src, "Colgate Total Active Prevention Clean Mint Toothpaste 75ml", { gtins: ["6920354819667"] }).level, "barcode");
    assert.equal(m(src, "Colgate Total 12 Clean Mint Toothpaste 75ml", { gtins: ["6001067000000"] }).level, null);
  });
  test("a shop's own brand never matches another shop's own brand", () => {
    assert.ok(W.cmpOwnBrand("PnP", "PnP UHT Full Cream Milk 1L"));
    assert.ok(W.cmpOwnBrand(null, "Woolworths Full Cream Milk 1L"));
    assert.equal(W.cmpOwnBrand("Coca-Cola", "Coca-Cola Plastic 2L"), false);
    assert.equal(m(id("PnP UHT Full Cream Milk 1L", "PnP"), "Clicks UHT Full Cream Milk 1L", { brand: "Clicks" }).level, null);
  });
  test("own brand without a barcode: no shops are searched", () => {
    const p = W.cmpPlan(id("PnP UHT Full Cream Milk 1L", "PnP"), "www.pnp.co.za", "ZAR");
    assert.equal(p.ownBrand, true);
    assert.equal(p.shops.length, 0);
  });
  test("the plan names the shops we can't search, with the reason", () => {
    const p = W.cmpPlan(id("Coca-Cola Plastic 2L", "Coca-Cola"), "www.pnp.co.za", "ZAR");
    assert.ok(p.shops.some((s) => s.id === "clicks"));
    assert.ok(!p.shops.some((s) => s.id === "pnp"), "not the page's own shop");
    const ns = Object.fromEntries(p.notSearched.map((x) => [x.name, x.why]));
    assert.equal(ns.Woolworths, "robots");
    assert.equal(ns.Checkers, "browser");
    assert.equal(ns.Makro, "blocks");
    const uk = W.cmpPlan(W.cmpIdentity({ title: "Coca-Cola Original Taste 24 x 330ml", brand: "Coca-Cola", price: 12.5, currency: "GBP" }, "https://www.tesco.com/x"), "www.tesco.com", "GBP");
    assert.ok(uk.shops.some((s) => s.id === "morrisons"));
    const scent = W.cmpPlan(W.cmpIdentity({ title: "Dior Sauvage Eau de Parfum 100ml", brand: "Dior", price: 120, currency: "GBP" }, "https://allbeauty.com/x"), "allbeauty.com", "GBP");
    assert.ok(!scent.shops.some((s) => s.id === "morrisons"), "a supermarket is not searched for perfume");
  });
  test("Woolworths product codes are the barcode (checked with the GS1 check digit)", () => {
    assert.equal(W.cmpGtinCheck("7613033745843"), true);
    assert.equal(W.cmpGtinCheck("7613033745844"), false);
    const w = W.cmpIdentity({ title: "Nescafé Gold Instant Coffee 200 g", brand: "Other Brands", price: 149.99, currency: "ZAR" }, "https://www.woolworths.co.za/prod/_/A-7613033745843");
    assert.equal(w.gtin, "7613033745843");
    assert.equal(w.brand, null, "'Other Brands' is not a brand");
  });
  test("the short query is the brand and two name words, without the size", () => {
    assert.equal(W.cmpShortQuery(id("Jungle Oats 1kg", "Jungle")), "jungle oats");
  });
});

describe("Pick n Pay search and detail", () => {
  test("search: shelf price, product link and code; detail: barcode, brand, Smart Shopper price", async (t) => {
    const calls = mockFetch(t, (url) => new Response(url.includes("/products/search") ? fx("pnp-search.json") : fx("pnp-detail.json"), { headers: { "content-type": "application/json" } }));
    const list = await W.CMP_SEARCH.pnp(shop("pnp"), "nescafe gold 200g");
    assert.equal(calls[0].init.method, "POST");
    assert.match(calls[0].url, /query=nescafe%20gold%20200g/);
    assert.equal(list[0].title, "Nescafe Gold Instant Coffee 200g");
    assert.equal(list[0].price, 209.99);
    assert.match(list[0].url, /^https:\/\/www\.pnp\.co\.za\/.+\/p\/000000000000539176_EA$/);
    const d = JSON.parse(fx("pnp-detail.json"));
    assert.equal(W.pnpFacts(d).barcode, "7613033745843");
    const r = W.pnpProduct(d);
    assert.equal(r.gtin, "7613033745843");
    assert.ok(r.brand);
  });
  test("Smart Shopper price only while the promotion runs, and only as a note", () => {
    const p = (start, end) => [{ promotionDisplayType: "SMART_SHOPPER", promotionTextMessage: "1 For R129.00 (Smart Price)", startDate: shift(start), endDate: shift(end) }];
    assert.deepEqual(W.cmpPnpMember(p(-864e5, 864e5)), { label: "Smart Shopper price", price: 129 });
    assert.equal(W.cmpPnpMember(p(-2 * 864e5, -864e5)), null);
    assert.equal(W.cmpPnpMember([{ promotionDisplayType: "SMART_SHOPPER", promotionTextMessage: "Buy 2 For R200" }]), null);
    const it = W.cmpPnpItem(shop("pnp"), { name: "X 1L", url: "/x/p/1_EA", price: { value: 209.99, currencyIso: "ZAR" }, potentialPromotions: p(-864e5, 864e5) });
    assert.equal(it.price, 209.99, "the shelf price stays the price");
    assert.equal(it.member.price, 129);
  });
});

describe("Clicks search", () => {
  test("brand is joined to the name; regular price", async (t) => {
    mockFetch(t, () => new Response(fx("clicks-search.json"), { headers: { "content-type": "application/json" } }));
    const list = await W.CMP_SEARCH.clicks(shop("clicks"), "yardley kajal");
    assert.equal(list[0].title, "Yardley Soft Kajal Eye Pencil Black");
    assert.equal(list[0].brand, "Yardley");
    assert.equal(list[0].price, 149.95);
    assert.equal(list[0].url, "https://clicks.co.za/yardley_soft-kajal-eye-pencil-black/p/315692");
  });
  test("product page: brand, name and category from the data layer", () => {
    const html = `<div class="price typo-h2">R 62.99</div><input name="productPrice" value="62.99"><script>dataLayer.push({'item_name': "Soft Body Cream 200ml", 'item_brand': "Nivea", 'item_category': ["Toiletries"], 'item_category2': ["Body Moisturisers"]})</script>`;
    const r = W.clicksPage(html);
    assert.equal(r.price, 62.99);
    assert.equal(r.title, "Nivea Soft Body Cream 200ml");
    assert.equal(r.brand, "Nivea");
    assert.equal(r.category, "Toiletries > Body Moisturisers");
  });
});

describe("Morrisons search", () => {
  test("price for everyone, size in the name, product link", async (t) => {
    mockFetch(t, () => new Response(fx("morrisons-search.html"), { headers: { "content-type": "text/html" } }));
    const list = await W.CMP_SEARCH.morrisons(shop("morrisons"), "coca cola");
    assert.ok(list.length >= 2);
    const c = list.find((x) => x.title === "Coca-Cola Original Taste 24 x 330ml");
    assert.equal(c.price, 12.5);
    assert.equal(c.was, 15.25);
    assert.equal(c.member, null);
    assert.equal(c.url, "https://groceries.morrisons.com/products/coca-cola-original-taste-24-x-330ml/111904301");
  });
  test("a More Card price is a member note; the price is the price for everyone", () => {
    const p = { retailerProductId: "1", brand: "Dove", name: "Dove Body Wash", size: { value: "450ml" }, available: true, price: { current: { amount: "3.00", currency: "GBP" }, original: { amount: "5.50", currency: "GBP" } }, offers: [{ description: "More Card Price Now £3, Was £5.50" }] };
    const it = W.cmpMorrisonsItem(shop("morrisons"), p, { 1: "/products/dove-body-wash-450ml/1" });
    assert.equal(it.price, 5.5);
    assert.equal(it.was, null);
    assert.deepEqual(it.member, { label: "More Card price", price: 3 });
    assert.equal(it.title, "Dove Body Wash 450ml");
  });
});
