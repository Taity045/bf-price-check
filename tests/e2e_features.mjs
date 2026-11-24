// Feature and layout checks. Usage: node tests/e2e_features.mjs [BASE] [SHOTDIR]
import { chromium } from "playwright-core";
import fs from "fs";
const BASE = process.argv[2] || "https://bf-price-check.tm-deal-lab.workers.dev";
const OUT = process.argv[3] || "screenshots";
const KEY = process.env.E2E_KEY || (fs.existsSync("/workspace/bf-secrets/e2e_key") ? fs.readFileSync("/workspace/bf-secrets/e2e_key", "utf8").trim() : "");
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PC = "https://www.evetech.co.za/amd-ryzen-5-5500-intel-arc-b580-budget-gaming-pc-16gb-512gb-nvme/best-pc-deal/22997";
const MOUSE = "https://www.evetech.co.za/logitech-g-pro-x-superlight-2c-wireless-mouse-black/best-deal/24659";
const results = []; const ok = (name, pass, info = "") => { results.push({ name, pass, info }); console.log((pass ? "PASS " : "FAIL ") + name + (info ? " — " + String(info).slice(0, 160) : "")); };
const browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const phone = (w = 390, h = 844) => ({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" });
const wide = (w, h = 900) => ({ viewport: { width: w, height: h } });
async function page(opts) {
  const ctx = await browser.newContext(opts);
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  const p = await ctx.newPage(); p._errs = [];
  p.on("pageerror", (e) => p._errs.push(String(e)));
  p.on("console", (m) => { if (m.type() === "error" && !/challenges\.cloudflare|Failed to load resource/.test(m.text())) p._errs.push(m.text()); });
  return p;
}
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const waitArchive = (p) => p.waitForFunction(() => !/Looking|Reading archived copies…/.test(document.getElementById("progtxt").textContent), null, { timeout: 90000 });
const smallTargets = (p) => p.evaluate(() => {
  const bad = [];
  document.querySelectorAll(".top a, .top button, .flinks a, .flinks button, .actions button:not(.hidden), #chips a, #f .go, dialog[open] button, dialog[open] .sharelist a").forEach((el) => {
    const r = el.getBoundingClientRect(); if (!r.width || getComputedStyle(el).visibility === "hidden") return;
    if (r.height < 43.5) bad.push((el.id || el.textContent.trim().slice(0, 20)) + ":" + Math.round(r.height));
  });
  return bad;
});
const fitsViewport = (p, sel) => p.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1; }, sel);

// record one real result for the layout matrix (no extra live checks per screen size)
const rec = await (await fetch(BASE + "/api/check?url=" + encodeURIComponent(PC), { headers: { "user-agent": UA } })).json();
ok("recorded a live result for layout tests", !!(rec.current && rec.current.price), rec.error);
async function mockApi(p) {
  await p.route("**/api/check?**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(rec) }));
  await p.route("**/api/archive?**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "ok", captures_12mo: rec.history.archive.length, sampled: rec.history.archive.length, pending: [] }) }));
  await p.route("**/api/verdict?**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await p.route("**/api/others?**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ matches: [] }) }));
}

