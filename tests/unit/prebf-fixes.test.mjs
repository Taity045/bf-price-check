// Pre-Black Friday fixes (25 Nov 2026): requests that got a 404 (iPhone icon names, sitemap), Amazon share
// short links (amzn.eu, amzn.to, a.co) and Amazon South Africa / UK as shops we can't search. No network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { W, worker } from "../helpers/load-worker.mjs";
import { testDb } from "../helpers/db.mjs";

const get = (env, path, method = "GET") => worker.fetch(new Request("https://site.test" + path, { method, headers: { "user-agent": "Mozilla/5.0 (iPhone) Safari" } }), env, { waitUntil() {} });

describe("no 404 for real visitors", () => {
  for (const p of ["/apple-touch-icon.png", "/apple-touch-icon-precomposed.png", "/apple-touch-icon-120x120.png", "/apple-touch-icon-180x180-precomposed.png"]) {
    test(`${p} is the 180 px PNG icon`, async (t) => {
      const { env } = testDb(t);
      const r = await get(env, p);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("content-type"), "image/png");
      const b = Buffer.from(await r.arrayBuffer());
      assert.equal(b.slice(1, 4).toString(), "PNG"); assert.equal(b.readUInt32BE(16), 180);
    });
  }
  test("look-alike icon names still get 404", async (t) => {
    const { env } = testDb(t);
    for (const p of ["/apple-touch-icon.png.bak", "/apple-touch-icon-x.png", "/xapple-touch-icon.png"]) assert.equal((await get(env, p)).status, 404, p);
  });
  test("sitemap.xml lists the two pages; robots.txt names it", async (t) => {
    const { env } = testDb(t);
    const r = await get(env, "/sitemap.xml");
    assert.equal(r.status, 200); assert.match(r.headers.get("content-type"), /xml/);
    const x = await r.text();
    assert.match(x, /<loc>https:\/\/site\.test\/<\/loc>/); assert.match(x, /<loc>https:\/\/site\.test\/privacy<\/loc>/);
    const rb = await (await get(env, "/robots.txt")).text();
    assert.match(rb, /^User-agent: \*\nAllow: \/\nSitemap: https:\/\/site\.test\/sitemap\.xml\n$/);
  });
  test("bot probes still get 404", async (t) => {
    const { env } = testDb(t);
    for (const p of ["/.env", "/wp-admin/", "/.git/config", "/render.yaml"]) assert.equal((await get(env, p)).status, 404, p);
  });
});

// The Amazon bot check page (what a plain request to amazon.co.za/dp/… gets, HTTP 200).
const AMZ_CAPTCHA = `<!doctype html><html><head><title dir="ltr">Amazon.co.za</title></head><body><h4>Enter the characters you see below</h4><p>Sorry, we just need to make sure you're not a robot.</p><form action="/errors/validateCaptcha"><img src="https://images-na.ssl-images-amazon.com/captcha/x/Captcha_abc.jpg"></form><!-- To discuss automated access to Amazon data please contact api-services-support@amazon.com. --></body></html>`;
const SHORT = "https://amzn.eu/d/033QGzXN";
const DEST = "https://www.amazon.co.za/dp/B0FSLPR9WF?ref=cm_sw_r_cso_cp_apin_dp_X&social_share=cm_sw_r_cso_cp_apin_dp_X";

