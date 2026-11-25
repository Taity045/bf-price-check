import { chromium } from "playwright-core";
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
const U = process.argv[2], OUT = "/workspace/bf-compare-notes/live-shots";
for (const [n, o] of [["1440", { viewport: { width: 1440, height: 900 } }], ["390", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }]]) {
  for (const run of [1, 2]) {
    const c = await b.newContext({ ...o, userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36 bf-live-test" }); const p = await c.newPage();
    const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
    await p.addInitScript(() => { window.__cls = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true }); });
    await p.goto("https://eish.veldwire.com/?u=" + encodeURIComponent(U));
    await p.waitForSelector("#result:not(.hidden)", { timeout: 30000 });
    await p.waitForSelector("#others:not(.hidden)", { timeout: 30000 });
    const t = () => p.evaluate(() => Math.round(document.querySelector("#chart").getBoundingClientRect().top + scrollY));
    const a = await t();
    await p.waitForFunction(() => /shops checked/.test(document.querySelector("#cmpStatus").textContent) && !/ of /.test(document.querySelector("#cmpStatus").textContent), null, { timeout: 60000 });
    const z = await t(); const cls = await p.evaluate(() => window.__cls);
    const rows = await p.$$eval("#otherList li", (l) => l.map((x) => x.innerText.replace(/\s+/g, " ").slice(0, 90)));
    console.log(n, "run", run, "chart moved", z - a, "px, CLS", cls.toFixed(4), "errors", errs.length, "\n  " + rows.join("\n  "));
    if (run === 1) { await p.locator("#others").screenshot({ path: `${OUT}/compare-live-${process.env.TAG||"x"}-${n}.png` }); await p.screenshot({ path: `${OUT}/page-live-${process.env.TAG||"x"}-${n}.png`, fullPage: true }); }
    await c.close();
  }
}
await b.close();
