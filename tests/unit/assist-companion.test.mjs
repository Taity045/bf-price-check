// AB-39b: "i want an iphone with a good camera" showed a R160 sync cable and Eufy trackers. Companion items on
// the whole name, the named brand or line first in the name, lowest device prices, "good" with no budget not
// cheapest first, and no reason that says the pick lacks something. For all kinds of products.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { W, worker } from "../helpers/load-worker.mjs";
import { testDb } from "../helpers/db.mjs";

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const quiet = (t) => { const log = console.log; console.log = () => {}; t.after(() => { console.log = log; }); };
const fits = (q, title, c = "ZA") => W.asFits(W.asRules(q, c), title, q);
const IQ = "i want an iphone with a good camera";
const CABLE = "URBAN Microworld Ipad / Iphone / Ipad Sync + charge cable Pink";
const TRACK1 = "Eufy SmartTrack Link 3 iPhone - AEST87B0011TRIP", TRACK2 = "Eufy SmartTrack Card 3 iPhone - AEST87B2011TRIP";

describe("AB-39b: companion items and brand position", () => {
  test("iphone with a good camera: no sync cable, no trackers; real iPhones fit", () => {
    const r = W.asRules(IQ, "ZA");
    assert.equal(r.category, "phone"); assert.deepEqual(r.searchQueries, ["iphone"]);
    assert.equal(fits(IQ, CABLE), false, "cable after ' + '");
    assert.equal(fits(IQ, TRACK1), false, "Eufy tracker"); assert.equal(fits(IQ, TRACK2), false, "Eufy tracker card");
    assert.equal(fits(IQ, "Apple iPhone 16 128GB Black"), true);
    assert.equal(fits(IQ, "Apple iPhone 17 Pro Max 256GB - Cosmic Orange"), true);
    assert.equal(fits(IQ, "iPhone 16e 128GB White"), true);
  });
  test("other kinds: macbook, ps5, laptops, watches", () => {
    assert.equal(fits("macbook", "Apple MacBook Air 13 M3 16GB 256GB"), true);
    assert.equal(fits("macbook", "2024 Apple MacBook Air 13-inch M3"), true);
    assert.equal(fits("macbook", "USB-C Hub for MacBook Pro"), false);
    assert.equal(fits("macbook", "Satechi Aluminium Stand MacBook"), false);
    assert.equal(fits("macbook", "Baseus MacBook Charger 65W"), false);
    assert.equal(fits("ps5", "Sony PlayStation 5 Slim Console Digital Edition"), true);
    assert.equal(fits("ps5", "Dobe Charging Station PS5 Controller"), false);
    assert.equal(fits("ps5", "Orb PS5 Cooling Fan Sticker"), false);
    assert.equal(fits("good laptop for work", "Lenovo IdeaPad Slim 3 Core i5 16GB 512GB SSD Laptop"), true);
    assert.equal(fits("good laptop for work", "Laptop Charger 65W USB-C for Lenovo"), false);
    assert.equal(fits("good laptop for work", "Kingston 64GB microSD memory card laptop"), false);
    assert.equal(fits("garmin running watch", "Garmin Instinct 2 Solar Charging Smartwatch"), true);
    assert.equal(fits("garmin running watch", "Garmin Forerunner 165 GPS Running Smartwatch with charging cable"), true);
    assert.equal(fits("fitness tracker under R1500", "Fitbit Inspire 3 Fitness Tracker Black"), true);
    assert.equal(fits("samsung phone under R5000", "Samsung Galaxy A16 128GB 25W Fast Charging"), true);
    assert.equal(fits("samsung phone under R5000", "Tile Mate Tracker Samsung"), false);
    assert.equal(fits("best TV under R8000", "Hisense 55 inch 4K Smart TV, Voice Remote"), true);
  });
  test("accessory requests still find accessories", () => {
    assert.equal(fits("iphone charge cable", CABLE), true);
    assert.equal(fits("phone bag", "Apatchy London The Mila Stone Leather Phone Bag", "GB"), true);
  });
});

