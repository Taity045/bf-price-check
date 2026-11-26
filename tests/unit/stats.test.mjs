import assert from "node:assert/strict";
import { describe, test, before, after } from "node:test";
import { W, worker } from "../helpers/load-worker.mjs";
import { testDb } from "../helpers/db.mjs";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const PHONE = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

function setup(t, extraEnv = {}) {
  const { db, env } = testDb(t);
  Object.assign(env, extraEnv);
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  const call = async (url, { headers = {}, method = "GET", body, cf } = {}) => {
    const req = new Request(url, { method, headers: { "user-agent": UA, ...headers }, body });
    if (cf) Object.defineProperty(req, "cf", { value: cf });
    const r = await worker.fetch(req, env, ctx);
    await Promise.all(waits.splice(0));
    return r;
  };
  const counts = () => Object.fromEntries(db.prepare("SELECT metric || ':' || key AS k, n FROM m_counts").all().map((r) => [r.k, r.n]));
  return { db, env, call, counts, ctx };
}
const b64u = (buf) => Buffer.from(buf).toString("base64url");

describe("stats helpers", () => {
  test("days follow South African time (UTC+2)", () => {
    assert.equal(W.mDay(Date.UTC(2026, 10, 24, 21, 59)), "2026-11-24");
    assert.equal(W.mDay(Date.UTC(2026, 10, 24, 22, 0)), "2026-11-25");
  });
  test("device type", () => {
    assert.equal(W.mDevice(UA), "desktop");
    assert.equal(W.mDevice(PHONE), "phone");
    assert.equal(W.mDevice(IPHONE), "phone");
    assert.equal(W.mDevice("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)"), "tablet");
    assert.equal(W.mDevice("Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 Chrome/120 Safari/537.36"), "tablet");
  });
  test("referrer keeps the domain only and skips our own site", () => {
    assert.equal(W.mRefDomain("https://www.reddit.com/r/southafrica/comments/abc?x=1", "eish.veldwire.com"), "reddit.com");
    assert.equal(W.mRefDomain("https://www.google.co.za/", "eish.veldwire.com"), "google");
    assert.equal(W.mRefDomain("https://l.facebook.com/l.php?u=x", "eish.veldwire.com"), "facebook.com");
    assert.equal(W.mRefDomain("https://t.co/abc", "eish.veldwire.com"), "x.com");
    assert.equal(W.mRefDomain("", "eish.veldwire.com"), "direct");
    assert.equal(W.mRefDomain(null, "eish.veldwire.com"), "direct");
    assert.equal(W.mRefDomain("https://eish.veldwire.com/?u=1", "eish.veldwire.com"), null);
    assert.equal(W.mRefDomain("https://bf-price-check.tm-deal-lab.workers.dev/", "eish.veldwire.com"), null);
    assert.equal(W.mRefDomain("android-app://com.whatsapp", "x"), "other");
    assert.equal(W.mRefDomain("not a url", "x"), "other");
  });
  test("bots, link previews, scripts and prefetch are not people", () => {
    const h = (ua, extra = {}) => W.mHuman(new Request("https://x.test/", { headers: { "user-agent": ua, ...extra } }));
    assert.equal(h(UA), true);
    assert.equal(h(PHONE), true);
    for (const ua of ["", "curl/8.0", "node", "WhatsApp/2.23.20.0 A", "facebookexternalhit/1.1", "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0 Safari/537.36", UA + " bf-smoke"]) assert.equal(h(ua), false, ua);
    assert.equal(h(UA, { "sec-purpose": "prefetch" }), false);
  });
  test("Access team name accepts the short name or the full domain only", () => {
    assert.equal(W.mTeam({ ACCESS_TEAM_DOMAIN: "veldwire" }), "veldwire.cloudflareaccess.com");
    assert.equal(W.mTeam({ ACCESS_TEAM_DOMAIN: "https://Veldwire.cloudflareaccess.com/" }), "veldwire.cloudflareaccess.com");
    assert.equal(W.mTeam({ ACCESS_TEAM_DOMAIN: "evil.example.com" }), null);
    assert.equal(W.mTeam({}), null);
  });
});

