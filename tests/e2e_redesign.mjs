// End-to-end check of the UI. Usage: node tests/e2e_redesign.mjs [BASE] [SHOTDIR]
import { chromium } from "playwright-core";
const BASE = process.argv[2] || "https://bf-price-check.tm-deal-lab.workers.dev";
const OUT = process.argv[3] || "screenshots";
const exe = process.env.CHROME || "/usr/bin/google-chrome";
const results = []; const ok = (name, pass, info = "") => { results.push({ name, pass, info }); console.log((pass ? "PASS " : "FAIL ") + name + (info ? " — " + info : "")); };
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
const shots = { 0: "redesign-result-uk-blocked.png", 1: "redesign-result.png", 2: "redesign-result-eu.png" };
for (const i of [0, 1, 2]) {
  const p = await page(mobile); await p.goto(BASE + "/");
  const label = await p.locator("#chips a").nth(i).textContent();
  await p.locator("#chips a").nth(i).click();
  await p.waitForSelector("#result:not(.hidden)", { timeout: 60000 });
  await waitArchive(p);
  const big = (await p.textContent("#verdict .big"))?.trim();
  const n = await pointCount(p);
  ok(`example "${label}" shows a verdict`, !!big && !/Not enough|Can't judge/.test(big), big);
  ok(`example "${label}" chart has >= 3 points`, n >= 3, String(n));
  ok(`example "${label}" URL updated`, p.url().includes("?u="));
  ok(`example "${label}" shop link set`, (await p.getAttribute("#plink", "href")).startsWith("https://"));
  ok(`example "${label}" no sideways scroll`, await noOverflow(p));
  // chart tap
  await p.locator("#chart circle[data-i]").first().click({ force: true });
  ok(`example "${label}" chart tap updates tip`, !(await p.textContent("#tip")).includes("Tap a point"));
  await p.click("#pts summary"); ok(`example "${label}" all-prices table opens`, (await p.locator("#ptable tr").count()) >= 2);
  await p.screenshot({ path: `${OUT}/${shots[i]}`, fullPage: true });
  if (i === 0) {
    ok("blocked shop shows manual price box", await p.isVisible("#manualbox"));
    await p.fill("#mnow", "99"); await p.selectOption("#mcur", "GBP"); await p.click("#mapply");
    const b2 = (await p.textContent("#verdict .big")).trim();
    ok("manual price updates verdict", /deal/i.test(b2), b2);
  }
  if (i === 1) {
    // share falls back to copy on desktop-like context; on mobile navigator.share may exist; stub it
    await p.evaluate(() => { navigator.share = undefined; });
    await p.click("#share"); await p.waitForTimeout(400);
    const clip = await p.evaluate(() => navigator.clipboard.readText().catch(() => ""));
    ok("share copies link", clip.includes("/?u="), clip.slice(0, 80));
    ok("share shows toast", (await p.textContent("#toast")).includes("copied"));
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
await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
