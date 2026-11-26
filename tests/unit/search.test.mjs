// Product search by name (src/search.js): link or name, the words, the shops, the filter, and the two endpoints.
// No network: shop answers are mocked.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { W, worker } from "../helpers/load-worker.mjs";
import { testDb } from "../helpers/db.mjs";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
let ipSeq = 0;
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

const LINKS = ["https://www.takealot.com/x/PLID1", "http://loot.co.za/product/abc", "takealot.com/apple-airpods-4/PLID95957224", "www.loot.co.za/product/x", "amzn.eu/d/033QGzXN",
  "Look at this https://www.takealot.com/x/PLID1 deal", "takealot.com", "www.robertdyas.co.uk", "WWW.EXAMPLE.CO.ZA/p/1"];
const NAMES = ["PS5 Slim", "AirPods 4", "Smeg kettle", "Samsung Galaxy S25 Ultra 256GB", "iPhone 16 Pro", "Buds3 Pro", "LEGO 75192", "Kettle 1.7L", "Nike Air Force 1 size 9.5", "Galaxy S24 5.0", "ps5"];

describe("search: link or product name", () => {
  test("links are links", () => { for (const v of LINKS) assert.equal(W.srchIsLink(v), true, v); });
  test("product names are not links", () => { for (const v of NAMES) assert.equal(W.srchIsLink(v), false, v); });
  test("the page uses the same rule as the server", () => {
    execFileSync("python3", ["build.py"], { cwd: new URL("../../", import.meta.url), stdio: "ignore" });
    const src = readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");
    const m = src.match(/const isLink = (\(v\) => [^\n]+);\n/);
    assert.ok(m, "isLink in index.html");
    const isLink = (0, eval)(m[1]);
    for (const v of [...LINKS, ...NAMES]) assert.equal(isLink(v), W.srchIsLink(v), v);
  });
});

describe("search: the words", () => {
  test("2 to 120 characters, letters or numbers, never a link", () => {
    assert.match(W.srchClean("").error, /product name/);
    assert.match(W.srchClean("a").error, /at least 2/);
    assert.match(W.srchClean("x".repeat(121)).error, /120 characters or fewer/);
    assert.match(W.srchClean("!!!").error, /letters or numbers/);
    assert.match(W.srchClean("https://www.takealot.com/x/PLID1").error, /link/);
    assert.equal(W.srchClean("  PS5   Slim ").q, "PS5 Slim");
    assert.equal(W.srchClean("x".repeat(120)).q.length, 120);
    assert.equal(W.srchClean("ab").q, "ab");
  });
  test("no markup or control characters in the words", () => {
    assert.equal(W.srchClean("<b>PS5</b>\u0000 Slim").q, "b PS5 /b Slim");
  });
  test("country: ZA (default), GB, UK = GB; anything else is refused", () => {
    assert.equal(W.srchCountry(null), "ZA");
    assert.equal(W.srchCountry("za"), "ZA");
    assert.equal(W.srchCountry("GB"), "GB");
    assert.equal(W.srchCountry("uk"), "GB");
    assert.equal(W.srchCountry("US"), null);
  });
  test("words: like compare (PlayStation 5 = ps5), without filler words", () => {
    assert.deepEqual(W.srchWords("PlayStation 5 Slim"), ["ps5", "slim"]);
    assert.deepEqual(W.srchWords("the best cheap Smeg kettle"), ["smeg", "kettle"]);
    assert.equal(W.srchKey("PS5  SLIM"), W.srchKey("ps5 slim"));
  });
});

