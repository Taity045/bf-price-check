// Clicks every button and flow like a real user at 360-1920 px. The shop request POST is mocked, so nothing is stored or emailed.
// Usage: node tests/e2e_review.mjs [BASE] [SHOTDIR]
import { chromium } from "playwright-core";
const BASE = process.argv[2] || "https://bf-price-check.tm-deal-lab.workers.dev";
const OUT = process.argv[3] || "screenshots";
import fs from "fs"; fs.mkdirSync(OUT, { recursive: true });
const R = []; const ok = (n, p, i = "") => { R.push({ n, p, i }); console.log((p ? "PASS " : "FAIL ") + n + (i ? " — " + i : "")); };
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" };
const desk = (w) => ({ viewport: { width: w, height: 900 } });
async function page(o, mockReq = true) {
  const ctx = await browser.newContext(o);
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  const p = await ctx.newPage(); p._errs = [];
  p.on("pageerror", (e) => p._errs.push("pageerror: " + e)); p.on("console", (m) => { if (m.type() === "error") p._errs.push(m.text()); });
  if (mockReq) await p.route("**/api/request", (r) => { p._reqBody = r.request().postData(); r.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }); });
  return p;
}
const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const openDlg = (p) => p.evaluate(() => [...document.querySelectorAll("dialog[open]")].map((d) => d.id).join(","));
const inView = (p, sel) => p.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return r.width > 0 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; }, sel);

for (const [name, o] of [["360", { ...mobile, viewport: { width: 360, height: 740 } }], ["390", mobile], ["1280", desk(1280)], ["1440", desk(1440)], ["1920", desk(1920)]]) {
  const p = await page(o); await p.goto(BASE + "/", { waitUntil: "networkidle" });
  ok(`${name} home no overflow`, (await overflow(p)) <= 1, String(await overflow(p)));
  await p.screenshot({ path: `${OUT}/home-${name}.png` });
  // shops dialog
  await p.click("#shopsBtn"); await p.waitForFunction(() => !/Loading/.test(document.getElementById("shoplist").textContent));
  const shops = await p.textContent("#shoplist");
  ok(`${name} shops list loads`, shops.length > 50, shops.slice(0, 80));
  ok(`${name} shops list has no Amazon`, !/amazon/i.test(shops));
  ok(`${name} shops list has Germany`, /Germany/.test(shops), "");
  await p.keyboard.press("Escape"); ok(`${name} Escape closes shops`, (await openDlg(p)) === "");
  // ask from footer
  await p.click("#askBtn"); ok(`${name} footer ask opens form`, (await openDlg(p)) === "reqDlg");
  ok(`${name} send button visible in viewport`, await inView(p, "#rSend"));
  ok(`${name} shop input focused`, await p.evaluate(() => document.activeElement.id) === "rShop");
  await p.screenshot({ path: `${OUT}/ask-${name}.png` });
  await p.click("#rSend"); ok(`${name} empty shop -> message`, /Type the shop/.test(await p.textContent("#rMsg")));
  await p.fill("#rShop", "e2e-test shop"); await p.fill("#rEmail", "bad"); await p.click("#rSend");
  ok(`${name} bad email -> message`, /email/.test(await p.textContent("#rMsg")));
  await p.fill("#rEmail", ""); await p.click("#rSend");
  await p.waitForFunction(() => /Thank you/.test(document.getElementById("rMsg").textContent), null, { timeout: 15000 }).catch(() => {});
  ok(`${name} request submit success msg`, /Thank you/.test(await p.textContent("#rMsg")), await p.textContent("#rMsg") + " body=" + p._reqBody);
  await p.waitForTimeout(2200); ok(`${name} request dialog auto closes`, (await openDlg(p)) === "");
  // shops -> ask
  await p.click("#shopsBtn"); await p.click("#shopsAsk"); ok(`${name} shops->ask opens form`, (await openDlg(p)) === "reqDlg");
  await p.click("#reqDlg [data-close].sec"); ok(`${name} cancel closes`, (await openDlg(p)) === "");
  // backdrop click
  await p.click("#askBtn"); await p.mouse.click(5, 5); ok(`${name} backdrop click closes`, (await openDlg(p)) === "");
  // saved
  await p.click("#savedBtn"); ok(`${name} saved opens`, (await openDlg(p)) === "savedDlg");
  await p.click("#tabStats"); ok(`${name} stats tab`, !(await p.isHidden("#paneStats")));
  await p.keyboard.press("Escape");
  ok(`${name} home no JS errors`, p._errs.length === 0, p._errs.join(" | "));
  await p.context().close();
}

