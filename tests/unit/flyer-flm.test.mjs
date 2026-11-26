// Food Lover's Market flyer deals (src/flyer.js): the data, the deal words, search, strict compare matching,
// and the end date. No network: the flyer is in memory. Time is set with Date.now.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { W, worker } from "../helpers/load-worker.mjs";
import { testDb } from "../helpers/db.mjs";

const DURING = Date.parse("2026-11-26T12:00:00Z");
const LAST_MINUTE = Date.parse("2026-11-29T21:59:00Z");          // 23:59 SAST on 29 Nov
const AFTER = Date.parse("2026-11-29T22:00:00Z");                // 00:00 SAST on 30 Nov
const BEFORE = Date.parse("2026-11-22T21:59:59Z");               // 23:59:59 SAST on 22 Nov
const realNow = Date.now;
function at(t, ctx) { Date.now = () => t; ctx.after(() => { Date.now = realNow; }); }
const deal = (prefix) => W.FLM_FLYER.deals.find((d) => d.id.startsWith(prefix));
const src = (title, brand = null, price = null) => W.cmpIdentity({ title, brand, price }, "https://www.checkers.co.za/p/1");
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
let ipSeq = 0;

describe("flyer: the data", () => {
  const raw = JSON.parse(readFileSync(new URL("../../data/flm-flyer-2026-11-23.json", import.meta.url), "utf8"));
  test("141 deals, Western Cape, valid 23 to 29 November 2026, every id once", () => {
    assert.equal(raw.deals.length, 141);
    assert.equal(new Set(raw.deals.map((d) => d.id)).size, 141);
    assert.equal(raw.region, "Western Cape"); assert.equal(raw.valid_from, "2026-11-23"); assert.equal(raw.valid_to, "2026-11-29");
    for (const d of raw.deals) { assert.ok(d.price > 0 && d.unit_price > 0 && d.qty >= 1, d.id); assert.equal(d.valid_to, "2026-11-29", d.id); }
  });
  test("the built Worker has every deal with the same prices (nothing added or changed)", () => {
    const built = readFileSync(new URL("../../dist/worker.js", import.meta.url), "utf8");
    const m = built.match(/^const FLM_FLYER = (.+);$/m);
    assert.ok(m, "FLM_FLYER in dist/worker.js (run python3 build.py)");
    const b = JSON.parse(m[1]);
    assert.equal(b.deals.length, 141);
    for (const d of raw.deals) {
      const x = b.deals.find((y) => y.id === d.id);
      assert.deepEqual([x.title, x.brand, x.price, x.deal_text, x.qty, x.unit_price, x.is_combo], [d.title, d.brand, d.price, d.deal_text, d.qty, d.unit_price, d.is_combo], d.id);
    }
  });
  test("the label names the region and the dates", () => {
    assert.equal(W.FLM_LABEL, "Food Lover's Market (Western Cape flyer, valid 23\u201329 Nov)");
  });
});

describe("flyer: the end date (South Africa time)", () => {
  test("starts 00:00 SAST on 23 Nov and ends 23:59:59 SAST on 29 Nov", () => {
    assert.equal(new Date(W.FLM_FROM).toISOString(), "2026-11-22T22:00:00.000Z");
    assert.equal(new Date(W.FLM_UNTIL).toISOString(), "2026-11-29T21:59:59.999Z");
    assert.equal(W.flmActive(DURING), true);
    assert.equal(W.flmActive(LAST_MINUTE), true);
    assert.equal(W.flmActive(AFTER), false);
    assert.equal(W.flmActive(BEFORE), false);
    assert.equal(W.flmActive(Date.parse("2027-11-26T12:00:00Z")), false, "never again next year");
  });
  test("after the end: no search results, no compare match, not a searched shop", (t) => {
    at(AFTER, t);
    assert.deepEqual(W.flmSearch("Jungle Oats"), []);
    assert.equal(W.flmCompare(src("Jungle Oats 1kg", "Jungle", 39.99)), null);
    assert.ok(!W.srchPlan("Jungle Oats", "ZA").shops.some((s) => s.id === "flm"));
    const plan = W.cmpPlan(src("Jungle Oats 1kg", "Jungle"), "www.checkers.co.za", "ZAR");
    assert.ok(!plan.shops.some((s) => s.id === "flm"));
    assert.equal(W.flmSecondsLeft(), 0);
  });
  test("before the start: nothing shows either", (t) => {
    at(BEFORE, t);
    assert.deepEqual(W.flmSearch("Jungle Oats"), []);
    assert.equal(W.flmCompare(src("Jungle Oats 1kg", "Jungle", 39.99)), null);
  });
  test("in the last minute it still shows, and nothing is cached past the end", (t) => {
    at(LAST_MINUTE, t);
    assert.equal(W.flmSearch("Jungle Oats").length, 1);
    assert.equal(W.flmSecondsLeft(), 59);
  });
});