describe("counting page views (cookieless)", () => {
  test("page views, once-a-day visitors, country, device and referrer", async (t) => {
    const { call, counts, db } = setup(t);
    const a = { "cf-connecting-ip": "203.0.113.7", referer: "https://www.reddit.com/r/x/comments/1" };
    let r = await call("https://eish.veldwire.com/", { headers: a, cf: { country: "ZA" } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("set-cookie"), null, "no cookies");
    await call("https://eish.veldwire.com/privacy", { headers: { "cf-connecting-ip": "203.0.113.7" }, cf: { country: "ZA" } });
    await call("https://eish.veldwire.com/?u=https%3A%2F%2Fwww.takealot.com%2Fx", { headers: { "cf-connecting-ip": "198.51.100.9", "user-agent": PHONE }, cf: { country: "GB" } });
    const c = counts();
    assert.equal(c["pv:"], 3);
    assert.equal(c["visitors:"], 2, "same IP and browser on the same day counts once");
    assert.equal(c["country:ZA"], 1);
    assert.equal(c["country:GB"], 1);
    assert.equal(c["device:desktop"], 1);
    assert.equal(c["device:phone"], 1);
    assert.equal(c["ref:reddit.com"], 1);
    assert.equal(c["ref:direct"], 2);
    assert.equal(c["event:shared_link_open"], 1);
    // The raw IP and browser string are never stored anywhere.
    const dump = JSON.stringify([db.prepare("SELECT * FROM m_counts").all(), db.prepare("SELECT * FROM m_seen").all(), db.prepare("SELECT * FROM m_salt").all()]);
    for (const secret of ["203.0.113.7", "198.51.100.9", "Chrome/131", "Pixel"]) assert.ok(!dump.includes(secret), secret);
    const seen = db.prepare("SELECT h FROM m_seen").all();
    assert.equal(seen.length, 2);
    assert.ok(seen.every((s) => /^[0-9a-f]{20}$/.test(s.h)));
  });
  test("bots are counted apart and never as visitors; HEAD and assets are not counted", async (t) => {
    const { call, counts } = setup(t);
    await call("https://eish.veldwire.com/", { headers: { "user-agent": "WhatsApp/2.23" } });
    await call("https://eish.veldwire.com/", { headers: { "user-agent": "curl/8" } });
    await call("https://eish.veldwire.com/", { method: "HEAD" });
    await call("https://eish.veldwire.com/og-home.png");
    await call("https://eish.veldwire.com/api/shops");
    const c = counts();
    assert.equal(c["bot:"], 2);
    assert.equal(c["pv:"], undefined);
    assert.equal(c["visitors:"], undefined);
  });
  test("browser-test traffic (x-e2e-key) is skipped unless STATS_COUNT_E2E=1", async (t) => {
    const key = "k".repeat(20);
    const s1 = setup(t, { E2E_KEY: key });
    await s1.call("https://eish.veldwire.com/", { headers: { "x-e2e-key": key } });
    assert.equal(s1.counts()["pv:"], undefined);
    const s2 = setup(t, { E2E_KEY: key, STATS_COUNT_E2E: "1" });
    await s2.call("https://eish.veldwire.com/", { headers: { "x-e2e-key": key } });
    assert.equal(s2.counts()["pv:"], 1);
  });
  test("a new day gets a new salt and clears old salts, visitor hashes and counts older than 400 days", async (t) => {
    const { db, env, call, counts } = setup(t);
    const realNow = Date.now;
    t.after(() => { Date.now = realNow; });
    db.prepare("INSERT INTO m_salt VALUES ('2000-01-01', 'old')").run();
    db.prepare("INSERT INTO m_seen VALUES ('2000-01-01', 'abc')").run();
    db.prepare("INSERT INTO m_counts VALUES ('2000-01-01', 'pv', '', 5)").run();
    Date.now = () => Date.UTC(2031, 0, 5, 10); // a day no test has used, so the in-memory salt is stale
    await call("https://eish.veldwire.com/", { headers: { "cf-connecting-ip": "203.0.113.50" } });
    const salts = db.prepare("SELECT day FROM m_salt").all().map((r) => r.day);
    assert.deepEqual(salts, ["2031-01-05"]);
    assert.deepEqual(db.prepare("SELECT day FROM m_seen").all().map((r) => r.day), ["2031-01-05"]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM m_counts WHERE day = '2000-01-01'").get().n, 0);
    assert.equal(counts()["visitors:"], 1);
    // next day: same person counts again (no cross-day tracking), old hash gone
    Date.now = () => Date.UTC(2031, 0, 6, 10);
    await call("https://eish.veldwire.com/", { headers: { "cf-connecting-ip": "203.0.113.50" } });
    assert.deepEqual(db.prepare("SELECT day FROM m_seen").all().map((r) => r.day), ["2031-01-06"]);
    assert.equal(db.prepare("SELECT n FROM m_counts WHERE day = '2031-01-06' AND metric = 'visitors'").get().n, 1);
  });
});

describe("live probe (/api/e2e/stats-probe)", () => {
  test("needs the test key; counts one made-up visit, then removes it and leaves real counts alone", async (t) => {
    const key = "p".repeat(20);
    const { call, counts, db } = setup(t, { E2E_KEY: key });
    await call("https://eish.veldwire.com/", { headers: { "cf-connecting-ip": "203.0.113.70" }, cf: { country: "ZA" } });
    const real = counts();
    assert.equal((await call("https://eish.veldwire.com/api/e2e/stats-probe", { method: "POST" })).status, 404);
    assert.equal((await call("https://eish.veldwire.com/api/e2e/stats-probe", { method: "POST", headers: { "x-e2e-key": "wrong".repeat(5) } })).status, 404);
    const r = await call("https://eish.veldwire.com/api/e2e/stats-probe", { method: "POST", headers: { "x-e2e-key": key } });
    assert.deepEqual(await r.json(), { page_view_counted: true, visitor_counted: true, removed_again: true });
    assert.deepEqual(counts(), real);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM m_seen").get().n, 1);
  });
});

describe("counting checks and clicks", () => {
  test("a refused check (bad link) is counted as invalid", async (t) => {
    const { call, counts } = setup(t);
    const r = await call("https://eish.veldwire.com/api/check?url=notaurl", { headers: { "cf-connecting-ip": "203.0.113.60" } });
    assert.equal(r.status, 400);
    assert.equal(counts()["outcome:invalid"], 1);
    assert.equal(counts()["check:"], undefined);
  });
  test("a cached ok check counts the shop and a price read", async (t) => {
    const { counts, env, db } = setup(t);
    const canon = "https://www.takealot.com/x/PLID123";
    await W.cachePut(env, W.LIVE_CACHE_PREFIX + canon, { status: "ok", price: 999, currency: "ZAR", checked_at: Date.now() }, 1e7);
    const waits = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: "104.16.0.1" }] }), { headers: { "content-type": "application/dns-json" } });
    t.after(() => { globalThis.fetch = origFetch; });
    const r = await worker.fetch(new Request("https://eish.veldwire.com/api/check?url=" + encodeURIComponent(canon), { headers: { "user-agent": UA, "cf-connecting-ip": "203.0.113.61" } }), env, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    const c = counts();
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal((await r.json()).current.price, 999, "the answer itself is unchanged");
    assert.equal(c["check:"], 1);
    assert.equal(c["outcome:ok"], 1);
    assert.equal(c["shop:takealot.com"], 1);
    assert.equal(c["shop_ok:takealot.com"], 1);
  });
  test("beacon: known names only, same site only, always 204", async (t) => {
    const { call, counts } = setup(t);
    for (const name of ["share", "share", "save", "compare_open"]) assert.equal((await call("https://eish.veldwire.com/api/m", { method: "POST", body: name, headers: { origin: "https://eish.veldwire.com" } })).status, 204);
    assert.equal((await call("https://eish.veldwire.com/api/m", { method: "POST", body: "<script>", headers: {} })).status, 204);
    assert.equal((await call("https://eish.veldwire.com/api/m", { method: "POST", body: "share", headers: { origin: "https://evil.example" } })).status, 204);
    assert.equal((await call("https://eish.veldwire.com/api/m", { method: "POST", body: "share", headers: { "sec-fetch-site": "cross-site" } })).status, 204);
    assert.equal((await call("https://eish.veldwire.com/api/m", { method: "POST", body: "share", headers: { "user-agent": "curl/8" } })).status, 204);
    assert.equal((await call("https://eish.veldwire.com/api/m")).status, 204);
    const c = counts();
    assert.equal(c["click:share"], 2);
    assert.equal(c["click:save"], 1);
    assert.equal(c["click:compare_open"], 1);
    assert.equal(Object.keys(c).filter((k) => k.startsWith("click:")).length, 3);
  });
  test("every click name the page sends is accepted by the worker", async () => {
    const { readFileSync } = await import("node:fs");
    const html = readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");
    const names = new Set([...html.matchAll(/"((?:share|save|compare|request|saved|shops|example)[a-z_]*)"/g)].map((m) => m[1]).filter((n) => W.M_CLICKS.includes(n) || /^(share_|request_|compare_|saved_|shops_)/.test(n)));
    for (const n of names) assert.ok(W.M_CLICKS.includes(n), n);
    assert.ok(names.size >= 8);
  });
});

