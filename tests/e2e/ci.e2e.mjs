// Browser tests for CI. Runs against a local `wrangler dev` (or any BASE) with no traffic to shops:
// price-check answers are faked in the browser, everything else (pages, forms, D1) is the real worker.
// Usage: node tests/e2e/ci.e2e.mjs [BASE]      env: CHROME=/path/to/chrome  SHOTS=dir  HOME_BUDGET=bytes
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const BASE = (process.argv[2] || process.env.BASE || "http://127.0.0.1:8787").replace(/\/$/, "");
const SHOTS = process.env.SHOTS || "e2e-artifacts";
const HOME_BUDGET = Number(process.env.HOME_BUDGET || 100 * 1024); // bytes for the first view (HTML, JS, CSS, fonts)
mkdirSync(SHOTS, { recursive: true });

const results = [];
const ok = (name, pass, info = "") => { results.push({ name, pass: !!pass, info }); console.log(`${pass ? "PASS" : "FAIL"} ${name}${info && !pass ? " — " + String(info).slice(0, 300) : ""}`); };
const desktop = { viewport: { width: 1280, height: 800 } };
const mobile = { viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36" };

const PRODUCT = "https://www.takealot.com/test-kettle/PLID00000001";
const SHOP_PAGE = "https://shop.example.co.za/product/123";
const DAY = 864e5;
// With E2E_KEY (same value as the worker's), form requests skip the rate limit and Turnstile and are marked as tests.
const KEY = process.env.E2E_KEY || "";
const SHOP_PREFIX = KEY ? "e2e-test-" : "";
const checkAnswer = () => ({
  url: PRODUCT, canonical: PRODUCT, host: "takealot.com", tld_currency: "ZAR", cached: false, tracked: true,
  current: { status: "ok", checked_at: Date.now(), price: 999, was: 1499, currency: "ZAR", title: "CI Test Kettle 1.7L", source: "takealot-api" },
  history: { archive: [], archive_failed: 0, checks: [60, 40, 20, 10].map((d, i) => ({ t: Date.now() - d * DAY, price: [1299, 1249, 1299, 1199][i], was: null, currency: "ZAR" })) },
  history_days: 365, verdict: null, ids: { gtin: null, mpn: null }, shop: { name: "Takealot" }, blocked_shop: null,
});
async function fakeChecks(p) {
  await p.route(/\/api\/check\?/, (r) => r.fulfill({ json: checkAnswer() }));
  await p.route(/\/api\/archive\?/, (r) => r.fulfill({ json: { status: "ok", captures_12mo: 0, sampled: 0, pending: [] } }));
  await p.route(/\/api\/verdict\?/, (r) => r.fulfill({ json: {} }));
  await p.route(/\/api\/others\?/, (r) => r.fulfill({ json: { matches: [] } }));
}

const browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
async function open(opts, { fake = true } = {}) {
  const ctx = await browser.newContext({ ...opts, extraHTTPHeaders: KEY ? { "x-e2e-key": KEY } : {} });
  const p = await ctx.newPage();
  p._errs = [];
  p.on("pageerror", (e) => p._errs.push(String(e)));
  p.on("console", (m) => { if (m.type() === "error" && !/challenges\.cloudflare|Failed to load resource/.test(m.text())) p._errs.push(m.text()); });
  // never talk to third parties from CI
  await p.route((u) => !u.href.startsWith(BASE) && !u.href.startsWith("https://shop.example.co.za/"), (r) => r.abort());
  if (fake) await fakeChecks(p);
  return p;
}
const noSideScroll = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const inView = (p, sel) => p.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return r.width > 0 && r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1; }, sel);
async function step(name, fn) {
  try { await fn(); } catch (e) { ok(name + " (no crash)", false, (e && e.stack) || e); }
}

// 1. home page on desktop and phone, plus page weight
for (const [name, o] of [["desktop", desktop], ["phone", mobile]]) await step(`home ${name}`, async () => {
  const p = await open(o, { fake: false });
  const res = await p.goto(BASE + "/", { waitUntil: "networkidle" });
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(300);
  // uncompressed size of everything the page loaded from the site
  const bytes = await p.evaluate(() => [...performance.getEntriesByType("navigation"), ...performance.getEntriesByType("resource")]
    .filter((e) => e.name.startsWith(location.origin)).reduce((n, e) => n + (e.decodedBodySize || 0), 0));
  ok(`home ${name}: HTTP 200`, res.status() === 200, res.status());
  ok(`home ${name}: title`, (await p.title()).includes("Deal or Dud"), await p.title());
  ok(`home ${name}: heading`, (await p.textContent("h1")).trim().length > 10);
  ok(`home ${name}: no sideways scroll`, await noSideScroll(p));
  ok(`home ${name}: fake discount wall link hidden`, !(await p.isVisible("#wallLink")));
  ok(`home ${name}: page weight ${Math.round(bytes / 1024)} KB within ${Math.round(HOME_BUDGET / 1024)} KB`, bytes > 0 && bytes <= HOME_BUDGET, bytes);
  ok(`home ${name}: no JS errors`, p._errs.length === 0, p._errs.join(" | "));
  await p.screenshot({ path: `${SHOTS}/home-${name}.png`, fullPage: true });
  await p.context().close();
});