describe("flyer: the deal in plain words", () => {
  test("one price: 'R29.99 each'", () => {
    const x = W.flmDealText(deal("flm-1-jungle-oats"));
    assert.equal(x.deal, "R29.99 each"); assert.equal(x.need, null); assert.equal(x.multi, false);
  });
  test("multi-buy: '10 for R100 (R10.00 each)', and you must buy 10", () => {
    const x = W.flmDealText(deal("flm-1-rhodes-baked-beans"));
    assert.equal(x.deal, "10 for R100 (R10.00 each)");
    assert.equal(x.need, "R10.00 each when you buy 10 (R100 total)");
    assert.equal(x.multi, true);
  });
  test("'any' multi-buy keeps 'any'; a limit is kept", () => {
    assert.equal(W.flmDealText(deal("flm-1-sunlight-5-in-1")).deal, "Any 2 for R99 (R49.50 each)");
    assert.equal(W.flmDealText(deal("flm-1-sunlight-5-in-1")).need, "R49.50 each when you buy any 2 (R99 total)");
    const coke = W.flmDealText(deal("flm-1-coca-cola"));
    assert.equal(coke.deal, "5 for R100 (R20.00 each)");
    assert.equal(coke.limit, "2 deals per customer");
  });
  test("per kg, per pack, per deal and combos say so", () => {
    assert.equal(W.flmDealText(deal("flm-2-exotic-tomatoes")).deal, "R59.00 per kg");
    assert.equal(W.flmDealText(deal("flm-3-oukraal-sizzler")).deal, "R50.00 per pack");
    assert.equal(W.flmDealText(deal("flm-3-chicken-wings")).deal, "R100.00 per deal");
    assert.equal(W.flmDealText(deal("flm-8-combo-3-x-white-grape")).deal, "R99.00 for the combo");
  });
  test("every deal gets words, and a multi-buy never reads as a price for one item alone", () => {
    for (const d of W.FLM_FLYER.deals) {
      const x = W.flmDealText(d);
      assert.ok(x.deal && !/undefined|NaN/.test(x.deal + x.need), d.id);
      if (d.qty > 1) { assert.equal(x.multi, true, d.id); assert.match(x.need, new RegExp(`when you buy (any )?${d.qty} \\(R`), d.id); assert.match(x.deal, new RegExp(`^(Any )?${d.qty} for R`), d.id); }
    }
  });
  test("the unit price is the flyer's own number", () => {
    const it = W.flmItem(deal("flm-1-la-belinda"));
    assert.equal(it.price, 12.5); assert.equal(it.total, 100); assert.equal(it.qty, 8);
    assert.equal(it.url, "https://foodloversmarket.co.za/"); assert.equal(it.flyer, true);
  });
});

describe("flyer: search", () => {
  test("grocery words find the flyer deals", (t) => {
    at(DURING, t);
    const first = (q) => (W.flmSearch(q)[0] || {}).title;
    assert.equal(first("Jungle Oats"), "Jungle Oats 1 kg");
    assert.equal(first("Tastic rice"), "Tastic Long Grain Parboiled Rice 2 kg");
    assert.match(first("Nescafe Gold"), /^Nescafe Gold Instant Coffee/);
    assert.match(first("Nescafé Gold"), /^Nescafe Gold Instant Coffee/);
    assert.equal(first("Weet-Bix"), "Bokomo Weet-Bix 1.35 kg");
    assert.equal(first("weetbix"), "Bokomo Weet-Bix 1.35 kg");
    assert.equal(first("eggs"), "Large Eggs 18s");
    assert.match(first("Coca-Cola"), /^Coca-Cola Original Taste Less Sugar 2 L/);
    assert.ok(W.flmSearch("baked beans").some((x) => /^Rhodes Baked Beans/.test(x.title)));
    assert.ok(W.flmSearch("Sunlight").length >= 2);
    assert.ok(W.flmSearch("olive oil").length >= 1);
    assert.ok(W.flmSearch("milk").some((x) => x.title === "Clover Full Cream Fresh Milk 2 L"));
  });
  test("lowest price for one item first; no more than 8; words that are not on the flyer find nothing", (t) => {
    at(DURING, t);
    const r = W.flmSearch("milk");
    assert.deepEqual(r.map((x) => x.price), [...r.map((x) => x.price)].sort((a, b) => a - b));
    assert.ok(W.flmSearch("pork").length <= 8);
    assert.deepEqual(W.flmSearch("PS5 Slim"), []);
    assert.deepEqual(W.flmSearch("Jungle Oats Instant"), []);
  });
  test("plan: Food Lover's Market first for South Africa, only when the flyer has the words", (t) => {
    at(DURING, t);
    const p = W.srchPlan("Jungle Oats", "ZA");
    assert.deepEqual(p.shops[0], { id: "flm", name: "Food Lover's Market", flyer: true });
    assert.equal(p.category, "groceries");
    assert.ok(p.shops.some((s) => s.id === "pnp"), "other grocery shops too");
    assert.ok(!W.srchPlan("PS5 Slim", "ZA").shops.some((s) => s.id === "flm"));
    assert.ok(!W.srchPlan("Jungle Oats", "GB").shops.some((s) => s.id === "flm"), "not in the UK");
    const wings = W.srchPlan("chicken wings", "ZA");
    assert.equal(wings.shops[0].id, "flm");
    assert.equal(wings.category, "groceries", "a flyer deal makes it a grocery search");
  });
});

