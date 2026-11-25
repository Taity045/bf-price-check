// Daily price saving (src/daily.js): scheduling, batching, back-off, robots.txt, seed list,
// and whole runs against an in-memory D1 with a fake network.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { W } from "../helpers/load-worker.mjs";
import { testDb } from "../helpers/db.mjs";

const H = 3600e3, DAY = 864e5, T = Date.UTC(2026, 10, 25, 10, 0);
const DOH = new Set(["1.1.1.1", "dns.google", "cloudflare-dns.com"]);
const publicDns = (url) => Response.json({ Status: 0, Answer: url.searchParams.get("type") === "A" ? [{ type: 1, data: "1.1.1.1" }] : [] });
const tkProduct = (price, title = "Product") => Response.json({ buybox: { items: [{ is_selected: true, price, listing_price: price + 100 }] }, core: { title } });
const htmlPage = (price) => new Response(`<html><head><script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "Thing", offers: { "@type": "Offer", price, priceCurrency: "ZAR" } })}</script></head><body>ok</body></html>`, { headers: { "content-type": "text/html" } });
const minute0 = () => Date.now() - (Date.now() % H);   // not a seed-list slot

// A test D1 that counts queries the way the Free plan limit does (a batch is one query).
function countingEnv(env) {
  const n = { queries: 0 };
  const wrap = (s) => ({ bind: (...a) => wrap(s.bind(...a)), first: () => (n.queries++, s.first()), run: () => (n.queries++, s.run()), all: () => (n.queries++, s.all()), exec: () => s.exec() });
  return { n, env: { ...env, DB: { prepare: (sql) => wrap(env.DB.prepare(sql)), batch: (l) => (n.queries++, env.DB.batch(l)) } } };
}
function net(t, handler) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (raw, init = {}) => {
    const url = new URL(raw);
    if (DOH.has(url.hostname)) return publicDns(url);
    calls.push({ url, ua: (init.headers || {})["user-agent"] });
    return handler(url, init);
  });
  return calls;
}
function addTracked(db, url, extra = {}) {
  const r = { orig_url: url, last_viewed: Date.now(), seed: 0, lane: W.laneFor(url), host: W.hostKey(url), fails: 0, next_check_at: 0, last_checked: null, title: null, ...extra };
  db.prepare("INSERT INTO tracked (url, orig_url, title, added_at, last_viewed, last_checked, check_count, seed, lane, host, fails, next_check_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)")
    .run(url, r.orig_url, r.title, Date.now(), r.last_viewed, r.last_checked, r.seed, r.lane, r.host, r.fails, r.next_check_at);
}
const tk = (n) => `https://www.takealot.com/product-${n}/PLID${1000 + n}`;
const row = (db, url) => db.prepare("SELECT * FROM tracked WHERE url = ?").get(url);

describe("nextCheckAt", () => {
  test("a good check: again in 23 h, so each product gets one check per calendar day", () => {
    assert.equal(W.nextCheckAt({ t: T, ok: true, lastViewed: T }), T + 23 * H);
  });
  test("not viewed for 60+ days: weekly; an active price alert keeps it daily", () => {
    assert.equal(W.nextCheckAt({ t: T, ok: true, lastViewed: T - 61 * DAY }), T + 7 * DAY);
    assert.equal(W.nextCheckAt({ t: T, ok: true, lastViewed: T - 61 * DAY, alert: true }), T + 23 * H);
    assert.equal(W.nextCheckAt({ t: T, ok: true, lastViewed: T - 59 * DAY }), T + 23 * H);
  });
  test("failures back off 6 h, 1 day, 2, 4, then 7 days, and pause after MAX_FAILS", () => {
    const waits = [1, 2, 3, 4, 5, 6, 7].map((fails) => W.nextCheckAt({ t: T, ok: false, fails, lastViewed: T }) - T);
    assert.deepEqual(waits, [6 * H, 23 * H, 2 * DAY, 4 * DAY, 7 * DAY, 7 * DAY, 7 * DAY]);
    assert.equal(W.nextCheckAt({ t: T, ok: false, fails: W.MAX_FAILS, lastViewed: T }), null);
  });
  test("a page that is gone (404/410) or not allowed by robots.txt is paused at once", () => {
    assert.equal(W.nextCheckAt({ t: T, ok: false, fails: 1, gone: true, lastViewed: T }), null);
  });
  test("failing and stale: at least weekly", () => {
    assert.equal(W.nextCheckAt({ t: T, ok: false, fails: 1, lastViewed: T - 90 * DAY }), T + 7 * DAY);
  });
});

