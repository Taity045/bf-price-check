// AB-41: "where can i buy redbull in bulk?" searched "red bull bulk" and "coke" searched "coke" (no Coca-Cola),
// Ask AI did not use the live grocery flyers, and "where can i buy a bike" showed an inner tube as the best match.
// Everyday short names (both ways), bulk and multi-pack words, flyer deals in Ask AI, bike parts and price floors.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { W, worker } from "../helpers/load-worker.mjs";
import { testDb } from "../helpers/db.mjs";

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const quiet = (t) => { const log = console.log; console.log = () => {}; t.after(() => { console.log = log; }); };
const fits = (q, title, c = "ZA") => W.asFits(W.asRules(q, c), title, q);
const T = (s) => Date.parse(s);
const LIVE = T("2026-11-27T10:00:00Z");          // 27 Nov 2026 12:00 SAST: all four flyers are live
const AFTER = T("2026-11-29T22:00:00Z");         // 30 Nov 2026 00:00 SAST: the 29 Nov deals have stopped
const realNow = Date.now;
const at = (t, ctx) => { Date.now = () => t; ctx.after(() => { Date.now = realNow; }); };
const RB = "where can i buy redbull in bulk?";
const INNER = "TPU Road Bike Innertube 65mm - 700 x 25-32C";

describe("AB-41: everyday short names", () => {
  test("coke = coca cola, redbull = red bull, air pods = airpods, i phone = iphone, mac book, i pad, playstation 5", () => {
    assert.deepEqual(W.srchWords("coke"), ["coca", "cola"]);
    assert.deepEqual(W.srchWords("Coca-Cola"), ["coca", "cola"]);
    assert.deepEqual(W.srchWords("redbull"), ["red", "bull"]);
    assert.deepEqual(W.srchWords("red bull"), ["red", "bull"]);
    assert.deepEqual(W.srchWords("air pods pro"), ["airpods", "pro"]);
    assert.deepEqual(W.srchWords("i phone 16"), ["iphone", "16"]);
    assert.deepEqual(W.srchWords("mac book air"), ["macbook", "air"]);
    assert.deepEqual(W.srchWords("i pad mini"), ["ipad", "mini"]);
    assert.deepEqual(W.srchWords("playstation 5"), ["ps5"]);
    assert.deepEqual(W.srchWords("playstation5 slim"), ["ps5", "slim"]);
  });
  test("both ways: the short name finds the full name and the full name finds the short name", () => {
    assert.equal(W.srchHas(W.srchWords("coke"), "Coca-Cola Original Taste 2 L"), true);
    assert.equal(W.srchHas(W.srchWords("coca cola"), "Coke Zero 2L"), true);
    assert.equal(W.srchHas(W.srchWords("redbull"), "Red Bull Energy Drink 250ml"), true);
    assert.equal(W.srchHas(W.srchWords("red bull"), "Redbull Sugarfree 473ml"), true);
    assert.equal(W.srchHas(W.srchWords("airpods"), "Apple Air Pods Pro 2"), true);
  });
  test("exact searches do not change; the shop gets the shops' own name", () => {
    assert.equal(W.srchShopQ("iPhone 16 Pro"), "iPhone 16 Pro");
    assert.equal(W.srchShopQ("Jungle Oats"), "Jungle Oats");
    assert.equal(W.srchShopQ("coke"), "coca cola");
    assert.equal(W.srchShopQ("redbull"), "red bull");
    assert.deepEqual(W.srchWords("coconut"), ["coconut"]);
    assert.deepEqual(W.srchWords("can i phone"), ["can", "i", "phone"]);
  });
  test("coke in Ask AI: searches coca cola, a grocery, Coca-Cola names fit, a brandy combo does not", () => {
    const r = W.asRules("coke", "ZA");
    assert.deepEqual(r.searchQueries, ["coca cola"]); assert.equal(r.grocery, true); assert.equal(r.accessory, false); assert.equal(r.category, "other");
    assert.equal(fits("coke", "Coca-Cola Original 24 x 300ml"), true);
    assert.equal(fits("coke", "Coke Zero 2L"), true);
    assert.equal(fits("coke", "Coca-Cola Original Taste Less Sugar 2 L"), true);
    assert.equal(fits("coke", "2 x Richelieu Premium International Brandy 750 ml and Coca-Cola (Incl. Variants) 1 L"), false);
    assert.equal(fits("coke", "Pepsi Cola 2L"), false);
  });
  test("the AI's search words get the same names and lose bulk words", () => {
    const rules = W.asRules(RB, "ZA");
    const m = W.asMerge({ category: "other", searchQueries: ["red bull bulk", "bulk"] }, rules, RB);
    assert.deepEqual(W.asFixQueries(m.searchQueries, true), ["red bull"]);
    assert.deepEqual(W.asFixQueries(["coke"], false), ["coca cola"]);
    assert.deepEqual(W.asFixQueries(["16GB laptop", "Garmin Forerunner"], false), ["16GB laptop", "Garmin Forerunner"]);
  });
});

