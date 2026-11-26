// AB-39: the assistant keeps the user's brand and model, never shows an accessory or a product "for" another
// device when the user wants the device, ranks "best" requests with no budget by the higher models (not the
// cheapest), and never says that a small memory "runs many apps". For all kinds of products.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { W, worker } from "../helpers/load-worker.mjs";
import { testDb } from "../helpers/db.mjs";

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const quiet = (t) => { const log = console.log; console.log = () => {}; t.after(() => { console.log = log; }); };
const fits = (q, title, c = "ZA") => W.asFits(W.asRules(q, c), title, q);
const BAG = "Apatchy London The Mila Stone Leather Phone Bag";
const VR = "VRPARK J20 Virtual Reality Headset with Integrated Headphones | Smartphone VR Glasses for Android & iPhone";
const MOBICEL = "Mobicel Star 4-Inch Smartphone 1GB RAM 8GB Dual Sim";

describe("AB-39: named brand and model", () => {
  test("the search keeps the brand, line and model words (all kinds of products)", () => {
    const sq = (q) => W.asRules(q, "ZA").searchQueries;
    assert.deepEqual(sq("iphone 18 pro"), ["iphone 18 pro"]);
    assert.deepEqual(sq("i want a new iphone with the best camera"), ["iphone"]);
    assert.deepEqual(sq("samsung s25 ultra"), ["samsung s25 ultra"]);
    assert.deepEqual(sq("ps5 slim"), ["ps5 slim"]);
    assert.deepEqual(sq("garmin forerunner 265"), ["garmin forerunner 265"]);
    assert.deepEqual(sq("ninja air fryer under R2000"), ["ninja air fryer"]);
    assert.deepEqual(sq("samsung phone under R5000"), ["samsung smartphone"]);
    assert.equal(W.asRules("iphone 18 pro", "GB").category, "phone");
    assert.equal(W.asRules("garmin forerunner 265", "GB").category, "watch");
  });
  test("a brand after 'for' or 'with' is what the product works with, not the product", () => {
    const r = W.asRules("Need a 4K TV under £500 for PS5", "GB");
    assert.equal(r.category, "tv"); assert.equal(r.named, null);
  });
  test("iphone 18 pro: never a phone bag, a VR headset or another brand; the real model fits", () => {
    for (const c of ["GB", "ZA"]) {
      assert.equal(fits("iphone 18 pro", BAG, c), false, "phone bag");
      assert.equal(fits("iphone 18 pro", VR, c), false, "VR glasses for iPhone");
      assert.equal(fits("iphone 18 pro", MOBICEL, c), false, "other brand");
      assert.equal(fits("iphone 18 pro", "Clear Case for iPhone 18 Pro", c), false, "case");
      assert.equal(fits("iphone 18 pro", "Apple iPhone 18 Pro Max 256GB", c), false, "other model (Pro Max)");
      assert.equal(fits("iphone 18 pro", "Apple iPhone 17 Pro 256GB", c), false, "other generation");
      assert.equal(fits("iphone 18 pro", "Apple iPhone 18 Pro 256GB Deep Blue", c), true);
    }
  });
  test("other models of the same line are other products (all kinds)", () => {
    assert.equal(fits("iphone 16", "Apple iPhone 16 128GB Black"), true);
    assert.equal(fits("iphone 16", "Apple iPhone 16 Pro 128GB"), false);
    assert.equal(fits("iphone 16", "Apple iPhone 16e 128GB"), false);
    assert.equal(fits("garmin forerunner 265", "Garmin Forerunner 265 GPS Running Smartwatch Black"), true);
    assert.equal(fits("garmin forerunner 265", "Garmin Forerunner 265S GPS Running Smartwatch"), false);
    assert.equal(fits("samsung s25 ultra", "Samsung Galaxy S25 Ultra 256GB Titanium Black"), true);
    assert.equal(fits("samsung s25 ultra", "Samsung Galaxy S25 256GB"), false);
    assert.equal(fits("ps5 slim", "Sony PlayStation 5 Slim Console Digital Edition"), true);
    assert.equal(fits("ps5 slim", "PS5 Slim Vertical Stand"), false);
    assert.equal(fits("ninja air fryer", "Ninja Foodi Dual Zone Air Fryer AF300"), true);
    assert.equal(fits("ninja air fryer", "Philips Airfryer 3000 Series"), false);
    assert.equal(fits("ninja air fryer", "Silicone Liners for Ninja Air Fryer"), false);
  });
});