describe("Amazon short links in /api/check (mocked, no network)", () => {
  const run = async (t, url, short = (u) => (/amzn\.eu/.test(u) ? new Response(null, { status: 301, headers: { location: DEST } }) : null)) => {
    const { env } = testDb(t);
    const real = globalThis.fetch, asked = [];
    globalThis.fetch = async (input, init = {}) => {
      const u = typeof input === "string" ? input : input.url; asked.push({ u, redirect: init.redirect });
      if (/dns-query|dns\.google/.test(u)) return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }] }), { headers: { "content-type": "application/dns-json" } });
      const s = short(u); if (s) return s;
      if (/amazon\.co\.za/.test(u)) return new Response(AMZ_CAPTCHA, { status: 200, headers: { "content-type": "text/html" } });
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    };
    t.after(() => { globalThis.fetch = real; });
    const waits = [];
    const r = await worker.fetch(new Request("https://site.test/api/check?url=" + encodeURIComponent(url), { headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0 Safari/537.36", "cf-connecting-ip": "198.51.100." + (Math.random() * 200 | 0) } }), env, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    return { status: r.status, body: await r.json(), asked };
  };
  test("amzn.eu link: checks the Amazon.co.za page, names the shop, ZAR for the price box", async (t) => {
    const { status, body, asked } = await run(t, SHORT);
    assert.equal(status, 200);
    assert.equal(body.host, "amazon.co.za");
    assert.equal(body.canonical, "https://www.amazon.co.za/dp/B0FSLPR9WF");
    assert.match(body.url, /^https:\/\/www\.amazon\.co\.za\/dp\/B0FSLPR9WF/);
    assert.equal(body.tld_currency, "ZAR");
    assert.deepEqual(body.blocked_shop, { name: "Amazon South Africa" });
    assert.equal(body.current.status, "blocked"); assert.equal(body.current.price, undefined, "no price from a bot check page");
    const s = asked.filter((a) => /amzn\.eu/.test(a.u));
    assert.equal(s.length, 1); assert.equal(s[0].redirect, "manual", "we read the short link's answer, we don't follow it blindly");
    assert.ok(asked.filter((a) => /^https:\/\/www\.amazon\.co\.za\//.test(a.u)).length <= 1, "at most one request to Amazon, no retry against its bot check");
  });
  test("a short link that goes somewhere other than Amazon is refused", async (t) => {
    const { status, body, asked } = await run(t, "https://amzn.to/abc", (u) => (/amzn\.to/.test(u) ? new Response(null, { status: 302, headers: { location: "https://evil.example/x" } }) : null));
    assert.equal(status, 400); assert.match(body.error, /does not go to an Amazon page/);
    assert.ok(!asked.some((a) => /evil\.example/.test(a.u)), "never opens the other site");
  });
  test("a short link with no redirect gives a plain message", async (t) => {
    const { status, body } = await run(t, "https://a.co/d/none", (u) => (/a\.co/.test(u) ? new Response("{\"message\":\"Page Not Found\"}", { status: 404 }) : null));
    assert.equal(status, 400); assert.match(body.error, /Paste the full Amazon link/);
  });
  test("a short link to a private address is refused", async (t) => {
    const { status } = await run(t, "https://amzn.eu/d/x", (u) => (/amzn\.eu/.test(u) ? new Response(null, { status: 301, headers: { location: "http://127.0.0.1/admin" } }) : null));
    assert.equal(status, 400);
  });
});

describe("Amazon in compare", () => {
  test("ZA electronics compare names Amazon South Africa as a shop we can't search", () => {
    const id = W.cmpIdentity({ title: "Samsung Galaxy Buds3 Pro Wireless Earbuds Silver", brand: "Samsung", price: 3999, currency: "ZAR" }, "https://www.takealot.com/x/PLID1");
    const p = W.cmpPlan(id, "www.takealot.com", "ZAR");
    assert.ok(p.notSearched.some((x) => x.name === "Amazon South Africa" && x.why === "blocks"), JSON.stringify(p.notSearched));
    assert.ok(!p.shops.some((s) => /amazon/i.test(s.name)), "never searched");
  });
  test("UK electronics compare names Amazon UK; not for groceries", () => {
    const e = W.cmpPlan(W.cmpIdentity({ title: "Sony WH-1000XM5 Wireless Headphones Black", brand: "Sony", price: 279, currency: "GBP" }, "https://www.currys.co.uk/x"), "www.currys.co.uk", "GBP");
    assert.ok(e.notSearched.some((x) => x.name === "Amazon UK"), JSON.stringify(e.notSearched));
    const g = W.cmpPlan(W.cmpIdentity({ title: "Coca-Cola Original Taste 24 x 330ml", brand: "Coca-Cola", price: 12.5, currency: "GBP" }, "https://groceries.morrisons.com/x"), "groceries.morrisons.com", "GBP");
    assert.ok(!g.notSearched.some((x) => /Amazon/.test(x.name)));
  });
});

describe("result page wording", () => {
  const js = readFileSync(new URL("../../public/result.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");
  test("'Not compared' is one small line; the other headline states keep the big card", () => {
    assert.match(js, /const setCmpSlim = \(why\) => setCmpHead\("slim", "", "Not compared with other shops: " \+ why\);/);
    assert.ok(!/setCmpHead\("", "Not compared"/.test(js), "no big 'Not compared' card left");
    assert.match(html, /\.cmphead\.slim\{min-height:0;/);
    for (const s of ["No cheaper exact match found", "Checking other shops…", "`Cheaper at ${b.name}"]) assert.ok(js.includes(s), s);
  });
  test("shared Amazon text sets the price box currency", () => {
    assert.match(html, /Amazon\\\.co\\\.za\\b\/i\.test\(v\) \? "ZAR"/);
  });
});