describe("AB-41: bulk and multi-pack requests", () => {
  test("where can i buy redbull in bulk? searches red bull (not red bull bulk)", () => {
    const r = W.asRules(RB, "ZA");
    assert.deepEqual(r.searchQueries, ["red bull"]); assert.equal(r.bulk, true); assert.equal(r.grocery, true);
    assert.match(W.asUnderstanding(r), /Looking for: red bull \(packs and cases first\)/);
  });
  test("other bulk words: case, crate, tray, pack, multi-buy, box, wholesale", () => {
    for (const q of ["red bull case", "coke 24 pack", "case of coke", "coke multi-buy", "red bull tray", "box of red bull", "red bull wholesale", "crate of coke"]) {
      const r = W.asRules(q, "ZA");
      assert.equal(r.bulk, true, q); assert.equal(r.accessory, false, q);
      assert.ok(["red bull", "coca cola"].includes(r.searchQueries[0]), q + " -> " + r.searchQueries[0]);
    }
    // a phone case is still an accessory request, not a bulk request
    const pc = W.asRules("phone case", "ZA"); assert.equal(pc.bulk, false); assert.equal(pc.accessory, true);
  });
  test("a case of cans is the product, not an accessory", () => {
    assert.equal(fits(RB, "Red Bull Energy Drink Case 24 x 250ml"), true);
    assert.equal(fits(RB, "Red Bull Energy Drink 250ml"), true);
  });
  test("pack sizes", () => {
    const n = (title, flyer) => W.asPackN({ title, flyer });
    assert.equal(n("Red Bull Energy Drink 250ml"), 1);
    assert.equal(n("Red Bull Energy Drink 24 x 250ml"), 24);
    assert.equal(n("Red Bull 4 Pack 250ml"), 4);
    assert.equal(n("Coca-Cola 6-pack 330ml cans"), 6);
    assert.equal(n("Red Bull Sugarfree pack of 12"), 12);
    assert.equal(n("Red Bull Sugar Free Case"), 2);
    assert.equal(n("Coca-Cola Original 1.5 Litre", { qty: 2 }), 2);
  });
  test("bulk: packs, cases and multi-buys first, bigger packs first; without bulk the lowest price first", () => {
    const c = (title, price, shop = "Takealot", extra = {}) => ({ title, price, was: null, currency: "ZAR", shop, shop_id: shop.toLowerCase(), url: "https://www.takealot.com/x/" + encodeURIComponent(title), ...extra });
    const cands = [c("Red Bull Energy Drink 250ml", 25), c("Red Bull Energy Drink 4 x 250ml", 95), c("Red Bull Energy Drink 24 x 250ml", 529), c("Red Bull Sugarfree 250ml", 24)];
    const bulk = W.asPick(W.asRules(RB, "ZA"), cands);
    assert.deepEqual(bulk.top.map((p) => p.title), ["Red Bull Energy Drink 24 x 250ml", "Red Bull Energy Drink 4 x 250ml", "Red Bull Sugarfree 250ml"]);
    assert.equal(bulk.top[0].pack, 24);
    const plain = W.asPick(W.asRules("red bull", "ZA"), cands);
    assert.equal(plain.top[0].title, "Red Bull Sugarfree 250ml");
  });
});