describe("AB-39: accessories (all kinds of products)", () => {
  test("a device request never shows an accessory or a product made 'for' a device", () => {
    assert.equal(fits("i want a new iphone with the best camera", VR), false);
    assert.equal(fits("i want a new iphone with the best camera", BAG), false);
    assert.equal(fits("laptop for a university student under R12000", "15.6 inch Laptop Backpack"), false);
    assert.equal(fits("best TV under R8000", "Universal TV Wall Mount Bracket 32-65 inch"), false);
    assert.equal(fits("running watch under R6000", "Silicone Strap for Garmin Forerunner 265"), false);
    assert.equal(fits("ps5 slim", "Dobe Charging Dock for PS5 Controllers"), false);
    assert.equal(fits("phone for my mom", VR), false);
  });
  test("a real device that says what it works with still fits", () => {
    assert.equal(fits("running watch under R6000", "Smartwatch for Android and iPhone GPS"), true);
    assert.equal(fits("running watch under R6000", "Garmin Forerunner 165 GPS Running Smartwatch"), true);
    assert.equal(fits("laptop for a law student under R10000", "Lenovo IdeaPad Slim 3 Core i5 8GB 512GB SSD Laptop"), true);
  });
  test("an accessory request finds the accessory: phone bag, laptop sleeve, iPhone 16 case", () => {
    assert.equal(W.asRules("phone bag", "GB").accessory, true);
    assert.equal(fits("phone bag", BAG, "GB"), true);
    assert.equal(fits("phone bag", "Apple iPhone 16 128GB", "GB"), false);
    assert.equal(fits("laptop sleeve", "Targus 14 inch Laptop Sleeve"), true);
    assert.equal(fits("laptop sleeve", "HP 15 Laptop Ryzen 5 16GB"), false);
    assert.equal(fits("iPhone 16 case", "Spigen Clear Case for iPhone 16"), true);
  });
});

describe("AB-39: 'best' with no budget, and true spec reasons", () => {
  const cand = (title, price) => ({ title, price, was: null, currency: "ZAR", shop: "Takealot", shop_id: "takealot", url: "https://www.takealot.com/x/PLID" + price });
  test("i want a new iphone with the best camera: the higher models first, not the cheapest", () => {
    const intent = W.asRules("i want a new iphone with the best camera", "ZA");
    assert.equal(intent.quality, true); assert.equal(intent.maxBudget, null);
    const r = W.asPick(intent, [cand("Apple iPhone 16e 128GB", 12999), cand("Apple iPhone 17 Pro Max 256GB", 32999), cand("Apple iPhone 17 256GB", 19999), cand("Apple iPhone 17 Pro 256GB", 27999)]);
    assert.deepEqual(r.top.map((x) => x.title), ["Apple iPhone 17 Pro Max 256GB", "Apple iPhone 17 Pro 256GB", "Apple iPhone 17 256GB"]);
  });
  test("best TV with no budget (another kind): the higher price first; with a budget the old rule stays", () => {
    const r = W.asPick(W.asRules("best smart tv", "ZA"), [cand("Hisense 32 inch Smart TV", 2999), cand("Samsung 65 inch 4K Smart TV", 14999)]);
    assert.equal(r.top[0].title, "Samsung 65 inch 4K Smart TV");
    const plain = W.asPick(W.asRules("smart tv for my mom", "ZA"), [cand("Samsung 65 inch Smart TV", 14999), cand("Hisense 32 inch Smart TV", 2999)]);
    assert.equal(plain.top[0].title, "Hisense 32 inch Smart TV", "no 'best': the lower price first");
  });
  test("RAM reasons: never '1GB memory runs many apps'; only realistic claims (phones 6GB+, laptops 8GB+)", () => {
    const ph = (t) => W.asFeats(t, "phone").join("; ");
    assert.doesNotMatch(ph(MOBICEL), /memory/);
    assert.doesNotMatch(ph("Budget Smartphone 2GB RAM 32GB"), /memory/);
    assert.doesNotMatch(ph("Budget Smartphone 3GB RAM 64GB"), /apps at once|many apps/);
    assert.match(ph("Samsung Galaxy A56 8GB RAM 256GB"), /8GB memory runs many apps/);
    assert.match(ph("Phone 6GB RAM 128GB"), /6GB memory runs several apps/);
    assert.match(ph("Apple iPhone 18 Pro 1TB"), /1TB storage holds many photos/);
    const lp = (t) => W.asFeats(t, "laptop").join("; ");
    assert.doesNotMatch(lp("Mini Laptop 2GB RAM 32GB eMMC"), /memory/);
    assert.doesNotMatch(lp("Laptop Celeron 4GB RAM 128GB SSD"), /apps/);
    assert.match(lp("HP 15 Ryzen 5 16GB RAM 512GB SSD Laptop"), /16GB memory runs many apps/);
    // an AI reason with a 'many apps' claim for small memory is not used
    const facts = "name: " + MOBICEL + "; price: R399";
    assert.equal(W.asReasonOk("Good for calls: 1GB memory runs many apps. It costs R399 at Matrix.", facts), false);
    assert.equal(W.asReasonOk("Good for study: 4GB RAM runs several apps. It costs R4,999 at Takealot.", "name: Laptop 4GB RAM; price: R4,999 Takealot"), false);
  });
});

