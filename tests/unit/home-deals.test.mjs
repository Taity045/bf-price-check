// AB-37 home page: "Today's genuine deals" (src/home.js, GET /api/home) and the new home page parts in the built page.
// Only real data: price drops from D1 verdicts that match the last checked price (checked in the last 3 days), and
// live flyer deals with a printed normal price above the deal price. No D1 writes; answers are kept in memory.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { W, worker } from "../helpers/load-worker.mjs";
import { testDb } from "../helpers/db.mjs";

const T = (s) => Date.parse(s);
const DURING = T("2026-11-27T08:00:00Z");   // 10:00 SAST on Black Friday
const AFTER = T("2026-11-29T22:00:00Z");    // 00:00 SAST on 30 Nov: every Pick n Pay flyer deal has ended
const BEFORE = T("2026-11-22T12:00:00Z");   // before any flyer starts
const DAY = 864e5;
const realNow = Date.now;
function at(t, ctx) { Date.now = () => t; ctx.after(() => { Date.now = realNow; }); }
const pnp = JSON.parse(readFileSync(new URL("../../data/pnp-flyer-2026-11-26.json", import.meta.url), "utf8"));

describe("home deals: flyer deals", () => {
  test("only live deals with a printed normal price above the deal price; the saving is the flyer's own numbers", () => {
    const list = W.homeFlyer(DURING);
    assert.ok(list.length > 0 && list.length <= 12, `${list.length} flyer deals`);
    for (const x of list) {
      const f = W.FLYERS.find((y) => y.shop === x.shop); assert.ok(f, x.shop);
      const d = f.data.deals.find((y) => y.title === x.title && y.price === x.price);
      assert.ok(d, `${x.title}: a real flyer deal`);
      assert.ok(d.regular_price > d.price, `${x.title}: normal price above the deal price`);
      assert.equal(x.regular, d.regular_price);
      assert.equal(x.saving, Math.round((d.regular_price - d.price) * 100) / 100);
      assert.equal(x.currency, "ZAR"); assert.equal(x.cc, "ZA"); assert.equal(x.kind, "flyer"); assert.equal(x.label, "Flyer deal");
      assert.equal(x.href, "/?q=" + encodeURIComponent(d.title).replace(/%20/g, "+") + "&c=ZA");
      assert.ok(x.until > DURING, "still live");
      assert.ok(!("score" in x), "no invented score");
    }
    for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].saving >= list[i].saving, "biggest saving first");
  });
  test("the Russell Hobbs iron: 2 for R399, normal price R799.98 for 2", () => {
    const iron = W.homeFlyer(DURING).find((x) => /Supremeglide/.test(x.title));
    const d = pnp.deals.find((y) => /Supremeglide/.test(y.title));
    assert.ok(iron && d);
    assert.equal(iron.price, d.price); assert.equal(iron.qty, d.qty); assert.equal(iron.regular, d.regular_price);
    assert.match(iron.deal, /^2 for R399/);
  });
  test("at most 8 deals per shop", () => {
    const by = {}; for (const x of W.homeFlyer(DURING)) by[x.shop] = (by[x.shop] || 0) + 1;
    assert.ok(Object.values(by).every((n) => n <= 8), JSON.stringify(by));
  });
  test("auto-expiry: nothing after the last flyer day, nothing before the first", () => {
    assert.deepEqual(W.homeFlyer(AFTER), []);
    assert.deepEqual(W.homeFlyer(BEFORE), []);
  });
});

