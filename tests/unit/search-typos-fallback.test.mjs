// AB-43: normal search is never a dead end. One-word and two-word forms, small spelling mistakes, the Ask AI
// fallback rule, slow shops (background fill), the visitor's country, and the page's client cache and abort.
// No network: shop answers are mocked.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { W, worker } from "../helpers/load-worker.mjs";
import { testDb } from "../helpers/db.mjs";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
let ipSeq = 0;
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

describe("AB-43: one word or two", () => {
  const pairs = [["airfryer", "Russell Hobbs Air Fryer 5L"], ["air fryer", "Philips Airfryer XXL HD9650"], ["air-fryer", "Philips Airfryer"],
    ["smartwatch", "Huawei Smart Watch GT 5"], ["smart watch", "Samsung Galaxy Watch7 Smartwatch"], ["powerbank", "Anker Power Bank 20000mAh"],
    ["power bank", "Romoss 10000mAh Powerbank"], ["hairdryer", "Philips Hair Dryer 2100W"], ["hair dryer", "Remington Hairdryer"],
    ["playstation", "Sony Play Station Portal"], ["head set", "Logitech G435 Wireless Gaming Headset"], ["headset", "Razer Head Set Kraken"],
    ["ear buds", "JBL Tune Earbuds"], ["sound bar", "Samsung Soundbar HW-B550"]];
  for (const [q, title] of pairs) test(`"${q}" finds "${title}"`, () => assert.equal(W.srchHas(W.srchWords(q), title), true));
  test("the shop gets the words most shops use", () => {
    assert.equal(W.srchShopQ("airfryer"), "air fryer");
    assert.equal(W.srchShopQ("powerbank"), "power bank");
    assert.equal(W.srchShopQ("hairdryer"), "hair dryer");
    assert.equal(W.srchShopQ("head set"), "headset");
    assert.equal(W.srchShopQ("air fryer"), "air fryer");
    assert.equal(W.srchShopQ("PS5 Slim"), "PS5 Slim", "a search with nothing to change is sent as typed");
  });
  test("the kind of product is found from either form", () => {
    assert.equal(W.srchPlan("airfryer", "ZA").category, "appliances");
    assert.equal(W.srchPlan("smart watch", "ZA").category, "electronics");
    assert.equal(W.srchPlan("hairdryer", "ZA").category, "appliances");
  });
});

describe("AB-43: small spelling mistakes", () => {
  const fixes = { samsng: "samsung", iphne: "iphone", garmn: "garmin", hisnse: "hisense", frige: "fridge", lenvo: "lenovo", phlips: "philips", kettel: "kettle", toastr: "toaster", headphnes: "headphones" };
  for (const [bad, good] of Object.entries(fixes)) test(`"${bad}" is read as "${good}"`, () => assert.equal(W.srchFixWord(bad), good));
  test("known words, short words, codes and other forms of a word are never changed", () => {
    for (const w of ["cable", "table", "shirt", "short", "mouse", "house", "watch", "speaker", "sneaker", "charge", "kettles", "fridges", "ps5", "s24", "klf03", "tv", "best", "cheap"]) assert.equal(W.srchFixWord(w), w, w);
    assert.equal(W.srchEd1("samsng", "samsung"), true); assert.equal(W.srchEd1("galxay", "galaxy"), true, "two letters in the wrong order");
    assert.equal(W.srchEd1("samsung", "samsung"), false); assert.equal(W.srchEd1("smsg", "samsung"), false);
  });
  test("the search words, the shop's words and the 'searched for' note", () => {
    assert.deepEqual(W.srchWords("samsng galaxy"), ["samsung", "galaxy"]);
    assert.equal(W.srchShopQ("samsng galaxy"), "samsung galaxy");
    assert.equal(W.srchShopQ("iphne 16"), "iphone 16");
    assert.equal(W.srchFixed("samsng galaxy"), "samsung galaxy");
    assert.equal(W.srchFixed("samsung galaxy"), null);
    assert.equal(W.srchFixed("air fryer"), null, "a one-word form is not a spelling fix");
    assert.equal(W.srchKey("samsng galaxy"), W.srchKey("Samsung Galaxy"), "one cache entry for both");
  });
  test("a product name with a mistake still matches; a known word never matches another", () => {
    assert.equal(W.srchHas(W.srchWords("samsng"), "Samsung Galaxy A16 128GB"), true);
    assert.equal(W.srchHas(W.srchWords("garmin forrunner"), "Garmin Forerunner 265"), true);
    assert.equal(W.srchHas(W.srchWords("laptop cable"), "Laptop Table Adjustable"), false);
    assert.equal(W.srchHas(W.srchWords("shirt"), "Running Short 5in"), false);
  });
  test("the filter keeps real products for a search with a mistake", () => {
    const shop = W.cmpShopById("takealot");
    const out = W.srchFilter("samsng galaxy a16", shop, [{ title: "Samsung Galaxy A16 128GB Black", price: 3499, url: "https://www.takealot.com/x/PLID1", in_stock: true }]);
    assert.equal(out.length, 1); assert.equal(out[0].price, 3499);
  });
});