describe("AB-41: bikes (no parts or accessories for a bike request)", () => {
  test("where can i buy a bike: a bike request; parts and accessories never fit", () => {
    const r = W.asRules("where can i buy a bike", "ZA");
    assert.equal(r.category, "bike"); assert.deepEqual(r.searchQueries, ["bike"]); assert.equal(r.accessory, false);
    for (const t of [INNER, "Schwalbe Marathon Plus 700x32C Tyre", "Shimano PD-M520 SPD Pedals", "Fizik Aliante Saddle", "Kryptonite Bike Lock", "Giro Helmet Road Bike", "Lezyne Bike Pump", "Topeak Bike Light Set", "Shimano Deore 12 Speed Chain", "Muc-Off Tubeless Sealant", "Thule Bike Rack", "RockShox Fork 29", "Bike Bottle Cage"])
      assert.equal(fits("where can i buy a bike", t), false, t);
    for (const t of ["Silverback Stride 29er Mountain Bike", "Trek Marlin 5 Gen 3", "Momsen Kids Bike 16", "Titan Racing Cypher RS Expert Bicycle", "Specialized Turbo Vado e-Bike"])
      assert.equal(fits("where can i buy a bike", t), true, t);
  });
  test("kinds of bikes, and a bike part request still finds the part", () => {
    assert.deepEqual(W.asRules("mountain bike under R10000", "ZA").searchQueries, ["mountain bike"]);
    assert.deepEqual(W.asRules("road bike", "ZA").searchQueries, ["road bike"]);
    assert.deepEqual(W.asRules("electric bike", "ZA").searchQueries, ["e-bike"]);
    for (const q of ["bike pump", "inner tube 700c", "bike helmet", "bike lock"]) assert.equal(W.asRules(q, "ZA").accessory, true, q);
    assert.equal(fits("inner tube 700c", "TPU Road Bike Inner Tube 700c"), true);
  });
  test("parts of appliances and other products are not the main product", () => {
    assert.equal(fits("robot vacuum", "Roborock Replacement Filters and Brush Heads robot vacuum"), false);
    assert.equal(fits("electric toothbrush", "Oral-B Brush Heads 4 Pack"), false);
  });
  test("lowest bike price: R1,500 in South Africa, £80 in the UK", () => {
    assert.equal(W.AS_FLOOR.ZAR.bike, 1500); assert.equal(W.AS_FLOOR.GBP.bike, 80);
  });
});

describe("AB-41: live flyer deals in Ask AI", () => {
  test("coke: Coca-Cola deals from the live flyers, with the flyer's own details", (t) => {
    at(LIVE, t);
    const fc = W.asFlyerCands(W.asRules("coke", "ZA"), "ZA");
    assert.ok(fc.cands.length >= 3, "Coca-Cola flyer deals");
    assert.ok(fc.cands.every((c) => /coca-cola/i.test(c.title) && !/brandy/i.test(c.title)));
    const pnp = fc.cands.find((c) => c.shop === "Pick n Pay flyer");
    assert.ok(pnp, "Pick n Pay flyer deal");
    assert.deepEqual(pnp.flyer.badges, ["Smart Shopper"]);
    assert.match(pnp.flyer.label, /^Pick n Pay \(.+ flyer, valid \d+\u2013\d+ Nov\)$/);
    assert.equal(pnp.flyer.valid_to, "2026-11-29");
    assert.ok(pnp.flyer.deal && pnp.url.startsWith("https://"));
    for (const c of fc.cands) assert.ok(c.price > 0 && c.flyer.until > LIVE);
  });
  test("auto-expiry: no flyer deal after 23:59:59 SAST on its last day; UK: none", (t) => {
    at(AFTER, t);
    const fc = W.asFlyerCands(W.asRules("coke", "ZA"), "ZA");
    assert.ok(fc.cands.every((c) => c.flyer.until >= AFTER));
    assert.equal(W.asFlyerCands(W.asRules("coke", "GB"), "GB").cands.length, 0);
  });
  test("a flyer pick's reason uses only the flyer's words", () => {
    const intent = W.asRules("coke", "ZA");
    const r = W.asRuleReason(intent, { title: "Coca-Cola 1.5 Litre", price: 14, currency: "ZAR", shop: "Pick n Pay flyer", flyer: { deal: "2 for R28 (R14.00 each)", need: "R14.00 each when you buy 2 (R28 total)", limit: null, badges: ["Smart Shopper"], label: "Pick n Pay (inland provinces flyer, valid 26\u201329 Nov)" } });
    assert.equal(r, "In-store flyer deal: R14.00 each when you buy 2 (R28 total). You need the Smart Shopper card. Valid at Pick n Pay (inland provinces flyer, valid 26\u201329 Nov).");
  });
});