describe("search: the shops", () => {
  test("South Africa: rand shops only, general shops first, off shops named as not searched", () => {
    const p = W.srchPlan("PS5 Slim", "ZA");
    assert.equal(p.currency, "ZAR");
    assert.equal(p.category, "electronics");
    assert.equal(p.shops[0].id, "takealot");
    for (const s of p.shops) { const shop = W.cmpShopById(s.id); assert.equal(shop.cur, "ZAR"); assert.ok(!shop.off, s.id); }
    assert.ok(p.shops.length <= 12);
    assert.ok(p.notSearched.some((x) => x.name === "Amazon South Africa" && x.why === "blocks"));
    assert.ok(p.notSearched.some((x) => x.why === "robots"), "shops whose robots.txt says no are named");
    assert.ok(!p.shops.some((s) => s.id === "ngf" || s.id === "exclusivebooks" || s.id === "cyclelab"), "no liquor, book or bike shops for a console");
  });
  test("UK: pound shops only", () => {
    const p = W.srchPlan("Smeg kettle", "GB");
    assert.equal(p.currency, "GBP");
    assert.ok(p.shops.length >= 1);
    for (const s of p.shops) assert.equal(W.cmpShopById(s.id).cur, "GBP");
    assert.ok(p.shops.some((s) => s.id === "fenwick"));
    assert.ok(p.notSearched.some((x) => x.name === "Amazon UK"));
  });
  test("a brand's own shop only when the search names the brand", () => {
    assert.ok(!W.srchPlan("running shoes", "ZA").shops.some((s) => s.id === "puma"));
    assert.ok(W.srchPlan("puma suede", "ZA").shops.some((s) => s.id === "puma"));
  });
  test("groceries go to the grocery shops; an unknown kind goes to general and broad shops", () => {
    assert.ok(W.srchPlan("Nescafe Gold 200g", "ZA").shops.some((s) => s.id === "pnp"));
    const p = W.srchPlan("zorbix 3000", "ZA");
    assert.equal(p.category, null);
    assert.ok(p.shops.some((s) => s.id === "takealot"));
    assert.ok(!p.shops.some((s) => s.id === "pnp"));
  });
  test("slow shops (10 s between requests) come last", () => {
    const p = W.srchPlan("Nescafe Gold 200g", "ZA").shops.map((s) => !!W.cmpShopById(s.id).slow);
    assert.deepEqual(p, [...p].sort((a, b) => a - b));
  });
});

