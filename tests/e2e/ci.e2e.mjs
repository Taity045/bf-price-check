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
  ok(`home ${name}: result view script is not part of the first view`, await p.evaluate(() => !performance.getEntriesByType("resource").some((e) => /\/result\.[0-9a-f]{10}\.js/.test(e.name))));
  ok(`home ${name}: no JS errors`, p._errs.length === 0, p._errs.join(" | "));
  await p.screenshot({ path: `${SHOTS}/home-${name}.png`, fullPage: true });
  await p.context().close();
});

// 1b. privacy page: short and friendly, on desktop and phone
for (const [name, o] of [["desktop", desktop], ["phone", mobile]]) await step(`privacy ${name}`, async () => {
  const p = await open(o, { fake: false });
  const res = await p.goto(BASE + "/privacy", { waitUntil: "networkidle" });
  const txt = (await p.textContent("#privacyView")).replace(/\s+/g, " ").trim();
  ok(`privacy ${name}: HTTP 200 and visible`, res.status() === 200 && await p.isVisible("#privacyView"), res.status());
  ok(`privacy ${name}: three short lines or fewer, no sub-headings`, (await p.$$("#privacyView li")).length <= 3 && !(await p.$("#privacyView h2")) && txt.length < 400, txt.length);
  ok(`privacy ${name}: says no accounts and no names`, /no accounts, no names/.test(txt), txt);
  ok(`privacy ${name}: no email address shown`, !/@[a-z0-9-]+\.[a-z]/i.test(txt), txt);
  ok(`privacy ${name}: no sideways scroll`, await noSideScroll(p));
  ok(`privacy ${name}: no JS errors`, p._errs.length === 0, p._errs.join(" | "));
  await p.screenshot({ path: `${SHOTS}/privacy-${name}.png`, fullPage: true });
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

// 3b. archive copies that are bot-check or empty pages: the note says so, they are not "no price"
await step("blocked copies", async () => {
  const p = await open(desktop);
  await p.route(/\/api\/check\?/, (r) => r.fulfill({ json: { ...checkAnswer(), history: { ...checkAnswer().history, archive_blocked: 1 } } }));
  await p.route(/\/api\/archive\?/, (r) => r.fulfill({ json: { status: "ok", captures_12mo: 3, sampled: 3, pending: [{ ts: "20260101120000", orig: PRODUCT }, { ts: "20260201120000", orig: PRODUCT }] } }));
  await p.route(/\/api\/snap\?/, (r) => r.fulfill({ json: /20260101/.test(r.request().url()) ? { status: "blocked", reason: "bot-page" } : { status: "noprice" } }));
  await p.goto(BASE + "/");
  await p.fill("#u", PRODUCT); await p.click("#go");
  // wait for both archive copies (the note says "bot-check" after the first one already)
  await p.waitForFunction(() => /had no price/.test(document.getElementById("archnote").textContent) && /bot-check/.test(document.getElementById("archnote").textContent), null, { timeout: 15000 }).catch(() => {});
  const note = await p.textContent("#archnote");
  ok("blocked: archive note counts bot-check or empty pages apart from 'no price'", /1 had no price we could read\. 2 were bot-check pages or empty pages, not the product page\./.test(note), note);
  ok("blocked: no JS errors", p._errs.length === 0, p._errs.join(" | "));
  await p.context().close();
});

// 3a. one older price from a Common Crawl web archive copy (answer faked): evidence verdict with its source link
await step("common crawl evidence", async () => {
  const p = await open(desktop);
  const CC = "https://www.dunelm.com/product/teddy-bear-throw-1000162540";
  const link = "https://index.commoncrawl.org/CC-MAIN-2026-30-index?url=" + encodeURIComponent(CC) + "&output=json";
  await p.route(/\/api\/check\?/, (r) => r.fulfill({ json: { ...checkAnswer(), url: CC, canonical: CC, host: "dunelm.com", tld_currency: null, shop: { name: "Dunelm" },
    current: { status: "ok", checked_at: Date.now(), price: 85, was: 140, currency: "GBP", title: "CI Teddy Throw", source: "json-ld" },
    history: { archive: [], archive_failed: 0, checks: [], cc: [{ t: Date.now() - 120 * DAY, price: 85, was: null, currency: "GBP", url: CC, link }] } } }));
  await p.goto(BASE + "/");
  await p.fill("#u", CC); await p.click("#go");
  await p.waitForSelector("#result:not(.hidden)", { timeout: 15000 });
  await p.waitForTimeout(500);
  const v = await p.textContent("#verdict");
  ok("cc: inflated 'was' price verdict from one archive price", /Likely inflated was price/.test(v), v);
  ok("cc: verdict names the source", /web archive copy \(Common Crawl\)/.test(v), v);
  const href = await p.getAttribute("#verdict a[href*='commoncrawl']", "href");
  ok("cc: source links to Common Crawl's index record", href === link, href);
  await p.click("#pts summary").catch(() => {});
  ok("cc: price table lists the Common Crawl copy", /Common Crawl/.test(await p.textContent("#ptable")), await p.textContent("#ptable"));
  ok("cc: archive note counts it", /Common Crawl web archive: 1 older price/.test(await p.textContent("#archnote")), await p.textContent("#archnote"));
  ok("cc: no JS errors", p._errs.length === 0, p._errs.join(" | "));
  await p.screenshot({ path: `${SHOTS}/result-common-crawl.png`, fullPage: true });
  await p.context().close();
});

// 3b. "Other shops" compare panel, with faked shop answers (arriving one by one)
const CMP_PLAN = { product: { title: "CI Test Kettle 1.7L", brand: "ci", gtin: "6001234567890", codes: [], currency: "ZAR", category: "appliances" },
  shops: [{ id: "hirschs", name: "Hirsch's" }, { id: "okfurniture", name: "OK Furniture" }, { id: "loot", name: "Loot" }, { id: "computermania", name: "Computer Mania" }, { id: "firstshop", name: "First Shop" }],
  skipped: [], results: { loot: { shop: "loot", name: "Loot", status: "none", checked_at: Date.now() - 3600e3 } } };
const CMP_SHOP = {
  hirschs: { shop: "hirschs", name: "Hirsch's", status: "match", checked_at: Date.now(), match: { title: "CI Test Kettle 1.7L Stainless - CTK17", price: 899, was: 1099, currency: "ZAR", url: "https://shop.example.co.za/hirschs-kettle", in_stock: true, level: "model" } },
  okfurniture: { shop: "okfurniture", name: "OK Furniture", status: "match", checked_at: Date.now(), match: { title: "CI Test Kettle 1.7L", price: 949, currency: "ZAR", url: "https://shop.example.co.za/ok-kettle", in_stock: true, level: "barcode" } },
  computermania: { shop: "computermania", name: "Computer Mania", status: "match", checked_at: Date.now(), match: { title: "CI Test Kettle 1.7L <b>bold</b>", price: 799, currency: "ZAR", url: "https://shop.example.co.za/cm-kettle", in_stock: false, level: "name" } },
  firstshop: { shop: "firstshop", name: "First Shop", status: "blocked", checked_at: Date.now() },
};
for (const [name, o] of [["desktop", desktop], ["phone", mobile], ["1440", { viewport: { width: 1440, height: 900 } }], ["390", { ...mobile, viewport: { width: 390, height: 844 } }]]) await step(`compare ${name}`, async () => {
  const p = await open(o);
  await p.route(/\/api\/compare\?/, (r) => r.fulfill({ json: CMP_PLAN }));
  let n = 0;
  await p.route(/\/api\/compare\/shop\?/, async (r) => { const id = new URL(r.request().url()).searchParams.get("shop"); await new Promise((ok) => setTimeout(ok, 150 * ++n)); r.fulfill({ json: CMP_SHOP[id] }); });
  await p.goto(BASE + "/");
  await p.fill("#u", PRODUCT); await p.click("#go");
  await p.waitForSelector("#others:not(.hidden)", { timeout: 15000 });
  const tops = () => p.evaluate(() => ({ chart: document.querySelector("#chart").getBoundingClientRect().top + scrollY, actions: document.querySelector(".actions").getBoundingClientRect().top + scrollY, verdict: document.querySelector("#verdict").getBoundingClientRect().top + scrollY }));
  const before = await tops();
  ok(`compare ${name}: shows progress while shops answer`, /of 5 shops checked/.test(await p.textContent("#cmpStatus")), await p.textContent("#cmpStatus"));
  await p.waitForFunction(() => /5 shops checked/.test(document.querySelector("#cmpStatus").textContent) && !/of/.test(document.querySelector("#cmpStatus").textContent), null, { timeout: 10000 });
  const after = await tops();
  // up to 1 px: sub-pixel rounding on CI (seen once: 1351.875 -> 1352.875); a real push is a row height (40+ px)
  ok(`compare ${name}: chart and buttons do not move while shop rows load (within 1 px)`, Math.abs(before.chart - after.chart) <= 1 && Math.abs(before.actions - after.actions) <= 1, JSON.stringify({ before, after }));
  ok(`compare ${name}: verdict does not move when the headline fills in (within 1 px)`, Math.abs(before.verdict - after.verdict) <= 1, JSON.stringify({ before, after }));
  const head = (await p.textContent("#cmpHead")).replace(/\u00a0/g, " ").replace(/\s+/g, " ");
  ok(`compare ${name}: headline names the cheaper shop and the saving`, /Cheaper at Hirsch's: R ?899/.test(head) && /Save R ?100 \(10%\)/.test(head) && /Same model number as this product/.test(head), head);
  ok(`compare ${name}: headline is above the verdict`, await p.evaluate(() => document.querySelector("#cmpHead").getBoundingClientRect().bottom <= document.querySelector("#verdict").getBoundingClientRect().top));
  ok(`compare ${name}: out-of-stock cheaper shop is not the headline`, !/Computer Mania/.test(head), head);
  ok(`compare ${name}: other shops is below the chart`, (await p.evaluate(() => document.querySelector("#others").getBoundingClientRect().top > document.querySelector("#chart").getBoundingClientRect().bottom)));
  const rows = await p.$$eval("#otherList li", (ls) => ls.map((l) => l.textContent.replace(/\s+/g, " ").trim()));
  ok(`compare ${name}: this page plus 3 matches`, rows.length === 4, rows.join(" | "));
  ok(`compare ${name}: this page first`, /This page/.test(rows[0]), rows[0]);
  ok(`compare ${name}: cheapest in-stock shop marked (Hirsch's, not the out-of-stock one)`, /Hirsch/.test(rows[1]) && /Cheapest/.test(rows[1]) && !rows.slice(2).some((r) => /Cheapest/.test(r)), rows.join(" | "));
  ok(`compare ${name}: saving shown against this page`, /R\s?100 less/.test(rows[1].replace(/\u00a0/g, " ")), rows[1]);
  ok(`compare ${name}: match levels shown`, /Same model number/.test(rows[1]) && /Same barcode/.test(rows[2]) && /Same name and specs/.test(rows[3]), rows.join(" | "));
  ok(`compare ${name}: out of stock is labelled and listed last, with no saving shown`, /Out of stock/.test(rows[3]) && /Computer Mania/.test(rows[3]) && !/less/.test(rows[3]), rows[3]);
  ok(`compare ${name}: shop titles are escaped`, (await p.$$eval("#otherList b", (b) => b.length)) < 20 && /<b>bold<\/b>/.test(rows[3]), rows[3]);
  const sum = await p.textContent("#cmpSum");
  ok(`compare ${name}: not found and couldn't check are listed`, /Not found at: Loot/.test(sum) && /Couldn't check: First Shop/.test(sum), sum);
  const link = await p.getAttribute("#otherList li:nth-child(2) a", "href");
  ok(`compare ${name}: link opens the shop's page`, link === "https://shop.example.co.za/hirschs-kettle", link);
  ok(`compare ${name}: no sideways scroll`, await noSideScroll(p));
  ok(`compare ${name}: no JS errors`, p._errs.length === 0, p._errs.join(" | "));
  await p.waitForFunction(() => !document.querySelector(".toast.on, .toast.show"), null, { timeout: 6000 }).catch(() => {});
  await p.waitForTimeout(3500);
  await p.locator("#others").screenshot({ path: `${SHOTS}/compare-${name}.png` });
  await p.locator("#cmpHead").screenshot({ path: `${SHOTS}/headline-${name}.png` });
  await p.context().close();
});
for (const [name, o] of [["1440", { viewport: { width: 1440, height: 900 } }], ["390", { ...mobile, viewport: { width: 390, height: 844 } }]]) await step(`compare tie ${name}`, async () => {
  const p = await open(o);
  const tie = { okfurniture: { ...CMP_SHOP.okfurniture, match: { ...CMP_SHOP.okfurniture.match, price: 999 } }, hirschs: { ...CMP_SHOP.hirschs, match: { ...CMP_SHOP.hirschs.match, price: 1099, was: null } } };
  await p.route(/\/api\/compare\?/, (r) => r.fulfill({ json: { ...CMP_PLAN, shops: CMP_PLAN.shops.filter((x) => tie[x.id]), results: {} } }));
  await p.route(/\/api\/compare\/shop\?/, (r) => r.fulfill({ json: tie[new URL(r.request().url()).searchParams.get("shop")] }));
  await p.goto(BASE + "/");
  await p.fill("#u", PRODUCT); await p.click("#go");
  // wait until both shops answered (a "Checking 1 more shop…" placeholder row also counts as a list item)
  await p.waitForFunction(() => /2 shops checked/.test(document.querySelector("#cmpStatus").textContent) && !/ of /.test(document.querySelector("#cmpStatus").textContent) && document.querySelectorAll("#otherList li").length === 3, null, { timeout: 10000 });
  const rows = await p.$$eval("#otherList li", (ls) => ls.map((l) => l.textContent.replace(/\s+/g, " ").trim()));
  ok(`compare tie ${name}: this page and the shop at the same price are both tagged`, /Same lowest price/.test(rows[0]) && /OK Furniture/.test(rows[1]) && /Same lowest price/.test(rows[1]) && /Same price/.test(rows[1]), rows.join(" | "));
  ok(`compare tie ${name}: the dearer shop is not tagged`, !/Cheapest|Same lowest/.test(rows[2]), rows[2]);
  const head = (await p.textContent("#cmpHead")).replace(/\s+/g, " ");
  ok(`compare tie ${name}: headline says no cheaper exact match, and how many sell it`, /No cheaper exact match found/.test(head) && /We checked 2 shops\. 2 sell the exact same product, but not for less\./.test(head), head);
  await p.locator("#cmpHead").screenshot({ path: `${SHOTS}/headline-none-${name}.png` });
  await p.locator("#others").screenshot({ path: `${SHOTS}/compare-tie-${name}.png` });
  await p.context().close();
});
// groceries: member price as a note, "Same name and size", and the shops we can't search (with why)
const GROC_PLAN = { product: { title: "CI Instant Coffee 200g", brand: "ci", gtin: "6001234567890", codes: [], currency: "ZAR", category: "groceries" },
  noun: "groceries and toiletries", shopNoun: null, specialists: 2,
  shops: [{ id: "pnp", name: "Pick n Pay" }, { id: "clicks", name: "Clicks" }, { id: "takealot", name: "Takealot", general: true }], skipped: [], results: {},
  notSearched: [{ name: "Woolworths", why: "robots" }, { name: "Checkers", why: "browser" }, { name: "Shoprite", why: "browser" }, { name: "Makro", why: "blocks" }] };
const GROC_SHOP = {
  pnp: { shop: "pnp", name: "Pick n Pay", status: "match", checked_at: Date.now(), match: { title: "CI Instant Coffee 200g", price: 209.99, currency: "ZAR", url: "https://shop.example.co.za/pnp-coffee", in_stock: true, level: "barcode", member: { label: "Smart Shopper price", price: 129 } } },
  takealot: { shop: "takealot", name: "Takealot", status: "none", checked_at: Date.now() },
  clicks: { shop: "clicks", name: "Clicks", status: "match", checked_at: Date.now(), match: { title: "CI Instant Coffee Jar 200g", price: 199.95, currency: "ZAR", url: "https://shop.example.co.za/clicks-coffee", in_stock: true, level: "name" } },
};
for (const [name, o] of [["1440", { viewport: { width: 1440, height: 900 } }], ["390", { ...mobile, viewport: { width: 390, height: 844 } }]]) await step(`compare groceries ${name}`, async () => {
  const p = await open(o);
  await p.route(/\/api\/compare\?/, (r) => r.fulfill({ json: GROC_PLAN }));
  await p.route(/\/api\/compare\/shop\?/, (r) => r.fulfill({ json: GROC_SHOP[new URL(r.request().url()).searchParams.get("shop")] }));
  await p.goto(BASE + "/");
  await p.fill("#u", PRODUCT); await p.click("#go");
  await p.waitForFunction(() => /3 shops checked/.test(document.querySelector("#cmpStatus").textContent) && !/ of /.test(document.querySelector("#cmpStatus").textContent), null, { timeout: 10000 });
  const rows = await p.$$eval("#otherList li", (ls) => ls.map((l) => l.textContent.replace(/\s+/g, " ").replace(/\u00a0/g, " ").trim()));
  const pnp = rows.find((r) => /Pick n Pay/.test(r)) || "", clicks = rows.find((r) => /Clicks/.test(r)) || "";
  ok(`compare groceries ${name}: shelf price shown, member price only as a note`, /R\s?209[.,]99/.test(pnp) && /Smart Shopper price R\s?129/.test(pnp), pnp);
  ok(`compare groceries ${name}: name match says "Same name and size"`, /Same name and size/.test(clicks), clicks);
  const sum = await p.textContent("#cmpSum");
  ok(`compare groceries ${name}: names the shops checked`, /Checked 2 shops that sell groceries and toiletries \(Pick n Pay, Clicks\) and 1 general shop \(Takealot\)\./.test(sum), sum);
  ok(`compare groceries ${name}: names the shops we can't search, and why`, /We can't search Woolworths \(ask tools not to use their search\); Checkers and Shoprite \(show search results only in a browser\); Makro \(block tools like ours\)\./.test(sum), sum);
  ok(`compare groceries ${name}: no sideways scroll`, await noSideScroll(p));
  ok(`compare groceries ${name}: no JS errors`, p._errs.length === 0, p._errs.join(" | "));
  await p.locator("#others").screenshot({ path: `${SHOTS}/compare-groceries-${name}.png` });
  await p.context().close();
});
await step("compare: own brand", async () => {
  const p = await open(mobile);
  await p.route(/\/api\/compare\?/, (r) => r.fulfill({ json: { ...GROC_PLAN, shops: [], reason: "own brand", ownBrand: true } }));
  await p.goto(BASE + "/");
  await p.fill("#u", PRODUCT); await p.click("#go");
  await p.waitForSelector("#others:not(.hidden)", { timeout: 15000 });
  const sum = await p.textContent("#cmpSum");
  ok("compare: own brand is said, and not compared", /shop's own brand\. Other shops don't sell it/.test(sum), sum);
  await p.context().close();
});
await step("compare: nothing found", async () => {
  const p = await open(mobile);
  const bikes = { ...CMP_PLAN, product: { ...CMP_PLAN.product, category: "cycling" }, noun: "bikes and cycling gear", shopNoun: "bike shop", specialists: 2,
    shops: [{ id: "olympiccycles", name: "Olympic Cycles" }, { id: "mellowvelo", name: "Mellow Velo" }, { id: "takealot", name: "Takealot", general: true }], results: {} };
  await p.route(/\/api\/compare\?/, (r) => r.fulfill({ json: bikes }));
  await p.route(/\/api\/compare\/shop\?/, (r) => r.fulfill({ json: { status: "none", checked_at: Date.now() } }));
  await p.goto(BASE + "/");
  await p.fill("#u", PRODUCT); await p.click("#go");
  await p.waitForFunction(() => /No exact match/.test(document.querySelector("#cmpSum").textContent), null, { timeout: 10000 });
  const sum = await p.textContent("#cmpSum");
  ok("compare: names the kind of shops and each shop checked", /Checked 2 bike shops \(Olympic Cycles, Mellow Velo\) and 1 general shop \(Takealot\)\./.test(sum), sum);
  ok("compare: says plainly when no shop has the same product", /No exact match at any of them\./.test(sum), sum);
  await p.context().close();
});
await step("compare: no shops known for this kind of product", async () => {
  const p = await open(mobile);
  await p.route(/\/api\/compare\?/, (r) => r.fulfill({ json: { ...CMP_PLAN, product: { ...CMP_PLAN.product, category: "toys" }, noun: "toys", specialists: 0, shops: [], results: {}, reason: "no shops" } }));
  await p.goto(BASE + "/");
  await p.fill("#u", PRODUCT); await p.click("#go");
  await p.waitForFunction(() => /didn't compare/.test(document.querySelector("#cmpSum").textContent), null, { timeout: 10000 });
  const sum = await p.textContent("#cmpSum");
  ok("compare: says briefly when we know no shops for the kind of product", /We don't know other shops here that sell toys yet/.test(sum) && !/searched|checked \d/.test(sum), sum);
  await p.context().close();
});

// 3c. A shared result link (?u=) must not move the page while the result and other shops load (CLS)
for (const [name, o] of [["1440", { viewport: { width: 1440, height: 900 } }], ["1280", desktop], ["390", { ...mobile, viewport: { width: 390, height: 844 } }], ["360", mobile]]) await step(`shared link CLS ${name}`, async () => {
  const p = await open(o);
  await p.route(/\/api\/check\?/, async (r) => { await new Promise((ok) => setTimeout(ok, 700)); r.fulfill({ json: checkAnswer() }); });
  await p.route(/\/api\/compare\?/, (r) => r.fulfill({ json: CMP_PLAN }));
  await p.route(/\/api\/compare\/shop\?/, async (r) => { await new Promise((ok) => setTimeout(ok, 300)); r.fulfill({ json: CMP_SHOP[new URL(r.request().url()).searchParams.get("shop")] }); });
  await p.addInitScript(() => { window.__cls = 0; window.__src = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) { window.__cls += e.value; window.__src.push((e.sources || []).map((x) => x.node && (x.node.id || x.node.nodeName)).join(",") + ":" + e.value.toFixed(3)); } }).observe({ type: "layout-shift", buffered: true }); });
  await p.goto(BASE + "/?u=" + encodeURIComponent(PRODUCT));
  await p.waitForFunction(() => /shops checked/.test(document.querySelector("#cmpStatus")?.textContent || "") && !/ of /.test(document.querySelector("#cmpStatus").textContent), null, { timeout: 15000 });
  await p.waitForTimeout(800);
  const cls = await p.evaluate(() => window.__cls), src = await p.evaluate(() => window.__src);
  ok(`shared link CLS ${name}: layout shift under 0.02 while the result and other shops load`, cls < 0.02, cls.toFixed(4) + " " + src.join(" | "));
  ok(`shared link CLS ${name}: no JS errors`, p._errs.length === 0, p._errs.join(" | "));
  await p.context().close();
});

// 3d. The home page must not move when the example links fill in (they wrap to two lines on phones)
for (const [name, o] of [["1440", { viewport: { width: 1440, height: 900 } }], ["412", { ...mobile, viewport: { width: 412, height: 823 } }], ["360", mobile]]) await step(`home CLS ${name}`, async () => {
  const p = await open(o, { fake: false });
  await p.addInitScript(() => { window.__cls = 0; window.__src = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) { window.__cls += e.value; window.__src.push((e.sources || []).map((x) => x.node && (x.node.id || x.node.nodeName)).join(",") + ":" + e.value.toFixed(3)); } }).observe({ type: "layout-shift", buffered: true }); });
  await p.goto(BASE + "/", { waitUntil: "networkidle" });
  await p.waitForTimeout(800);
  const cls = await p.evaluate(() => window.__cls), src = await p.evaluate(() => window.__src);
  ok(`home CLS ${name}: layout shift under 0.02 while the page loads`, cls < 0.02, cls.toFixed(4) + " " + src.join(" | "));
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
  ok("shops list says how much price history each shop has", (await p.$$eval("#shoplist li > span:first-child .small", (x) => x.length)) === (await p.$$eval("#shoplist li", (x) => x.length)) && /Price history: (good|some)|History is building up/.test(list), list.slice(0, 300));
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
  const old = await fetch(BASE + "/result.0123456789.js");
  ok("old result script names still load after a deploy, not cached", old.ok && /no-cache/.test(old.headers.get("cache-control")), old.status);
  const home = await (await fetch(BASE + "/")).text(), app = (home.match(/\/app\.[0-9a-f]{10}\.js/) || [""])[0];
  const lazy = ((await (await fetch(BASE + app)).text()).match(/\/result\.[0-9a-f]{10}\.js/) || [""])[0];
  const lr = lazy ? await fetch(BASE + lazy) : null;
  ok("result script is served and cached for a year", !!lr && lr.ok && /immutable/.test(lr.headers.get("cache-control")) && /__dod/.test(await lr.text()), lazy);
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
  if (KEY) {
    const pr = await (await fetch(BASE + "/api/e2e/stats-probe", { method: "POST", headers: H })).json();
    const again = await data();
    ok("stats probe counts a visit and removes it again", pr.page_view_counted && pr.visitor_counted && pr.removed_again && again.totals.pv === after.totals.pv, JSON.stringify(pr));
  }
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