describe("pickBatch", () => {
  const r = (url, lane, host = "a.co.za") => ({ url, lane, host });
  test("keeps the order (people's products first) and the caps per lane", () => {
    const rows = [r("t1", "takealot"), r("t2", "takealot"), r("t3", "takealot"), r("t4", "takealot"), r("t5", "takealot"), r("p1", "page", "x"), r("p2", "page", "y")];
    assert.deepEqual(W.pickBatch(rows, { takealot: 4, page: 1 }).map((x) => x.url), ["t1", "t2", "t3", "t4", "p1"]);
  });
  test("one page per shop, no duplicates, lane 0 means none", () => {
    const rows = [r("p1", "page", "x"), r("p2", "page", "x"), r("p3", "page", "y"), r("p3", "page", "y")];
    assert.deepEqual(W.pickBatch(rows, { takealot: 4, page: 3 }).map((x) => x.url), ["p1", "p3"]);
    assert.deepEqual(W.pickBatch(rows, { takealot: 2, page: 0 }), []);
  });
});

describe("savedDays", () => {
  test("counts different UTC days with a price in the last 365 days", () => {
    const checks = [{ ts: T, price: 1 }, { ts: T + H, price: 2 }, { ts: T - DAY, price: 3 }, { ts: T - 2 * DAY, price: null }, { ts: T - 400 * DAY, price: 4 }];
    assert.equal(W.savedDays(checks, T), 2);
  });
});

describe("robots.txt", () => {
  const takealotApi = "User-agent: AdsBot-Google\nAllow: /rest/v-*-*-*/sponsored-products/\n\nUser-agent: *\nDisallow: /rest/v-*-*-*/sponsored-products/\nDisallow: /rest/v-*-*-*/collect*\n\nAllow: /\n";
  test("Takealot's API robots.txt allows product details and search, not the disallowed paths", () => {
    const rules = W.parseRobots(takealotApi);
    assert.ok(W.robotsAllows(rules, "/rest/v-1-14-0/product-details/PLID123?platform=desktop&display_credit=false"));
    assert.ok(W.robotsAllows(rules, "/rest/v-1-14-0/searches/products,breadcrumbs?sort=BestSelling&department_slug=computers"));
    assert.ok(!W.robotsAllows(rules, "/rest/v-1-14-0/sponsored-products/x"));
    assert.ok(!W.robotsAllows(rules, "/rest/v-1-14-0/collect?x=1"));
  });
  test("a group for our bot wins over *; longest rule wins; Allow wins a tie; $ ends a pattern", () => {
    const txt = "User-agent: *\nDisallow: /\n\nUser-agent: Other\nUser-agent: DealOrDudBot\nDisallow: /private\nAllow: /private/ok\nDisallow: /*.pdf$\nAllow: /tie\nDisallow: /tie\n";
    const rules = W.parseRobots(txt);
    assert.ok(W.robotsAllows(rules, "/product/1"));
    assert.ok(!W.robotsAllows(rules, "/private/x"));
    assert.ok(W.robotsAllows(rules, "/private/ok/1"));
    assert.ok(!W.robotsAllows(rules, "/file.pdf"));
    assert.ok(W.robotsAllows(rules, "/file.pdf?x=1"));
    assert.ok(W.robotsAllows(rules, "/tie"));
  });
  test("we do not match a group just because its name is part of ours", () => {
    assert.ok(W.robotsAllows(W.parseRobots("User-agent: bot\nDisallow: /\n"), "/p"));
  });
  test("an empty Disallow allows everything; * group used when there is no group for us", () => {
    assert.ok(W.robotsAllows(W.parseRobots("User-agent: *\nDisallow:\n"), "/p"));
    assert.ok(!W.robotsAllows(W.parseRobots("User-agent: *\nDisallow: /p\n"), "/p/1"));
  });
});