// 2. link box errors (checked in the page, before any request)
await step("link box errors", async () => {
  const p = await open(mobile);
  await p.goto(BASE + "/");
  await p.click("#go");
  ok("empty link shows an error", (await p.textContent("#error")).includes("Paste a product link"), await p.textContent("#error"));
  await p.fill("#u", "hello there"); await p.click("#go");
  ok("text that is not a link shows an error", /doesn.t look like/.test(await p.textContent("#error")), await p.textContent("#error"));
  await p.context().close();
});

// 3. a price check shows a result and a verdict (answer faked)
for (const [name, o] of [["desktop", desktop], ["phone", mobile]]) await step(`result ${name}`, async () => {
  const p = await open(o);
  await p.goto(BASE + "/");
  await p.fill("#u", PRODUCT); await p.click("#go");
  await p.waitForSelector("#result:not(.hidden)", { timeout: 15000 });
  await p.waitForTimeout(500);
  ok(`result ${name}: product title shown`, (await p.textContent("#ptitle")).includes("CI Test Kettle"), await p.textContent("#ptitle"));
  ok(`result ${name}: price shown`, /999/.test((await p.textContent("#prices")).replace(/[\s\u00a0,]/g, "")), await p.textContent("#prices"));
  ok(`result ${name}: verdict shown`, (await p.textContent("#verdict")).trim().length > 0, await p.textContent("#verdict"));
  ok(`result ${name}: address bar has ?u=`, new URL(p.url()).searchParams.get("u") === PRODUCT, p.url());
  ok(`result ${name}: no sideways scroll`, await noSideScroll(p));
  ok(`result ${name}: no JS errors`, p._errs.length === 0, p._errs.join(" | "));
  await p.screenshot({ path: `${SHOTS}/result-${name}.png`, fullPage: true });
  await p.context().close();
});

// 4. "Ask us to add a shop" form, sent to the real worker and local D1
for (const [name, o] of [["desktop", desktop], ["phone", mobile]]) await step(`shop request ${name}`, async () => {
  const p = await open(o);
  await p.goto(BASE + "/");
  await p.click("#askBtn");
  await p.waitForSelector("#reqDlg[open]");
  ok(`shop request ${name}: form opens`, await p.isVisible("#rShop"));
  ok(`shop request ${name}: send button fits on screen`, await inView(p, "#rSend"));
  await p.fill("#rShop", "x"); await p.click("#rSend");
  ok(`shop request ${name}: too-short name is refused`, /shop name/.test(await p.textContent("#rMsg")), await p.textContent("#rMsg"));
  await p.fill("#rShop", `${SHOP_PREFIX}ci-${name}.example.co.za`); await p.fill("#rEmail", "not-an-email"); await p.click("#rSend");
  ok(`shop request ${name}: bad email is refused`, /email/.test(await p.textContent("#rMsg")), await p.textContent("#rMsg"));
  await p.fill("#rEmail", "");
  const [resp] = await Promise.all([p.waitForResponse((r) => r.url().endsWith("/api/request")), p.click("#rSend")]);
  ok(`shop request ${name}: server accepts it`, resp.status() === 200, resp.status() + " " + (await resp.text()));
  await p.waitForFunction(() => /Thank you/.test(document.getElementById("rMsg").textContent), null, { timeout: 5000 }).catch(() => {});
  ok(`shop request ${name}: thank-you message`, /Thank you/.test(await p.textContent("#rMsg")), await p.textContent("#rMsg"));
  ok(`shop request ${name}: no JS errors`, p._errs.length === 0, p._errs.join(" | "));
  await p.screenshot({ path: `${SHOTS}/request-${name}.png` });
  await p.context().close();
});

// 5. no bookmark feature; a ?url= link (used by shares) starts a check
await step("?url= link", async () => {
  const p = await open(desktop);
  await p.goto(BASE + "/");
  ok("no bookmark button", !(await p.$("#bmBtn")) && !(await p.$("#bmDlg")));
  await p.goto(BASE + "/?url=" + encodeURIComponent(SHOP_PAGE));
  await p.waitForSelector("#result:not(.hidden)", { timeout: 15000 }).catch(() => {});
  ok("?url= link starts a price check", await p.isVisible("#result"));
  ok("?url= link: no JS errors", p._errs.length === 0, p._errs.join(" | "));
  await p.context().close();
});

