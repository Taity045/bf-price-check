// End-to-end check of the UI. Usage: node tests/e2e_redesign.mjs [BASE] [SHOTDIR]
import { chromium } from "playwright-core";
const BASE = process.argv[2] || "https://bf-price-check.tm-deal-lab.workers.dev";
const OUT = process.argv[3] || "screenshots";
const exe = process.env.CHROME || "/usr/bin/google-chrome";
const results = []; const ok = (name, pass, info = "") => { results.push({ name, pass, info }); console.log((pass ? "PASS " : "FAIL ") + name + (info ? " — " + info : "")); };
import fs from "fs";
const KEY = process.env.E2E_KEY || (fs.existsSync("/workspace/bf-secrets/e2e_key") ? fs.readFileSync("/workspace/bf-secrets/e2e_key", "utf8").trim() : "");
const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
async function page(opts) {
  const ctx = await browser.newContext(opts);
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  const p = await ctx.newPage(); p._errs = [];
  p.on("pageerror", (e) => p._errs.push(String(e))); p.on("console", (m) => { if (m.type() === "error") p._errs.push(m.text()); });
  return p;
}
const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" };
const desktop = { viewport: { width: 1280, height: 900 } };
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const waitArchive = (p) => p.waitForFunction(() => { const t = document.getElementById("progtxt").textContent; return !/Looking|Reading archived copies…/.test(t); }, null, { timeout: 90000 });
const pointCount = (p) => p.evaluate(() => document.querySelectorAll("#chart circle[data-i]").length);