const searchResult = (dept, items) => ({ sections: {
  breadcrumbs: { results: dept ? [{ breadcrumb: { department_slug: dept } }] : [] },
  products: { results: items.map(([id, slug, prices, extra = {}]) => ({ product_views: { core: { id, slug, title: "T" + id }, buybox_summary: { prices, is_preorder: false, ...extra } } })) },
} });

describe("takealotSeeds", () => {
  test("one-price products only, as canonical Takealot links", () => {
    const d = searchResult("computers", [[1, "mouse", [99]], [2, "vitamins", [99, 189]], [3, "pre", [10], { is_preorder: true }], [4, "Bad Slug!", [5]], [5, "laptop", [9999]]]);
    assert.deepEqual(W.takealotSeeds(d, "computers").seeds, [
      { url: "https://www.takealot.com/mouse/PLID1", title: "T1" },
      { url: "https://www.takealot.com/laptop/PLID5", title: "T5" },
    ]);
    assert.equal(W.canonicalize(new URL("https://www.takealot.com/mouse/PLID1")).canon, "https://www.takealot.com/mouse/PLID1");
  });
  test("an unknown department (the API then answers with the whole site) gives no seeds", () => {
    assert.ok(W.takealotSeeds(searchResult(null, [[1, "x", [1]]]), "computers").error);
    assert.ok(W.takealotSeeds(searchResult("gaming", [[1, "x", [1]]]), "computers").error);
  });
  test("at most max per department", () => {
    const d = searchResult("toys", Array.from({ length: 40 }, (_, i) => [i + 1, "p" + i, [10]]));
    assert.equal(W.takealotSeeds(d, "toys", 25).seeds.length, 25);
  });
});

describe("shop ranking rule", () => {
  test("a score needs 5 judged products and 3 products with prices on 7+ days", () => {
    assert.equal(W.shopScore(10, 2, 3), 20);
    assert.equal(W.shopScore(10, 2, 2), null);
    assert.equal(W.shopScore(4, 2, 9), null);
  });
});