// ---------- /api/assist and /api/search/shop with mocked shops ----------
function setup(t, products) {
  const { env } = testDb(t);
  const ok = { limit: async () => ({ success: true }) };
  Object.assign(env, { RL_SEARCH: ok, RL_CMP_SHOP: ok, RL_CMP_SLOW: ok, RL_CMP_IP: ok, AI_MATCH: "off" });
  const real = globalThis.fetch, asked = [];
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (/\/robots\.txt$/.test(url)) return new Response("", { status: 404 });
    if (/api\.takealot\.com\/rest\/.*searches\/products/.test(url)) {
      const q = new URL(url).searchParams.get("qsearch"); asked.push(q);
      return json({ sections: { products: { results: (products[q] || []).map(([title, price], i) => ({ product_views: { core: { id: 1000 + i + q.length * 50, title, slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-") }, buybox_summary: { prices: [price] }, stock_availability_summary: { is_in_stock: true } } })) } } });
    }
    return new Response("not mocked", { status: 599 });
  };
  t.after(() => { globalThis.fetch = real; });
  W.asAiReset(); W.asOrReset(); W.asRlReset();
  return { env, asked };
}
const get = (env, q, c = "ZA") => worker.fetch(new Request("https://eish.veldwire.com/api/assist?q=" + encodeURIComponent(q) + "&c=" + c, { headers: { "cf-connecting-ip": "203.0.113.9" } }), env, {});

describe("AB-41: /api/assist", () => {
  test("where can i buy redbull in bulk?: searches red bull, the 24-pack first", async (t) => {
    quiet(t);
    const { env, asked } = setup(t, { "red bull": [["Red Bull Energy Drink 250ml", 25], ["Red Bull Energy Drink 24 x 250ml", 529], ["Red Bull Energy Drink 4 x 250ml", 95]] });
    const d = await (await get(env, RB)).json();
    assert.ok(asked.includes("red bull")); assert.ok(!asked.some((q) => /bulk/.test(q)));
    assert.deepEqual(d.intent.searchQueries, ["red bull"]); assert.equal(d.intent.bulk, true);
    assert.equal(d.picks[0].title, "Red Bull Energy Drink 24 x 250ml");
    assert.equal(d.picks[1].title, "Red Bull Energy Drink 4 x 250ml");
  });
  test("coke: Coca-Cola from the online shop and from the live flyers", async (t) => {
    quiet(t); at(LIVE, t);
    const { env, asked } = setup(t, { "coca cola": [["Coca-Cola Original 24 x 300ml", 249], ["Coca-Cola Original 2L", 26.99]] });
    const d = await (await get(env, "coke")).json();
    assert.ok(asked.includes("coca cola"));
    const all = d.picks.concat(d.more);
    assert.ok(all.some((p) => p.shop === "Takealot" && /Coca-Cola/.test(p.title)), "online");
    const fl = all.filter((p) => p.flyer);
    assert.ok(fl.length >= 3, "flyer deals");
    assert.ok(fl.every((p) => p.flyer.label && p.flyer.deal && p.flyer.valid_to && Array.isArray(p.flyer.badges)));
    assert.ok(d.shops.searched.includes("Pick n Pay flyer"));
    assert.ok(all.every((p) => !/brandy/i.test(p.title)));
    for (const p of d.picks.filter((x) => x.flyer)) assert.match(p.reason, /^In-store flyer deal: /);
  });
  test("where can i buy a bike: no inner tube as a pick", async (t) => {
    quiet(t);
    const { env } = setup(t, {});
    const fc = W.asCandidates(W.asRules("where can i buy a bike", "ZA"), [{ shop: W.cmpShopById("evobikes"), q: "bike", list: [
      { title: INNER, price: 150, url: "https://evobikes.co.za/product/tpu-innertube" },
      { title: "Silverback Stride 29er Mountain Bike", price: 8999, url: "https://evobikes.co.za/product/stride" },
      { title: "Evo Kids Bike Bell", price: 99, url: "https://evobikes.co.za/product/bell" },
      { title: "Bike Lite 20 Kids Bike", price: 1200, url: "https://evobikes.co.za/product/lite" }] }]);
    assert.deepEqual(fc.map((c) => c.title), ["Silverback Stride 29er Mountain Bike"]);
    assert.ok(env);
  });
  test("normal search: coke at an online shop finds Coca-Cola", (t) => {
    const shop = W.cmpShopById("takealot");
    const items = W.srchFilter("coke", shop, [{ title: "Coca-Cola Original 2L", price: 26.99, url: "https://www.takealot.com/coca-cola/PLID1" }, { title: "Pepsi 2L", price: 20, url: "https://www.takealot.com/pepsi/PLID2" }]);
    assert.deepEqual(items.map((x) => x.title), ["Coca-Cola Original 2L"]);
    assert.ok(t);
  });
});

describe("AB-41: live check fixes", () => {
  test("red bull is one name: Black Bull Red Rage is not Red Bull", () => {
    assert.equal(fits(RB, "Black Bull Red Rage Insane Pre-Workout Sachets Sour Wormz 10 x 100g"), false);
    assert.equal(fits(RB, "Red Bull Energy Drink The Peach Edition 250ml Case (6 x 4 Pack)"), true);
    assert.equal(W.asPackN({ title: "Red Bull Energy Drink The Peach Edition 250ml Case (6 x 4 Pack)" }), 24);
  });
  test("bike reasons say only what the name shows", () => {
    assert.deepEqual(W.asFeats('GetUp Rocket 26" Mountain Bike - Shimano 21 Speed Disc Brakes', "bike"), ["26-inch wheels", "21 gears", "disc brakes"]);
    assert.deepEqual(W.asFeats("GetUp BMX Bike - Orange", "bike"), []);
  });
});
