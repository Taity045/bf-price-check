// Pick n Pay, SPAR & TOPS and Shoprite flyer deals next to Food Lover's Market (src/flyer.js): the data, the deal
// words (badges, limits, normal prices, notes), search over every flyer, and auto-expiry at each deal's own
// valid_to 23:59:59 SAST (Shoprite MoneyMarket phones run to 6 Dec). No network. Time is set with Date.now.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { W, worker } from "../helpers/load-worker.mjs";
import { testDb } from "../helpers/db.mjs";

const T = (s) => Date.parse(s);
const BEFORE_PNP = T("2026-11-25T21:59:59Z");     // 23:59:59 SAST on 25 Nov (Pick n Pay starts 26 Nov)
const DURING = T("2026-11-26T12:00:00Z");         // 14:00 SAST on 26 Nov
const LAST = T("2026-11-29T21:59:59Z");           // 23:59:59 SAST on 29 Nov
const AFTER = T("2026-11-29T22:00:00Z");          // 00:00 SAST on 30 Nov
const PHONE_LAST = T("2026-12-06T21:59:59Z");     // 23:59:59 SAST on 6 Dec
const PHONE_AFTER = T("2026-12-06T22:00:00Z");    // 00:00 SAST on 7 Dec
const realNow = Date.now;
function at(t, ctx) { Date.now = () => t; ctx.after(() => { Date.now = realNow; }); }
const F = (id) => W.flyerById(id);
const raw = (f) => JSON.parse(readFileSync(new URL("../../data/" + f, import.meta.url), "utf8"));
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
let ipSeq = 0;
function setup(t, now) {
  at(now, t);
  const { db, env } = testDb(t);
  const real = globalThis.fetch, calls = [];
  globalThis.fetch = async (input) => { calls.push(String(input && input.url || input)); return new Response("not mocked", { status: 599 }); };
  t.after(() => { globalThis.fetch = real; });
  const ip = "198.51.100." + (++ipSeq);
  const get = (path) => worker.fetch(new Request("https://site.test" + path, { headers: { "user-agent": UA, "cf-connecting-ip": ip } }), env, { waitUntil() {} });
  return { db, get, calls };
}

describe("flyers: the data", () => {
  test("deal counts: Pick n Pay 58, SPAR & TOPS 42, Shoprite 120 (Sofnfree has no printed price: out), FLM 141", () => {
    assert.equal(W.PNP_FLYER.deals.length, 58);
    assert.equal(W.SPAR_FLYER.deals.length, 42);
    assert.equal(W.SHOPRITE_FLYER.deals.length, 120);
    assert.equal(W.FLM_FLYER.deals.length, 141);
    assert.ok(!W.SHOPRITE_FLYER.deals.some((d) => /sofnfree/i.test(d.title)));
    for (const f of W.FLYERS) for (const d of f.data.deals) { assert.ok(d.price > 0 && d.unit_price > 0 && d.qty >= 1, d.id); assert.ok(d.valid_from && d.valid_to, d.id); }
  });
  test("the built Worker has the same deals and prices as the data files", () => {
    const built = readFileSync(new URL("../../dist/worker.js", import.meta.url), "utf8");
    for (const [name, file] of [["PNP_FLYER", "pnp-flyer-2026-11-26.json"], ["SPAR_FLYER", "spar-flyer-2026-11-25.json"], ["SHOPRITE_FLYER", "shoprite-flyer-2026-11-26.json"]]) {
      const m = built.match(new RegExp("^const " + name + " = (.+);$", "m"));
      assert.ok(m, name + " in dist/worker.js (run python3 build.py)");
      const b = JSON.parse(m[1]), r = raw(file).deals.filter((d) => d.price != null);
      assert.equal(b.deals.length, r.length, name);
      for (const d of r) { const x = b.deals.find((y) => y.id === d.id); assert.ok(x, d.id); assert.equal(x.price, d.price); assert.equal(x.unit_price, d.unit_price); assert.equal(x.valid_to, d.valid_to); }
    }
  });
  test("shop names, regions and fine print", () => {
    assert.equal(F("pnpflyer").shop, "Pick n Pay"); assert.equal(F("sparflyer").shop, "SPAR & TOPS"); assert.equal(F("shopriteflyer").shop, "Shoprite");
    assert.match(F("pnpflyer").fine, /Supermarkets and Mini Markets in Gauteng, North West, Mpumalanga, Limpopo and Northern Cape\. Not at Hypermarkets\./);
    assert.match(F("shopriteflyer").fine, /Shoprite stores in Gauteng, Mpumalanga, North West and Limpopo\. Not at the stores the flyer lists as excluded\./);
    assert.equal(F("pnpflyer").label, "Pick n Pay (Gauteng, North West, Mpumalanga, Limpopo and Northern Cape flyer, valid 26\u201329 Nov)");
    assert.equal(F("sparflyer").label, "SPAR & TOPS (South Africa flyer, valid 25\u201329 Nov)");
    for (const id of ["pnpflyer", "sparflyer", "shopriteflyer"]) { const s = W.cmpShopById(id); assert.ok(s && s.flyer && s.cur === "ZAR" && s.hosts.length === 0, id); }
  });
});