function setup(t, now) {
  at(now, t);
  const { db, env } = testDb(t);
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input) => { calls.push(typeof input === "string" ? input : input.url); return new Response("not mocked", { status: 599 }); };
  t.after(() => { globalThis.fetch = real; });
  const ip = "192.0.2." + (++ipSeq);
  const waits = [];
  const get = async (path) => {
    const r = await worker.fetch(new Request("https://site.test" + path, { headers: { "user-agent": UA, "cf-connecting-ip": ip } }), env, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits.splice(0));
    return r;
  };
  const writes = () => db.prepare("SELECT COUNT(*) AS n FROM cache WHERE k LIKE '%flm%'").get().n;
  return { db, env, calls, get, writes };
}

describe("flyer: search API", () => {
  test("/api/search/shop?shop=flm: flyer rows, honest label, no shop fetch, no D1 rows", async (t) => {
    const { get, calls, writes } = setup(t, DURING);
    const plan = await (await get("/api/search?q=Tastic+rice&c=ZA")).json();
    assert.equal(plan.shops[0].id, "flm");
    const r = await get("/api/search/shop?q=Tastic+rice&c=ZA&shop=flm");
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.status, "ok"); assert.equal(d.flyer, true);
    assert.equal(d.label, "Food Lover's Market (Western Cape flyer, valid 23\u201329 Nov)");
    assert.equal(d.items.length, 1);
    const it = d.items[0];
    assert.equal(it.title, "Tastic Long Grain Parboiled Rice 2 kg");
    assert.equal(it.price, 27.99); assert.equal(it.deal, "R27.99 each"); assert.equal(it.url, "https://foodloversmarket.co.za/");
    assert.equal(calls.length, 0, "no fetch");
    assert.equal(writes(), 0, "no D1 rows");
    assert.ok(+/max-age=(\d+)/.exec(r.headers.get("cache-control"))[1] <= 300);
  });
  test("/api/search/shop?shop=flm after the end: 'ended', no items", async (t) => {
    const { get } = setup(t, AFTER);
    const d = await (await get("/api/search/shop?q=Jungle+Oats&c=ZA&shop=flm")).json();
    assert.equal(d.status, "ended"); assert.deepEqual(d.items, []);
    const plan = await (await get("/api/search?q=Jungle+Oats&c=ZA")).json();
    assert.ok(!plan.shops.some((s) => s.id === "flm"));
  });
  test("a plan with the flyer is not cached past the end", async (t) => {
    const { get } = setup(t, LAST_MINUTE);
    const r = await get("/api/search?q=Jungle+Oats&c=ZA");
    assert.equal(r.headers.get("cache-control"), "public, max-age=59");
  });
  test("UK: refused", async (t) => {
    const { get } = setup(t, DURING);
    assert.equal((await get("/api/search/shop?q=Jungle+Oats&c=GB&shop=flm")).status, 400);
  });
});