// ---------- /api/assist with mocked shops (Computer Mania answers, other shops fail) ----------
const prod = (title, price) => ({ title, handle: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), url: "/products/" + title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), price: String(price), price_min: String(price), price_max: String(price), available: true, vendor: "" });
function setup(t, products) {
  const { db, env } = testDb(t);
  const ok = { limit: async () => ({ success: true }) };
  Object.assign(env, { RL_SEARCH: ok, RL_CMP_SHOP: ok, RL_CMP_SLOW: ok, RL_CMP_IP: ok, AI_MATCH: "off" });
  const real = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (/\/robots\.txt$/.test(url)) return new Response("", { status: 404 });
    if (/computermania\.co\.za\/search\/suggest\.json/.test(url)) return json({ resources: { results: { products } } });
    return new Response("not mocked", { status: 599 });
  };
  t.after(() => { globalThis.fetch = real; });
  W.asAiReset(); W.asOrReset(); W.asRlReset();
  return { env };
}
const get = (env, q, c = "ZA") => worker.fetch(new Request("https://eish.veldwire.com/api/assist?q=" + encodeURIComponent(q) + "&c=" + c, { headers: { "cf-connecting-ip": "203.0.113.9" } }), env, {});
const JUNK = [prod(BAG, 544), prod(VR, 390), prod(MOBICEL, 399), prod("Clear Case for iPhone 17 Pro", 199)];

describe("AB-39: /api/assist", () => {
  test("iphone 18 pro with no real match: no picks and a plain empty message", async (t) => {
    quiet(t);
    const { env } = setup(t, JUNK);
    const d = await (await get(env, "iphone 18 pro")).json();
    assert.equal(d.picks.length, 0); assert.equal(d.more.length, 0);
    assert.equal(d.note, 'No matching products found for "iphone 18 pro" at the shops we searched.');
    assert.equal(d.intent.named, "iphone 18 pro"); assert.deepEqual(d.intent.searchQueries, ["iphone 18 pro"]);
    assert.match(d.understanding, /Looking for: iphone 18 pro/);
  });
  test("i want a new iphone with the best camera: only iPhones, the higher models first", async (t) => {
    quiet(t);
    const { env } = setup(t, [...JUNK, prod("Apple iPhone 17 128GB", 18999), prod("Apple iPhone 17 Pro Max 256GB", 32999), prod("Apple iPhone 17 Pro 256GB", 27999)]);
    const d = await (await get(env, "i want a new iphone with the best camera")).json();
    assert.deepEqual(d.picks.map((p) => p.title), ["Apple iPhone 17 Pro Max 256GB", "Apple iPhone 17 Pro 256GB", "Apple iPhone 17 128GB"]);
    assert.ok(d.picks.every((p) => !/1GB memory|many apps/.test(p.reason) || /\d{2,}GB|[6-9]GB/.test(p.reason)));
  });
  test("phone bag still finds the bag", async (t) => {
    quiet(t);
    const { env } = setup(t, JUNK);
    const d = await (await get(env, "phone bag under R1000")).json();
    assert.deepEqual(d.picks.map((p) => p.title), [BAG]);
  });
});