describe("stats dashboard access (fail closed)", () => {
  let keys, jwk, origFetch, certCalls = 0;
  const TEAM = "testteam.cloudflareaccess.com", AUD = "a".repeat(64);
  const ENV = { ACCESS_TEAM_DOMAIN: "testteam", ACCESS_AUD: AUD, OWNER_EMAIL: "owner@example.com" };
  before(async () => {
    keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    origFetch = globalThis.fetch;
    globalThis.fetch = async (u) => {
      if (String(u) === `https://${TEAM}/cdn-cgi/access/certs`) { certCalls++; return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } }); }
      throw new Error("unexpected fetch " + u);
    };
  });
  after(() => { globalThis.fetch = origFetch; });
  async function token(claims = {}, { kid = "k1", key = keys.privateKey, alg = "RS256" } = {}) {
    const t = Math.floor(Date.now() / 1000);
    const head = b64u(JSON.stringify({ alg, kid, typ: "JWT" }));
    const body = b64u(JSON.stringify({ aud: [AUD], iss: `https://${TEAM}`, email: "owner@example.com", exp: t + 600, iat: t, nbf: t, sub: "u1", ...claims }));
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(head + "." + body));
    return head + "." + body + "." + b64u(sig);
  }
  const get = (s, path, jwt, extra = {}) => s.call("https://stats.veldwire.com" + path, { headers: { ...(jwt ? { "cf-access-jwt-assertion": jwt } : {}), ...extra } });

  test("not set up yet: 403, even with a header", async (t) => {
    const s = setup(t, {});
    const r = await get(s, "/", await token());
    assert.equal(r.status, 403);
    assert.match(await r.text(), /not set up/);
    assert.equal((await get(s, "/api/data", "x.y.z")).status, 403);
  });
  test("no token, junk, wrong key, wrong audience, wrong issuer, expired, wrong email, other alg: 403", async (t) => {
    const s = setup(t, ENV);
    const other = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const bad = [
      null, "", "a.b", "a.b.c", "x".repeat(50),
      await token({}, { key: other.privateKey }),
      await token({}, { kid: "unknown" }),
      await token({ aud: ["b".repeat(64)] }),
      await token({ iss: "https://evil.cloudflareaccess.com" }),
      await token({ exp: Math.floor(Date.now() / 1000) - 5 }),
      await token({ nbf: Math.floor(Date.now() / 1000) + 3600 }),
      await token({ email: "someone@example.com" }),
      await token({ email: undefined }),
      (await token()).replace(/^[^.]+/, b64u(JSON.stringify({ alg: "none", kid: "k1" }))),
    ];
    for (const [i, jwt] of bad.entries()) {
      for (const path of ["/", "/api/data", "/anything"]) {
        const r = await get(s, path, jwt);
        assert.equal(r.status, 403, `case ${i} ${path}`);
        assert.equal(r.headers.get("cache-control"), "private, no-store");
        assert.ok(!(await r.text()).includes("Price checks"));
      }
    }
  });
  test("a valid Access token for the owner shows the dashboard and data", async (t) => {
    const s = setup(t, ENV);
    s.db.prepare("INSERT INTO m_counts VALUES (?, 'pv', '', 12), (?, 'visitors', '', 5), (?, 'check', '', 4), (?, 'outcome', 'ok', 3), (?, 'outcome', 'blocked', 1), (?, 'shop', 'takealot.com', 4), (?, 'shop_ok', 'takealot.com', 3), (?, 'country', 'ZA', 5), (?, 'ref', '<img src=x onerror=alert(1)>', 2), (?, 'click', 'share', 2)")
      .run(...Array(10).fill(W.mDay()));
    const jwt = await token({ email: "Owner@Example.com" });
    const r = await get(s, "/", jwt);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-security-policy"), /default-src 'none'/);
    assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow");
    const html = await r.text();
    for (const s2 of ["Visitors", "Page views", "Price checks", "75%", "takealot.com", "South Africa", "Share (opened)", "Check outcomes"]) assert.ok(html.includes(s2), s2);
    assert.ok(!html.includes("<img src=x"), "referrer text is escaped");
    assert.ok(!/<script/i.test(html), "no scripts on the dashboard");
    const d = await (await get(s, "/api/data?days=7", jwt)).json();
    assert.equal(d.days, 7);
    assert.equal(d.totals.pv, 12);
    assert.equal(d.totals.visitors, 5);
    assert.equal(d.totals.ok, 3);
    assert.deepEqual(d.shops[0], { key: "takealot.com", n: 4, ok: 3 });
    assert.equal((await get(s, "/nope", jwt)).status, 404);
    assert.equal((await s.call("https://stats.veldwire.com/", { method: "POST", headers: { "cf-access-jwt-assertion": jwt } })).status, 405);
  });
  test("STATS_ALLOWED_EMAILS overrides the owner address", async (t) => {
    const s = setup(t, { ...ENV, STATS_ALLOWED_EMAILS: "a@example.com, b@example.com" });
    assert.equal((await get(s, "/", await token({ email: "b@example.com" }))).status, 200);
    assert.equal((await get(s, "/", await token())).status, 403);
  });
  test("the signing keys are cached, not fetched on every request", async (t) => {
    const s = setup(t, ENV);
    const before = certCalls, jwt = await token();
    for (let i = 0; i < 5; i++) assert.equal((await get(s, "/", jwt)).status, 200);
    assert.ok(certCalls - before <= 1);
  });
  test("the dev shortcut works only on localhost with STATS_DEV=1", async (t) => {
    const s = setup(t, { STATS_DEV: "1" });
    assert.equal((await s.call("http://127.0.0.1:8787/__stats")).status, 200);
    assert.equal((await s.call("http://localhost:8787/__stats/api/data")).status, 200);
    assert.equal((await s.call("https://eish.veldwire.com/__stats")).status, 404);
    assert.equal((await s.call("http://eish.veldwire.com/__stats", { headers: { "cf-connecting-ip": "127.0.0.1" } })).status, 200, "wrangler dev: route host over http from loopback");
    assert.equal((await s.call("https://eish.veldwire.com/__stats", { headers: { "cf-connecting-ip": "127.0.0.1" } })).status, 404, "https is never the dev server");
    assert.equal((await s.call("http://eish.veldwire.com/__stats", { headers: { "cf-connecting-ip": "203.0.113.9" } })).status, 404, "a real visitor over http");
    assert.equal((await s.call("https://stats.veldwire.com/")).status, 403, "STATS_DEV does not open the real host");
    const s2 = setup(t, {});
    assert.equal((await s2.call("http://127.0.0.1:8787/__stats")).status, 404);
  });
  test("the main site and workers.dev never serve the dashboard", async (t) => {
    const s = setup(t, ENV);
    const jwt = await token();
    for (const u of ["https://eish.veldwire.com/stats", "https://bf-price-check.tm-deal-lab.workers.dev/__stats", "https://eish.veldwire.com/api/data"]) {
      const r = await s.call(u, { headers: { "cf-access-jwt-assertion": jwt } });
      assert.ok(!(await r.text()).includes("Price checks"), u);
    }
  });
});