// 1. layout matrix: every page, light and dark, phone to big screen
const WIDTHS = [360, 390, 768, 1024, 1280, 1920];
for (const w of WIDTHS) for (const scheme of ["light", "dark"]) {
  const p = await page({ ...(w < 768 ? phone(w) : wide(w)), colorScheme: scheme });
  await mockApi(p);
  const tag = `${w}px ${scheme}`;
  for (const [name, path] of [["home", "/"], ["privacy", "/privacy"], ["result", "/?u=" + encodeURIComponent(PC)]]) {
    await p.goto(BASE + path);
    if (name === "result") { await p.waitForSelector("#result:not(.hidden)", { timeout: 30000 }); await waitArchive(p); }
    if (name === "wall") await p.waitForFunction(() => !/Loading/.test(document.getElementById("wallList").textContent), null, { timeout: 20000 });
    await p.waitForTimeout(150);
    ok(`${tag} ${name}: no sideways scroll`, await noOverflow(p));
    const small = await smallTargets(p); ok(`${tag} ${name}: tap targets >= 44px`, small.length === 0, small.join(", "));
    if ((w === 390 || w === 1280) && scheme === "light") await p.screenshot({ path: `${OUT}/feature-${w === 390 ? "mobile" : "desktop"}-${name}.png`, fullPage: true });
    if (w === 390 && scheme === "dark" && (name === "home" || name === "result")) await p.screenshot({ path: `${OUT}/feature-mobile-${name}-dark.png`, fullPage: true });
  }
  // modals
  if (scheme === "light") {
    for (const [btn, dlg] of [["#shopsBtn", "#shopsDlg"], ["#bmBtn", "#bmDlg"], ["#savedBtn", "#savedDlg"], ["#askBtn", "#reqDlg"], ["#share", "#shareDlg"]]) {
      await p.click(btn); await p.waitForSelector(dlg + "[open]");
      ok(`${tag} modal ${dlg} fits the screen`, await fitsViewport(p, dlg));
      const small = await smallTargets(p); ok(`${tag} modal ${dlg} tap targets`, small.length === 0, small.join(", "));
      await p.click(dlg + " .x");
    }
  }
  ok(`${tag} no JS errors`, p._errs.length === 0, p._errs.join(" | "));
  await p.context().close();
}
// landscape phone
{
  const p = await page({ ...phone(844, 390) }); await mockApi(p);
  for (const path of ["/", "/?u=" + encodeURIComponent(PC), "/privacy"]) {
    await p.goto(BASE + path); await p.waitForTimeout(400);
    ok(`landscape phone ${path.slice(0, 12)}: no sideways scroll`, await noOverflow(p));
  }
  await p.click("#bmBtn"); ok("landscape phone: bookmark modal fits (scrolls inside)", await p.evaluate(() => { const d = document.getElementById("bmDlg"); const r = d.getBoundingClientRect(); return r.height <= innerHeight + 1; }));
  await p.screenshot({ path: `${OUT}/feature-landscape.png` });
  await p.context().close();
}