describe("search: which products match", () => {
  const has = (q, t) => W.srchHas(W.srchWords(q), t);
  test("every word must be in the name", () => {
    assert.ok(has("PS5 Slim", "PlayStation 5 Slim Console with disc drive"));
    assert.ok(!has("PS5 Slim", "PlayStation 5 Console"));
    assert.ok(has("AirPods 4", "Apple AirPods 4 with ANC"));
    assert.ok(!has("AirPods 4", "Apple AirPods Pro 2"));
  });
  test("ps5 is not ps500; joined words and plurals match", () => {
    assert.ok(!has("PS5", "Elac Varro PS500 15\" Subwoofer"));
    assert.ok(has("Buds3 Pro", "Samsung Galaxy Buds 3 Pro"));
    assert.ok(has("smeg kettles", "Smeg KLF03 Kettle"));
    assert.ok(has("smeg kettle", "Smeg Kettles Set"));
  });
  const shop = W.cmpShopById("takealot");
  const c = (o) => ({ title: "PlayStation 5 Slim Console", price: 9999, url: "https://www.takealot.com/ps5/PLID1", in_stock: true, ...o });
  test("filter: in stock, an exact price, the shop's own link; lowest price first; prices kept as the shop gave them", () => {
    const out = W.srchFilter("PS5 Slim", shop, [
      c({ price: 12999, url: "https://www.takealot.com/a/PLID1" }),
      c({ price: 10499.5, url: "https://www.takealot.com/b/PLID2" }),
      c({ price: 9000, url: "https://www.takealot.com/c/PLID3", in_stock: false }),
      c({ price: null, url: "https://www.takealot.com/d/PLID4" }),
      c({ price: 8000, url: "https://evil.example.com/e" }),
      c({ price: 7000, url: "javascript:alert(1)" }),
      c({ title: "PS5 Slim Vertical Stand for PS5", price: 299, url: "https://www.takealot.com/f/PLID6" }),
      c({ title: "PS5 Slim Console (Refurbished)", price: 6999, url: "https://www.takealot.com/g/PLID7" }),
      c({ title: "EA Sports FC 25 (PS5)", price: 899, url: "https://www.takealot.com/h/PLID8" }),
    ]);
    assert.deepEqual(out.map((x) => x.price), [10499.5, 12999]);
    assert.deepEqual(out.map((x) => x.url), ["https://www.takealot.com/b/PLID2", "https://www.takealot.com/a/PLID1"]);
    assert.ok(out.every((x) => x.currency === "ZAR"));
  });
  test("accessories or used stock only when the search asks for them", () => {
    const acc = W.srchFilter("PS5 Slim stand", shop, [c({ title: "PS5 Slim Vertical Stand for PS5", price: 299 })]);
    assert.equal(acc.length, 1);
    const used = W.srchFilter("PS5 Slim refurbished", shop, [c({ title: "PS5 Slim Console (Refurbished)", price: 6999 })]);
    assert.equal(used.length, 1);
  });
  test("brand kept apart from the name is shown and matched; same name and price once; at most 8 per shop", () => {
    const fen = W.cmpShopById("fenwick");
    const k = (h, p = 159) => ({ title: "KLF03 Cordless Electric Kettle 1.7L", brand: "SMEG", price: p, url: "https://fenwick.co.uk/products/" + h, in_stock: true });
    const out = W.srchFilter("Smeg kettle", fen, [k("a"), k("b"), k("c", 169)]);
    assert.deepEqual(out.map((x) => [x.title, x.price]), [["SMEG KLF03 Cordless Electric Kettle 1.7L", 159], ["SMEG KLF03 Cordless Electric Kettle 1.7L", 169]]);
    const many = W.srchFilter("PS5 Slim", shop, Array.from({ length: 12 }, (_, i) => c({ price: 9000 + i, url: "https://www.takealot.com/x/PLID" + i })));
    assert.equal(many.length, 8);
    assert.equal(many[0].price, 9000);
  });
  test("a was price only when it is higher; a price range shows as 'from'", () => {
    const out = W.srchFilter("PS5 Slim", shop, [c({ was: 9000 }), c({ was: 12000, url: "https://www.takealot.com/z/PLID9", price: 10000, range: true })]);
    assert.equal(out[0].was, null);
    assert.equal(out[1].was, 12000);
    assert.equal(out[1].from, true);
  });
});

function setup(t, routes, extraEnv = {}) {
  const { env } = testDb(t);
  Object.assign(env, extraEnv);
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, ua: (init.headers || {})["user-agent"] });
    for (const [re, fn] of routes) if (re.test(url)) return fn(url);
    return new Response("not mocked", { status: 599 });
  };
  t.after(() => { globalThis.fetch = real; });
  const ip = "198.51.100." + (++ipSeq);
  const waits = [];
  const get = async (path, headers = {}) => {
    const r = await worker.fetch(new Request("https://site.test" + path, { headers: { "user-agent": UA, "cf-connecting-ip": ip, ...headers } }), env, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits.splice(0));
    return r;
  };
  return { env, calls, get };
}
const TAKEALOT = { sections: { products: { results: [
  { product_views: { core: { id: 95228805, title: "PlayStation 5 Slim Console with disc drive (PS5 Slim)", brand: "Sony", slug: "playstation-5-slim-console" }, buybox_summary: { prices: [15999], listing_price: 17999 }, stock_availability_summary: { is_in_stock: true } } },
  { product_views: { core: { id: 2, title: "PlayStation 5 Slim Console + DualSense Controller", brand: "Sony", slug: "ps5-bundle" }, buybox_summary: { prices: [17990] }, stock_availability_summary: { is_in_stock: true } } },
  { product_views: { core: { id: 3, title: "PS5 Slim Console Cover Skin for PS5", slug: "skin" }, buybox_summary: { prices: [199] }, stock_availability_summary: { is_in_stock: true } } },
  { product_views: { core: { id: 4, title: "PlayStation 5 Slim Digital", slug: "digital" }, buybox_summary: { prices: [12999] }, stock_availability_summary: { is_in_stock: false } } },
] } } };
const routes = (o = {}) => [
  [/api\.takealot\.com\/robots\.txt$/, () => new Response(o.robots || "User-agent: *\nDisallow: /cart\n", { status: 200 })],
  [/\/robots\.txt$/, () => new Response("", { status: 404 })],
  [/api\.takealot\.com\/rest\/v-1-11-0\/searches\/products/, () => (o.takealot ? o.takealot() : json(TAKEALOT))],
];