describe("flyer: compare is strict", () => {
  const m = (title, brand = null, price = null) => W.flmCompare(src(title, brand, price));
  test("same brand, name and size match", (t) => {
    at(DURING, t);
    assert.equal(m("Jungle Oats 1kg", "Jungle", 39.99).title, "Jungle Oats 1 kg");
    assert.equal(m("Jungle Oats Original 1kg").title, "Jungle Oats 1 kg");
    assert.match(m("NESCAFÉ Gold Instant Coffee 200g", "Nescafe", 160).title, /^Nescafe Gold/);
    assert.match(m("Nescafe Gold 220g", null, 170).title, /^Nescafe Gold/, "either flyer size");
    assert.equal(m("Tastic Long Grain Parboiled Rice 2kg", "Tastic", 45).title, "Tastic Long Grain Parboiled Rice 2 kg");
    assert.equal(m("Bokomo Weet-Bix 1.35kg", "Bokomo", 80).title, "Bokomo Weet-Bix 1.35 kg");
    assert.equal(m("Bokomo Weetbix Original 1.35kg", null, 80).title, "Bokomo Weet-Bix 1.35 kg");
    assert.equal(m("Clover Fresh Full Cream Milk 2L", "Clover", 35).title, "Clover Full Cream Fresh Milk 2 L");
    assert.equal(m("Sunlight Original Dishwashing Liquid 750ml", "Sunlight", 35).title, "Sunlight Original Dishwashing Liquid Bottles 750 ml");
    assert.match(m("Rhodes Baked Beans in Tomato Sauce 400g", "Rhodes", 19).title, /^Rhodes Baked Beans/);
    assert.match(m("Coca-Cola Original Taste Less Sugar 2L", "Coca-Cola", 30).title, /^Coca-Cola/);
  });
  test("'or' on the flyer covers each choice, and two products with sizes are two products", (t) => {
    at(DURING, t);
    assert.match(m("La Belinda Chopped Tomatoes 400g", null, 18).title, /^La Belinda/);
    assert.match(m("La Belinda Peeled Tomatoes 400g", null, 18).title, /^La Belinda/);
    assert.match(m("Rhodes Whole Kernel Corn 410g", null, 25).title, /Corn 410 g$/);
    assert.match(m("Nola Original Mayonnaise 750g", "Nola", 50).title, /^Nola/);
    assert.match(m("Sunlight Auto Liquid Detergent 1.5L", "Sunlight", 70).title, /^Sunlight 5-in-1/);
    assert.match(m("Sunlight 5-in-1 Washing Powder 2kg", "Sunlight", 70).title, /^Sunlight 5-in-1/);
    assert.equal(m("Sunlight Auto Liquid Detergent 2kg", "Sunlight", 70), null, "the size goes with its product");
  });
  test("another size, kind, flavour, brand or pack is not the same product", (t) => {
    at(DURING, t);
    for (const [title, brand, price] of [
      ["Jungle Oats 500g", "Jungle", 25], ["Jungle Instant Oats 1kg", "Jungle", 40], ["Nescafe Gold Decaf 200g", "Nescafe", 160],
      ["Nescafe Gold 100g", "Nescafe", 90], ["Nescafe Gold Cappuccino 200g", "Nescafe", 160], ["Tastic Basmati Rice 2kg", "Tastic", 60],
      ["Tastic Long Grain Parboiled Rice 1kg", "Tastic", 25], ["Bokomo Weet-Bix 900g", "Bokomo", 60], ["Bokomo Weet-Bix Fruit 1.35kg", "Bokomo", 80],
      ["Clover Low Fat Fresh Milk 2L", "Clover", 35], ["Clover Full Cream Long Life Milk 2L", "Clover", 35], ["Clover Full Cream Fresh Milk 1L", "Clover", 20],
      ["Sunlight Lemon Dishwashing Liquid 750ml", "Sunlight", 35], ["Koo Baked Beans in Tomato Sauce 400g", "Koo", 18], ["Rhodes Baked Beans 6 x 400g", "Rhodes", 100],
      ["Coca-Cola Original 2L", "Coca-Cola", 30], ["Coca-Cola No Sugar 2L", "Coca-Cola", 30], ["Nola Lite Mayonnaise 750g", "Nola", 50],
      ["Large Eggs 18s", null, 70], ["Food Lover's Shredded Tuna in Brine 170g", null, 20], ["Jungle Oats", "Jungle", 40],
    ]) assert.equal(m(title, brand, price), null, title);
  });
  test("combos, fresh items without a brand and the shop's own brand are never compared", (t) => {
    at(DURING, t);
    for (const d of W.FLM_FLYER.deals) {
      if (d.is_combo || !d.brand || /^Food Lover/.test(d.brand)) assert.ok(W.flmMatchWhy(src(d.title, d.brand), d), d.id);
    }
  });
  test("a flyer price far from the checked price is not trusted", (t) => {
    at(DURING, t);
    assert.equal(m("Jungle Oats 1kg", "Jungle", 400), null);
    assert.equal(m("Jungle Oats 1kg", "Jungle", 5), null);
  });
  test("every branded flyer line matches its own name (no line is unreachable by mistake)", (t) => {
    at(DURING, t);
    const ok = W.FLM_FLYER.deals.filter((d) => !d.is_combo && d.brand && !/^Food Lover|\//.test(d.brand) && /\d\s*(g|kg|ml|l)\b/i.test(d.title) && !/\bor\b|,|\d\s*(g|ml|l)\s*[/-]/i.test(d.title));
    assert.ok(ok.length >= 30, ok.length);
    for (const d of ok) assert.equal(W.flmMatchWhy(src(d.title.replace(/\([^)]*\)/g, ""), d.brand), d), null, d.title);
  });
});

