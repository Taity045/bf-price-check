// /api/compare and /api/compare/shop with mocked shops (no network).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { W, worker } from "../helpers/load-worker.mjs";
import { testDb } from "../helpers/db.mjs";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const CANON = "https://www.takealot.com/apple-airpods-4/PLID95957224";
let ipSeq = 0;

function setup(t, routes) {
  const { db, env } = testDb(t);
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, ua: (init.headers || {})["user-agent"] });
    for (const [re, fn] of routes) if (re.test(url)) return fn(url);
    return new Response("not mocked", { status: 599 });
  };
  t.after(() => { globalThis.fetch = real; });
  db.prepare("INSERT INTO tracked (url, orig_url, title, added_at, last_viewed, last_checked, last_status, check_count) VALUES (?, ?, ?, ?, ?, ?, 'ok', 1)").run(CANON, CANON, "Apple AirPods 4", Date.now(), Date.now(), Date.now());
  const cur = { status: "ok", checked_at: Date.now(), price: 2298, was: 2918, currency: "ZAR", title: "Apple AirPods 4", source: "takealot-api", gtin: "195949688584", brand: "Apple" };
  W.cachePut(env, W.LIVE_CACHE_PREFIX + CANON, cur, 3600e3);   // memory (no caches.default in tests): set at once
  const ip = "203.0.113." + (++ipSeq);
  const waits = [];
  const get = async (path) => {
    const r = await worker.fetch(new Request("https://site.test" + path, { headers: { "user-agent": UA, "cf-connecting-ip": ip } }), env, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits.splice(0));
    return r;
  };
  return { db, env, calls, get };
}
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const suggest = (products) => json({ resources: { results: { products } } });
const SHOPIFY_AIRPODS = [
  { title: "Apple AirPods 4 White", handle: "apple-airpods-4-white", url: "/products/apple-airpods-4-white?_pos=1", price: "1999.00", price_min: "1999.00", price_max: "1999.00", compare_at_price_min: "2999.00", available: true, vendor: "Apple" },
  { title: "Apple Airpods 4 Active Noise Cancellation White", handle: "apple-airpods-4-anc", url: "/products/apple-airpods-4-anc", price: "3899.00", price_min: "3899.00", price_max: "3899.00", available: true, vendor: "Apple" },
  { title: "Silicone Case for AirPods 4", handle: "case", url: "/products/case", price: "199.00", available: true, vendor: "Generic" },
];
const routes = () => [
  [/computermania\.co\.za\/robots\.txt$/, () => new Response(globalThis.__cmRobots || "User-agent: *\nDisallow: /cart\n", { status: 200 })],
  [/\/robots\.txt$/, () => new Response("", { status: 404 })],
  [/computermania\.co\.za\/search\/suggest\.json/, () => suggest(SHOPIFY_AIRPODS)],
  [/computermania\.co\.za\/products\/apple-airpods-4-white\.js/, () => json({ variants: [{ title: "Default Title", price: 199900, barcode: "195949688584", sku: "MXP63ZE/A", available: true }] })],
  [/computermania\.co\.za\/products\/apple-airpods-4-anc\.js/, () => json({ variants: [{ title: "Default Title", price: 389900, barcode: "195949688591", sku: "MXP93ZE/A", available: true }] })],
  [/matrixwarehouse\.co\.za/, () => new Response("<html>Just a moment... cf-chl</html>", { status: 403 })],
  [/firstshop\.co\.za\/search\/suggest\.json/, () => suggest([])],
];