describe("AB-39b: ranking and reasons", () => {
  const cand = (title, price) => ({ title, price, was: null, currency: "ZAR", shop: "Takealot", shop_id: "takealot", url: "https://www.takealot.com/x/PLID" + price });
  test("'good' with no budget: not cheapest first (iphone, laptop)", () => {
    const r = W.asPick(W.asRules(IQ, "ZA"), [cand("Apple iPhone 16e 128GB", 12999), cand("Apple iPhone 17 256GB", 19999), cand("Apple iPhone 17 Pro 256GB", 27999)]);
    assert.equal(r.top[0].title, "Apple iPhone 17 Pro 256GB");
    const l = W.asPick(W.asRules("good laptop for work", "ZA"), [cand("Basic Laptop Celeron 4GB 128GB", 4499), cand("Lenovo IdeaPad Slim 3 Core i5 16GB 512GB SSD Laptop", 11999), cand("HP 15 Core i5 16GB 512GB SSD Laptop", 10999), cand("Gaming Laptop RTX 4090 Core i9 32GB 2TB", 64999)]);
    assert.notEqual(l.top[0].title, "Basic Laptop Celeron 4GB 128GB");
    // "Core Ultra" is a processor, not the Ultra model: a R57,000 laptop does not come first for "good laptop"
    const u = W.asPick(W.asRules("good laptop for work", "ZA"), [cand("Lenovo ThinkPad T14 Intel Core Ultra 7 32GB 512GB SSD Laptop", 56999), cand("HP ProBook 4 Intel Core i5 16GB 512GB SSD Laptop", 19799), cand("Dell Pro 15 Essential Core i5 16GB 512GB SSD Laptop", 15999)]);
    assert.notEqual(u.top[0].title, "Lenovo ThinkPad T14 Intel Core Ultra 7 32GB 512GB SSD Laptop");
  });
  test("a reason that says the pick lacks something, or praises what the name does not show, is not used", () => {
    const facts = "name: Apple iPhone 16 128GB; price: R14,999; shop: Takealot";
    assert.equal(W.asReasonOk("This pick does not have a camera. It costs R14,999 at Takealot.", facts + " " + IQ, facts), false);
    assert.equal(W.asReasonOk("This iPhone has a good camera. It costs R14,999 at Takealot.", facts + " " + IQ, facts), false);
    assert.equal(W.asReasonOk("Good for photos: the camera takes clear photos. It costs R14,999 at Takealot.", facts + " " + IQ, facts), false, "camera only from the request");
    assert.equal(W.asReasonOk("Good for calls and apps: 128GB storage holds photos and apps. It costs R14,999 at Takealot.", facts + " " + IQ, facts), true);
  });
  test("the cache version is v7", () => assert.equal(W.AS_VER, "v7"));
});

// ---------- /api/assist with mocked shops (Computer Mania answers) ----------
const prod = (title, price) => ({ title, handle: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), url: "/products/" + title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), price: String(price), price_min: String(price), price_max: String(price), available: true, vendor: "" });
function setup(t, products) {
  const { env } = testDb(t);
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

describe("AB-39b: /api/assist", () => {
  test("i want an iphone with a good camera: only real iPhones, no cable or tracker, not cheapest first", async (t) => {
    quiet(t);
    const { env } = setup(t, [prod(CABLE, 160), prod(TRACK1, 1199.99), prod(TRACK2, 1299.99), prod("iPhone Sticker Pack", 49), prod("Apple iPhone 16e 128GB", 12999), prod("Apple iPhone 17 Pro 256GB", 27999), prod("Apple iPhone 17 256GB", 19999)]);
    const d = await (await get(env, IQ)).json();
    assert.deepEqual(d.picks.map((p) => p.title), ["Apple iPhone 17 Pro 256GB", "Apple iPhone 17 256GB", "Apple iPhone 16e 128GB"]);
    assert.equal(d.more.length, 0);
    for (const p of d.picks) assert.doesNotMatch(p.reason, /does not|camera/i);
  });
  test("a device request never shows a product under the lowest device price", async (t) => {
    quiet(t);
    const { env } = setup(t, [prod("Apple iPhone 15 128GB", 450)]);
    const d = await (await get(env, "iphone 15")).json();
    assert.equal(d.picks.length, 0);
  });
});
