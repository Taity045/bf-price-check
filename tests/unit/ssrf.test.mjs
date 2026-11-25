import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { W, worker } from "../helpers/load-worker.mjs";
import { fixture } from "../helpers/fixtures.mjs";
import { testDb } from "../helpers/db.mjs";

const RESOLVERS = new Set(["1.1.1.1", "dns.google"]);
const dnsAnswer = (a = [], aaaa = []) => (u) => Response.json({ Status: 0, Answer: u.searchParams.get("type") === "A" ? a.map((data) => ({ type: 1, data })) : aaaa.map((data) => ({ type: 28, data })) });

// Replaces fetch for one test: DNS-over-HTTPS calls go to `dns`, everything else to `site`.
function mockNet(t, dns, site = () => { throw new Error("no store traffic expected"); }) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (raw, init) => {
    const u = new URL(raw);
    calls.push(u.href);
    return RESOLVERS.has(u.hostname) ? dns(u) : site(u, init);
  });
  return calls;
}

describe("validateUrl", () => {
  const err = (u) => W.validateUrl(u).error;
  test("accepts normal shop links and strips the fragment and trailing dot", () => {
    const r = W.validateUrl("  https://www.takealot.com./x/PLID1#reviews ");
    assert.equal(r.error, undefined);
    assert.equal(r.url.href, "https://www.takealot.com/x/PLID1");
    assert.ok(W.validateUrl("http://shop.co.uk:443/p").url);
  });
  const bad = {
    "empty": "", "not a link": "hello there", "ftp": "ftp://shop.co.za/x", "javascript": "javascript:alert(1)", "file": "file:///etc/passwd",
    "login details": "https://user:pw@shop.co.za/", "odd port": "https://shop.co.za:8080/", "localhost": "http://localhost/",
    "single label": "http://intranet/", ".local": "http://printer.local/", ".internal": "https://metadata.google.internal/computeMetadata/v1/",
    ".lan": "http://nas.lan/", ".home": "http://router.home/", ".corp": "http://wiki.corp/", "sub.localhost": "http://a.localhost/", ".arpa": "http://1.0.0.127.in-addr.arpa/",
    "IPv4 literal": "http://127.0.0.1/", "IPv4 metadata": "http://169.254.169.254/latest/meta-data/", "decimal IP": "http://2130706433/",
    "hex IP": "http://0x7f.0.0.1/", "IPv6 literal": "http://[::1]/", "IPv6 mapped": "http://[::ffff:127.0.0.1]/", "workers.dev": "https://bf-price-check.tm-deal-lab.workers.dev/api/check",
    "archive.org": "https://web.archive.org/web/2024/https://x.co.za", "too long": "https://shop.co.za/" + "a".repeat(2100), "empty label": "http://shop..co.za/",
  };
  for (const [name, u] of Object.entries(bad)) test(`rejects ${name}`, () => assert.ok(err(u), u));
});

