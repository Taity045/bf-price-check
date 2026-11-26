// Home page picks (examples.json): one row of group chips, 4–6 real products per group, built into the page.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { W } from "../helpers/load-worker.mjs";

const root = new URL("../../", import.meta.url);
const ex = JSON.parse(readFileSync(new URL("examples.json", root), "utf8"));
const id = (title, extra = {}, url = "https://www.yuppiechef.com/x.htm?id=1") => W.cmpIdentity({ title, price: 1000, currency: "ZAR", ...extra }, url);
const hostOf = (u) => { const x = new URL(u); return (x.hostname.replace(/^www\./, "") + x.pathname).toLowerCase(); };
const inList = (list, u) => list.some((s) => s.d.some((d) => hostOf(u).startsWith(d)));

describe("home page picks: examples.json", () => {
  test("groups: Popular first, 4 to 6 products each, unique ids and labels", () => {
    assert.ok(ex.groups.length >= 6 && ex.groups.length <= 9, "6 to 9 chips");
    assert.equal(ex.groups[0].id, "popular");
    assert.equal(new Set(ex.groups.map((g) => g.id)).size, ex.groups.length);
    assert.equal(new Set(ex.groups.map((g) => g.label)).size, ex.groups.length);
    for (const g of ex.groups) {
      assert.match(g.id, /^[a-z]+$/, g.id);
      assert.ok(g.label.length <= 16, `short chip label: ${g.label}`);
      assert.ok(g.items.length >= 4 && g.items.length <= 6, `${g.id}: ${g.items.length} products`);
      assert.equal(new Set(g.items.map((i) => i.url)).size, g.items.length, `${g.id}: no repeated link`);
    }
  });
  test("every product: a name, a shop, ZA or UK, an https link to a shop we read (never a blocked shop), and no price", () => {
    for (const g of ex.groups) for (const it of g.items) {
      assert.deepEqual(Object.keys(it).sort(), ["cc", "name", "shop", "url"], `${it.name}: only name, shop, cc, url (no invented prices)`);
      assert.ok(it.name.length >= 4 && it.name.length <= 48, it.name);
      assert.ok(["ZA", "UK"].includes(it.cc), it.cc);
      assert.match(it.url, /^https:\/\/[^\s]+$/, it.url);
      assert.ok(!W.blockedShopFor(it.url), `${it.url}: blocked shop`);
      assert.ok(!/amazon\.|amzn\.|kurtgeiger\.|takealot\.com\/[^/]+\/PLID\d+\/./i.test(it.url), it.url);
      assert.ok(inList(W.SHOP_LIST.works, it.url), `${it.url}: in the shops we read`);
    }
  });
  test("every Popular product is also in its own group", () => {
    const rest = new Set(ex.groups.slice(1).flatMap((g) => g.items.map((i) => i.url)));
    for (const it of ex.groups[0].items) assert.ok(rest.has(it.url), it.url);
  });
});

describe("home page picks: the built page", () => {
  execFileSync("python3", ["build.py"], { cwd: root, stdio: "ignore" });
  const worker = readFileSync(new URL("dist/worker.js", root), "utf8");
  const html = JSON.parse(worker.match(/\nconst HTML = (".*");\n/)[1]);
  test("one chip per group, the first one on, and one list per group (only the first shown)", () => {
    const chips = [...html.matchAll(/<button type="button" class="cat" data-g="([a-z]+)" aria-controls="pk-\1" aria-pressed="(true|false)">([^<]+)<\/button>/g)];
    assert.deepEqual(chips.map((m) => m[1]), ex.groups.map((g) => g.id));
    assert.deepEqual(chips.map((m) => m[2]), ex.groups.map((g, i) => (i ? "false" : "true")));
    for (const [i, g] of ex.groups.entries()) {
      const ul = html.match(new RegExp(`<ul class="picks" id="pk-${g.id}" aria-label="[^"]+"( hidden)?>([\\s\\S]*?)</ul>`));
      assert.ok(ul, g.id); assert.equal(!!ul[1], i > 0, `${g.id} hidden`);
      assert.equal((ul[2].match(/<li>/g) || []).length, g.items.length);
    }
  });
  test("links open the check (/?u=…) and keep the real product link; names are escaped", () => {
    const it = ex.groups.find((g) => g.id === "appliances").items.find((i) => i.url.includes("yuppiechef"));
    assert.ok(html.includes(`href="/?u=${encodeURIComponent(it.url)}"`));
    assert.ok(html.includes("ASUS VY27UQ 27&quot; 4K monitor"));
    assert.ok(!/R\s?\d[\d ,.]*<|£\d/.test(html.slice(html.indexOf('id="tries"'), html.indexOf("</section>", html.indexOf('id="tries"')))), "no prices in the picks");
  });
  test("simple words: heading and note", () => {
    assert.ok(html.includes(">Try a popular product</h2>"));
    assert.ok(html.includes("Tap a product to check its price now."));
  });
});

describe("compare: a colour word is not a drink", () => {
  test("Champagne or Wine colour on a kettle, toaster or mug is not liquor", () => {
    assert.equal(W.cmpCategory(id("Smeg Retro Cordless Kettle, 1.7L, Champagne Matte")), "appliances");
    assert.equal(W.cmpCategory(id("Russell Hobbs 2 Slice Toaster Wine Red")), "appliances");
    assert.equal(W.cmpCategory(id("Moët & Chandon Brut Imperial Champagne 750ml")), "liquor");
    assert.equal(W.cmpCategory(id("Nederburg Wine 750ml")), "liquor");
  });
});