// 6. shops list and hidden wall
await step("shops list", async () => {
  const p = await open(desktop);
  await p.goto(BASE + "/");
  await p.click("#shopsBtn");
  await p.waitForFunction(() => document.querySelectorAll("#shoplist li").length > 5, null, { timeout: 5000 });
  const list = await p.textContent("#shoplist");
  ok("shops list has Takealot and no Amazon", /Takealot/.test(list) && !/Amazon/.test(list), list.slice(0, 200));
  await p.goto(BASE + "/wall");
  ok("/wall goes to the home page while the wall is off", new URL(p.url()).pathname === "/", p.url());
  await p.context().close();
});

// 7. API answers without a browser
await step("API", async () => {
  const UA = { "user-agent": "Mozilla/5.0 (CI)" };
  const bad = await fetch(BASE + "/api/check?url=" + encodeURIComponent("http://127.0.0.1/admin"), { headers: UA });
  ok("/api/check refuses a private address with 400", bad.status === 400, bad.status);
  const bot = await fetch(BASE + "/api/check?url=" + encodeURIComponent(PRODUCT), { headers: { "user-agent": "python-requests/2.31" } });
  ok("/api/check refuses scraper user agents with 403", bot.status === 403, bot.status);
  const form = await fetch(BASE + "/api/request", { method: "POST", headers: { ...UA, "content-type": "application/json" }, body: JSON.stringify({ shop: "" }) });
  ok("/api/request refuses an empty shop with 400", form.status === 400, form.status);
  const wall = await fetch(BASE + "/api/wall");
  ok("/api/wall is off", wall.status === 404, wall.status);
  const js = await fetch(BASE + "/app.0123456789.js");
  ok("old script names still load after a deploy", js.ok && /javascript/.test(js.headers.get("content-type")), js.status);
});

// 8. private stats: counting works end to end, and the dashboard renders (local dev shortcut /__stats,
// which needs STATS_DEV=1 and localhost; the real host is protected by Cloudflare Access).
await step("stats", async () => {
  const H = KEY ? { "x-e2e-key": KEY } : {};
  const data = async () => { const r = await fetch(BASE + "/__stats/api/data?days=7", { headers: H }); return r.ok ? r.json() : { status: r.status }; };
  const sum = (d, k) => (d.clicks || []).filter((c) => c.key === k).reduce((a, c) => a + c.n, 0);
  const before = await data();
  ok("stats data answers on the local dev shortcut", before.totals, JSON.stringify(before));
  if (!before.totals) return;
  const desktopUA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
  const p = await open({ ...desktop, userAgent: desktopUA }, { fake: false });
  await p.goto(BASE + "/", { waitUntil: "networkidle" });
  await p.click("#shopsBtn");
  await p.waitForTimeout(800);
  await p.context().close();
  await fetch(BASE + "/api/check?url=notaurl", { headers: { ...H, "user-agent": desktopUA } });
  await fetch(BASE + "/", { headers: { ...H, "user-agent": "WhatsApp/2.23.20.0" } });
  let after = before;
  for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 250)); after = await data(); if (after.totals.pv > before.totals.pv && sum(after, "shops_open") > sum(before, "shops_open")) break; }
  ok("a page view is counted", after.totals.pv === before.totals.pv + 1, `${before.totals.pv} -> ${after.totals.pv}`);
  ok("a visitor is counted", after.totals.visitors >= 1, after.totals.visitors);
  ok("a button click is counted (sendBeacon)", sum(after, "shops_open") === sum(before, "shops_open") + 1);
  const inv = (d) => (d.outcomes.find((o) => o.key === "invalid") || {}).n || 0;
  ok("a refused check is counted", inv(after) === inv(before) + 1);
  ok("a link-preview bot is counted as a bot, not a visit", after.totals.bot === before.totals.bot + 1, `${before.totals.bot} -> ${after.totals.bot}`);
  for (const [name, o, scheme] of [["desktop", desktop, "light"], ["phone", mobile, "light"], ["desktop dark", desktop, "dark"]]) {
    const q = await open({ ...o, colorScheme: scheme }, { fake: false });
    const res = await q.goto(BASE + "/__stats/?days=30", { waitUntil: "load" });
    ok(`stats dashboard ${name} loads`, res.status() === 200, res.status());
    ok(`stats dashboard ${name} has the charts`, (await q.locator("svg[role=img]").count()) === 1 && (await q.locator("h2").count()) >= 7);
    ok(`stats dashboard ${name} has no side scroll`, await noSideScroll(q));
    ok(`stats dashboard ${name} has no errors`, q._errs.length === 0, q._errs.join(" | "));
    const size = (await res.body()).length;
    ok(`stats dashboard ${name} is small (< 60 KB)`, size < 60 * 1024, size);
    await q.screenshot({ path: `${SHOTS}/stats-${name.replace(" ", "-")}.png`, fullPage: true });
    await q.context().close();
  }
});

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
if (failed.length) { console.log("Failed:\n" + failed.map((f) => " - " + f.name + (f.info ? ": " + String(f.info).slice(0, 300) : "")).join("\n")); process.exit(1); }