describe("runDaily (whole runs)", () => {
  test("people's products before seeds, at most 4 Takealot + 1 page a run, prices saved as 'daily'", async (t) => {
    const { db, env } = testDb(t);
    for (let i = 0; i < 6; i++) addTracked(db, tk(i), { seed: 1, next_check_at: 1 + i });
    addTracked(db, tk(10), { seed: 0, next_check_at: 50 });
    addTracked(db, tk(11), { seed: 0, next_check_at: 60 });
    addTracked(db, "https://www.evetech.co.za/a", { next_check_at: 1 });
    addTracked(db, "https://www.evetech.co.za/b", { next_check_at: 2 });
    addTracked(db, "https://www.notdue.co.za/c", { next_check_at: Date.now() + DAY });
    const calls = net(t, (url) => url.pathname === "/robots.txt" ? new Response("User-agent: *\nAllow: /\n") : url.hostname === "api.takealot.com" ? tkProduct(100) : htmlPage(250));
    const { n, env: cenv } = countingEnv(env);
    const sum = await W.runDaily(cenv, minute0());
    assert.equal(sum.picked, 5); assert.equal(sum.saved, 5); assert.equal(sum.failed, 0);
    const daily = db.prepare("SELECT url FROM checks WHERE via = 'daily' ORDER BY url").all().map((r) => r.url);
    assert.deepEqual(daily, [tk(0), tk(1), tk(10), tk(11), "https://www.evetech.co.za/a"].sort());
    const r = row(db, tk(10));
    assert.equal(r.last_status, "ok"); assert.equal(r.fails, 0); assert.equal(r.days, 1);
    assert.ok(Math.abs(r.next_check_at - (Date.now() + 23 * H)) < 5000);
    assert.equal(row(db, "https://www.evetech.co.za/b").last_checked, null, "second page of the same shop waits for a later run");
    // Free plan budget: 50 subrequests and 50 D1 queries per run.
    const products = calls.filter((c) => c.url.pathname !== "/robots.txt");
    assert.ok(calls.length <= 10, `fetches: ${calls.length}`);
    assert.ok(n.queries <= 15, `D1 queries: ${n.queries}`);
    assert.ok(products.every((c) => c.ua === W.BOT_UA), "the daily check says who it is");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cache WHERE k LIKE 'robots:%'").get().n, 2, "robots.txt cached per site");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cache WHERE k LIKE ?").get(W.LIVE_CACHE_PREFIX + "%").n, 0, "the daily check does not fill the check cache (saves D1 rows written)");
  });

  test("DNS lookup with no answer: product not read, no failure counted, again in an hour", async (t) => {
    const { db, env } = testDb(t);
    addTracked(db, "https://www.evetech.co.za/a", { next_check_at: 1, fails: 1 });
    const calls = [];
    t.mock.method(globalThis, "fetch", async (raw) => { const url = new URL(raw); if (DOH.has(url.hostname)) throw new TypeError("resolver down"); calls.push(url); return htmlPage(250); });
    await W.runDaily(env, minute0());
    const r = row(db, "https://www.evetech.co.za/a");
    assert.equal(calls.length, 0, "the shop page is not fetched");
    assert.equal(r.fails, 1, "fails unchanged");
    assert.ok(Math.abs(r.next_check_at - (Date.now() + H)) < 5000);
  });

  test("the next run takes the rest; nothing is checked twice in a day", async (t) => {
    const { db, env } = testDb(t);
    for (let i = 0; i < 6; i++) addTracked(db, tk(i), { seed: 1, next_check_at: 1 + i });
    net(t, (url) => url.pathname === "/robots.txt" ? new Response("", { status: 404 }) : tkProduct(100));
    await W.runDaily(env, minute0());
    await W.runDaily(env, minute0());
    const s3 = await W.runDaily(env, minute0());
    assert.equal(s3.picked, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM checks WHERE via = 'daily'").get().n, 6);
  });

  test("two runs at the same time do not check the same product (claim)", async (t) => {
    const { db, env } = testDb(t);
    for (let i = 0; i < 4; i++) addTracked(db, tk(i), { next_check_at: 1 });
    net(t, (url) => url.pathname === "/robots.txt" ? new Response("") : tkProduct(100));
    await Promise.all([W.runDaily(env, minute0()), W.runDaily(env, minute0())]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM checks WHERE via = 'daily'").get().n, 4);
  });

  test("a verdict is saved once there are 3 older daily prices", async (t) => {
    const { db, env } = testDb(t);
    const url = tk(1);
    addTracked(db, url);
    for (const d of [4, 3, 2]) db.prepare("INSERT INTO checks (url, ts, price, currency, source, via) VALUES (?, ?, 120, 'ZAR', 'takealot-api', 'daily')").run(url, Date.now() - d * DAY);
    net(t, (u) => u.pathname === "/robots.txt" ? new Response("") : tkProduct(100));
    await W.runDaily(env, minute0());
    const v = db.prepare("SELECT verdict, n FROM verdicts WHERE url = ?").get(url);
    assert.equal(v.n, 3);
    assert.equal(v.verdict, "Real deal");
    assert.equal(row(db, url).days, 4);
  });

  test("a shop that blocks us backs off and is paused after MAX_FAILS; a person's check restarts it", async (t) => {
    const { db, env } = testDb(t);
    const url = "https://www.blocky.co.za/p/1";
    addTracked(db, url);
    let status = 403;
    net(t, (u) => u.pathname === "/robots.txt" ? new Response("") : new Response("Access denied", { status }));
    await W.runDaily(env, minute0());
    let r = row(db, url);
    assert.equal(r.fails, 1); assert.equal(r.last_status, "blocked");
    assert.ok(Math.abs(r.next_check_at - (Date.now() + 6 * H)) < 5000);
    for (let i = 2; i <= W.MAX_FAILS; i++) { db.prepare("UPDATE tracked SET next_check_at = 0 WHERE url = ?").run(url); await W.runDaily(env, minute0()); }
    r = row(db, url);
    assert.equal(r.fails, W.MAX_FAILS); assert.equal(r.next_check_at, null, "paused");
    assert.equal((await W.runDaily(env, minute0())).picked, 0);
    status = 200;
    // A person checks it (browser headers): it is back in the daily list.
    t.mock.method(globalThis, "fetch", async (raw) => { const u = new URL(raw); return DOH.has(u.hostname) ? publicDns(u) : htmlPage(99); });
    await W.track(env, url, url, { status: "ok", checked_at: Date.now(), price: 99, currency: "ZAR" });
    r = row(db, url);
    assert.equal(r.fails, 0); assert.ok(r.next_check_at > Date.now());
  });

  test("robots.txt says no: no product request, paused; a 404 page is paused too", async (t) => {
    const { db, env } = testDb(t);
    addTracked(db, "https://www.strict.co.za/p/1");
    addTracked(db, "https://www.gone.co.za/p/2");
    const calls = net(t, (u) => u.pathname === "/robots.txt" ? new Response(u.hostname.includes("strict") ? "User-agent: *\nDisallow: /p/\n" : "") : new Response("nope", { status: 404 }));
    await W.runDaily(env, minute0(), { caps: { takealot: 4, page: 2 } });
    assert.equal(row(db, "https://www.strict.co.za/p/1").last_status, "robots");
    assert.equal(row(db, "https://www.strict.co.za/p/1").next_check_at, null);
    assert.equal(row(db, "https://www.gone.co.za/p/2").next_check_at, null);
    assert.ok(!calls.some((c) => c.url.hostname === "www.strict.co.za" && c.url.pathname !== "/robots.txt"));
  });

  test("robots.txt server error: try again in an hour, not counted as a failure", async (t) => {
    const { db, env } = testDb(t);
    addTracked(db, "https://www.flaky.co.za/p/1", { fails: 2 });
    net(t, (u) => u.pathname === "/robots.txt" ? new Response("", { status: 503 }) : htmlPage(1));
    const s = await W.runDaily(env, minute0());
    const r = row(db, "https://www.flaky.co.za/p/1");
    assert.equal(s.skipped, 1); assert.equal(r.fails, 2);
    assert.ok(Math.abs(r.next_check_at - (Date.now() + H)) < 5000);
  });

  test("shops on the blocked list are not requested at all", async (t) => {
    const { db, env } = testDb(t);
    const blocked = W.SHOP_LIST.blocked[0];
    const url = `https://${blocked.d[0].includes("/") ? blocked.d[0] : "www." + blocked.d[0] + "/p/1"}`;
    addTracked(db, url);
    const calls = net(t, () => htmlPage(1));
    await W.runDaily(env, minute0());
    assert.equal(calls.length, 0);
    assert.equal(row(db, url).next_check_at, null);
  });

  test("legacy rows (from before daily saving) get a lane and are checked", async (t) => {
    const { db, env } = testDb(t);
    db.prepare("INSERT INTO tracked (url, orig_url, last_viewed, last_checked, last_status) VALUES (?, ?, ?, 0, 'ok')").run(tk(7), tk(7), Date.now());
    net(t, (u) => u.pathname === "/robots.txt" ? new Response("") : tkProduct(5));
    const s = await W.runDaily(env, minute0());
    assert.equal(s.saved, 1);
    assert.equal(row(db, tk(7)).lane, "takealot");
  });

  test("seed list: one department per slot, up to MAX_SEEDS, people's products stay people's", async (t) => {
    const { db, env } = testDb(t);
    addTracked(db, "https://www.takealot.com/p0/PLID1", { seed: 0, next_check_at: Date.now() + DAY });
    const items = Array.from({ length: 30 }, (_, i) => [i + 1, "p" + i, [100]]);
    const calls = net(t, (u) => u.pathname === "/robots.txt" ? new Response("User-agent: *\nAllow: /\n") : u.pathname.includes("/searches/") ? Response.json(searchResult(u.searchParams.get("department_slug"), items)) : tkProduct(100));
    const slot = minute0() + 5 * 60e3;
    const s = await W.runDaily(env, slot);
    assert.equal(s.seed_dept, "computers");
    assert.equal(s.seeds_added, 24, "25 per department, one was already tracked");
    assert.equal(row(db, "https://www.takealot.com/p0/PLID1").seed, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tracked WHERE seed = 1").get().n, 24);
    const search = calls.find((c) => c.url.pathname.includes("/searches/"));
    assert.equal(search.ua, W.BOT_UA);
    // The next slot takes the next department; a refreshed department waits a week.
    const s2 = await W.runDaily(env, slot);
    assert.equal(s2.seed_dept, "cellular-gps");
    // The cap holds.
    db.prepare("UPDATE tracked SET seed = 1").run();
    for (let i = 0; i < W.MAX_SEEDS; i++) addTracked(db, tk(5000 + i), { seed: 1, next_check_at: Date.now() + DAY });
    const before = db.prepare("SELECT COUNT(*) AS n FROM tracked WHERE seed = 1").get().n;
    const s3 = await W.runDaily(env, slot);
    assert.equal(s3.seeds_added, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tracked WHERE seed = 1").get().n, before);
  });

  test("a seed slot with nothing to refresh keeps the normal batch size", async (t) => {
    const { db, env } = testDb(t);
    for (const d of ["computers", "cellular-gps", "tv-audio-video", "gaming", "cameras", "home-kitchen", "diy-tools-machinery", "sport", "beauty", "toys", "baby", "pool-garden"]) db.prepare("INSERT INTO cache (k, v, exp) VALUES (?, '{}', ?)").run("seed-dept:" + d, Date.now() + DAY);
    for (let i = 0; i < 5; i++) addTracked(db, tk(i));
    net(t, (u) => u.pathname === "/robots.txt" ? new Response("") : tkProduct(1));
    const s = await W.runDaily(env, minute0() + 5 * 60e3);
    assert.equal(s.seed_dept, undefined);
    assert.equal(s.picked, 4);
  });

  test("housekeeping drops seeds off the lists for 60 days; status shows counts only", async (t) => {
    const { db, env } = testDb(t);
    addTracked(db, tk(1), { seed: 1, last_viewed: Date.now() - 61 * DAY });
    addTracked(db, tk(2), { seed: 1 });
    addTracked(db, "https://www.evetech.co.za/x", { seed: 0, last_viewed: Date.now() - 61 * DAY });
    await W.ensureDailySchema(env);
    await W.dailyHousekeeping(env);
    assert.deepEqual(db.prepare("SELECT url FROM tracked ORDER BY url").all().map((r) => r.url), ["https://www.evetech.co.za/x", tk(2)]);
    db.prepare("INSERT INTO checks (url, ts, price, via) VALUES (?, ?, 1, 'daily')").run(tk(2), Date.now());
    const s = await (await W.apiDailyStatus(env)).json();
    assert.equal(s.products.checked_by_people.products, 1);
    assert.equal(s.products.popular_seed_list.products, 1);
    assert.equal(s.daily_prices_saved_last_24h, 1);
    assert.ok(!JSON.stringify(s).includes("http"), "no product links in the status");
  });
});