describe("flyers: deal words", () => {
  const item = (id, pre) => W.flyItem(F(id), F(id).data.deals.find((d) => d.id.startsWith(pre)));
  test("Pick n Pay: Smart Shopper badge, multi-buy normal price 'R… for N', per-customer limit", (t) => {
    at(DURING, t);
    const coke = item("pnpflyer", "pnp-1-coca-cola-original-taste-less-sugar-1-5");
    assert.equal(coke.deal, "2 for R28 (R14.00 each)");
    assert.equal(coke.need, "R14.00 each when you buy 2 (R28 total)");
    assert.equal(coke.limit, "4 deals per customer");
    assert.equal(coke.regular, "Normal price R43.98 for 2");
    assert.deepEqual(coke.badges, ["Smart Shopper"]);
    const cam = item("pnpflyer", "pnp-1-volkano");
    assert.equal(cam.regular, "Normal price R299.99"); assert.equal(cam.deal, "R199.99 each");
    const single = F("pnpflyer").data.deals.find((d) => /^each \(\d deals per customer\)$/.test(d.deal_text));
    const x = W.flyItem(F("pnpflyer"), single);
    assert.match(x.limit, /^\d deals per customer$/); assert.match(x.deal, /^R[\d.]+ each$/);
    const mince = item("pnpflyer", "pnp-2-bulk-lean-beef-mince");
    assert.deepEqual(mince.badges, [], "no Smart Shopper mark on the flyer: no badge"); assert.equal(mince.deal, "R109.99 per kg");
  });
  test("SPAR & TOPS: SPAR Rewards badge; max 5 deals on pages 1-3, max 12 on TOPS liquor; combos", () => {
    for (const d of F("sparflyer").data.deals) {
      const x = W.flyItem(F("sparflyer"), d);
      assert.deepEqual(x.badges, ["SPAR Rewards"], d.id);
      assert.equal(x.limit, d.page === 4 ? "Max 12 deals per customer" : "Max 5 deals per customer", d.id);
    }
    const combos = F("sparflyer").data.deals.filter((d) => /^combo/.test(d.deal_text));
    assert.equal(combos.length, 6);
    for (const d of combos) assert.match(W.flyItem(F("sparflyer"), d).deal, /^R[\d.]+ for the combo$/);
  });
  test("Shoprite: Xtra Savings badge, limit field, 'from' price, MoneyMarket note", () => {
    const goldi = item("shopriteflyer", "shoprite-1-goldi");
    assert.equal(goldi.limit, "Max 6 deals per customer"); assert.deepEqual(goldi.badges, ["Xtra Savings"]);
    assert.equal(item("shopriteflyer", "shoprite-3-carling").limit, "Max 3 per customer");
    const mag = item("shopriteflyer", "shoprite-4-slow-mag");
    assert.equal(mag.deal, "From R62.00"); assert.match(mag.note, /changes by variant/);
    const honor = item("shopriteflyer", "shoprite-4-honor-t10");
    assert.match(honor.note, /MoneyMarket/); assert.equal(honor.label, "Shoprite (Gauteng, Mpumalanga, North West and Limpopo flyer, valid 23 Nov\u20136 Dec)");
    assert.equal(item("shopriteflyer", "shoprite-2-combo-buy-beef-steak").deal, "R140.00 per kg (combo)");
    assert.equal(item("shopriteflyer", "shoprite-4-rehidrat").note, null, "no note about how the flyer was typed");
  });
});

describe("flyers: search", () => {
  test("Coca-Cola: every flyer is a searched shop, first, in order", (t) => {
    at(DURING, t);
    const ids = W.srchPlan("Coca-Cola", "ZA").shops.map((s) => s.id);
    assert.deepEqual(ids.slice(0, 4), ["flm", "pnpflyer", "sparflyer", "shopriteflyer"]);
    assert.ok(ids.includes("takealot"), "normal online shops still searched");
    assert.equal(W.srchPlan("Coca-Cola", "GB").shops.filter((s) => /flyer|flm/.test(s.id)).length, 0, "UK: no flyers");
  });
  test("an appliance on a flyer does not turn the search into groceries", (t) => {
    at(DURING, t);
    assert.notEqual(W.srchPlan("Volkano dash camera", "ZA").category, "groceries");
    assert.ok(W.srchPlan("Volkano dash camera", "ZA").shops.some((s) => s.id === "pnpflyer"));
  });
  test("/api/search/shop for each flyer: rows with badges, label and fine print; no shop fetch", async (t) => {
    const { get, calls } = setup(t, DURING);
    for (const [id, badge] of [["pnpflyer", "Smart Shopper"], ["sparflyer", "SPAR Rewards"], ["shopriteflyer", "Xtra Savings"]]) {
      const d = await (await get(`/api/search/shop?q=Coca-Cola&c=ZA&shop=${id}`)).json();
      assert.equal(d.status, "ok", id); assert.equal(d.flyer, true); assert.equal(d.label, F(id).label);
      assert.ok(d.items.every((x) => x.flyer && x.badges.includes(badge) && x.fine === F(id).fine && x.url === F(id).home), id);
    }
    assert.equal(calls.length, 0);
  });
  test("plan cache is not kept past the next deal end (29 Nov), even with phones running to 6 Dec", async (t) => {
    const { get } = setup(t, T("2026-11-29T21:58:00Z"));
    const r = await get("/api/search?q=Honor+T10&c=ZA");
    assert.equal(r.headers.get("cache-control"), "public, max-age=119");
  });
});

