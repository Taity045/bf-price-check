// Run the bookmark code the way a browser runs a bookmark (browser-started javascript: navigation), on real shop pages.
import { chromium, firefox } from "playwright-core";
const BASE = process.argv[2] || "https://eish.veldwire.com";
const OUT = process.argv[3] || "screenshots";
const which = process.argv[4] || "chromium";
const CODE = `javascript:void(location.href='${BASE}/?url='+encodeURIComponent(location.href))`;
const PAGES = {
  Takealot: "https://www.takealot.com/apple-airpods-4/PLID95776470",
  Woolworths: "https://www.woolworths.co.za/",
  "Cycle Lab": "https://www.cyclelab.com/",
  Evetech: "https://www.evetech.co.za/amd-ryzen-5-5600-arc-b580-budget-gaming-pc/best-deal/23902.aspx",
};
const b = which === "firefox" ? await firefox.launch() : await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
let pass = 0, n = 0;
for (const [name, url] of Object.entries(PAGES)) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-ZA" });
  const p = await ctx.newPage();
  const logs = []; p.on("console", (m) => /Content Security|Refused/i.test(m.text()) && logs.push(m.text().slice(0, 160)));
  await p.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch((e) => logs.push("load: " + e.message.slice(0, 80)));
  const start = p.url();
  await p.waitForTimeout(1500);
  let how = "";
  if (which === "chromium") {
    const s = await ctx.newCDPSession(p); how = "CDP Page.navigate (browser-started, like a bookmark)";
    await Promise.all([p.waitForURL((u) => u.href.startsWith(BASE), { timeout: 20000 }).catch(() => {}), s.send("Page.navigate", { url: CODE }).catch((e) => logs.push("nav: " + e.message))]);
  } else {
    how = "page script (Firefox has no CDP)";
    await Promise.all([p.waitForURL((u) => u.href.startsWith(BASE), { timeout: 20000 }).catch(() => {}), p.evaluate(CODE.slice(11)).catch(() => {})]);
  }
  const landed = p.url().startsWith(BASE + "/?url=");
  let price = false;
  if (landed && /PLID|aspx/.test(url)) { await p.waitForFunction(() => /R\s?\d/.test((document.getElementById("prices") || {}).textContent || ""), null, { timeout: 60000 }).catch(() => {}); price = /R\s?\d/.test(await p.textContent("#prices").catch(() => "")); }
  n++; if (landed) pass++;
  console.log(`${landed ? "PASS" : "FAIL"} ${which} ${name}: ${start.slice(0, 70)} -> ${p.url().slice(0, 90)}${price ? " (check ran, price shown)" : ""} [${how}] ${logs.join(" | ")}`);
  await p.screenshot({ path: `${OUT}/bookmarklet-${which}-${name.replace(/\s/g, "").toLowerCase()}.png` });
  await ctx.close();
}
console.log(`${pass}/${n} passed`);
await b.close();