// 1. home pages
for (const [name, o] of [["desktop", desktop], ["mobile", mobile]]) {
  const p = await page(o); await p.goto(BASE + "/");
  ok(`home ${name} loads`, (await p.title()).includes("Deal or Dud"));
  ok(`home ${name} no sideways scroll`, await noOverflow(p));
  ok(`home ${name} no coffee/donate`, !(await p.content()).match(/coffee|donate/i));
  ok(`home ${name} 3 example links`, (await p.locator("#chips a").count()) === 3);
  ok(`home ${name} new heading`, (await p.textContent("h1")).trim() === "You think you found a good deal? Let's find out!");
  await p.screenshot({ path: `${OUT}/redesign-${name}.png`, fullPage: true });
  ok(`home ${name} no JS errors`, p._errs.length === 0, p._errs.join(" | "));
  await p.context().close();
}
// 2. error states
{
  const p = await page(mobile); await p.goto(BASE + "/");
  await p.click("#go"); ok("empty submit shows error", (await p.textContent("#error")).includes("Paste a product link"));
  await p.fill("#u", "hello there"); await p.click("#go"); ok("bad text shows error", (await p.textContent("#error")).includes("doesn't look like"));
  await p.fill("#u", "https://printer.internal/x"); await p.click("#go");
  await p.waitForFunction(() => !document.getElementById("error").classList.contains("hidden") && document.getElementById("error").textContent.length > 5, null, { timeout: 20000 });
  ok("private host rejected by server", /not a public website/i.test(await p.textContent("#error")), await p.textContent("#error"));
  ok("button re-enabled after error", !(await p.isDisabled("#go")));
  await p.context().close();
}
// 3. examples
const shots = { 0: "example-takealot.png", 1: "example-evetech.png", 2: "example-cyclelab.png" };
for (const i of [0, 1, 2]) {
  const p = await page(mobile); await p.goto(BASE + "/");
  const label = await p.locator("#chips a").nth(i).textContent();
  await p.locator("#chips a").nth(i).click();
  await p.waitForSelector("#result:not(.hidden)", { timeout: 60000 });
  await waitArchive(p);
  const big = (await p.textContent("#verdict .big"))?.trim();
  const n = await pointCount(p);
  ok(`example "${label}" is a South African shop`, /Takealot|Evetech|Cycle Lab/.test(label), label);
  ok(`example "${label}" shows a price and a verdict box`, !!big && /R\s?\d/.test(await p.textContent("#prices")), big);
  ok(`example "${label}" chart has >= 1 point`, n >= 1, String(n));
  ok(`example "${label}" URL updated`, p.url().includes("?u="));
  ok(`example "${label}" shop link set`, (await p.getAttribute("#plink", "href")).startsWith("https://"));
  ok(`example "${label}" no sideways scroll`, await noOverflow(p));
  // chart tap (after archive copies finish loading, because the chart redraws as each one arrives)
  await p.waitForFunction(() => document.getElementById("prog").classList.contains("hidden") && !document.getElementById("progtxt").textContent.trim(), null, { timeout: 30000 }).catch(() => {});
  await p.locator("#chart circle[data-i]").first().click({ force: true });
  ok(`example "${label}" chart tap updates tip`, !(await p.textContent("#tip")).includes("Tap a point"));
  await p.click("#pts summary"); ok(`example "${label}" all-prices table opens`, (await p.locator("#ptable tr").count()) >= 2);
  await p.screenshot({ path: `${OUT}/${shots[i]}`, fullPage: true });
  if (i === 0) {
    const p2 = await page(mobile);
    await p2.goto(BASE + "/?u=" + encodeURIComponent("https://www.currys.co.uk/products/apple-airpods-4-with-active-noise-cancellation-white-10270519.html"));
    await p2.waitForSelector("#result:not(.hidden)", { timeout: 60000 }); await waitArchive(p2);
    ok("shop that blocks us shows manual price box", await p2.isVisible("#manualbox"));
    await p2.fill("#mnow", "99"); await p2.selectOption("#mcur", "GBP"); await p2.click("#mapply");
    const b2 = (await p2.textContent("#verdict .big")).trim();
    ok("manual price updates verdict", !/Can't judge/.test(b2), b2);
    await p2.context().close();
  }
  if (i === 1) {
    // share falls back to copy on desktop-like context; on mobile navigator.share may exist; stub it
    await p.evaluate(() => { navigator.share = undefined; });
    await p.click("#share"); await p.click("#shareCopy"); await p.waitForTimeout(400);
    const clip = await p.evaluate(() => navigator.clipboard.readText().catch(() => ""));
    ok("share copies link", clip.includes("/?u="), clip.slice(0, 80));
    const tq = await p.waitForFunction(() => /copied/.test(document.getElementById("toast")?.textContent || ""), null, { timeout: 6000 }).then(() => "").catch(async () => await p.textContent("#toast"));
    ok("share shows toast", tq === "", tq);
    await p.click("#shareDlg .x");
    await p.click("#again"); await p.waitForFunction(() => !document.getElementById("go").disabled, null, { timeout: 60000 });
    ok("check again keeps result", await p.isVisible("#result"));
  }
  ok(`example "${label}" no JS errors`, p._errs.length === 0, p._errs.join(" | "));
  await p.context().close();
}
// 4. shared link opens the check directly (desktop)
{
  const p = await page(desktop);
  await p.goto(BASE + "/?u=" + encodeURIComponent("https://www.mediamarkt.de/de/product/_samsung-galaxy-a57-256-gb-awesome-gray-dual-sim-3039261.html"));
  await p.waitForSelector("#result:not(.hidden)", { timeout: 60000 }); await waitArchive(p);
  ok("shared link opens result", (await pointCount(p)) >= 3);
  await p.screenshot({ path: `${OUT}/redesign-result-desktop.png`, fullPage: true });
  await p.context().close();
}
// 5. thin-history shop, rate limit and dark mode
{
  const p = await page(mobile); await p.goto(BASE + "/");
  await p.fill("#u", "https://www.takealot.com/apple-airpods-pro-3/PLID99471433"); await p.press("#u", "Enter");
  await p.waitForSelector("#result:not(.hidden)", { timeout: 60000 }); await waitArchive(p);
  const big = (await p.textContent("#verdict .big")).trim();
  ok("Takealot check shows a price and a clear status", /R\s?[\d ,]+/.test(await p.textContent("#prices")) && big.length > 3, big);
  ok("Takealot check no JS errors", p._errs.length === 0, p._errs.join(" | "));
  await p.route("**/api/check**", (r) => r.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "Too many checks in one minute. Wait a minute and try again." }) }));
  await p.click("#go"); await p.waitForFunction(() => !document.getElementById("error").classList.contains("hidden"), null, { timeout: 10000 });
  ok("rate limit message shown", /Too many checks in one minute/.test(await p.textContent("#error")));
  await p.route("**/api/check**", (r) => r.abort());
  await p.click("#go"); await p.waitForFunction(() => /connection/.test(document.getElementById("error").textContent), null, { timeout: 10000 });
  ok("offline message shown", true);
  ok("button re-enabled after network error", !(await p.isDisabled("#go")));
  await p.context().close();
}
{
  const p = await page({ ...mobile, colorScheme: "dark" });
  await p.goto(BASE + "/?u=" + encodeURIComponent("https://www.evetech.co.za/amd-ryzen-5-5500-intel-arc-b580-budget-gaming-pc-16gb-512gb-nvme/best-pc-deal/22997"));
  await p.waitForSelector("#result:not(.hidden)", { timeout: 60000 }); await waitArchive(p);
  ok("dark mode renders", (await p.evaluate(() => getComputedStyle(document.body).backgroundColor)) !== "rgb(255, 255, 255)");
  await p.screenshot({ path: `${OUT}/redesign-result-dark.png`, fullPage: true });
  await p.context().close();
}
// 6. shops list, unsupported shop and the request form
{
  const p = await page(mobile); await p.goto(BASE + "/");
  await p.click("#shopsBtn"); await p.waitForFunction(() => document.querySelectorAll("#shoplist li").length >= 10, null, { timeout: 15000 });
  ok("shops list opens", await p.isVisible("#shopsDlg"));
  ok("shops list has Cycle Lab", (await p.textContent("#shoplist")).includes("Cycle Lab"));
  await p.click("#shopsDlg button.go[data-close]"); ok("shops list closes", !(await p.isVisible("#shopsDlg")));
  await p.click("#askBtn"); ok("footer ask opens form", await p.isVisible("#reqDlg"));
  await p.click("#reqDlg .x"); ok("form closes with ×", !(await p.isVisible("#reqDlg")));
  // unsupported shop with no readable price
  await p.fill("#u", "https://example.com/some-product"); await p.click("#go");
  await p.waitForSelector("#result:not(.hidden)", { timeout: 60000 }); await waitArchive(p);
  ok("unsupported shop message", (await p.textContent("#unsup")).includes("We do not check this shop yet."));
  ok("unsupported shop shows manual price box", await p.isVisible("#manualbox"));
  await p.screenshot({ path: `${OUT}/unsupported-shop.png`, fullPage: true });
  await p.click("#unsupAsk");
  ok("form prefilled with host", (await p.inputValue("#rShop")) === "example.com");
  ok("form prefilled with product link", (await p.inputValue("#rUrl")).includes("example.com/some-product"));
  ok("form has the request note", (await p.textContent("#reqDlg")).includes("We look at every request"));
  await p.fill("#rShop", ""); await p.click("#rSend"); ok("form needs shop", /Type the shop/.test(await p.textContent("#rMsg")));
  await p.fill("#rShop", "example.com"); await p.fill("#rEmail", "not-an-email"); await p.click("#rSend"); ok("form checks email", /email/.test(await p.textContent("#rMsg")));
  await p.fill("#rEmail", ""); await p.fill("#rShop", process.env.E2E_SHOP || "e2e-test example.com");
  await p.screenshot({ path: `${OUT}/request-form.png` });
  // test requests carry the test key, so they are not emailed and are removed at the end
  if (KEY) await p.route("**/api/request", (r) => r.continue({ headers: { ...r.request().headers(), "x-e2e-key": KEY } }));
  await p.click("#rSend"); await p.waitForFunction(() => /Thank you|could not|many/.test(document.getElementById("rMsg").textContent), null, { timeout: 15000 });
  ok("form submit succeeds", /Thank you/.test(await p.textContent("#rMsg")), await p.textContent("#rMsg"));
  await p.waitForTimeout(2200); ok("form closes after success", !(await p.isVisible("#reqDlg")));
  ok("unsupported flow no JS errors", p._errs.length === 0, p._errs.join(" | "));
  await p.context().close();
}
// 7. Cycle Lab is supported and reads a price
{
  const p = await page(mobile);
  await p.goto(BASE + "/?u=" + encodeURIComponent("https://www.cyclelab.com/product/dm101124-dm-bike-gravel-carb-orbea-terra-700c-slv-l"));
  await p.waitForSelector("#result:not(.hidden)", { timeout: 60000 }); await waitArchive(p);
  ok("Cycle Lab price read", /R\s?69\s?999/.test((await p.textContent("#prices")).replace(/[\u00a0,]/g, " ")), await p.textContent("#prices"));
  ok("Cycle Lab is on the list (no unsupported box)", !(await p.isVisible("#unsup")));
  await p.screenshot({ path: `${OUT}/cyclelab-result.png`, fullPage: true });
  await p.context().close();
}
await browser.close();
if (KEY) { const r = await fetch(BASE + "/api/e2e/cleanup", { method: "POST", headers: { "x-e2e-key": KEY } }); const d = await r.json().catch(() => ({})); ok("test rows removed from D1", r.ok && d.ok, JSON.stringify(d)); }
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