function seed(db, t, rows) {
  for (const r of rows) {
    db.prepare("INSERT INTO verdicts (url, host, title, verdict, price, was, currency, low, med, high, high90, n, gap, archived, low_t, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)")
      .run(r.url, new URL(r.url).hostname.replace(/^www\./, ""), r.title ?? "Product " + r.url.slice(-2), r.verdict, r.price, r.currency || "ZAR", r.low ?? r.price, r.med, r.med * 1.2, r.med * 1.2, r.n ?? 9, r.archived ?? 0, t - 30 * DAY, t - 10 * DAY);
    db.prepare("INSERT INTO tracked (url, title, added_at, last_checked, last_status, host) VALUES (?, ?, ?, ?, ?, ?)").run(r.url, r.title ?? null, t - 60 * DAY, r.checked ?? t - 3600e3, r.status || "ok", "x");
    db.prepare("INSERT INTO checks (url, ts, price, currency) VALUES (?, ?, ?, ?)").run(r.url, t - 40 * DAY, r.med, r.currency || "ZAR");
    db.prepare("INSERT INTO checks (url, ts, price, currency) VALUES (?, ?, ?, ?)").run(r.url, t - 3600e3, r.lastPrice ?? r.price, r.currency || "ZAR");
  }
}
describe("home deals: price drops from our own checks (D1)", () => {
  test("fresh Real deal and Decent deal rows show; stale, changed, archived, error, fake and other currencies do not", async (t) => {
    at(DURING, t);
    const { db, env } = testDb(t);
    const u = (n) => `https://www.takealot.com/p/PLID0000${n}`;
    seed(db, DURING, [
      { url: u(11), title: "Kettle real", verdict: "Real deal", price: 800, med: 1000 },                      // 20 % under: shows
      { url: u(12), title: "Toaster decent", verdict: "Decent deal", price: 900, med: 1000 },                 // 10 % under: shows
      { url: u(13), title: "Stale", verdict: "Real deal", price: 500, med: 1000, checked: DURING - 4 * DAY }, // not checked in 3 days
      { url: u(14), title: "Changed", verdict: "Real deal", price: 500, med: 1000, lastPrice: 700 },          // price changed since
      { url: u(15), title: "Archived", verdict: "Real deal", price: 500, med: 1000, archived: 1 },
      { url: u(16), title: "Error", verdict: "Real deal", price: 500, med: 1000, status: "error" },
      { url: u(17), title: "Fake", verdict: "Fake discount", price: 500, med: 1000 },
      { url: u(18), title: "Euro", verdict: "Real deal", price: 500, med: 1000, currency: "EUR" },
      { url: u(19), title: "Same", verdict: "Same old price", price: 1000, med: 1000 },
      { url: "https://www.currys.co.uk/products/x-10199999.html", title: "UK TV", verdict: "Decent deal", price: 85, med: 100, currency: "GBP" },
    ]);
    const list = await W.homeDrops(env, DURING);
    assert.deepEqual(list.map((x) => x.title), ["Kettle real", "UK TV", "Toaster decent"]);
    const [k, uk, ts] = list;
    assert.equal(k.label, "Lowest price we found"); assert.equal(k.good, true);
    assert.equal(k.saving, 200); assert.equal(k.usual, 1000); assert.equal(k.pct, 20); assert.equal(k.n, 9);
    assert.equal(k.shop, "Takealot"); assert.equal(k.cc, "ZA"); assert.equal(k.currency, "ZAR");
    assert.equal(k.href, "/?u=" + encodeURIComponent(u(11)));
    assert.equal(ts.label, "Lower than usual");
    assert.equal(uk.cc, "GB"); assert.equal(uk.currency, "GBP");
  });
  test("no verdicts table or no DB: an empty list, never an error", async () => {
    assert.deepEqual(await W.homeDrops({}, DURING), []);
    assert.deepEqual(await W.homeDrops({ DB: { prepare() { throw new Error("no such table"); } } }, DURING), []);
  });
});