// 2. live result: verdict stamp, best time, share, save, stats, badge
{
  const p = await page(phone());
  await p.goto(BASE + "/"); await p.evaluate(() => localStorage.clear());
  await p.fill("#u", PC); await p.click("#go");
  await p.waitForSelector("#result:not(.hidden)", { timeout: 60000 }); await waitArchive(p);
  const big = (await p.textContent("#verdict .big")).trim();
  ok("live result has a verdict", big.length > 3, big);
  ok("verdict stamp was revealed", await p.evaluate(() => { const v = document.getElementById("verdict"); return v.classList.contains("unk") || v.dataset.revealed === v.querySelector(".big").textContent.trim(); }));
  ok("verdict looks like a stamp", await p.evaluate(() => { const v = document.getElementById("verdict"); if (v.classList.contains("unk")) return true; const cs = getComputedStyle(v.querySelector(".big")); return cs.textTransform === "uppercase" && parseFloat(cs.borderTopWidth) >= 2 && cs.transform !== "none"; }));
  const best = await p.locator("#verdict .best").textContent().catch(() => "");
  ok("best time to buy line from real data", /lowest.* in the last 12 months/i.test(best), best);
  // share
  await p.click("#share"); await p.waitForSelector("#shareDlg[open]");
  const wa = await p.getAttribute("#shareWa", "href");
  ok("share to WhatsApp link", wa.startsWith("https://wa.me/?text=") && decodeURIComponent(wa).includes(BASE + "/?u="), decodeURIComponent(wa).slice(0, 120));
  await p.screenshot({ path: `${OUT}/feature-share.png` });
  await p.click("#shareDlg .x");
  // save
  await p.click("#save");
  ok("save adds to Saved", (await p.textContent("#savedN")).trim() === "1");
  ok("save button shows saved", (await p.textContent("#save")).includes("Saved"));
  await p.click("#savedBtn"); await p.waitForSelector("#savedDlg[open]");
  ok("Saved list shows the product", (await p.locator("#savedList li a").count()) === 1);
  await p.evaluate(() => { const l = JSON.parse(localStorage.getItem("dod:saved")); l[0].t = 0; l[0].verdict = null; localStorage.setItem("dod:saved", JSON.stringify(l)); });
  await p.click("#savedDlg .x"); await p.click("#savedBtn");
  await p.waitForFunction(() => /Updated|stopped|could not/.test(document.getElementById("savedNote").textContent), null, { timeout: 30000 });
  ok("Saved re-checks on open", /Updated/.test(await p.textContent("#savedNote")), await p.textContent("#savedNote"));
  ok("Saved shows latest verdict", (await p.locator("#savedList .chip").count()) === 1);
  await p.screenshot({ path: `${OUT}/feature-saved.png` });
  await p.click("#tabStats");
  ok("Your stats shows checks", /\d/.test(await p.textContent("#myStats")));
  ok("First check badge earned", (await p.locator(".badge.on").first().textContent()).includes("First check"));
  await p.screenshot({ path: `${OUT}/feature-stats.png` });
  await p.click("#tabSaved"); await p.click("#savedList [data-rm]");
  ok("remove from Saved", (await p.locator("#savedList li a").count()) === 0);
  await p.click("#savedDlg .x");
  ok("live result no JS errors", p._errs.length === 0, p._errs.join(" | "));
  await p.context().close();
}
// reduced motion: no stamp animation
{
  const p = await page({ ...phone(), reducedMotion: "reduce" }); await mockApi(p);
  await p.goto(BASE + "/?u=" + encodeURIComponent(PC)); await p.waitForSelector("#result:not(.hidden)"); await waitArchive(p);
  ok("reduced motion turns off the stamp animation", await p.evaluate(() => getComputedStyle(document.querySelector("#verdict .big")).animationName === "none"));
  await p.context().close();
}
// 3. other shops (barcode match, live)
{
  const p = await page(phone());
  await p.goto(BASE + "/?u=" + encodeURIComponent(MOUSE));
  await p.waitForSelector("#result:not(.hidden)", { timeout: 60000 });
  await p.waitForSelector("#others:not(.hidden)", { timeout: 40000 }).catch(() => {});
  const t = await p.textContent("#others").catch(() => "");
  ok("other shops shows a Takealot barcode match", (await p.isVisible("#others")) && /Takealot/.test(t) && /barcode/.test(t), t.slice(0, 120));
  await p.locator("#others").screenshot({ path: `${OUT}/feature-other-shops.png` }).catch(() => {});
  await p.context().close();
  const r = await (await fetch(BASE + "/api/others?url=" + encodeURIComponent(PC), { headers: { "user-agent": UA } })).json();
  ok("other shops hides weak matches (PC: no barcode or model match)", Array.isArray(r.matches) && r.matches.length === 0, JSON.stringify(r).slice(0, 120));
}
// 3b. "Ask us to add a shop": footer link and result button, desktop and phone, with a real submit (test row)
for (const [n, o] of [["1440", wide(1440)], ["1280", wide(1280)], ["390", phone()]]) {
  const p = await page(o);
  if (KEY) await p.route("**/api/request", (r) => r.continue({ headers: { ...r.request().headers(), "x-e2e-key": KEY } }));
  await p.goto(BASE + "/");
  await p.click("#askBtn"); await p.waitForSelector("#reqDlg[open]", { timeout: 5000 }).catch(() => {});
  ok(`${n}: footer "Ask us to add a shop" opens the form`, await p.isVisible("#reqDlg"));
  const lay = await p.evaluate(() => {
    const r = (id) => document.getElementById(id).getBoundingClientRect();
    const d = document.querySelector("#reqDlg").getBoundingClientRect(), t = r("reqTitle"), shop = r("rShop"), mail = r("rEmail"), send = r("rSend");
    const inside = [shop, mail, send].every((b) => b.left >= d.left - 1 && b.right <= d.right + 1 && b.bottom <= d.bottom + 1);
    return { titleOneLine: t.height < 48, stacked: shop.top > t.bottom && mail.top > shop.bottom, wide: shop.width >= Math.min(300, d.width - 60), inside, fitsScreen: d.bottom <= innerHeight + 1 && d.right <= innerWidth + 1 };
  });
  ok(`${n}: form layout (title on one line, fields stacked, full width, inside the box)`, lay.titleOneLine && lay.stacked && lay.wide && lay.inside && lay.fitsScreen, JSON.stringify(lay));
  await p.screenshot({ path: `${OUT}/hotfix-request-${n}-open.png` });
  await p.fill("#rShop", "e2e-test footer " + n); await p.fill("#rEmail", "e2e-test@example.com"); await p.click("#rSend");
  await p.waitForFunction(() => /Thank you|could not|many|person/.test(document.getElementById("rMsg").textContent), null, { timeout: 15000 }).catch(() => {});
  ok(`${n}: footer form submits`, /Thank you/.test(await p.textContent("#rMsg")), await p.textContent("#rMsg"));
  await p.screenshot({ path: `${OUT}/hotfix-request-${n}-success.png` });
  await p.waitForTimeout(2200);
  ok(`${n}: form closes after success`, !(await p.isVisible("#reqDlg")));
  await p.click("#askBtn"); await p.click("#reqDlg .x"); ok(`${n}: form closes with x`, !(await p.isVisible("#reqDlg")));
  await p.goto(BASE + "/?u=" + encodeURIComponent("https://www.example.com/some-product"));
  await p.waitForSelector("#unsupAsk", { timeout: 60000 }).catch(() => {});
  await p.click("#unsupAsk"); await p.waitForSelector("#reqDlg[open]", { timeout: 5000 }).catch(() => {});
  ok(`${n}: result "Ask us to add this shop" opens the form`, await p.isVisible("#reqDlg"));
  ok(`${n}: result form is prefilled`, (await p.inputValue("#rShop")) === "example.com");
  await p.fill("#rShop", "e2e-test result " + n); await p.click("#rSend");
  await p.waitForFunction(() => /Thank you|could not|many|person/.test(document.getElementById("rMsg").textContent), null, { timeout: 15000 }).catch(() => {});
  ok(`${n}: result form submits`, /Thank you/.test(await p.textContent("#rMsg")), await p.textContent("#rMsg"));
  ok(`${n}: request flow no JS errors`, p._errs.length === 0, p._errs.join(" | "));
  await p.context().close();
}
// known-blocked shop: plain message and manual box, no "ask us" form; shops list has no Amazon
{
  const p = await page(phone());
  await p.goto(BASE + "/?u=" + encodeURIComponent("https://www.amazon.co.za/dp/B0DGJ7HYG1"));
  await p.waitForSelector("#result:not(.hidden)", { timeout: 60000 });
  const blockedOk = await p.evaluate(() => !document.getElementById("unsup").classList.contains("hidden"));
  const t = await p.textContent("#unsup");
  const priceRead = await p.evaluate(() => !document.querySelector("#prices .none"));
  ok("Amazon shows 'often blocks our checks' when no price", priceRead || (blockedOk && /Amazon South Africa often blocks our checks\. You can type the price below\./.test(t)), t);
  ok("blocked shop has no ask-us button", !(await p.isVisible("#unsupAsk")));
  ok("blocked shop shows the manual price box", priceRead || await p.isVisible("#manualbox"));
  await p.screenshot({ path: `${OUT}/feature-blocked-shop.png`, fullPage: true });
  await p.click("#shopsBtn"); await p.waitForFunction(() => document.querySelectorAll("#shoplist li").length >= 40, null, { timeout: 15000 }).catch(() => {});
  const list = await p.textContent("#shoplist");
  ok("shops list has only working shops (no Amazon)", !/Amazon/.test(list) && /Takealot/.test(list) && /Cycle Lab/.test(list), (await p.locator("#shoplist li").count()) + " shops");
  await p.context().close();
}
// a page loaded before a deploy asks for an older script name: it must still get the script
{ const r = await fetch(BASE + "/app.0123456789.js"); ok("old script name still works after a deploy", r.ok && /javascript/.test(r.headers.get("content-type"))); }
{
  const p = await page(phone());
  await p.goto(BASE + "/"); await p.click("#bmBtn"); await p.waitForTimeout(300);
  await p.click("#bmCopy"); await p.waitForTimeout(300);
  ok("390: bookmark copy shows feedback", /Copied/.test(await p.textContent("#bmCopy")));
  await p.screenshot({ path: `${OUT}/hotfix-bookmark-390.png` });
  await p.click("#bmDlg .x"); ok("390: bookmark modal closes", !(await p.isVisible("#bmDlg")));
  await p.context().close();
}
// 4. bookmark button and ?url=
for (const base of [...new Set([BASE, "https://eish.veldwire.com", "https://bf-price-check.tm-deal-lab.workers.dev"])]) {
  const html = await (await fetch(base + "/", { headers: { "user-agent": UA } })).text();
  const want = `href="javascript:void(location.href='${base}/?url='+encodeURIComponent(location.href))"`;
  ok(`${base}: bookmark link is in the HTML without JS`, html.includes(want), (html.match(/id="bmLink"[^>]*/) || [""])[0].slice(0, 160));
  const p = await page(wide(1280));
  await p.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  await p.goto(base + "/"); await p.click("#bmBtn"); await p.waitForSelector("#bmDlg[open]");
  const href = await p.getAttribute("#bmLink", "href");
  ok(`${base}: dialog link is the javascript: code`, href === `javascript:void(location.href='${base}/?url='+encodeURIComponent(location.href))`, href);
  ok(`${base}: copy source has the same code`, (await p.inputValue("#bmCode")) === href);
  ok(`${base}: the javascript code is not shown`, !(await p.evaluate(() => { const r = document.getElementById("bmCode").getBoundingClientRect(); return r.right > 0 && r.width > 2; })) && !/javascript:/.test(await p.innerText("#bmDlg")));
  ok(`${base}: footer note text`, (await p.innerText("footer")).includes("We show only real prices from the shop and price archives. If we find no history, we tell you. Always check the shop's page before you buy."));
  await p.click("#bmCopy"); await p.waitForTimeout(300);
  ok(`${base}: copy works`, (await p.evaluate(() => navigator.clipboard.readText().catch(() => ""))) === href && /Copied/.test(await p.textContent("#bmCopy")));
  await p.screenshot({ path: `${OUT}/bookmark-dialog-${new URL(base).hostname.split(".")[0]}.png` });
  await p.goto(PC, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await Promise.all([p.waitForURL((u) => u.href.startsWith(base + "/?url="), { timeout: 30000 }).catch(() => {}), p.evaluate(href.replace(/^javascript:/, "")).catch(() => {})]);
  ok(`${base}: bookmarklet on Evetech lands on the site with ?url=`, p.url().startsWith(base + "/?url=" + encodeURIComponent(PC).slice(0, 20)), p.url().slice(0, 120));
  await p.waitForSelector("#result:not(.hidden)", { timeout: 60000 }).catch(() => {});
  await p.waitForFunction(() => /R\s?\d/.test(document.getElementById("prices").textContent), null, { timeout: 60000 }).catch(() => {});
  ok(`${base}: bookmarklet runs a check with a price`, /R\s?\d/.test(await p.textContent("#prices")));
  await p.waitForTimeout(800); await p.screenshot({ path: `${OUT}/bookmark-run-${new URL(base).hostname.split(".")[0]}.png` });
  await p.context().close();
}

{
  const p = await page(wide(1280));
  await p.goto(BASE + "/"); await p.click("#bmBtn");
  const code = await p.inputValue("#bmCode");
  ok("bookmark code uses this site's address with ?url=", code.startsWith("javascript:") && code.includes(BASE + "/?url="), code);
  ok("bookmark link has the same javascript: code", (await p.getAttribute("#bmLink", "href")) === code);
  ok("bookmark link can be dragged", await p.evaluate(() => { const a = document.getElementById("bmLink"); return a.draggable !== false && a.tagName === "A"; }));
  await p.click("#bmCopy"); await p.waitForTimeout(300);
  ok("copy the code copies it", (await p.evaluate(() => navigator.clipboard.readText().catch(() => ""))) === code);
  ok("copy shows feedback", /Copied/.test(await p.textContent("#bmCopy")) && /copied/i.test(await p.textContent("#toast")));
  await p.screenshot({ path: `${OUT}/hotfix-bookmark-1280.png` });
  await p.click("#bmLink"); ok("clicking the drag button explains what to do", /Drag it/.test(await p.textContent("#bmHint")));
  await p.click("#bmDlg .x"); ok("bookmark modal closes", !(await p.isVisible("#bmDlg")));
  // run the bookmarklet on a real product page: it must open this site with ?url= and run a check
  await p.goto(PC, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await Promise.all([p.waitForURL((u) => u.href.startsWith(BASE + "/"), { timeout: 30000 }).catch(() => {}), p.evaluate(code.replace(/^javascript:/, "")).catch(() => {})]);
  ok("bookmarklet opens the site with ?url=", p.url().startsWith(BASE + "/?") , p.url().slice(0, 100));
  await p.waitForSelector("#result:not(.hidden)", { timeout: 60000 }).catch(() => {});
  ok("bookmarklet runs a check", await p.isVisible("#result"));
  await p.waitForTimeout(1500); await p.screenshot({ path: `${OUT}/hotfix-bookmarklet-run-1280.png` });
  await p.goto(BASE + "/?url=" + encodeURIComponent(PC)); await p.waitForSelector("#result:not(.hidden)", { timeout: 60000 });
  ok("?url= link runs a check", (await p.textContent("#prices")).includes("R"));
  await p.context().close();
}
// 5. price alerts (hidden until email to anyone works)
{
  const cfg = await (await fetch(BASE + "/api/config")).json();
  const p = await page(phone()); await mockApi(p);
  await p.goto(BASE + "/?u=" + encodeURIComponent(PC)); await p.waitForSelector("#result:not(.hidden)");
  ok("alert button follows the flag", (await p.isVisible("#alertBtn")) === !!cfg.alerts, "alerts=" + cfg.alerts);
  await p.evaluate(() => document.getElementById("alertBtn").classList.remove("hidden"));
  await p.click("#alertBtn"); await p.fill("#aEmail", "bad"); await p.click("#aSend");
  ok("alert form checks the email", /email/i.test(await p.textContent("#aMsg")));
  await p.screenshot({ path: `${OUT}/feature-alert.png` });
  await p.context().close();
  const body = JSON.stringify({ url: rec.canonical, email: "e2e-test@example.com", target: 1000 });
  const off = await fetch(BASE + "/api/alert", { method: "POST", headers: { "content-type": "application/json", "user-agent": UA }, body });
  ok("alerts API refuses while the flag is off", cfg.alerts || off.status === 503, String(off.status));
  if (KEY) {
    const r = await (await fetch(BASE + "/api/alert", { method: "POST", headers: { "content-type": "application/json", "user-agent": UA, "x-e2e-key": KEY }, body })).json();
    ok("alert is stored (test row)", r.ok && r.confirm && r.stop, JSON.stringify(r).slice(0, 80));
    const c = await (await fetch(r.confirm, { headers: { "user-agent": UA } })).text(); ok("alert confirm link works", c.includes("Alert started"));
    const s = await (await fetch(r.stop, { headers: { "user-agent": UA } })).text(); ok("alert stop link works", s.includes("Alert stopped"));
    const bad = await (await fetch(r.stop.replace(/t=[0-9a-f]+/, "t=" + "0".repeat(32)))).text(); ok("alert link with wrong token is refused", bad.includes("not found"));
  }
}
// 6. share card (OG image) and server meta for shared links
{
  const html = await (await fetch(BASE + "/?u=" + encodeURIComponent(PC), { headers: { "user-agent": "WhatsApp/2.24.1 A" } })).text();
  const img = (html.match(/property="og:image" content="([^"]+)"/) || [])[1] || "";
  ok("shared link has og:image for previews", img.includes("/og.png?u="), img.slice(0, 100));
  ok("shared link og:title has product", /og:title" content="[^"]{8,}/.test(html));
  const r = await fetch(img.replace(/&amp;/g, "&"), { headers: { "user-agent": "facebookexternalhit/1.1" } });
  const buf = Buffer.from(await r.arrayBuffer());
  ok("share card is a PNG", r.headers.get("content-type") === "image/png" && buf.slice(1, 4).toString() === "PNG" && buf.length > 5000, buf.length + " bytes");
  fs.writeFileSync(`${OUT}/feature-og.png`, buf);
  const home = await (await fetch(BASE + "/")).text();
  ok("home has absolute og:image", /og:image" content="https:\/\/[^"]+\/og\.png"/.test(home));
}
// 7. wall, counter, privacy, footer
{
  const p = await page(phone());
  await p.goto(BASE + "/");
  ok("wall link hidden while the wall is off", !(await p.isVisible("#wallLink")) && !(await p.isVisible("#counter")));
  await p.goto(BASE + "/wall"); ok("/wall goes to the home page while off", new URL(p.url()).pathname === "/");
  await p.goto(BASE + "/privacy");
  const txt = await p.textContent("#privacyView");
  ok("privacy page mentions Turnstile", /Turnstile/.test(txt));
  ok("privacy page has no remove-your-data promise", !/Remove your data|instant|within \d+ (days|hours)/i.test(txt));
  ok("privacy page has no Your rights section", !/Your rights|Information Regulator/.test(txt) && !(await p.$("#privAsk")));
  const all = await p.content();
  ok("no full name or email on the page", !/Tatenda|Magondo|gmail|hello@/i.test(all));
  ok("no Made by text and no name in the page", !(await p.$("#madeby")) && !/T[a]ity|Made by/i.test(await p.content()));
  ok("pages no JS errors", p._errs.length === 0, p._errs.join(" | "));
  await p.context().close();
}
// 8. light bot protection
{
  const a = await fetch(BASE + "/api/check?url=" + encodeURIComponent(PC), { headers: { "user-agent": "python-requests/2.31" } });
  ok("scraper user agent blocked on the API", a.status === 403);
  const b = await fetch(BASE + "/api/check?url=" + encodeURIComponent(PC), { headers: { "user-agent": UA, origin: "https://other.example" } });
  ok("other websites cannot call the API", b.status === 403);
  const c = await fetch(BASE + "/?u=" + encodeURIComponent(PC), { headers: { "user-agent": "facebookexternalhit/1.1" } });
  ok("preview bots can still read shared pages", c.status === 200);
}
await browser.close();
if (KEY) { const r = await fetch(BASE + "/api/e2e/cleanup", { method: "POST", headers: { "x-e2e-key": KEY, "user-agent": UA } }); const d = await r.json().catch(() => ({})); ok("test rows removed from D1", r.ok && d.ok, JSON.stringify(d)); }
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