// product flow (Takealot, supported)
const TK = process.env.TK || "https://www.takealot.com/apple-airpods-4/PLID95957224";
for (const [name, o] of [["390", mobile], ["1440", desk(1440)]]) {
  const p = await page(o); await p.goto(BASE + "/");
  await p.fill("#u", TK); await p.click("#go");
  await p.waitForSelector("#result:not(.hidden), #error:not(.hidden)", { timeout: 60000 });
  const err = await p.isVisible("#error");
  ok(`${name} takealot check`, !err, err ? await p.textContent("#error") : (await p.textContent("#prices")));
  if (!err) {
    await p.waitForFunction(() => !/Looking|Reading archived copies…/.test(document.getElementById("progtxt").textContent), null, { timeout: 90000 }).catch(() => {});
    ok(`${name} verdict`, true, (await p.textContent("#verdict")).slice(0, 160));
    ok(`${name} result no overflow`, (await overflow(p)) <= 1);
    await p.screenshot({ path: `${OUT}/result-${name}.png`, fullPage: true });
    await p.click("#share"); ok(`${name} share opens`, (await openDlg(p)) === "shareDlg");
    ok(`${name} WA link`, (await p.getAttribute("#shareWa", "href")).startsWith("https://wa.me/?text="));
    await p.click("#shareCopy"); await p.waitForTimeout(300);
    const c = await p.evaluate(() => navigator.clipboard.readText()).catch(() => "");
    ok(`${name} share copy link`, c.startsWith(new URL(BASE).origin + "/?u="), c);
    await p.keyboard.press("Escape");
    await p.click("#save"); ok(`${name} save`, /Saved/.test(await p.textContent("#save")) && (await p.textContent("#savedN")) === "1");
    await p.click("#savedBtn"); await p.waitForTimeout(500);
    ok(`${name} saved list has item`, (await p.locator("#savedList [data-rm]").count()) === 1);
    await p.click("#savedList [data-rm]"); ok(`${name} remove from saved`, /Nothing saved/.test(await p.textContent("#savedList")) && (await p.textContent("#save")) === "Save");
    await p.keyboard.press("Escape");
    await p.click("#again"); await p.waitForSelector("#go:not([disabled])", { timeout: 60000 });
    ok(`${name} check again ok`, !(await p.isVisible("#error")));
    const unsup = await p.isVisible("#unsup"); ok(`${name} supported shop: no 'not on list' box`, !unsup);
    await p.click("#askBtn"); ok(`${name} footer ask on supported shop has empty shop`, (await p.inputValue("#rShop")) === "");
    await p.keyboard.press("Escape");
  }
  ok(`${name} product no JS errors`, p._errs.length === 0, p._errs.join(" | "));
  await p.context().close();
}

// unsupported shop -> Ask us to add this shop
for (const [name, o] of [["390", mobile], ["1280", desk(1280)]]) {
  const p = await page(o); await p.goto(BASE + "/?u=" + encodeURIComponent("https://www.example.com/product/123"));
  await p.waitForSelector("#result:not(.hidden), #error:not(.hidden)", { timeout: 60000 });
  if (await p.isVisible("#error")) { ok(`${name} unsupported check`, false, await p.textContent("#error")); }
  else {
    ok(`${name} unsupported box shown`, await p.isVisible("#unsupAsk"), await p.textContent("#unsup"));
    await p.screenshot({ path: `${OUT}/unsup-${name}.png`, fullPage: true });
    await p.click("#unsupAsk"); ok(`${name} unsupAsk opens form`, (await openDlg(p)) === "reqDlg");
    ok(`${name} unsupAsk prefilled`, (await p.inputValue("#rShop")) === "example.com" && (await p.inputValue("#rUrl")).includes("example.com"), await p.inputValue("#rShop"));
    ok(`${name} unsup send visible`, await inView(p, "#rSend"));
    await p.screenshot({ path: `${OUT}/unsup-ask-${name}.png` });
    await p.click("#rSend"); await p.waitForTimeout(800);
    ok(`${name} unsup request sent`, /Thank you/.test(await p.textContent("#rMsg")), await p.textContent("#rMsg"));
    await p.waitForTimeout(2000);
    // manual price
    if (await p.isVisible("#manualbox")) {
      await p.fill("#mnow", "1299"); await p.selectOption("#mcur", "ZAR"); await p.click("#mapply");
      ok(`${name} manual price applied`, /1[\s,\u00a0]?299/.test(await p.textContent("#prices")), await p.textContent("#prices"));
    }
  }
  ok(`${name} unsup no JS errors`, p._errs.length === 0, p._errs.join(" | "));
  await p.context().close();
}

// pages
{
  const p = await page(mobile); await p.goto(BASE + "/privacy");
  ok("privacy page shows", await p.isVisible("#privacyView"));
  ok("no email shown on site", !/@[a-z0-9-]+\.[a-z]/i.test((await p.textContent("body")).replace(/you@example\.com/g, "")));
  await p.goto(BASE + "/wall"); ok("wall hidden (redirects home)", new URL(p.url()).pathname === "/" , p.url());
  await p.context().close();
}
await browser.close();
const f = R.filter((x) => !x.p); console.log(`\n${R.length - f.length}/${R.length} passed`); f.forEach((x) => console.log("FAILED:", x.n, x.i));