describe("flyer: compare API", () => {
  const CANON = "https://www.pnp.co.za/jungle-oats-1kg/p/000000000000123456_EA";
  function product(db, title = "Jungle Oats Original 1kg", price = 39.99) {
    db.prepare("INSERT INTO tracked (url, orig_url, title, added_at, last_viewed, last_checked, last_status, check_count) VALUES (?, ?, ?, ?, ?, ?, 'ok', 1)").run(CANON, CANON, title, Date.now(), Date.now(), Date.now());
    const cur = { status: "ok", checked_at: Date.now(), price, currency: "ZAR", title, source: "pnp", brand: "Jungle", category: "Food Cupboard" };
    return W.cachePut({ DB: null }, W.LIVE_CACHE_PREFIX + CANON, cur, 3600e3);
  }
  test("plan has Food Lover's Market; its answer is the flyer deal, not saved to history or cache", async (t) => {
    const { db, get, calls } = setup(t, DURING);
    await product(db);
    const plan = await (await get("/api/compare?url=" + encodeURIComponent(CANON))).json();
    assert.ok(plan.shops.some((s) => s.id === "flm"), JSON.stringify(plan.shops));
    const r = await get("/api/compare/shop?shop=flm&url=" + encodeURIComponent(CANON));
    const d = await r.json();
    assert.equal(d.status, "match");
    assert.equal(d.match.level, "flyer");
    assert.equal(d.match.price, 29.99);
    assert.equal(d.match.url, "https://foodloversmarket.co.za/");
    assert.equal(d.match.flyer.label, "Food Lover's Market (Western Cape flyer, valid 23\u201329 Nov)");
    assert.equal(d.match.flyer.deal, "R29.99 each");
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(calls.length, 0, "no fetch");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cache WHERE k LIKE 'cmp-%:flm:%'").get().n, 0, "no cached answer");
    assert.equal(await W.cacheGet({}, "cmp-" + W.CMP_VER + ":flm:" + CANON), null, "not in the Cloudflare cache or memory either");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tracked WHERE url LIKE '%foodloversmarket%'").get().n, 0, "no price history for the flyer");
  });
  test("multi-buy: the price for one item, and the rule in words", async (t) => {
    const { db, get } = setup(t, DURING);
    await product(db, "Rhodes Baked Beans in Tomato Sauce 400g", 18.99);
    const d = await (await get("/api/compare/shop?shop=flm&url=" + encodeURIComponent(CANON))).json();
    assert.equal(d.status, "match");
    assert.equal(d.match.price, 10);
    assert.equal(d.match.flyer.qty, 10);
    assert.equal(d.match.flyer.need, "R10.00 each when you buy 10 (R100 total)");
  });
  test("after the end: Food Lover's Market is not in the plan, and its answer is 'skipped'", async (t) => {
    const { db, get } = setup(t, AFTER);
    await product(db);
    const plan = await (await get("/api/compare?url=" + encodeURIComponent(CANON))).json();
    assert.ok(!plan.shops.some((s) => s.id === "flm"));
    const d = await (await get("/api/compare/shop?shop=flm&url=" + encodeURIComponent(CANON))).json();
    assert.equal(d.status, "skipped");
    assert.equal(d.match, undefined);
  });
});

describe("flyer: the page", () => {
  const js = readFileSync(new URL("../../public/result.js", import.meta.url), "utf8");
  test("flyer rows: no price history button, the shop's home page, 'In-store flyer deal'", () => {
    assert.match(js, /In-store flyer deal/);
    assert.match(js, /href="\$\{esc\(it\.url\)\}"/, "the flyer's own shop home page (src/flyer.js url)");
    assert.match(js, /each when you buy \$\{f\.qty\}/, "the headline says the multi-buy rule");
  });
});