describe("GET /api/home", () => {
  test("drops first, then flyer deals; cached in memory (one D1 read), no D1 writes, short cache header", async (t) => {
    at(DURING, t); W.homeMemReset(); t.after(() => W.homeMemReset());
    const { db, env } = testDb(t);
    seed(db, DURING, [{ url: "https://www.takealot.com/p/PLID00000021", title: "Air fryer", verdict: "Real deal", price: 999, med: 1499 }]);
    const sql = [];
    const DB = { prepare: (s) => { sql.push(s); return env.DB.prepare(s); }, batch: env.DB.batch };
    const get = () => worker.fetch(new Request("https://site.test/api/home"), { DB }, { waitUntil() {} });
    const r = await get(); const d = await r.json();
    assert.equal(r.status, 200);
    assert.match(r.headers.get("cache-control"), /^public, max-age=([0-9]|[1-9][0-9]|[12][0-9]{2}|300)$/);
    assert.equal(d.deals[0].title, "Air fryer"); assert.equal(d.deals[0].kind, "drop");
    assert.ok(d.flyer > 0 && d.deals.slice(1).every((x) => x.kind === "flyer"));
    await get(); await get();
    assert.equal(sql.length, 1, "one D1 read for three requests");
    assert.ok(sql.every((s) => /^\s*SELECT/i.test(s)), "no D1 writes");
  });
  test("a flyer deal that ended after the answer was made is not sent", async (t) => {
    W.homeMemReset(); t.after(() => W.homeMemReset());
    let now = T("2026-11-29T21:58:00Z"); Date.now = () => now; t.after(() => { Date.now = realNow; });
    const get = () => worker.fetch(new Request("https://site.test/api/home"), {}, { waitUntil() {} });
    const a = await (await get()).json();
    assert.ok(a.deals.length > 0);
    assert.ok(a.expires_at <= T("2026-11-29T21:59:59.999Z"), "the answer is never kept past the end of a shown deal");
    now = AFTER;
    const b = await (await get()).json();
    assert.deepEqual(b.deals, []);
  });
  test("POST is refused", async () => {
    const r = await worker.fetch(new Request("https://site.test/api/home", { method: "POST" }), {}, { waitUntil() {} });
    assert.equal(r.status, 405);
  });
});