describe("flyers: auto-expiry at each deal's own valid_to 23:59:59 SAST", () => {
  const has = (id, q) => W.flyerSearch(F(id), q).length > 0;
  test("before the start: Pick n Pay deals do not show; SPAR does (it starts 25 Nov)", (t) => {
    at(BEFORE_PNP, t);
    assert.equal(has("pnpflyer", "Coca-Cola"), false);
    assert.equal(W.flyerActive(F("pnpflyer")), false);
    assert.equal(has("sparflyer", "Coca-Cola"), true);
  });
  test("23:59:59 SAST on 29 Nov: every flyer still shows", (t) => {
    at(LAST, t);
    for (const id of ["flm", "pnpflyer", "sparflyer", "shopriteflyer"]) assert.equal(has(id, "Coca-Cola"), true, id);
  });
  test("00:00 SAST on 30 Nov: FLM, Pick n Pay, SPAR and normal Shoprite deals are gone; only MoneyMarket phones stay", (t) => {
    at(AFTER, t);
    for (const id of ["flm", "pnpflyer", "sparflyer"]) { assert.equal(W.flyerActive(F(id)), false, id); assert.equal(has(id, "Coca-Cola"), false, id); }
    assert.equal(has("shopriteflyer", "Coca-Cola"), false);
    const live = W.FLYERS.flatMap((f) => f.data.deals.filter((d) => W.flyDealLive(f, d)).map((d) => d.id));
    assert.deepEqual(live.sort(), ["shoprite-4-feature-phone-s8-plus-brand-name-illegible-with-free-data-ai", "shoprite-4-honor-t10-32gb-smartphone-with-free-20gb-data"]);
    assert.equal(has("shopriteflyer", "Honor T10"), true);
    const plan = W.srchPlan("Coca-Cola", "ZA");
    assert.ok(!plan.shops.some((s) => s.id === "flm" || /flyer$/.test(s.id)), JSON.stringify(plan.shops));
    assert.ok(plan.shops.length > 0, "online shops still searched");
  });
  test("6 Dec 23:59:59 SAST: phones still show; 7 Dec 00:00 SAST: gone, Shoprite is not searched", (t) => {
    at(PHONE_LAST, t);
    assert.equal(has("shopriteflyer", "Honor T10"), true);
    Date.now = () => PHONE_AFTER;
    assert.equal(has("shopriteflyer", "Honor T10"), false);
    assert.equal(W.flyerActive(F("shopriteflyer")), false);
    assert.ok(!W.srchPlan("Honor T10", "ZA").shops.some((s) => s.id === "shopriteflyer"));
  });
  test("after the end the API says 'ended' with no rows", async (t) => {
    const { get } = setup(t, AFTER);
    const d = await (await get("/api/search/shop?q=Coca-Cola&c=ZA&shop=pnpflyer")).json();
    assert.equal(d.status, "ended"); assert.deepEqual(d.items, []);
    const p = await (await get("/api/search/shop?q=Honor+T10&c=ZA&shop=shopriteflyer")).json();
    assert.equal(p.status, "ok"); assert.equal(p.items[0].title, "Honor T10 32GB smartphone with free 20GB data");
  });
});

describe("flyers: compare", () => {
  const src = (title, brand = null, price = null) => W.cmpIdentity({ title, brand, price }, "https://www.checkers.co.za/p/1");
  test("strict match on a new flyer with its badge; the shop's own brand never matches", (t) => {
    at(DURING, t);
    const m = W.flyerCompare(F("shopriteflyer"), src("Goldi Frozen Mixed Chicken Portions 5kg", "Goldi", 199));
    assert.ok(m, "Goldi 5 kg matches"); assert.equal(m.price, 169); assert.deepEqual(m.badges, ["Xtra Savings"]);
    const own = F("sparflyer").data.deals.find((d) => /^SPAR$/i.test(d.brand));
    assert.equal(W.flmMatchWhy(src(own.title, own.brand), own, F("sparflyer").own), "own brand");
  });
  test("after the end: compare finds nothing on the ended flyers", (t) => {
    at(AFTER, t);
    assert.equal(W.flyerCompare(F("shopriteflyer"), src("Goldi Frozen Mixed Chicken Portions 5kg", "Goldi", 199)), null);
    assert.equal(W.flyerCompareAnswer(F("pnpflyer"), src("Coca-Cola Original 1.5L", "Coca-Cola", 20)).status, "skipped");
  });
});