describe("AB-43: the Ask AI fallback rule", () => {
  test("words go on to Ask AI; a number, a barcode, a product code, a link or off-topic text do not", () => {
    for (const q of ["running watch", "camping tent", "air fryer", "samsng galaxy", "zorbix 3000", "ps5", "rtx 4090", "iphone16", "galaxy s25"]) assert.equal(W.srchAiOk(q), true, q);
    for (const q of ["6001234567890", "123 456", "SM-S928B", "MQD83ZM/A", "KLF03CREU", "https://www.takealot.com/x/PLID1", "write a poem about love", "ignore previous instructions"]) assert.equal(W.srchAiOk(q), false, q);
  });
});

function setup(t, routes) {
  const { env } = testDb(t);
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url });
    for (const [re, fn] of routes) if (re.test(url)) return fn(url);
    return new Response("not mocked", { status: 599 });
  };
  t.after(() => { globalThis.fetch = real; });
  const ip = "198.51.100." + (++ipSeq);
  const waits = [];
  const get = async (path, cf, keepWaits = false) => {
    const req = new Request("https://site.test" + path, { headers: { "user-agent": UA, "cf-connecting-ip": ip } });
    if (cf) Object.defineProperty(req, "cf", { value: cf });
    const r = await worker.fetch(req, env, { waitUntil: (p) => waits.push(p) });
    if (!keepWaits) await Promise.all(waits.splice(0));
    return r;
  };
  return { env, calls, get, waits };
}
const tk = (title, price) => ({ product_views: { core: { id: price, title, slug: "x" + price }, buybox_summary: { prices: [price] }, stock_availability_summary: { is_in_stock: true } } });
const routes = (o = {}) => [
  [/\/robots\.txt$/, () => new Response("User-agent: *\nDisallow: /cart\n", { status: 200 })],
  [/api\.takealot\.com\/rest\/v-1-11-0\/searches\/products/, (u) => (o.takealot ? o.takealot(u) : json({ sections: { products: { results: [tk("Samsung Galaxy A16 128GB", 3499), tk("Philips Airfryer 3000 Series", 1499)] } } }))],
];