describe("home page: deal cards written into the page", () => {
  test("GET / has the live flyer cards, 4 shown, View all with the count, and the note; no request needed", async (t) => {
    at(DURING, t); W.homeMemReset(); t.after(() => W.homeMemReset());
    const { db, env } = testDb(t);
    seed(db, DURING, [
      { url: "https://www.takealot.com/p/PLID00000031", title: "Kettle <b>bold</b>", verdict: "Real deal", price: 799, med: 999 },
      { url: "https://www.currys.co.uk/products/x-10199998.html", title: "UK TV", verdict: "Decent deal", price: 85, med: 100, currency: "GBP" },
    ]);
    const r = await worker.fetch(new Request("https://site.test/"), env, { waitUntil() {} });
    const html = await r.text();
    const lis = [...html.matchAll(/<li data-cc="(ZA|GB)" data-kind="(drop|flyer)"(?: data-until="\d+")?( hidden)?><a class="dcard" href="([^"]+)"/g)];
    const za = lis.filter((m) => m[1] === "ZA"), gb = lis.filter((m) => m[1] === "GB");
    assert.ok(za.length >= 5, `${za.length} ZA cards`);
    assert.equal(za.filter((m) => !m[3]).length, 4, "4 shown at first");
    assert.equal(za[0][2], "drop", "our own price drop first");
    assert.equal(gb.length, 1); assert.ok(gb[0][3], "UK cards hidden until UK is chosen");
    assert.ok(html.includes(`>View all (${za.length})</button>`));
    assert.ok(html.includes("Kettle &lt;b&gt;bold&lt;/b&gt;"), "titles are escaped");
    assert.match(html, /Lowest price we found<\/span><b class="dtitle">Kettle/);
    assert.match(html, /R\s?799<\/span><span class="dmeta"><b>R\s?200 under<\/b> the usual R\s?999 · from 9 older prices<br>Checked today/);
    assert.match(html, /Flyer deals come from the shop&#39;s printed flyer/);
    assert.match(html, /<li class="dempty" data-empty="ZA" hidden>/);
  });
  test("after the flyers end and with no drops: an honest empty note, no View all", async (t) => {
    at(AFTER, t); W.homeMemReset(); t.after(() => W.homeMemReset());
    const html = await (await worker.fetch(new Request("https://site.test/"), {}, { waitUntil() {} })).text();
    assert.ok(!/<li data-cc=/.test(html));
    assert.match(html, /<li class="dempty" data-empty="ZA">No genuine deals to show right now/);
    assert.match(html, /class="linkbtn more hidden" id="dealsAll"/);
  });
  test("a shared result or search link gets no cards (the home parts are hidden there) and no SA / UK switch on a result", async (t) => {
    at(DURING, t); W.homeMemReset(); t.after(() => W.homeMemReset());
    const a = await (await worker.fetch(new Request("https://site.test/?u=" + encodeURIComponent("https://www.takealot.com/p/PLID1")), {}, { waitUntil() {} })).text();
    assert.ok(!/<li data-cc=/.test(a)); assert.match(a, /<div class="ccrow hidden" id="ccrow"/);
    const b = await (await worker.fetch(new Request("https://site.test/?q=PS5&c=ZA"), {}, { waitUntil() {} })).text();
    assert.ok(!/<li data-cc=/.test(b)); assert.match(b, /<div class="ccrow" id="ccrow"/);
    const c = await (await worker.fetch(new Request("https://site.test/?m=ai"), {}, { waitUntil() {} })).text();
    assert.ok(/<li data-cc=/.test(c), "the AI tab link still shows the deals");
  });
});

describe("home page: the built page", () => {
  execFileSync("python3", ["build.py"], { cwd: new URL("../../", import.meta.url), stdio: "ignore" });
  const worker2 = readFileSync(new URL("../../dist/worker.js", import.meta.url), "utf8");
  const html = JSON.parse(worker2.match(/\nconst HTML = (".*");\n/)[1]);
  test("3 mode pills: Find a product, Verify a deal, Ask AI; no camera button", () => {
    const pills = [...html.matchAll(/<button type="button" class="mode" data-m="(\w+)" aria-pressed="false">([^<]+)<\/button>/g)].map((m) => m[1] + ":" + m[2]);
    assert.deepEqual(pills, ["find:Find a product", "verify:Verify a deal", "ai:Ask AI"]);
    assert.ok(!/camera|type="file"|capture=/i.test(html), "no camera or image upload");
  });
  test("today's genuine deals, quick searches, the AI block with the law student example", () => {
    assert.ok(html.includes("Today's genuine deals") && html.includes('id="dealList"') && html.includes('id="dealsAll"'));
    const tp = [...html.matchAll(/<button type="button" class="tp" data-q="([^"]+)">([^<]+)<\/button>/g)].map((m) => m[2]);
    assert.deepEqual(tp, ["iPhone 16", "Gaming laptops", "Running watches", "Air fryers", "TVs"]);
    assert.ok(html.includes("Your AI shopping expert"));
    assert.ok(html.includes('data-q="I have R10,000. I need a laptop for a law student">Laptop for a law student, R10,000<'));
  });
  test("bottom bar and top bar: Home, Deals, AI, Saved (no Alerts)", () => {
    const bnav = html.match(/<nav class="bnav"[\s\S]*?<\/nav>/)[0];
    assert.deepEqual([...bnav.matchAll(/<\/svg>(\w+)<\/(?:a|button)>/g)].map((m) => m[1]), ["Home", "Deals", "AI", "Saved"]);
    assert.ok(!/Alerts/.test(bnav));
    const top = html.match(/<nav class="topnav"[\s\S]*?<\/nav>/)[0];
    assert.ok(/>Home</.test(top) && />Deals</.test(top) && />AI</.test(top) && /id="savedBtn"/.test(top) && !/Alerts/.test(top));
  });
  test("never the owner's name or email", () => {
    assert.ok(!/tatenda|magondo|@gmail/i.test(html));
  });
});