describe("compare API with mocked shops", () => {
  test("needs a checked product", async (t) => {
    const { get } = setup(t, routes());
    const r = await get("/api/compare?url=" + encodeURIComponent("https://www.takealot.com/other/PLID1"));
    assert.equal(r.status, 403);
  });
  test("plan: same-currency shops, never the source shop", async (t) => {
    const { get, calls } = setup(t, routes());
    const d = await (await get("/api/compare?url=" + encodeURIComponent(CANON))).json();
    assert.equal(d.product.gtin, "195949688584");
    assert.equal(d.product.category, "electronics");
    const ids = d.shops.map((s) => s.id);
    assert.ok(ids.includes("computermania") && ids.includes("hirschs"));
    assert.ok(!ids.includes("takealot") && !ids.includes("lakeland") && !ids.includes("exclusivebooks"));
    assert.equal(calls.length, 0, "the plan itself calls no shop");
  });
  test("one shop: barcode match, cheaper, saved to history, cached", async (t) => {
    const { get, calls, db } = setup(t, routes());
    const d = await (await get(`/api/compare/shop?url=${encodeURIComponent(CANON)}&shop=computermania`)).json();
    assert.equal(d.status, "match");
    assert.equal(d.match.level, "barcode");
    assert.equal(d.match.price, 1999);
    assert.equal(d.match.was, 2999);
    assert.equal(d.match.url, "https://computermania.co.za/products/apple-airpods-4-white");
    assert.match(d.match.title, /AirPods 4 White/);
    assert.ok(calls.every((c) => /DealOrDud-PriceCompare/.test(c.ua)), "honest user agent");
    assert.ok(calls.length <= 1 + 3 + 2, "few subrequests: " + calls.length);
    const hist = db.prepare("SELECT price, currency, source FROM checks WHERE url = ?").all("https://computermania.co.za/products/apple-airpods-4-white");
    assert.deepEqual(hist.map((h) => [h.price, h.currency, h.source]), [[1999, "ZAR", "compare-computermania"]]);
    assert.ok(db.prepare("SELECT url FROM tracked WHERE url = ?").get("https://computermania.co.za/products/apple-airpods-4-white"), "kept for daily re-checks");
    const n = calls.length;
    const again = await (await get(`/api/compare/shop?url=${encodeURIComponent(CANON)}&shop=computermania`)).json();
    assert.equal(again.cached, true); assert.equal(again.match.price, 1999); assert.equal(calls.length, n, "no new shop calls");
    const plan = await (await get("/api/compare?url=" + encodeURIComponent(CANON))).json();
    assert.equal(plan.results.computermania.match.price, 1999, "the plan returns cached answers");
    const old = await (await get("/api/others?url=" + encodeURIComponent(CANON))).json();
    assert.equal(old.matches[0].shop, "Computer Mania");
    // AB-44: the answers, the identity and the shop search are cached in memory / the Cloudflare cache, not D1
    assert.deepEqual(db.prepare("SELECT k FROM cache").all().map((r) => r.k).filter((k) => !k.startsWith("robots-cmp:")), [], "only robots.txt (D1 state) in the D1 cache table");
  });
  test("the ANC model and the case are not offered as the same product", async (t) => {
    const r = setup(t, [[/\/robots\.txt$/, () => new Response("", { status: 404 })], [/computermania\.co\.za\/search\/suggest\.json/, () => suggest(SHOPIFY_AIRPODS.slice(1))], [/\.js$/, () => json({ variants: [{ title: "Default Title", price: 389900, barcode: "195949688591", available: true }] })]]);
    const d = await (await r.get(`/api/compare/shop?url=${encodeURIComponent(CANON)}&shop=computermania`)).json();
    assert.equal(d.status, "none");
    assert.equal(d.match, null);
  });
  test("an option picked on a page with several prices is shown but not saved to that page's history", async (t) => {
    const multi = { title: "Apple AirPods 4", handle: "apple-airpods-4-range", url: "/products/apple-airpods-4-range", price: "1999.00", price_min: "1999.00", price_max: "3899.00", available: true, vendor: "Apple" };
    const { get, db } = setup(t, [[/\/robots\.txt$/, () => new Response("", { status: 404 })], [/computermania\.co\.za\/search\/suggest\.json/, () => suggest([multi])],
      [/apple-airpods-4-range\.js/, () => json({ variants: [{ title: "Standard", price: 199900, barcode: "195949688584", available: true }, { title: "Active Noise Cancellation", price: 389900, barcode: "195949688591", available: true }] })]]);
    const d = await (await get(`/api/compare/shop?url=${encodeURIComponent(CANON)}&shop=computermania`)).json();
    assert.equal(d.status, "match");
    assert.equal(d.match.level, "barcode");
    assert.equal(d.match.price, 1999);
    assert.equal(db.prepare("SELECT count(*) n FROM checks WHERE url = ?").get("https://computermania.co.za/products/apple-airpods-4-range").n, 0);
  });
  test("a shop that blocks us is reported, not guessed", async (t) => {
    const { get } = setup(t, routes());
    const d = await (await get(`/api/compare/shop?url=${encodeURIComponent(CANON)}&shop=matrix`)).json();
    assert.equal(d.status, "blocked");
    assert.equal(d.match, null);
  });
  test("no results", async (t) => {
    const { get } = setup(t, routes());
    const d = await (await get(`/api/compare/shop?url=${encodeURIComponent(CANON)}&shop=firstshop`)).json();
    assert.equal(d.status, "none");
  });
  test("unknown or not-planned shop", async (t) => {
    const { get } = setup(t, routes());
    assert.equal((await get(`/api/compare/shop?url=${encodeURIComponent(CANON)}&shop=nope`)).status, 400);
    assert.equal((await (await get(`/api/compare/shop?url=${encodeURIComponent(CANON)}&shop=takealot`)).json()).status, "skipped");
  });
  test("per-shop limit protects shops", async (t) => {
    const { get, db } = setup(t, routes());
    db.prepare("INSERT INTO rl (k, n, win) VALUES (?, ?, ?)").run("cmpshop:firstshop", 999, Math.floor(Date.now() / 60000));
    const d = await (await get(`/api/compare/shop?url=${encodeURIComponent(CANON)}&shop=firstshop`)).json();
    assert.equal(d.status, "busy");
  });
  test("scraper user agents are refused", async (t) => {
    const { env } = setup(t, routes());
    const r = await worker.fetch(new Request(`https://site.test/api/compare?url=${encodeURIComponent(CANON)}`, { headers: { "user-agent": "python-requests/2.31" } }), env, { waitUntil() {} });
    assert.equal(r.status, 403);
  });
  test("a shop whose robots.txt disallows the search is not searched", async (t) => {
    globalThis.__cmRobots = "User-agent: *\nDisallow: /search\n";
    t.after(() => { delete globalThis.__cmRobots; });
    const { get, calls } = setup(t, routes());
    const r = await (await get(`/api/compare/shop?url=${encodeURIComponent(CANON)}&shop=computermania`)).json();
    assert.equal(r.status, "robots");
    assert.ok(!calls.some((c) => /computermania\.co\.za\/search/.test(c.url)), "no search request was sent");
  });
  test("our robots.txt group wins over the * group", async (t) => {
    globalThis.__cmRobots = "User-agent: *\nDisallow: /\n\nUser-agent: DealOrDud-PriceCompare\nAllow: /\n";
    t.after(() => { delete globalThis.__cmRobots; });
    const { get } = setup(t, routes());
    const r = await (await get(`/api/compare/shop?url=${encodeURIComponent(CANON)}&shop=computermania`)).json();
    assert.equal(r.status, "match");
  });
  test("robots.txt that does not answer (5xx): not searched now, short cache", async (t) => {
    const rs = routes(); rs.unshift([/computermania\.co\.za\/robots\.txt$/, () => new Response("down", { status: 503 })]);
    const { get, calls } = setup(t, rs);
    const r = await (await get(`/api/compare/shop?url=${encodeURIComponent(CANON)}&shop=computermania`)).json();
    assert.equal(r.status, "error");
    assert.ok(!calls.some((c) => /computermania\.co\.za\/search/.test(c.url)));
  });
});