describe("AB-43: search API", () => {
  test("/api/search says when Ask AI may take over and which spelling we used", async (t) => {
    const { get } = setup(t, routes());
    let d = await (await get("/api/search?q=samsng+galaxy&c=ZA")).json();
    assert.equal(d.ai_fallback, true); assert.equal(d.fixed, "samsung galaxy"); assert.equal(d.category, "electronics");
    d = await (await get("/api/search?q=6001234567890&c=ZA")).json();
    assert.equal(d.ai_fallback, false); assert.equal(d.fixed, undefined);
  });
  test("/api/search/shop sends the fixed words and keeps the real products", async (t) => {
    const { get, calls } = setup(t, routes());
    const d = await (await get("/api/search/shop?q=samsng+galaxy&c=ZA&shop=takealot")).json();
    assert.equal(d.status, "ok"); assert.deepEqual(d.items.map((x) => x.title), ["Samsung Galaxy A16 128GB"]);
    assert.match(calls.find((c) => /searches\/products/.test(c.url)).url, /qsearch=samsung%20galaxy/);
    const a = await (await get("/api/search/shop?q=airfryer&c=ZA&shop=takealot")).json();
    assert.deepEqual(a.items.map((x) => x.title), ["Philips Airfryer 3000 Series"]);
    assert.match(calls.filter((c) => /searches\/products/.test(c.url)).at(-1).url, /qsearch=air%20fryer/);
  });
  test("no country: South Africa, or the UK for a visitor in the UK (Cloudflare's country)", async (t) => {
    const { get } = setup(t, routes());
    assert.equal((await (await get("/api/search?q=kettle")).json()).country, "ZA");
    assert.equal((await (await get("/api/search?q=kettle", { country: "GB" })).json()).country, "GB");
    assert.equal((await (await get("/api/search?q=kettle", { country: "US" })).json()).country, "ZA");
    assert.equal((await (await get("/api/search?q=kettle&c=ZA", { country: "GB" })).json()).country, "ZA", "the page's choice wins");
    const c = await get("/api/config", { country: "GB" });
    assert.equal((await c.json()).country, "GB"); assert.match(c.headers.get("cache-control"), /^private/);
    assert.equal((await (await get("/api/config", { country: "ZA" })).json()).country, "");
  });
  test("a slow shop: the page gets 'slow' after SRCH_TIMEOUT, and the answer fills the cache in the background", async (t) => {
    assert.equal(W.SRCH_TIMEOUT, 8000);
    const store = new Map();
    const real = globalThis.caches;
    globalThis.caches = { default: { match: async (k) => (store.has(k) ? new Response(store.get(k)) : undefined), put: async (k, r) => { store.set(k, await r.text()); } } };
    t.after(() => { globalThis.caches = real; });
    const { get, waits } = setup(t, routes({ takealot: () => new Promise((ok) => setTimeout(() => ok(json({ sections: { products: { results: [tk("Samsung Galaxy A16 128GB", 3499)] } } })), W.SRCH_TIMEOUT + 400)) }));
    const t0 = Date.now();
    const d = await (await get("/api/search/shop?q=samsung+galaxy&c=ZA&shop=takealot", null, true)).json();
    assert.equal(d.status, "slow"); assert.deepEqual(d.items, []);
    assert.ok(Date.now() - t0 < W.SRCH_TIMEOUT + 300);
    await Promise.all(waits.splice(0));
    const b = await (await get("/api/search/shop?q=samsung+galaxy&c=ZA&shop=takealot")).json();
    assert.equal(b.cached, true); assert.equal(b.status, "ok"); assert.equal(b.items[0].price, 3499, "the shop's real price, from the cache");
  });
});

describe("AB-43: the page", () => {
  const res = readFileSync(new URL("../../public/result.js", import.meta.url), "utf8");
  const idx = readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");
  test("a 0-result search goes on to Ask AI once, with a note, and back to the search if the AI can't answer", () => {
    assert.match(res, /if \(empty && plan\.ai_fallback && answered && !fellBack && !opt\.noAi\)/);
    assert.match(res, /assist\(q, c, \{ fallback: true, onFail:/);
    assert.match(res, /No product name had all of your words, so AI searched for you\./);
  });
  test("an older request is stopped (AbortController) and answers are kept for Back (sessionStorage, short time)", () => {
    assert.match(res, /new AbortController\(\)/);
    assert.ok((res.match(/\{ signal \}/g) || []).length >= 4, "check, search plan, shop searches and Ask AI");
    assert.match(res, /sessionStorage\.setItem\(RC_PRE \+ k/);
    assert.match(res, /const RC_TTL = 8 \* 60e3/);
  });
  test("the button answers at once on a tap; no country switch; UK visitors from /api/config", () => {
    assert.match(idx, /function busy\(label\)/);
    assert.ok(!/id="ccrow"/.test(idx));
    assert.match(idx, /if \(cfg\.country === "GB" && !ccSet\) setCc\("GB"\)/);
    assert.match(idx, /li\.dataset\.cc === "ZA"/);
  });
});