describe("private address ranges", () => {
  test("IPv4", () => {
    for (const ip of ["0.0.0.0", "10.1.2.3", "127.0.0.1", "100.64.0.1", "100.127.255.255", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "192.0.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.5", "224.0.0.1", "255.255.255.255", "999.1.1.1", "1.2.3"]) {
      assert.equal(W.isPrivateIPv4(ip), true, ip);
    }
    for (const ip of ["1.1.1.1", "8.8.8.8", "104.18.0.1", "172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1", "192.169.0.1"]) assert.equal(W.isPrivateIPv4(ip), false, ip);
  });
  test("IPv6", () => {
    for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:7f00:1", "2001:db8::1", "2001:10::1", "2002:c0a8:101::1", "ff02::1", "not-an-ip"]) assert.equal(W.isPrivateIPv6(ip), true, ip);
    for (const ip of ["2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "2001:4860:4860::8888"]) assert.equal(W.isPrivateIPv6(ip), false, ip);
  });
});

describe("DNS check (DoH)", () => {
  test("public answers pass", async (t) => {
    mockNet(t, dnsAnswer(["104.18.0.1"], ["2606:4700::1"]));
    assert.equal(await W.resolvesPublic("shop.co.za"), true);
  });
  test("a private A record is refused", async (t) => {
    mockNet(t, dnsAnswer(["104.18.0.1", "10.0.0.5"]));
    assert.equal(await W.resolvesPublic("evil.example.com"), false);
  });
  test("a private AAAA record is refused", async (t) => {
    mockNet(t, dnsAnswer(["104.18.0.1"], ["::1"]));
    assert.equal(await W.resolvesPublic("evil.example.com"), false);
  });
  test("falls back to the second resolver when the first fails", async (t) => {
    const calls = mockNet(t, (u) => (u.hostname === "1.1.1.1" ? new Response("down", { status: 502 }) : dnsAnswer(["127.0.0.1"])(u)));
    assert.equal(await W.resolvesPublic("evil.example.com"), false);
    assert.ok(calls.some((c) => c.startsWith("https://dns.google/")));
  });
  test("fails closed when no resolver answers", async (t) => {
    mockNet(t, () => { throw new TypeError("network down"); });
    assert.equal(await W.resolvesPublic("shop.co.za"), null);
  });
  test("fails closed on resolver errors like SERVFAIL", async (t) => {
    mockNet(t, () => Response.json({ Status: 2 }));
    assert.equal(await W.resolvesPublic("shop.co.za"), null);
  });
  test("one answered lookup is enough (A answers, AAAA resolver down)", async (t) => {
    mockNet(t, (u) => (u.searchParams.get("type") === "AAAA" ? new Response("down", { status: 502 }) : Response.json({ Status: 0, Answer: [{ type: 1, data: "104.18.0.1" }] })));
    assert.equal(await W.resolvesPublic("shop.co.za"), true);
  });
  test("NXDOMAIN with no addresses passes the DNS check (the fetch then fails)", async (t) => {
    mockNet(t, () => Response.json({ Status: 3 }));
    assert.equal(await W.resolvesPublic("nope.co.za"), true);
  });
});

describe("live check flow (no network)", () => {
  test("/api/check refuses a host that resolves to a private address", async (t) => {
    const { env } = testDb(t);
    mockNet(t, dnsAnswer(["192.168.0.10"]));
    const r = await worker.fetch(new Request("https://site.test/api/check?url=" + encodeURIComponent("https://intranet-shop.co.za/p"), { headers: { "user-agent": "Mozilla/5.0" } }), env, { waitUntil() {} });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /public website/);
  });
  test("/api/check answers 503 (not 'not public') when no DNS resolver answers", async (t) => {
    const { env } = testDb(t);
    mockNet(t, () => { throw new TypeError("network down"); });
    const r = await worker.fetch(new Request("https://site.test/api/check?url=" + encodeURIComponent("https://shop-dns-down.co.za/p"), { headers: { "user-agent": "Mozilla/5.0" } }), env, { waitUntil() {} });
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /look up the shop's address/);
  });
  test("a store redirect to a private address is refused", async (t) => {
    let hits = 0;
    mockNet(t, (u) => dnsAnswer(u.searchParams.get("name") === "inside.example.com" ? ["10.0.0.1"] : ["104.18.0.1"])(u), (u) => {
      hits++;
      if (u.hostname === "shop.co.za") return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } });
      throw new Error("must not reach " + u.href);
    });
    const r = await W.getCurrent(W.canonicalize(new URL("https://shop.co.za/p")), "https://shop.co.za/p", "shop.co.za");
    assert.equal(r.status, "error");
    assert.match(r.message, /IP address/);
    assert.equal(hits, 1);
  });
  test("a redirect to a name that resolves privately is refused", async (t) => {
    mockNet(t, (u) => dnsAnswer(u.searchParams.get("name") === "inside.example.com" ? ["10.0.0.1"] : ["104.18.0.1"])(u), (u) => {
      if (u.hostname === "shop.co.za") return new Response(null, { status: 301, headers: { location: "https://inside.example.com/" } });
      throw new Error("must not reach " + u.href);
    });
    const r = await W.getCurrent(W.canonicalize(new URL("https://shop.co.za/p")), "https://shop.co.za/p", "shop.co.za");
    assert.equal(r.status, "error");
    assert.match(r.message, /public address/);
  });
  test("too many redirects", async (t) => {
    mockNet(t, dnsAnswer(["104.18.0.1"]), (u) => new Response(null, { status: 302, headers: { location: "/loop" + Math.random() } }));
    const r = await W.getCurrent(W.canonicalize(new URL("https://shop.co.za/p")), "https://shop.co.za/p", "shop.co.za");
    assert.match(r.message, /redirected too many times/);
  });
  test("Amazon bot check page is reported as blocked", async (t) => {
    mockNet(t, dnsAnswer(["104.18.0.1"]), () => new Response(fixture("amazon-bot-check.html"), { status: 200 }));
    const u = new URL("https://www.amazon.co.za/dp/B0DGJ7HYG1");
    const r = await W.getCurrent(W.canonicalize(u), u.href, u.hostname);
    assert.equal(r.status, "blocked");
    assert.match(r.message, /bot check/);
  });
  test("Amazon showing a foreign currency gives no price", async (t) => {
    mockNet(t, dnsAnswer(["104.18.0.1"]), () => new Response(fixture("amazon-product.html")));
    const u = new URL("https://www.amazon.co.za/dp/1847941834");
    const r = await W.getCurrent(W.canonicalize(u), u.href, u.hostname);
    assert.equal(r.status, "noprice");
    assert.match(r.message, /GBP instead of ZAR/);
  });
  test("Amazon UK page in pounds is read", async (t) => {
    mockNet(t, dnsAnswer(["104.18.0.1"]), (u) => { assert.match(u.href, /^https:\/\/www\.amazon\.co\.uk\/dp\/1847941834$/); return new Response(fixture("amazon-product.html")); });
    const u = new URL("https://www.amazon.co.uk/Atomic-Habits/dp/1847941834/ref=x?th=1");
    const r = await W.getCurrent(W.canonicalize(u), u.href, u.hostname);
    assert.deepEqual([r.status, r.price, r.was, r.currency], ["ok", 8, 16.99, "GBP"]);
  });
  test("SA shop on .com without a currency on the page gets ZAR, marked as guessed", async (t) => {
    mockNet(t, dnsAnswer(["104.18.0.1"]), () => new Response('<span itemprop="price" content="1499.00">R1 499</span>'));
    const u = new URL("https://www.bash.com/p/123");
    const r = await W.getCurrent(W.canonicalize(u), u.href, u.hostname);
    assert.deepEqual([r.status, r.price, r.currency, r.currency_guessed], ["ok", 1499, "ZAR", true]);
  });
  test("HTTP 404 and 403 from the store", async (t) => {
    let status = 404;
    mockNet(t, dnsAnswer(["104.18.0.1"]), () => new Response("gone", { status }));
    const u = new URL("https://shop.co.za/p");
    assert.equal((await W.getCurrent(W.canonicalize(u), u.href, u.hostname)).status, "error");
    status = 403;
    assert.equal((await W.getCurrent(W.canonicalize(u), u.href, u.hostname)).status, "blocked");
  });
});