describe("search API", () => {
  test("/api/search: the plan; bad words or country answer 400 in plain words", async (t) => {
    const { get, calls } = setup(t, routes());
    let r = await get("/api/search?q=" + encodeURIComponent("PS5 Slim") + "&c=ZA");
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.q, "PS5 Slim"); assert.equal(d.country, "ZA"); assert.equal(d.currency, "ZAR");
    assert.equal(d.shops[0].id, "takealot");
    assert.equal(calls.length, 0, "the plan calls no shop");
    r = await get("/api/search?q=a&c=ZA"); assert.equal(r.status, 400); assert.match((await r.json()).error, /at least 2/);
    r = await get("/api/search?q=PS5&c=US"); assert.equal(r.status, 400); assert.match((await r.json()).error, /South Africa or the UK/);
    r = await get("/api/search?q=" + encodeURIComponent("https://www.takealot.com/x/PLID1")); assert.equal(r.status, 400);
  });
  test("/api/search: 30 searches a minute per visitor, then 429", async (t) => {
    const { get } = setup(t, routes());
    for (let i = 0; i < 30; i++) assert.equal((await get("/api/search?q=PS5+Slim&c=ZA")).status, 200, `search ${i + 1}`);
    const r = await get("/api/search?q=PS5+Slim&c=ZA");
    assert.equal(r.status, 429);
    assert.match((await r.json()).error, /Wait a minute/);
  });
  test("/api/search/shop: real shop prices, matching in-stock products only, lowest first", async (t) => {
    const { get, calls } = setup(t, routes());
    const r = await get("/api/search/shop?q=PS5+Slim&c=ZA&shop=takealot");
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.status, "ok"); assert.equal(d.name, "Takealot");
    assert.deepEqual(d.items.map((x) => [x.price, x.currency]), [[15999, "ZAR"], [17990, "ZAR"]]);
    assert.equal(d.items[0].url, "https://www.takealot.com/playstation-5-slim-console/PLID95228805");
    assert.equal(d.items[0].was, 17999);
    const search = calls.filter((c) => /searches\/products/.test(c.url));
    assert.equal(search.length, 1);
    assert.match(search[0].url, /qsearch=PS5%20Slim/);
    assert.match(search[0].ua, /DealOrDud-PriceCompare/, "our own honest user agent");
    assert.ok(calls.some((c) => /api\.takealot\.com\/robots\.txt/.test(c.url)), "robots.txt read first");
  });
  test("/api/search/shop: a shop not in the plan, or not a shop, is refused", async (t) => {
    const { get, calls } = setup(t, routes());
    assert.equal((await get("/api/search/shop?q=PS5+Slim&c=ZA&shop=fenwick")).status, 400, "a UK shop for ZA");
    assert.equal((await get("/api/search/shop?q=PS5+Slim&c=ZA&shop=lakeland")).status, 400);
    assert.equal((await get("/api/search/shop?q=PS5+Slim&c=ZA&shop=nope")).status, 400);
    assert.equal((await get("/api/search/shop?q=x&c=ZA&shop=takealot")).status, 400);
    assert.equal(calls.length, 0);
  });
  test("/api/search/shop: robots.txt says no = not searched", async (t) => {
    const { get, calls } = setup(t, routes({ robots: "User-agent: *\nDisallow: /rest/v-1-11-0/searches/\n" }));
    const d = await (await get("/api/search/shop?q=PS5+Slim&c=ZA&shop=takealot")).json();
    assert.equal(d.status, "robots");
    assert.deepEqual(d.items, []);
    assert.equal(calls.filter((c) => /searches\/products/.test(c.url)).length, 0);
  });
  test("/api/search/shop: a bot check is 'blocked', a failure is 'error', no match is 'none' (never invented items)", async (t) => {
    let { get } = setup(t, routes({ takealot: () => new Response("no", { status: 403 }) }));
    let d = await (await get("/api/search/shop?q=PS5+Slim&c=ZA&shop=takealot")).json();
    assert.equal(d.status, "blocked"); assert.deepEqual(d.items, []);
    ({ get } = setup(t, routes({ takealot: () => new Response("x", { status: 500 }) })));
    d = await (await get("/api/search/shop?q=PS5+Slim&c=ZA&shop=takealot")).json();
    assert.equal(d.status, "error"); assert.deepEqual(d.items, []);
    ({ get } = setup(t, routes({ takealot: () => json({ sections: { products: { results: [] } } }) })));
    d = await (await get("/api/search/shop?q=PS5+Slim&c=ZA&shop=takealot")).json();
    assert.equal(d.status, "none"); assert.deepEqual(d.items, []);
  });
  test("/api/search/shop: the answer is kept 20 minutes in the Cloudflare cache (no D1 rows)", async (t) => {
    const store = new Map(); const puts = [];
    const real = globalThis.caches;
    globalThis.caches = { default: { match: async (k) => (store.has(k) ? new Response(store.get(k)) : undefined), put: async (k, r) => { puts.push([k, r.headers.get("cache-control")]); store.set(k, await r.text()); } } };
    t.after(() => { globalThis.caches = real; });
    const { get, calls, env } = setup(t, routes());
    const before = (await env.DB.prepare("SELECT COUNT(*) AS n FROM cache").first()).n;
    const a = await (await get("/api/search/shop?q=PS5+Slim&c=ZA&shop=takealot")).json();
    const b = await (await get("/api/search/shop?q=ps5  slim&c=ZA&shop=takealot")).json();
    assert.equal(b.cached, true);
    assert.deepEqual(b.items, a.items);
    assert.equal(calls.filter((c) => /searches\/products/.test(c.url)).length, 1, "the second search used the cache");
    assert.equal(puts.length, 1); assert.equal(puts[0][1], "public, max-age=" + W.SRCH_TTL);
    assert.equal(W.SRCH_TTL, 1200);
    const after = (await env.DB.prepare("SELECT COUNT(*) AS n FROM cache WHERE k NOT LIKE 'robots-cmp:%'").first()).n;
    assert.equal(after, before, "no search rows in D1");
  });
});

describe("search: the built page", () => {
  const worker = readFileSync(new URL("../../dist/worker.js", import.meta.url), "utf8");
  const html = JSON.parse(worker.match(/\nconst HTML = (".*");\n/)[1]);
  test("one box for a link or a name, no SA / UK switch on the home page (AB-43), and the search results area", () => {
    assert.match(html, /<input id="u" name="u" type="text" placeholder="Search, paste a link or ask AI" aria-label="Product link or product name"/);
    // AB-43: South Africa first: no country switch on the home page; a UK visitor gets a link in the results only
    assert.ok(!/id="ccrow"/.test(html) && !/class="ccb"/.test(html) && !/>Shops in</.test(html));
    assert.match(html, /<button type="button" class="linkbtn occ hidden" id="sOther"><\/button>/);
    assert.match(html, /<button type="button" class="linkbtn occ hidden" id="asOther"><\/button>/);
    assert.match(html, /<section id="search" class="hidden" aria-label="Search results">/);
  });
  test("the home page with ?q= opens in the short layout", async (t) => {
    const { get } = setup(t, routes());
    const r = await get("/?q=PS5+Slim&c=ZA");
    assert.equal(r.status, 200);
    assert.match(await r.text(), /<html lang="en" class="q">/);
  });
});

describe("search: brand words", () => {
  test("no brand before a name that already has a brand word", () => {
    const shop = W.cmpShopById("takealot");
    const out = W.srchFilter("PS5 Slim", shop, [{ title: "PlayStation 5 Slim Console", brand: "Sony PlayStation", price: 15999, url: "https://www.takealot.com/x/PLID1", in_stock: true }]);
    assert.equal(out[0].title, "PlayStation 5 Slim Console");
  });
});
